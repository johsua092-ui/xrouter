import { describe, it, expect, beforeEach } from "vitest";
import { cooldownRegistry } from "../../src/sse/services/cooldownRegistry.js";

describe("dynamic cooldown registry (voidllm pattern)", () => {
  beforeEach(() => {
    cooldownRegistry.clear("test-conn");
    cooldownRegistry.clear("test-conn|gpt-4");
  });

  it("marks a connection as cooling and respects duration", () => {
    expect(cooldownRegistry.isCooling("test-conn")).toBe(false);
    cooldownRegistry.mark("test-conn", 5000, "HTTP 429 Rate Limit");

    expect(cooldownRegistry.isCooling("test-conn")).toBe(true);
    expect(cooldownRegistry.getRemainingMs("test-conn")).toBeGreaterThan(0);
  });

  it("supports Retry-After header in seconds", () => {
    cooldownRegistry.markFromRetryAfter("test-conn", "60", 30000, "Rate limited");
    expect(cooldownRegistry.isCooling("test-conn")).toBe(true);
    expect(cooldownRegistry.getRemainingMs("test-conn")).toBeGreaterThan(50000);
  });

  it("clears cooling state upon explicit heal / clear", () => {
    cooldownRegistry.mark("test-conn", 10000);
    expect(cooldownRegistry.isCooling("test-conn")).toBe(true);
    cooldownRegistry.clear("test-conn");
    expect(cooldownRegistry.isCooling("test-conn")).toBe(false);
  });

  it("provides active telemetry metrics", () => {
    cooldownRegistry.mark("test-conn", 10000, "Too Many Requests");
    const metrics = cooldownRegistry.getMetrics();
    expect(metrics.coolingCount).toBe(1);
    expect(metrics.activeCooldowns[0].key).toBe("test-conn");
  });
});
