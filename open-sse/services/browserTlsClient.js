// Browser TLS-impersonating HTTP client for Web-Cookie providers.
// Combines Chrome 133+ BoringSSL / Post-Quantum TLS 1.3 ClientHello via wreq-js,
// with proxy pool support, session pooling, and native fetch fail-open resilience.

import { loadRuntimeDep } from "./lazyRuntime.js";

const DEFAULT_TIMEOUT_MS = 120000;
const sessionCache = new Map();

const WEB_COOKIE_DOMAINS = [
  "gemini.google.com",
  "google.com",
  "chat.deepseek.com",
  "deepseek.com",
  "kimi.moonshot.cn",
  "kimi.ai",
  "moonshot.cn",
  "grok.com",
  "chatgpt.com",
  "oaistatic.com",
  "claude.ai",
  "copilot.microsoft.com",
  "chat.z.ai",
  "duckduckgo.com",
  "yuanbao.tencent.com",
  "notion.so",
  "arena.lmsys.org",
  "lmarena.ai",
];

export function isWebCookieTarget(url) {
  if (!url) return false;
  try {
    const parsed = new URL(typeof url === "string" ? url : url.toString());
    const host = parsed.hostname.toLowerCase();
    return WEB_COOKIE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

async function getWreqModule() {
  try {
    return await import(/* webpackIgnore: true */ "wreq-js");
  } catch (_) {
    return await loadRuntimeDep("wreq-js");
  }
}

async function getBrowserSession(proxyUrl = "") {
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
      profile: "chrome_133",
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

export function resetBrowserTlsSession() {
  for (const [, promise] of sessionCache) {
    promise.then((s) => s.close?.()).catch(() => {});
  }
  sessionCache.clear();
}

/**
 * Fetch through an impersonated Chrome 133 TLS session.
 * Returns a standard web Response so all stream/text/json consumers work unchanged.
 */
export async function browserTlsFetch(url, init = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();
  const proxyUrl =
    proxyOptions?.connectionProxyUrl ||
    proxyOptions?.proxyUrl ||
    proxyOptions?.url ||
    init?.proxy ||
    "";

  let session;
  try {
    session = await getBrowserSession(proxyUrl);
  } catch (err) {
    console.warn(`[BrowserTLS] wreq-js session creation failed (${err?.message || err}), falling open to native fetch`);
    return fetch(targetUrl, init);
  }

  // Normalize headers
  const headers = {};
  if (init.headers) {
    if (typeof init.headers.forEach === "function") {
      init.headers.forEach((val, key) => {
        headers[key] = val;
      });
    } else if (typeof init.headers === "object") {
      for (const [k, v] of Object.entries(init.headers)) {
        if (v !== undefined && v !== null) {
          headers[k] = String(v);
        }
      }
    }
  }

  const timeoutMs = init.timeout || proxyOptions?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const options = {
    method: (init.method || "GET").toUpperCase(),
    headers,
    redirect: init.redirect || "follow",
    timeout: timeoutMs,
  };

  if (init.body !== undefined && init.body !== null) {
    options.body = init.body;
  }
  if (init.signal) {
    options.signal = init.signal;
  }

  try {
    const res = await session.fetch(targetUrl, options);

    const outHeaders = new Headers();
    const setCookies = res.headers?.getSetCookie?.() || [];
    res.headers?.forEach?.((val, key) => {
      outHeaders.set(key, val);
    });

    if (setCookies.length > 0 && typeof outHeaders.getSetCookie !== "function") {
      outHeaders.getSetCookie = () => setCookies;
    }

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText || "",
      headers: outHeaders,
    });
  } catch (fetchErr) {
    sessionCache.delete(proxyUrl || "direct");
    if (proxyOptions?.strictProxy === true) {
      throw fetchErr;
    }
    console.warn(`[BrowserTLS] session.fetch failed (${fetchErr?.message}), falling open to native fetch`);
    return fetch(targetUrl, init);
  }
}
