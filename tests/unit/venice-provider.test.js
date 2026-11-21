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
});
