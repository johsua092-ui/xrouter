import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildModelsList: vi.fn(),
  getSettings: vi.fn(),
  isValidApiKey: vi.fn(),
}));

vi.mock("../../src/app/api/v1/models/route.js", () => ({
  buildModelsList: mocks.buildModelsList,
}));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/auth.js", async () => ({
  ...(await import("../../src/sse/services/keyGate.js")),
  isValidApiKey: mocks.isValidApiKey,
}));

const { GET } = await import("../../src/app/api/v1/models/[...model]/route.js");

const chatModel = {
  id: "cc/claude-sonnet-5",
  object: "model",
  owned_by: "cc",
  context_length: 1_000_000,
};

function params(model) {
  return { params: Promise.resolve({ model }) };
}

describe("GET /v1/models/{id}", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.buildModelsList.mockResolvedValue([chatModel]);
  });

  it("retrieves a provider-prefixed model ID split across URL path segments", async () => {
    mocks.buildModelsList.mockResolvedValue([chatModel]);

    const response = await GET(new Request("https://router.test/v1/models/cc/claude-sonnet-5"), params(["cc", "claude-sonnet-5"]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(chatModel);
    expect(mocks.buildModelsList).toHaveBeenCalledWith(["llm"], { request: expect.any(Request) });
  });

  it("also handles a decoded slash in a single catch-all segment", async () => {
    mocks.buildModelsList.mockResolvedValue([chatModel]);

    const response = await GET(new Request("https://router.test/v1/models/cc%2Fclaude-sonnet-5"), params(["cc/claude-sonnet-5"]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(chatModel);
  });

  it("keeps capability-list routes unchanged", async () => {
    const imageModel = { id: "image/gpt-image-1", object: "model", owned_by: "image" };
    mocks.buildModelsList.mockResolvedValue([imageModel]);

    const response = await GET(new Request("https://router.test/v1/models/image"), params(["image"]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: "list", data: [imageModel] });
    expect(mocks.buildModelsList).toHaveBeenCalledWith(["image"], { request: expect.any(Request) });
  });

  it("returns an OpenAI-style model_not_found response for an unknown model", async () => {
    mocks.buildModelsList.mockResolvedValue([chatModel]);

    const response = await GET(new Request("https://router.test/v1/models/cc/missing-model"), params(["cc", "missing-model"]));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toMatchObject({
      type: "invalid_request_error",
      code: "model_not_found",
    });
  });

  it.each([["cc", "claude-sonnet-5"], ["image"]])("requires a key for protected model path %j", async (...model) => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const response = await GET(new Request("https://router.test/v1/models/lookup"), params(model));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(mocks.buildModelsList).not.toHaveBeenCalled();
  });

  it.each([
    [false, 401],
    ["KEY_DISABLED", 403],
    ["QUOTA_EXCEEDED", 429],
  ])("rejects a key with verdict %j", async (verdict, status) => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.isValidApiKey.mockResolvedValue(verdict);
    const response = await GET(new Request("https://router.test/v1/models/cc/claude-sonnet-5", {
      headers: { authorization: "Bearer fixture-model-key" },
    }), params(["cc", "claude-sonnet-5"]));

    expect(response.status).toBe(status);
    expect((await response.json()).error.type).toBe("invalid_request_error");
    expect(mocks.buildModelsList).not.toHaveBeenCalled();
  });

  it.each(["authorization", "x-api-key"])("accepts a valid key from %s", async (header) => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const response = await GET(new Request("https://router.test/v1/models/cc/claude-sonnet-5", {
      headers: { [header]: header === "authorization" ? "Bearer fixture-model-key" : "fixture-model-key" },
    }), params(["cc", "claude-sonnet-5"]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(chatModel);
    expect(mocks.isValidApiKey).toHaveBeenCalledWith("fixture-model-key");
  });
});
