import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";

import { matchesAllowedModels as matchesModelPatterns, parseAllowedModels } from "./apiKeysRepo.js";

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 12) return key.charAt(0) + "***";
  // Keep the tail: keys sharing a machine-id prefix (team keys) must not collide.
  return key.slice(0, 8) + "***" + key.slice(-4);
}

// byApiKey counters are aggregated on the FULL api key on purpose: masking at
// aggregation time collided keys sharing a prefix (team keys) into one bucket.
// But the object is returned as-is by /api/usage/stats, so its OBJECT KEYS would
// carry the raw api keys in the response. Re-key with the masked label right
// before returning; no consumer reads these object keys, only the values
// (keyName, apiKeyMasked, ...).
function withRedactedApiKeyBuckets(byApiKey) {
  const out = {};
  for (const entry of Object.values(byApiKey || {})) {
    const label = `${entry.apiKeyMasked || "local-no-key"}|${entry.rawModel || "unknown"}|${entry.provider || "unknown"}`;
    let key = label;
    for (let n = 2; out[key]; n += 1) key = `${label}#${n}`;
    out[key] = entry;
  }
  return out;
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const statsEmitTimers = global._statsEmitTimers;

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target || typeof target !== "object") return;
  // M12 fix: key is provider/model from upstream data — never allow it to
  // resolve to Object.prototype (prototype pollution of the whole process).
  if (key === "__proto__" || key === "constructor" || key === "prototype") key = `x${key}`;
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) {
 const meta = { ...values.meta };
 for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
 Object.assign(target[key], meta);
 }
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, resolvedModel: entry.resolvedModel } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function pushToRing(entry) {
  // Zero-token failures (401 storms, blocked 405s, quota rejections) never enter
  // the ring: RING_CAP is only 50, so a burst of failures would evict every real
  // row, and each SSE "pending" payload then wipes dashboard Recent Requests to
  // [] until the next full stats event. Failures stay in usageHistory/charts;
  // they just don't get to displace real usage in the live list.
  const rawTokens = typeof entry.tokens === "string" ? parseJson(entry.tokens, {}) : entry.tokens;
  const t = rawTokens || {};
  const pt = t.prompt_tokens || t.input_tokens || 0;
  const ct = t.completion_tokens || t.output_tokens || 0;
  if (!pt && !ct) return;
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    // Skip zero-token failures at load time: a 401-retry storm filling the ring
    // starves the real-usage view downstream (dashboard "Recent Requests").
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory WHERE promptTokens > 0 OR completionTokens > 0 ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, endpoint: r.endpoint, cost: r.cost, status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    // Delegate the actual math to the single source of truth (avoids the two
    // copies drifting apart — see open-sse/providers/pricing.js for the
    // cache-inclusive prompt_tokens convention this assumes).
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens(tokens, pricing);
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

// Scoped variant for API-key dashboard sessions. Without a filter this returns the
// global view; with one, live rows another key triggered are never exposed and the
// history is narrowed to the key plus its allowed models. Pending traffic carries no
// key attribution, so a scoped caller gets an empty active list rather than a leak.
export async function getActiveRequests(filterApiKey = null, allowedModels = "*") {
  const activeRequests = [];
  const connectionMap = await getConnectionMapCached();

  if (!filterApiKey) {
    for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
      for (const [modelKey, count] of Object.entries(models)) {
        if (count > 0) {
          const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
          const match = modelKey.match(/^(.*) \((.*)\)$/);
          activeRequests.push({
            model: match ? match[1] : modelKey,
            provider: match ? match[2] : "unknown",
            account: accountName, count,
          });
        }
      }
    }
  }

  const patterns = parseAllowedModels(allowedModels);
  const modelAllowed = (model) => matchesModelPatterns(patterns, model);

  await ensureRingInitialized();
  const seen = new Set();
  const recentRequests = [...recentRing.items]
    .filter((e) => !filterApiKey || e.apiKey === filterApiKey)
    .filter((e) => modelAllowed(e.model))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      return {
        timestamp: e.timestamp, model: e.model, provider: e.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = (!filterApiKey && Date.now() - lastErrorProvider.ts < 10000)
    ? lastErrorProvider.provider
    : "";
  return { activeRequests, recentRequests, errorProvider };
}

export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost = await calculateCost(entry.provider, entry.model, entry.tokens);

    // Cost is priced from the REAL model + provider; the flip below only changes
    // what the dashboards display, never what is billed.
    const resolvedModel = entry.model;
    if (entry.requestedModel) entry.model = entry.requestedModel;
    entry.resolvedModel = entry.requestedModel ? resolvedModel : undefined;

    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    let inserted = false;

    // All 3 writes (history insert, daily upsert, lifetime counter) in ONE transaction.
    // better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
    db.transaction(() => {
      const existing = db.get(
        `SELECT id, endpoint FROM usageHistory
         WHERE timestamp = ?
           AND COALESCE(provider, '') = COALESCE(?, '')
           AND COALESCE(model, '') = COALESCE(?, '')
           AND COALESCE(connectionId, '') = COALESCE(?, '')
           AND COALESCE(apiKey, '') = COALESCE(?, '')
           AND promptTokens = ?
           AND completionTokens = ?
         ORDER BY id DESC LIMIT 1`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null,
          promptTokens, completionTokens,
        ]
      );

      if (existing) {
        if (!existing.endpoint && entry.endpoint) {
          db.run(`UPDATE usageHistory SET endpoint = ? WHERE id = ?`, [entry.endpoint, existing.id]);
        }
        return;
      }

      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null, entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson(entry.requestedModel ? { resolvedModel } : {}),
        ]
      );

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row ? parseJson(row.data, {}) : {
        requests: 0, promptTokens: 0, completionTokens: 0, cost: 0,
        byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
      };
      aggregateEntryToDay(day, entry);
      db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);

      // Atomic counter increment in same transaction
      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);

      // Update API Key usedTokens and sliding window
      if (entry.apiKey) {
         const totalTokens = promptTokens + completionTokens;
         if (totalTokens > 0) {
            db.run(`UPDATE apiKeys SET usedTokens = COALESCE(usedTokens, 0) + ? WHERE key = ?`, [totalTokens, entry.apiKey]);
         }
         import("./apiKeysRepo.js").then(({ recordApiKeyUsageInWindow }) => {
           recordApiKeyUsageInWindow(entry.apiKey, totalTokens);
         }).catch(() => {});
      }

      inserted = true;
    });

    if (inserted) {
      pushToRing(entry);
      scheduleStatsEvent("update", 250);
    }
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }
  if (filter.apiKey) { conds.push("apiKey = ?"); params.push(filter.apiKey); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens, meta FROM usageHistory ${where} ORDER BY id ASC`, params);

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, apiKeyMasked: maskApiKey(r.apiKey), endpoint: r.endpoint,
    cost: r.cost, status: r.status, tokens: parseJson(r.tokens, {}),
    resolvedModel: (() => { try { return (parseJson(r.meta, {}) || {}).resolvedModel || null; } catch { return null; } })(),
  }));
}

function loadDaysInRange(adapter, maxDays) {
  if (maxDays == null) {
    return adapter.all(`SELECT dateKey, data FROM usageDaily ORDER BY dateKey ASC`);
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`, [cutoffKey]);
}

export async function getUsageStats(period = "all", filterApiKey = null, allowedModels = "*") {
  const db = await getAdapter();

  const patterns = parseAllowedModels(allowedModels);
  const modelAllowed = (model) => matchesModelPatterns(patterns, model);

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = {};
  for (const k of allApiKeys) apiKeyMap[k.key] = { name: k.name, id: k.id, createdAt: k.createdAt };

  // recentRequests from live history.
  // BUG fix (dashboard showed "No requests yet"): LIMIT 100 grabbed the newest
  // 100 rows — a 401-retry storm (~every 3s, all zero-token) starved the
  // zero-token filter down to 0–3 rows. Filter zero-token rows in SQL and widen
  // the window so real usage always survives a failure flood.
  const recentSql = filterApiKey
    ? `SELECT timestamp, provider, model, tokens, status FROM usageHistory WHERE apiKey = ? AND (promptTokens > 0 OR completionTokens > 0) ORDER BY id DESC LIMIT 1000`
    : `SELECT timestamp, provider, model, tokens, status FROM usageHistory WHERE promptTokens > 0 OR completionTokens > 0 ORDER BY id DESC LIMIT 1000`;
  const recentParams = filterApiKey ? [filterApiKey] : [];
  const recentRows = db.all(recentSql, recentParams);
  const seen = new Set();
  const recentRequests = recentRows
    .map((r) => {
      const t = parseJson(r.tokens, {}) || {};
      return {
        timestamp: r.timestamp, model: r.model, provider: r.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: r.status || "ok",
      };
    })
    .filter((e) => {
      if (!modelAllowed(e.model)) return false;
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: filterApiKey ? {} : pendingRequests,
    activeRequests: filterApiKey ? [] : [],
    recentRequests,
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests - only populate for global view, or filter for specific key
  if (!filterApiKey) {
    for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
      for (const [modelKey, count] of Object.entries(models)) {
        if (count > 0) {
          const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
          const match = modelKey.match(/^(.*) \((.*)\)$/);
          stats.activeRequests.push({
            model: match ? match[1] : modelKey,
            provider: match ? match[2] : "unknown",
            account: accountName, count,
          });
        }
      }
    }
  }

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10Sql = filterApiKey
    ? `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ? AND apiKey = ?`
    : `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`;
  const recent10Params = filterApiKey
    ? [tenMinutesAgo.toISOString(), now.toISOString(), filterApiKey]
    : [tenMinutesAgo.toISOString(), now.toISOString()];
  const recent10 = db.all(recent10Sql, recent10Params);
  for (const r of recent10) {
    if (!modelAllowed(r.model)) continue;
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }

  if (filterApiKey) {
    let cutoff = null;
    if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else if (period === "24h") {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    } else if (period === "7d") {
      cutoff = new Date(Date.now() - PERIOD_MS["7d"]).toISOString();
    } else if (period === "30d") {
      cutoff = new Date(Date.now() - PERIOD_MS["30d"]).toISOString();
    } else if (period === "60d") {
      cutoff = new Date(Date.now() - PERIOD_MS["60d"]).toISOString();
    }

    const where = ["apiKey = ?"];
    const params = [filterApiKey];
    if (cutoff) {
      where.push("timestamp >= ?");
      params.push(cutoff);
    }

    const filtered = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens, meta FROM usageHistory WHERE ${where.join(" AND ")}`,
      params
    );

    for (const r of filtered) {
      if (!modelAllowed(r.model)) continue;
      const tokens = parseJson(r.tokens, {}) || {};
      const promptTokens = r.promptTokens ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0;
      const completionTokens = r.completionTokens ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0;
      const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
      const entryCost = r.cost || 0;
      const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCost += entryCost;

      if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
      stats.byProvider[r.provider].requests++;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cachedTokens += cachedTokens;
      stats.byProvider[r.provider].cost += entryCost;

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, resolvedModel: (parseJson(r.meta, {}) || {}).resolvedModel || undefined, lastUsed: r.timestamp };
      }
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(r.timestamp) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.timestamp;

      if (r.connectionId) {
        const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.timestamp };
        }
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(r.timestamp) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.timestamp;
      }

      const keyInfo = apiKeyMap[r.apiKey];
      const keyName = keyInfo?.name || r.apiKey.slice(0, 8) + "...";
      const apiKeyMasked = maskApiKey(r.apiKey);
      const akKey = `${apiKeyMasked}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byApiKey[akKey]) {
        stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: apiKeyMasked, lastUsed: r.timestamp };
      }
      const ake = stats.byApiKey[akKey];
      ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
      if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cost += entryCost;
      if (new Date(r.timestamp) > new Date(epe.lastUsed)) epe.lastUsed = r.timestamp;
    }

    stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
    stats.byApiKey = withRedactedApiKeyBuckets(stats.byApiKey);
    return stats;
  }

  const useDailySummary = period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays = periodDays[period] || null;
    const dayRows = loadDaysInRange(db, maxDays);

    for (const dr of dayRows) {
      const dateKey = dr.dateKey;
      const day = parseJson(dr.data, {});
      if (patterns === null) {
        stats.totalPromptTokens += day.promptTokens || 0;
        stats.totalCompletionTokens += day.completionTokens || 0;
        stats.totalCachedTokens += day.cachedTokens || 0;
        stats.totalCost += day.cost || 0;

        for (const [prov, p] of Object.entries(day.byProvider || {})) {
          if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
          stats.byProvider[prov].requests += p.requests || 0;
          stats.byProvider[prov].promptTokens += p.promptTokens || 0;
          stats.byProvider[prov].completionTokens += p.completionTokens || 0;
          stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
          stats.byProvider[prov].cost += p.cost || 0;
        }
      }

      for (const [mk, m] of Object.entries(day.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        if (!modelAllowed(rawModel)) continue;
        const provider = m.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byModel[statsKey]) {
        stats.byModel[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, resolvedModel: m.resolvedModel || undefined, lastUsed: dateKey };
        }
        stats.byModel[statsKey].requests += m.requests || 0;
        stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
        stats.byModel[statsKey].cachedTokens += m.cachedTokens || 0;
        stats.byModel[statsKey].cost += m.cost || 0;
        if (dateKey > (stats.byModel[statsKey].lastUsed || "")) stats.byModel[statsKey].lastUsed = dateKey;

        // Day totals and provider buckets carry no model dimension, so in
        // restricted mode they are rebuilt from the matching model buckets.
        if (patterns !== null) {
          stats.totalPromptTokens += m.promptTokens || 0;
          stats.totalCompletionTokens += m.completionTokens || 0;
          stats.totalCachedTokens += m.cachedTokens || 0;
          stats.totalCost += m.cost || 0;

          if (provider) {
            if (!stats.byProvider[provider]) stats.byProvider[provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
            stats.byProvider[provider].requests += m.requests || 0;
            stats.byProvider[provider].promptTokens += m.promptTokens || 0;
            stats.byProvider[provider].completionTokens += m.completionTokens || 0;
            stats.byProvider[provider].cachedTokens += m.cachedTokens || 0;
            stats.byProvider[provider].cost += m.cost || 0;
          }
        }
      }

      for (const [connId, a] of Object.entries(day.byAccount || {})) {
        const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = a.rawModel || "";
        if (!modelAllowed(rawModel)) continue;
        const provider = a.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, connectionId: connId, accountName, lastUsed: dateKey };
        }
        stats.byAccount[accountKey].requests += a.requests || 0;
        stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
        stats.byAccount[accountKey].cachedTokens += a.cachedTokens || 0;
        stats.byAccount[accountKey].cost += a.cost || 0;
        if (dateKey > (stats.byAccount[accountKey].lastUsed || "")) stats.byAccount[accountKey].lastUsed = dateKey;
      }

      for (const [akKey, ak] of Object.entries(day.byApiKey || {})) {
        const rawModel = ak.rawModel || "";
        if (!modelAllowed(rawModel)) continue;
        const provider = ak.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const apiKeyVal = ak.apiKey;
        const keyInfo = apiKeyVal ? apiKeyMap[apiKeyVal] : null;
        const keyName = keyInfo?.name || (apiKeyVal ? apiKeyVal.slice(0, 8) + "..." : "Local (No API Key)");
        const apiKeyMasked = maskApiKey(apiKeyVal);
        const apiKeyKey = apiKeyMasked || "local-no-key";
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey, lastUsed: dateKey };
        }
        stats.byApiKey[akKey].requests += ak.requests || 0;
        stats.byApiKey[akKey].promptTokens += ak.promptTokens || 0;
        stats.byApiKey[akKey].completionTokens += ak.completionTokens || 0;
        stats.byApiKey[akKey].cachedTokens += ak.cachedTokens || 0;
        stats.byApiKey[akKey].cost += ak.cost || 0;
        if (dateKey > (stats.byApiKey[akKey].lastUsed || "")) stats.byApiKey[akKey].lastUsed = dateKey;
      }

      for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
        const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
        const rawModel = ep.rawModel || "";
        if (!modelAllowed(rawModel)) continue;
        const provider = ep.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byEndpoint[epKey]) {
          stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byEndpoint[epKey].requests += ep.requests || 0;
        stats.byEndpoint[epKey].promptTokens += ep.promptTokens || 0;
        stats.byEndpoint[epKey].completionTokens += ep.completionTokens || 0;
        stats.byEndpoint[epKey].cachedTokens += ep.cachedTokens || 0;
        stats.byEndpoint[epKey].cost += ep.cost || 0;
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || "")) stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }

    // Overlay precise lastUsed timestamps from history.
    // ponytail: overlay scans only a recent window; entries older than that keep
    // day-level lastUsed from usageDaily. Upgrade to a materialized per-key
    // MAX(timestamp) table if exact old timestamps ever matter.
    const OVERLAY_WINDOW_MS = 2 * 86400000;
    const overlayCutoff = Math.max(
      maxDays ? Date.now() - maxDays * 86400000 : 0,
      Date.now() - OVERLAY_WINDOW_MS
    );
    const histRows = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint FROM usageHistory WHERE timestamp >= ?`,
      [new Date(overlayCutoff).toISOString()]
    );
    for (const e of histRows) {
      const ts = e.timestamp;
      if (!modelAllowed(e.model)) continue;
      const modelKey = e.provider ? `${e.model} (${e.provider})` : e.model;
      if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = ts;

      if (e.connectionId) {
        const accountName = connectionMap[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
        const accountKey = `${e.model} (${e.provider} - ${accountName})`;
        if (stats.byAccount[accountKey] && new Date(ts) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = ts;
      }

      const apiKeyKey = (e.apiKey && typeof e.apiKey === "string")
        ? `${e.apiKey}|${e.model}|${e.provider || "unknown"}`
        : "local-no-key";
      if (stats.byApiKey[apiKeyKey] && new Date(ts) > new Date(stats.byApiKey[apiKeyKey].lastUsed)) stats.byApiKey[apiKeyKey].lastUsed = ts;

      const endpoint = e.endpoint || "Unknown";
      const endpointKey = `${endpoint}|${e.model}|${e.provider || "unknown"}`;
      if (stats.byEndpoint[endpointKey] && new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed)) stats.byEndpoint[endpointKey].lastUsed = ts;
    }
  } else {
    // 24h / today: live history is the precise source.
    let cutoff;
    if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    }
    const filtered = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens, meta FROM usageHistory WHERE timestamp >= ?`,
      [cutoff]
    );

    for (const r of filtered) {
      if (!modelAllowed(r.model)) continue;
      const tokens = parseJson(r.tokens, {}) || {};
      const promptTokens = r.promptTokens ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0;
      const completionTokens = r.completionTokens ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0;
      const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
      const entryCost = r.cost || 0;
      const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCost += entryCost;

      if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
      stats.byProvider[r.provider].requests++;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cachedTokens += cachedTokens;
      stats.byProvider[r.provider].cost += entryCost;

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
      stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, resolvedModel: (parseJson(r.meta, {}) || {}).resolvedModel || undefined, lastUsed: r.timestamp };
      }
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(r.timestamp) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.timestamp;

      if (r.connectionId) {
        const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.timestamp };
        }
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(r.timestamp) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.timestamp;
      }

      if (r.apiKey && typeof r.apiKey === "string") {
        const keyInfo = apiKeyMap[r.apiKey];
        const keyName = keyInfo?.name || r.apiKey.slice(0, 8) + "...";
        const apiKeyMasked = maskApiKey(r.apiKey);
        // Key by the FULL api key (same as the daily rollup + lastUsed overlay)
        // — masking here collided all keys sharing a prefix into one bucket.
        const akKey = `${r.apiKey}|${r.model}|${r.provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: apiKeyMasked, lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey[akKey];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      } else {
        if (!stats.byApiKey["local-no-key"]) {
          stats.byApiKey["local-no-key"] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: null, keyName: "Local (No API Key)", apiKeyKey: "local-no-key", lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey["local-no-key"];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      }

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cost += entryCost;
      if (new Date(r.timestamp) > new Date(epe.lastUsed)) epe.lastUsed = r.timestamp;
    }
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  stats.byApiKey = withRedactedApiKeyBuckets(stats.byApiKey);
  return stats;
}

export async function getChartData(period = "7d", filterApiKey = null, allowedModels = "*") {
  const db = await getAdapter();
  const now = Date.now();

  const patterns = parseAllowedModels(allowedModels);
  const modelAllowed = (model) => matchesModelPatterns(patterns, model);

  // For "today" and "24h", use hourly buckets from usageHistory (already has filterApiKey support)
  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, requests: 0 }));

    const sql = filterApiKey
      ? `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND apiKey = ?`
      : `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`;
    const params = filterApiKey ? [new Date(startTime).toISOString(), filterApiKey] : [new Date(startTime).toISOString()];
    const rows = db.all(sql, params);
    for (const r of rows) {
      if (!modelAllowed(r.model)) continue;
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
        buckets[idx].cost += r.cost || 0;
        buckets[idx].requests += 1;
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, requests: 0 }));

    const sql = filterApiKey
      ? `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND apiKey = ?`
      : `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`;
    const params = filterApiKey ? [new Date(startTime).toISOString(), filterApiKey] : [new Date(startTime).toISOString()];
    const rows = db.all(sql, params);
    for (const r of rows) {
      if (!modelAllowed(r.model)) continue;
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      buckets[idx].cost += r.cost || 0;
      buckets[idx].requests += 1;
    }
    return buckets;
  }

  // For "all", "7d", "30d", "60d" - use daily buckets
  // If filterApiKey is provided, query usageHistory directly to avoid leaking data from other API keys
  // usageDaily contains aggregated data for ALL API keys in its byApiKey field
  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  let startTime;
  let bucketCount;
  if (period === "all") {
    // For "all", find earliest date from usageHistory
    const earliestRow = db.get(`SELECT MIN(timestamp) as minTs FROM usageHistory${filterApiKey ? ' WHERE apiKey = ?' : ''}`, filterApiKey ? [filterApiKey] : []);
    if (!earliestRow?.minTs) return [];
    const earliest = new Date(earliestRow.minTs);
    earliest.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    bucketCount = Math.max(1, Math.round((today - earliest) / 86400000) + 1);
    startTime = earliest.getTime();
  } else {
    bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    startTime = today.getTime() - (bucketCount - 1) * 86400000;
  }

  // Query usageHistory directly when filterApiKey is provided, otherwise use usageDaily for performance
  if (filterApiKey) {
    const sql = `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND apiKey = ?`;
    const params = [new Date(startTime).toISOString(), filterApiKey];
    const rows = db.all(sql, params);

    const dayMap = {};
    for (const r of rows) {
      if (!modelAllowed(r.model)) continue;
      const d = new Date(r.timestamp);
      d.setHours(0, 0, 0, 0);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (!dayMap[dateKey]) dayMap[dateKey] = { tokens: 0, cost: 0, requests: 0 };
      dayMap[dateKey].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      dayMap[dateKey].cost += r.cost || 0;
      dayMap[dateKey].requests += 1;
    }

    return Array.from({ length: bucketCount }, (_, i) => {
      const d = new Date(startTime + i * 86400000);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dayData = dayMap[dateKey];
      return {
        label: labelFn(d),
        tokens: dayData ? dayData.tokens : 0,
        cost: dayData ? dayData.cost : 0,
        requests: dayData ? dayData.requests : 0,
      };
    });
  }

  // No filterApiKey - use usageDaily for better performance (admin/global view)
  const dayRows = loadDaysInRange(db, period === "all" ? null : bucketCount);
  const dayMap = {};
  for (const r of dayRows) {
    const dayData = parseJson(r.data, {});
    if (patterns === null) {
      // No model restriction - use day totals directly
      dayMap[r.dateKey] = dayData;
    } else {
      // Model restricted - sum only matching models from byModel
      let totalRequests = 0;
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalCachedTokens = 0;
      let totalCost = 0;
      for (const [mk, m] of Object.entries(dayData.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        if (!modelAllowed(rawModel)) continue;
        totalRequests += m.requests || 0;
        totalPromptTokens += m.promptTokens || 0;
        totalCompletionTokens += m.completionTokens || 0;
        totalCachedTokens += m.cachedTokens || 0;
        totalCost += m.cost || 0;
      }
      if (totalRequests > 0) {
        dayMap[r.dateKey] = {
          requests: totalRequests,
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          cachedTokens: totalCachedTokens,
          cost: totalCost,
        };
      }
    }
  }

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(startTime + i * 86400000);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      cost: dayData ? (dayData.cost || 0) : 0,
      requests: dayData ? (dayData.requests || 0) : 0,
    };
  });
}

/**
 * Compact per-day totals for the Overview sparklines (#16) plus a session-
 * scoped activity pulse for the heatmap (#15).
 *
 * The sparklines read `usageDaily`, so an idle day is a real zero — distinct
 * from the chart API, which merges today's live rows. The heatmap buckets the
 * 60 most recent session-scoped requests by local weekday × hour; session
 * scoping matches the rest of the Overview, so a key user sees their own
 * pattern and not the whole server's.
 */
export async function getSparks(period = "30d", filterApiKey = null, allowedModels = "*") {
  const db = await getAdapter();

  const patterns = parseAllowedModels(allowedModels);
  const modelAllowed = (model) => matchesModelPatterns(patterns, model);

  const DAYS = { today: 1, "24h": 1, "7d": 7, "30d": 30, "60d": 60, all: 60 }[period] || 30;

  const totals = { requests: [], input: [], output: [], cost: [], cached: [] };
  const rows = db.all(
    `SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`,
    [localCutoffKey(DAYS)],
  );
  const byKey = {};
  for (const r of rows) byKey[r.dateKey] = parseJson(r.data, {});

  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const key = offsetKey(i);
    const day = byKey[key];
    if (!day) {
      totals.requests.push(0); totals.input.push(0); totals.output.push(0);
      totals.cost.push(0); totals.cached.push(0);
      continue;
    }
    // usageDaily has no top-level cachedTokens — it lives per model bucket.
    const dayCached = Object.values(day.byModel || {}).reduce(
      (sum, m) => sum + (Number(m.cachedTokens) || 0), 0,
    );
    if (patterns === null && !filterApiKey) {
      totals.requests.push(Number(day.requests) || 0);
      totals.input.push(Number(day.promptTokens) || 0);
      totals.output.push(Number(day.completionTokens) || 0);
      totals.cost.push(Number(day.cost) || 0);
      totals.cached.push(dayCached);
      continue;
    }
    // Session-scoped: sum only the allowed models from the per-model buckets.
    let req = 0, pin = 0, pout = 0, cost = 0, cached = 0;
    for (const [mk, m] of Object.entries(day.byModel || {})) {
      const rawModel = m.rawModel || String(mk).split("|")[0];
      if (!modelAllowed(rawModel)) continue;
      req += Number(m.requests) || 0;
      pin += Number(m.promptTokens) || 0;
      pout += Number(m.completionTokens) || 0;
      cost += Number(m.cost) || 0;
      cached += Number(m.cachedTokens) || 0;
    }
    totals.requests.push(req); totals.input.push(pin); totals.output.push(pout);
    totals.cost.push(cost); totals.cached.push(cached);
  }

  // Heatmap source: the most recent rows the session may see. Capped — a
  // heat cell is a traffic pattern, not an audit trail.
  const keyRows = filterApiKey
    ? db.all(
        `SELECT timestamp FROM usageHistory WHERE apiKey = ? ORDER BY id DESC LIMIT 500`,
        [filterApiKey],
      )
    : db.all(`SELECT timestamp FROM usageHistory ORDER BY id DESC LIMIT 500`);
  const heatTimestamps = keyRows.map((r) => r.timestamp);

  return { days: DAYS, totals, heatTimestamps };
}

function toLocalKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function offsetKey(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return toLocalKey(d);
}

function localCutoffKey(n) {
  return offsetKey(n - 1);
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(limit = 200, filterApiKey = null) {
  try {
    const db = await getAdapter();
    // Fix (cross-tenant PII): apikey sessions only ever see their own rows —
    // same scoping getUsageStats already applies via filterApiKey.
    const rows = filterApiKey
      ? db.all(
          `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status, tokens FROM usageHistory WHERE apiKey = ? ORDER BY id DESC LIMIT ?`,
          [filterApiKey, limit],
        )
      : db.all(
          `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
          [limit],
        );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      const costFormatted = Number(r.cost) > 0 ? `$${Number(r.cost).toFixed(4)}` : "$0.00";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"} | ${costFormatted}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}
