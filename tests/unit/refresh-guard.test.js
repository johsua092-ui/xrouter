// Refresh guard: connections without a refreshToken must never enter the refresh
// pipeline, and a failed refresh must back off instead of retrying on every request
// or every scheduler tick. Also covers the per-tick batch cap.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refreshProviderCredentials = vi.fn();

vi.mock("../../src/lib/localDb.js", () => ({
  updateProviderConnection: vi.fn(async () => true),
}));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(async () => null),
  invalidateProjectId: vi.fn(),
  removeConnection: vi.fn(),
}));

vi.mock("open-sse/services/oauthCredentialManager.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    refreshProviderCredentials: (...args) => refreshProviderCredentials(...args),
  };
});

const {
  canRefreshCredentials,
  getRefreshCooldown,
  markRefreshCooldown,
  clearRefreshCooldown,
  resetRefreshCooldowns,
} = await import("../../open-sse/services/oauthCredentialManager.js");

const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
const { runBackgroundTokenRefreshTick } = await import(
  "../../src/sse/services/backgroundTokenRefresh.js"
);
const { REFRESH_GUARD_CONFIG } = await import("../../open-sse/config/runtimeConfig.js");

const EXPIRED = new Date(Date.now() - 60_000).toISOString();

function conn(overrides = {}) {
  return {
    id: "conn-1",
    connectionId: "conn-1",
    provider: "antigravity",
    authType: "oauth",
    accessToken: "stale-access-token",
    refreshToken: "refresh-token-value",
    expiresAt: EXPIRED,
    ...overrides,
  };
}

beforeEach(() => {
  refreshProviderCredentials.mockReset();
  resetRefreshCooldowns();
});

afterEach(() => {
  resetRefreshCooldowns();
});

describe("canRefreshCredentials", () => {
  it("rejects missing, empty and whitespace-only refreshToken", () => {
    expect(canRefreshCredentials("antigravity", {})).toBe(false);
    expect(canRefreshCredentials("antigravity", { refreshToken: "" })).toBe(false);
    expect(canRefreshCredentials("antigravity", { refreshToken: "   " })).toBe(false);
    expect(canRefreshCredentials("antigravity", { refreshToken: null })).toBe(false);
    expect(canRefreshCredentials("antigravity", null)).toBe(false);
  });

  it("accepts a real refreshToken", () => {
    expect(canRefreshCredentials("antigravity", { refreshToken: "abc" })).toBe(true);
  });

  it("accepts providers that refresh without a refreshToken", () => {
    expect(canRefreshCredentials("vertex", {})).toBe(true);
    expect(canRefreshCredentials("vertex-partner", {})).toBe(true);
    expect(canRefreshCredentials("zed", {})).toBe(true);
  });
});

describe("refresh cooldown store", () => {
  it("marks, reports and clears a cooldown", () => {
    const c = conn();
    expect(getRefreshCooldown("antigravity", c)).toBe(0);

    const applied = markRefreshCooldown("antigravity", c, "no_refresh_token");
    expect(applied).toBe(REFRESH_GUARD_CONFIG.noRefreshTokenCooldownMs);
    expect(getRefreshCooldown("antigravity", c)).toBeGreaterThan(0);

    clearRefreshCooldown("antigravity", c);
    expect(getRefreshCooldown("antigravity", c)).toBe(0);
  });

  it("expires a cooldown once its deadline passes", () => {
    const c = conn();
    const t0 = 1_000_000;
    markRefreshCooldown("antigravity", c, "refresh_failed", t0);
    const ttl = REFRESH_GUARD_CONFIG.failureCooldownMs;

    expect(getRefreshCooldown("antigravity", c, t0 + ttl - 1)).toBeGreaterThan(0);
    expect(getRefreshCooldown("antigravity", c, t0 + ttl + 1)).toBe(0);
  });

  it("keys by connection so two accounts do not share a cooldown", () => {
    const a = conn({ id: "a", connectionId: "a" });
    const b = conn({ id: "b", connectionId: "b" });
    markRefreshCooldown("antigravity", a, "refresh_failed");
    expect(getRefreshCooldown("antigravity", a)).toBeGreaterThan(0);
    expect(getRefreshCooldown("antigravity", b)).toBe(0);
  });
});

describe("checkAndRefreshToken with an empty connection", () => {
  it("never calls refresh and returns the credentials untouched", async () => {
    const c = conn({ refreshToken: "" });
    const out = await checkAndRefreshToken("antigravity", c);

    expect(refreshProviderCredentials).not.toHaveBeenCalled();
    expect(out.accessToken).toBe("stale-access-token");
  });

  it("does not retry on the next call either", async () => {
    const c = conn({ refreshToken: undefined });
    await checkAndRefreshToken("antigravity", c);
    await checkAndRefreshToken("antigravity", c, { force: true });
    await checkAndRefreshToken("antigravity", c);

    expect(refreshProviderCredentials).not.toHaveBeenCalled();
    expect(getRefreshCooldown("antigravity", c)).toBeGreaterThan(0);
  });
});

describe("checkAndRefreshToken failure backoff", () => {
  it("refreshes once, then backs off instead of hammering upstream", async () => {
    refreshProviderCredentials.mockResolvedValue(null);
    const c = conn();

    await checkAndRefreshToken("antigravity", c);
    expect(refreshProviderCredentials).toHaveBeenCalledTimes(1);
    expect(getRefreshCooldown("antigravity", c)).toBeGreaterThan(0);

    await checkAndRefreshToken("antigravity", c);
    await checkAndRefreshToken("antigravity", c);
    expect(refreshProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("does not let force bypass an active cooldown", async () => {
    const c = conn();
    markRefreshCooldown("antigravity", c, "refresh_failed");
    refreshProviderCredentials.mockResolvedValue({ accessToken: "fresh", expiresIn: 3600 });

    await checkAndRefreshToken("antigravity", c, { force: true });

    // Background ticks pass force:true; a cooling connection must still be skipped.
    expect(refreshProviderCredentials).not.toHaveBeenCalled();
  });

  it("clears the cooldown after a successful refresh", async () => {
    const c = conn();
    refreshProviderCredentials.mockResolvedValue({ accessToken: "fresh", expiresIn: 3600 });

    const out = await checkAndRefreshToken("antigravity", c, { force: true });

    expect(refreshProviderCredentials).toHaveBeenCalledTimes(1);
    expect(out.accessToken).toBe("fresh");
    expect(getRefreshCooldown("antigravity", c)).toBe(0);
  });
});

describe("background tick guard", () => {
  const originalMax = REFRESH_GUARD_CONFIG.maxPerTick;

  afterEach(() => {
    REFRESH_GUARD_CONFIG.maxPerTick = originalMax;
  });

  it("caps how many connections one tick refreshes", async () => {
    REFRESH_GUARD_CONFIG.maxPerTick = 2;
    const connections = Array.from({ length: 5 }, (_, i) =>
      conn({ id: `c${i}`, connectionId: `c${i}`, email: `c${i}@example.com` })
    );
    const refresh = vi.fn(async () => ({}));

    await runBackgroundTokenRefreshTick({
      loadConnections: async () => connections,
      refreshConnection: refresh,
      sleep: async () => {},
    });

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("skips connections already on cooldown", async () => {
    const cooling = conn({ id: "cool", connectionId: "cool", email: "cool@example.com" });
    const healthy = conn({ id: "ok", connectionId: "ok", email: "ok@example.com" });
    markRefreshCooldown("antigravity", cooling, "no_refresh_token");

    const refresh = vi.fn(async () => ({}));
    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [cooling, healthy],
      refreshConnection: refresh,
      sleep: async () => {},
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0].id).toBe("ok");
  });
});
