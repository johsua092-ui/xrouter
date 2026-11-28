import { JETBRAINS_CONFIG } from "../constants/oauth.js";

const AI_BASE = "https://api.jetbrains.ai";

function parseJwtPayload(token) {
  try {
    if (!token || typeof token !== "string") return {};
    const parts = token.split(".");
    if (parts.length < 2) return {};
    return JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
  } catch {
    return {};
  }
}

const jetbrains = {
  config: JETBRAINS_CONFIG,
  flowType: "authorization_code_pkce",
  fixedPort: JETBRAINS_CONFIG.fixedPort || 62345,
  callbackPath: JETBRAINS_CONFIG.callbackPath || "/",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    // Upstream junie-cli strictly whitelists port 62345 loopback
    const validRedirectUri = redirectUri && redirectUri.includes("localhost:62345")
      ? redirectUri
      : "http://localhost:62345";
    const params = {
      response_type: "code",
      client_id: config.clientId || "junie-cli",
      redirect_uri: validRedirectUri,
      scope: config.scope || "offline_access openid jb-authn-service",
      code_challenge: codeChallenge,
      code_challenge_method: config.codeChallengeMethod || "S256",
      state,
    };
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    return `${config.authorizeUrl || "https://junie.jetbrains.com/cli-auth"}?${queryString}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    let cleanCode = code;
    if (typeof cleanCode === "string") {
      cleanCode = cleanCode.trim();
      if (cleanCode.includes("://") || cleanCode.includes("code=") || cleanCode.startsWith("/")) {
        try {
          const parsed = new URL(cleanCode.startsWith("http") ? cleanCode : `http://localhost${cleanCode.startsWith("/") ? "" : "/"}${cleanCode}`);
          cleanCode = parsed.searchParams.get("code") || cleanCode;
        } catch {}
      }
    }
    const validRedirectUri = redirectUri && redirectUri.includes("localhost:62345")
      ? redirectUri
      : "http://localhost:62345";
    const response = await fetch(config.tokenUrl || "https://oauth.account.jetbrains.com/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId || "junie-cli",
        code: cleanCode,
        redirect_uri: validRedirectUri,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`JetBrains token exchange failed: ${error}`);
    }

    return await response.json();
  },
  postExchange: async (tokens) => {
    const idToken = tokens.id_token;
    if (!idToken) return null;

    let licenseId = null;
    let grazieJwt = null;

    try {
      const liteRes = await fetch(`${AI_BASE}/auth/jetbrains-jwt/license/obtain/grazie-lite`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });

      if (liteRes.ok) {
        const liteJson = await liteRes.json();
        licenseId = liteJson.license?.licenseId || null;
        grazieJwt = liteJson.token || null;

        if (!grazieJwt && licenseId) {
          const pRes = await fetch(`${AI_BASE}/auth/jetbrains-jwt/provide-access/license/v2`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${idToken}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ licenseId }),
            signal: AbortSignal.timeout(15000),
          });

          if (pRes.ok) {
            const pData = await pRes.json().catch(() => null);
            grazieJwt = pData?.token || null;
          }
        }
      }
    } catch (err) {
      console.warn("[JETBRAINS] Failed to auto-provision Grazie-Lite JWT:", err.message);
    }

    return { licenseId, grazieJwt };
  },
  mapTokens: (tokens, extra) => {
    const idPayload = parseJwtPayload(tokens.id_token);
    const graziePayload = parseJwtPayload(extra?.grazieJwt);

    const email = idPayload.email || graziePayload.ownerEmail || idPayload.jbaLogin || "jetbrains-user";
    const name = idPayload.name || (email ? email.split("@")[0] : "JetBrains AI");

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresIn: tokens.expires_in,
      lastRefreshAt: new Date().toISOString(),
      email,
      displayName: `${name} (Grazie Lite)`,
      providerSpecificData: {
        licenseId: extra?.licenseId || "GZL",
        grazieJwt: extra?.grazieJwt || null,
        sub: idPayload.sub || null,
      },
    };
  },
};

export default jetbrains;
