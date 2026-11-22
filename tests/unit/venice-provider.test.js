import test from "node:test";
import assert from "node:assert/strict";

test("Venice Provider Integration Tests", async (t) => {
  // 1. Registry validation
  await t.test("Registry exports valid no-auth metadata", async () => {
    const veniceRegistryModule = await import("../../open-sse/providers/registry/venice.js");
    const reg = veniceRegistryModule.default;

    assert.equal(reg.id, "venice");
    assert.equal(reg.category, "free");
    assert.equal(reg.noAuth, true);
    assert.equal(reg.hasFree, true);
    assert.equal(reg.authType, "none");
    assert.equal(reg.transport.format, "venice");
    assert.equal(reg.transport.baseUrl, "https://outerface.venice.ai/api/inference/chat");
    assert.equal(Array.isArray(reg.models), true);
    assert.equal(reg.models.length, 6);

    const modelIds = reg.models.map((m) => m.id);
    assert.ok(modelIds.includes("deepseek-v4-1-flash-uncensored"));
    assert.ok(modelIds.includes("qwen3-coder-480b-a35b-instruct-turbo"));
    assert.ok(modelIds.includes("nvidia-nemotron-3-ultra-550b-a55b"));
  });

  // 2. Registry list inclusion
  await t.test("Venice is present in master providers list", async () => {
    const listModule = await import("../../open-sse/providers/registry/index.js");
    const allProviders = listModule.default;
    const found = allProviders.find((p) => p.id === "venice");
    assert.ok(found, "Venice provider should exist in registry index list");
    assert.equal(found.id, "venice");
  });

  // 3. Executor resolution
  await t.test("Executor is properly registered in executors index", async () => {
    const { getExecutor, hasSpecializedExecutor, VeniceExecutor } = await import("../../open-sse/executors/index.js");

    assert.ok(hasSpecializedExecutor("venice"), "venice should have specialized executor");
    assert.ok(hasSpecializedExecutor("venice-ai"), "venice-ai alias should be recognized");
    assert.ok(hasSpecializedExecutor("veniceai"), "veniceai alias should be recognized");

    const executor = getExecutor("venice");
    assert.ok(executor instanceof VeniceExecutor);
    assert.equal(executor.noAuth, true);
  });

  // 4. Payload formatting
  await t.test("Executor formats OpenAI payload to Venice outerface schema", async () => {
    const { VeniceExecutor } = await import("../../open-sse/executors/venice.js");
    const executor = new VeniceExecutor();

    const openAiBody = {
      messages: [
        { role: "system", content: "You are an AI assistant." },
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "4" },
        { role: "user", content: "And plus 1?" },
      ],
      temperature: 0.5,
      top_p: 0.8,
    };

    const payload = executor.formatPayload("venice/qwen3-coder-480b-a35b-instruct-turbo", openAiBody);

    assert.equal(payload.modelId, "qwen3-coder-480b-a35b-instruct-turbo");
    assert.equal(payload.systemPrompt, "You are an AI assistant.");
    assert.equal(payload.temperature, 0.5);
    assert.equal(payload.topP, 0.8);
    assert.equal(payload.simpleMode, false);
    assert.equal(Array.isArray(payload.prompt), true);
    assert.equal(payload.prompt.length, 3);
    assert.equal(payload.prompt[0].role, "user");
    assert.equal(payload.prompt[1].role, "assistant");
    assert.equal(payload.prompt[2].role, "user");
    assert.ok(payload.requestId && typeof payload.requestId === "string");
  });

  // 5. Proxy resolution
  await t.test("Executor resolves connection proxy or local proxy", async () => {
    const { VeniceExecutor } = await import("../../open-sse/executors/venice.js");
    const executor = new VeniceExecutor();

    const customProxy = executor.resolveProxy({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://1.2.3.4:8080",
    });
    assert.equal(customProxy, "http://1.2.3.4:8080");
  });

  // 6. Token TTL & Grace period validation
  await t.test("Executor validates token TTL with 60s grace margin", async () => {
    const { VeniceExecutor } = await import("../../open-sse/executors/venice.js");
    const executor = new VeniceExecutor();

    const nowSec = Math.floor(Date.now() / 1000);

    // Fresh token: expires in 300s -> fresh!
    assert.equal(executor.isTokenFresh(nowSec + 300), true);

    // Borderline token: expires in 65s (>60s) -> fresh!
    assert.equal(executor.isTokenFresh(nowSec + 65), true);

    // Stale token: expires in 55s (<=60s grace period) -> stale!
    assert.equal(executor.isTokenFresh(nowSec + 55), false);

    // Expired token: expired 10s ago -> stale!
    assert.equal(executor.isTokenFresh(nowSec - 10), false);

    // Invalid / null
    assert.equal(executor.isTokenFresh(null), false);
    assert.equal(executor.isTokenFresh(undefined), false);
  });

  // 7. Token queue & In-flight deduplication
  await t.test("Executor pops fresh cached tokens and evicts stale queues", async () => {
    const { VeniceExecutor } = await import("../../open-sse/executors/venice.js");
    const executor = new VeniceExecutor();

    const nowSec = Math.floor(Date.now() / 1000);

    // Seed tokenCache with fresh tokens
    executor.tokenCache.set("test-proxy", {
      queue: ["token-1", "token-2"],
      expiresAt: nowSec + 200,
    });

    const t1 = await executor.getAttestationToken("test-proxy", null);
    assert.equal(t1, "token-1");

    const t2 = await executor.getAttestationToken("test-proxy", null);
    assert.equal(t2, "token-2");

    // Queue is now empty, next call will trigger mint
    assert.equal(executor.tokenCache.get("test-proxy").queue.length, 0);

    // Stale queue auto-eviction
    executor.tokenCache.set("stale-proxy", {
      queue: ["stale-token"],
      expiresAt: nowSec + 30, // within 60s grace margin
    });

    // Mock mintAndQueue to verify it was triggered
    let mintTriggered = false;
    executor.mintAndQueue = async () => {
      mintTriggered = true;
      return "fresh-minted-token";
    };

    const t3 = await executor.getAttestationToken("stale-proxy", null);
    assert.equal(mintTriggered, true);
    assert.equal(t3, "fresh-minted-token");
  });

  // 8. In-flight mint deduplication
  await t.test("Concurrent getAttestationToken calls share a single in-flight mint", async () => {
    const { VeniceExecutor } = await import("../../open-sse/executors/venice.js");
    const executor = new VeniceExecutor();

    let mintCallCount = 0;
    executor.mintAndQueue = async (proxyKey) => {
      mintCallCount++;
      await new Promise((r) => setTimeout(r, 50));
      executor.tokenCache.set(proxyKey, {
        queue: ["token-b", "token-c"],
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      });
      return "token-a";
    };

    // Trigger two calls concurrently
    const [res1, res2] = await Promise.all([
      executor.getAttestationToken("concurrent-proxy", null),
      executor.getAttestationToken("concurrent-proxy", null),
    ]);

    assert.equal(mintCallCount, 1, "Should only execute 1 in-flight mint call");
    assert.equal(res1, "token-a");
    assert.equal(res2, "token-b");
  });

  // 9. OpenAI Tool Bridge & Venice Tool Calling alignment
  await t.test("Venice properly formats tool definitions and renders tool transcripts", async () => {
    const { VeniceExecutor } = await import("../../open-sse/executors/venice.js");
    const executor = new VeniceExecutor();

    const requestWithTools = {
      messages: [
        { role: "system", content: "You are a code agent." },
        { role: "user", content: "Check file a.js" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "a.js" }) },
            },
          ],
        },
        {
          role: "tool",
          name: "read_file",
          tool_call_id: "call-1",
          content: "console.log('hello');",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a local file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        },
      ],
    };

    const payload = executor.formatPayload("venice/deepseek-v4-1-flash-uncensored", requestWithTools);

    // Verify systemPrompt has tool documentation
    assert.ok(payload.systemPrompt.includes("[Tools Available]"));
    assert.ok(payload.systemPrompt.includes("read_file: Read a local file"));
    assert.ok(payload.systemPrompt.includes("<tool_call>"));

    // Verify messages: assistant tool_calls rendered as <tool_call>
    const assistantMsg = payload.prompt.find((p) => p.role === "assistant");
    assert.ok(assistantMsg);
    assert.ok(assistantMsg.content.includes('<tool_call>{"name":"read_file"'));

    // Verify tool result rendered with [Tool Result]
    const toolResultMsg = payload.prompt.find((p) => p.role === "user" && p.content.includes("[Tool Result (read_file)]"));
    assert.ok(toolResultMsg);
    assert.ok(toolResultMsg.content.includes("console.log('hello');"));
  });
});
