// A bare RESOURCE_EXHAUSTED from Antigravity (generic message, no details) is a refusal of the
// request body, not a quota signal: it repeats for the same body every time, while real quota
// errors carry reset info. It must not be retried, refresh quota, or lock the account's model.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const {
  AntigravityExecutor,
  isAntigravityPromptRejection,
  moveSystemInstructionToContents,
  readBodyOnce,
  ANTIGRAVITY_PROMPT_REJECTED_MESSAGE,
} = await import("../../open-sse/executors/antigravity.js");
const { ANTIGRAVITY_PROMPT_REWRITES } = await import("../../open-sse/config/appConstants.js");
const { parseUpstreamError } = await import("../../open-sse/utils/error.js");

const BARE = JSON.stringify({
  error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" },
});
const WITH_RETRY_INFO = JSON.stringify({
  error: {
    code: 429,
    message: "Resource has been exhausted (e.g. check quota).",
    status: "RESOURCE_EXHAUSTED",
    details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" }],
  },
});
const REAL_QUOTA = JSON.stringify({
  error: {
    code: 429,
    message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h56m48s.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "QUOTA_EXHAUSTED",
        metadata: { quotaResetTimeStamp: new Date(Date.now() + 3600_000).toISOString() },
      },
    ],
  },
});

const response = (status, body) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

// proxyAwareFetch's DNS-bypass path (the default for Antigravity's Google hosts) returns this
// shape: no clone(), and text() drains the socket, so a second read gets nothing.
const bypassResponse = (status, body) => {
  let drained = false;
  const res = {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Map([["content-type", "application/json"]]),
    text: async () => {
      if (drained) return "";
      drained = true;
      return body;
    },
  };
  res.json = async () => JSON.parse(await res.text());
  return res;
};

beforeEach(() => fetchMock.mockReset());

describe("isAntigravityPromptRejection", () => {
  it("matches the bare RESOURCE_EXHAUSTED body", () => {
    expect(isAntigravityPromptRejection(429, BARE)).toBe(true);
  });

  it.each([
    ["one with RetryInfo details", 429, WITH_RETRY_INFO],
    ["a real quota error", 429, REAL_QUOTA],
    ["a non-429 status", 503, BARE],
    ["an empty body", 429, ""],
    ["a non-JSON body", 429, "Resource has been exhausted (e.g. check quota)."],
  ])("does not match %s", (_label, status, body) => {
    expect(isAntigravityPromptRejection(status, body)).toBe(false);
  });
});

describe("readBodyOnce", () => {
  it("keeps a drained bypass body readable for later callers", async () => {
    const res = bypassResponse(429, BARE);
    expect(await readBodyOnce(res)).toBe(BARE);
    expect(await readBodyOnce(res)).toBe(BARE);
    expect(await res.text()).toBe(BARE);
  });
});

describe("moveSystemInstructionToContents", () => {
  it("moves system parts into the first user turn", () => {
    const moved = moveSystemInstructionToContents({
      request: {
        systemInstruction: { parts: [{ text: "Hermes fingerprint" }, { text: "  " }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      },
    });
    expect(moved.request.systemInstruction).toBeUndefined();
    expect(moved.request.contents[0].parts).toEqual([{ text: "Hermes fingerprint" }]);
    expect(moved.request.contents[1].parts).toEqual([{ text: "hi" }]);
  });

  it("returns null when there is no system text", () => {
    expect(moveSystemInstructionToContents({ request: { contents: [] } })).toBeNull();
  });
});

describe("Antigravity executor handling", () => {
  const ag = new AntigravityExecutor();

  it("does not retry the bare rejection", async () => {
    expect(await ag.computeRetryDelay(response(429, BARE), 1)).toBe(false);
  });

  it("still backs off on other 429s", async () => {
    expect(await ag.computeRetryDelay(response(429, ""), 1)).toBe(2000);
  });

  it("reports it as a request-scoped 400 with an explanation", async () => {
    const parsed = await parseUpstreamError(response(429, BARE), ag);
    expect(parsed.statusCode).toBe(400);
    expect(parsed.message).toBe(ANTIGRAVITY_PROMPT_REJECTED_MESSAGE);
    // No reset timestamp: nothing may arm a cooldown or lock the account.
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("leaves a real quota 429 as a 429", async () => {
    const parsed = await parseUpstreamError(response(429, REAL_QUOTA), ag);
    expect(parsed.statusCode).toBe(429);
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now());
  });
});

describe("ANTIGRAVITY_PROMPT_REWRITES", () => {
  const apply = (input) =>
    ANTIGRAVITY_PROMPT_REWRITES.reduce(
      (text, rule) =>
        typeof rule.from === "string"
          ? text.split(rule.from).join(typeof rule.to === "function" ? "" : rule.to)
          : text.replace(rule.from, rule.to),
      input
    );

  it("rewords the Hermes identity line but keeps the identifiers", () => {
    const out = apply(
      "You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask\n"
        + "For help with Hermes Agent itself you may load it with skill_view(name='hermes-agent'); the documentation at "
        + "https://hermes-agent.nousresearch.com/docs is your authoritative reference."
    );
    expect(out).not.toContain("Hermes Agent, built by Nous Research");
    expect(out).not.toContain("Be direct: match the length of your reply");
    expect(out).toContain("skill_view(name='hermes-agent')");
    expect(out).toContain("https://hermes-agent.nousresearch.com/docs");
  });

  it("rewords the Claude Code identity line instead of deleting it", () => {
    const out = apply("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(out).not.toContain("Claude Code");
    expect(out).toContain("You are Antigravity");
  });

  it("strips the billing header line", () => {
    expect(apply("x-anthropic-billing-header: cc_version=2.0.1\nhello")).toBe("hello");
  });

  it("rewords the OpenClaw identity line", () => {
    const out = apply("You are a personal assistant running inside OpenClaw.");
    expect(out).not.toContain("running inside OpenClaw");
    expect(out).toContain("that runs inside OpenClaw");
  });

  it("covers the dual-use security sentence", () => {
    const out = apply(
      "Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases."
    );
    expect(out).not.toContain("Dual-use security tools");
  });
});
