/**
 * Antigravity identity spoofing — regression tests.
 *
 * These cover the four ways the rewrite used to let a request reach the
 * Antigravity backend without the identity that backend fingerprints. All four
 * were verified live against daily-cloudcode-pa.googleapis.com:
 *
 *   UA antigravity/hub/2.32.1  → accepted
 *   UA antigravity/hub/1.0.0   → 404 "Requested entity was not found"
 *   UA curl/8.0 (non-AG)       → 403 "You do not have a valid license"
 *   mismatched identity on code-assist endpoints → silent tier downgrade
 *      (ineligibleTiers: [{ reasonCode: "UNSUPPORTED_CLIENT" }])
 *
 * The module under test is CommonJS; tests/ is an ESM package, so it is pulled
 * in through createRequire.
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
  // The identity must be applied to the whole Cloud Code Assist surface, not
  // just generation: onboarding is where the silent tier downgrade happens.
  it("covers onboarding", () => {
    expect(isAntigravityIdentityUrl("https://x/v1internal:loadCodeAssist")).toBe(true);
    expect(isAntigravityIdentityUrl("https://x/v1internal:onboardUser")).toBe(true);
  });

  it("covers catalogue and quota", () => {
    expect(isAntigravityIdentityUrl("https://x/v1internal:fetchAvailableModels")).toBe(true);
    expect(isAntigravityIdentityUrl("https://x/v1internal:retrieveUserQuotaSummary")).toBe(true);
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
  // A non-Antigravity UA earns 403 "no valid license". The old rewrite only
  // touched a UA that already contained `antigravity/`, so a third-party client
  // was forwarded verbatim — the exact case the rewrite exists to repair.
  it("forces a non-Antigravity UA to the pinned identity", () => {
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
    // Regression: /antigravity\/([^\s]+)/ captured "hub/1.0.0" from
    // "antigravity/hub/1.0.0 linux/x64" and re-emitted it as the platform,
    // producing "antigravity/hub/2.32.1 hub/1.0.0".
    expect(rewriteAntigravityUserAgent("antigravity/hub/1.0.0 linux/x64")).toBe("antigravity/hub/2.32.1 linux/x64");
    expect(rewriteAntigravityUserAgent("antigravity/hub/1.0.0 win32/x64")).toBe("antigravity/hub/2.32.1 win32/x64");
    expect(rewriteAntigravityUserAgent("antigravity/hub/1.0.0 darwin/arm64")).toBe("antigravity/hub/2.32.1 darwin/arm64");
  });
});

describe("antigravity identity — metadata stamping", () => {
  // `shouldRewriteMetadata` used to return false when the body carried no
  // metadata — the precise signature of a third-party client — leaving it
  // unstamped. The identity is now applied unconditionally.
  it("overwrites metadata naming another IDE", () => {
    const body = Buffer.from(JSON.stringify({ metadata: { ideName: "other", ideType: "X" } }));
    const res = applyAntigravityIdeVersionOverride(body, { "user-agent": "curl/8.0" }, AG_URL);
    const parsed = JSON.parse(res.bodyBuffer.toString());
    expect(parsed.metadata.ideVersion).toBe(ANTIGRAVITY_IDE_VERSION);
    expect(parsed.metadata.ideName).toBe("antigravity");
    expect(res.applied).toBe(true);
  });

  it("creates metadata when absent", () => {
    const body = Buffer.from(JSON.stringify({ contents: [] }));
    const res = applyAntigravityIdeVersionOverride(body, {}, AG_URL);
    expect(JSON.parse(res.bodyBuffer.toString()).metadata.ideVersion).toBe(ANTIGRAVITY_IDE_VERSION);
  });

  it("stamps nested request.metadata too", () => {
    const body = Buffer.from(JSON.stringify({ request: { contents: [] } }));
    const res = applyAntigravityIdeVersionOverride(body, {}, AG_URL);
    expect(JSON.parse(res.bodyBuffer.toString()).request.metadata.ideVersion).toBe(ANTIGRAVITY_IDE_VERSION);
  });

  it("survives a non-JSON body and still rewrites the UA", () => {
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
  // An alias that resolves to a model the upstream does not serve is worse than
  // an absent one: it succeeds locally and 404s upstream, which reads as an
  // identity failure rather than a dead model.
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
    // Restored with the catalogue. These ids were pruned on a free-tier
    // sample; a Pro/Ultra plan serves them, so they are advertised again.
    const registry = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    const ids = registry.models.map((m) => m.id);
    expect(ids.filter((id) => /5-5|5\.5/.test(id)).length).toBeGreaterThan(0);
    expect(ids.filter((id) => /3\.[67]-flash/.test(id)).length).toBeGreaterThan(0);
  });
});
