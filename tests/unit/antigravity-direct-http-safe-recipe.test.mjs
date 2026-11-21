import test from "node:test";
import assert from "node:assert/strict";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { __test__ as tlsTest } from "../../open-sse/services/antigravityTlsClient.js";
import { getAntigravityModelQuotaFraction, clearAntigravityQuotaCache } from "../../open-sse/services/antigravityQuotaMonitor.js";

test("Antigravity Direct HTTP Recipe 2: buildHeaders includes official Client-Metadata and canonical headers", () => {
  const executor = new AntigravityExecutor();
  const credentials = {
    accessToken: "ya29.test-access-token",
    projectId: "aicode-consumers",
  };

  const headers = executor.buildHeaders(credentials, true);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Accept"], "text/event-stream");
  assert.equal(headers["Authorization"], "Bearer ya29.test-access-token");
  assert.match(headers["User-Agent"], /antigravity/i);
  assert.equal(headers["x-goog-user-project"], "aicode-consumers");
  assert.equal(headers["x-request-source"], "local");

  // Client-Metadata verification
  assert.ok(headers["Client-Metadata"], "Client-Metadata header must exist");
  const meta = JSON.parse(headers["Client-Metadata"]);
  assert.equal(meta.ideType, "ANTIGRAVITY");
  assert.equal(meta.ideName, "antigravity");
  assert.equal(meta.pluginType, "GEMINI");
  assert.ok(meta.ideVersion, "ideVersion must be populated");
});

test("Antigravity Direct HTTP Recipe 1: transformRequest enforces canonical project ID and removes requestType on chat", () => {
  const executor = new AntigravityExecutor();
  const credentials = {
    accessToken: "ya29.test-token",
    projectId: "aicode-consumers",
  };

  const body = {
    model: "gemini-3.8-flash-low",
    requestType: "agent",
    request: {
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
    },
  };

  const transformed = executor.transformRequest("gemini-3.8-flash-low", body, true, credentials);
  assert.equal(transformed.project, "aicode-consumers");
  assert.equal(transformed.userAgent, "antigravity");
  assert.match(transformed.requestId, /^agent\/[a-f0-9-]+\/\d+\/[a-f0-9-]+\/\d+$/);
  assert.equal(transformed.requestType, undefined, "requestType: 'agent' must be stripped to prevent fake 429");
});

test("Antigravity Direct HTTP Recipe 5: TLS impersonation uses BoringSSL cipher list", () => {
  assert.ok(Array.isArray(tlsTest.ANTIGRAVITY_CIPHER_LIST.split(":")), "Cipher list must be defined");
  assert.ok(tlsTest.ANTIGRAVITY_CIPHER_LIST.includes("TLS_AES_128_GCM_SHA256"));
  assert.ok(tlsTest.ANTIGRAVITY_CIPHER_LIST.includes("TLS_CHACHA20_POLY1305_SHA256"));
});

test("Antigravity Direct HTTP Recipe 6: Proactive Quota Engine calculates fraction and identifies drained threshold", () => {
  clearAntigravityQuotaCache();

  const mockQuota = {
    groups: [
      {
        displayName: "Gemini / Code Assist",
        buckets: [
          { window: "1d", remainingFraction: 0.85, resetTime: "2026-11-22T00:00:00Z" },
          { window: "5h", remainingFraction: 0.015, resetTime: "2026-11-22T02:00:00Z" }, // Drained! <= 0.02
        ],
      },
      {
        displayName: "Claude 3.7 / 3.5 Sonnet",
        buckets: [
          { window: "1d", remainingFraction: 0.90, resetTime: "2026-11-22T00:00:00Z" },
        ],
      },
    ],
  };

  // Gemini model should see 0.015 (drained <= 0.02)
  const geminiFraction = getAntigravityModelQuotaFraction(mockQuota, "gemini-3.8-flash-low");
  assert.equal(geminiFraction, 0.015);

  // Claude model should see 0.90 (healthy)
  const claudeFraction = getAntigravityModelQuotaFraction(mockQuota, "claude-sonnet-4-6");
  assert.equal(claudeFraction, 0.90);

  // Unknown model fails open to 1.0
  const emptyFraction = getAntigravityModelQuotaFraction(null, "unknown-model");
  assert.equal(emptyFraction, 1.0);
});
