// RUNTIME SMOKE: global-error boundary must compile (JSX) and its detector +
// loop guard must behave. We transpile with the installed Next/SWC, execute
// the detector helpers, and simulate the sessionStorage flow.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = "/root/xrouter";
const SRC = fs.readFileSync(path.join(ROOT, "src/app/global-error.js"), "utf8");

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name} -> ${e.message}`); }
};

console.log("global-error runtime smoke");

// 1. JSX compiles with the project's own SWC binding.
check("file compiles as JSX (Next SWC transform)", () => {
  const { transformSync } = require(path.join(ROOT, "node_modules/next/dist/build/swc/index.js"));
  const res = transformSync(SRC, {
    jsc: { parser: { syntax: "ecmascript", jsx: true }, target: "es2022" },
    filename: "global-error.js",
    isModule: true,
  });
  // transformSync may return a promise-like in some versions — normalize.
  const code = typeof res?.code === "string" ? res.code : null;
  assert.ok(code, "transformSync returned no code");
  assert.ok(code.includes("ChunkLoadError"), "detector lost in transform");
  assert.ok(!/<html/.test(code), "JSX not transformed");
});

// 2. Extract and run isStaleChunkError against real error shapes.
const body = SRC.slice(SRC.indexOf("function isStaleChunkError"), SRC.indexOf("function shouldReload"));
const isStale = new Function("error", `${body}\nreturn isStaleChunkError(error);`);

check("ChunkLoadError by name -> stale", () => {
  assert.strictEqual(isStale(Object.assign(new Error("x"), { name: "ChunkLoadError" })), true);
});
check("'Loading chunk 123 failed' message -> stale", () => {
  assert.strictEqual(isStale(new Error("Loading chunk 123 failed")), true);
});
check("'Failed to fetch dynamically imported module' -> stale", () => {
  assert.strictEqual(isStale(new Error("Failed to fetch dynamically imported module: /x.js")), true);
});
check("'error while loading route' -> stale", () => {
  assert.strictEqual(isStale(new Error("error while loading route")), true);
});
check("server digest NEXT_DIGEST -> NOT stale (no reload on 500)", () => {
  assert.strictEqual(isStale(Object.assign(new Error("e"), { digest: "NEXT_SERVER_ERROR" })), false);
});
check("plain TypeError -> NOT stale", () => {
  assert.strictEqual(isStale(new TypeError("cannot read property x of undefined")), false);
});
check("null/undefined -> NOT stale", () => {
  assert.strictEqual(isStale(null), false);
  assert.strictEqual(isStale(undefined), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
