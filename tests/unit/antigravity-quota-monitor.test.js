// Unit tests for open-sse/services/antigravityQuotaMonitor.js and
// open-sse/services/antigravityTlsClient.js — the proactive Antigravity quota
// pre-check and its BoringSSL fetch delegate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeoutMock = vi.fn();
vi.mock("../../open-sse/services/usage/shared.js", () => ({
  fetchWithTimeout: (...args) => fetchWithTimeoutMock(...args),
}));

const zcodeTlsFetchMock = vi.fn();
vi.mock("../../open-sse/services/zcodeTlsClient.js", () => ({
  zcodeTlsFetch: (...args) => zcodeTlsFetchMock(...args),
}));

const quotaUrl = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

let _clearQuotaMonitorCache;
let parseMostRestrictiveBucket;
let isAntigravityQuotaDrained;

function summaryResponse(bucketsByGroup) {
  return {
    ok: true,
    json: async () => ({
      groups: Object.entries(bucketsByGroup).map(([displayName, buckets]) => ({
        displayName,
        buckets,
      })),
    }),
  };
}

function bucket(remainingFraction, extra = {}) {
  return { window: "5h", remainingFraction, resetTime: "2026-11-24T01:00:00Z", ...extra };
}

describe("antigravityQuotaMonitor", () => {
  beforeEach(async () => {
    vi.resetModules();
    fetchWithTimeoutMock.mockReset();
    ({ _clearQuotaMonitorCache, parseMostRestrictiveBucket, isAntigravityQuotaDrained } = await import(
      "../../open-sse/services/antigravityQuotaMonitor.js"
    ));
    _clearQuotaMonitorCache();
  });

  afterEach(() => {
    _clearQuotaMonitorCache();
  });

  describe("parseMostRestrictiveBucket", () => {
    it("picks the most restrictive bucket across session and weekly windows", () => {
      const data = {
        groups: [
          {
            displayName: "Gemini Pro",
            buckets: [
              bucket(0.5),
              { window: "weekly", remainingFraction: 0.01, resetTime: "2026-11-29T00:00:00Z" },
            ],
          },
        ],
      };
      expect(parseMostRestrictiveBucket(data, "gemini-3.7-flash-high")).toEqual({
        remainingFraction: 0.01,
        resetTime: "2026-11-29T00:00:00Z",
      });
    });

    it("routes model families to the matching group only", () => {
      const data = {
        groups: [
          { displayName: "Gemini Pro", buckets: [bucket(0.4)] },
          { displayName: "Claude & GPT", buckets: [bucket(0.9)] },
        ],
      };
      expect(parseMostRestrictiveBucket(data, "claude-opus-4-6").remainingFraction).toBe(0.9);
      expect(parseMostRestrictiveBucket(data, "gpt-5.2").remainingFraction).toBe(0.9);
      expect(parseMostRestrictiveBucket(data, "gemini-3-pro").remainingFraction).toBe(0.4);
      expect(parseMostRestrictiveBucket(data, "ag/gemini-3-flash").remainingFraction).toBe(0.4);
    });

    it("treats argon models as their own family", () => {
      const data = {
        groups: [
          { displayName: "Gemini 4 Argon", buckets: [bucket(0.7)] },
          { displayName: "Gemini Pro", buckets: [bucket(0.1)] },
        ],
      };
      expect(parseMostRestrictiveBucket(data, "gemini-4-argon").remainingFraction).toBe(0.7);
    });

    it("skips disabled weekly buckets and reports disabled session buckets as 0", () => {
      const data = {
        groups: [
          {
            displayName: "Gemini Pro",
            buckets: [
              { window: "weekly", disabled: true, remainingFraction: 0.8 },
              { window: "5h", disabled: true, remainingFraction: 0.4 },
            ],
          },
        ],
      };
      const worst = parseMostRestrictiveBucket(data, "gemini-3-pro");
      expect(worst.remainingFraction).toBe(0);
      expect(worst.resetTime).toBeNull();
    });

    it("returns null for unparsable payloads and unknown families", () => {
      expect(parseMostRestrictiveBucket(null, "gemini-3-pro")).toBeNull();
      expect(parseMostRestrictiveBucket({}, "gemini-3-pro")).toBeNull();
      expect(parseMostRestrictiveBucket({ groups: [] }, "gemini-3-pro")).toBeNull();
      expect(parseMostRestrictiveBucket({ groups: [{ displayName: "Other", buckets: [bucket(0.5)] }] }, "gemini-3-pro")).toBeNull();
    });
  });

  describe("isAntigravityQuotaDrained", () => {
    it("reports drained at remaining <= 2% with the bucket resetTime", async () => {
      fetchWithTimeoutMock.mockResolvedValue(summaryResponse({ "Gemini Pro": [bucket(0.01)] }));
      const result = await isAntigravityQuotaDrained("tok", "gemini-3-pro", null, "conn1");
      expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
        quotaUrl,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        }),
        10_000,
        null
      );
      expect(result).toEqual({ isDrained: true, resetTime: "2026-11-24T01:00:00Z" });
    });

    it("reports healthy above the threshold", async () => {
      fetchWithTimeoutMock.mockResolvedValue(summaryResponse({ "Gemini Pro": [bucket(0.03)] }));
      const result = await isAntigravityQuotaDrained("tok", "gemini-3-pro", null, "conn1");
      expect(result).toEqual({ isDrained: false, resetTime: "2026-11-24T01:00:00Z" });
    });

    it("serves the documented { isDrained, resetTime } shape on cache hits without refetching", async () => {
      fetchWithTimeoutMock.mockResolvedValue(summaryResponse({ "Gemini Pro": [bucket(0.01)] }));
      const first = await isAntigravityQuotaDrained("tok", "gemini-3-pro", null, "conn1");
      expect(first.isDrained).toBe(true);
      const calls = fetchWithTimeoutMock.mock.calls.length;
      const second = await isAntigravityQuotaDrained("tok", "gemini-3-pro", null, "conn1");
      expect(second).toEqual(first);
      expect(fetchWithTimeoutMock.mock.calls.length).toBe(calls);
    });

    it("does not leak a summary between different tokens under the same connection", async () => {
      fetchWithTimeoutMock.mockResolvedValue(summaryResponse({ "Gemini Pro": [bucket(0.01)] }));
      await isAntigravityQuotaDrained("tokenA", "gemini-3-pro", null, "default");
      const calls = fetchWithTimeoutMock.mock.calls.length;
      await isAntigravityQuotaDrained("tokenB", "gemini-3-pro", null, "default");
      expect(fetchWithTimeoutMock.mock.calls.length).toBe(calls + 1);
    });

    it("fails open on network errors and non-ok responses", async () => {
      fetchWithTimeoutMock.mockRejectedValue(new Error("boom"));
      await expect(isAntigravityQuotaDrained("tok", "gemini-3-pro", null, "conn1")).resolves.toEqual({
        isDrained: false,
        resetTime: null,
      });
      fetchWithTimeoutMock.mockResolvedValue({ ok: false, status: 500 });
      await expect(isAntigravityQuotaDrained("tok", "gemini-3-pro", null, "conn1")).resolves.toEqual({
        isDrained: false,
        resetTime: null,
      });
    });

    it("normalizes an unparseable resetTime to null", async () => {
      fetchWithTimeoutMock.mockResolvedValue(
        summaryResponse({ "Gemini Pro": [{ window: "5h", remainingFraction: 0.01, resetTime: "garbage" }] })
      );
      const result = await isAntigravityQuotaDrained("tok", "gemini-3-pro", null, "conn1");
      expect(result.isDrained).toBe(true);
      expect(result.resetTime).toBeNull();
    });

    it("fails open without hitting the network when inputs are missing", async () => {
      await expect(isAntigravityQuotaDrained("", "gemini-3-pro")).resolves.toEqual({ isDrained: false, resetTime: null });
      await expect(isAntigravityQuotaDrained("tok", "")).resolves.toEqual({ isDrained: false, resetTime: null });
      expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    });
  });
});

describe("antigravityTlsClient", () => {
  let antigravityTlsFetch;

  beforeEach(async () => {
    vi.resetModules();
    zcodeTlsFetchMock.mockReset();
    ({ antigravityTlsFetch } = await import("../../open-sse/services/antigravityTlsClient.js"));
  });

  it("delegates to the shared wreq session client with the proxy hint", async () => {
    zcodeTlsFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const response = await antigravityTlsFetch(
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      { proxyUrl: "http://user:pass@127.0.0.1:10880" }
    );
    expect(response.status).toBe(200);
    expect(zcodeTlsFetchMock).toHaveBeenCalledWith(
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      { signal: undefined, proxy: "http://user:pass@127.0.0.1:10880" }
    );
  });

  it("rethrows instead of re-dispatching when the caller already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    zcodeTlsFetchMock.mockRejectedValue(new Error("aborted"));
    await expect(
      antigravityTlsFetch("https://x.test", { method: "POST", signal: ctrl.signal }, null)
    ).rejects.toThrow("aborted");
    expect(zcodeTlsFetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces errors on the proxied path so the executor retry logic sees them", async () => {
    zcodeTlsFetchMock.mockRejectedValue(new Error("tunnel down"));
    await expect(
      antigravityTlsFetch("https://x.test", { method: "POST" }, { proxyUrl: "http://p:1" })
    ).rejects.toThrow("tunnel down");
  });
});
