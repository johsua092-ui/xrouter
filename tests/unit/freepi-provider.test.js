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
  assert.equal(freepiRegistry.transport.validateUrl, "https://api.freepi.ai/me/stats");
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
  assert.ok(testUtilsContent.includes('url: "https://api.freepi.ai/me/stats"'), "freepi test config must target /me/stats");

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
