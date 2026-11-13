#!/usr/bin/env node
/**
 * Pre-build cleaner.
 *
 * Drops the previous production build directory before a fresh `next build`.
 * A stale `.next` keeps the whole previous route graph on disk; the next
 * compilation has to read those manifests and cache files back on top of the
 * new build, which is the single largest avoidable memory spike per run.
 * Removing it first keeps the peak flat between consecutive builds.
 *
 * Only the build output is touched — sources, node_modules and any sibling
 * `NEXT_DIST_DIR` directory (e.g. `.next-dev`) are left alone.
 */
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = process.env.NEXT_DIST_DIR || ".next";
const target = join(projectRoot, distDir);

if (target === projectRoot) {
  console.error(`[cleanBuild] refusing to remove project root (${target})`);
  process.exit(1);
}

if (!existsSync(target)) {
  console.log(`[cleanBuild] nothing to remove (${distDir} absent)`);
  process.exit(0);
}

await rm(target, { recursive: true, force: true });
console.log(`[cleanBuild] removed ${distDir}`);
