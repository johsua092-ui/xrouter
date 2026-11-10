// Abuse guard: IP bans, per-key deny-list / provider allowlist, usage-share tokens.
//
// Everything here lives in its own table (ipBans, apiKeyAcls, shareTokens) so the
// core tables keep the exact shape an older build expects — a database exported
// from this build still restores somewhere that has never heard of these tables.
//
// The model pattern language is shared with the allowed-model gate on purpose: a
// deny pattern means exactly what an allow pattern means (`gpt-4*`, `*opus`, exact).
import { randomBytes } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseAllowedModels, matchesAllowedModels } from "./allowedModels.js";

const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ IP bans */

/** Every ban row, newest first. `activeOnly` drops those already expired. */
export async function getIpBans({ activeOnly = false } = {}) {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM ipBans ORDER BY banStartedAt DESC`) || [];
  if (!activeOnly) return rows;
  const now = Date.now();
  return rows.filter((r) => !r.banExpiresAt || new Date(r.banExpiresAt).getTime() > now);
}

/** True when this address is currently held out. Expired rows clean themselves up. */
export async function isIpBanned(ip) {
  if (!ip || typeof ip !== "string") return false;
  const db = await getAdapter();
  const row = db.get(`SELECT ip, banExpiresAt FROM ipBans WHERE ip = ?`, [ip.trim()]);
  if (!row) return false;
  if (row.banExpiresAt && new Date(row.banExpiresAt).getTime() <= Date.now()) {
    try {
      db.run(`DELETE FROM ipBans WHERE ip = ?`, [ip.trim()]);
    } catch {}
    return false;
  }
  return true;
}

/** Ban (or re-ban) an address. `expiresAt` null / `ttlMinutes` 0 means permanent. */
export async function banIp(ip, { reason = "manual", expiresAt = null, ttlMinutes = 0, notes = "", failedAttempts = 1 } = {}) {
  const addr = String(ip || "").trim();
  if (!addr) return { ok: false, error: "ip is required" };
  const db = await getAdapter();
  let until = expiresAt || null;
  if (!until && Number(ttlMinutes) > 0) {
    until = new Date(Date.now() + Number(ttlMinutes) * 60_000).toISOString();
  }
  const existing = db.get(`SELECT failedAttempts, banStartedAt FROM ipBans WHERE ip = ?`, [addr]);
  db.run(
    `INSERT OR REPLACE INTO ipBans(ip, reason, failedAttempts, banStartedAt, banExpiresAt, notes, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [
      addr,
      String(reason || "manual"),
      Number(failedAttempts) || 1,
      existing?.banStartedAt || nowIso(),
      until,
      String(notes || ""),
      nowIso(),
    ]
  );
  return { ok: true, ip: addr, reason, banExpiresAt: until };
}

export async function unbanIp(ip) {
  const addr = String(ip || "").trim();
  if (!addr) return { ok: false, error: "ip is required" };
  const db = await getAdapter();
  db.run(`DELETE FROM ipBans WHERE ip = ?`, [addr]);
  return { ok: true, ip: addr };
}

export async function unbanIps(ips = []) {
  const list = [...new Set((Array.isArray(ips) ? ips : []).map((i) => String(i || "").trim()).filter(Boolean))];
  if (!list.length) return { ok: true, removed: 0 };
  const db = await getAdapter();
  for (const ip of list) db.run(`DELETE FROM ipBans WHERE ip = ?`, [ip]);
  return { ok: true, removed: list.length };
}

/** Housekeeping: drop rows whose window has passed. Safe to call on a schedule. */
export async function pruneExpiredIpBans() {
  const db = await getAdapter();
  const before = db.all(`SELECT ip FROM ipBans`)?.length ?? 0;
  try {
    db.run(`DELETE FROM ipBans WHERE banExpiresAt IS NOT NULL AND banExpiresAt <= ?`, [nowIso()]);
  } catch {
    return { removed: 0 };
  }
  const after = db.all(`SELECT ip FROM ipBans`)?.length ?? 0;
  return { removed: Math.max(0, before - after) };
}

/* ------------------------------------------------------------- per-key ACLs */

function aclRow(row) {
  if (!row) return { apiKeyId: null, deniedModels: "", allowedProviders: "", notes: "", updatedAt: null };
  return {
    apiKeyId: row.apiKeyId,
    deniedModels: row.deniedModels || "",
    allowedProviders: row.allowedProviders || "",
    notes: row.notes || "",
    updatedAt: row.updatedAt || null,
  };
}

export async function getKeyAcl(apiKeyId) {
  if (!apiKeyId) return aclRow(null);
  const db = await getAdapter();
  return aclRow(db.get(`SELECT * FROM apiKeyAcls WHERE apiKeyId = ?`, [apiKeyId]));
}

/** Every ACL that actually restricts something, keyed by apiKeyId. */
export async function getKeyAclMap() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeyAcls`) || [];
  const map = new Map();
  for (const row of rows) {
    const acl = aclRow(row);
    if (acl.deniedModels.trim() || acl.allowedProviders.trim()) map.set(acl.apiKeyId, acl);
  }
  return map;
}

export async function setKeyAcl(apiKeyId, { deniedModels, allowedProviders, notes } = {}) {
  if (!apiKeyId) return { ok: false, error: "apiKeyId is required" };
  const db = await getAdapter();
  const prev = aclRow(db.get(`SELECT * FROM apiKeyAcls WHERE apiKeyId = ?`, [apiKeyId]));
  const next = {
    deniedModels: deniedModels === undefined ? prev.deniedModels : String(deniedModels || ""),
    allowedProviders: allowedProviders === undefined ? prev.allowedProviders : String(allowedProviders || ""),
    notes: notes === undefined ? prev.notes : String(notes || ""),
  };
  db.run(
    `INSERT OR REPLACE INTO apiKeyAcls(apiKeyId, deniedModels, allowedProviders, notes, updatedAt)
     VALUES(?, ?, ?, ?, ?)`,
    [apiKeyId, next.deniedModels, next.allowedProviders, next.notes, nowIso()]
  );
  return { ok: true, acl: { apiKeyId, ...next } };
}

export async function deleteKeyAcl(apiKeyId) {
  if (!apiKeyId) return { ok: false, error: "apiKeyId is required" };
  const db = await getAdapter();
  db.run(`DELETE FROM apiKeyAcls WHERE apiKeyId = ?`, [apiKeyId]);
  return { ok: true };
}

/**
 * A key's own deny-list, merged with every deny-list inherited from the team it
 * belongs to. Answers the two questions the request gate asks.
 */
export function aclVerdict(acl, requestedModel, requestedProvider) {
  const denied = parseAllowedModels(acl?.deniedModels);
  if (denied && requestedModel && matchesAllowedModels(denied, requestedModel)) {
    return "MODEL_DENIED";
  }
  const providers = parseAllowedModels(acl?.allowedProviders);
  if (providers && requestedProvider) {
    const wanted = String(requestedProvider).trim().toLowerCase();
    const permitted = providers.some((p) => p === wanted || (p.endsWith("*") && wanted.startsWith(p.slice(0, -1))));
    if (!permitted) return "PROVIDER_NOT_ALLOWED";
  }
  return null;
}

/* --------------------------------------------------------- usage-share links */

function shareRow(row) {
  if (!row) return null;
  return {
    token: row.token,
    apiKeyId: row.apiKeyId,
    label: row.label || "",
    expiresAt: row.expiresAt || null,
    viewCount: Number(row.viewCount) || 0,
    lastViewedAt: row.lastViewedAt || null,
    createdAt: row.createdAt,
  };
}

/** Mint a share link. Defaults to a 30-day life; `ttlDays` 0 means never expires. */
export async function createShareToken(apiKeyId, { label = "", ttlDays = 30, expiresAt = null } = {}) {
  if (!apiKeyId) return { ok: false, error: "apiKeyId is required" };
  const db = await getAdapter();
  const token = randomBytes(18).toString("base64url");
  let until = expiresAt || null;
  if (!until && Number(ttlDays) > 0) {
    until = new Date(Date.now() + Number(ttlDays) * 86_400_000).toISOString();
  }
  db.run(
    `INSERT INTO shareTokens(token, apiKeyId, label, expiresAt, viewCount, lastViewedAt, createdAt)
     VALUES(?, ?, ?, ?, 0, NULL, ?)`,
    [token, apiKeyId, String(label || ""), until, nowIso()]
  );
  return { ok: true, share: { token, apiKeyId, label, expiresAt: until } };
}

/** Resolve a token, or null when unknown / expired / revoked. */
export async function getShareToken(token) {
  if (!token) return null;
  const db = await getAdapter();
  const row = shareRow(db.get(`SELECT * FROM shareTokens WHERE token = ?`, [String(token)]));
  if (!row) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;
  return row;
}

export async function getShareTokensForKey(apiKeyId) {
  if (!apiKeyId) return [];
  const db = await getAdapter();
  return (db.all(`SELECT * FROM shareTokens WHERE apiKeyId = ? ORDER BY createdAt DESC`, [apiKeyId]) || []).map(shareRow);
}

export async function revokeShareToken(token) {
  if (!token) return { ok: false, error: "token is required" };
  const db = await getAdapter();
  db.run(`DELETE FROM shareTokens WHERE token = ?`, [String(token)]);
  return { ok: true };
}

/** Count a view. Best-effort: a failed counter must never break the page. */
export async function touchShareToken(token) {
  try {
    const db = await getAdapter();
    db.run(`UPDATE shareTokens SET viewCount = viewCount + 1, lastViewedAt = ? WHERE token = ?`, [
      nowIso(),
      String(token),
    ]);
  } catch {}
}
