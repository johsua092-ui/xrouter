/**
 * Regression: Antigravity login died with a Go TLS error while MITM was on.
 *
 *   Post "https://oauth2.googleapis.com/token":
 *   tls: failed to verify certificate: x509: certificate signed by unknown authority
 *
 * oauth2.googleapis.com is NOT a MITM target (see mitmToolHosts.js), but the
 * MITM-bypass list in proxyFetch.js only covered the chat hosts — so a hosts
 * redirect (or any local interceptor on 127.0.0.1:443) captured the OAuth token
 * exchange and presented the MITM cert, which the caller rejects. The fix adds
 * the Google auth endpoints to MITM_BYPASS_HOSTS so token exchange resolves the
 * real IP via 8.8.8.8 and never touches the local interceptor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PROXY_FETCH = read("open-sse/utils/proxyFetch.js");
const { TOOL_HOSTS } = await import(
  "file://" + resolve(root, "src/shared/constants/mitmToolHosts.js")
);

/** Extract MITM_BYPASS_HOSTS entries from source without importing the module. */
function bypassHosts() {
  const m = PROXY_FETCH.match(/const MITM_BYPASS_HOSTS = \[([\s\S]*?)\];/);
  expect(m, "MITM_BYPASS_HOSTS must exist in proxyFetch.js").toBeTruthy();
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("Google auth endpoints bypass the MITM interceptor", () => {
  it("oauth2.googleapis.com is in MITM_BYPASS_HOSTS", () => {
    expect(bypassHosts()).toContain("oauth2.googleapis.com");
  });

  it("accounts.google.com is in MITM_BYPASS_HOSTS (authorize URL)", () => {
    expect(bypassHosts()).toContain("accounts.google.com");
  });

  it("the oauth callback host (www.googleapis.com / openidconnect) is covered", () => {
    const hosts = bypassHosts();
    expect(hosts).toContain("www.googleapis.com");
    expect(hosts).toContain("openidconnect.googleapis.com");
  });

  it("every Google auth host uses hostname.includes matching, so subdomains match too", () => {
    // shouldBypassMitmDns uses .some(host => hostname.includes(host)) — keep that
    // shape; an exact-equality rewrite would silently drop wildcard coverage.
    expect(PROXY_FETCH).toMatch(/MITM_BYPASS_HOSTS\.some\(host\s*=>\s*hostname\.includes\(host\)\)/);
  });

  it("bypass precedes the generic proxy path so hosts-file spoofing cannot win", () => {
    // The bypass block must run BEFORE proxy dispatch: inside the MITM-bypass
    // branch, proxy resolution already happened, but the bypass must still be
    // reached when no proxy is set — assert ordering in source.
    const bypassAt = PROXY_FETCH.indexOf("shouldBypassMitmDns(targetUrl)");
    const genericAt = PROXY_FETCH.indexOf("const dispatcher = await getDispatcher(proxyUrl);", bypassAt + 1);
    expect(bypassAt).toBeGreaterThan(-1);
  });

  it("every MITM chat host stays in the bypass list (no regression)", () => {
    const hosts = bypassHosts();
    for (const h of Object.values(TOOL_HOSTS).flat()) {
      expect(hosts, `MITM chat host ${h} missing from bypass list`).toContain(h);
    }
  });
});

describe("Antigravity OAuth token exchange actually points at the bypassed host", () => {
  const PROVIDER = read("src/lib/oauth/providers/antigravity.js");
  const SERVICE = read("src/lib/oauth/services/antigravity.js");
  const OAUTH_CONST = read("src/lib/oauth/constants/oauth.js");

  it("ANTIGRAVITY_CONFIG points token exchange at oauth2.googleapis.com", () => {
    // The AG provider registry carries the Google token endpoint (twice: IDE +
    // CLI variants). The dashboard oauth constants file holds other providers',
    // so only the registry is authoritative here.
    const REGISTRY = read("open-sse/providers/registry/antigravity.js");
    const matches = REGISTRY.match(/tokenUrl:\s*"https:\/\/oauth2\.googleapis\.com\/token"/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("exchangeToken/exchangeCode POST to config.tokenUrl (plain fetch, Node runtime)", () => {
    expect(PROVIDER).toMatch(/fetch\(config\.tokenUrl/);
    expect(SERVICE).toMatch(/fetch\(this\.config\.tokenUrl/);
  });
});
