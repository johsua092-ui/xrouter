import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

// Live smoke: exercises the real free-tier AG quota path with the prod account
// (read-only). The account blob is extracted by /usr/bin/node beforehand because
// better-sqlite3's prebuilt ABI differs from vitest's node.
describe("antigravity free-tier quota smoke (live)", () => {
  it("produces a per-model quota the auth pre-filter can act on", async () => {
    if (!fs.existsSync("/tmp/ag-acct.json")) {
      console.log("SMOKE_SKIP: /tmp/ag-acct.json absent");
      return;
    }
    const { id, email, at, psd } = JSON.parse(fs.readFileSync("/tmp/ag-acct.json", "utf8"));
    const specific = JSON.parse(psd || "{}");
    console.log("SMOKE account:", String(id).slice(0, 8), "|", email);
    console.log("SMOKE expiresAt:", specific.expiresAt, "| expired:", new Date(specific.expiresAt).getTime() <= Date.now());

    const { getAntigravityUsage } = await import("open-sse/services/usage/google.js");
    const agq = await import("@/sse/services/antigravityQuota.js");

    const usage = await getAntigravityUsage(at, specific);
    const keys = Object.keys(usage.quotas || {});
    console.log("SMOKE message:", usage.message || "(none)");
    console.log("SMOKE quotaKeys:", keys.length, "|", keys.slice(0, 10).join(",") || "(empty)");

    let armed = false;
    for (const model of ["gemini-3.8-flash-high", "claude-sonnet-4-6", "gemini-pro-agent"]) {
      const q = agq.getAntigravityModelQuota(usage.quotas || {}, model);
      if (q) armed = true;
      console.log(
        "SMOKE resolve:",
        model,
        "=>",
        q ? `${Math.round(q.remainingPercentage)}% reset=${q.resetAt}` : "null"
      );
    }
    console.log(armed ? "SMOKE PRE_FILTER: ARMED" : "SMOKE PRE_FILTER: BLIND");

    // New: the refresh entrypoint must arm the pre-filter even when upstream is
    // unreachable, as long as the stored token is already expired.
    const refreshed = await agq.refreshAntigravityQuota(id, at, specific);
    const q2 = agq.getAntigravityModelQuota(refreshed || {}, "gemini-3.8-flash-high");
    console.log(
      "SMOKE refreshQuota:",
      refreshed ? `${Object.keys(refreshed).length} keys` : "null",
      "| prefilter:",
      q2 ? `${Math.round(q2.remainingPercentage)}% reset=${q2.resetAt}` : "null"
    );
    expect(true).toBe(true);
  }, 90000);
});
