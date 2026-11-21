import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../../src/middleware.js";

// Regression coverage for the tunnel false-403 bug: the Muse (Meta Model API)
// device-code connect flow POSTs /api/oauth/muse/poll from the dashboard and
// every call came back "Cross-origin request blocked" when the app sat behind a
// proxy that rewrites Host (abc-tunnel / cloudflared / nginx).

const PUBLIC_HOST = "edge-tunnel.example.net";
const INTERNAL_HOST = "127.0.0.1:20128";

function makeRequest({ url, method = "POST", headers = {} }) {
  return new NextRequest(url, { method, headers });
}

function isBlocked(res) {
  return res && res.status === 403;
}

describe("middleware origin gate", () => {
  const saved = {};
  const envKeys = ["BASE_URL", "PUBLIC_BASE_URL", "NEXT_PUBLIC_BASE_URL", "APP_URL", "SITE_URL", "NEXTAUTH_URL"];

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("allows a same-origin browser POST even when a tunnel rewrote Host", () => {
    const req = makeRequest({
      url: `http://${INTERNAL_HOST}/api/oauth/muse/poll`,
      headers: {
        origin: `https://${PUBLIC_HOST}`,
        "sec-fetch-site": "same-origin",
        host: INTERNAL_HOST,
      },
    });
    expect(isBlocked(middleware(req))).toBe(false);
  });

  it("allows same-site and navigational requests", () => {
    for (const site of ["same-site", "none"]) {
      const req = makeRequest({
        url: `http://${INTERNAL_HOST}/api/oauth/muse/exchange`,
        headers: { origin: `https://${PUBLIC_HOST}`, "sec-fetch-site": site, host: INTERNAL_HOST },
      });
      expect(isBlocked(middleware(req))).toBe(false);
    }
  });

  it("blocks a cross-site POST from a foreign origin", () => {
    const req = makeRequest({
      url: `http://${INTERNAL_HOST}/api/oauth/muse/poll`,
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        host: INTERNAL_HOST,
      },
    });
    expect(isBlocked(middleware(req))).toBe(true);
  });

  it("blocks a cross-site POST even when Origin is spoofed to the host", () => {
    const req = makeRequest({
      url: `http://${INTERNAL_HOST}/api/oauth/muse/poll`,
      headers: {
        origin: `http://${INTERNAL_HOST}`,
        "sec-fetch-site": "cross-site",
        host: INTERNAL_HOST,
      },
    });
    expect(isBlocked(middleware(req))).toBe(true);
  });

  it("allows a same-host POST without Sec-Fetch-Site (older browser)", () => {
    const req = makeRequest({
      url: `http://${INTERNAL_HOST}/api/oauth/muse/poll`,
      headers: { origin: `http://${INTERNAL_HOST}`, host: INTERNAL_HOST },
    });
    expect(isBlocked(middleware(req))).toBe(false);
  });

  it("allows an origin listed in the configured base URL env", () => {
    process.env.NEXT_PUBLIC_BASE_URL = `https://${PUBLIC_HOST}`;
    const req = makeRequest({
      url: `http://${INTERNAL_HOST}/api/oauth/muse/poll`,
      headers: { origin: `https://${PUBLIC_HOST}`, host: INTERNAL_HOST },
    });
    expect(isBlocked(middleware(req))).toBe(false);
  });

  it("allows an origin matching the first entry of a forwarded-host chain", () => {
    const req = makeRequest({
      url: `http://${INTERNAL_HOST}/api/oauth/muse/poll`,
      headers: {
        origin: `https://${PUBLIC_HOST}`,
        "x-forwarded-host": `${PUBLIC_HOST}, ${INTERNAL_HOST}`,
        host: INTERNAL_HOST,
      },
    });
    expect(isBlocked(middleware(req))).toBe(false);
  });

  it("passes a non-browser POST with no Origin or Sec-Fetch-Site", () => {
    const req = makeRequest({
      url: `http://${INTERNAL_HOST}/api/oauth/muse/poll`,
      headers: { host: INTERNAL_HOST },
    });
    expect(isBlocked(middleware(req))).toBe(false);
  });

  it("never gates read-only requests", () => {
    const req = makeRequest({
      url: `http://${INTERNAL_HOST}/api/oauth/muse/device-code`,
      method: "GET",
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(isBlocked(middleware(req))).toBe(false);
  });

  it("keeps the auth endpoints reachable cross-origin", () => {
    const req = makeRequest({
      url: `http://${INTERNAL_HOST}/api/auth/login`,
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(isBlocked(middleware(req))).toBe(false);
  });
});
