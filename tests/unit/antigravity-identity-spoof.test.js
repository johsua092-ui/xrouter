/**
 * Antigravity identity spoofing — normalized to decolua/9router regression tests.
 *
 * Covers generation endpoints while leaving onboarding/catalogue untouched
 * to prevent Google Protobuf schema rejection.
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  applyAntigravityIdeVersionOverride,
  isAntigravityIdentityUrl,
  rewriteAntigravityUserAgent,
  ANTIGRAVITY_IDE_VERSION,
} = require("../../src/mitm/antigravityIdeVersion.js");

const AG_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent";
const AG_UA_PREFIX = `antigravity/hub/${ANTIGRAVITY_IDE_VERSION}`;

describe("antigravity identity — URL scope", () => {
  it("keeps onboarding endpoints for untouched native passthrough", () => {
    expect(isAntigravityIdentityUrl("https://x/v1internal:loadCodeAssist")).toBe(false);
    expect(isAntigravityIdentityUrl("https://x/v1internal:onboardUser")).toBe(false);
  });

  it("keeps catalogue and quota untouched for native passthrough", () => {
    expect(isAntigravityIdentityUrl("https://x/v1internal:fetchAvailableModels")).toBe(false);
    expect(isAntigravityIdentityUrl("https://x/v1internal:retrieveUserQuotaSummary")).toBe(false);
  });

  it("covers generation, streaming included", () => {
    expect(isAntigravityIdentityUrl("https://x/v1internal:generateContent")).toBe(true);
    expect(isAntigravityIdentityUrl("https://x/v1internal:streamGenerateContent?alt=sse")).toBe(true);
  });

  it("leaves telemetry out of scope", () => {
    expect(isAntigravityIdentityUrl("https://x/recordCodeAssistMetrics")).toBe(false);
    expect(isAntigravityIdentityUrl("https://x/recordTrajectoryAnalytics")).toBe(false);
  });
});

describe("antigravity identity — User-Agent", () => {
  it("forces a non-Antigravity UA to the pinned identity on generation", () => {
    expect(rewriteAntigravityUserAgent("curl/8.0").startsWith(AG_UA_PREFIX)).toBe(true);
    expect(rewriteAntigravityUserAgent("Mozilla/5.0").startsWith(AG_UA_PREFIX)).toBe(true);
  });

  it("fills in a missing UA", () => {
    expect(rewriteAntigravityUserAgent(undefined).startsWith(AG_UA_PREFIX)).toBe(true);
    expect(rewriteAntigravityUserAgent("").startsWith(AG_UA_PREFIX)).toBe(true);
  });

  it("repins a stale version", () => {
    expect(rewriteAntigravityUserAgent("antigravity/hub/1.0.0 linux/x64")).toContain(ANTIGRAVITY_IDE_VERSION);
  });

  it("preserves the caller platform without mistaking the version for it", () => {
    expect(rewriteAntigravityUserAgent("antigravity/hub/1.0.0 linux/x64")).toBe("antigravity/hub/2.32.1 linux/x64");
    expect(rewriteAntigravityUserAgent("antigravity/hub/1.0.0 win32/x64")).toBe("antigravity/hub/2.32.1 win32/x64");
    expect(rewriteAntigravityUserAgent("antigravity/hub/1.0.0 darwin/arm64")).toBe("antigravity/hub/2.32.1 darwin/arm64");
  });
});

describe("antigravity identity — metadata stamping", () => {
  it("overwrites metadata naming another IDE when metadata exists", () => {
    const body = Buffer.from(JSON.stringify({ metadata: { ideName: "other", ideType: "X" } }));
    const res = applyAntigravityIdeVersionOverride(body, { "user-agent": "curl/8.0" }, AG_URL);
    const parsed = JSON.parse(res.bodyBuffer.toString());
    expect(parsed.metadata.ideVersion).toBe(ANTIGRAVITY_IDE_VERSION);
    expect(parsed.metadata.ideName).toBe("antigravity");
    expect(res.applied).toBe(true);
  });

  it("does not inject metadata when absent (protects against Unknown name 'metadata' protobuf error)", () => {
    const body = Buffer.from(JSON.stringify({ contents: [] }));
    const res = applyAntigravityIdeVersionOverride(body, {}, AG_URL);
    const parsed = JSON.parse(res.bodyBuffer.toString());
    expect(parsed.metadata).toBeUndefined();
  });

  it("stamps nested request.metadata when already present", () => {
    const body = Buffer.from(JSON.stringify({ request: { metadata: { ideVersion: "1.0.0" }, contents: [] } }));
    const res = applyAntigravityIdeVersionOverride(body, {}, AG_URL);
    expect(JSON.parse(res.bodyBuffer.toString()).request.metadata.ideVersion).toBe(ANTIGRAVITY_IDE_VERSION);
  });

  it("survives a non-JSON body and still rewrites the UA on generation endpoints", () => {
    const res = applyAntigravityIdeVersionOverride(Buffer.from("<not json>"), { "user-agent": "curl" }, AG_URL);
    expect(res.headers["user-agent"]).toContain(AG_UA_PREFIX);
  });

  it("leaves out-of-scope URLs untouched", () => {
    const res = applyAntigravityIdeVersionOverride(
      Buffer.from("{}"),
      { "user-agent": "curl" },
      "https://x/recordCodeAssistMetrics"
    );
    expect(res.applied).toBe(false);
    expect(res.headers["user-agent"]).toBe("curl");
  });

  it("rewrites a mixed-case User-Agent header in place", () => {
    const res = applyAntigravityIdeVersionOverride(Buffer.from("{}"), { "User-Agent": "curl/8.0" }, AG_URL);
    expect(res.headers["User-Agent"]).toContain(ANTIGRAVITY_IDE_VERSION);
  });
});

describe("antigravity model catalogue — no dead aliases", () => {
  it("every synonym target exists in the registry", async () => {
    const { MODEL_SYNONYMS, MODEL_PATTERNS } = require("../../src/mitm/config.js");
    const registry = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    const ids = new Set(registry.models.map((m) => m.id));

    const badSynonyms = Object.entries(MODEL_SYNONYMS.antigravity)
      .filter(([, v]) => !ids.has(v))
      .map(([k, v]) => `${k} -> ${v}`);
    const badPatterns = MODEL_PATTERNS.antigravity
      .filter((p) => !ids.has(p.alias))
      .map((p) => `${String(p.match)} -> ${p.alias}`);

    expect(badSynonyms).toEqual([]);
    expect(badPatterns).toEqual([]);
  });

  it("carries the full claude 5.5 and gemini 3.6/3.7 families again", async () => {
    const registry = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    const ids = registry.models.map((m) => m.id);
    expect(ids.filter((id) => /5-5|5\.5/.test(id)).length).toBeGreaterThan(0);
    expect(ids.filter((id) => /3\.[67]-flash/.test(id)).length).toBeGreaterThan(0);
  });
});
