import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }
    : {
        models: {
          "gemini-3.8-flash-high": {
            displayName: "Gemini 3.8 Flash (High)",
            quotaInfo: { remainingFraction: 0.8, resetTime: "2026-07-25T12:00:00Z" },
          },
          "gemini-3.8-flash-medium": {
            displayName: "Gemini 3.8 Flash (Medium)",
            quotaInfo: { remainingFraction: 0.5, resetTime: "2026-07-25T12:00:00Z" },
          },
          "gemini-3.8-flash-low": {
            displayName: "Gemini 3.8 Flash (Low)",
            quotaInfo: { remainingFraction: 0.2, resetTime: "2026-07-25T12:00:00Z" },
          },
          "gemini-3.5-flash-low": {
            displayName: "Gemini 3.5 Flash (Medium)",
            quotaInfo: { remainingFraction: 0.9, resetTime: "2026-07-25T12:00:00Z" },
          },
          "internal-model": {
            displayName: "Internal",
            isInternal: true,
            quotaInfo: { remainingFraction: 0.5 },
          },
        },
      },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity quota tracker: Gemini 3.8 Flash usage bars", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("returns Gemini 3.8 Flash tier quotas so the dashboard can render usage bars", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.8-flash-high"]).toMatchObject({
      used: 200,
      total: 1000,
      remainingPercentage: 80,
      displayName: "Gemini 3.8 Flash (High)",
    });
    expect(usage.quotas["gemini-3.8-flash-medium"]).toMatchObject({
      used: 500,
      total: 1000,
      remainingPercentage: 50,
    });
    expect(usage.quotas["gemini-3.8-flash-low"]).toMatchObject({
      used: 800,
      total: 1000,
      remainingPercentage: 20,
    });
  });

  it("filters out internal and unlisted models", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    // isInternal is dropped outright. gemini_session is an account-scoped
    // bucket the dashboard renders separately rather than as a per-model bar,
    // so it is intentionally not filtered out of the raw quota map here.
    expect(usage.quotas).not.toHaveProperty("internal-model");
    expect(Object.keys(usage.quotas)).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.5-flash-low",
      "gemini_session",
    ]);
  });
});
