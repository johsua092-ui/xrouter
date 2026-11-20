import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getNousUsage } from "../../open-sse/services/usage/nous.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  NOUS_BILLING_STATE_URL,
  NOUS_BILLING_SUBSCRIPTION_URL,
} from "../../open-sse/services/nous.js";

describe("Nous Research Usage & Billing Service", () => {
  it("returns error message when accessToken is empty", async () => {
    const res = await getNousUsage("");
    assert.match(res.message, /not available/i);
    assert.equal(res.plan, "Nous Research");
  });

  it("handles 401/403 authentication errors gracefully", async () => {
    const mockFetch = async () => {
      return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
    };

    const res = await getNousUsage("bad_token", null, { fetch: mockFetch });
    assert.equal(res.plan, "Nous Research");
    assert.match(res.message, /authentication failed/i);
  });

  it("parses Free tier billing state and subscription successfully", async () => {
    const mockFetch = async (url) => {
      if (url === NOUS_BILLING_STATE_URL) {
        return new Response(JSON.stringify({
          org: { name: "Test User's account", slug: "test-slug" },
          balanceUsd: "5.50",
          monthlyCap: {
            limitUsd: "1000",
            spentThisMonthUsd: "15.00",
          },
        }), { status: 200 });
      }
      if (url === NOUS_BILLING_SUBSCRIPTION_URL) {
        return new Response(JSON.stringify({
          current: null, // Free tier
          org: { name: "Test User's account" },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    };

    const res = await getNousUsage("valid_token", null, { fetch: mockFetch });
    assert.equal(res.plan, "Nous Research (Free - Test User's account)");
    assert.equal(res.org, "Test User's account");

    // Free Models indicator
    assert.ok(res.quotas["Free Models"]);
    assert.equal(res.quotas["Free Models"].unlimited, true);

    // Balance quota
    assert.ok(res.quotas["Balance (USD)"]);
    assert.equal(res.quotas["Balance (USD)"].total, 5.5);
    assert.equal(res.quotas["Balance (USD)"].isCreditBalance, true);
    assert.equal(res.quotas["Balance (USD)"].currency, "USD");

    // Monthly Cap quota (shows because balance/spent > 0)
    assert.ok(res.quotas["Monthly Cap"]);
    assert.equal(res.quotas["Monthly Cap"].used, 15);
    assert.equal(res.quotas["Monthly Cap"].total, 1000);
  });

  it("parses Plus tier with usage windows correctly", async () => {
    const mockFetch = async (url) => {
      if (url === NOUS_BILLING_STATE_URL) {
        return new Response(JSON.stringify({
          org: { name: "Dev Org" },
          balanceUsd: "25.00",
          monthlyCap: { limitUsd: "500", spentThisMonthUsd: "50" },
        }), { status: 200 });
      }
      if (url === NOUS_BILLING_SUBSCRIPTION_URL) {
        return new Response(JSON.stringify({
          current: { name: "Plus", tierId: "usage-window-hermes-plus" },
          org: { name: "Dev Org" },
          usageWindow: {
            daily: { used: 30, limit: 100, resetAt: "2026-11-20T00:00:00Z" },
            weekly: { used: 150, limit: 700, resetAt: "2026-11-25T00:00:00Z" },
          },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    };

    const res = await getNousUsage("valid_token", null, { fetch: mockFetch });
    assert.equal(res.plan, "Nous Research (Plus - Dev Org)");
    assert.ok(res.quotas["Daily Window"]);
    assert.equal(res.quotas["Daily Window"].used, 30);
    assert.equal(res.quotas["Daily Window"].total, 100);
    assert.equal(res.quotas["Daily Window"].remainingPercentage, 70);
    assert.equal(res.quotas["Daily Window"].resetAt, "2026-11-20T00:00:00Z");

    assert.ok(res.quotas["Weekly Window"]);
    assert.equal(res.quotas["Weekly Window"].used, 150);
    assert.equal(res.quotas["Weekly Window"].total, 700);
  });

  it("is integrated into getUsageForProvider dispatcher", async () => {
    const mockFetch = async (url) => {
      if (url === NOUS_BILLING_STATE_URL) {
        return new Response(JSON.stringify({
          balanceUsd: "0",
          monthlyCap: { limitUsd: "1000", spentThisMonthUsd: "0" },
        }), { status: 200 });
      }
      if (url === NOUS_BILLING_SUBSCRIPTION_URL) {
        return new Response(JSON.stringify({ current: null }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    };

    const res = await getUsageForProvider({
      provider: "nous",
      accessToken: "mock_token",
      fetch: mockFetch,
    });

    assert.ok(res.quotas["Free Models"]);
    assert.ok(res.quotas["Balance (USD)"]);
    assert.equal(res.plan, "Nous Research (Free)");
  });
});
