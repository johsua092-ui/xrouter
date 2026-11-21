const FREEPI_API_BASE = "https://api.freepi.ai";
const CONSENT_VERSION = "4";

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

    // Submit consent automatically for this device session
    try {
      await fetch(config.consentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: data.session_id,
          consent_version: CONSENT_VERSION,
        }),
      });
    } catch (e) {
      console.warn("[freepi oauth] consent submission warning:", e?.message);
    }

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
        data: { error: "authorization_pending" },
      };
    }

    const token = data.token || data.access_token || data.accessToken;
    if (token) {
      data.access_token = token;
    }

    return {
      ok: res.ok,
      data,
    };
  },

  postExchange: async (tokenData) => {
    const token = tokenData.access_token || tokenData.token;
    if (!token) return {};
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
