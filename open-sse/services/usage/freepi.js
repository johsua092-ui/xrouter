/**
 * FreePI usage - queries GET /me/stats
 * Free daily allowance refills daily (refill_at timestamp).
 * Note: Free models (Particle-1, DeepSeek V4.1 Flash, GLM 5.3 Flash, DeepSeek V4 Flash)
 * are Free Unlimited and do not deduct from the daily credit allowance.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const STATS_URL = "https://api.freepi.ai/me/stats";

/**
 * @param {string|null|undefined} token
 * @param {object|null} proxyOptions
 */
export async function getFreePiUsage(token, proxyOptions = null) {
  if (!token || typeof token !== "string" || !token.trim()) {
    return { message: "FreePI token not available. Connect with GitHub or add token to view usage." };
  }

  try {
    const res = await proxyAwareFetch(
      STATS_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (res.status === 401 || res.status === 403) {
      return { plan: "FreePI", message: "FreePI authentication failed. Check token or sign in again." };
    }

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return {
        plan: "FreePI",
        message: `FreePI usage error (${res.status})${err ? `: ${err.slice(0, 120)}` : ""}`,
      };
    }

    const stats = await res.json();
    const allowance = typeof stats.allowance_credits === "number" ? stats.allowance_credits : 0;
    const remaining = typeof stats.remaining_credits_today === "number" ? stats.remaining_credits_today : allowance;
    const usedCredits = Math.max(0, allowance - remaining);
    const wallet = typeof stats.credit_credits === "number" ? stats.credit_credits : 0;
    const bonus = typeof stats.bonus_wallet_credits === "number" ? stats.bonus_wallet_credits : 0;
    const totalTokensToday = (stats.prompt_tokens_today || 0) + (stats.completion_tokens_today || 0);
    const requestsToday = typeof stats.request_count_today === "number" ? stats.request_count_today : 0;

    const quotas = {
      "Daily Credits": {
        used: usedCredits,
        total: allowance,
        remainingPercentage: allowance > 0 ? Math.round(((allowance - usedCredits) / allowance) * 100) : 100,
        resetAt: stats.refill_at || null,
        unlimited: false,
      },
    };

    if (requestsToday > 0 || totalTokensToday > 0) {
      quotas["Tokens Today"] = {
        used: totalTokensToday,
        total: 0,
        remainingPercentage: 100,
        resetAt: stats.refill_at || null,
        unlimited: true,
        unit: "tokens",
      };
      quotas["Requests Today"] = {
        used: requestsToday,
        total: 0,
        remainingPercentage: 100,
        resetAt: stats.refill_at || null,
        unlimited: true,
        unit: "requests",
      };
    }

    if (wallet > 0 || bonus > 0) {
      quotas["Credits Wallet"] = {
        used: 0,
        total: wallet + bonus,
        resetAt: null,
        unlimited: false,
      };
    }

    const tierLabel = stats.tier ? ` (${stats.tier})` : "";
    const handleLabel = stats.handle ? ` · @${stats.handle}` : "";

    return {
      plan: `FreePI${tierLabel}${handleLabel}`,
      quotas,
    };
  } catch (err) {
    return { message: `FreePI error: ${err.message}` };
  }
}
