/**
 * Regression: OpenCode resource-lifetime hardening (audit round 2).
 *
 * Five findings, all verified against the source at HEAD:
 *   1. opencodeTlsClient sessionCache had no cap — rotating proxies leaked
 *      native wreq/Rust sessions that V8 GC can never reclaim.
 *   2. Windows daemon kill used child.kill() on a `shell: true` spawn, so it
 *      reaped cmd.exe and orphaned opencode.exe (~175 MB, port still held).
 *   3. serviceSessionPool had a size cap but no TTL: sessions on an EXTERNAL
 *      daemon are never reached by the daemon reaper, so they pinned a /api/event
 *      long-poll plus a WebSocket until the 100-entry cap filled.
 *   4. The 30s graceful-drain setTimeout in the MCP relay was not unref'd, so it
 *      pinned the event loop.
 *   5. process.on("SIGINT"/"SIGTERM") suppressed the default exit and the handler
 *      never called process.exit(), so Ctrl+C swept daemons then hung.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, "../../open-sse/services", p), "utf8");
const BRIDGE = read("opencodeServiceBridge.js");
const TLS = read("opencodeTlsClient.js");

function body(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe("finding 1 — TLS sessionCache is bounded (LRU)", () => {
  it("declares a cap and evicts down to it", () => {
    expect(TLS).toMatch(/const MAX_TLS_SESSIONS = \d+/);
    const evict = body(TLS, "evictTlsSessionsOverCap");
    expect(evict).toMatch(/sessionCache\.size > MAX_TLS_SESSIONS/);
  });

  it("closes native sessions it drops (the whole point of the cap)", () => {
    const evict = body(TLS, "evictTlsSessionsOverCap");
    expect(evict).toMatch(/sessionCache\.delete\(/);
    expect(evict).toMatch(/\.close\?\.\(\)/);
  });

  it("re-inserts cache hits so a hot proxy is not evicted first", () => {
    const get = body(TLS, "getSession");
    expect(get).toMatch(/sessionCache\.delete\(cacheKey\)/);
    expect(get).toMatch(/sessionCache\.set\(cacheKey, hit\)/);
  });
});

describe("finding 2 — daemon kill walks the process tree on Windows", () => {
  it("uses taskkill /F /T, not a bare child.kill()", () => {
    const kill = body(BRIDGE, "killDaemonProcess");
    expect(kill).toMatch(/taskkill \/F \/T \/PID/);
    expect(kill).toMatch(/process\.platform === "win32"/);
  });

  it("imports execSync", () => {
    expect(BRIDGE).toMatch(/import \{ spawn, execSync \} from "child_process"/);
  });

  it("routes EVERY daemon kill through the helper", () => {
    // No stray direct kills left behind — a partial migration leaves the
    // Windows orphan open on whichever path kept the old call.
    expect(BRIDGE).not.toMatch(/info\.process\?\.kill/);
    expect(BRIDGE).not.toMatch(/oldest\?\.process\?\.kill/);
    expect(BRIDGE).not.toMatch(/existing\.process\.kill\(\)/);
    expect(BRIDGE).toMatch(/killDaemonProcess\(info\.process\)/);
    expect(BRIDGE).toMatch(/killDaemonProcess\(oldest\?\.process\)/);
    expect(BRIDGE).toMatch(/killDaemonProcess\(existing\.process\)/);
  });
});

describe("finding 3 — serviceSessionPool has an idle TTL", () => {
  it("declares the idle window and a sweep interval", () => {
    expect(BRIDGE).toMatch(/SERVICE_SESSION_IDLE_TIMEOUT_MS = 30 \* 60 \* 1000/);
    expect(BRIDGE).toMatch(/setInterval\(sweepIdleServiceSessions/);
  });

  it("unrefs the sweep timer so housekeeping cannot hold the process", () => {
    expect(BRIDGE).toMatch(/serviceSessionSweepTimer\.unref/);
  });

  it("NEVER sweeps a session that owns in-flight work", () => {
    const sweep = body(BRIDGE, "sweepIdleServiceSessions");
    expect(sweep).toMatch(/session\.inFlight/);
    expect(sweep).toMatch(/session\.activeTurn/);
    expect(sweep).toMatch(/pendingCalls\?\.size > 0/);
    expect(sweep).toMatch(/queuedCalls\?\.length > 0/);
    // Busy sessions must be refreshed and skipped, not closed.
    expect(sweep).toMatch(/session\.lastUsedAt = now;\s*\n\s*continue;/);
  });

  it("closes and removes only genuinely idle sessions", () => {
    const sweep = body(BRIDGE, "sweepIdleServiceSessions");
    expect(sweep).toMatch(/idleFor < SERVICE_SESSION_IDLE_TIMEOUT_MS\) continue/);
    expect(sweep).toMatch(/session\.close\(\)/);
    expect(sweep).toMatch(/serviceSessionPool\.delete\(key\)/);
  });

  it("tracks usage on both event and turn boundaries", () => {
    expect(BRIDGE).toMatch(/this\.lastUsedAt = this\.lastEventAt/);
    expect(BRIDGE).toMatch(/this\.inFlight = true/);
    expect(BRIDGE).toMatch(/this\.inFlight = false/);
  });
});

describe("finding 4 — MCP relay drain timer is unref'd", () => {
  it("unrefs the 30s graceful drain", () => {
    expect(BRIDGE).toMatch(/const drainTimer = setTimeout\(/);
    expect(BRIDGE).toMatch(/if \(drainTimer\.unref\) drainTimer\.unref\(\)/);
    expect(BRIDGE).toMatch(/\}, 30_000\);/);
  });
});

describe("finding 5 — SIGINT/SIGTERM actually terminate", () => {
  it("calls process.exit after the sweep", () => {
    expect(BRIDGE).toMatch(/process\.exit\(signal === "SIGINT" \? 130 : 143\)/);
  });

  it("uses once(), so a second Ctrl+C cannot queue another sweep", () => {
    expect(BRIDGE).toMatch(/process\.once\("SIGINT"/);
    expect(BRIDGE).toMatch(/process\.once\("SIGTERM"/);
    expect(BRIDGE).not.toMatch(/process\.on\("SIGINT"/);
    expect(BRIDGE).not.toMatch(/process\.on\("SIGTERM"/);
  });

  it("keeps the plain exit handler (it cannot await, only sweep)", () => {
    expect(BRIDGE).toMatch(/process\.on\("exit", cleanupAllDaemons\)/);
  });
});

describe("previously-fixed invariants still hold", () => {
  it("reaper still refuses to evict a slot it no longer owns", () => {
    expect(BRIDGE).toMatch(/if \(current !== info\)/);
  });

  it("detachLogPipes still drains instead of destroying", () => {
    const at = BRIDGE.indexOf("const detachLogPipes");
    const block = BRIDGE.slice(at, BRIDGE.indexOf("};", at));
    expect(block).not.toMatch(/stdout\?\.destroy/);
    expect(block).toMatch(/stdout\?\.resume/);
  });
});
