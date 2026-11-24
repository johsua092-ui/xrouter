import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { DefaultExecutor } from "./default.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const CLI_VERSION = "0.6.25";
const ADS_INTERVAL_MS = 60 * 1000;
const LAUNCH_HANDSHAKE_TTL_MS = 55 * 60 * 1000; // 55m TTL (official FreePI CLI launch grace is 60m)
const SETTLING_DELAY_MS = 500; // 500ms post-stream grace settling delay for upstream socket reset
const MAX_QUEUE_SIZE = 10;

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
 * 4. Sync profile & meter via GET /me
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
          "x-client-version": CLI_VERSION,
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

    // Official CLI calls GET /me after launch banner to synchronize quota allowance and reward state
    await proxyAwareFetch(
      "https://api.freepi.ai/me",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/json",
          "x-session-id": sid,
        },
        signal: AbortSignal.timeout(5000),
      },
      proxyOptions
    ).catch(() => {});

    stamp(launchHandshakeMap, key, Date.now());
    stamp(lastImpressionMap, key, Date.now());
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
          "x-client-version": CLI_VERSION,
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

  // Reject early if queue capacity is overwhelmed
  if (queue.waiting.length >= MAX_QUEUE_SIZE) {
    throw new Error("FreePI queue full: too many concurrent requests queued for this account");
  }

  // Wait in FIFO queue
  return new Promise((resolve, reject) => {
    const item = {
      aborted: false,
      // The abort listener used to stay attached after the hang-off, keeping
      // this closure (and the whole request) reachable from the signal.
      resolve: (releaseFn) => {
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
        resolve(releaseFn);
      },
      reject,
    };

    function onAbort() {
      item.aborted = true;
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
  });
}

/**
 * Wraps a streaming response body so that the queue release lock is held
 * throughout the entire token streaming lifecycle until EOF, flush, or abort.
 * Exported for tests: the release paths are the difference between a slot that
 * frees up and an account that looks busy for the life of the process.
 */
export function wrapStreamWithQueueLock(response, releaseLock) {
  // Release must be idempotent and non-throwing: it is called from four paths
  // (body-less, flush, cancel, and the failure path below) and a rejected
  // release would surface as an unhandled rejection.
  let released = false;
  const safeRelease = () => {
    if (released) return;
    released = true;
    try {
      Promise.resolve(releaseLock()).catch(() => {});
    } catch { /* a throwing release must not mask the response */ }
  };

  if (!response?.body || typeof response.body.pipeThrough !== "function") {
    safeRelease();
    return response;
  }

  const transform = new TransformStream({
    transform(chunk, controller) {
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

  buildHeaders(credentials, stream = true, url, model, body) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    const token = credentials?.accessToken || credentials?.apiKey;
    const sessionId = token ? getSessionId(token) : randomUUID();
    const turnId = randomUUID();

    headers["x-client-version"] = CLI_VERSION;
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
        fireAdCycle(cleanToken, sessionId, turnId, proxyOptions).catch(() => {});
      }
    }

    // 3. Acquire Stream Queue Lock (Strict single concurrency = 1 per account)
    let releaseLock = () => Promise.resolve();
    if (cleanToken) {
      try {
        releaseLock = await acquireFreePiQueueLock(cleanToken, signal);
      } catch (queueErr) {
        log?.warn?.("FREEPI", `Queue acquisition error: ${queueErr.message}`);
        return {
          response: new Response(
            JSON.stringify({ error: { message: queueErr.message, code: "QUEUE_OVERFLOW" } }),
            { status: 429, headers: { "Content-Type": "application/json" } }
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

      // 4. If streaming response is successful, wrap stream so lock is held until stream completion
      if (result?.response?.ok && result.response.body) {
        result.response = wrapStreamWithQueueLock(result.response, releaseLock);
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
