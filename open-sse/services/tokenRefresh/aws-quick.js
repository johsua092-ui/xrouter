// Amazon Quick (AWS) token refresh.
//
// Ported from magpie-aws-quick lib/oauth.mjs refreshSession() (MIT). AWS's
// OIDC endpoint answers camelCase JSON ({accessToken, refreshToken, expiresIn})
// — the same dialect Kiro's AWS SSO refresh uses — and ROTATES the refresh
// token on EVERY refresh, so the rotated value must reach the connection row
// (chatCore persists it via onCredentialsRefreshed; the usage route persists
// refreshAndUpdateCredentials).
//
// The token endpoint comes from the issuer's OIDC discovery document, with the
// regional oidc host as fallback. The access token we keep is the id_token
// (~1h) — it is what the Quick WS handshake and the qbs-event API take as
// Bearer; AWS OIDC also returns a separate opaque access_token which Quick
// never uses client-side, so it is ignored.

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { dedupRefresh } from "./dedup.js";

// issuerUrl → token_endpoint cache (discovery is immutable per issuer).
const endpointCache = new Map();

async function resolveTokenEndpoint(issuerUrl, region, log) {
  const issuer = String(issuerUrl || "").replace(/\/+$/, "");
  if (issuer) {
    if (!endpointCache.has(issuer)) {
      let ep = null;
      try {
        const r = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
        if (r.ok) ep = (await r.json())?.token_endpoint || null;
      } catch (e) {
        log?.debug?.("TOKEN_REFRESH", `Quick OIDC discovery failed for ${issuer}: ${e?.message || e}`);
      }
      endpointCache.set(issuer, ep);
    }
    const ep = endpointCache.get(issuer);
    if (ep) return ep;
  }
  return `https://oidc.${region || "us-east-1"}.amazonaws.com/token`;
}

/**
 * Refresh an Amazon Quick connection.
 * @param {string} refreshToken current (possibly already-rotated) refresh token
 * @param {object} providerSpecificData {issuerUrl, clientId, clientSecret, region, …}
 * @param {object} log
 * @returns {object|null} merged credentials {accessToken, refreshToken, idToken, expiresIn}
 */
export async function refreshAwsQuickToken(refreshToken, providerSpecificData, log) {
  if (!refreshToken) return null;
  return dedupRefresh("aws-quick", refreshToken, async () => {
    try {
      const psd = providerSpecificData || {};
      if (!psd.clientId || !psd.clientSecret) {
        log?.warn?.("TOKEN_REFRESH", "aws-quick refresh skipped: providerSpecificData is missing clientId/clientSecret");
        return null;
      }
      const endpoint = await resolveTokenEndpoint(psd.issuerUrl, psd.region, log);

      const response = await proxyAwareFetch(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          // AWS SSO OIDC dialect: camelCase JSON body (not form-encoded).
          body: JSON.stringify({
            clientId: psd.clientId,
            clientSecret: psd.clientSecret,
            grantType: "refresh_token",
            refreshToken,
          }),
        },
        null
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        log?.error?.("TOKEN_REFRESH", "Failed to refresh aws-quick token", {
          status: response.status,
          error: errorText.slice(0, 500),
        });
        return null;
      }

      const tokens = await response.json();
      // Prefer the id_token (what Quick's WS + qbs-event surfaces accept);
      // fall back to the opaque access_token when the id_token is absent.
      const idToken = tokens.idToken || tokens.id_token || "";
      const accessToken = idToken || tokens.accessToken || tokens.access_token || "";
      if (!accessToken) {
        log?.error?.("TOKEN_REFRESH", "aws-quick refresh returned no accessToken/idToken");
        return null;
      }

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed aws-quick token", {
        hasNewRefreshToken: !!(tokens.refreshToken || tokens.refresh_token),
        expiresIn: tokens.expiresIn ?? tokens.expires_in,
      });

      return {
        accessToken,
        idToken: idToken || undefined,
        // AWS rotates the refresh token on every refresh; keep the old one only
        // if the answer oddly omits it.
        refreshToken: tokens.refreshToken || tokens.refresh_token || refreshToken,
        expiresIn: tokens.expiresIn ?? tokens.expires_in,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Error refreshing aws-quick token: ${error.message}`);
      return null;
    }
  }, log);
}
