/**
 * #5613 — AWS OIDC (Kiro IAM Identity Center / Builder ID sign-in, IdC token
 * refresh) resets a TLS handshake that offers X25519 alone, so adding a Kiro
 * account failed with "fetch failed". The shared TLS_ECDH_CURVE keeps X25519
 * first and adds P-256 / P-384; NINEROUTER_TLS_ECDH_CURVE overrides it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DEFAULT_CURVES = "X25519:prime256v1:secp384r1";
const ENV_KEYS = [
  "NINEROUTER_TLS_ECDH_CURVE",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
  "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
];

describe("TLS curve list (#5613)", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.doUnmock("undici");
  });

  it.each([
    [undefined, DEFAULT_CURVES],
    ["X25519", "X25519"],
  ])("tlsConfig resolves the curve list (override=%s)", async (override, expected) => {
    if (override) process.env.NINEROUTER_TLS_ECDH_CURVE = override;
    vi.resetModules();
    const { TLS_ECDH_CURVE } = await import("../../open-sse/config/tlsConfig.js");
    expect(TLS_ECDH_CURVE).toBe(expected);
  });

  it("direct dispatchers offer the shared curve list", async () => {
    const Agent = vi.fn(function (options) { this.options = options; });
    vi.doMock("undici", async () => ({ ...(await vi.importActual("undici")), Agent }));
    const { getDirectDispatcher, resetDirectDispatchersForTests } =
      await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();
    expect((await getDirectDispatcher()).options.connect.ecdhCurve).toBe(DEFAULT_CURVES);
  });

  it("proxy dispatchers offer the curve list in connect and requestTls", async () => {
    const ProxyAgent = vi.fn(function (options) { this.options = options; });
    vi.doMock("undici", async () => ({ ...(await vi.importActual("undici")), ProxyAgent }));
    const { createProxyDispatcher } = await import("../../open-sse/utils/proxyDispatcher.js");
    await createProxyDispatcher({ uri: "http://127.0.0.1:7890" });
    const opts = ProxyAgent.mock.calls[0][0];
    expect(opts.connect.ecdhCurve).toBe(DEFAULT_CURVES);
    expect(opts.requestTls.ecdhCurve).toBe(DEFAULT_CURVES);
  });
});
