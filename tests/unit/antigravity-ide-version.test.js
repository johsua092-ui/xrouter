/**
 * Antigravity IDE version override — identity rewrite on the Cloud Code Assist surface.
 *
 * The rewrite applies to the whole `v1internal:` surface, not only generation:
 * the live backend fingerprints the caller on onboarding and catalogue calls too,
 * and the failure there is a silent tier downgrade rather than an error:
 *
 *   UA antigravity/hub/2.32.1  → currentTier: free-tier
 *   UA curl/8.0                → ineligibleTiers: [{ reasonCode: "UNSUPPORTED_CLIENT" }]
 *
 * Every request on the surface therefore gets the pinned identity whether or not
 * the caller supplied one, and a caller whose identity talks about another IDE is
 * corrected rather than trusted.
 */

import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  ANTIGRAVITY_IDE_VERSION,
  ANTIGRAVITY_IDE_NAME,
  applyAntigravityIdeVersionOverride,
} = require("../../src/mitm/antigravityIdeVersion.js");
const REGISTRY = require("../../open-sse/providers/registry/antigravity.js").default;

const CALLER_VERSION = "2.11.0";
const IDE_UA = `antigravity/hub/${ANTIGRAVITY_IDE_VERSION} linux/x64`;

function makeRequest(metadata = { ideName: "antigravity", ideVersion: CALLER_VERSION }) {
  const bodyBuffer = Buffer.from(JSON.stringify({ metadata, request: { contents: [] } }));
  const headers = {
    "content-type": "application/json",
    "content-length": String(bodyBuffer.length),
    "user-agent": `antigravity/${CALLER_VERSION}`,
  };
  return { bodyBuffer, headers };
}

describe("Antigravity IDE version override", () => {
  it("rewrites identity on the model catalogue", () => {
    const { bodyBuffer, headers } = makeRequest();

    const result = applyAntigravityIdeVersionOverride(bodyBuffer, headers, "/v1internal:fetchAvailableModels");

    expect(result.applied).toBe(true);
    expect(result.headers["user-agent"]).toBe(IDE_UA);
    expect(JSON.parse(result.bodyBuffer.toString()).metadata.ideVersion).toBe(ANTIGRAVITY_IDE_VERSION);
    expect(result.headers["content-length"]).toBe(String(result.bodyBuffer.length));
  });

  it.each([":generateContent", ":streamGenerateContent"])(
    "rewrites identity for %s requests",
    (endpoint) => {
      const { bodyBuffer, headers } = makeRequest();

      const result = applyAntigravityIdeVersionOverride(
        bodyBuffer,
        headers,
        `/v1internal/models/gemini-3.7-flash-tiered${endpoint}`
      );

      expect(result.applied).toBe(true);
      expect(result.bodyBuffer).not.toBe(bodyBuffer);
      expect(result.headers["user-agent"]).toBe(IDE_UA);
      expect(JSON.parse(result.bodyBuffer.toString()).metadata.ideVersion).toBe(ANTIGRAVITY_IDE_VERSION);
    }
  );

  it("keeps a malformed non-JSON body byte-for-byte while correcting the UA", () => {
    // The body is left alone — it cannot be stamped — but a non-Antigravity UA
    // would earn a 403 "no valid license" on this endpoint, so it is corrected.
    const bodyBuffer = Buffer.from([0xff, 0x00, 0x7b, 0x6e, 0x6f, 0x74, 0x2d, 0x6a, 0x73, 0x6f, 0x6e]);
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(bodyBuffer.length),
      "user-agent": `antigravity/${CALLER_VERSION}`,
    };

    const result = applyAntigravityIdeVersionOverride(bodyBuffer, headers, "/v1internal:loadCodeAssist");

    expect(result.bodyBuffer).toBe(bodyBuffer);
    expect(result.headers["content-length"]).toBe(String(bodyBuffer.length));
    expect(result.headers["user-agent"]).toBe(IDE_UA);
  });

  it("synthesizes the identity a third-party caller cannot supply", () => {
    // A client that is not the Antigravity IDE has no identity to present on
    // onboarding, which is exactly the caller this rewrite serves: leaving the
    // body untouched gets the account silently downgraded to UNSUPPORTED_CLIENT.
    const bodyBuffer = Buffer.from(JSON.stringify({ metadata: {}, request: { contents: [] } }));
    const headers = { "content-type": "application/json", "content-length": String(bodyBuffer.length) };

    const result = applyAntigravityIdeVersionOverride(
      bodyBuffer,
      headers,
      "/v1internal/models/gemini-3.7-flash-tiered:generateContent"
    );

    expect(result.applied).toBe(true);
    const parsed = JSON.parse(result.bodyBuffer.toString());
    expect(parsed.metadata.ideVersion).toBe(ANTIGRAVITY_IDE_VERSION);
    expect(parsed.metadata.ideName).toBe(ANTIGRAVITY_IDE_NAME);
    expect(result.headers["user-agent"]).toBe(IDE_UA);
  });

  it("leaves the model catalogue advertising only live models", () => {
    // A model the upstream answers with 404 "Requested entity was not found" is
    // worse than an absent one — the error reads as an identity rejection.
    const ids = REGISTRY.models.map((m) => m.id);
    expect(ids).not.toContain("gemini-4-argon-medium");
    expect(ids.some((id) => /^gemini-4-argon/.test(id))).toBe(true);
    expect(ids.filter((id) => /5-5/.test(id))).toEqual([]);
  });
});
