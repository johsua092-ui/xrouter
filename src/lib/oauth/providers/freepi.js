const FREEPI_API_BASE = "https://api.freepi.ai";
const CONSENT_VERSION = "4";
const CONSENT_ATTEMPTS = 2;
const CONSENT_TIMEOUT_MS = 6000;
const DEVICE_CODE_TIMEOUT_MS = 10000;
const CONSENT_RETRY_DELAY_MS = 300;
const IDENTITY_ATTEMPTS = 2;
const IDENTITY_TIMEOUT_MS = 4000;
const IDENTITY_RETRY_DELAY_MS = 200;
const AUTH_SCHEME = "Bearer";

const authHeaders = (token) => ({
  Authorization: `${AUTH_SCHEME} ${token}`,
  Accept: "application/json",
});

const handleEmail = (handle) => (handle ? `${handle}@github` : undefined);

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
        // Bounded: a hung consent call would otherwise stall the entire
        // device-code request (undici only aborts headers after minutes) and
        // the user would stare at a spinner before the browser step even starts.
        signal: AbortSignal.timeout(CONSENT_TIMEOUT_MS),
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
    if (attempt < CONSENT_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, CONSENT_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function fetchJson(url, token, timeoutMs) {
  const res = await fetch(url, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Resolve the account identity behind a freshly issued token.
 *
 * The handle becomes the connection's email (`<handle>@github`), which is also
 * the dedup key createProviderConnection uses for oauth rows. A single hiccup
 * here used to store a row with no email, and the next login for the same
 * account could not match it — so every retry grew the pool by one duplicate
 * entry (same account, same 1-concurrency limit, half the requests throttled).
 */
async function resolveIdentity(token) {
  let lastError = null;
  for (let attempt = 1; attempt <= IDENTITY_ATTEMPTS; attempt++) {
    try {
      return await fetchJson(`${FREEPI_API_BASE}/me/stats`, token, IDENTITY_TIMEOUT_MS);
    } catch (err) {
      lastError = err;
      // 401/403 is the token itself being rejected — /me answers the same.
      if (err.status === 401 || err.status === 403) return null;
      if (attempt < IDENTITY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, IDENTITY_RETRY_DELAY_MS));
      }
    }
  }
  // Older/newer API revisions expose the same handle from /me instead.
  try {
    return await fetchJson(`${FREEPI_API_BASE}/me`, token, IDENTITY_TIMEOUT_MS);
  } catch (err) {
    lastError = err;
  }
  console.warn("[freepi oauth] identity lookup failed:", lastError?.message);
  return null;
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
      // Upstream answers in <1s; a black-holed connection must not hold the
      // dashboard request open for undici's default header timeout.
      signal: AbortSignal.timeout(DEVICE_CODE_TIMEOUT_MS),
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

    // The token response may already carry the handle; only ask upstream when
    // it does not, so a /me outage cannot strip the connection's identity.
    const identity = tokenData.handle ? null : await resolveIdentity(token);
    const handle = tokenData.handle || identity?.handle;
    if (!handle) return {};

    return {
      handle,
      tier: tokenData.tier || identity?.tier,
      email: handleEmail(handle),
    };
  },

  mapTokens: (data, extra = {}) => {
    const token = data.access_token || data.token;
    const handle = extra?.handle || data.handle || undefined;
    return {
      accessToken: token,
      tokenType: "Bearer",
      email: extra?.email || handleEmail(handle),
      displayName: handle ? `@${handle}` : "FreePI User",
      providerSpecificData: {
        handle,
        tier: extra?.tier || data.tier || undefined,
      },
    };
  },
};

export default freepi;
