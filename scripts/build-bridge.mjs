#!/usr/bin/env node
/**
 * build-bridge.mjs — prepares the Go core binary for `bin/xrouter`.
 *
 * Three paths, in order:
 *   1. A Go toolchain is present  -> compile from ./cmd/xrouter.
 *   2. No toolchain, but a binary already exists -> keep it, report the reuse.
 *   3. Neither -> fail with the exact command to fix it.
 *
 * There is intentionally NO download step. The upstream release pipeline that
 * would host `xrouter-<os>-<arch>` artifacts does not exist in this repo (no
 * .github/workflows), so a downloader would only ever 404. Compiling locally is
 * the only honest path.
 *
 * `next build` is NOT invoked from here. The dashboard is still a Next.js
 * standalone app and must keep building through `npm run build`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const binExt = process.platform === "win32" ? ".exe" : "";
const binDir = path.join(root, "bin");
const binPath = path.join(binDir, `xrouter${binExt}`);

function hasGo() {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

fs.mkdirSync(binDir, { recursive: true });

if (!hasGo()) {
  if (fs.existsSync(binPath)) {
    const st = fs.statSync(binPath);
    console.log(`\u2713 Go core already built (${humanSize(st.size)}) \u2014 no Go toolchain, reusing it.`);
    process.exit(0);
  }
  console.error(
    "\u274c No Go toolchain and no prebuilt core.\n" +
      "   Install Go, then run: npm run build:go",
  );
  process.exit(1);
}

console.log("\u26a1 Go toolchain detected \u2014 compiling core...");
execFileSync(
  "go",
  ["build", "-trimpath", "-ldflags=-s -w", "-o", binPath, "./cmd/xrouter"],
  { cwd: root, stdio: "inherit" },
);

const size = fs.statSync(binPath).size;
console.log(`\u2713 Go core ready: bin/xrouter (${humanSize(size)})`);

if (process.platform !== "win32") {
  try {
    fs.chmodSync(binPath, 0o755);
  } catch {}
}
