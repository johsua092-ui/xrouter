import test from "node:test";
import assert from "node:assert/strict";
import { classify429, decide429, FULL_QUOTA_COOLDOWN_MS, CAPACITY_COOLDOWN_MS, TRANSIENT_429_COOLDOWN_MS } from "../../open-sse/services/antigravity429Engine.js";
import { normalizeAntigravitySystemInstruction, AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { ANTIGRAVITY_PROMPT_REWRITES } from "../../open-sse/config/appConstants.js";

test("Antigravity 429 classification & cooldown resilience", () => {
  // 1. Explicit quota exhaustion gets full cooldown (5 hours)
  const quotaErr1 = classify429("QUOTA_EXHAUSTED: daily quota exceeded");
  assert.equal(quotaErr1.kind, "quota_exhausted");
  assert.equal(decide429(quotaErr1).retryAfterMs, FULL_QUOTA_COOLDOWN_MS);

  const quotaErr2 = classify429("Your AI credit balance is too low to continue");
  assert.equal(quotaErr2.kind, "quota_exhausted");
  assert.equal(decide429(quotaErr2).retryAfterMs, FULL_QUOTA_COOLDOWN_MS);

  // 2. Generic detail-free RESOURCE_EXHAUSTED gets transient cooldown (60s, per FailureGuard pattern)
  const genericErr = classify429("RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).");
  assert.equal(genericErr.kind, "rate_limit");
  assert.equal(decide429(genericErr).retryAfterMs, TRANSIENT_429_COOLDOWN_MS);
  assert.equal(TRANSIENT_429_COOLDOWN_MS, 60000);

  // 3. Capacity overload gets 30s cooldown
  const capacityErr = classify429("MODEL_CAPACITY_EXHAUSTED: server overloaded");
  assert.equal(capacityErr.kind, "capacity");
  assert.equal(decide429(capacityErr).retryAfterMs, CAPACITY_COOLDOWN_MS);
  assert.equal(CAPACITY_COOLDOWN_MS, 30000);
});

test("Antigravity prompt rewrites strip Hermes fake-429 trigger lines", () => {
  const TRIGGERS = [
    "<!-- End Hermes runtime environment -->",
    "# Google model operational directives",
    "If a tool, install, or network call fails and blocks the real path, say so directly",
    "When the user asks you to build, run, or verify something, the deliverable is a working artifact",
    "For help with Hermes Agent itself — configuring, setting up, using, extending, or troubleshooting it",
    "Mid-turn, the user can steer you: Hermes delivers their message as a standalone user message",
  ];
  const SOUL = "You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask";

  const rawSystem = [SOUL, "Legitimate instruction 1", ...TRIGGERS, "Legitimate instruction 2"].join("\n");
  const normalized = normalizeAntigravitySystemInstruction({
    parts: [{ text: rawSystem }]
  });

  assert.ok(normalized?.parts?.[0]?.text, "Normalized system parts must exist");
  const out = normalized.parts[0].text;

  // Verify triggers are stripped
  for (const t of TRIGGERS) {
    assert.ok(!out.includes(t), `Output must not contain trigger: ${t}`);
  }
  // Verify soul is neutralized
  assert.ok(out.includes("You are an AI assistant."));
  assert.ok(!out.includes("Nous Research"));
  // Verify genuine instructions are preserved
  assert.ok(out.includes("Legitimate instruction 1"));
  assert.ok(out.includes("Legitimate instruction 2"));
});

test("AntigravityExecutor.parseError computes transient resetsAtMs for detail-free 429", () => {
  const executor = new AntigravityExecutor();
  const raw429Body = JSON.stringify({
    error: {
      code: 429,
      message: "RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota)."
    }
  });

  const parsed = executor.parseError({ status: 429 }, raw429Body);
  assert.equal(parsed.status, 429);
  assert.ok(parsed.resetsAtMs > Date.now(), "resetsAtMs must be in the future");
  const diffSec = Math.round((parsed.resetsAtMs - Date.now()) / 1000);
  assert.ok(diffSec >= 58 && diffSec <= 62, `Cooldown should be ~60s, got ${diffSec}s`);
});
