/**
 * Regression: after every server rebuild, open tabs showed the built-in Next.js
 * global-error screen because their cached HTML referenced chunk hashes that no
 * longer exist (ChunkLoadError on lazy route load). The fix ships a custom
 * src/app/global-error.js that auto-reloads once for stale-chunk errors, with a
 * loop guard so a genuinely broken page can't reload forever.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const file = resolve(root, "src/app/global-error.js");
const src = existsSync(file) ? readFileSync(file, "utf8") : "";

describe("custom global-error boundary exists", () => {
  it("src/app/global-error.js exists (overrides the built-in boundary)", () => {
    expect(existsSync(file)).toBe(true);
  });

  it("is a client component (must run in the browser to reload)", () => {
    expect(src).toMatch(/["']use client["']/);
  });

  it("renders its own <html>/<body> — required by the global-error contract", () => {
    expect(src).toMatch(/<html/);
    expect(src).toMatch(/<body/);
  });
});

describe("stale-chunk detection", () => {
  it("recognizes ChunkLoadError and dynamic-import failures", () => {
    expect(src).toMatch(/ChunkLoadError/);
    expect(src).toMatch(/Loading chunk/i);
    expect(src).toMatch(/Failed to fetch dynamically imported module/i);
    expect(src).toMatch(/error while loading route/i);
  });

  it("ignores server-error digests — a 500 must NOT trigger a reload loop", () => {
    // Next marks server errors with a digest; reloading those wouldn't help
    // and would loop. The detector must bail on them.
    expect(src).toMatch(/digest/);
    expect(src).toMatch(/NEXT_|DYNAMIC_SERVER_USAGE/);
  });
});

describe("reload loop guard", () => {
  it("counts reloads in sessionStorage with a max", () => {
    expect(src).toMatch(/sessionStorage/);
    expect(src).toMatch(/MAX_AUTO_RELOADS\s*=\s*\d+/);
    expect(src).toMatch(/RELOAD_WINDOW_MS\s*=\s*\d+/);
  });

  it("uses location.replace, not location.reload, so Back skips the broken entry", () => {
    expect(src).toMatch(/window\.location\.replace\(window\.location\.href\)/);
  });
});

describe("boundary must be dependency-free", () => {
  it("imports nothing but react", () => {
    const imports = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports.length).toBe(1);
    expect(imports[0]).toMatch(/from "react"/);
  });

  it("offers manual Reload + reset fallback in the UI", () => {
    expect(src).toMatch(/Reload/);
    expect(src).toMatch(/onClick=\{\(\) => reset\(\)\}/);
  });
});
