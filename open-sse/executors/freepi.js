import { randomUUID } from "node:crypto";
import os from "node:os";
import { DefaultExecutor } from "./default.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const CLI_VERSION = "0.6.25";
const ADS_INTERVAL_MS = 60 * 1000;

// Track last impression timestamp and session ID per token/connection
const sessionMap = new Map();
const lastImpressionMap = new Map();

function getSessionId(token) {
  let sid = sessionMap.get(token);
  if (!sid) {
    sid = randomUUID();
    sessionMap.set(token, sid);
  }
  return sid;
}

/**
 * Perform FreePI ad fetch and impression reporting cycle.
 * Simulates free-pi-cli's createAdsExtension telemetry so the upstream
 * server does not pause the account with 403 ads_required.
 */
async function fireAdCycle(token, sessionId, turnId, proxyOptions) {
  if (!token || typeof token !== "string" || !token.trim()) return;
  try {
    const res = await proxyAwareFetch(
      "https://api.freepi.ai/ads/next?slot=banner",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "Content-Type": "application/json",
          "x-session-id": sessionId,
          "x-turn-id": turnId,
          "x-client-version": CLI_VERSION,
          "x-client-os": process.platform,
          "x-client-arch": os.arch(),
          "x-ad-trigger": "user_message",
          "x-ad-context": "none",
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
          Authorization: `Bearer ${token.trim()}`,
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

    lastImpressionMap.set(token, Date.now());
  } catch {
    // Non-blocking catch
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

    return headers;
  }

  async execute(params) {
    const { credentials, proxyOptions, log } = params;
    const token = credentials?.accessToken || credentials?.apiKey;
    const sessionId = token ? getSessionId(token) : randomUUID();
    const turnId = randomUUID();

    // Heartbeat: fire ad impression in background if older than 60s
    if (token) {
      const last = lastImpressionMap.get(token) || 0;
      if (Date.now() - last > ADS_INTERVAL_MS) {
        lastImpressionMap.set(token, Date.now()); // optimistic debounce
        fireAdCycle(token, sessionId, turnId, proxyOptions).catch(() => {});
      }
    }

    const result = await super.execute(params);

    // If upstream returns 403 ads_required, automatically unblock and retry once
    if (result?.response?.status === 403 && token) {
      try {
        const cloned = result.response.clone();
        const text = await cloned.text();
        if (text.includes("ads_required")) {
          log?.info?.("FREEPI", "Detected ads_required (403), triggering ad impression and retrying...");
          await fireAdCycle(token, sessionId, turnId, proxyOptions);
          // Retry completion request
          return await super.execute(params);
        }
      } catch {
        // Fall through to original result
      }
    }

    return result;
  }
}
