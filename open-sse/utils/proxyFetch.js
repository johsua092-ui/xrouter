import { Readable } from "stream";
import { MEMORY_CONFIG, ALLOW_INSECURE_TLS_FALLBACK } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";
import { createProxyDispatcher } from "./proxyDispatcher.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

const OPENCODE_V6_CACHE = new Map();

/**
 * Resolve OpenCode real AAAA records via DoH (Cloudflare 1.1.1.1 / Google 8.8.8.8)
 * to bypass IPv4 DNS hijacking and 403 FreeTierError (from Ashineqq/opencode2api).
 */
export async function resolveOpencodeIPv6(hostname) {
  const cached = OPENCODE_V6_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ips;

  const endpoints = [
    `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=AAAA`,
    `https://8.8.8.8/resolve?name=${encodeURIComponent(hostname)}&type=AAAA`,
  ];

  for (const ep of endpoints) {
    try {
      const res = await originalFetch(ep, {
        headers: { "accept": "application/dns-json" },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.Status === 0 && Array.isArray(data.Answer)) {
        const ips = data.Answer.filter((a) => a.type === 28 && a.data).map((a) => a.data);
        if (ips.length > 0) {
          OPENCODE_V6_CACHE.set(hostname, { ips, expiry: Date.now() + 4 * 60 * 1000 });
          return ips;
        }
      }
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  if (!proxyDispatchers.has(normalized)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const dispatcher = await createProxyDispatcher({ uri: normalized });
    proxyDispatchers.set(normalized, dispatcher);
  }

  return proxyDispatchers.get(normalized);
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    socket.connect(HTTPS_PORT, realIP, () => {
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      const req = https.request(reqOptions, (res) => {
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        resolve(response);
      });

      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", reject);
  });
}

// OpenCode's free-tier gate answers 403 `FreeTierError` when the request
// exits from an IP it has flagged — the transport itself succeeded, so the
// proxy-failure fallback below never sees it and every retry keeps leaving
// through the same flagged proxy. Live measurement (#4983): identical body and
// headers in the same minute — flagged pool egress → 403 FreeTierError,
// direct egress → 200.
const FREE_TIER_ERROR_MARKER = "FreeTierError";

/** Rebuild a response whose body we buffered while inspecting it. */
function bufferedResponse(text, original) {
  const headers = new Headers(original.headers);
  // The body was decoded while reading, so upstream framing no longer applies.
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(text, { status: original.status, statusText: original.statusText, headers });
}

function targetHost(url) {
  try {
    return new URL(typeof url === "string" ? url : url.toString()).host;
  } catch {
    return String(url);
  }
}

/**
 * After a proxied attempt, replay once on the direct egress when upstream
 * rejected the *proxy's IP* (403 FreeTierError). A body already consumed by
 * the first attempt cannot be resent, and strictProxy keeps its contract of
 * never leaving over another path — both return the rejection as-is.
 */
async function replayFreeTierRejectionDirect(url, options, proxied, proxyOptions) {
  if (proxied.status !== 403) return proxied;
  let text;
  try {
    text = await proxied.text();
  } catch {
    return proxied;
  }
  if (!text.includes(FREE_TIER_ERROR_MARKER)) return bufferedResponse(text, proxied);

  const poolId = proxyOptions?.connectionProxyPoolId || proxyOptions?.proxyPoolId;
  if (poolId) {
    try {
      const { quarantineProxy } = await import("@/lib/network/connectionProxy.js");
      quarantineProxy(poolId, 30 * 60 * 1000);
    } catch {}
  }

  const isOpencode = typeof url === "string" && url.includes("opencode.ai");
  if (proxyOptions?.strictProxy === true || poolId || isOpencode) {
    throw new Error(`[ProxyFetch] 403 FreeTierError: Proxy IP flagged by OpenCode free-tier gate`);
  }

  if (options?.body && typeof options.body.getReader === "function" && options.body.locked) {
    return bufferedResponse(text, proxied);
  }
  console.warn(`[ProxyFetch] Proxy egress rejected by the OpenCode free-tier gate (403 FreeTierError); replaying direct: ${targetHost(url)}`);
  try {
    return await originalFetch(url, options);
  } catch (directError) {
    console.warn(`[ProxyFetch] Direct replay failed: ${directError.message}`);
    return bufferedResponse(text, proxied);
  }
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const baseHeaders = options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : { ...(options.headers || {}) };
    const relayHeaders = {
      ...baseHeaders,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return originalFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // PR #5297: Route free-tier TLS fetch through connection proxies via directFetchProxy
  if (options.directFetch) {
    if (!proxyUrl) return await options.directFetch(url, options);
    if (options.directFetchProxy) {
      try {
        return await options.directFetch(url, options, { proxyUrl });
      } catch (err) {
        if (err?.name !== "OpencodeTlsUnavailableError") throw err;
        console.warn(`[ProxyFetch] directFetch unavailable (${err.message}); failing open to native proxied fetch`);
      }
    }
  }

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        const dispatcher = await getDispatcher(proxyUrl);
        const res = await originalFetch(url, { ...options, dispatcher });
        if (res.status === 407) {
          throw new Error("HTTP 407 Proxy Authentication Required (credentials invalid or plan expired)");
        }
        return res;
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true) {
          throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    const poolId = proxyOptions?.connectionProxyPoolId || proxyOptions?.proxyPoolId;
    const isOpencode = targetUrl.includes("opencode.ai");
    try {
      const dispatcher = await getDispatcher(proxyUrl);
      const res = await originalFetch(url, { ...options, dispatcher });
      if (res.status === 407) {
        throw new Error("HTTP 407 Proxy Authentication Required (credentials invalid or plan expired)");
      }
      if (res.status === 524 || res.status === 502 || res.status === 504) {
        if (poolId) {
          try {
            const { quarantineProxy } = await import("@/lib/network/connectionProxy.js");
            quarantineProxy(poolId, 15 * 60 * 1000);
          } catch {}
        }
        if (proxyOptions?.strictProxy === true || poolId || isOpencode) {
          throw new Error(`[ProxyFetch] Proxy returned HTTP ${res.status} timeout/bad gateway`);
        }
      }
      return await replayFreeTierRejectionDirect(url, options, res, proxyOptions);
    } catch (proxyError) {
      if (poolId) {
        try {
          const { quarantineProxy } = await import("@/lib/network/connectionProxy.js");
          quarantineProxy(poolId, 15 * 60 * 1000);
        } catch {}
      }
      // If strictProxy is enabled or targeting OpenCode, fail hard so the caller can rotate!
      // But for normal proxy pools, allow fallback to direct connection so requests aren't killed with 502.
      if (proxyOptions?.strictProxy === true || isOpencode) {
        throw new Error(`[ProxyFetch] Proxy required but failed: ${proxyError.message}`);
      }
      console.warn(`[ProxyFetch] Proxy ${proxyUrl} failed, falling back to direct connection: ${proxyError.message}`);
      return originalFetch(url, options);
    }
  }

let directDispatcher = null;
async function getDirectDispatcher() {
  if (!directDispatcher) {
    const { Agent } = await import("undici");
    directDispatcher = new Agent({
      maxHeaderSize: 64 * 1024,
    });
  }
  return directDispatcher;
}

  // got-scraping disabled — use native fetch with enlarged maxHeaderSize (64KB)
  // to avoid UND_ERR_HEADERS_OVERFLOW from Google / Cloudflare responses with massive Set-Cookie headers.
  const dispatcher = options.dispatcher || (await getDirectDispatcher().catch(() => null));
  return originalFetch(url, dispatcher ? { ...options, dispatcher } : options);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
