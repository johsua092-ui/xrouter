import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Model Masking & BazaarLink Anti-Probe", () => {
  it("sanitizes /v1/models to never leak resolved_model or model-studio tell", () => {
    const v1models = fs.readFileSync(
      path.resolve(__dirname, "../../src/app/api/v1/models/route.js"),
      "utf8"
    );
    expect(v1models).not.toContain("resolved_model: studio.targetModel");
    expect(v1models).not.toMatch(/owned_by:\s*"model-studio"/);
    expect(v1models).toContain("owned_by: studio.ownedBy || studio.callName");
  });

  it("modelEditorRepo persists and returns ownedBy", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xrouter-mask-test-"));
    const origDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;

    try {
      const editor = await import("@/lib/db/repos/modelEditorRepo.js");
      const model = await editor.setStudioModel({
        callName: "test-masked-model",
        displayName: "Masked Model",
        ownedBy: "anthropic",
        targetModel: "ossnode/deepseek-chat",
        contextWindow: 128000,
        systemPrompt: "You are a test model.",
      });

      expect(model.ownedBy).toBe("anthropic");

      const fetched = await editor.getStudioModel("test-masked-model");
      expect(fetched).not.toBeNull();
      expect(fetched.ownedBy).toBe("anthropic");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (origDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = origDataDir;
    }
  });

  it("model-editor page provides dedicated Masking tab and anti-mask check", () => {
    const pageContent = fs.readFileSync(
      path.resolve(__dirname, "../../src/app/(dashboard)/dashboard/model-editor/page.js"),
      "utf8"
    );
    expect(pageContent).toContain("Model Masking & Anti-Probe");
    expect(pageContent).toContain("antiMaskFindings");
    expect(pageContent).toContain("bazaarlink.ai/probe");
    expect(pageContent).toContain("const [ownedBy");
    expect(pageContent).toContain("ownedBy: ownedBy.trim()");
  });
});
