import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId, quarantineProxy, isProxyQuarantined } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import { getAffinityConnectionId, setAffinityConnection, touchAffinity, clearAffinity } from "./conversationAffinity.js";
import { tripCircuitBreaker, isCircuitBreakerOpen, recordCircuitSuccess } from "./circuitBreaker.js";

export { apiKeyGateFailure, shouldLogAuthFailure } from "./keyGate.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const conversationKey = options?.conversationKey || null;
  const requestedModel = options?.requestedModel || model;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth || AI_PROVIDERS[providerId]?.noAuth) {
      if (excludeSet.has("noauth") || excludeSet.has("noauth-direct")) return null;
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      const hasProxyConfigured = Boolean(override.proxyPoolId && override.proxyPoolId !== "__none__") || strategy !== "none";

      let pickedId = null;

      if (hasProxyConfigured) {
        // Proxy / rotation is ON: aggressively rotate across active proxies in pool, no direct VPS fallback
        const allPools = await getProxyPools({ isActive: true });
        // Prioritize healthy proxies (active status & lowest latency first)
        const sortedPools = [...allPools]
          .filter(p => p.proxyUrl)
          .sort((a, b) => {
            const statusScore = (s) => (s === "active" ? 0 : s === "unknown" ? 1 : 2);
            const scoreDiff = statusScore(a.testStatus) - statusScore(b.testStatus);
            if (scoreDiff !== 0) return scoreDiff;
            return (a.latencyMs || 9999) - (b.latencyMs || 9999);
          });

        const poolIds = sortedPools.map(p => p.id);
        const eligiblePoolIds = poolIds.filter(id => !excludeSet.has(`noauth-proxy:${id}`) && !isProxyQuarantined(id));

        const rotStrategy = strategy !== "none" ? strategy : "round-robin";
        const candidateId = (override.proxyPoolId && override.proxyPoolId !== "__none__") ? override.proxyPoolId : null;

        // If rotation strategy is explicitly "none" (single proxy pinned), try candidateId first
        if (strategy === "none" && candidateId && !excludeSet.has(`noauth-proxy:${candidateId}`) && !isProxyQuarantined(candidateId)) {
          pickedId = candidateId;
        } else if (eligiblePoolIds.length > 0) {
          pickedId = pickProxyPoolId(eligiblePoolIds, rotStrategy, providerId) || eligiblePoolIds[0];
        } else {
          // Fallback to any non-excluded poolId even if quarantined if pool has no non-quarantined proxies left
          const fallbackPoolIds = poolIds.filter(id => !excludeSet.has(`noauth-proxy:${id}`));
          pickedId = fallbackPoolIds.length > 0 ? fallbackPoolIds[0] : null;
        }

        // When proxy/rotation is ON, fail when all proxies are exhausted (never leak/fallback to direct VPS IP)
        if (!pickedId) {
          return null;
        }
      } else {
        // Proxy is OFF: use direct VPS connection as usual
        return {
          id: "noauth-direct",
          connectionId: "noauth-direct",
          connectionName: "Public (Direct)",
          isActive: true,
          accessToken: "public",
          providerSpecificData: {
            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: "",
            connectionProxyPoolId: null,
            vercelRelayUrl: "",
          },
        };
      }

      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId });
      // Special rule: opencode should NEVER be forced to vercel-relay unless explicitly configured
      // Cloudflare blocks Vercel server IP ranges from accessing OpenCode free models
      if (providerId === "opencode" && resolvedProxy.vercelRelayUrl) {
        resolvedProxy.vercelRelayUrl = "";
      }

      const hasProxy = Boolean(resolvedProxy.connectionProxyUrl || resolvedProxy.vercelRelayUrl);
      const connId = hasProxy ? `noauth-proxy:${pickedId}` : "noauth-direct";

      return {
        id: connId,
        connectionId: connId,
        connectionName: hasProxy ? "Public (Proxy)" : "Public (Direct)",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || pickedId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, circuit-broken, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      if (isCircuitBreakerOpen(c.id)) return false;
      const enabled = c.providerSpecificData?.enabledModels;
      if (providerId === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }

    // Cache-Aware Conversation Affinity (KV prompt-cache hit preservation)
    if (!connection && conversationKey && settings.cacheAffinityEnabled !== false) {
      const affinityId = getAffinityConnectionId(providerId, conversationKey);
      if (affinityId) {
        const affinityConn = availableConnections.find((c) => c.id === affinityId);
        if (affinityConn) {
          connection = affinityConn;
          log.info("CACHE_AFFINITY", `${provider} | warm KV-cache match → sticky on ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
          touchAffinity(providerId, conversationKey, connection.id);
          await updateProviderConnection(connection.id, {
            lastUsedAt: new Date().toISOString(),
            consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
          });
        } else {
          clearAffinity(providerId, conversationKey);
        }
      }
    }

    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    if (connection && conversationKey && settings.cacheAffinityEnabled !== false) {
      setAffinityConnection(providerId, conversationKey, connection.id);
    }

    let connectionSpecificData = connection.providerSpecificData || {};

    // Provider-level proxy rotation for standard providers (Round-robin live pools / Random)
    if (providerOverride.rotateStrategy && providerOverride.rotateStrategy !== "none") {
      try {
        const { getProxyPools } = await import("@/lib/db/repos/proxyPoolsRepo");
        const allPools = await getProxyPools({ isActive: true });
        const validPools = allPools.filter((p) => p.proxyUrl);
        const eligiblePools = validPools.filter((p) => !isProxyQuarantined(p.id));
        const activeList = eligiblePools.length > 0 ? eligiblePools : validPools;

        if (activeList.length > 0) {
          const poolIds = activeList.map((p) => p.id);
          const pickedPoolId = pickProxyPoolId(poolIds, providerOverride.rotateStrategy, providerId) || poolIds[0];
          if (pickedPoolId) {
            connectionSpecificData = {
              ...connectionSpecificData,
              proxyPoolId: pickedPoolId,
            };
          }
        }
      } catch (err) {
        log.warn("AUTH", `${provider} | proxy rotation resolution failed: ${err.message}`);
      }
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connectionSpecificData);

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId) return { shouldFallback: false, cooldownMs: 0 };
  if (connectionId.startsWith("noauth-proxy")) {
    // Quarantine proxy if it failed with 403, 429, 524, 502, 504, or timeout/Abuse/Rate limit
    const isProxyFailure = status === 403 || status === 429 || status === 524 || status === 502 || status === 504 ||
      (errorText && (
        errorText.includes("Abuse") ||
        errorText.includes("timeout") ||
        errorText.includes("524") ||
        errorText.includes("FreeTierError") ||
        errorText.includes("FreeUsageLimitError") ||
        errorText.includes("Rate limit exceeded")
      ));
    if (isProxyFailure) {
      const parts = connectionId.split(":");
      if (parts[1]) {
        quarantineProxy(parts[1], 15 * 60 * 1000);
      }
    }
    // A proxy failure on a free no-auth provider should rotate IMMEDIATELY (0ms) to another proxy in pool!
    return { shouldFallback: true, cooldownMs: 0 };
  }
  if (connectionId === "noauth" || connectionId === "noauth-direct") {
    // If direct VPS IP encounters a temporary 403, 429, 524, 502, 504, try next fallback connection if available
    if (status === 403 || status === 429 || status === 524 || status === 502 || status === 504) {
      return { shouldFallback: true, cooldownMs: 15000 };
    }
    return { shouldFallback: false, cooldownMs: 0 };
  }
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, shouldLock, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, shouldLock, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  // A rejected request is the caller's mistake, so no account gets cooled down.
  if (shouldLock === false) return { shouldFallback: false, cooldownMs: 0 };
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  const settings = await getSettings();

  // If an account is permanently dead (401 invalid key, 403 forbidden/banned, 402 out of credits/insufficient balance),
  // auto-delete it immediately when autoDeleteDeadKeys is enabled.
  const isDeadAuth = status === 401 || status === 403;
  const isOutOfCredits = status === 402 || (typeof errorText === "string" && (
    errorText.toLowerCase().includes("insufficient_quota") ||
    errorText.toLowerCase().includes("quota exceeded") ||
    errorText.toLowerCase().includes("out of credits") ||
    errorText.toLowerCase().includes("balance is insufficient") ||
    errorText.toLowerCase().includes("token quota exhausted") ||
    errorText.toLowerCase().includes("invalid_api_key")
  ));

  if (settings.autoDeleteDeadKeys === true || settings.autoPruneDeadConnections === true) {
    if (isDeadAuth || isOutOfCredits) {
      try {
        const { deleteProviderConnection } = await import("@/lib/localDb");
        await deleteProviderConnection(connectionId);
        log.warn("AUTH", `🗑 Auto-deleted dead/exhausted connection ${connName} [${status}]`);
        return { shouldFallback: true, cooldownMs: 0 };
      } catch (e) {
        log.error("AUTH", `Failed to auto-delete dead connection ${connectionId}:`, e.message);
      }
    }
  }

  // Do NOT trip circuit breaker on per-model rate limits (e.g. Tagflow/ADCode "upstream-rate-limit" or single-model 429)
  // Circuit breaker should only trip when an account itself is dead/failing globally (5xx/connection failure/exhausted)
  const isPerModelRateLimit = status === 429 && (
    (typeof reason === "string" && (
      reason.includes("upstream-rate-limit") ||
      reason.includes("FreeUsageLimitError") ||
      reason.includes("rate limit") ||
      reason.includes("Model is unavailable")
    )) ||
    model
  );

  // Trip circuit breaker on actual connection/server-level errors (not per-model rate limits)
  if (shouldFallback && connectionId && connectionId !== "noauth" && !isPerModelRateLimit) {
    tripCircuitBreaker(connectionId, { status, error: reason, provider, model });
  }

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey, requestedModel = null, clientIp = null) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey, requestedModel, clientIp);
}

