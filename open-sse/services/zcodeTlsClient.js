// Hardened TLS-impersonating HTTP client for ZCode start-plan.
// Emulates Chrome 131 BoringSSL / Post-Quantum TLS 1.3 ClientHello via wreq-js,
// matching the Ciii-ATM/zcode-gateway and desktop Electron signature with proxy awareness.

const sessionCache = new Map();
let cachedWreq = null;

async function getWreqModule() {
  if (cachedWreq) return cachedWreq;
  try {
    cachedWreq = await import("wreq-js");
    return cachedWreq;
  } catch (esmError) {
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      cachedWreq = require("wreq-js");
      return cachedWreq;
    } catch (cjsError) {
      try {
        const { createRequire } = await import("node:module");
        const path = await import("node:path");
        const fs = await import("node:fs");
        const candidates = [
          path.resolve(process.cwd(), "package.json"),
          path.resolve(process.cwd(), "..", "..", "package.json"),
        ];
        for (const pkgPath of candidates) {
          if (fs.existsSync(pkgPath)) {
            try {
              const require = createRequire(pkgPath);
              cachedWreq = require("wreq-js");
              if (cachedWreq) return cachedWreq;
            } catch {}
          }
        }
      } catch {}
      throw new Error(`wreq-js import failed: ${esmError?.message || esmError} (cjs fallback: ${cjsError?.message || cjsError})`);
    }
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
