import { describe, it, expect } from "vitest";
import { getVirtualDeviceProfile, sanitizeLogOutput } from "../../open-sse/services/virtualDevice.js";
import { ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS, LOAD_CODE_ASSIST_METADATA } from "../../open-sse/config/appConstants.js";
import { ANTIGRAVITY_IDE_VERSION, ANTIGRAVITY_IDE_USER_AGENT } from "../../open-sse/providers/shared.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

describe("Antigravity-Shield Native Protections", () => {
  describe("Pillar 1: Virtual Device Profile Isolation", () => {
    it("generates deterministic 64-hex machineId and RFC UUID v4 per connection", () => {
      const profile1 = getVirtualDeviceProfile("conn-acc-1");
      const profile2 = getVirtualDeviceProfile("conn-acc-1");
      const profile3 = getVirtualDeviceProfile("conn-acc-2");

      expect(profile1.machineId).toHaveLength(64);
      expect(profile1.deviceUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      // Deterministic for same connection
      expect(profile1.machineId).toBe(profile2.machineId);
      expect(profile1.deviceUuid).toBe(profile2.deviceUuid);

      // Isolated and distinct for different connections
      expect(profile1.machineId).not.toBe(profile3.machineId);
      expect(profile1.deviceUuid).not.toBe(profile3.deviceUuid);
    });

    it("sanitizes authorization tokens and client secrets in logs", () => {
      const raw = "Error: ya29.a0AfH6SMDI8329-test Bearer test_token_xyz GOCSPX-abc123456789";
      const sanitized = sanitizeLogOutput(raw);
      expect(sanitized).not.toContain("ya29.a0AfH6SMDI8329-test");
      expect(sanitized).not.toContain("Bearer test_token_xyz");
      expect(sanitized).not.toContain("GOCSPX-abc123456789");
      expect(sanitized).toContain("ya29.***REDACTED***");
      expect(sanitized).toContain("Bearer ***REDACTED***");
      expect(sanitized).toContain("GOCSPX-***REDACTED***");
    });
  });

  describe("Pillar 2: Client Metadata & Version Consistency", () => {
    it("pins loadCodeAssist headers to latest ANTIGRAVITY_IDE_VERSION and User-Agent", () => {
      expect(ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS["User-Agent"]).toBe(ANTIGRAVITY_IDE_USER_AGENT);
      expect(ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS["User-Agent"]).not.toContain("1.107.0");

      const clientMeta = JSON.parse(ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS["Client-Metadata"]);
      expect(clientMeta.ideType).toBe("ANTIGRAVITY");
      expect(clientMeta.ideName).toBe("antigravity");
      expect(clientMeta.ideVersion).toBe(ANTIGRAVITY_IDE_VERSION);

      expect(LOAD_CODE_ASSIST_METADATA.ideVersion).toBe(ANTIGRAVITY_IDE_VERSION);
      expect(LOAD_CODE_ASSIST_METADATA.ideName).toBe("antigravity");
    });
  });

  describe("Pillar 3: Canonical Project ID & Legacy Project Sanitization", () => {
    const ag = new AntigravityExecutor();

    it("generates canonical Google format cloudaicompanion-proj-* instead of random adjective-noun", () => {
      const pid = ag.generateProjectId({ connectionId: "conn-12345" });
      expect(pid).toMatch(/^cloudaicompanion-proj-[0-9a-f]{16}$/);
      expect(pid).not.toMatch(/^(useful|bright|swift|calm|bold)-/);
    });

    it("sanitizes legacy random fake project IDs during transformRequest", () => {
      const out = ag.transformRequest("gemini-2.5-flash", {
        request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] }
      }, true, { connectionId: "conn-12345", projectId: "useful-spark-a1b2c" });

      expect(out.project).toMatch(/^cloudaicompanion-proj-[0-9a-f]{16}$/);
      expect(out.project).not.toBe("useful-spark-a1b2c");
    });

    it("preserves authentic provisioned project IDs", () => {
      const realPid = "cloudaicompanion-proj-real-user-123";
      const out = ag.transformRequest("gemini-2.5-flash", {
        request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] }
      }, true, { connectionId: "conn-12345", projectId: realPid });

      expect(out.project).toBe(realPid);
    });
  });

  describe("Pillar 4: Staged Multi-Host Failover on 403 & Error Classification", () => {
    const ag = new AntigravityExecutor();

    it("allows fallback from daily staging endpoint (urlIndex 0) to production endpoint (urlIndex 1) on 403", () => {
      expect(ag.shouldRetry(403, 0)).toBe(true);
    });

    it("vetoes further retry when production endpoint (urlIndex 1) also returns 403", () => {
      expect(ag.shouldRetry(403, 1)).toBe(false);
    });

    it("classifies Google quota exhaustion returned as 403 into QUOTA_EXHAUSTED cooldown", () => {
      const mockRes = { status: 403 };
      const parsed = ag.parseError(mockRes, JSON.stringify({
        error: { message: "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'GenerateContent requests'" }
      }));

      expect(parsed.code).toBe("QUOTA_EXHAUSTED");
      expect(parsed.resetsAtMs).toBeGreaterThan(Date.now());
      expect(parsed.message).toContain("quota exceeded");
    });
  });
});
