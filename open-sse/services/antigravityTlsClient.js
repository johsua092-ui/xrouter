// Hardened TLS-impersonating HTTP client for Google Antigravity / Gemini Code Assist.
// Emulates Chrome 133+ BoringSSL / Post-Quantum TLS 1.3 with GREASE via wreq-js,
// matching the official desktop IDE and language_server native TLS fingerprint with proxy awareness.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// BoringSSL/Google-family cipher list the upstream accepts, matching native BoringSSL client
const ANTIGRAVITY_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const DEFAULT_TIMEOUT_MS = 180000;
const sessionCache = new Map();
const MAX_TLS_SESSIONS = 32;

let cachedWreq = null;

function getNativeRequire() {
  if (typeof globalThis !== "undefined") {
    if (typeof globalThis.__xrouter_native_require__ === "function") return globalThis.__xrouter_native_require__;
    if (typeof globalThis.__non_webpack_require__ === "function") return globalThis.__non_webpack_require__;
  }
  if (typeof __non_webpack_require__ === "function") return __non_webpack_require__;
  try {
    if (typeof process !== "undefined" && typeof process.getBuiltinModule === "function") {
      const nodeModule = process.getBuiltinModule("module");
      if (typeof nodeModule?.createRequire === "function") {
        return nodeModule.createRequire(process.cwd() + "/package.json");
      }
    }
  } catch {}
  try {
    const dynamicRequire = new Function("fromPath", "const m = typeof process !== 'undefined' && process.getBuiltinModule ? process.getBuiltinModule('module') : (typeof require !== 'undefined' ? require('module') : null); return m ? m.createRequire(fromPath) : null;");
    const req = dynamicRequire(process.cwd() + "/package.json");
    if (req) return req;
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

  if (typeof globalThis !== "undefined" && isValidWreq(globalThis.__xrouter_wreq__)) {
    cachedWreq = normalizeWreq(globalThis.__xrouter_wreq__);
    return cachedWreq;
  }

  const nativeReq = getNativeRequire();

  if (nativeReq) {
    try {
      const mod = nativeReq("wreq-js");
      if (isValidWreq(mod)) {
        cachedWreq = normalizeWreq(mod);
        return cachedWreq;
      }
    } catch {}
  }

  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "node_modules", "wreq-js", "dist", "wreq-js.cjs"),
    path.resolve(cwd, ".next", "standalone", "node_modules", "wreq-js", "dist", "wreq-js.cjs"),
    path.resolve(cwd, "..", "..", "node_modules", "wreq-js", "dist", "wreq-js.cjs"),
    "/root/xrouter/.next/standalone/node_modules/wreq-js/dist/wreq-js.cjs",
    "/root/xrouter/node_modules/wreq-js/dist/wreq-js.cjs",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const fileUrl = pathToFileURL(candidate).href;
        const mod = await import(fileUrl);
        if (isValidWreq(mod)) {
          cachedWreq = normalizeWreq(mod);
          return cachedWreq;
        }
      } catch {}
    }
  }

  try {
    const mod = await import(/* webpackIgnore: true */ "wreq-js");
    if (isValidWreq(mod)) {
      cachedWreq = normalizeWreq(mod);
      return cachedWreq;
    }
  } catch {}

  throw new Error("wreq-js runtime missing createSession");
}

function normalizeProxyUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

function sessionKeyFor(proxyUrl = "") {
  return normalizeProxyUrl(proxyUrl) || "direct";
}

function evictTlsSessionsOverCap(keepKey) {
  while (sessionCache.size > MAX_TLS_SESSIONS) {
    let victimKey = null;
    for (const key of sessionCache.keys()) {
      if (key !== keepKey) { victimKey = key; break; }
    }
    if (victimKey === null) break;
    const promise = sessionCache.get(victimKey);
    sessionCache.delete(victimKey);
    promise?.then((s) => s?.close?.()).catch(() => {});
  }
}

async function getSession(proxyUrl = "") {
  const normalizedProxy = normalizeProxyUrl(proxyUrl);
  const cacheKey = sessionKeyFor(proxyUrl);
  if (sessionCache.has(cacheKey)) {
    const hit = sessionCache.get(cacheKey);
    sessionCache.delete(cacheKey);
    sessionCache.set(cacheKey, hit);
    return hit;
  }

  const promise = (async () => {
    const wreq = await getWreqModule();
    if (!wreq || typeof wreq.createSession !== "function") {
      throw new Error("wreq-js runtime missing createSession");
    }

    const sessionOpts = {
      profile: "chrome_133",
      emulation: {
        tlsOptions: { cipherList: ANTIGRAVITY_CIPHER_LIST },
      },
    };

    if (normalizedProxy && !/workers\.dev|vercel\.app|pages\.dev|deno\.dev/i.test(normalizedProxy)) {
      sessionOpts.proxy = normalizedProxy;
    }

    return await wreq.createSession(sessionOpts);
  })().catch((err) => {
    sessionCache.delete(cacheKey);
    throw err;
  });

  sessionCache.set(cacheKey, promise);
  evictTlsSessionsOverCap(cacheKey);
  return promise;
}

export function resetAntigravityTlsSession() {
  for (const [, promise] of sessionCache) {
    promise.then((s) => s?.close?.()).catch(() => {});
  }
  sessionCache.clear();
}

/**
 * Fetch through the BoringSSL-impersonated TLS session.
 * Emulates official Google BoringSSL TLS 1.3 ClientHello with GREASE extension.
 * Returns a standard Response object.
 */
export async function antigravityTlsFetch(url, init = {}, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, proxy } = {}) {
  const proxyUrl = proxy || init.proxy || "";
  const cacheKey = sessionKeyFor(proxyUrl);
  let session;

  try {
    session = await getSession(proxyUrl);
  } catch (error) {
    // Fail-open to native fetch if wreq-js is uninstalled or broken
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
    if (res.status === 429) {
      sessionCache.delete(cacheKey);
    }
    const headers = {};
    res.headers?.forEach?.((value, key) => {
      headers[key] = value;
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (fetchErr) {
    sessionCache.delete(cacheKey);
    if (proxyUrl) {
      throw fetchErr;
    }
    return fetch(url, {
      method: init.method || "GET",
      headers: init.headers,
      body: init.body,
      signal,
    });
  }
}

export const __test__ = { ANTIGRAVITY_CIPHER_LIST };
