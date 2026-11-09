/**
 * antigravityTier.js — can this Antigravity account reach Claude 5.5?
 *
 * Claude Opus/Sonnet 5.5 live behind Antigravity's `standard-tier`, which is a
 * subscription of its own — separate from Google One AI Pro. An account on a
 * Google One trial keeps `currentTier.id = "free-tier"` even though
 * `paidTier.id = "g1-pro-tier"`, and upstream then answers those model ids with
 * 404. So eligibility must be read from the live tier, never assumed.
 *
 * The probe hits the same endpoints the quota service already uses
 * (loadCodeAssist for the tier, fetchAvailableModels for the catalog), reusing
 * the stored OAuth token from the active Antigravity connection.
 */
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
let DatabaseSync;
try {
  DatabaseSync = req("node:sqlite").DatabaseSync;
} catch {
  try {
    DatabaseSync = req("better-sqlite3");
  } catch {}
}

const DB_PATH = process.env.DATABASE_PATH || "/root/.xrouter/db/data.sqlite";
const AG_BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const UA = "Antigravity/2.11.0 darwin/24.0.0";

// Google One trial / promo accounts report paidTier g1-pro-tier while staying on
// Antigravity's free-tier. Only a real Antigravity standard-tier unlocks 5.5.
const PAID_TIER_IDS = new Set(["standard-tier", "g1-pro-tier-standard", "ultra-tier"]);
const CLAUDE55_HINTS = [/opus[-_.]?5[-_.]?5/i, /sonnet[-_.]?5[-_.]?5/i, /opus.?5\.5/i, /sonnet.?5\.5/i];

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, value: null };

function readToken() {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const row = db
      .prepare("SELECT data FROM providerConnections WHERE provider = 'antigravity' AND isActive = 1 LIMIT 1")
      .get();
    db.close();
    if (!row?.data) return null;
    const parsed = JSON.parse(row.data);
    return parsed.accessToken || null;
  } catch {
    return null;
  }
}

async function post(path, token) {
  const res = await fetch(`${AG_BASE}:${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": UA,
      "Content-Type": "application/json",
      "X-Client-Name": "antigravity",
    },
    body: "{}",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * @returns {Promise<{tierId: string|null, tierName: string|null,
 *   canUseClaude55: boolean, catalogHasClaude55: boolean, modelIds: string[],
 *   reason: string}>}
 */
export async function getAntigravityTier() {
  if (cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const token = readToken();
  if (!token) {
    const out = {
      tierId: null,
      tierName: null,
      canUseClaude55: false,
      catalogHasClaude55: false,
      modelIds: [],
      reason: "no-antigravity-connection",
    };
    cache = { at: Date.now(), value: out };
    return out;
  }

  let tierId = null;
  let tierName = null;
  let paidTierId = null;
  try {
    const sub = await post("loadCodeAssist", token);
    if (sub) {
      tierId = sub?.currentTier?.id ?? null;
      tierName = sub?.currentTier?.name ?? null;
      paidTierId = sub?.paidTier?.id ?? null;
    }
  } catch {
    /* fall through — catalog below is the second signal */
  }

  // The catalog is the decisive signal: a model listed there is one upstream will
  // accept. Tier ids are undocumented and have changed before.
  let modelIds = [];
  let catalogHasClaude55 = false;
  try {
    const cat = await post("fetchAvailableModels", token);
    if (cat?.models) {
      modelIds = Object.keys(cat.models);
      catalogHasClaude55 = modelIds.some((id) => CLAUDE55_HINTS.some((re) => re.test(id)));
    }
  } catch {
    /* keep defaults */
  }

  const canUseClaude55 = catalogHasClaude55 || (tierId ? PAID_TIER_IDS.has(tierId) : false);

  let reason = "ok";
  if (!tierId && !modelIds.length) reason = "probe-failed";
  else if (canUseClaude55) reason = catalogHasClaude55 ? "in-catalog" : "paid-tier";
  else if (paidTierId && paidTierId !== "free-tier")
    reason = "google-one-trial-only"; // One is paid, Antigravity tier is not
  else reason = "free-tier";

  const out = { tierId, tierName, canUseClaude55, catalogHasClaude55, modelIds, reason };
  cache = { at: Date.now(), value: out };
  return out;
}