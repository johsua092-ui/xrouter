import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { getGlmUsage, getGlmClaimablePlans, claimGlmPlan, getGlmBalance } from "../../open-sse/services/usage/glm.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_GLM_CREDIT_USAGE = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 2000,
        currentValue: 0,
        remaining: 1999,
        percentage: 25,
        nextResetTime: 1787905548392,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 10000,
        currentValue: 0,
        remaining: 9999,
        percentage: 10,
        nextResetTime: 1788492142997,
      },
    ],
    level: "lite",
  },
  success: true,
};

const SAMPLE_GLM_TOKENS_USAGE = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "TOKENS_LIMIT",
        percentage: 40,
        nextResetTime: 1787905548392,
      },
    ],
    level: "standard",
  },
  success: true,
};

describe("glm registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("glm");
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("glm-cn");
    expect(USAGE_APIKEY_PROVIDERS).toContain("glm");
    expect(USAGE_APIKEY_PROVIDERS).toContain("glm-cn");
  });
});

describe("getGlmUsage and getUsageForProvider(glm)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles CREDIT_LIMIT with session 5h and weekly 7d quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_GLM_CREDIT_USAGE));

    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "glm-key-123",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Lite");
    expect(usage.quotas["Session (5h)"]).toEqual({
      used: 25,
      total: 100,
      remaining: 75,
      remainingPercentage: 75,
      resetAt: new Date(1787905548392).toISOString(),
      unlimited: false,
    });
    expect(usage.quotas["Weekly (7d)"]).toEqual({
      used: 100 ? 10 : 10,
      total: 100,
      remaining: 90,
      remainingPercentage: 90,
      resetAt: new Date(1788492142997).toISOString(),
      unlimited: false,
    });
  });

  it("handles TOKENS_LIMIT quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_GLM_TOKENS_USAGE));

    const usage = await getUsageForProvider({
      provider: "glm-cn",
      apiKey: "glm-cn-key",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Standard");
    expect(usage.quotas["Tokens"]).toEqual({
      used: 40,
      total: 100,
      remaining: 60,
      remainingPercentage: 60,
      resetAt: new Date(1787905548392).toISOString(),
      unlimited: false,
    });
  });

  it("handles fallback key for custom limit units", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 200,
        data: {
          limits: [
            {
              type: "CREDIT_LIMIT",
              unit: 99,
              number: 12,
              percentage: 5,
              nextResetTime: 0,
            },
          ],
          level: "pro",
        },
      })
    );

    const usage = await getGlmUsage("glm-key", "glm");
    expect(usage.plan).toBe("Pro");
    expect(usage.quotas["Limit (12)"]).toEqual({
      used: 5,
      total: 100,
      remaining: 95,
      remainingPercentage: 95,
      resetAt: null,
      unlimited: false,
    });
  });

  it("surfaces invalid key message on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "invalid-key",
    });

    expect(usage.message).toMatch(/invalid or expired/i);
  });

  it("handles non-200 error response", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "server error" }, 500));

    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "valid-key",
    });

    expect(usage.message).toMatch(/GLM quota API error \(500\)/);
  });

  it("returns message when apiKey is missing", async () => {
    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "",
    });

    expect(usage.message).toBe("GLM API key not available.");
  });
});

describe("GLM native event gift card claim", () => {
  it("fetches and normalizes claimable plans from zcode preview endpoint", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        msg: "success",
        data: {
          server_time: 1730336400,
          plans: [
            {
              plan_id: "zcode_weekend_build",
              name: "ZCODE WEEKEND BUILD",
              description: "500M tokens grant",
              priority: 10,
              entitlements: [
                {
                  entitlement_id: "ent_glm_5_3_flash",
                  show_name: "GLM-5.3-Flash",
                  meter: "tokens",
                  unit_type: "tokens",
                  grant_units: 500000000,
                  period: "one_time",
                },
              ],
            },
          ],
        },
      })
    );

    const result = await getGlmClaimablePlans("mock_jwt_token");
    expect(result.count).toBe(1);
    expect(result.plans[0].planId).toBe("zcode_weekend_build");
    expect(result.plans[0].name).toBe("ZCODE WEEKEND BUILD");
    expect(result.plans[0].entitlements[0].grantUnits).toBe(500000000);
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("https://zcode.z.ai/api/v1/zcode-plan/billing/preview"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer mock_jwt_token",
          "X-ZCode-App-Version": "3.16.3",
          "X-Platform": "linux-x64",
        }),
      }),
      null
    );
  });

  it("claims a plan successfully via zcode claim endpoint", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        msg: "Claim succeeded",
        data: {
          server_time: 1730336500,
          plan: {
            user_plan_id: "upl_123",
            plan_id: "zcode_weekend_build",
            status: "active",
          },
        },
      })
    );

    const result = await claimGlmPlan("mock_jwt_token", "zcode_weekend_build");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.plan.user_plan_id).toBe("upl_123");
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://zcode.z.ai/api/v1/zcode-plan/billing/claim",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer mock_jwt_token",
          "Content-Type": "application/json",
          "X-ZCode-App-Version": "3.16.3",
          "X-Platform": "linux-x64",
        }),
        body: JSON.stringify({ plan_id: "zcode_weekend_build" }),
      }),
      null
    );
  });

  it("handles claim failure cleanly without throwing unhandled exceptions", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 3001,
        msg: "Plan already claimed",
      }, 400)
    );

    const result = await claimGlmPlan("mock_jwt_token", "zcode_weekend_build");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Plan already claimed/i);
  });

  it("fetches active ZCode plan token balance via billing/balance endpoint", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        msg: "success",
        data: {
          server_time: 1730336500,
          plans: [{ plan_id: "zcode_weekend_build", name: "ZCODE WEEKEND BUILD", status: "active" }],
          balances: [
            {
              show_name: "GLM-5.3-Flash",
              plan_id: "zcode_weekend_build",
              total_units: 500000000,
              used_units: 0,
              remaining_units: 500000000,
              unit_type: "tokens",
            },
          ],
        },
      })
    );

    const balance = await getGlmBalance("mock_jwt_token");
    expect(balance).not.toBeNull();
    expect(balance.balances[0].total_units).toBe(500000000);
    expect(balance.balances[0].show_name).toBe("GLM-5.3-Flash");
  });
});
