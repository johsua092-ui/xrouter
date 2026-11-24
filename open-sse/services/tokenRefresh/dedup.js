const REFRESH_RESULT_TTL_MS = 10_000;
const refreshDedupCache = new Map();

// Entries expire after REFRESH_RESULT_TTL_MS but were only dropped when the same
// key was looked up again. Refresh tokens rotate on every use, so every refresh
// created a NEW key that stayed in the map forever — slow, unbounded growth over
// months. Sweep expired entries once the map gets sizeable.
const PRUNE_AT = 100;
function pruneExpired(now = Date.now()) {
  if (refreshDedupCache.size < PRUNE_AT) return;
  for (const [k, v] of refreshDedupCache) {
    if (!v.promise && v.expiresAt <= now) refreshDedupCache.delete(k);
  }
}

export async function dedupRefresh(provider, oldToken, fn, log) {
  if (!oldToken) return fn();
  pruneExpired();
  const key = `${provider}:${oldToken}`;
  const hit = refreshDedupCache.get(key);
  if (hit) {
    if (hit.promise) {
      log?.info?.("TOKEN_REFRESH", `Reusing in-flight refresh for ${provider}`);
      return hit.promise;
    }
    if (hit.expiresAt > Date.now()) {
      log?.info?.("TOKEN_REFRESH", `Reusing recent refresh result for ${provider}`);
      return hit.result;
    }
    refreshDedupCache.delete(key);
  }
  const promise = (async () => {
    try {
      const result = await fn();
      refreshDedupCache.set(key, { result, expiresAt: Date.now() + REFRESH_RESULT_TTL_MS });
      return result;
    } catch (err) {
      refreshDedupCache.delete(key);
      throw err;
    }
  })();
  refreshDedupCache.set(key, { promise });
  return promise;
}
