import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

describe("AntigravityExecutor Gemini vs Claude toolConfig and functionResponse role", () => {
  const executor = new AntigravityExecutor();

  it("Gemini models preserve original role for functionResponse and do not force user role", () => {
    const geminiBody = {
      model: "ag/gemini-3.8-flash-high",
      request: {
        contents: [
          { role: "user", parts: [{ text: "What is the weather?" }] },
          { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Jakarta" } } }] },
          { role: "tool", parts: [{ functionResponse: { name: "get_weather", response: { temp: "30C" } } }] }
        ]
      }
    };

    const transformed = executor.transformRequest("gemini-3.8-flash-high", geminiBody, true, {});
    const contents = transformed.request.contents;
    const toolMsg = contents.find(c => c.parts?.some(p => p.functionResponse));
    assert.ok(toolMsg);
    assert.equal(toolMsg.role, "tool");
  });

  it("Claude models map functionResponse to user role", () => {
    const claudeBody = {
      model: "claude-sonnet-4-6",
      request: {
        contents: [
          { role: "user", parts: [{ text: "What is the weather?" }] },
          { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Jakarta" } } }] },
          { role: "tool", parts: [{ functionResponse: { name: "get_weather", response: { temp: "30C" } } }] }
        ]
      }
    };

    const transformed = executor.transformRequest("claude-sonnet-4-6", claudeBody, true, {});
    const contents = transformed.request.contents;
    const toolMsg = contents.find(c => c.parts?.some(p => p.functionResponse));
    assert.ok(toolMsg);
    assert.equal(toolMsg.role, "user");
  });

  it("Gemini models preserve client toolConfig if provided", () => {
    const geminiBody = {
      model: "ag/gemini-3.8-flash-high",
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        tools: [{ functionDeclarations: [{ name: "read_file", description: "Read file" }] }],
        toolConfig: { functionCallingConfig: { mode: "AUTO", allowedFunctionNames: ["read_file"] } }
      }
    };

    const transformed = executor.transformRequest("gemini-3.8-flash-high", geminiBody, true, {});
    assert.deepEqual(transformed.request.toolConfig, {
      functionCallingConfig: { mode: "AUTO", allowedFunctionNames: ["read_file"] }
    });
  });

  it("Gemini models default to AUTO (not VALIDATED) when toolConfig not provided", () => {
    const geminiBody = {
      model: "ag/gemini-3.8-flash-high",
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        tools: [{ functionDeclarations: [{ name: "read_file", description: "Read file" }] }]
      }
    };

    const transformed = executor.transformRequest("gemini-3.8-flash-high", geminiBody, true, {});
    assert.deepEqual(transformed.request.toolConfig, {
      functionCallingConfig: { mode: "AUTO" }
    });
  });

  it("Claude models default to VALIDATED when toolConfig not provided", () => {
    const claudeBody = {
      model: "claude-sonnet-4-6",
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        tools: [{ functionDeclarations: [{ name: "read_file", description: "Read file" }] }]
      }
    };

    const transformed = executor.transformRequest("claude-sonnet-4-6", claudeBody, true, {});
    assert.deepEqual(transformed.request.toolConfig, {
      functionCallingConfig: { mode: "VALIDATED" }
    });
  });

  it("reasoning_effort mapping preserves includeThoughts: true", () => {
    const geminiBody = {
      model: "ag/gemini-3.8-flash-high",
      reasoning_effort: "low",
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }]
      }
    };

    const transformed = executor.transformRequest("gemini-3.8-flash-high", geminiBody, true, {});
    assert.ok(transformed.request.generationConfig);
    assert.equal(transformed.request.generationConfig.thinkingConfig?.thinkingBudget, 1024);
    assert.equal(transformed.request.generationConfig.thinkingConfig?.includeThoughts, true);
  });

  it("deduplicates repetitive IDE model output error loop turns to prevent session poisoning", () => {
    const errorMsg = "Error: model output error: model output must contain either output text or tool calls, these cannot both be empty, please try again";
    const corruptedContents = [
      { role: "user", parts: [{ text: "Initial request" }] },
      { role: "model", parts: [] },
      { role: "user", parts: [{ text: errorMsg }] },
      { role: "model", parts: [] },
      { role: "user", parts: [{ text: errorMsg }] },
      { role: "model", parts: [] },
      { role: "user", parts: [{ text: errorMsg }] },
      { role: "user", parts: [{ text: "tes" }] }
    ];

    const body = {
      model: "ag/gemini-3.8-flash-high",
      request: { contents: corruptedContents }
    };

    const transformed = executor.transformRequest("gemini-3.8-flash-high", body, true, {});
    const contents = transformed.request.contents;
    // Count how many times errorMsg appears across all parts
    let count = 0;
    for (const c of contents) {
      for (const p of c.parts || []) {
        if (p.text === errorMsg) count++;
      }
    }
    assert.equal(count, 1, "Duplicate error messages should be collapsed into at most 1");
  });
});
