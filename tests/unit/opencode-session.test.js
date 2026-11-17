// The executor gates the local service-daemon branch on NODE_ENV === "test".
// Vitest does not set NODE_ENV on its own, so without this the daemon path is
// taken and the test hangs waiting for a real `opencode serve` process.
process.env.NODE_ENV = "test";
delete process.env.OPENCODE_USE_SERVICE_DAEMON;

import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

// The executor's `directFetch` goes through the dedicated TLS client, not
// proxyAwareFetch. Without this mock the test reaches the real network and
// hangs until the 5s timeout.
vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import {
  OPENCODE_SESSION_RE,
  generateSessionId,
  generateRequestId,
  translateSessionId,
  stableSessionId,
} from "../../open-sse/executors/opencode.js";
import { OPENCODE_CANONICAL_TOOL_DEFINITIONS } from "../../open-sse/utils/opencodeFingerprint.js";

function makeCredentials(overrides = {}) {
  return {
    connectionId: "conn_test",
    rawHeaders: {},
    ...overrides,
  };
}

function prepare(executor, overrides = {}) {
  const credentials = overrides.credentials || makeCredentials();
  const prepared = executor.prepareRequestCredentials({
    body: overrides.body || { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
    credentials,
    providerSessionId: overrides.providerSessionId ?? "conversation-a",
    clientTool: overrides.clientTool ?? "claude",
  });
  return { credentials, prepared };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("OpenCode Free Session ID Format", () => {
  it("generates session IDs matching OpenCode canonical format (ses_ + 12 hex + 14 base62)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateSessionId();
      expect(id).toMatch(OPENCODE_SESSION_RE);
      expect(id).toHaveLength(30);
    }
  });

  it("generates request IDs matching OpenCode canonical format (msg_ + 12 hex + 14 base62)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateRequestId();
      expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(id).toHaveLength(30);
    }
  });

  it("translates arbitrary sessions into valid OpenCode session format", () => {
    const inputs = [
      "claude:550e8400-e29b-41d4-a716-446655440000",
      "antigravity:conv-abc-123",
      "session-from-codex",
      "12345",
      "",
    ];
    for (const raw of inputs) {
      const translated = translateSessionId(raw, "claude");
      expect(translated).toMatch(OPENCODE_SESSION_RE);
      expect(translated).toHaveLength(30);
    }
  });

  it("preserves already-valid OpenCode sessions without re-hashing", () => {
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    expect(translateSessionId(valid)).toBe(valid);
    expect(translateSessionId(`  ${valid}  `)).toBe(valid);
  });
});

describe("OpenCode Free Executor Session Resolution", () => {
  it("uses request-local session credentials without mutating source credentials", () => {
    const executor = getExecutor("opencode");
    const { credentials, prepared } = prepare(executor);

    expect(executor.constructor.name).toBe("OpenCodeExecutor");
    expect(prepared).not.toBe(credentials);
    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(credentials).not.toHaveProperty("_opencodeSession");
    expect(executor).not.toHaveProperty("_currentSessionId");
  });

  it("preserves valid native x-opencode-session header case-insensitively", () => {
    const executor = getExecutor("opencode");
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "X-OpenCode-Session": ` ${valid} ` } }),
    });

    expect(prepared._opencodeSession).toBe(valid);
  });

  it("translates invalid native x-opencode-session header into a valid session", () => {
    const executor = getExecutor("opencode");
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "x-opencode-session": "invalid-session-uuid" } }),
    });

    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(prepared._opencodeSession).not.toBe("invalid-session-uuid");
  });

  it("translates conversation session deterministically", () => {
    const executor = getExecutor("opencode");
    const first = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;
    const second = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;

    expect(first).toBe(second);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("isolates different conversations and tools", () => {
    const executor = getExecutor("opencode");
    const convA = prepare(executor, { providerSessionId: "conversation-a" }).prepared._opencodeSession;
    const convB = prepare(executor, { providerSessionId: "conversation-b" }).prepared._opencodeSession;
    const toolClaude = prepare(executor, { providerSessionId: "same", clientTool: "claude" }).prepared._opencodeSession;
    const toolCodex = prepare(executor, { providerSessionId: "same", clientTool: "codex" }).prepared._opencodeSession;

    expect(convA).not.toBe(convB);
    expect(toolClaude).not.toBe(toolCodex);
  });

  // The full executor path paces the first upstream call (MIN_START_GAP_MS =
  // 400) and walks every fallback URL, so the default 5s budget is too tight
  // for a cold module graph. Give this one a realistic budget instead of
  // loosening the pacing that protects the free lane in production.
  it("adds the valid session header to fetch requests", async () => {
    const executor = getExecutor("opencode");
    const credentials = makeCredentials();
    const result = await executor.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
      stream: false,
      credentials,
      providerSessionId: "conversation-fetch-test",
      clientTool: "claude",
    });

    expect(result.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(result.headers["x-opencode-session"]);
    expect(fetchMock.mock.calls[0][1].headers["Authorization"]).toBe("Bearer public");
    expect(credentials).not.toHaveProperty("_opencodeSession");
  }, 20000);

  it("falls back to a valid generated session in buildHeaders when called standalone", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({});

    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["Authorization"]).toBe("Bearer public");
  });
  it("handles null or undefined body gracefully in transformRequest", () => {
    const executor = getExecutor("opencode");
    expect(() => executor.transformRequest("muse-spark-1.3-contributor-free", null, false, {})).not.toThrow();
    expect(() => executor.transformRequest("big-pickle", undefined, false, {})).not.toThrow();
  });
});

describe("OpenCode Free User-Agent Validation", () => {
  // The v2 UA is opencode/<channel>/<version>/<client>. Assert the shape so the
  // version floor can move without rewriting the test.
  const V2_UA_RE = /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/;

  it("defaults to the v2 UA for non-opencode downstream clients", () => {
    const executor = getExecutor("opencode");
    const headersNoUa = executor.buildHeaders({});
    expect(headersNoUa["User-Agent"]).toMatch(V2_UA_RE);

    const headersClaude = executor.buildHeaders({ rawHeaders: { "user-agent": "Claude-Code/1.0" } });
    expect(headersClaude["User-Agent"]).toMatch(V2_UA_RE);
  });

  it("replaces bare opencode with the v2 UA to prevent 403 FreeTierError", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode" } });
    expect(headers["User-Agent"]).toMatch(V2_UA_RE);
  });

  it("upgrades outdated opencode versions to prevent 426 Upgrade Required", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.15.0" } });
    expect(headers["User-Agent"]).toMatch(V2_UA_RE);
  });

  it("preserves a valid v2 downstream UA and rewrites a v1 one", () => {
    const executor = getExecutor("opencode");

    // Valid v2 (major >= 2) passes through untouched.
    const passthrough = "opencode/latest/2.2.5/cli";
    const kept = executor.buildHeaders({ rawHeaders: { "user-agent": passthrough } });
    expect(kept["User-Agent"]).toBe(passthrough);

    const future = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/beta/3.0.1/cli" } });
    expect(future["User-Agent"]).toBe("opencode/beta/3.0.1/cli");

    // The v1 shape (opencode/<version>) is not recognised and gets replaced.
    const legacy = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.19.0" } });
    expect(legacy["User-Agent"]).toMatch(V2_UA_RE);
  });
});

describe("OpenCode Stable Session Reuse (429 follow-up)", () => {
  function anonymousCredentials(auth) {
    return makeCredentials({ connectionId: undefined, rawHeaders: { authorization: `Bearer ${auth}` } });
  }

  it("reuses one stable upstream session instead of minting a new one per request", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const first = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });
    const second = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });

    expect(first._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(second._opencodeSession).toBe(first._opencodeSession);
  });

  it("isolates stable sessions by downstream identity", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const forKey = (auth) => executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials(auth),
      providerSessionId: null,
      clientTool: "claude",
    })._opencodeSession;

    expect(forKey("user-A")).not.toBe(forKey("user-B"));
    expect(forKey("user-A")).toMatch(OPENCODE_SESSION_RE);
  });

  it("isolates stable sessions by client tool when the API key is shared", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const forTool = (clientTool) => executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("shared-key"),
      providerSessionId: null,
      clientTool,
    })._opencodeSession;

    // Apps sharing one 9Router key must not pool into one upstream session:
    // upstream quota is per session, so pooled sessions exhaust together.
    expect(forTool("claude")).not.toBe(forTool("codex"));
    expect(forTool("claude")).toBe(forTool("claude"));
  });

  it("falls back to the raw User-Agent when no client tool is detected", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const forUa = (ua) => executor.prepareRequestCredentials({
      body,
      credentials: { connectionId: "direct-conn", rawHeaders: { "user-agent": ua } },
      providerSessionId: null,
      clientTool: null,
    })._opencodeSession;

    // Generic chat apps (no detectable tool) each get their own pool instead
    // of all of them sharing the single "generic" session.
    expect(forUa("CherryStudio/1.0")).not.toBe(forUa("chatbox/2.3"));
    expect(forUa("CherryStudio/1.0")).toBe(forUa("CherryStudio/1.0"));
    expect(forUa("CherryStudio/1.0")).toMatch(OPENCODE_SESSION_RE);
  });

  it("exposes the stable session helper directly", () => {
    const first = stableSessionId({ connectionId: "direct-conn" });
    expect(stableSessionId({ connectionId: "direct-conn" })).toBe(first);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("emits canonical msg_ request ids from generateRequestId", () => {
    const first = generateRequestId(1_700_000_000_000);
    expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    // Distinct calls must not collide.
    expect(generateRequestId()).not.toBe(generateRequestId());
  });

  it("never sends the v1 x-opencode-request header upstream", () => {
    // Upstream rejects any x-opencode-request header with 403, so a downstream
    // client supplying one must not have it propagated.
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({
      rawHeaders: { "x-opencode-request": "msg_0ae8d9cd3001swxaFbM248jcIF" },
    });
    expect(headers["x-opencode-request"]).toBeUndefined();
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
  });

  it("keeps the standalone buildHeaders session stable across calls", () => {
    const executor = getExecutor("opencode");
    const first = executor.buildHeaders({})["x-opencode-session"];
    const second = executor.buildHeaders({})["x-opencode-session"];
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(second).toBe(first);
  });

  it("applies the full lowercase free-tier fingerprint quartet", () => {
    const executor = getExecutor("opencode");

    const chatNoTools = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chatNoTools.stream).toBe(true);
    // Upstream rejects tool_choice "none" with 403 FreeTierError, so it is
    // stripped rather than forwarded.
    expect(chatNoTools.tool_choice).toBeUndefined();
    expect(chatNoTools.tools.map((t) => t.function?.name)).toEqual([
      "edit", "glob", "grep", "read", "shell",
    ]);

    const chatWithTools = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "Bash", description: "Claude Code tool" } },
        { type: "function", function: { name: "Glob", description: "Claude Code tool" } },
        { type: "function", function: { name: "Grep", description: "Claude Code tool" } },
        { type: "function", function: { name: "Read", description: "Claude Code tool" } },
      ],
      tool_choice: "auto",
    });
    expect(chatWithTools.tool_choice).toBe("auto");
    // fingerprintToolKey is case-sensitive: "Bash" is not recognised as the
    // canonical "shell", so the caller's capitalised tools are left alone and
    // all five fingerprint tools are appended after them.
    expect(chatWithTools.tools.map((t) => t.function?.name)).toEqual([
      "Bash", "Glob", "Grep", "Read", "edit", "glob", "grep", "read", "shell",
    ]);

    const chatPartial = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "bash", description: "existing" } },
        { type: "function", function: { name: "read", description: "existing" } },
      ],
    });
    // Lowercase names match the fingerprint keys. A tool whose parameters do
    // not already speak OpenCode's schema cannot be normalised in place, so it
    // is aliased to <key>_client and the canonical tools are appended after.
    const partialNames = chatPartial.tools.map((t) => t.function?.name);
    expect(partialNames[0]).toBe("bash");
    expect(partialNames[1]).toBe("read_client");
    expect(partialNames).toEqual(["bash", "read_client", "edit", "glob", "grep", "read", "shell"]);
    expect(chatPartial.tools[0].function.description).toBe("existing");

    // Already carries every fingerprint tool -> nothing is appended. A tool
    // that omits `parameters` cannot be normalised in place (there is no
    // schema to prove the caller's handler still lines up), so each one is
    // aliased to <key>_client and the canonical five are appended after it.
    const chatFull = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: ["edit", "glob", "grep", "read", "shell"].map((name) => ({
        type: "function", function: { name, description: "existing" },
      })),
    });
    expect(chatFull.tools.length).toBe(10);
    expect(chatFull.tools[0].function.description).toBe("existing");
  });

  it("keeps a full canonical fingerprint set intact when definitions are real", () => {
    const executor = getExecutor("opencode");
    const chatFull = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: ["edit", "glob", "grep", "read", "shell"].map((name) => ({
        type: "function",
        function: {
          name,
          ...OPENCODE_CANONICAL_TOOL_DEFINITIONS[name],
        },
      })),
    });

    expect(chatFull.tools.length).toBe(5);
    expect(chatFull.tools.map((t) => t.function.name)).toEqual([
      "edit", "glob", "grep", "read", "shell",
    ]);
  });

  it("cloaks Muse Responses requests even when the client already supplies tools", () => {
    const executor = getExecutor("opencode");
    const transformed = executor.transformRequest("muse-spark-1.3-contributor-free(xhigh)", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{
        type: "function",
        name: "zcode_search",
        description: "client-provided tool",
        parameters: { type: "object", properties: {} },
      }],
      tool_choice: "auto",
      reasoning_effort: "xhigh",
    }, true, {});

    expect(transformed.stream).toBe(true);
    expect(transformed.reasoning?.effort).toBe("xhigh");
    // Responses lane emits flat tools. The canonical fingerprint set for
    // OpenCode v2.2.5+ is edit/glob/grep/read/shell — `bash` is not a
    // fingerprint name, so a caller-supplied `bash` is passed through verbatim
    // while `shell` is appended as the canonical equivalent.
    const names = transformed.tools.map((tool) => tool.name ?? tool.function?.name);
    expect(names).toContain("zcode_search");
    expect(names).toContain("shell");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("read");
    expect(names.filter((name) => name === "shell")).toHaveLength(1);
    expect(names.filter((name) => name === "read")).toHaveLength(1);
  });

  it("declares forceStream on the opencode transport so chatCore serves SSE upstream", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS.opencode?.forceStream).toBe(true);
  });
});
