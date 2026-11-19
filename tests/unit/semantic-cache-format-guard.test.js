import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkSemanticCache,
  saveToSemanticCache,
  clearSemanticCache,
  extractMessagesFromBody
} from "../../open-sse/rtk/semanticCache.js";

describe("SemanticCache format and tools isolation guard", () => {
  beforeEach(() => {
    clearSemanticCache();
  });

  it("extractMessagesFromBody correctly extracts from all message formats", () => {
    assert.equal(extractMessagesFromBody({ messages: [{ role: "user", content: "A" }] }).length, 1);
    assert.equal(extractMessagesFromBody({ input: [{ role: "user", content: "B" }] }).length, 1);
    assert.equal(extractMessagesFromBody({ contents: [{ role: "user", parts: [{ text: "C" }] }] }).length, 1);
    assert.equal(extractMessagesFromBody({ request: { contents: [{ role: "user", parts: [{ text: "D" }] }] } }).length, 1);
    assert.equal(extractMessagesFromBody({}).length, 0);
    assert.equal(extractMessagesFromBody(null).length, 0);
  });

  it("never caches or matches requests containing tools (agent workflows)", () => {
    const agentBody = {
      model: "antigravity/gemini-3.8-flash-high",
      request: {
        contents: [{ role: "user", parts: [{ text: "List directory" }] }],
        tools: [{ functionDeclarations: [{ name: "list_dir", description: "List files" }] }]
      }
    };

    saveToSemanticCache(agentBody, "antigravity/gemini-3.8-flash-high", {
      choices: [{ message: { role: "assistant", content: "done" } }]
    });

    const cached = checkSemanticCache(agentBody, "antigravity/gemini-3.8-flash-high");
    assert.equal(cached, null);
  });

  it("never matches or caches bodies with empty/no extracted text", () => {
    const emptyBody = {
      model: "antigravity/gemini-3.8-flash-high",
      request: {}
    };

    saveToSemanticCache(emptyBody, "antigravity/gemini-3.8-flash-high", {
      choices: [{ message: { role: "assistant", content: "test" } }]
    });

    const cached = checkSemanticCache(emptyBody, "antigravity/gemini-3.8-flash-high");
    assert.equal(cached, null);
  });

  it("caches and hits valid standard OpenAI prompt without tools", () => {
    const standardBody = {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "What is 2 + 2?" }]
    };

    const mockResponse = {
      id: "chatcmpl-123",
      choices: [{ message: { role: "assistant", content: "4" } }]
    };

    saveToSemanticCache(standardBody, "openai/gpt-4o", mockResponse);

    const hit = checkSemanticCache(standardBody, "openai/gpt-4o");
    assert.ok(hit);
    assert.equal(hit.choices[0].message.content, "4");
  });
});
