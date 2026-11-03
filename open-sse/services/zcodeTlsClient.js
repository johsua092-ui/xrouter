// Hardened TLS-impersonating HTTP client for ZCode start-plan.
// Emulates Chrome 131 BoringSSL / Post-Quantum TLS 1.3 ClientHello via wreq-js,
// matching the Ciii-ATM/zcode-gateway and desktop Electron signature with proxy awareness.

const sessionCache = new Map();

async function getWreqModule() {
  try {
    return await import("wreq-js");
  } catch (error) {
    throw new Error(`wreq-js import failed: ${error?.message || error}`);
  }
}

async function getSession(proxyUrl = "") {
  const cacheKey = proxyUrl || "direct";
  if (sessionCache.has(cacheKey)) {
    return sessionCache.get(cacheKey);
  }

  const promise = (async () => {
    const wreq = await getWreqModule();
    if (!wreq || typeof wreq.createSession !== "function") {
      throw new Error("wreq-js runtime missing createSession");
    }

    const sessionOpts = {
      profile: "chrome_131",
    };

    if (proxyUrl) {
      sessionOpts.proxy = proxyUrl;
    }

    return await wreq.createSession(sessionOpts);
  })().catch((err) => {
    sessionCache.delete(cacheKey);
    throw err;
  });

  sessionCache.set(cacheKey, promise);
  return promise;
}

export function resetZcodeTlsSession() {
  for (const [, promise] of sessionCache) {
    promise.then((s) => s.close?.()).catch(() => {});
  }
  sessionCache.clear();
}

export async function zcodeTlsFetch(url, init = {}, { signal, timeoutMs = 300000, proxy } = {}) {
  const proxyUrl = proxy || init.proxy || "";
  let session;

  try {
    session = await getSession(proxyUrl);
  } catch (error) {
    console.warn(`[ZcodeTLS] wreq-js unavailable (${error?.message || error}), failing open to native fetch`);
    return fetch(url, {
      method: init.method || "GET",
      headers: init.headers,
      body: init.body,
      signal,
    });
  }

  const options = {
    method: init.method || "GET",
    headers: init.headers,
    redirect: "follow",
    timeout: timeoutMs,
  };
  if (init.body !== undefined) options.body = init.body;
  if (signal) options.signal = signal;

  try {
    const res = await session.fetch(url, options);
    const headers = {};
    res.headers?.forEach?.((value, key) => {
      headers[key] = value;
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (fetchErr) {
    sessionCache.delete(proxyUrl || "direct");
    console.warn(`[ZcodeTLS] Session fetch failed (${fetchErr.message}), fallback to native fetch`);
    return fetch(url, {
      method: init.method || "GET",
      headers: init.headers,
      body: init.body,
      signal,
    });
  }
}
