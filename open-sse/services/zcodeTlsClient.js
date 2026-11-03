// Hardened TLS-impersonating HTTP client for ZCode start-plan.
// Emulates Chrome 131 BoringSSL / Post-Quantum TLS 1.3 ClientHello via wreq-js,
// matching the Ciii-ATM/zcode-gateway and desktop Electron signature with proxy awareness.

const sessionCache = new Map();
let cachedWreq = null;

function getNativeRequire() {
  try {
    if (typeof __non_webpack_require__ !== "undefined") return __non_webpack_require__;
  } catch {}
  try {
    return eval("require");
  } catch {}
  return null;
}

function isValidWreq(mod) {
  return mod && (typeof mod.createSession === "function" || typeof mod.default?.createSession === "function");
}

function normalizeWreq(mod) {
  if (!mod) return null;
  return typeof mod.createSession === "function" ? mod : mod.default;
}

async function getWreqModule() {
  if (cachedWreq) return cachedWreq;

  const nativeReq = getNativeRequire();

  // 1. Direct native CommonJS require (bypasses webpack chunk scope)
  if (nativeReq) {
    try {
      const mod = nativeReq("wreq-js");
      if (isValidWreq(mod)) {
        cachedWreq = normalizeWreq(mod);
        return cachedWreq;
      }
    } catch {}
  }

  // 2. createRequire via native module
  if (nativeReq) {
    try {
      const nodeModule = nativeReq("node:module") || nativeReq("module");
      const createReq = nodeModule?.createRequire || nodeModule?.default?.createRequire;
      if (typeof createReq === "function") {
        const path = nativeReq("node:path") || nativeReq("path");
        const fs = nativeReq("node:fs") || nativeReq("fs");
        const cwd = process.cwd();
        const pkgCandidates = [
          path.resolve(cwd, "package.json"),
          path.resolve(cwd, "..", "package.json"),
          path.resolve(cwd, "..", "..", "package.json"),
          path.resolve(cwd, ".next", "standalone", "package.json"),
          "/root/xrouter/package.json",
          "/root/xrouter/.next/standalone/package.json",
        ];
        for (const pkg of pkgCandidates) {
          if (fs.existsSync(pkg)) {
            try {
              const req = createReq(pkg);
              const mod = req("wreq-js");
              if (isValidWreq(mod)) {
                cachedWreq = normalizeWreq(mod);
                return cachedWreq;
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  // 3. Direct file path resolution
  if (nativeReq) {
    try {
      const path = nativeReq("node:path") || nativeReq("path");
      const fs = nativeReq("node:fs") || nativeReq("fs");
      const cwd = process.cwd();
      const directCandidates = [
        path.resolve(cwd, "node_modules", "wreq-js", "dist", "wreq-js.cjs"),
        path.resolve(cwd, "node_modules", "wreq-js"),
        path.resolve(cwd, "..", "..", "node_modules", "wreq-js", "dist", "wreq-js.cjs"),
        path.resolve(cwd, "..", "..", "node_modules", "wreq-js"),
        "/root/xrouter/node_modules/wreq-js/dist/wreq-js.cjs",
        "/root/xrouter/.next/standalone/node_modules/wreq-js/dist/wreq-js.cjs",
      ];
      for (const direct of directCandidates) {
        if (fs.existsSync(direct)) {
          try {
            const mod = nativeReq(direct);
            if (isValidWreq(mod)) {
              cachedWreq = normalizeWreq(mod);
              return cachedWreq;
            }
          } catch {}
        }
      }
    } catch {}
  }

  // 4. ESM dynamic import
  try {
    const mod = await import("wreq-js");
    if (isValidWreq(mod)) {
      cachedWreq = normalizeWreq(mod);
      return cachedWreq;
    }
  } catch (esmError) {
    throw new Error(`wreq-js import failed: ${esmError?.message || esmError}`);
  }

  throw new Error("wreq-js runtime missing createSession");
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
