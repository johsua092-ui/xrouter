#!/usr/bin/env node
/**
 * start-bridge.js — launches the Go core and the Next.js dashboard together.
 *
 * Behaviour contract:
 *   - Go core        -> PORT_GO   (default 8080)
 *   - Next dashboard -> PORT      (default 20128)
 *   - Both get stdio: "inherit" so logs stay in the same terminal/tmux pane.
 *   - SIGINT/SIGTERM are forwarded to both children, then we wait for them.
 *   - NO automatic fallback: if the Go core dies, we tear the whole thing down
 *     and exit with its status. A silent Node-only fallback would leave an
 *     operator unable to tell which runtime is actually serving traffic.
 *
 * The dashboard is deliberately NOT served by Go. `dashboard_dist/` does not
 * exist yet and the embedded handler is still a placeholder, so pointing the
 * browser at the Go port would return a white screen. Node keeps owning the UI.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const binExt = process.platform === "win32" ? ".exe" : "";
const goBin = path.join(root, "bin", `xrouter${binExt}`);

if (!fs.existsSync(goBin)) {
  console.error(
    `\u274c Go core not built at ${goBin}\n` +
      `   Run: npm run build:go`,
  );
  process.exit(1);
}

const goPort = process.env.PORT_GO || "8080";
const nodePort = process.env.PORT || "20128";

console.log(`\u26a1 Go core        -> http://127.0.0.1:${goPort}`);
console.log(`\u26a1 Dashboard      -> http://127.0.0.1:${nodePort}`);
console.log("");

const children = [];
let shuttingDown = false;

function launch(label, cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });

  child.on("error", (err) => {
    console.error(`[${label}] failed to start: ${err.message}`);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    // The Go core is the reason this launcher exists. If it exits, the session
    // is over — do not keep a half-alive Node dashboard pretending otherwise.
    if (label === "go") {
      console.error(
        `[go] exited (code=${code} signal=${signal ?? "none"}); shutting down.`,
      );
      shutdown(code ?? 1);
    } else {
      console.error(`[dashboard] exited (code=${code} signal=${signal ?? "none"}).`);
    }
  });

  children.push({ label, child });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    try {
      if (child.exitCode === null) child.kill("SIGTERM");
    } catch {}
  }
  // Give children a moment to flush, then exit regardless.
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

launch("go", goBin, [], { PORT: goPort });

launch(
  "dashboard",
  process.execPath,
  [
    "--expose-gc",
    "--max-old-space-size=512",
    "custom-server.js",
  ],
  { PORT: nodePort },
);
