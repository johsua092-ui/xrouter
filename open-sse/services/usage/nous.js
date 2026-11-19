/**
 * Nous Research usage handler
 *
 * Source of truth: official Nous Portal internal billing endpoints
 *   GET https://portal.nousresearch.com/api/billing/state
 *   GET https://portal.nousresearch.com/api/billing/subscription
 *
 * Auth: Bearer <accessToken>
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  NOUS_BILLING_STATE_URL,
  NOUS_BILLING_SUBSCRIPTION_URL,
} from "../nous.js";

/**
 * Get quota and subscription usage for Nous Research connection
 * @param {string} accessToken
 * @param {object|null} proxyOptions
 * @returns {Promise<object>} Usage data with plan and quotas
 */
export async function getNousUsage(accessToken, proxyOptions = null, options = {}) {
  if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
    return {
      plan: "Nous Research",
      message: "Nous access token not available. Connect via OAuth or API key to view usage.",
    };
  }

  const fetchFn = options.fetch || proxyAwareFetch;
  const token = accessToken.trim();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  try {
    const [stateRes, subRes] = await Promise.all([
      fetchFn(
        NOUS_BILLING_STATE_URL,
        { method: "GET", headers },
        proxyOptions,
      ).catch((err) => ({ ok: false, status: 0, error: err })),
      fetchFn(
        NOUS_BILLING_SUBSCRIPTION_URL,
        { method: "GET", headers },
        proxyOptions,
      ).catch((err) => ({ ok: false, status: 0, error: err })),
    ]);

    if (stateRes.status === 401 || stateRes.status === 403 || subRes.status === 401 || subRes.status === 403) {
      return {
        plan: "Nous Research",
        message: "Nous authentication failed. Re-authenticate connection.",
      };
    }

    if (!stateRes.ok && !subRes.ok) {
      const errStatus = stateRes.status || subRes.status || 500;
      return {
        plan: "Nous Research",
        message: `Nous billing API error (${errStatus})`,
      };
    }

    const billingData = stateRes.ok ? await stateRes.json().catch(() => ({})) : {};
    const subData = subRes.ok ? await subRes.json().catch(() => ({})) : {};

    const tierName = subData?.current?.name || (subData?.current ? "Plus" : "Free");
    const orgName = billingData?.org?.name || subData?.org?.name || null;
    const plan = orgName ? `Nous Research (${tierName} - ${orgName})` : `Nous Research (${tierName})`;

    const quotas = {};

    // 1. Credit balance
    const balance = parseFloat(billingData?.balanceUsd || 0);
    quotas["Balance (USD)"] = {
      used: 0,
      total: balance,
      remainingPercentage: balance > 0 ? 100 : 0,
      resetAt: null,
      unlimited: false,
      isCreditBalance: true,
      currency: "USD",
    };

    // 2. Monthly spending cap
    const spent = parseFloat(billingData?.monthlyCap?.spentThisMonthUsd || 0);
    const limit = parseFloat(billingData?.monthlyCap?.limitUsd || 0);
    if (limit > 0) {
      quotas["Monthly Cap"] = {
        used: spent,
        total: limit,
        remainingPercentage: Math.max(0, Math.min(100, Math.round(((limit - spent) / limit) * 100))),
        resetAt: null,
        unlimited: false,
      };
    }

    // 3. Usage windows (for Plus / Super / Ultra tiers)
    if (subData?.usageWindow && typeof subData.usageWindow === "object") {
      for (const [windowName, windowData] of Object.entries(subData.usageWindow)) {
        if (!windowData || typeof windowData !== "object") continue;
        const wUsed = Number(windowData.used ?? windowData.spent ?? 0);
        const wLimit = Number(windowData.limit ?? windowData.cap ?? windowData.total ?? 0);
        const wResetAt = windowData.resetsAt || windowData.resetAt || windowData.resets_at || null;
        const label = `${windowName.charAt(0).toUpperCase() + windowName.slice(1)} Window`;
        quotas[label] = {
          used: wUsed,
          total: wLimit,
          remainingPercentage: wLimit > 0 ? Math.max(0, Math.min(100, Math.round(((wLimit - wUsed) / wLimit) * 100))) : 100,
          resetAt: wResetAt,
          unlimited: wLimit <= 0,
        };
      }
    }

    return {
      plan,
      quotas,
      org: orgName,
    };
  } catch (error) {
    return {
      plan: "Nous Research",
      message: `Nous usage error: ${error.message}`,
    };
  }
}
