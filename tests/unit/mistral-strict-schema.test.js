// Regression: the DeepSeek model rule in reasoningContentInjector re-added
// reasoning_content to every assistant turn *after* stripUnsupportedParams had
// removed it for providers that reject the field. Mistral's chat schema is strict
// (extra="forbid"), so mistral/deepseek-v4-1-flash-1017 answered
// 422 {"loc":["body","messages",2,"assistant","reasoning_content"]}.
// DefaultExecutor must strip last.
import { describe, it, expect } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const bodyWithHistory = () => ({
  model: "deepseek-v4-1-flash-1017",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "ok" },
    { role: "assistant", content: "hello" },
  ],
});

describe("DefaultExecutor.transformRequest — reasoning_content vs strict providers", () => {
  it("drops reasoning_content for mistral even on a deepseek-* model id", () => {
    const out = new DefaultExecutor("mistral").transformRequest("deepseek-v4-1-flash-1017", bodyWithHistory());
    const assistants = out.messages.filter((m) => m.role === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    for (const m of assistants) expect(m.reasoning_content).toBeUndefined();
  });

  it("still injects the placeholder for the native DeepSeek provider", () => {
    const out = new DefaultExecutor("deepseek").transformRequest("deepseek-v4-1-flash-1017", bodyWithHistory());
    const assistants = out.messages.filter((m) => m.role === "assistant");
    expect(assistants.every((m) => typeof m.reasoning_content === "string")).toBe(true);
  });

  it("drops a client-echoed reasoning block for groq too", () => {
    const body = bodyWithHistory();
    body.messages[2].reasoning_content = "prior thinking";
    const out = new DefaultExecutor("groq").transformRequest("qwen/qwen3.6-27b", body);
    for (const m of out.messages.filter((x) => x.role === "assistant")) {
      expect(m.reasoning_content).toBeUndefined();
    }
  });
});
