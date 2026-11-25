// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Parse a boolean env flag ("true"/"1" → true, "false"/"0" → false), falling back to a default.
function envBool(name, def) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Stream watchdog budget: one timer covering BOTH phases — before the first upstream byte
// (prefill, aborts as "stream first-chunk timeout") and between chunks once tokens flow
// (aborts as "stream stall timeout"). Keep it generous (600s = 10m) so long reasoning /
// generation streams from slow models (GLM-5.3-Flash, Claude 3.7 Thinking, DeepSeek R1)
// aren't aborted mid-stream. A provider registry `transport.stallTimeoutMs` overrides it
// per provider. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 600 * 1000);

// Kiro tool-call-repair first-chunk timeout ONLY (consumed by executors/kiro.js). Chat
// streaming does NOT use this: its first-chunk phase is covered by the provider stall budget
// above. Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

export const ALLOW_INSECURE_TLS_FALLBACK = envBool("ALLOW_INSECURE_TLS_FALLBACK", false) && !envBool("STRICT_SSL", false);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Keep-alive socket TTL. Cap it below upstream/edge idle windows (Cloudflare, AWS Global
// Accelerator / NVIDIA NIM) that drop idle sockets without a TCP RST. keepAliveMaxTimeout is
// clamped to the same value so an upstream `Keep-Alive` header cannot extend it to 600s.
// Google Frontend (*.googleapis.com) keeps HTTP/1.1 sockets open for minutes (matching
// Antigravity Go http.DefaultTransport IdleConnTimeout = 90s), avoiding ~100-200ms cold
// TCP+TLS handshakes between turns >4s apart; stale-socket replay still covers dead sockets.
export const DEFAULT_KEEPALIVE_TIMEOUT_MS = 4 * 1000;
export const GOOGLE_KEEPALIVE_TIMEOUT_MS = 90 * 1000;
export const FRESH_RETRY_KEEPALIVE_TIMEOUT_MS = 1;
export const FETCH_KEEPALIVE_TIMEOUT_MS = envMs("FETCH_KEEPALIVE_TIMEOUT_MS", DEFAULT_KEEPALIVE_TIMEOUT_MS);

function isGoogleApisHost(targetUrl) {
  if (!targetUrl) return false;
  try {
    const hostname = new URL(targetUrl).hostname.toLowerCase();
    return hostname === "googleapis.com" || hostname.endsWith(".googleapis.com");
  } catch {
    return false;
  }
}

export function resolveKeepAliveTimeouts(targetUrl = "") {
  const defaultTimeout = isGoogleApisHost(targetUrl) ? GOOGLE_KEEPALIVE_TIMEOUT_MS : DEFAULT_KEEPALIVE_TIMEOUT_MS;
  const timeout = envMs("FETCH_KEEPALIVE_TIMEOUT_MS", defaultTimeout);
  return { keepAliveTimeout: timeout, keepAliveMaxTimeout: timeout };
}

// Escape hatch: FETCH_FRESH_RETRY=off disables the transport-level replay, leaving only the
// executor's own retry path (which still forces a fresh socket). Defaults to on.
export function isFreshSocketReplayEnabled() {
  const raw = String(process.env.FETCH_FRESH_RETRY ?? "").trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false" || raw === "no");
}

// Dead keep-alive sockets surface as these codes/substrings; DNS, connect-refused and TLS
// failures are excluded so a real unreachable host is never mistaken for a stale socket.
export const STALE_SOCKET_ERROR_CODES = new Set([
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_HEADERS_TIMEOUT",
]);

export const NON_STALE_SOCKET_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_INVALID_ARG",
]);

// Deliberately excludes a bare "fetch failed": with no error code the upstream may already
// hold the request, and replaying it would send (and bill) the same completion twice.
export const STALE_SOCKET_ERROR_SUBSTRINGS = [
  "other side closed",
  "socket hang up",
];

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-9router-token-saver";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

function envChoice(name, validChoices, def) {
  const raw = process.env[name];
  if (raw && validChoices.includes(raw.toLowerCase())) return raw.toLowerCase();
  return def;
}

export const EGRESS_CONFIG = {
  mode: envChoice("EGRESS_PROBE_MODE", ["off", "auto", "always"], "auto"),
  probeUrl: envUrl("EGRESS_PROBE_URL", "https://api64.ipify.org?format=json"),
  probeTimeoutMs: envMs("EGRESS_PROBE_TIMEOUT_MS", 2500),
  ipCacheTtlMs: envMs("EGRESS_IP_CACHE_TTL_MS", 10 * 60 * 1000),
  ipStaleTtlMs: envMs("EGRESS_IP_STALE_TTL_MS", 60 * 60 * 1000),
  directRecheckMs: envMs("EGRESS_DIRECT_RECHECK_MS", 15 * 1000),
  minCooldownMs: envMs("EGRESS_MIN_COOLDOWN_MS", 1000),
  maxCooldownMs: envMs("EGRESS_MAX_COOLDOWN_MS", 24 * 60 * 60 * 1000),
  defaultCooldownMs: envMs("EGRESS_DEFAULT_COOLDOWN_MS", 60 * 1000),
  limitMessage: envUrl(
    "EGRESS_LIMIT_MESSAGE",
    "Free usage limit reached on the current egress. Retry after the indicated delay or switch proxies."
  ),
};

export const OPENCODE_TRANSPORT_CONFIG = {
  mode: envChoice("OPENCODE_TRANSPORT", ["off", "auto"], "auto"),
  bunBin: envUrl("OPENCODE_BUN_BIN", "bun"),
  readyTimeoutMs: envMs("OPENCODE_TRANSPORT_READY_TIMEOUT_MS", 8000),
  failureBackoffMs: envMs("OPENCODE_TRANSPORT_BACKOFF_MS", 5 * 60 * 1000),
};

// Guard rails for the OAuth refresh path.
// - noRefreshTokenCooldownMs: how long a connection with no usable refreshToken is
//   skipped before we look at it again (it cannot ever succeed until the account is
//   re-imported, but a short TTL keeps a fresh import from waiting a full cycle).
// - failureCooldownMs: backoff after a refresh attempt produced nothing usable, so a
//   dead account is not retried on every request or every scheduler tick.
// - maxPerTick: hard cap on how many connections one background tick may refresh, so a
//   mass-expiry event cannot turn into an unbounded refresh storm.
// - maxCooldownEntries: bound on the cooldown map so it cannot grow without limit.
export const REFRESH_GUARD_CONFIG = {
  noRefreshTokenCooldownMs: envMs("REFRESH_NO_TOKEN_COOLDOWN_MS", 10 * 60 * 1000),
  failureCooldownMs: envMs("REFRESH_FAILURE_COOLDOWN_MS", 30 * 1000),
  maxPerTick: envMs("BG_REFRESH_MAX_PER_TICK", 25),
  maxCooldownEntries: envMs("REFRESH_MAX_COOLDOWN_ENTRIES", 1000),
};

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];
