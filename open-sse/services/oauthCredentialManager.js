import {
  getRefreshLeadMs,
  isUnrecoverableRefreshError,
  refreshTokenByProvider,
} from "./tokenRefresh.js";
import { PROVIDER_OAUTH } from "../providers/index.js";
import { REFRESH_GUARD_CONFIG } from "../config/runtimeConfig.js";

// Single source: codex.oauth.maxRefreshAgeMs (8 days) — proactive refresh window
export const CODEX_MAX_REFRESH_AGE_MS = PROVIDER_OAUTH["codex"]?.maxRefreshAgeMs;

const refreshLocks = new Map();
const refreshCooldowns = new Map();

// Providers whose refresh flow does not consume a refreshToken (service-account JSON
// or a locally-held credential). Everything else needs a real refreshToken to work.
const REFRESH_WITHOUT_REFRESH_TOKEN = new Set(["vertex", "vertex-partner", "zed"]);

function parseTimeMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toExpiresAt(expiresIn, nowMs = Date.now()) {
  if (!expiresIn) return null;
  return new Date(nowMs + expiresIn * 1000).toISOString();
}

export function getCredentialExpiryMs(credentials) {
  return parseTimeMs(credentials?.expiresAt ?? credentials?.tokenExpiresAt);
}

export function getCredentialLastRefreshMs(credentials) {
  return parseTimeMs(
    credentials?.lastRefreshAt ??
    credentials?.lastRefresh ??
    credentials?.providerSpecificData?.lastRefreshAt
  );
}

export function isCodexRefreshStale(credentials, nowMs = Date.now(), maxAgeMs = CODEX_MAX_REFRESH_AGE_MS) {
  const lastRefreshMs = getCredentialLastRefreshMs(credentials);
  return !lastRefreshMs || nowMs - lastRefreshMs >= maxAgeMs;
}

export function shouldRefreshCredentials(provider, credentials, nowMs = Date.now()) {
  if (!credentials) return false;

  const expiresAtMs = getCredentialExpiryMs(credentials);
  if (expiresAtMs !== null && expiresAtMs - nowMs < getRefreshLeadMs(provider)) {
    return true;
  }

  // Proactive stale refresh for providers declaring oauth.maxRefreshAgeMs (e.g. codex)
  const maxAgeMs = PROVIDER_OAUTH[provider]?.maxRefreshAgeMs;
  if (maxAgeMs && credentials.refreshToken && isCodexRefreshStale(credentials, nowMs, maxAgeMs)) {
    return true;
  }

  return false;
}

export function mergeProviderSpecificData(existing, next) {
  if (!next || typeof next !== "object") return existing;
  return {
    ...(existing || {}),
    ...next,
  };
}

export function mergeRefreshedCredentials(provider, currentCredentials, refreshedCredentials, nowMs = Date.now()) {
  if (!refreshedCredentials) return null;
  if (isUnrecoverableRefreshError(refreshedCredentials)) return refreshedCredentials;

  const next = {};
  const nowIso = new Date(nowMs).toISOString();

  if (refreshedCredentials.accessToken) next.accessToken = refreshedCredentials.accessToken;
  if (refreshedCredentials.apiKey) next.apiKey = refreshedCredentials.apiKey;
  if (refreshedCredentials.token) next.token = refreshedCredentials.token;

  const refreshToken = refreshedCredentials.refreshToken ?? currentCredentials?.refreshToken;
  if (refreshToken) next.refreshToken = refreshToken;

  const idToken = refreshedCredentials.idToken ?? currentCredentials?.idToken;
  if (idToken) next.idToken = idToken;

  if (refreshedCredentials.expiresIn) {
    next.expiresIn = refreshedCredentials.expiresIn;
    next.expiresAt = toExpiresAt(refreshedCredentials.expiresIn, nowMs);
  } else if (refreshedCredentials.expiresAt) {
    next.expiresAt = refreshedCredentials.expiresAt;
  }

  if (refreshedCredentials.projectId) next.projectId = refreshedCredentials.projectId;

  if (refreshedCredentials.providerSpecificData) {
    next.providerSpecificData = mergeProviderSpecificData(
      currentCredentials?.providerSpecificData,
      refreshedCredentials.providerSpecificData
    );
  }

  if (refreshedCredentials.copilotToken) next.copilotToken = refreshedCredentials.copilotToken;
  if (refreshedCredentials.copilotTokenExpiresAt) {
    next.copilotTokenExpiresAt = refreshedCredentials.copilotTokenExpiresAt;
  }

  // trackRefreshAt providers (e.g. codex) always stamp lastRefreshAt for staleness tracking
  if (
    PROVIDER_OAUTH[provider]?.trackRefreshAt ||
    next.accessToken ||
    next.apiKey ||
    next.token ||
    next.refreshToken ||
    next.copilotToken
  ) {
    next.lastRefreshAt = refreshedCredentials.lastRefreshAt || nowIso;
  }

  return next;
}

function getRefreshLockKey(provider, credentials) {
  const stableId =
    credentials?.connectionId ||
    credentials?.id ||
    credentials?.email ||
    credentials?.name ||
    credentials?.refreshToken?.slice?.(-16) ||
    "default";
  return `${provider}:${stableId}`;
}

/**
 * Can this connection actually be refreshed?
 *
 * A connection with an expired (or missing) `expiresAt` but no `refreshToken` used to
 * fall through to the refresh path anyway: the attempt could never succeed, but it ran
 * on every request and on every scheduler tick, with no spacing and no cap. Checking
 * here keeps empty connections out of the refresh pipeline entirely.
 *
 * @param {string} provider
 * @param {object} credentials
 * @returns {boolean}
 */
export function canRefreshCredentials(provider, credentials) {
  if (!credentials) return false;
  if (REFRESH_WITHOUT_REFRESH_TOKEN.has(provider)) return true;
  const token = credentials.refreshToken;
  return typeof token === "string" && token.trim() !== "";
}

function pruneExpiredCooldowns(nowMs) {
  for (const [key, entry] of refreshCooldowns) {
    if (entry.until <= nowMs) refreshCooldowns.delete(key);
  }
}

/**
 * Remaining cooldown for this connection, in ms (0 when not cooling down).
 * @param {string} provider
 * @param {object} credentials
 * @param {number} [nowMs]
 * @returns {number}
 */
export function getRefreshCooldown(provider, credentials, nowMs = Date.now()) {
  if (!credentials) return 0;
  const key = getRefreshLockKey(provider, credentials);
  const entry = refreshCooldowns.get(key);
  if (!entry) return 0;
  const remaining = entry.until - nowMs;
  if (remaining <= 0) {
    refreshCooldowns.delete(key);
    return 0;
  }
  return remaining;
}

/**
 * Put a connection on refresh cooldown.
 * @param {string} provider
 * @param {object} credentials
 * @param {"no_refresh_token"|"refresh_failed"} reason
 * @param {number} [nowMs]
 * @returns {number} applied cooldown in ms
 */
export function markRefreshCooldown(provider, credentials, reason = "refresh_failed", nowMs = Date.now()) {
  if (!credentials) return 0;
  const key = getRefreshLockKey(provider, credentials);
  const ttl =
    reason === "no_refresh_token"
      ? REFRESH_GUARD_CONFIG.noRefreshTokenCooldownMs
      : REFRESH_GUARD_CONFIG.failureCooldownMs;

  if (refreshCooldowns.size >= REFRESH_GUARD_CONFIG.maxCooldownEntries) {
    pruneExpiredCooldowns(nowMs);
    // Still full: drop the oldest entry so the map stays bounded.
    while (refreshCooldowns.size >= REFRESH_GUARD_CONFIG.maxCooldownEntries) {
      const oldest = refreshCooldowns.keys().next().value;
      if (oldest === undefined) break;
      refreshCooldowns.delete(oldest);
    }
  }

  refreshCooldowns.set(key, { until: nowMs + ttl, reason });
  return ttl;
}

/** Clear cooldown after a successful refresh. */
export function clearRefreshCooldown(provider, credentials) {
  if (!credentials) return;
  refreshCooldowns.delete(getRefreshLockKey(provider, credentials));
}

/** Test hook: drop all cooldown state. */
export function resetRefreshCooldowns() {
  refreshCooldowns.clear();
}

export async function withCredentialRefreshLock(provider, credentials, refreshFn) {
  const key = getRefreshLockKey(provider, credentials);
  const existing = refreshLocks.get(key);
  if (existing) return existing;

  const pending = Promise.resolve()
    .then(refreshFn)
    .finally(() => {
      refreshLocks.delete(key);
    });

  refreshLocks.set(key, pending);
  return pending;
}

export async function refreshProviderCredentials(provider, credentials, log) {
  if (!credentials) return null;
  if (!canRefreshCredentials(provider, credentials)) {
    log?.debug?.("TOKEN_REFRESH", "Refresh skipped: connection has no refreshToken", {
      provider,
      connectionId: credentials.connectionId || credentials.id || null,
    });
    return null;
  }

  return withCredentialRefreshLock(provider, credentials, async () => {
    const refreshed = await refreshTokenByProvider(provider, credentials, log);
    return mergeRefreshedCredentials(provider, credentials, refreshed);
  });
}
