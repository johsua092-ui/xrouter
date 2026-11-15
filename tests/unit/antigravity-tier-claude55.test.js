import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CARD = resolve(
  __dirname,
  "../../src/app/(dashboard)/dashboard/cli-tools/components/AntigravityToolCard.js",
);
const card = readFileSync(CARD, "utf8");
const registry = readFileSync(
  resolve(__dirname, "../../open-sse/providers/registry/antigravity.js"),
  "utf8",
);
const route = readFileSync(
  resolve(__dirname, "../../src/app/api/usage/antigravity-tier/route.js"),
  "utf8",
);
const helper = readFileSync(
  resolve(__dirname, "../../src/lib/usage/antigravityTier.js"),
  "utf8",
);

describe("Antigravity: Claude 5.5 tier gating", () => {
  it("does not advertise Claude 5.5, which the upstream tier does not serve", () => {
    // Verified against a live fetchAvailableModels: the catalogue returns
    // claude-opus-4-6-thinking and claude-sonnet-4-6 and no 5.5 id at all.
    // Advertising 5.5 produced a guaranteed 404 on every request for it, which
    // is indistinguishable from an identity rejection.
    expect(registry).not.toContain('id: "claude-sonnet-5-5"');
    expect(registry).not.toMatch(/id: "claude-(opus|sonnet)-5[-.]5/);
  });

  it("keeps the 4.6 models so existing traffic keeps working", () => {
    expect(registry).toContain('id: "claude-sonnet-4-6"');
    expect(registry).toContain('id: "claude-opus-4-6-thinking"');
  });

  it("recognises every 5.5 spelling in the card helper so legacy callers are gated", () => {
    // The card still has to understand 5.5 ids: clients on an older config will
    // keep sending them, and they must be routed to a working model instead of
    // silently 404ing.
    expect(card).toContain("const isClaude55");
    for (const id of [
      "claude-opus-5.5",
      "claude-opus-5.5-thinking",
      "claude-opus-5.5-agentic",
      "claude-sonnet-5-5",
      "claude-sonnet-5-5-thinking",
    ]) {
      expect(card).toContain(id.includes("opus") ? "opus[-_.]?5[-_.]?5" : "sonnet[-_.]?5[-_.]?5");
      expect(id).toMatch(/5[-_.]5|5\.5/);
    }
  });

  it("does not flag the 4.6 models as gated", () => {
    // the regex must require a 5.5 version token, so 4.6 stays neutral
    const re = /opus[-_.]?5[-_.]?5|sonnet[-_.]?5[-_.]?5/;
    expect(re.test("claude-opus-4-6-thinking")).toBe(false);
    expect(re.test("claude-sonnet-4-6")).toBe(false);
    expect(re.test("claude-opus-5.5")).toBe(true);
  });

  it("paints the row red only when the probe says the tier is blocked", () => {
    expect(card).toContain("claude55Blocked");
    // Design-token class, not a raw palette value: the app themes through
    // --color-danger, and text-red-500 is not a defined utility in this build.
    expect(card).toContain("text-danger");
    expect(card).toContain("/api/usage/antigravity-tier");
    // the probe must gate on the live answer, never on a hardcoded true
    expect(card).toContain("t.canUseClaude55 === false");
  });

  it("treats a failed probe as blocked rather than claiming access", () => {
    expect(helper).toContain("canUseClaude55: false");
    expect(route).toContain("canUseClaude55: false");
  });

  it("derives access from the live catalog, not from the tier id alone", () => {
    // tier ids are undocumented and have changed; the catalog is the ground truth
    expect(helper).toContain("fetchAvailableModels");
    expect(helper).toContain("catalogHasClaude55");
    expect(helper).toMatch(/canUseClaude55\s*=\s*catalogHasClaude55\s*\|\|/);
  });

  it("caches the probe so the card does not hit Google on every render", () => {
    expect(helper).toContain("CACHE_TTL_MS");
    expect(route).toContain('"Cache-Control": "no-store"');
  });
});
