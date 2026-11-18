/**
 * RUNTIME SMOKE: prove the bypass body serialization actually works.
 *
 * createBypassRequest dynamic-imports node:https inside the module, so we can't
 * monkey-patch it from this process. Instead we run a REAL local TLS server
 * (self-signed) and point the bypass at 127.0.0.1 via a hosts-free trick: the
 * bypass resolves DNS through 8.8.8.8, so we simulate the "spoofed" environment
 * by calling the module's own exported patched fetch against a URL whose host
 * we map in /etc/hosts is NOT needed — instead we verify the serialization
 * contract directly: the exact code path (rawHeaders + bodyData + Content-Length)
 * extracted from source and executed against the real test payloads.
 *
 * This is the same expression list the fix introduced; keeping this smoke in
 * sync with the source is enforced by mitm-cert-oauth.test.js source asserts.
 */
const assert = require("assert");
const fs = require("fs");

const path = require("path");

const src = fs.readFileSync(path.resolve(__dirname, "../../open-sse/utils/proxyFetch.js"), "utf8");

// Extract the serialization block from createBypassRequest and eval it in isolation.
const start = src.indexOf("const rawHeaders = options.headers instanceof Headers");
const end = src.indexOf("const reqOptions = {", start);
assert(start > 0, "serialization block not found");
assert(end > start, "reqOptions not found after serialization block");
const block = src.slice(start, end);

function runBlock(options) {
  const fn = new Function("options", "Headers", "URLSearchParams", "Buffer", block + "\nreturn { rawHeaders, bodyData };");
  return fn(options, Headers, URLSearchParams, Buffer);
}

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name} -> ${e.message}`); }
};

console.log("createBypassRequest serialization smoke");

// 1. THE BUG: URLSearchParams body must serialize as form data, not "{}"
check("URLSearchParams body -> form-encoded string", () => {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "r1", client_id: "c1", client_secret: "s1" });
  const { rawHeaders, bodyData } = runBlock({ headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  assert.strictEqual(bodyData, "grant_type=refresh_token&refresh_token=r1&client_id=c1&client_secret=s1");
  assert.strictEqual(rawHeaders["Content-Length"], String(Buffer.byteLength(bodyData)));
});

// 2. web Headers instance must be normalized (was: spread -> {})
check("Headers instance -> plain object with entries", () => {
  const h = new Headers({ "Content-Type": "application/json", "X-Test": "yes" });
  const { rawHeaders, bodyData } = runBlock({ headers: h, body: JSON.stringify({ a: 1 }) });
  // Web Headers lowercases names — that's the fetch() contract; the bug was
  // the whole object coming through as {} (spread of a Headers instance).
  assert.strictEqual(rawHeaders["content-type"], "application/json");
  assert.strictEqual(rawHeaders["x-test"], "yes");
  assert.strictEqual(bodyData, '{"a":1}');
});

// 3. plain object headers still work
check("plain object headers pass through", () => {
  const { rawHeaders } = runBlock({ headers: { Authorization: "Bearer x" }, body: "hi" });
  assert.strictEqual(rawHeaders.Authorization, "Bearer x");
});

// 4. Content-Length auto-set for string body
check("string body gets Content-Length", () => {
  const { rawHeaders, bodyData } = runBlock({ headers: {}, body: "hello" });
  assert.strictEqual(bodyData, "hello");
  assert.strictEqual(rawHeaders["Content-Length"], "5");
});

// 5. existing Content-Length preserved (case-insensitive)
check("caller Content-Length not overridden", () => {
  const { rawHeaders } = runBlock({ headers: { "content-length": "99" }, body: "hello" });
  assert.strictEqual(rawHeaders["content-length"], "99");
  assert.strictEqual(rawHeaders["Content-Length"], undefined);
});

// 6. GET (no body) -> no bodyData, no Content-Length
check("no body -> no Content-Length injected", () => {
  const { bodyData, rawHeaders } = runBlock({ headers: { Accept: "application/json" } });
  assert.strictEqual(bodyData, null);
  assert.strictEqual(rawHeaders["Content-Length"], undefined);
});

// 7. Buffer body passes through as-is
check("Buffer body passes through", () => {
  const buf = Buffer.from([1, 2, 3]);
  const { bodyData, rawHeaders } = runBlock({ headers: {}, body: buf });
  assert.ok(Buffer.isBuffer(bodyData));
  assert.strictEqual(rawHeaders["Content-Length"], "3");
});

// 8. plain JSON object (the old path) still stringifies
check("plain object body still JSON.stringify'd", () => {
  const { bodyData } = runBlock({ headers: {}, body: { grant_type: "x" } });
  assert.strictEqual(bodyData, '{"grant_type":"x"}');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
