import crypto from "crypto";
import { ZCODE_CONFIG } from "../constants/oauth.js";
import { resolveZcodeAuth } from "open-sse/services/zcodePlan.js";

// ZCode device login uses the official CLI polling flow (same endpoint as the
// `glm` provider). The web authorization-code flow is not usable here: the
// desktop client id only registers the zcode:// deep-link intermediary, so any
// dashboard callback is rejected with "Redirect URI not registered".
//
//   1) POST {cliInitUrl}  Authorization: Bearer ***  {"provider":"zai"}
//        → { data: { authorize_url, flow_id, poll_interval_sec, expires_at } }
//   2) Browser opens authorize_url; the user signs in.
//   3) GET {cliPollUrl}/<flow_id>  until status=ready
//        → { data: { status:"ready", token, user, zai: { access_token } } }
//   4) data.token            = zcode JWT (start-plan model key)
//      data.zai.access_token = Z.AI business token (coding-plan project key)
//
// The start-plan gateway fingerprints the caller, so the identity has to
// outlive a single request: a device mid that is re-derived per call (or a
// session id shared by every account) is exactly what the gateway answers with
// HTTP 405 code 3012 "unusual activity". Both are minted once here, carried on
// the connection, and reused for every later turn and usage read.
const TIMEOUT_MS = 20000;

function mintZcodeDeviceMid() {
  return crypto.randomUUID();
}

function mintZcodeSessionSeed() {
  return crypto.randomBytes(16).toString("hex");
}

function familyOf(meta, config) {
  if (meta?.family === "bigmodel") return "bigmodel";
  return config?.providerId === "bigmodel" ? "bigmodel" : "zai";
}

function isSuccessCode(code) {
  return code === undefined || code === null || code === 0 || code === 200 || code === "0" || code === "200";
}

function relativeSeconds(expiresAt) {
  const raw = Number(expiresAt);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const seconds = Math.floor((ms - Date.now()) / 1000);
  return seconds > 0 ? seconds : null;
}

async function readJson(response, label) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ZCode ${label} failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`ZCode ${label} response is not valid JSON`);
  }
}

const zcode = {
  config: ZCODE_CONFIG,
  flowType: "device_code",
  // A re-login mints a fresh plan JWT, so the device identity has to be reused
  // by account rather than by token: bumping token_version leaves the old
  // credential-keyed row unusable, and a brand-new device mid would read as an
  // unfamiliar device. Look the account up by email and hand its stored identity
  // back to mapTokens.
  resolveExistingIdentity: async (data) => {
    const email = String(data?.user?.email || "").trim();
    const accountUUID = String(data?.user?.user_id || "").trim();
    if (!email && !accountUUID) return null;
    try {
      const { getProviderConnections } = await import("@/lib/localDb");
      const rows = await getProviderConnections({ provider: "zcode" });
      const match = (rows || []).find((row) => {
        const psd = row?.providerSpecificData || {};
        const rowEmail = String(psd.email || row?.email || "").trim();
        const rowUUID = String(psd.accountUUID || psd.userId || "").trim();
        if (email && rowEmail && rowEmail.toLowerCase() === email.toLowerCase()) return true;
        if (accountUUID && rowUUID && rowUUID === accountUUID) return true;
        return false;
      });
      if (!match) return null;
      const psd = match.providerSpecificData || {};
      return {
        connectionId: match.id,
        deviceId: psd.deviceId || psd.deviceMid || null,
        sessionSeed: psd.sessionSeed || null,
        accountUUID: psd.accountUUID || psd.userId || accountUUID || null,
      };
    } catch {
      return null;
    }
  },
  requestDeviceCode: async (config, _codeChallenge, options = {}) => {
    const family = familyOf(options, config);
    const pollToken = crypto.randomBytes(32).toString("hex");
    const payload = await readJson(
      await fetch(config.cliInitUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pollToken}`,
        },
        body: JSON.stringify({ provider: family }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      "OAuth init"
    );
    if (!isSuccessCode(payload?.code) || !payload?.data) {
      throw new Error(payload?.msg || "ZCode OAuth init returned no data");
    }
    const data = payload.data;
    if (!data.flow_id || !data.authorize_url) {
      throw new Error("ZCode OAuth init response missing flow_id/authorize_url");
    }
    return {
      device_code: data.flow_id,
      verification_uri: data.authorize_url,
      expires_in: relativeSeconds(data.expires_at) ?? 300,
      interval: data.poll_interval_sec || 3,
      _zcodePollToken: pollToken,
      _zcodeFamily: family,
    };
  },
  pollToken: async (config, deviceCode, _codeVerifier, extraData = {}) => {
    const pollToken = extraData?._zcodePollToken;
    const family = familyOf(extraData, config);
    if (!pollToken) {
      return {
        ok: true,
        data: {
          error: "access_denied",
          error_description: "Missing ZCode poll token — restart the login flow",
        },
      };
    }

    let payload;
    try {
      payload = await readJson(
        await fetch(`${config.cliPollUrl}/${encodeURIComponent(deviceCode)}`, {
          headers: { Authorization: `Bearer ${pollToken}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
        "OAuth poll"
      );
    } catch (error) {
      return { ok: true, data: { error: "access_denied", error_description: error.message } };
    }

    if (!isSuccessCode(payload?.code)) {
      return { ok: true, data: { error: "access_denied", error_description: payload?.msg || "ZCode poll failed" } };
    }

    const data = payload.data || {};
    if (data.status === "pending") {
      return { ok: true, data: { error: "authorization_pending" } };
    }
    if (data.status === "failed") {
      return {
        ok: true,
        data: { error: "access_denied", error_description: "ZCode authorization failed or was cancelled" },
      };
    }
    if (data.status !== "ready") {
      return { ok: true, data: { error: "authorization_pending", error_description: `Unknown status: ${data.status}` } };
    }

    const providerData = data[family] || data[config.providerId] || {};
    const accessToken =
      providerData.access_token || providerData.accessToken || data.accessToken || data.access_token;
    if (!accessToken) {
      return {
        ok: true,
        data: { error: "access_denied", error_description: "ZCode poll response missing access token" },
      };
    }

    return {
      ok: true,
      data: {
        access_token: accessToken,
        _zcodeJwtToken: data.token || "",
        _zcodeFamily: family,
        _zcodeRefreshToken:
          providerData.refresh_token || providerData.refreshToken || data.refresh_token || data.refreshToken || "",
        _zcodeUser: data.user || {},
      },
    };
  },
  postExchange: async (tokens) => {
    try {
      const plan = await resolveZcodeAuth({
        accessToken: tokens.access_token,
        providerSpecificData: {
          family: tokens._zcodeFamily,
          zcodeJwtToken: tokens._zcodeJwtToken,
          oauthAccessToken: tokens.access_token,
        },
      });
      return { plan };
    } catch (error) {
      return { planError: error?.message || String(error) };
    }
  },
  mapTokens: (tokens, extra) => {
    const family = tokens._zcodeFamily === "bigmodel" ? "bigmodel" : "zai";
    const user = tokens._zcodeUser || {};
    const name = family === "bigmodel" ? "ZCode (BigModel)" : "ZCode (Z.AI)";
    const displayName = user.name || user.email || name;
    // Carry the fingerprint forward: reuse the identity already stored for this
    // account when re-linking, otherwise mint a fresh one. Regenerating it on
    // every login reads as a new device to the gateway and trips 3012.
    const existing = extra?.existingIdentity || {};
    const deviceId = existing.deviceId || mintZcodeDeviceMid();
    const sessionSeed = existing.sessionSeed || mintZcodeSessionSeed();
    return {
      accessToken: tokens.access_token,
      refreshToken: null,
      name: displayName,
      displayName,
      email: user.email || null,
      providerSpecificData: {
        authMethod: "oauth",
        family,
        zcodeJwtToken: tokens._zcodeJwtToken || undefined,
        oauthAccessToken: tokens.access_token,
        ...(tokens._zcodeRefreshToken ? { zaiRefreshToken: tokens._zcodeRefreshToken } : {}),
        ...(user.user_id ? { userId: user.user_id } : {}),
        ...(user.name ? { username: user.name } : {}),
        zcodeClientVersion: ZCODE_CONFIG.clientVersion,
        // Identity bundle — stable per account, never per request.
        deviceId,
        deviceMid: deviceId,
        sessionSeed,
        ...(user.user_id ? { accountUUID: user.user_id } : {}),
        ...(extra?.plan?.persist || {}),
        ...(extra?.planError ? { zcodePlanError: extra.planError } : {}),
      },
    };
  },
};

export default zcode;
