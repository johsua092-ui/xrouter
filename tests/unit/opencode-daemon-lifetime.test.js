/**
 * Regression: opencode daemon pool lifetime bugs.
 *
 * Covers two defects found in the audit of 4d6c600 plus one found while fixing:
 *
 *   1. GHOST EVICTION — retiring an unhealthy pool entry left its 10-minute
 *      reaper armed. The stale timer then fired and deleted whatever occupied
 *      the poolKey at that moment, disowning the *healthy* replacement daemon.
 *   2. SIGPIPE — detachLogPipes() called .destroy() on stdout/stderr while
 *      `opencode serve --print-logs` was still running, so the daemon's next log
 *      write killed it silently.
 *   3. Kill ordering — abandonDaemon() destroyed the pipes BEFORE signalling,
 *      opening a window where the process died of SIGPIPE instead of our SIGKILL.
 *
 * These are pool/timer/pipe invariants, so they are asserted against the module
 * source contract rather than by spawning a real 175 MB daemon.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  resolve(here, "../../open-sse/services/opencodeServiceBridge.js"),
  "utf8",
);

/** Extract a top-level function body by brace matching from its signature. */
function body(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = SRC.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}") {
      depth--;
      if (depth === 0) return SRC.slice(i, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe("opencode daemon pool — lifetime invariants", () => {
  describe("scheduleDaemonReaper", () => {
    const reaper = body("scheduleDaemonReaper");

    it("verifies slot identity before evicting (no ghost eviction)", () => {
      // The reaper must compare the current pool entry against its own captured
      // `info` and bail when they differ. Without this a stale timer deletes a
      // live replacement daemon.
      expect(reaper).toMatch(/proxyDaemonPool\.get\(poolKey\)/);
      expect(reaper).toMatch(/current\s*!==\s*info/);
      expect(reaper).toMatch(/return/);
    });

    it("deletes the pool slot BEFORE killing, and clears its own handle", () => {
      const del = reaper.indexOf("proxyDaemonPool.delete(poolKey)");
      const kill = reaper.indexOf("killDaemonProcess(info.process)");
      expect(del).toBeGreaterThan(-1);
      expect(kill).toBeGreaterThan(-1);
      expect(del).toBeLessThan(kill);
      // Releasing the handle prevents the timer being cleared after it already fired.
      expect(reaper).toMatch(/info\.reaperTimer\s*=\s*null/);
    });
  });

  describe("detachLogPipes", () => {
    // The inline const, not a top-level function — grab it by its declaration.
    const at = SRC.indexOf("const detachLogPipes");
    const block = SRC.slice(at, SRC.indexOf("};", at));

    it("does NOT destroy the pipes — the writer is still alive", () => {
      // destroy() on a live writer's pipe == SIGPIPE == silent daemon death.
      expect(block).not.toMatch(/stdout\?\.destroy/);
      expect(block).not.toMatch(/stderr\?\.destroy/);
    });

    it("keeps the fds open by draining instead", () => {
      expect(block).toMatch(/stdout\?\.resume/);
      expect(block).toMatch(/stderr\?\.resume/);
    });

    it("still unhooks the data listeners (leak-free detach)", () => {
      expect(block).toMatch(/removeListener\("data",\s*onData\)/);
    });
  });

  describe("abandonDaemon", () => {
    const abandon = body("abandonDaemon");

    it("signals BEFORE reaping descriptors", () => {
      // Kill now routes through killDaemonProcess() so Windows gets the
      // taskkill /T tree walk; ordering against the pipe teardown is what this
      // test guards.
      const kill = abandon.indexOf("killDaemonProcess(p)");
      const destroy = abandon.indexOf("stdout?.destroy");
      expect(kill).toBeGreaterThan(-1);
      expect(destroy).toBeGreaterThan(-1);
      expect(kill).toBeLessThan(destroy);
    });
  });

  describe("retiring an unhealthy cached entry", () => {
    const at = SRC.indexOf("const existing = proxyDaemonPool.get(poolKey)");
    const block = SRC.slice(at, at + 900);

    it("clears the stale reaper timer AND removes the slot", () => {
      expect(block).toMatch(/existing\.reaperTimer/);
      expect(block).toMatch(/clearTimeout\(existing\.reaperTimer\)/);
      expect(block).toMatch(/proxyDaemonPool\.delete\(poolKey\)/);
      // Deletion must precede the kill for the same reason as the reaper. The
      // kill itself now goes through killDaemonProcess().
      const del = block.indexOf("proxyDaemonPool.delete(poolKey)");
      const kill = block.indexOf("killDaemonProcess(existing.process)");
      expect(del).toBeGreaterThan(-1);
      expect(kill).toBeGreaterThan(-1);
      expect(del).toBeLessThan(kill);
    });
  });
});
