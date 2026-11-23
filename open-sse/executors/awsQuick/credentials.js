// aws-quick credential freshness + persistence.
//
// The Quick WS handshake bakes the id_token into the connection URL, and the
// qbs-event usage probe carries it as a Bearer — a mid-stream refresh cannot
// fix either, so freshness is checked BEFORE the turn. The contract:
//
//   accessToken  = id_token (~1h life)
//   refreshToken = AWS ROTATES it on every refresh — the rotated value must be
//                  persisted to the connection row or the next refresh reuses
//                  a spent token and dies with invalid_grant
//   expiresAt    = epoch ms
//
// chatCore's 401/403 path persists the merged credentials itself (via
// onCredentialsRefreshed → updateProviderCredentials); this module covers the
// pre-flight path, persisting through updateProviderConnection directly.

import { refreshAwsQuickToken } from "../../services/tokenRefresh.js";

// Renew when the id_token has <2min left. The socket is reused across turns,
// so an expired token is only fatal for a NEW handshake — keep the lead tight
// but non-zero; the registry's oauth.refreshLeadMs (10min) governs the
// proactive scheduler, this is the just-in-time floor.
const REFRESH_LEAD_MS = 120_000;

// Per-connection single-flight: two requests landing in the same second must
// not refresh twice (every refresh burns the previous refresh token).
const inflight = (globalThis.__awsQuickRefreshInflight ||= new Map());

function expiryMsOf(credentials) {
  const raw = credentials?.expiresAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === "string" && raw.trim()) {
    const ms = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : new Date(raw).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  // Fallback: decode exp out of the id_token JWT itself.
  const jwt = String(credentials?.accessToken || "");
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] || "", "base64").toString("utf8"));
    if (Number.isFinite(payload?.exp)) return payload.exp * 1000;
  } catch {}
  return null;
}

export function isAwsQuickTokenFresh(credentials, nowMs = Date.now()) {
  const exp = expiryMsOf(credentials);
  if (exp === null) return !!credentials?.accessToken; // unknown expiry: try it
  return exp - nowMs > REFRESH_LEAD_MS;
}

/**
 * Persist refreshed credentials to the connection row (rotated RT included).
 * Best-effort: an in-memory-only refresh still serves this request.
 */
async function persistRefreshed(connectionId, refreshed, currentCredentials) {
  if (!connectionId) return;
  try {
    const { updateProviderConnection } = await import("@/lib/localDb");
    const expiresAt = refreshed.expiresIn
      ? Date.now() + refreshed.expiresIn * 1000
      : currentCredentials?.expiresAt;
    await updateProviderConnection(connectionId, {
      ...(refreshed.accessToken ? { accessToken: refreshed.accessToken } : {}),
      ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
      ...(expiresAt ? { expiresAt, tokenExpiresAt: expiresAt } : {}),
      lastRefreshAt: new Date().toISOString(),
      testStatus: "active",
      // providerSpecificData is merged by callers that know the full row; pass
      // it through unchanged — the RT rotation lives on the top-level columns.
      providerSpecificData: currentCredentials?.providerSpecificData,
    });
  } catch (e) {
    // The executor's 401 path re-persists via chatCore onCredentialsRefreshed,
    // so a failed pre-flight persist is not fatal.
    console.error(`[aws-quick] failed to persist refreshed credentials: ${e.message}`);
  }
}

/**
 * Return credentials whose accessToken is good for at least REFRESH_LEAD_MS,
 * refreshing (single-flight per connection) when needed.
 *
 * @returns {Promise<{credentials:object, refreshed:boolean, error:Error|null}>}
 *   credentials is the (possibly merged) input object on success; on refresh
 *   failure the original credentials come back untouched with `error` set.
 */
export async function ensureFreshAwsQuickCredentials(credentials, log) {
  if (!credentials) return { credentials, refreshed: false, error: null };
  if (isAwsQuickTokenFresh(credentials)) return { credentials, refreshed: false, error: null };
  if (!credentials.refreshToken) {
    return {
      credentials,
      refreshed: false,
      error: new Error("Amazon Quick access token expired and no refresh token is stored — reconnect the provider"),
    };
  }

  const key = String(credentials.connectionId || credentials.id || credentials.refreshToken.slice(-24));
  const existing = inflight.get(key);
  if (existing) {
    const result = await existing;
    return { ...result, refreshed: false }; // someone else did the refresh
  }

  const pending = (async () => {
    try {
      const refreshed = await refreshAwsQuickToken(credentials.refreshToken, credentials.providerSpecificData, log);
      if (!refreshed?.accessToken) {
        return { credentials, refreshed: false, error: new Error(refreshed?.error || "Amazon Quick token refresh failed — reconnect the provider") };
      }
      const merged = { ...credentials };
      merged.accessToken = refreshed.accessToken;
      if (refreshed.refreshToken) merged.refreshToken = refreshed.refreshToken;
      if (refreshed.idToken) merged.idToken = refreshed.idToken;
      if (refreshed.expiresIn) merged.expiresAt = Date.now() + refreshed.expiresIn * 1000;
      merged.lastRefreshAt = new Date().toISOString();
      await persistRefreshed(credentials.connectionId || credentials.id, refreshed, credentials);
      log?.info?.("TOKEN_REFRESH", "aws-quick credentials refreshed");
      return { credentials: merged, refreshed: true, error: null };
    } catch (e) {
      return { credentials, refreshed: false, error: e };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, pending);
  return pending;
}
