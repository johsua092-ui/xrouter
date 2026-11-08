import { describe, it, expect, beforeEach } from "vitest";
import {
  checkSemanticCache,
  saveToSemanticCache,
  resetSemanticCacheStats,
  getSemanticCacheStats,
  setSemanticSimilarityThreshold,
} from "../../open-sse/rtk/semanticCache.js";

describe("dual-stage semantic prompt caching", () => {
  beforeEach(() => {
    resetSemanticCacheStats();
    setSemanticSimilarityThreshold(0.85);
  });

  it("hits exact match with Tier 1 instant lookup", () => {
    const body = { messages: [{ role: "user", content: "What is Docker?" }] };
    saveToSemanticCache(body, "openai/gpt-4o", { choices: [{ message: { content: "Docker is a container platform." } }] });

    const result = checkSemanticCache(body, "openai/gpt-4o");
    expect(result).not.toBeNull();
    expect(result.choices[0].message.content).toBe("Docker is a container platform.");

    const stats = getSemanticCacheStats();
    expect(stats.exactHits).toBe(1);
    expect(stats.hits).toBe(1);
  });

  it("hits semantic match with Tier 2 similarity on minor wording variations", () => {
    const original = { messages: [{ role: "user", content: "Explain the quicksort algorithm in python" }] };
    saveToSemanticCache(original, "openai/gpt-4o", { choices: [{ message: { content: "Here is quicksort code..." } }] });

    // Request with polite filler and punctuation
    const variation = { messages: [{ role: "user", content: "Please explain the quicksort algorithm in python!" }] };
    const result = checkSemanticCache(variation, "openai/gpt-4o");
    expect(result).not.toBeNull();
    expect(result.choices[0].message.content).toBe("Here is quicksort code...");

    const stats = getSemanticCacheStats();
    expect(stats.semanticHits).toBe(1);
    expect(stats.hits).toBe(1);
  });

  it("misses when prompts discuss completely different topics", () => {
    const original = { messages: [{ role: "user", content: "What is the capital of France?" }] };
    saveToSemanticCache(original, "openai/gpt-4o", { choices: [{ message: { content: "Paris" } }] });

    const different = { messages: [{ role: "user", content: "How to cook fried rice with eggs?" }] };
    const result = checkSemanticCache(different, "openai/gpt-4o");
    expect(result).toBeNull();

    const stats = getSemanticCacheStats();
    expect(stats.misses).toBe(1);
  });
});
