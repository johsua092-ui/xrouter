import { defineConfig } from "vitest/config";
import { resolve } from "path";
import os from "node:os";
import crypto from 'node:crypto';
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Tests must never touch the real user DB (~/.xrouter): point DATA_DIR at a
    // throwaway directory for the whole run, otherwise fixtures write rows into
    // the live database (seeded keys/connections leak into production).
    env: {
      DATA_DIR: resolve(os.tmpdir(), "xrouter-test-data-" + process.pid),
      CREDENTIAL_VAULT_KEY: crypto.randomBytes(32).toString('base64'),
    },
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    maxWorkers: 4,
    testTimeout: 15000,
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
      { find: "@", replacement: resolve(__dirname, "../src") },
    ],
  },
});
