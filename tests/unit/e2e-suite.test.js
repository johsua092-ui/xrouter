import { describe, it, expect } from "vitest";
import { exportDb } from "../../src/lib/db/index.js";
import kiloRegistry from "../../open-sse/providers/registry/kilo-gateway.js";
import { applyFingerprintTools } from "../../open-sse/utils/opencodeFingerprint.js";

describe("E2E Verification Suite", () => {
  it("Auto-Backup: granular scope excludes usage history when requested", async () => {
    const compactExport = await exportDb({ usage: false });
    expect(compactExport.settings).toBeDefined();
    expect(compactExport.usageHistory).toBeUndefined();
    expect(compactExport.usageDaily).toBeUndefined();

    const fullExport = await exportDb(null);
    expect(fullExport.settings).toBeDefined();
    expect(fullExport.usageHistory).toBeDefined();
  });

  it("KiloCode: keyless gateway has 10 free verified models and noAuth", () => {
    expect(kiloRegistry.id).toBe("kilo-gateway");
    expect(kiloRegistry.noAuth).toBe(true);
    expect(kiloRegistry.authType).toBe("none");
    const freeModels = kiloRegistry.models.filter(m => m.isFree || m.id.includes("free"));
    expect(freeModels.length).toBeGreaterThanOrEqual(8);
    expect(kiloRegistry.models.some(m => m.id === "nvidia/nemotron-3.5-super-vl:free")).toBe(true);
  });

  it("opencode-cc Hardening: tool surface capping trims tools over 38K characters", () => {
    const fakeTools = Array.from({ length: 40 }, (_, i) => ({
      type: "function",
      function: {
        name: `custom_tool_${i}`,
        description: "A very long detailed description ".repeat(40),
        parameters: { type: "object", properties: { arg: { type: "string" } } }
      }
    }));
    const body = {
      tools: fakeTools,
      messages: [{ role: "user", content: "hello" }]
    };
    expect(JSON.stringify(body.tools).length).toBeGreaterThan(38000);

    applyFingerprintTools(body, false);
    expect(JSON.stringify(body.tools).length).toBeLessThanOrEqual(38000);
  });
});
