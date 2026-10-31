/**
 * GLM Coding Plan usage (international + China regions)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

/**
 * Parse the GLM quota API response — shared by pasted API keys and
 * OAuth-minted coding-plan keys (both hit the same monitor endpoint).
 * Supports both TOKENS_LIMIT and CREDIT_LIMIT and dynamic intervals (e.g. session 5h, weekly 7d).
 */
export function parseGlmQuotaResponse(json) {
  if (json?.success === false || (json?.code !== undefined && ![0, 200].includes(json.code))) {
    const rawMsg = json?.msg || json?.message || "No coding plan package active for this account";
    const message = rawMsg.includes("不存在coding plan")
      ? "Akun ini belum memiliki paket Coding Plan aktif di Z.ai. Silakan aktifkan paket di chat.z.ai / api.z.ai."
      : rawMsg;
    return { plan: "None", quotas: {}, message };
  }

  const data = json?.data && typeof json.data === "object" ? json.data : {};
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const quotas = {};

  for (const limit of limits) {
    // 1. Accept both TOKENS_LIMIT and CREDIT_LIMIT from GLM API
    if (!limit || (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT")) continue;
    const usedPercent = Number(limit.percentage) || 0;
    const resetMs = Number(limit.nextResetTime) || 0;
    const remaining = Math.max(0, 100 - usedPercent);
    // Absolute token amounts, when Z.ai returns them (gift/top-up grants like
    // "ZCODE Weekend Build" surface totalTokens/usedTokens / total/used in tokens).
    const absUsed = Number(limit.used ?? limit.usedTokens ?? limit.usedTokensAmount) || 0;
    const absTotal = Number(limit.total ?? limit.totalTokens ?? limit.totalTokensAmount) || 0;

    // 2. Map key dynamically based on type and period (unit) to avoid overwriting
    let key = "session";
    if (limit.unit === 3) {
      key = `Session (${limit.number}h)`;
    } else if (limit.unit === 6) {
      key = "Weekly (7d)";
    } else if (limit.type === "TOKENS_LIMIT") {
      key = "Tokens";
    } else {
      key = `Limit (${limit.number})`;
    }
    // Distinct key for an absolute-token grant so it doesn't clobber the %-window row.
    if (limit.type === "TOKENS_LIMIT" && absTotal > 0 && key === "Tokens") {
      key = "Tokens (grant)";
    }

    quotas[key] = {
      used: usedPercent,
      total: 100,
      remaining,
      remainingPercentage: remaining,
      usedTokens: absUsed,
      totalTokens: absTotal,
      resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
      unlimited: false,
    };
  }

  const levelRaw = typeof data.level === "string" ? data.level : "";
  const plan = levelRaw
    ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
    : limits.length > 0 ? "Standard" : "None";

  const message = limits.length === 0
    ? "Akun ini belum memiliki paket Coding Plan aktif di Z.ai (0 kuota)."
    : null;

  return { plan, quotas, message };
}

function glmResetError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function isGlmResetCardId(value) {
  return Number.isSafeInteger(value) || (typeof value === "string" && value.trim().length > 0);
}

function parseGlmCardExpiry(value) {
  const match = typeof value === "string" && value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T]([01]\d|2[0-3]):([0-5]\\d):([0-5]\d)(\\.\\d{1,6})?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/);
  const day = match && new Date(`${match[1]}T00:00:00Z`);
  if (!match || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1]) {
    throw glmResetError("Invalid GLM reset card expiry.");
  }
  // Z.ai's timezone-less reset-card expiry is Beijing time, not UTC or the host's local time.
  const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[5] || ""}${match[6] || "+08:00"}`);
  if (!Number.isFinite(time)) throw glmResetError("Invalid GLM reset card expiry.");
  return time;
}

async function glmResetRequest(apiKey, card, proxyOptions) {
  let response;
  try {
    response = await proxyAwareFetch(U("glm")[card ? "resetCardsUseUrl" : "resetCardsUrl"], {
      method: card ? "POST" : "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      strictTls: true,
      ...(card ? {
        body: JSON.stringify({ targetType: "PERSONAL", resetType: card.type, recordId: card.recordId, requestId: crypto.randomUUID() }),
      } : {}),
    // Proxy fallback would replay an irreversible POST after a potentially delivered request.
    }, card ? { ...proxyOptions, strictProxy: true } : proxyOptions);
  } catch {
    throw glmResetError("GLM reset card request failed. Check the provider dashboard before trying again.");
  }
  return { response, payload: await response.json().catch(() => null) };
}

export async function getGlmResetCards(apiKey, proxyOptions = null) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw glmResetError("GLM API key not available.", 401);
  const { response, payload } = await glmResetRequest(apiKey, null, proxyOptions);
  if (!response.ok) {
    throw glmResetError(`GLM reset card API error (${response.status}).`, response.status >= 400 && response.status < 500 ? response.status : 502);
  }
  if (payload?.success !== true || ![0, 200].includes(payload.code)) {
    throw glmResetError("GLM reset card API rejected the request.", [401, 403].includes(payload?.code) ? payload.code : 502);
  }
  if (!Array.isArray(payload.data?.fiveHourResets) || !Array.isArray(payload.data?.weekResets)) {
    throw glmResetError("Invalid GLM reset card list.");
  }
  const cards = [];
  for (const [bucket, type] of [["fiveHourResets", "FIVE_HOUR"], ["weekResets", "WEEK"]]) {
    for (const item of payload.data[bucket]) {
      if (item?.available !== true || !isGlmResetCardId(item.recordId)) continue;
      const expiry = parseGlmCardExpiry(item.expireTime);
      if (expiry <= Date.now()) continue;
      cards.push({ recordId: item.recordId, type, expiresAt: new Date(expiry).toISOString() });
    }
  }
  cards.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  return { availableCount: cards.length, cards };
}

export async function redeemGlmResetCard(apiKey, card, proxyOptions = null) {
  const failed = (status, code, uncertain, message) => ({ ok: false, alreadyUsed: false, status, code, uncertain, message });
  if (!card || !["FIVE_HOUR", "WEEK"].includes(card.type) || !isGlmResetCardId(card.recordId)) {
    return failed(400, "invalid_card", false, "Invalid GLM reset card.");
  }
  if (typeof apiKey !== "string" || !apiKey.trim()) return failed(401, "unauthorized", false, "GLM API key not available.");
  try {
    const { response, payload } = await glmResetRequest(apiKey, card, proxyOptions);
    if (response.ok && payload?.success === true && [0, 200].includes(payload.code)) {
      return { ok: true, alreadyUsed: false, uncertain: false, status: 200, code: "SUCCESS", message: "GLM usage reset successfully." };
    }
  } catch {}
  return failed(502, "uncertain", true, "Reset outcome is unknown. Check the Z.ai dashboard before trying again.");
}

/**
 * GLM Coding Plan usage (international + China regions)
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null) {
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(
      quotaUrl,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const { plan, quotas, message } = parseGlmQuotaResponse(json);

    let resetCards = null;
    if (provider === "glm") {
      try {
        resetCards = await getGlmResetCards(apiKey, proxyOptions);
      } catch {}
    }

    return { plan, quotas, message, resetCards };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}

const ZCODE_PLAN_PREVIEW_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/preview";
const ZCODE_PLAN_CLAIM_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/claim";
const ZCODE_APP_VERSION = "3.16.3";
const ZCODE_PLATFORM = "linux-x64";

/**
 * Fetch claimable gift cards / event plans for GLM / Z.ai accounts.
 * Hits GET https://zcode.z.ai/api/v1/zcode-plan/billing/preview
 */
export async function getGlmClaimablePlans(token, proxyOptions = null) {
  if (typeof token !== "string" || !token.trim()) {
    throw glmResetError("GLM authentication token not available.", 401);
  }
  const cleanToken = token.trim().replace(/^Bearer\s+/i, "");
  const url = new URL(ZCODE_PLAN_PREVIEW_URL);
  url.searchParams.set("app_version", ZCODE_APP_VERSION);
  url.searchParams.set("platform", ZCODE_PLATFORM);

  let response;
  try {
    response = await proxyAwareFetch(
      url.toString(),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          Accept: "application/json",
          "X-ZCode-App-Version": ZCODE_APP_VERSION,
          "X-Platform": ZCODE_PLATFORM,
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
      proxyOptions,
    );
  } catch (err) {
    throw glmResetError(`GLM plan preview network error: ${err?.message || err}`, 502);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw glmResetError(payload?.msg || payload?.message || `GLM preview HTTP error (${response.status})`, response.status >= 400 && response.status < 500 ? response.status : 502);
  }

  if (payload?.code !== 0 && payload?.code !== 200) {
    throw glmResetError(payload?.msg || payload?.message || `GLM preview rejected (code ${payload?.code})`, 400);
  }

  const plans = (payload?.data?.plans || []).map((p) => ({
    planId: p.plan_id || p.planId || "",
    name: p.name || p.plan_id || "Event Plan",
    description: p.description || "",
    priority: p.priority ?? 0,
    entitlements: (p.entitlements || []).map((e) => ({
      entitlementId: e.entitlement_id || e.entitlementId || "",
      showName: e.show_name || e.showName || "",
      meter: e.meter || "",
      unitType: e.unit_type || e.unitType || "tokens",
      grantUnits: Number(e.grant_units ?? e.grantUnits) || 0,
      period: e.period || "",
      effectiveAt: e.effective_at || e.effectiveAt || null,
    })),
  })).filter((p) => Boolean(p.planId));

  return {
    serverTime: payload?.data?.server_time,
    plans,
    count: plans.length,
  };
}

/**
 * Claim an event plan / giftcard natively for a GLM / Z.ai account.
 * Hits POST https://zcode.z.ai/api/v1/zcode-plan/billing/claim
 */
export async function claimGlmPlan(token, planId, proxyOptions = null, captcha = null) {
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, status: 401, code: "unauthorized", message: "GLM authentication token not available." };
  }
  if (!planId || typeof planId !== "string" || !planId.trim()) {
    return { ok: false, status: 400, code: "invalid_plan_id", message: "Plan ID is required." };
  }

  const cleanToken = token.trim().replace(/^Bearer\s+/i, "");
  const headers = {
    Authorization: `Bearer ${cleanToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-ZCode-App-Version": ZCODE_APP_VERSION,
    "X-Platform": ZCODE_PLATFORM,
  };

  if (captcha?.captchaVerifyParam) {
    headers["X-Aliyun-Captcha-Verify-Param"] = captcha.captchaVerifyParam;
  }
  if (captcha?.captchaRegion) {
    headers["X-Aliyun-Captcha-Verify-Region"] = captcha.captchaRegion;
  }

  let response;
  try {
    response = await proxyAwareFetch(
      ZCODE_PLAN_CLAIM_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ plan_id: planId.trim() }),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      },
      proxyOptions,
    );
  } catch (err) {
    return { ok: false, status: 502, code: "network_error", message: `GLM claim request failed: ${err?.message || err}` };
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: payload?.code || "http_error",
      message: payload?.msg || payload?.message || `GLM claim failed (HTTP ${response.status})`,
    };
  }

  if (payload?.code === 0 || payload?.code === 200) {
    return {
      ok: true,
      status: 200,
      code: "SUCCESS",
      message: payload?.msg || "Plan claimed successfully.",
      plan: payload?.data?.plan || null,
      serverTime: payload?.data?.server_time,
    };
  }

  return {
    ok: false,
    status: 400,
    code: payload?.code || "claim_rejected",
    message: payload?.msg || payload?.data?.message || payload?.message || "GLM plan claim was rejected by server.",
  };
}
