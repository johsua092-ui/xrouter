import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

test("FreePI Provider Integration Tests", async (t) => {
  // 1. Registry entry validation
  const freepiRegistryModule = await import("../../open-sse/providers/registry/freepi.js");
  const freepiRegistry = freepiRegistryModule.default;

  assert.equal(freepiRegistry.id, "freepi");
  assert.equal(freepiRegistry.category, "oauth");
  assert.deepEqual(freepiRegistry.authModes, ["oauth", "apikey"]);
  assert.equal(freepiRegistry.hasOAuth, true);
  assert.equal(freepiRegistry.hasFree, true);
  assert.equal(freepiRegistry.features?.usage, true);
  assert.equal(freepiRegistry.transport.baseUrl, "https://api.freepi.ai/v1/chat/completions");
  // No GET validateUrl: /me/stats 401s for CLI tokens while chat works, so the
  // health probe is a 1-token completion in testUtils instead.
  assert.equal(freepiRegistry.transport.validateUrl, undefined);
  assert.ok(Array.isArray(freepiRegistry.models) && freepiRegistry.models.length > 0);

  // 2. Main registry inclusion
  const registryIndexPath = path.join(rootDir, "open-sse/providers/registry/index.js");
  const registryIndexContent = fs.readFileSync(registryIndexPath, "utf8");
  assert.ok(registryIndexContent.includes('"./freepi.js"'), "registry/index.js must import freepi.js");

  // 3. OAuth provider device_code flow validation
  const freepiOAuthModule = await import("../../src/lib/oauth/providers/freepi.js");
  const freepiOAuth = freepiOAuthModule.default;

  assert.equal(freepiOAuth.flowType, "device_code");
  assert.equal(typeof freepiOAuth.requestDeviceCode, "function");
  assert.equal(typeof freepiOAuth.pollToken, "function");
  assert.equal(typeof freepiOAuth.mapTokens, "function");

  const mapped = freepiOAuth.mapTokens({ token: "test-jwt-token", handle: "devuser", tier: "supporter" });
  assert.equal(mapped.accessToken, "test-jwt-token");
  assert.equal(mapped.tokenType, "Bearer");
  assert.equal(mapped.providerSpecificData?.handle, "devuser");
  assert.equal(mapped.providerSpecificData?.tier, "supporter");

  // 4. OAuth provider index registration
  const oauthIndexPath = path.join(rootDir, "src/lib/oauth/providers/index.js");
  const oauthIndexContent = fs.readFileSync(oauthIndexPath, "utf8");
  assert.ok(oauthIndexContent.includes('import freepi from "./freepi.js";'), "oauth/providers/index.js must import freepi");
  assert.ok(oauthIndexContent.includes("freepi,"), "oauth/providers/index.js must register freepi in PROVIDERS");

  // 5. Route noPkceProviders validation
  const routePath = path.join(rootDir, "src/app/api/oauth/[provider]/[action]/route.js");
  const routeContent = fs.readFileSync(routePath, "utf8");
  const noPkcePollMatch = routeContent.match(/const noPkceProviders = \[([\s\S]*?)\];/);
  assert.ok(noPkcePollMatch, "noPkceProviders array must exist in route.js");
  assert.ok(noPkcePollMatch[1].includes('"freepi"'), 'noPkceProviders must include "freepi"');

  // 6. OAuthModal deviceCodeProviders validation
  const modalPath = path.join(rootDir, "src/shared/components/OAuthModal.js");
  const modalContent = fs.readFileSync(modalPath, "utf8");
  const deviceCodeMatch = modalContent.match(/const deviceCodeProviders = \[([\s\S]*?)\];/);
  assert.ok(deviceCodeMatch, "deviceCodeProviders array must exist in OAuthModal.js");
  assert.ok(deviceCodeMatch[1].includes('"freepi"'), 'deviceCodeProviders must include "freepi"');

  // 7. OAUTH_TEST_CONFIG validation
  const testUtilsPath = path.join(rootDir, "src/app/api/providers/[id]/test/testUtils.js");
  const testUtilsContent = fs.readFileSync(testUtilsPath, "utf8");
  assert.ok(testUtilsContent.includes("freepi: {"), "OAUTH_TEST_CONFIG must configure freepi");
  assert.ok(testUtilsContent.includes("probeFreePi"), "freepi must be health-checked with a real completion, not /me/stats");

  // 8. Usage fetcher validation
  const freepiUsageModule = await import("../../open-sse/services/usage/freepi.js");
  const emptyResult = await freepiUsageModule.getFreePiUsage("");
  assert.ok(emptyResult.message?.includes("token not available"), "getFreePiUsage should reject empty token");

  const usageServicePath = path.join(rootDir, "open-sse/services/usage.js");
  const usageServiceContent = fs.readFileSync(usageServicePath, "utf8");
  assert.ok(usageServiceContent.includes('import { getFreePiUsage } from "./usage/freepi.js";'), "usage.js must import getFreePiUsage");
  assert.ok(usageServiceContent.includes("freepi: (c) => getFreePiUsage"), "usage.js must register freepi handler");

  // 9. Suggested models filters validation
  const filtersPath = path.join(rootDir, "src/app/api/providers/suggested-models/filters.js");
  const filtersContent = fs.readFileSync(filtersPath, "utf8");
  assert.ok(filtersContent.includes('"freepi": (models) =>'), "FILTERS must include freepi");
  assert.ok(filtersContent.includes('"freepi": ['), "FALLBACK_SUGGESTIONS must include freepi");

  // 10. FreePiExecutor validation
  const executorsModule = await import("../../open-sse/executors/index.js");
  const freepiExecutor = executorsModule.getExecutor("freepi");
  assert.ok(freepiExecutor instanceof executorsModule.FreePiExecutor, "getExecutor('freepi') must return FreePiExecutor instance");
  const fpExecutor = executorsModule.getExecutor("fp");
  assert.ok(fpExecutor instanceof executorsModule.FreePiExecutor, "getExecutor('fp') must return FreePiExecutor instance");

  const headers = freepiExecutor.buildHeaders({ accessToken: "fake-jwt-token" });
  assert.equal(headers["x-client-version"], "0.6.25");
  assert.ok(headers["x-session-id"], "headers must include x-session-id");
  assert.ok(headers["x-turn-id"], "headers must include x-turn-id");
  assert.equal(headers["x-ad-context"], "none", "headers must include x-ad-context: none");

  // 11. FreePI Launch Handshake and Stream Queue validation
  const { launchSessionHandshake, acquireFreePiQueueLock } = await import("../../open-sse/executors/freepi.js");
  assert.equal(typeof launchSessionHandshake, "function", "launchSessionHandshake must be an exported function");
  assert.equal(typeof acquireFreePiQueueLock, "function", "acquireFreePiQueueLock must be an exported function");

  // Empty token handshake returns false safely without throwing
  const emptyHandshake = await launchSessionHandshake("");
  assert.equal(emptyHandshake, false);

  // Test concurrency lock and serial release
  const testToken = `test-token-${Date.now()}`;
  let release1 = await acquireFreePiQueueLock(testToken);
  assert.equal(typeof release1, "function");

  let queueOrder = [];
  // While lock 1 is held, request 2 should be waiting
  const promise2 = acquireFreePiQueueLock(testToken).then(async (rel2) => {
    queueOrder.push("req2");
    await rel2();
  });

  queueOrder.push("req1");
  await release1();
  await promise2;

  assert.deepEqual(queueOrder, ["req1", "req2"], "Stream queue must process requests in serial FIFO order");

  // 12. Provider Icon validation
  const { getProviderIconSrc } = await import("../../src/shared/utils/providerIcon.js");
  assert.equal(getProviderIconSrc("freepi"), "/providers/freepi.svg");
  assert.equal(getProviderIconSrc("fp"), "/providers/freepi.svg");
  assert.ok(fs.existsSync(path.join(rootDir, "public/providers/freepi.svg")), "public/providers/freepi.svg must exist");
  assert.ok(fs.existsSync(path.join(rootDir, "public/providers/freepi.png")), "public/providers/freepi.png must exist");
});

// FreePI's OAuth transport reports failures as {code, message} and gates every
// token poll behind a server-side consent record. Both used to be dropped on the
// floor, which turned any upstream failure into a 15-minute "Authorization
// timeout" with no explanation.
test("FreePI OAuth error surfacing", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const { default: freepiOAuth } = await import("../../src/lib/oauth/providers/freepi.js");

  const stub = (routes) => {
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      for (const [suffix, reply] of Object.entries(routes)) {
        if (u.endsWith(suffix)) return reply(opts);
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
  };

  const DEVICE = {
    session_id: "sess-1",
    user_code: "AAAA-BBBB",
    verification_uri: "https://github.com/login/device",
    interval: 5,
    expires_in: 899,
  };

  await t.test("consent is posted with session_id + consent_version", async () => {
    const seen = [];
    stub({
      "/auth/github/device": () => Response.json(DEVICE),
      "/auth/consent": (opts) => {
        seen.push(JSON.parse(opts.body));
        return Response.json({ ok: true });
      },
    });
    const data = await freepiOAuth.requestDeviceCode(freepiOAuth.config);
    assert.deepEqual(seen, [{ session_id: "sess-1", consent_version: "4" }]);
    assert.equal(data.device_code, "sess-1");
  });

  await t.test("device code request fails fast when consent is not recorded", async () => {
    stub({
      "/auth/github/device": () => Response.json(DEVICE),
      "/auth/consent": () => new Response('{"code":"internal","message":"boom"}', { status: 500 }),
    });
    await assert.rejects(
      freepiOAuth.requestDeviceCode(freepiOAuth.config),
      /FreePI consent not recorded \(500\)/,
    );
  });

  await t.test("consent failure is not retried on a deterministic 4xx", async () => {
    let calls = 0;
    stub({
      "/auth/github/device": () => Response.json(DEVICE),
      "/auth/consent": () => {
        calls++;
        return new Response('{"code":"bad_request"}', { status: 400 });
      },
    });
    await assert.rejects(freepiOAuth.requestDeviceCode(freepiOAuth.config), /\(400\)/);
    assert.equal(calls, 1);
  });

  await t.test("upstream {code,message} is mapped onto OAuth error fields", async () => {
    stub({
      "/auth/token": () => new Response('{"code":"not_found","message":"unknown session"}', { status: 404 }),
    });
    const result = await freepiOAuth.pollToken(freepiOAuth.config, "sid", null);
    assert.equal(result.ok, false);
    assert.equal(result.data.error, "not_found");
    assert.equal(result.data.error_description, "unknown session");
  });

  await t.test("403 consent_required keeps its actionable code", async () => {
    stub({
      "/auth/token": () =>
        new Response('{"code":"consent_required","message":"consent required before sign-in"}', { status: 403 }),
    });
    const result = await freepiOAuth.pollToken(freepiOAuth.config, "sid", null);
    assert.equal(result.data.error, "consent_required");
  });

  await t.test("pending passthrough keeps the server's retry_after", async () => {
    stub({ "/auth/token": () => Response.json({ status: "pending", retry_after: 10 }) });
    const result = await freepiOAuth.pollToken(freepiOAuth.config, "sid", null);
    assert.equal(result.ok, true);
    assert.equal(result.data.error, "authorization_pending");
    assert.equal(result.data.retry_after, 10);
  });

  await t.test("a granted session still maps token -> access_token", async () => {
    stub({ "/auth/token": () => Response.json({ token: "jwt-1", handle: "devuser", tier: "young" }) });
    const result = await freepiOAuth.pollToken(freepiOAuth.config, "sid", null);
    assert.equal(result.ok, true);
    assert.equal(result.data.access_token, "jwt-1");
  });
});

// A login whose identity lookup fails stores a row with no email; the next
// login for the same account cannot match it, so the pool grows one duplicate
// (same account, same single-concurrency limit) per retry. Identity is now
// retried, backed by /me, and short-circuited when the token body carries it.
test("FreePI identity resolution (duplicate-free re-login)", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const { default: freepiOAuth } = await import("../../src/lib/oauth/providers/freepi.js");

  // The launch handshake also fires a background request; only identity calls
  // are asserted, so filter them out.
  const stub = (routes) => {
    const calls = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      const path = u.replace("https://api.freepi.ai", "");
      calls.push(path);
      for (const [suffix, reply] of Object.entries(routes)) {
        if (u.endsWith(suffix)) return reply();
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    return {
      meCalls: () => calls.filter((p) => p.startsWith("/me")),
    };
  };

  await t.test("/me/stats resolves the handle and the dedup email", async () => {
    stub({ "/me/stats": () => Response.json({ handle: "octo", tier: "young" }) });
    const extra = await freepiOAuth.postExchange({ access_token: "tok" });
    assert.equal(extra.handle, "octo");
    assert.equal(extra.tier, "young");
    assert.equal(extra.email, "octo@github");

    const mapped = freepiOAuth.mapTokens({ access_token: "tok" }, extra);
    assert.equal(mapped.email, "octo@github");
    assert.equal(mapped.displayName, "@octo");
    assert.equal(mapped.providerSpecificData.handle, "octo");
  });

  await t.test("transient stats failures fall back to /me instead of losing identity", async () => {
    let statsCalls = 0;
    const probe = stub({
      "/me/stats": () => {
        statsCalls++;
        return new Response("upstream boom", { status: 503 });
      },
      "/me": () => Response.json({ handle: "octo", tier: "young" }),
    });
    const extra = await freepiOAuth.postExchange({ access_token: "tok" });
    assert.equal(statsCalls, 2, "stats is retried once before the fallback endpoint");
    assert.equal(extra.handle, "octo");
    assert.equal(extra.email, "octo@github");
    assert.deepEqual(probe.meCalls(), ["/me/stats", "/me/stats", "/me"]);
  });

  await t.test("a rejected token is terminal and fabricates no identity", async () => {
    const probe = stub({
      "/me/stats": () => new Response('{"code":"unauthorized"}', { status: 401 }),
    });
    const extra = await freepiOAuth.postExchange({ access_token: "tok" });
    assert.deepEqual(extra, {});
    assert.deepEqual(probe.meCalls(), ["/me/stats"], "401 must not be retried or fall back");
  });

  await t.test("a handle in the token response skips the identity call entirely", async () => {
    const probe = stub({});
    const extra = await freepiOAuth.postExchange({ access_token: "tok", handle: "octo", tier: "young" });
    assert.equal(extra.email, "octo@github");
    assert.deepEqual(probe.meCalls(), []);
  });

  await t.test("no handle anywhere leaves email undefined instead of a bogus one", async () => {
    stub({
      "/me/stats": () => Response.json({}),
    });
    const extra = await freepiOAuth.postExchange({ access_token: "tok" });
    assert.deepEqual(extra, {});
    const mapped = freepiOAuth.mapTokens({ access_token: "tok" }, extra);
    assert.equal(mapped.email, undefined);
    assert.equal(mapped.displayName, "FreePI User");
  });
});

// The per-token maps are process-lifetime state: FreePI has no refresh, so every
// re-login mints a new token and adds entries nobody removes. Measured before
// the sweep: 1.12 KB per token across these maps (≈110 MB per 100k logins), and
// a queue whose stream never closed kept an account "busy" forever.
test("FreePI per-token state hygiene", async (t) => {
  const {
    getSessionId,
    acquireFreePiQueueLock,
    sweepFreePiState,
    getFreePiStateStats,
    wrapStreamWithQueueLock,
  } = await import("../../open-sse/executors/freepi.js");

  await t.test("session id is stable per token and distinct across tokens", () => {
    const a1 = getSessionId("hygiene-a");
    const a2 = getSessionId("hygiene-a");
    const b = getSessionId("hygiene-b");
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
  });

  await t.test("sessions older than the TTL are dropped", () => {
    getSessionId("ttl-a");
    getSessionId("ttl-b");
    assert.ok(getFreePiStateStats().sessions >= 2);
    sweepFreePiState(Date.now() + 7 * 60 * 60 * 1000);
    assert.equal(getFreePiStateStats().sessions, 0, "6h-idle sessions must not survive the sweep");
  });

  await t.test("a held queue survives the sweep, an idle one does not", async () => {
    const token = `hygiene-queue-${Date.now()}`;
    const before = getFreePiStateStats().queues;

    const release = await acquireFreePiQueueLock(token);
    assert.equal(getFreePiStateStats().queues, before + 1);

    sweepFreePiState(Date.now() + 7 * 60 * 60 * 1000);
    assert.equal(getFreePiStateStats().queues, before + 1, "a running slot must never be swept");

    await release();
    sweepFreePiState(Date.now() + 7 * 60 * 60 * 1000);
    assert.equal(getFreePiStateStats().queues, before, "an idle slot is not worth keeping");
  });

  await t.test("the per-token maps stay bounded", () => {
    for (let i = 0; i < 700; i++) getSessionId(`bounded-${i}`);
    const stats = getFreePiStateStats();
    assert.ok(stats.sessions <= stats.limit, `sessions=${stats.sessions} limit=${stats.limit}`);
  });

  await t.test("the lock is released when the body cannot be wrapped", () => {
    let releases = 0;
    const bomb = {
      body: { pipeThrough() { throw new Error("boom"); } },
      status: 200,
      statusText: "OK",
      headers: new Headers(),
    };
    assert.throws(() => wrapStreamWithQueueLock(bomb, () => { releases++; }), /boom/);
    assert.equal(releases, 1, "a failed wrap must not strand the account as BUSY");
  });

  await t.test("release fires once on EOF", async () => {
    let releases = 0;
    const source = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      }),
      { status: 200 },
    );
    const wrapped = wrapStreamWithQueueLock(source, () => { releases++; });
    await new Response(wrapped.body).text();
    assert.equal(releases, 1);
  });

  await t.test("release fires once on cancel", async () => {
    let releases = 0;
    const source = new Response(
      new ReadableStream({
        pull(controller) { controller.enqueue(new TextEncoder().encode("chunk")); },
      }),
      { status: 200 },
    );
    const wrapped = wrapStreamWithQueueLock(source, () => { releases++; });
    const reader = wrapped.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(releases, 1);
  });

  await t.test("a body-less response releases immediately", () => {
    let releases = 0;
    const res = new Response(null, { status: 204 });
    wrapStreamWithQueueLock(res, () => { releases++; });
    assert.equal(releases, 1);
  });
});

test("FreePI queue admission control", async (t) => {
  const { acquireFreePiQueueLock, getFreePiQueuePressure, reserveFreePiSlot, getFreePiMetrics } = await import(
    "../../open-sse/executors/freepi.js"
  );
  const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

  await t.test("pressure reports idle, then running, then waiting", async () => {
    const token = `pressure-${Date.now()}`;
    assert.equal(getFreePiQueuePressure(token).idle, true, "an unknown token has no queue");

    const release = await acquireFreePiQueueLock(token);
    assert.equal(getFreePiQueuePressure(token).running, 1);

    const queued = acquireFreePiQueueLock(token);
    assert.deepEqual(
      { ...getFreePiQueuePressure(token) },
      { running: 1, waiting: 1, reserved: 0, total: 2, idle: false },
      "slot-aware routing needs the waiting count, not just the running flag",
    );

    await release();
    const releaseNext = await queued;
    assert.equal(getFreePiQueuePressure(token).running, 1, "the handed-off request owns the slot");
    await releaseNext();
    assert.equal(getFreePiQueuePressure(token).idle, true, "an idle queue must look idle again");
  });

  await t.test("a selection reservation makes the slot look taken", async () => {
    const token = `reserve-${Date.now()}`;
    assert.equal(getFreePiQueuePressure(token).idle, true);

    const undo = reserveFreePiSlot(token, 40);
    const during = getFreePiQueuePressure(token);
    assert.equal(during.reserved, 1);
    assert.equal(during.total, 1);
    assert.equal(during.idle, false, "two selects in the same tick must not both see a free account");

    reserveFreePiSlot(token, 40);
    assert.equal(getFreePiQueuePressure(token).total, 2);

    undo();
    assert.equal(getFreePiQueuePressure(token).reserved, 1, "releasing one reservation keeps the other");

    await new Promise((r) => setTimeout(r, 90));
    assert.equal(getFreePiQueuePressure(token).idle, true, "an unused reservation must expire on its own");
  });

  await t.test("acquiring the real lock clears the reservation", async () => {
    const token = `reserve-clear-${Date.now()}`;
    reserveFreePiSlot(token);
    assert.equal(getFreePiQueuePressure(token).reserved, 1);

    const release = await acquireFreePiQueueLock(token);
    const during = getFreePiQueuePressure(token);
    assert.equal(during.reserved, 0, "the lock supersedes the hint");
    assert.equal(during.running, 1);
    await release();
    assert.equal(getFreePiQueuePressure(token).idle, true);
  });

  await t.test("a full queue fails fast with QUEUE_OVERFLOW", async () => {
    const token = `overflow-${Date.now()}`;
    const release = await acquireFreePiQueueLock(token);

    const controllers = [];
    const waiting = [];
    for (let i = 0; i < 10; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      waiting.push(acquireFreePiQueueLock(token, ac.signal).catch((e) => e));
    }
    assert.equal(getFreePiQueuePressure(token).waiting, 10);

    await assert.rejects(
      acquireFreePiQueueLock(token),
      (err) => err.code === "QUEUE_OVERFLOW" && /QUEUE_OVERFLOW/.test(err.message),
    );

    controllers.forEach((c) => c.abort());
    await Promise.all(waiting);
    await release();

    assert.ok(getFreePiMetrics().queueOverflow >= 1, "the pool panel must be able to count refusals");
  });

  await t.test("a queued request times out instead of waiting forever", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const token = `timeout-${Date.now()}`;
    const release = await acquireFreePiQueueLock(token);
    const queued = acquireFreePiQueueLock(token);

    t.mock.timers.tick(119000);
    let settled = null;
    queued.then(() => { settled = "resolved"; }, (e) => { settled = e.code; });
    await Promise.resolve();
    assert.equal(settled, null, "must still be waiting before the deadline");

    t.mock.timers.tick(2000);
    await assert.rejects(queued, (err) => err.code === "QUEUE_TIMEOUT");

    const released = release();
    t.mock.timers.tick(600); // drain the post-stream settling delay
    await released;
  });

  await t.test("our own queue refusals never cool the account down", () => {
    const overflow = checkFallbackError(
      429,
      "FreePI queue full: too many concurrent requests queued for this account (QUEUE_OVERFLOW)",
      0,
      "freepi",
    );
    assert.equal(overflow.shouldLock, false, "a local admission decision is not account illness");
    assert.equal(overflow.cooldownMs, 0);

    const timeout = checkFallbackError(
      429,
      "FreePI queue wait exceeded 120000ms (QUEUE_TIMEOUT)",
      0,
      "freepi",
    );
    assert.equal(timeout.shouldLock, false);
    assert.equal(timeout.cooldownMs, 0);
  });

  await t.test("the pool snapshot is exposed and countable", async () => {
    const metrics = getFreePiMetrics();
    for (const key of ["requests", "queueOverflow", "queueTimeout", "upstream429", "authFailures", "adsCycles", "handshakes", "queues", "reservations"]) {
      assert.equal(typeof metrics[key], "number", `${key} must be a gauge or counter`);
    }

    const routeSrc = fs.readFileSync(
      path.join(rootDir, "src/app/api/providers/freepi/stats/route.js"), "utf8");
    assert.ok(routeSrc.includes("validateApiKey"), "monitors must be able to scrape with an API key");
    assert.ok(routeSrc.includes("collectFreePiStats"), "route must serve the shared snapshot");

    const collectorSrc = fs.readFileSync(path.join(rootDir, "src/lib/freepiStats.js"), "utf8");
    assert.ok(collectorSrc.includes("getFreePiQueuePressure"), "per-account queue depth comes from the executor");
    assert.ok(collectorSrc.includes("needs_reauth"), "dead tokens must be visible as their own state");
  });

  await t.test("routing exposes a slot-aware strategy for FreePI", () => {
    const authSrc = fs.readFileSync(path.join(rootDir, "src/sse/services/auth.js"), "utf8");
    assert.ok(authSrc.includes('strategy === "least-loaded"'), "auth.js must handle least-loaded");
    assert.ok(authSrc.includes("getFreePiQueuePressure"), "selection must read live queue depth");
    assert.ok(authSrc.includes("reserveFreePiSlot"), "selection must claim the slot it picked");

    const registry = fs.readFileSync(path.join(rootDir, "open-sse/providers/registry/freepi.js"), "utf8");
    assert.ok(!/validateUrl:\s*"https:\/\/api\.freepi\.ai\/me\/stats"/.test(registry),
      "/me/stats 401s for CLI tokens and must not be used as a health probe");

    const testUtils = fs.readFileSync(
      path.join(rootDir, "src/app/api/providers/[id]/test/testUtils.js"), "utf8");
    assert.ok(testUtils.includes('case "freepi"'), "connection test needs a real completion probe");
  });
});
