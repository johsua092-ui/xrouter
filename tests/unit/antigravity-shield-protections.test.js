import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getVirtualDeviceProfile, sanitizeLogOutput } from "../../open-sse/services/virtualDevice.js";
import { ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS, LOAD_CODE_ASSIST_METADATA } from "../../open-sse/config/appConstants.js";
import { ANTIGRAVITY_IDE_VERSION, ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_IDE_BASE_URL } from "../../open-sse/providers/shared.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

describe("Antigravity-Shield Safe Architecture & Protections", () => {
  describe("Pillar 1: Virtual Device Profile Isolation", () => {
    it("generates deterministic 64-hex machineId and RFC UUID v4 per connection", () => {
      const profile1 = getVirtualDeviceProfile("conn-acc-1");
      const profile2 = getVirtualDeviceProfile("conn-acc-1");
      const profile3 = getVirtualDeviceProfile("conn-acc-2");

      assert.equal(profile1.machineId.length, 64);
      assert.match(profile1.deviceUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      // Deterministic for same connection
      assert.equal(profile1.machineId, profile2.machineId);
      assert.equal(profile1.deviceUuid, profile2.deviceUuid);

      // Isolated and distinct for different connections
      assert.notEqual(profile1.machineId, profile3.machineId);
      assert.notEqual(profile1.deviceUuid, profile3.deviceUuid);
    });

    it("sanitizes authorization tokens and client secrets in logs", () => {
      const raw = "Error: ya29.a0AfH6SMDI8329-test Bearer test_token_xyz GOCSPX-abc123456789";
      const sanitized = sanitizeLogOutput(raw);
      assert.ok(!sanitized.includes("ya29.a0AfH6SMDI8329-test"));
      assert.ok(!sanitized.includes("Bearer test_token_xyz"));
      assert.ok(!sanitized.includes("GOCSPX-abc123456789"));
      assert.ok(sanitized.includes("ya29.***REDACTED***"));
      assert.ok(sanitized.includes("Bearer ***REDACTED***"));
      assert.ok(sanitized.includes("GOCSPX-***REDACTED***"));
    });
  });

  describe("Pillar 2: Client Metadata & Production URL Consistency", () => {
    it("pins base URL to production cloudcode-pa and not daily staging", () => {
      assert.equal(ANTIGRAVITY_IDE_BASE_URL, "https://cloudcode-pa.googleapis.com");
      assert.ok(!ANTIGRAVITY_IDE_BASE_URL.includes("daily-cloudcode-pa"));
    });

    it("pins loadCodeAssist headers to latest ANTIGRAVITY_IDE_VERSION and User-Agent", () => {
      assert.equal(ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS["User-Agent"], ANTIGRAVITY_IDE_USER_AGENT);

      const clientMeta = JSON.parse(ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS["Client-Metadata"]);
      assert.equal(clientMeta.ideType, "ANTIGRAVITY");
      assert.equal(clientMeta.ideName, "antigravity");
      assert.equal(clientMeta.ideVersion, ANTIGRAVITY_IDE_VERSION);

      assert.equal(LOAD_CODE_ASSIST_METADATA.ideVersion, ANTIGRAVITY_IDE_VERSION);
      assert.equal(LOAD_CODE_ASSIST_METADATA.ideName, "antigravity");
    });
  });

  describe("Pillar 3: Canonical Project ID (aicode-consumers) & Legacy Sanitization", () => {
    const ag = new AntigravityExecutor();

    it("generates canonical Google format aicode-consumers for consumer accounts", () => {
      const pid = ag.generateProjectId({ connectionId: "conn-12345" });
      assert.equal(pid, "aicode-consumers");
    });

    it("sanitizes legacy random fake project IDs during transformRequest to canonical aicode-consumers", () => {
      const out = ag.transformRequest("gemini-2.5-flash", {
        request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] }
      }, true, { connectionId: "conn-12345", projectId: "useful-spark-a1b2c" });

      assert.equal(out.project, "aicode-consumers");
    });

    it("preserves authentic provisioned GCP project IDs", () => {
      const realPid = "my-gcp-production-project-123";
      const out = ag.transformRequest("gemini-2.5-flash", {
        request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] }
      }, true, { connectionId: "conn-12345", projectId: realPid });

      assert.equal(out.project, realPid);
    });
  });

  describe("Pillar 4: Safe Error Classification (No 403 retries, TOS detection)", () => {
    const ag = new AntigravityExecutor();

    it("vetoes retry on 403 to prevent abuse loops", () => {
      assert.equal(ag.shouldRetry(403, 0), false);
      assert.equal(ag.shouldRetry(403, 1), false);
    });

    it("classifies TOS_VIOLATION with actionable appeal instruction", () => {
      const mockRes = { status: 403 };
      const parsed = ag.parseError(mockRes, JSON.stringify({
        error: {
          code: 403,
          message: "This service has been disabled in this account for violation of Terms of Service.",
          details: [{ reason: "TOS_VIOLATION" }]
        }
      }));

      assert.equal(parsed.code, "TOS_VIOLATION");
      assert.ok(parsed.message.includes("Terms of Service"));
      assert.ok(parsed.message.includes("https://forms.gle/hGzM9MEUv2azZsrb9"));
    });

    it("classifies Google quota exhaustion returned as 403 into QUOTA_EXHAUSTED cooldown", () => {
      const mockRes = { status: 403 };
      const parsed = ag.parseError(mockRes, JSON.stringify({
        error: { message: "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'GenerateContent requests'" }
      }));

      assert.equal(parsed.code, "QUOTA_EXHAUSTED");
      assert.ok(parsed.resetsAtMs > Date.now());
      assert.ok(parsed.message.includes("quota exceeded"));
    });
  });
});
