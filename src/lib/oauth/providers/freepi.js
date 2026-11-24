const FREEPI_API_BASE = "https://api.freepi.ai";
const CONSENT_VERSION = "4";
const CONSENT_ATTEMPTS = 2;

/**
 * Record consent for a device session. This is a hard prerequisite of the
 * upstream flow: until /auth/consent succeeds, every /auth/token poll answers
 * 403 {"code":"consent_required"} and the device session can never be
 * exchanged. Swallowing a failure here used to leave the user on a spinner for
 * the full device-code lifetime (899s) and then report a bare "Authorization
 * timeout" — the session was already dead before the browser even opened.
 */
async function submitConsent(consentUrl, sessionId) {
  let lastError = null;
  for (let attempt = 1; attempt <= CONSENT_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(consentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          session_id: sessionId,
          consent_version: CONSENT_VERSION,
        }),
      });
      if (res.ok) return;
      const body = await res.text().catch(() => "");
      lastError = new Error(
        `FreePI consent not recorded (${res.status}): ${body || "empty response"}`
      );
      // 4xx is deterministic (bad/expired session) — retrying cannot help.
      if (res.status < 500) break;
    } catch (err) {
      lastError = new Error(
        `FreePI consent request failed: ${err?.message || err}`
      );
    }
  }
  throw lastError;
}

const freepi = {
  config: {
    deviceCodeUrl: `${FREEPI_API_BASE}/auth/github/device`,
    consentUrl: `${FREEPI_API_BASE}/auth/consent`,
    tokenUrl: `${FREEPI_API_BASE}/auth/token`,
    userInfoUrl: `${FREEPI_API_BASE}/me/stats`,
  },
  flowType: "device_code",

  requestDeviceCode: async (config) => {
    const res = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`FreePI device code request failed (${res.status}): ${err}`);
    }

    const data = await res.json();

    // Consent is mandatory upstream (see submitConsent). Fail the device-code
    // request instead of handing out a session that can only ever answer 403.
    await submitConsent(config.consentUrl, data.session_id);

    return {
      device_code: data.session_id,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete,
      interval: data.interval || 5,
      expires_in: data.expires_in || 899,
    };
  },

  pollToken: async (config, deviceCode) => {
    let timezone = "UTC";
    let locale = "en-US";
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions();
      timezone = resolved.timeZone || "UTC";
      locale = resolved.locale || "en-US";
    } catch {}

    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        session_id: deviceCode,
        timezone,
        locale,
      }),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      const text = await res.text();
      data = { error: "invalid_response", error_description: text };
    }

    if (data.status === "pending" || data.error === "authorization_pending") {
      return {
        ok: true,
        data: {
          error: "authorization_pending",
          error_description: data.message,
          // Upstream asks the client to slow down via retry_after (it grows
          // while the browser step is in progress); ignoring it earns a hard
          // rate limit, so it has to survive to the poll loop.
          retry_after: data.retry_after,
        },
      };
    }

    const accessTokenValue = data.token || data.access_token || data.accessToken;
    if (accessTokenValue) {
      data["access_token"] = accessTokenValue;
      return {
        ok: res.ok,
        data,
      };
    }

    // FreePI reports failures as {code, message} — 403 consent_required,
    // 404 not_found ("unknown session", i.e. the device code expired), 429
    // rate_limited. The generic poll wrapper only understands the OAuth field
    // names, so an unmapped body reads as "no error, keep polling" and the UI
    // spins until the 15-minute timeout instead of telling the user anything.
    return {
      ok: false,
      data: {
        ...data,
        error: data.error || data.code || `http_${res.status}`,
        error_description: data.error_description || data.message,
      },
    };
  },

  postExchange: async (tokenData) => {
    const token = tokenData.access_token || tokenData.token;
    if (!token) return {};

    // Eagerly execute official Session Launch Handshake so the account is warm & ad-satisfied immediately
    try {
      const { launchSessionHandshake } = await import("../../../../open-sse/executors/freepi.js");
      launchSessionHandshake(token, tokenData.session_id).catch(() => {});
    } catch {}

    try {
      const res = await fetch(`${FREEPI_API_BASE}/me/stats`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const stats = await res.json();
        return {
          handle: stats.handle,
          tier: stats.tier,
          email: stats.handle ? `${stats.handle}@github` : undefined,
        };
      }
    } catch (e) {
      console.warn("[freepi oauth] postExchange warning:", e?.message);
    }
    return {};
  },

  mapTokens: (data, extra = {}) => {
    const token = data.access_token || data.token;
    return {
      accessToken: token,
      tokenType: "Bearer",
      email: extra?.email || (data.handle ? `${data.handle}@github` : undefined),
      displayName: extra?.handle ? `@${extra.handle}` : "FreePI User",
      providerSpecificData: {
        handle: extra?.handle || data.handle || undefined,
        tier: extra?.tier || data.tier || undefined,
      },
    };
  },
};

export default freepi;
