import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { DefaultExecutor } from "./default.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// The upstream rejects requests from old clients: 426 upgrade_required with
// "your free-pi-cli 0.6.25 is below the required minimum (0.6.28)". 0.6.28 is the
// current min and latest; keep the version mutable so a 426 can lift it without a
// redeploy, and let operators pin it with FREEPI_CLI_VERSION.
const VERSION_PATTERN = /below the required minimum \(([0-9]+\.[0-9]+\.[0-9]+)\)/i;
let cliVersion = process.env.FREEPI_CLI_VERSION || "0.6.28";

export function getFreePiCliVersion() {
  return cliVersion;
}

/** Pull the minimum client version out of a 426 body, or null when absent. */
export function parseRequiredCliVersion(text) {
  if (typeof text !== "string") return null;
  const match = text.match(VERSION_PATTERN);
  return match ? match[1] : null;
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
const ADS_INTERVAL_MS = 60 * 1000;
const LAUNCH_HANDSHAKE_TTL_MS = 55 * 60 * 1000; // 55m TTL (official FreePI CLI launch grace is 60m)
// Post-stream grace before the slot is handed to the next request. 500ms is the
// safe default (upstream needs a moment to release the session socket); it is
// also ~47% of the per-account cadence, so it is tunable for operators who would
// rather trade a little safety for throughput. Clamped to [0, 2000].
const SETTLING_ENV = process.env.FREEPI_SETTLING_DELAY_MS;
const SETTLING_DELAY_MS = Math.min(
  2000,
  Math.max(0, SETTLING_ENV === undefined || SETTLING_ENV === "" ? 500 : Number(SETTLING_ENV) || 0),
);
const MAX_QUEUE_SIZE = 10;
// Particle always writes reasoning_content before any content. With a small output
// budget the reasoning eats the whole allowance and the turn ends with
// finish_reason=length and an empty message (measured: 30-60 → empty, 120+ → fine;
// 69 of 296 live requests, 23%, came back empty this way). Raising the budget is
// the only fix that does not buffer the stream or duplicate the request.
const MIN_MAX_TOKENS_ENV = process.env.FREEPI_MIN_MAX_TOKENS;
export const FREEPI_MIN_MAX_TOKENS = Math.min(
  4096,
  Math.max(0, MIN_MAX_TOKENS_ENV === undefined || MIN_MAX_TOKENS_ENV === "" ? 256 : Number(MIN_MAX_TOKENS_ENV) || 0),
);

/**
 * Raise a too-small output budget to the floor. Returns the body untouched when
 * nothing needs to change, plus what the caller asked for so the raise is visible.
 */
export function clampFreePiMaxTokens(body, minOut = FREEPI_MIN_MAX_TOKENS) {
  if (!minOut || !body || typeof body !== "object") return { body, raisedFrom: null };
  const key = typeof body.max_tokens === "number"
    ? "max_tokens"
    : typeof body.max_completion_tokens === "number"
      ? "max_completion_tokens"
      : null;
  if (!key) return { body, raisedFrom: null };
  const requested = body[key];
  if (!Number.isFinite(requested) || requested <= 0 || requested >= minOut) {
    return { body, raisedFrom: null };
  }
  return { body: { ...body, [key]: minOut }, raisedFrom: requested };
}
const STREAM_INACTIVITY_TIMEOUT_MS = 60 * 1000; // 60s without chunk -> force abort
// A request that cannot get the slot within this budget fails with QUEUE_TIMEOUT
// instead of hanging: the queue used to wait until the client aborted, which on a
// 1200-token stream ahead of it means tens of seconds of silence.
const QUEUE_MAX_WAIT_MS = Number(process.env.FREEPI_QUEUE_MAX_WAIT_MS || 120000);

// Housekeeping for the per-token maps below.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // session id is cosmetic; drop after 6h idle
const MAX_TRACKED_TOKENS = 500; // hard ceiling per map, oldest-first
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Track last impression timestamp, launch handshake timestamp, and session ID per token/connection
const sessionMap = new Map();
const lastImpressionMap = new Map();
const launchHandshakeMap = new Map();

// Per-token FIFO Queue for strict single concurrency (limit = 1)
const tokenQueues = new Map();

// Selections made by routing that have not reached acquireFreePiQueueLock yet.
// Without this, two requests arriving in the same millisecond both see a free
// account, both pick it, and one waits behind the other although a second account
// sat idle — measured as 2 simultaneous streams serialising on one account.
const selectionReservations = new Map(); // tokenKey -> { count, expiresAt }
const RESERVATION_TTL_MS = 5000;

/**
 * Map keys are hashed, never the raw credential: a FreePI token is ~477 bytes,
 * so keying on it directly costs ~600 B per entry per map (measured: 1.12 KB
 * per token across these maps), and any heap snapshot would carry every
 * account token in cleartext.
 */
function tokenKey(token) {
  return createHash("sha256").update(String(token)).digest("base64url").slice(0, 22);
}

/** Keep the per-token maps bounded: a token that is never seen again must not pin memory forever. */
function stamp(map, key, value) {
  map.set(key, value);
  while (map.size > MAX_TRACKED_TOKENS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Drop state for tokens that are gone or idle. FreePI has no refresh endpoint:
 * every re-login mints a NEW token, so without this the maps grow for the
 * lifetime of the process (and a slot entry whose stream never closed would
 * stay "busy" forever).
 */
export function sweepFreePiState(now = Date.now()) {
  let dropped = 0;

  for (const [key, entry] of sessionMap) {
    if (!entry || now - entry.ts > SESSION_TTL_MS) { sessionMap.delete(key); dropped++; }
  }
  for (const [key, ts] of lastImpressionMap) {
    if (now - ts > ADS_INTERVAL_MS * 2) { lastImpressionMap.delete(key); dropped++; }
  }
  for (const [key, ts] of launchHandshakeMap) {
    if (now - ts > LAUNCH_HANDSHAKE_TTL_MS) { launchHandshakeMap.delete(key); dropped++; }
  }
  // A queue with no owner and no waiters carries no state worth keeping; a
  // waiting item can only exist while running is true.
  for (const [key, queue] of tokenQueues) {
    if (!queue.running && queue.waiting.length === 0) { tokenQueues.delete(key); dropped++; }
  }

  return dropped;
}

/** Sizes of the in-process state (tests + debugging hooks). */
// Counters for the pool panel: they are process-lifetime and monotonic, which is
// what a scraper wants (rate() over time), while the map sizes above are gauges.
const counters = {
  requests: 0,
  queueOverflow: 0,
  queueTimeout: 0,
  upstream429: 0,
  adsCycles: 0,
  adsFailures: 0,
  handshakes: 0,
  authFailures: 0,
};

export function getFreePiMetrics() {
  return { ...counters, ...getFreePiStateStats(), reservations: selectionReservations.size };
}

export function getFreePiStateStats() {
  return {
    sessions: sessionMap.size,
    impressions: lastImpressionMap.size,
    launches: launchHandshakeMap.size,
    queues: tokenQueues.size,
    limit: MAX_TRACKED_TOKENS,
  };
}

const sweepTimer = setInterval(() => {
  try { sweepFreePiState(); } catch { /* housekeeping must never throw */ }
}, SWEEP_INTERVAL_MS);
// Never hold the process open (tests, CLI, short-lived workers).
sweepTimer.unref?.();

export function getSessionId(token) {
  const key = tokenKey(token);
  let entry = sessionMap.get(key);
  if (!entry) {
    entry = { sid: randomUUID(), ts: Date.now() };
    stamp(sessionMap, key, entry);
  } else {
    entry.ts = Date.now();
  }
  return entry.sid;
}

function resolveLocaleHeaders() {
  try {
    const o = Intl.DateTimeFormat().resolvedOptions();
    return {
      ...(o.timeZone ? { "x-client-timezone": o.timeZone } : {}),
      ...(o.locale ? { "x-client-locale": o.locale } : {}),
    };
  } catch {
    return { "x-client-timezone": "UTC", "x-client-locale": "en-US" };
  }
}

/**
 * Perform FreePI Session Launch Handshake (session_start).
 * Executes the official pre-flight launch handshake:
 * 1. Fetch banner ad with x-ad-trigger: "launch"
 * 2. Ping TryGravity / upstream tracking pixel if imp_url present
 * 3. Report impression to /ads/impression
 * Guarantees that upstream FreePI marks the token as warm & ad-satisfied for up to 60 minutes.
 */
export async function launchSessionHandshake(token, sessionId = null, proxyOptions = null) {
  if (!token || typeof token !== "string" || !token.trim()) return false;
  const cleanToken = token.trim();
  const key = tokenKey(cleanToken);
  const now = Date.now();
  const lastLaunch = launchHandshakeMap.get(key) || 0;
  if (now - lastLaunch < LAUNCH_HANDSHAKE_TTL_MS) {
    return true; // Still within launch grace period
  }

  const sid = sessionId || getSessionId(cleanToken);
  const turnId = randomUUID();
  const localeHeaders = resolveLocaleHeaders();

  try {
    const res = await proxyAwareFetch(
      "https://api.freepi.ai/ads/next?slot=banner",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/json",
          "x-session-id": sid,
          "x-turn-id": turnId,
          "x-client-version": cliVersion,
          "x-client-os": process.platform,
          "x-client-arch": os.arch(),
          "x-ad-trigger": "launch",
          "x-ad-context": "none",
          ...localeHeaders,
        },
        signal: AbortSignal.timeout(6000),
      },
      proxyOptions
    );

    if (res.ok) {
      const ad = await res.json().catch(() => null);
      if (ad && ad.ad_id) {
        // Fire TryGravity / upstream tracking pixel
        if (ad.imp_url && typeof ad.imp_url === "string") {
          proxyAwareFetch(ad.imp_url, { method: "GET", signal: AbortSignal.timeout(4000) }, proxyOptions).catch(() => {});
        }

        // Report impression back to FreePI
        await proxyAwareFetch(
          "https://api.freepi.ai/ads/impression",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cleanToken}`,
              "Content-Type": "application/json",
              "x-session-id": sid,
            },
            body: JSON.stringify({
              ad_id: ad.ad_id,
              click_token: ad.click_token,
              imp_fired: Boolean(ad.imp_url),
            }),
            signal: AbortSignal.timeout(5000),
          },
          proxyOptions
        );
      }
    }

    // NOTE: the official CLI also calls GET /me after the launch banner to sync
    // quota. FreePI rejects CLI tokens on /me (and /me/stats) with 401
    // "invalid or expired token" even when chat completions work, so that call is
    // a guaranteed no-op — dropped instead of burning a round-trip per handshake.

    stamp(launchHandshakeMap, key, Date.now());
    stamp(lastImpressionMap, key, Date.now());
    counters.handshakes += 1;
    return true;
  } catch {
    return false;
  }
}

/**
 * Perform FreePI periodic ad fetch and impression reporting cycle during active conversation turns.
 */
async function fireAdCycle(token, sessionId, turnId, proxyOptions) {
  if (!token || typeof token !== "string" || !token.trim()) return;
  const cleanToken = token.trim();
  const key = tokenKey(cleanToken);
  const localeHeaders = resolveLocaleHeaders();
  try {
    const res = await proxyAwareFetch(
      "https://api.freepi.ai/ads/next?slot=banner",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/json",
          "x-session-id": sessionId,
          "x-turn-id": turnId,
          "x-client-version": cliVersion,
          "x-client-os": process.platform,
          "x-client-arch": os.arch(),
          "x-ad-trigger": "user_message",
          "x-ad-context": "none",
          ...localeHeaders,
        },
        signal: AbortSignal.timeout(5000),
      },
      proxyOptions
    );

    if (!res.ok) return;
    const ad = await res.json().catch(() => null);
    if (!ad || !ad.ad_id) return;

    // Fire gravity / upstream pixel impression if present
    if (ad.imp_url && typeof ad.imp_url === "string") {
      proxyAwareFetch(ad.imp_url, { method: "GET", signal: AbortSignal.timeout(4000) }, proxyOptions).catch(() => {});
    }

    // Report ad impression back to FreePI
    await proxyAwareFetch(
      "https://api.freepi.ai/ads/impression",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          ad_id: ad.ad_id,
          click_token: ad.click_token,
          imp_fired: Boolean(ad.imp_url),
        }),
        signal: AbortSignal.timeout(5000),
      },
      proxyOptions
    );

    stamp(lastImpressionMap, key, Date.now());
  } catch {
    // Non-blocking catch
  }
}

/**
 * Acquire concurrency lock for a specific FreePI token queue (strict single concurrency: N = 1).
 * Returns an asynchronous release function.
 */
export async function acquireFreePiQueueLock(token, signal) {
  if (!token || typeof token !== "string") {
    return () => Promise.resolve();
  }
  const cleanToken = token.trim();
  const key = tokenKey(cleanToken);

  // The real lock supersedes any routing reservation for this token.
  selectionReservations.delete(key);

  let queue = tokenQueues.get(key);
  if (!queue) {
    queue = { running: false, waiting: [] };
    tokenQueues.set(key, queue);
  }

  const createReleaseFn = () => {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      // Post-stream settling delay (~500ms) to ensure upstream FreePI server has released session socket
      if (SETTLING_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, SETTLING_DELAY_MS));
      }

      while (queue.waiting.length > 0) {
        const next = queue.waiting.shift();
        if (next && !next.aborted) {
          next.resolve(createReleaseFn());
          return;
        }
      }
      queue.running = false;
    };
  };

  // If slot is immediately available, acquire lock
  if (!queue.running) {
    queue.running = true;
    return createReleaseFn();
  }

  // Reject early if queue capacity is overwhelmed. The error carries a code so
  // the classifier can tell "our own admission control said no" from "the
  // upstream account is unhealthy" — the first must never cool the account down.
  if (queue.waiting.length >= MAX_QUEUE_SIZE) {
    counters.queueOverflow += 1;
    const err = new Error("FreePI queue full: too many concurrent requests queued for this account (QUEUE_OVERFLOW)");
    err.code = "QUEUE_OVERFLOW";
    err.retryAfterMs = 2000;
    throw err;
  }

  // Wait in FIFO queue
  return new Promise((resolve, reject) => {
    const item = {
      aborted: false,
      // The abort listener used to stay attached after the hang-off, keeping
      // this closure (and the whole request) reachable from the signal.
      resolve: (releaseFn) => {
        clearTimeout(item.timer);
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
        resolve(releaseFn);
      },
      reject,
    };

    function onAbort() {
      item.aborted = true;
      clearTimeout(item.timer);
      const idx = queue.waiting.indexOf(item);
      if (idx !== -1) queue.waiting.splice(idx, 1);
      reject(new Error("Request aborted while in FreePI queue"));
    }

    if (signal) {
      if (signal.aborted) {
        return reject(new Error("Request aborted before acquiring FreePI queue slot"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    queue.waiting.push(item);

    // Deadline: a queued request must never wait forever just because the slot
    // ahead of it never closes. Unref'd so a pending wait cannot hold the process.
    item.timer = setTimeout(() => {
      item.aborted = true;
      const idx = queue.waiting.indexOf(item);
      if (idx !== -1) queue.waiting.splice(idx, 1);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      counters.queueTimeout += 1;
      const err = new Error(`FreePI queue wait exceeded ${QUEUE_MAX_WAIT_MS}ms (QUEUE_TIMEOUT)`);
      err.code = "QUEUE_TIMEOUT";
      err.retryAfterMs = 5000;
      reject(err);
    }, QUEUE_MAX_WAIT_MS);
    if (item.timer && typeof item.timer.unref === "function") item.timer.unref();
  });
}

/**
 * Current load of a token's queue, for slot-aware account selection: routing reads
 * this to prefer an idle account over one that already has requests waiting.
 */
export function getFreePiQueuePressure(token) {
  const key = token && typeof token === "string" && token.trim() ? tokenKey(token.trim()) : "";
  const queue = key ? tokenQueues.get(key) : null;
  const running = queue?.running ? 1 : 0;
  const waiting = queue?.waiting?.length || 0;
  const reserved = key ? pendingReservations(key) : 0;
  const total = running + waiting + reserved;
  return { running, waiting, reserved, total, idle: total === 0 };
}

function pendingReservations(key) {
  const entry = selectionReservations.get(key);
  if (!entry) return 0;
  if (entry.expiresAt <= Date.now()) {
    selectionReservations.delete(key);
    return 0;
  }
  return entry.count;
}

/**
 * Claim an account for a request that routing just picked. The reservation is a
 * short-lived hint so the next selection sees this slot as taken; the real lock
 * supersedes it on acquire and it expires on its own if the request never lands.
 */
export function reserveFreePiSlot(token, ttlMs = RESERVATION_TTL_MS) {
  const key = token && typeof token === "string" && token.trim() ? tokenKey(token.trim()) : "";
  if (!key) return () => {};
  const now = Date.now();
  const entry = selectionReservations.get(key);
  if (!entry || entry.expiresAt <= now) {
    selectionReservations.set(key, { count: 1, expiresAt: now + ttlMs });
  } else {
    entry.count += 1;
    entry.expiresAt = now + ttlMs;
  }
  return () => {
    const current = selectionReservations.get(key);
    if (!current) return;
    current.count -= 1;
    if (current.count <= 0) selectionReservations.delete(key);
  };
}

/**
 * Helper compatibility aliases for slot-aware inspection and eviction.
 */
export function isFreePiSlotAvailable(token) {
  return getFreePiQueuePressure(token).idle;
}

export function getFreePiQueueStats(token) {
  const p = getFreePiQueuePressure(token);
  return { running: p.running === 1, waitingCount: p.waiting, totalLoad: p.total };
}

export function evictFreePiSlot(token) {
  const key = token && typeof token === "string" && token.trim() ? tokenKey(token.trim()) : "";
  if (!key) return;
  const queue = tokenQueues.get(key);
  if (queue) {
    queue.running = false;
    queue.waiting.forEach((item) => {
      item.aborted = true;
      if (item.timer) clearTimeout(item.timer);
      item.reject?.(new Error("FreePI connection slot evicted"));
    });
    queue.waiting = [];
    tokenQueues.delete(key);
  }
  selectionReservations.delete(key);
  sessionMap.delete(key);
  lastImpressionMap.delete(key);
  launchHandshakeMap.delete(key);
}

/**
 * Wraps a streaming response body so that the queue release lock is held
 * throughout the entire token streaming lifecycle until EOF, flush, or abort.
 * Exported for tests: the release paths are the difference between a slot that
 * frees up and an account that looks busy for the life of the process.
 */
export function wrapStreamWithQueueLock(response, releaseLock, signal = null) {
  // Release must be idempotent and non-throwing: it is called from four paths
  // (body-less, flush, cancel, and the failure path below) and a rejected
  // release would surface as an unhandled rejection.
  let released = false;
  let inactivityTimer = null;

  const safeRelease = () => {
    if (released) return;
    released = true;
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    try {
      Promise.resolve(releaseLock()).catch(() => {});
    } catch { /* a throwing release must not mask the response */ }
  };

  const resetInactivityTimer = (controller) => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      safeRelease();
      try {
        controller.error(new Error("FreePI stream inactivity timeout: no chunk received for 60s"));
      } catch {}
    }, STREAM_INACTIVITY_TIMEOUT_MS);
    if (inactivityTimer && typeof inactivityTimer.unref === "function") {
      inactivityTimer.unref();
    }
  };

  if (!response?.body || typeof response.body.pipeThrough !== "function") {
    safeRelease();
    return response;
  }

  if (signal) {
    if (signal.aborted) {
      safeRelease();
    } else {
      signal.addEventListener("abort", safeRelease, { once: true });
    }
  }

  const transform = new TransformStream({
    start(controller) {
      resetInactivityTimer(controller);
    },
    transform(chunk, controller) {
      resetInactivityTimer(controller);
      controller.enqueue(chunk);
    },
    flush() {
      safeRelease();
    },
    cancel() {
      safeRelease();
    },
  });

  try {
    const pipedBody = response.body.pipeThrough(transform);
    return new Response(pipedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    // Without this the lock outlived the request and the account stayed BUSY.
    safeRelease();
    throw err;
  }
}

export class FreePiExecutor extends DefaultExecutor {
  constructor() {
    super("freepi");
  }

  transformRequest(model, body) {
    const base = super.transformRequest(model, body);
    const { body: adjusted, raisedFrom } = clampFreePiMaxTokens(base);
    if (raisedFrom != null) {
      console.log(`[FREEPI] raised max_tokens ${raisedFrom} → ${FREEPI_MIN_MAX_TOKENS} (reasoning would have consumed the budget)`);
    }
    return adjusted;
  }

  buildHeaders(credentials, stream = true, url, model, body) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    const token = credentials?.accessToken || credentials?.apiKey;
    const sessionId = token ? getSessionId(token) : randomUUID();
    const turnId = randomUUID();

    headers["x-client-version"] = cliVersion;
    headers["x-session-id"] = sessionId;
    headers["x-turn-id"] = turnId;
    headers["x-ad-context"] = "none";

    return headers;
  }

  async execute(params) {
    const { credentials, proxyOptions, log, signal } = params;
    const token = credentials?.accessToken || credentials?.apiKey;
    const cleanToken = token?.trim?.() || "";
    const tokenStateKey = cleanToken ? tokenKey(cleanToken) : "";
    const sessionId = cleanToken ? getSessionId(cleanToken) : randomUUID();
    const turnId = randomUUID();
    counters.requests += 1;

    // 1. Session Launch Handshake: pre-warm account if not yet performed or expired
    if (cleanToken) {
      const lastLaunch = launchHandshakeMap.get(tokenStateKey) || 0;
      if (Date.now() - lastLaunch >= LAUNCH_HANDSHAKE_TTL_MS) {
        launchSessionHandshake(cleanToken, sessionId, proxyOptions).catch(() => {});
      }
    }

    // 2. Heartbeat: fire ad impression in background if older than 60s
    if (cleanToken) {
      const lastImpression = lastImpressionMap.get(tokenStateKey) || 0;
      if (Date.now() - lastImpression > ADS_INTERVAL_MS) {
        stamp(lastImpressionMap, tokenStateKey, Date.now()); // optimistic debounce
        fireAdCycle(cleanToken, sessionId, turnId, proxyOptions)
          .then(() => { counters.adsCycles += 1; })
          .catch(() => { counters.adsFailures += 1; });
      }
    }

    // 3. Acquire Stream Queue Lock (Strict single concurrency = 1 per account)
    let releaseLock = () => Promise.resolve();
    let queueWaitMs = 0;
    if (cleanToken) {
      const queueStartedAt = Date.now();
      try {
        releaseLock = await acquireFreePiQueueLock(cleanToken, signal);
        queueWaitMs = Date.now() - queueStartedAt;
        if (queueWaitMs >= 1000) {
          // The route handler does not forward custom response headers, so the wait
          // is reported here rather than as x-freepi-queue-ms.
          log?.info?.("FREEPI", `Waited ${queueWaitMs}ms for the account slot`);
        }
      } catch (queueErr) {
        log?.warn?.("FREEPI", `Queue acquisition error: ${queueErr.message}`);
        return {
          response: new Response(
            JSON.stringify({
              error: {
                message: queueErr.message,
                code: queueErr.code || "QUEUE_OVERFLOW",
              },
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                // Retry-After is honest here: the client asked for more
                // concurrency than the account can serve.
                "Retry-After": String(Math.max(1, Math.ceil((queueErr.retryAfterMs || 2000) / 1000))),
              },
            }
          ),
          url: this.buildUrl(params.model, params.stream, 0, credentials),
          headers: {},
          transformedBody: params.body,
        };
      }
    }

    let result;
    try {
      result = await super.execute(params);

      // If upstream returns 429 concurrent ("one request at a time"), wait 2.1s and retry automatically (up to 2 times)
      if (result?.response?.status === 429 && cleanToken) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const cloned = result.response.clone();
            const text = await cloned.text();
            if (text.includes("concurrent") || text.includes("one request at a time")) {
              counters.upstream429 += 1;
              log?.info?.("FREEPI", `Detected concurrent lock (429: one request at a time). Waiting 2.1s before retry (${attempt}/2)...`);
              await new Promise((r) => setTimeout(r, 2100));
              result = await super.execute(params);
              if (result?.response?.ok || result?.response?.status !== 429) {
                break;
              }
            } else {
              break;
            }
          } catch {
            break;
          }
        }
      }

      // If upstream rejects the client version, lift it to the required minimum and
      // retry once, so a version bump does not take the pool down until the next deploy.
      if (result?.response?.status === 426 && cleanToken) {
        try {
          const text = await result.response.clone().text();
          const required = parseRequiredCliVersion(text);
          if (required && compareVersions(required, cliVersion) > 0) {
            log?.warn?.("FREEPI", `Client version ${cliVersion} rejected, retrying as ${required}`);
            cliVersion = required;
            result = await super.execute(params);
          }
        } catch {
          // Fall through to the original result
        }
      }

      // If upstream returns 403 ads_required, automatically unblock via launch/impression cycle and retry once
      if (result?.response?.status === 403 && cleanToken) {
        try {
          const cloned = result.response.clone();
          const text = await cloned.text();
          if (text.includes("ads_required")) {
            log?.info?.("FREEPI", "Detected ads_required (403), triggering ad handshake and retrying...");
            await launchSessionHandshake(cleanToken, sessionId, proxyOptions);
            result = await super.execute(params);
          } else if (text.includes("belongs to another free-pi account")) {
            log?.warn?.("FREEPI", "Rejected: Conversation belongs to another FreePI account. New conversation required.");
          }
        } catch {
          // Fall through to original result
        }
      }

      if (result?.response?.status === 401) counters.authFailures += 1;

      // 4. If streaming response is successful, wrap stream so lock is held until stream completion
      if (result?.response?.ok && result.response.body) {
        result.response = wrapStreamWithQueueLock(result.response, releaseLock, signal);
        return result;
      }

      // For non-streaming or errored responses, release lock immediately
      releaseLock();
      return result;
    } catch (err) {
      releaseLock();
      throw err;
    }
  }
}
