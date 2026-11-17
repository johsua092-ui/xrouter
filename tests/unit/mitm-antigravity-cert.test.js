/**
 * Regression: Antigravity MITM certificate trust (audit 2026-11-17).
 *
 * The reported failure was Antigravity's Go backend rejecting the MITM cert:
 *   Post "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist":
 *   tls: failed to verify certificate: x509: certificate signed by unknown authority
 *
 * Three defects produced it, plus one more found while fixing the third.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const MANAGER = read("src/mitm/manager.js");
const PATHS = read("src/mitm/paths.js");
const DATA_DIR_JS = read("src/lib/dataDir.js");
const ROUTE = read("src/app/api/cli-tools/antigravity-mitm/route.js");
const ALIAS_CACHE = read("src/lib/mitmAliasCache.js");

describe("finding 1 — Go backends get SSL_CERT_FILE, not just Node", () => {
  it("sets NODE_EXTRA_CA_CERTS (Electron) AND SSL_CERT_FILE (Go) on Windows", () => {
    // The backend that calls cloudcode-pa is language_server.exe — a Go binary.
    // Go's crypto/x509 reads SSL_CERT_FILE and ignores NODE_EXTRA_CA_CERTS, so
    // setting only the latter leaves the original error in place.
    expect(MANAGER).toMatch(/setx NODE_EXTRA_CA_CERTS/);
    expect(MANAGER).toMatch(/setx SSL_CERT_FILE/);
    expect(MANAGER).toMatch(/reg delete HKCU\\\\Environment \/F \/V SSL_CERT_FILE/);
  });

  it("sets both on macOS via launchctl too", () => {
    expect(MANAGER).toMatch(/launchctl setenv NODE_EXTRA_CA_CERTS/);
    expect(MANAGER).toMatch(/launchctl setenv SSL_CERT_FILE/);
    expect(MANAGER).toMatch(/launchctl unsetenv SSL_CERT_FILE/);
  });

  it("only sets them when the root CA actually exists on disk", () => {
    // Go does not fall back to the system store if SSL_CERT_FILE points at a
    // missing file, so an unguarded path would be worse than not setting it.
    const at = MANAGER.indexOf("const rootCAPath = path.join(MITM_DIR, \"rootCA.crt\")");
    const block = MANAGER.slice(at, at + 2600);
    expect(block).toMatch(/if \(fs\.existsSync\(rootCAPath\)\)/);
  });

  it("clears BOTH vars on stopServer, so no stale trust survives", () => {
    const at = MANAGER.indexOf("async function stopServer");
    const block = MANAGER.slice(at, at + 6000);
    expect(block).toMatch(/unsetenv NODE_EXTRA_CA_CERTS|reg delete.*NODE_EXTRA_CA_CERTS/);
    expect(block).toMatch(/unsetenv SSL_CERT_FILE|reg delete.*SSL_CERT_FILE/);
  });
});

describe("finding 2 — one DATA_DIR resolver, all platforms", () => {
  it("paths.js rejects Unix-style paths on Windows", () => {
    expect(PATHS).toMatch(/process\.platform === "win32" && \/\^\\\/\/\.test\(configured\)/);
  });

  it("paths.js guard matches dataDir.js exactly", () => {
    const guard = /win32" && \/\^\\\/\/\.test\(configured\)/;
    expect(DATA_DIR_JS).toMatch(guard);
    expect(PATHS).toMatch(guard);
    // Same fallback wording, so a single grep finds both logs.
    expect(DATA_DIR_JS).toMatch(/is a Unix path on Windows/);
    expect(PATHS).toMatch(/is a Unix path on Windows/);
  });

  it("mitmAliasCache no longer reads process.env.DATA_DIR raw", () => {
    // Raw reads bypassed the Windows guard and pointed the alias cache at
    // D:\var\lib\xrouter while the dashboard used %APPDATA%.
    expect(ALIAS_CACHE).not.toMatch(/process\.env\.DATA_DIR/);
    expect(ALIAS_CACHE).toMatch(/import \{ DATA_DIR \} from "\.\/dataDir\.js"/);
  });
});

describe("finding 3 — trust-cert is not blocked by the admin gate on Windows", () => {
  it("exempts trust-cert from checkPrivilege when on win32", () => {
    expect(ROUTE).toMatch(/const needsAdmin = !\(isWin && action === "trust-cert"\)/);
    expect(ROUTE).toMatch(/if \(needsAdmin && !checkPrivilege\(pwd\)\)/);
  });

  it("still gates enable/disable — those really need admin", () => {
    // The exemption must be narrow: DNS edits genuinely require elevation.
    expect(ROUTE).not.toMatch(/needsAdmin = !isWin/);
    expect(ROUTE).toMatch(/action === "enable"/);
    expect(ROUTE).toMatch(/action === "disable"/);
  });

  it("the elevation path it now reaches really exists", () => {
    // installCertWindows calls runElevatedPowerShell, which is defined in
    // winElevated.js and produces the UAC prompt via Start-Process -Verb RunAs.
    const INSTALL = read("src/mitm/cert/install.js");
    const WIN_ELEVATED = read("src/mitm/winElevated.js");
    expect(INSTALL).toMatch(/runElevatedPowerShell/);
    expect(INSTALL).toMatch(/certutil -addstore Root/);
    expect(WIN_ELEVATED).toMatch(/Start-Process/);
    expect(WIN_ELEVATED).toMatch(/-Verb RunAs/);
  });

  it("trustCert only demands sudo off Windows", () => {
    expect(MANAGER).toMatch(/if \(!IS_WIN && !password && isSudoPasswordRequired\(\)\) throw new Error\("Sudo password required to trust certificate"\)/);
  });
});

describe("smoke — modules load and resolve a real DATA_DIR", () => {
  const require = createRequire(import.meta.url);

  it("src/mitm/paths.js loads and exports a usable MITM_DIR", () => {
    const paths = require(resolve(root, "src/mitm/paths.js"));
    expect(typeof paths.DATA_DIR).toBe("string");
    expect(typeof paths.MITM_DIR).toBe("string");
    expect(paths.DATA_DIR.length).toBeGreaterThan(0);
    expect(paths.MITM_DIR.endsWith("mitm")).toBe(true);
    // No Windows-style split: MITM_DIR must sit under DATA_DIR.
    expect(paths.MITM_DIR.startsWith(paths.DATA_DIR)).toBe(true);
  });

  it("paths.js and dataDir.js agree on DATA_DIR for the current env", async () => {
    const cjs = require(resolve(root, "src/mitm/paths.js"));
    const esm = await import(resolve(root, "src/lib/dataDir.js"));
    if (process.platform === "win32") {
      // The whole point of finding 2: identical resolution on Windows.
      expect(cjs.DATA_DIR).toBe(esm.DATA_DIR);
    } else {
      expect(typeof esm.DATA_DIR).toBe("string");
      expect(esm.DATA_DIR.length).toBeGreaterThan(0);
    }
  });

  it("a Unix DATA_DIR on Windows falls back instead of creating D:\\var\\lib", () => {
    // Simulated, not executed: assert the guard precedes the mkdirSync call, so
    // a Unix path can never reach directory creation on Windows.
    const guardAt = PATHS.indexOf("is a Unix path on Windows");
    const mkdirAt = PATHS.indexOf("fs.mkdirSync(configured");
    expect(guardAt).toBeGreaterThan(-1);
    expect(mkdirAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(mkdirAt);
  });
});
