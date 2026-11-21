// Antigravity Proactive Quota Monitor
// Polls the official internal quota endpoint used by Antigravity CLI and Desktop IDE:
// https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
// Caches quota summaries for 120 seconds to prevent rate-limiting while providing
// proactive skipping of depleted accounts (remainingFraction <= 0.02) BEFORE hitting 429 errors.

import { antigravityTlsFetch } from "./antigravityTlsClient.js";

const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const QUOTA_TTL_MS = 120 * 1000; // 120s cache matching agy-acp-bridge standard

// cache: cacheKey -> { timestamp: number, data: object }
const quotaCache = new Map();

function getCacheKey(accessToken, connectionId = "") {
  if (connectionId) return connectionId;
  if (typeof accessToken === "string" && accessToken.length > 20) {
    return accessToken.slice(-20);
  }
  return "default";
}

/**
 * Fetch the latest quota summary for an Antigravity account using official CLI headers.
 * @param {string} accessToken
 * @param {object|null} proxyOptions
 * @param {string} connectionId
 */
export async function fetchAntigravityQuota(accessToken, proxyOptions = null, connectionId = "") {
  if (!accessToken) return null;
  const key = getCacheKey(accessToken, connectionId);
  const now = Date.now();
  const hit = quotaCache.get(key);
  if (hit && now - hit.timestamp < QUOTA_TTL_MS) {
    return hit.data;
  }

  const proxyUrl = proxyOptions?.connectionProxyUrl || "";
  try {
    const res = await antigravityTlsFetch(QUOTA_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "antigravity/cli",
      },
      body: "{}",
    }, {
      timeoutMs: 15000,
      proxy: proxyUrl,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const errData = { error: `HTTP ${res.status}: ${errText.slice(0, 100)}` };
      // Cache transient error for 30s to avoid hammering
      quotaCache.set(key, { timestamp: now - QUOTA_TTL_MS + 30000, data: errData });
      return errData;
    }

    const data = await res.json();
    quotaCache.set(key, { timestamp: now, data });
    return data;
  } catch (err) {
    const errData = { error: String(err?.message || err) };
    quotaCache.set(key, { timestamp: now - QUOTA_TTL_MS + 20000, data: errData });
    return errData;
  }
}

/**
 * Get lowest remainingFraction relevant to the requested model.
 * Third-party models (claude*, gpt*) check the third-party group.
 * Gemini models check the gemini/code assist group.
 * Returns 1.0 (fail-open) if quota data is missing or inaccessible.
 */
export function getAntigravityModelQuotaFraction(quotaData, modelId = "") {
  if (!quotaData || !Array.isArray(quotaData.groups)) {
    return 1.0;
  }

  const modelLower = String(modelId || "").toLowerCase();
  const isThirdParty = modelLower.includes("claude") || modelLower.includes("gpt");

  const fractions = [];
  for (const group of quotaData.groups) {
    const name = String(group?.displayName || "").toLowerCase();
    const groupIs3P = name.includes("claude") || name.includes("gpt");

    if (groupIs3P !== isThirdParty) {
      continue;
    }

    for (const bucket of group.buckets || []) {
      const fraction = bucket.remainingFraction;
      if (typeof fraction === "number" && Number.isFinite(fraction)) {
        fractions.push(fraction);
      }
    }
  }

  return fractions.length > 0 ? Math.min(...fractions) : 1.0;
}

/**
 * Determine if the quota for a specific model is drained (remaining <= 2%).
 * Returns { isDrained: boolean, fraction: number, resetTime: string|null }
 */
export async function isAntigravityQuotaDrained(accessToken, modelId = "", proxyOptions = null, connectionId = "") {
  if (!accessToken) return { isDrained: false, fraction: 1.0, resetTime: null };
  const quota = await fetchAntigravityQuota(accessToken, proxyOptions, connectionId);
  if (!quota || quota.error) {
    // Fail-open: do not block requests if quota API is temporarily unreachable
    return { isDrained: false, fraction: 1.0, resetTime: null };
  }

  const fraction = getAntigravityModelQuotaFraction(quota, modelId);
  const isDrained = fraction <= 0.02;

  let resetTime = null;
  if (isDrained && Array.isArray(quota.groups)) {
    const modelLower = String(modelId || "").toLowerCase();
    const isThirdParty = modelLower.includes("claude") || modelLower.includes("gpt");
    for (const group of quota.groups) {
      const name = String(group?.displayName || "").toLowerCase();
      if ((name.includes("claude") || name.includes("gpt")) === isThirdParty) {
        for (const bucket of group.buckets || []) {
          if (bucket.resetTime) {
            resetTime = bucket.resetTime;
            break;
          }
        }
      }
    }
  }

  return { isDrained, fraction, resetTime };
}

export function clearAntigravityQuotaCache() {
  quotaCache.clear();
}
