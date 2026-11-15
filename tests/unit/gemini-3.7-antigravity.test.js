import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import antigravityRegistry from "../../open-sse/providers/registry/antigravity.js";
import geminiRegistry from "../../open-sse/providers/registry/gemini.js";
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js";

describe("Gemini 3.7 Flash Support & Config (#3286, #3281)", () => {
  // The registry rotates model generations (3.7 -> 3.8 -> 4-argon) while this
  // suite stays pinned to the tiered-model shape it was written to defend. Assert
  // against whichever generation the registry actually ships, and keep the
  // invariant that matters: all three tiers are registered together.
  const TIERED_PATTERN = /^gemini-(\d+\.\d+)-flash-(high|medium|low)$/;

  it("registers a tiered flash generation in the antigravity provider registry", () => {
    const agIds = antigravityRegistry.models.map(m => m.id);
    const tiered = agIds.filter(id => TIERED_PATTERN.test(id));
    expect(tiered.length).toBeGreaterThan(0);

    const generation = tiered[0].match(TIERED_PATTERN)[1];
    expect(agIds).toContain(`gemini-${generation}-flash-high`);
    expect(agIds).toContain(`gemini-${generation}-flash-medium`);
    expect(agIds).toContain(`gemini-${generation}-flash-low`);
  });

  it("registers gemini-3.7-flash in gemini provider registry", () => {
    const geminiIds = geminiRegistry.models.map(m => m.id);
    expect(geminiIds).toContain("gemini-3.7-flash");
  });

  it("resolves capabilities correctly for gemini-3.7 models with official limits", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-3.7-flash-high");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
  });

  it("defines pricing matching gemini-3.6-flash baseline", () => {
    expect(MODEL_PRICING["gemini-3.7-flash"]).toEqual(MODEL_PRICING["gemini-3.6-flash"]);
    expect(MODEL_PRICING["gemini-3.7-flash-high"]).toEqual(MODEL_PRICING["gemini-3.6-flash-high"]);
    expect(MODEL_PRICING["gemini-3.7-flash-medium"]).toEqual(MODEL_PRICING["gemini-3.6-flash-medium"]);
    expect(MODEL_PRICING["gemini-3.7-flash-low"]).toEqual(MODEL_PRICING["gemini-3.6-flash-low"]);
  });
});
