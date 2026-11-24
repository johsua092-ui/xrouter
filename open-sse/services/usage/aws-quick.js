// Amazon Quick (AWS) usage handler.
//
// Ported from magpie-aws-quick lib/usage.mjs (MIT). Quick meters agent time in
// minutes per entitlement unit; the tenant data plane answers
// `getAvailableEntitlementUnits` over the same qbs-event route the desktop
// app's cloud calls use:
//   POST {tenant_url}/integration/quick-work/qbs-event
//   {eventType, eventBody:{getAvailableEntitlementUnits:{awsAccountId}}}
// → {entitlements:[{unitType, numMinsAvailable, numMinsProvisioned, …}],
//    subscriptionMetadata:{subscriptionType, freeTrialMetadata:{status, expiryDate}}}
// (verified live on a social/AIDP account; the body must be non-empty).

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const UNIT_NAMES = {
  AUTOMATION_AGENT_HOUR_UNIT: "Agent hours",
  RESEARCH_AGENT_HOUR_UNIT: "Research hours",
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const hours = (mins) => Math.round((mins / 60) * 100) / 100;

/** QUICK_LITE_FREE_TRIAL → "Quick Lite (free trial)". */
export function planName(type) {
  const t = String(type || "").trim().toUpperCase();
  if (!t) return "";
  const trial = /_FREE_TRIAL$/.test(t);
  const words = t
    .replace(/_FREE_TRIAL$/, "")
    .split("_")
    .filter(Boolean);
  const name = words.map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
  return trial ? `${name} (free trial)` : name;
}

function unitName(type) {
  if (UNIT_NAMES[type]) return UNIT_NAMES[type];
  const words = String(type || "Usage")
    .replace(/_UNIT$/, "")
    .split("_")
    .filter(Boolean);
  return words.map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

/** Quick's own usage widget resets on the 1st of next month (local time). */
function nextMonthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
}

/** The account as Quick names it: the email/user tail of the actor ARN. */
function userOf(psd) {
  const arn = String(psd?.actorArn || "");
  const m = /:user\/[^\/]+\/(.+)$/.exec(arn);
  return psd?.accountName || m?.[1] || "";
}

/** Tenant base URL: providerSpecificData.tenantUrl, else derived from wsHost. */
export function tenantBaseUrl(psd) {
  const tenant = String(psd?.tenantUrl || "").replace(/\/+$/, "");
  if (tenant) return tenant;
  const host = String(psd?.wsHost || "").replace(/\/+$/, "");
  if (!host) return "";
  if (/^wss:\/\//.test(host)) return `https://${host.slice(6)}`;
  if (/^ws:\/\//.test(host)) return `http://${host.slice(5)}`;
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

/**
 * Raw getAvailableEntitlementUnits request — the Response is returned as-is
 * (status intact) so callers can tell 401/403 apart from 429/5xx, and the
 * request goes through proxyAwareFetch so the connection's proxy applies.
 * Returns null when there is no token or no tenant base URL.
 */
export async function probeAwsQuickEntitlementsResponse(accessToken, providerSpecificData, proxyOptions = null, { signal } = {}) {
  const base = tenantBaseUrl(providerSpecificData);
  if (!accessToken || !base) return null;
  const type = "getAvailableEntitlementUnits";
  return proxyAwareFetch(
    `${base}/integration/quick-work/qbs-event`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "x-amzn-qs-internal-trace-id": crypto.randomUUID(),
      },
      // The body must be non-empty for the data plane to answer.
      body: JSON.stringify({ eventType: type, eventBody: { [type]: { awsAccountId: providerSpecificData?.awsAccountId || "" } } }),
      ...(signal ? { signal } : {}),
    },
    proxyOptions
  );
}

/**
 * Raw getAvailableEntitlementUnits probe. Returns the `…Response` object
 * (entitlements + subscriptionMetadata) or null; `onAuthError` flags 401/403.
 */
export async function probeAwsQuickEntitlements(accessToken, providerSpecificData, proxyOptions = null, { signal, onAuthError } = {}) {
  const r = await probeAwsQuickEntitlementsResponse(accessToken, providerSpecificData, proxyOptions, { signal });
  if (!r) return null;
  if (r.status === 401 || r.status === 403) {
    onAuthError?.(r.status);
    return null;
  }
  const j = await r.json().catch(() => null);
  const type = "getAvailableEntitlementUnits";
  const resp = j?.eventResponse?.[`${type}Response`];
  if (!r.ok || !resp) return null;
  return resp;
}

/**
 * Map a getAvailableEntitlementUnits response to the gateway's shared usage
 * shape: { plan, quotas: { <unit>: {used, total, remaining, resetAt, unlimited} } }.
 * Units drawing on the same pool (identical minutes) collapse into one entry.
 */
export function quotaFromEntitlements(resp, { now } = {}) {
  const quotaInfo = {};
  const seen = new Map();
  for (const e of Array.isArray(resp?.entitlements) ? resp.entitlements : []) {
    const total = num(e.numMinsProvisioned);
    const left = num(e.numMinsAvailable);
    const key = `${total}|${left}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    const usedMins = Math.max(0, total - left);
    quotaInfo[unitName(e.unitType)] = {
      used: hours(usedMins),
      total: hours(total),
      remaining: hours(Math.max(0, left)),
      resetAt: nextMonthStart(now),
      unlimited: total <= 0,
    };
  }
  const sub = resp?.subscriptionMetadata;
  const plan = planName(sub?.subscriptionType);
  return {
    ...(plan ? { plan } : {}),
    quotas: quotaInfo,
  };
}

/**
 * Usage for one aws-quick connection. accessToken is the id_token;
 * providerSpecificData carries {tenantUrl, wsHost, awsAccountId, actorArn, …}.
 */
export async function getAwsQuickUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    let authError = false;
    const resp = await probeAwsQuickEntitlements(accessToken, providerSpecificData || {}, proxyOptions, {
      onAuthError: () => {
        authError = true;
      },
    });
    if (authError) {
      return {
        message: "Amazon Quick login has expired — please reconnect the provider.",
        signIn: "expired",
        quotas: {},
      };
    }
    if (!resp) {
      return { message: "Unable to fetch Amazon Quick usage right now.", quotas: {} };
    }
    return quotaFromEntitlements(resp);
  } catch (e) {
    return {
      message: `Unable to fetch Amazon Quick usage: ${String(e?.message ?? e).slice(0, 200)}`,
      quotas: {},
    };
  }
}
