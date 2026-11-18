/**
 * Antigravity IDE version override — normalized to decolua/9router behavior.
 *
 * Rewrites identity only on generation endpoints (:generateContent / :streamGenerateContent).
 * Non-chat endpoints (:loadCodeAssist, :onboardUser, :fetchAvailableModels, :retrieveUserQuotaSummary)
 * are left untouched so that IDE onboarding and Google protobuf schema checks pass cleanly.
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

describe("Antigravity IDE version override (normalized to decolua)", () => {
  it("leaves model catalogue and onboarding endpoints untouched for native passthrough", () => {
    const { bodyBuffer, headers } = makeRequest();

    const resultModels = applyAntigravityIdeVersionOverride(bodyBuffer, headers, "/v1internal:fetchAvailableModels");
    expect(resultModels.applied).toBe(false);

    const resultOnboard = applyAntigravityIdeVersionOverride(bodyBuffer, headers, "/v1internal:loadCodeAssist");
    expect(resultOnboard.applied).toBe(false);
  });

  it.each([":generateContent", ":streamGenerateContent"])(
    "rewrites identity for %s requests when metadata is present",
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

  it("does not inject metadata into payloads that do not have it (prevents protobuf schema rejection)", () => {
    const bodyBuffer = Buffer.from(JSON.stringify({ contents: [] }));
    const headers = {
      "content-type": "application/json",
      "content-length": String(bodyBuffer.length),
      "user-agent": `antigravity/${CALLER_VERSION}`,
    };

    const result = applyAntigravityIdeVersionOverride(
      bodyBuffer,
      headers,
      "/v1internal/models/gemini-3.7-flash-tiered:generateContent"
    );

    const parsed = JSON.parse(result.bodyBuffer.toString());
    expect(parsed.metadata).toBeUndefined();
  });

  it("advertises the full catalogue a higher-tier plan can serve", () => {
    const ids = REGISTRY.models.map((m) => m.id);
    expect(ids).toContain("gemini-4-argon-medium");
    expect(ids.filter((id) => /5-5/.test(id)).length).toBeGreaterThan(0);
  });
});
