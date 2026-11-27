import { resolveProviderId } from "@/shared/constants/providers.js";
import crypto from "node:crypto";
import * as log from "../utils/logger.js";

/**
 * Cache-Aware Conversation Affinity (KV-Cache Preserver)
 *
 * Upstream LLM providers (Claude, OpenAI/Codex, Kimi, Gemini, DeepSeek)
 * cache prompt KV tensors with strict TTLs:
 * - Claude: ~5 minutes (refreshes on cache hit)
 * - Codex / OpenAI: ~5-10 minutes
 * - Kimi / Moonshot / Qwen: ~5 minutes
 * - Gemini / Antigravity: ~60 minutes
 * - DeepSeek / River / Dahl: ~60 minutes+
 *
 * Standard round-robin blindly flips accounts every request, dropping
 * prompt cache hit rates to 0% in multi-account setups and forcing 50k-100k
 * token prefills on every turn. This service keeps subsequent turns of the
 * SAME conversation glued to the warm account for the duration of the cache TTL,
 * while automatically falling back if that account hits rate limits.
 */

export const PROVIDER_CACHE_TTL_MS = {
  claude: 5 * 60 * 1000,
  "claude-web": 5 * 60 * 1000,
  codex: 5 * 60 * 1000,
  openai: 5 * 60 * 1000,
  azure: 5 * 60 * 1000,
  kimi: 5 * 60 * 1000,
  "kimi-web": 5 * 60 * 1000,
  qwen: 5 * 60 * 1000,
  dashscope: 5 * 60 * 1000,
  gemini: 60 * 60 * 1000,
  "gemini-cli": 60 * 60 * 1000,
  antigravity: 60 * 60 * 1000,
  vertex: 60 * 60 * 1000,
  deepseek: 60 * 60 * 1000,
  "deepseek-web": 60 * 60 * 1000,
  river: 60 * 60 * 1000,
  dahl: 60 * 60 * 1000,
  zhipu: 60 * 60 * 1000,
  glm: 60 * 60 * 1000,
  // FreePI binds a conversation to one account upstream for the life of the
  // thread, so this affinity must outlive idle time (and restarts, see below).
  freepi: 24 * 60 * 60 * 1000,
  fp: 24 * 60 * 60 * 1000,
};

export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_AFFINITY_ENTRIES = 5000;

// Affinity survives restarts: losing it mid-conversation sends the next turn to a
// different FreePI account, and the upstream answers 403 "belongs to another free-pi
// account". Stored in the kv table (scope conversationAffinity), hydrated at boot.
const AFFINITY_SCOPE = "conversationAffinity";

// The router is addressed by aliases (`fp/particle`), while every other layer stores the
// resolved id (`freepi`). Keying affinity by the raw provider meant a pin written under
// `freepi:` was never found — or cleared — when the caller spoke `fp`.
function affinityProvider(provider) {
  if (!provider) return provider;
  try {
    return resolveProviderId(provider) || provider;
  } catch {
    return provider;
  }
}
const PERSIST_MIN_INTERVAL_MS = 60 * 1000;
const lastPersisted = new Map();
let hydration = null;

function affinityDb() {
  return import("@/lib/db/driver.js").then((m) => m.getAdapter());
}

function persistAffinity(storeKey, entry, force = false) {
  const now = Date.now();
  if (force || now - (lastPersisted.get(storeKey) || 0) >= PERSIST_MIN_INTERVAL_MS) {
    if (lastPersisted.size > MAX_AFFINITY_ENTRIES) lastPersisted.clear();
    lastPersisted.set(storeKey, now);
  } else {
    return;
  }
  affinityDb()
    .then((db) => db.run(
      "INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)",
      [AFFINITY_SCOPE, storeKey, JSON.stringify({ c: entry.connectionId, e: entry.expiresAt, t: entry.ttlMs })]
    ))
    .catch(() => {});
}

function forgetAffinity(storeKey) {
  lastPersisted.delete(storeKey);
  affinityDb()
    .then((db) => db.run("DELETE FROM kv WHERE scope=? AND key=?", [AFFINITY_SCOPE, storeKey]))
    .catch(() => {});
}

export function hydrateAffinity() {
  if (!hydration) {
    hydration = (async () => {
      try {
        const db = await affinityDb();
        const rows = db.all("SELECT key, value FROM kv WHERE scope=?", [AFFINITY_SCOPE]) || [];
        let restored = 0;
        const now = Date.now();
        for (const row of rows) {
          let parsed = null;
          try { parsed = JSON.parse(row.value || "{}"); } catch { parsed = null; }
          if (!parsed?.c || !parsed?.e) continue;
          if (parsed.e <= now) {
            db.run("DELETE FROM kv WHERE scope=? AND key=?", [AFFINITY_SCOPE, row.key]);
            continue;
          }
          restored += 1;
          affinityStore.set(row.key, {
            connectionId: parsed.c,
            lastUsedAt: parsed.e - (parsed.t || 0),
            expiresAt: parsed.e,
            ttlMs: parsed.t || PROVIDER_CACHE_TTL_MS[row.key.split(":")[0]] || DEFAULT_CACHE_TTL_MS,
          });
        }
        if (restored) console.log(`[AFFINITY] restored ${restored} pinned conversation(s) from the database`);
      } catch (err) {
        // No database yet (first boot) — affinity simply starts empty.
        console.log(`[AFFINITY] restore skipped: ${err?.message || err}`);
      }
    })();
  }
  return hydration;
}

// Key: `${resolvedProviderId}:${convKey}` -> { connectionId, lastUsedAt, expiresAt }
const affinityStore = new Map();

/**
 * Periodically purge expired affinities
 */
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of affinityStore) {
    if (now >= v.expiresAt) {
      affinityStore.delete(k);
      // Drop the persisted copy too, otherwise it is re-read on the next boot.
      forgetAffinity(k);
    }
  }
}, 60000);
if (cleanupInterval.unref) cleanupInterval.unref();

/**
 * Derive a stable conversation identifier from request headers, body, or message prefix.
 */
export function deriveConversationKey({ body, request = null, headers = null, apiKey = "", clientIp = "", provider = "" }) {
  // Normalize headers
  const getHeader = (key) => {
    if (request?.headers?.get) return request.headers.get(key) || request.headers.get(key.toLowerCase());
    if (headers) return headers[key] || headers[key.toLowerCase()];
    return null;
  };

  // 1. Explicit session headers
  const explicitHeader = getHeader("x-session-id") ||
    getHeader("x-conversation-id") ||
    getHeader("x-claude-session-id") ||
    getHeader("session-id") ||
    getHeader("conversation-id");
  if (explicitHeader && typeof explicitHeader === "string" && explicitHeader.trim()) {
    return `hdr:${explicitHeader.trim()}`;
  }

  // 2. Explicit body fields
  if (body && typeof body === "object") {
    if (body.session_id && typeof body.session_id === "string") return `body:${body.session_id.trim()}`;
    if (body.conversation_id && typeof body.conversation_id === "string") return `body:${body.conversation_id.trim()}`;
    if (body.prompt_cache_key && typeof body.prompt_cache_key === "string") return `body:${body.prompt_cache_key.trim()}`;
    if (body.metadata && typeof body.metadata === "object") {
      if (typeof body.metadata.user_id === "string" && body.metadata.user_id.trim()) {
        return `meta:${body.metadata.user_id.trim()}`;
      }
      if (typeof body.metadata.session_id === "string" && body.metadata.session_id.trim()) {
        return `meta:${body.metadata.session_id.trim()}`;
      }
    }
  }

  // 3. Stable conversation prefix hash from messages
  const msgs = Array.isArray(body?.messages) ? body.messages : (Array.isArray(body?.input) ? body.input : null);
  if (msgs && msgs.length > 0) {
    let system = "";
    let firstUser = "";
    for (const m of msgs) {
      const role = m?.role || "";
      let text = "";
      if (typeof m?.content === "string") text = m.content;
      else if (Array.isArray(m?.content)) {
        text = m.content.map(p => (typeof p === "string" ? p : p?.text || p?.input_text || "")).join(" ");
      }
      if (role === "system" && !system && text) system = text.slice(0, 500);
      else if (role === "user" && !firstUser && text) firstUser = text.slice(0, 500);
      if (system && firstUser) break;
    }
    const targetModel = body?.model ? String(body.model).trim() : "";
    const anchor = `${targetModel}\0${system}\0${firstUser}`;
    if (anchor.length > 5) {
      const hash = crypto.createHash("sha256").update(anchor).digest("hex").slice(0, 20);
      const caller = apiKey
        ? `key:${crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 10)}`
        : `ip:${clientIp || "anon"}`;
      return `prefix:${caller}:${hash}`;
    }
  }

  return null;
}

/**
 * Get active connection ID for this provider and conversation key
 */
export function getAffinityConnectionId(provider, convKey) {
  if (!provider || !convKey) return null;
  if (!hydration) hydrateAffinity();
  const storeKey = `${affinityProvider(provider)}:${convKey}`;
  const entry = affinityStore.get(storeKey);
  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    affinityStore.delete(storeKey);
    return null;
  }

  return entry.connectionId;
}

/**
 * Record or refresh conversation affinity to a connection
 */
export function setAffinityConnection(provider, convKey, connectionId) {
  if (!provider || !convKey || !connectionId) return;
  const providerKey = affinityProvider(provider);
  const ttl = PROVIDER_CACHE_TTL_MS[providerKey] || DEFAULT_CACHE_TTL_MS;
  const now = Date.now();
  const storeKey = `${providerKey}:${convKey}`;

  if (affinityStore.size >= MAX_AFFINITY_ENTRIES) {
    // Evict oldest entry
    const oldestKey = affinityStore.keys().next().value;
    if (oldestKey) affinityStore.delete(oldestKey);
  }

  const entry = {
    connectionId,
    lastUsedAt: now,
    expiresAt: now + ttl,
    ttlMs: ttl,
  };
  affinityStore.set(storeKey, entry);
  persistAffinity(storeKey, entry);
}

/**
 * Touch / extend TTL of an existing affinity on successful turn
 */
export function touchAffinity(provider, convKey, connectionId) {
  if (!provider || !convKey) return;
  const providerKey = affinityProvider(provider);
  const storeKey = `${providerKey}:${convKey}`;
  const entry = affinityStore.get(storeKey);
  if (entry) {
    const ttl = entry.ttlMs || PROVIDER_CACHE_TTL_MS[providerKey] || DEFAULT_CACHE_TTL_MS;
    const now = Date.now();
    entry.lastUsedAt = now;
    entry.expiresAt = now + ttl;
    if (connectionId && connectionId !== entry.connectionId) {
      entry.connectionId = connectionId;
      persistAffinity(storeKey, entry, true);
    } else {
      persistAffinity(storeKey, entry);
    }
  } else if (connectionId) {
    setAffinityConnection(provider, convKey, connectionId);
  }
}

/**
 * Clear affinity when a connection fails / rate-limits
 */
export function clearAffinity(provider, convKey) {
  if (!provider || !convKey) return;
  const storeKey = `${affinityProvider(provider)}:${convKey}`;
  affinityStore.delete(storeKey);
  // Delete unconditionally: the entry may already have been swept from memory while
  // its row was still in the database, and a resurrected wrong pin causes a 403 later.
  forgetAffinity(storeKey);
}

// Boot: rebuild the pins that were live before the last restart.
void hydrateAffinity();
