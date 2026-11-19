import { describe, expect, it } from "vitest";
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
    expect(toolMsg).toBeDefined();
    expect(toolMsg.role).toBe("tool");
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
    expect(toolMsg).toBeDefined();
    expect(toolMsg.role).toBe("user");
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
    expect(transformed.request.toolConfig).toEqual({
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
    expect(transformed.request.toolConfig).toEqual({
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
    expect(transformed.request.toolConfig).toEqual({
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
    expect(transformed.request.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 1024,
      includeThoughts: true
    });
  });
});
