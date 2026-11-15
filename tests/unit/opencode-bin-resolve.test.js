import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// These tests cover the Windows resolution gap in resolveOpencodeBin.
//
// The original candidate list is Unix-only:
//   /usr/local/bin/opencode
//   ~/.opencode/bin/opencode
//   /usr/bin/opencode
// On Windows none of those exist (the install is under %LOCALAPPDATA% or the
// npm global prefix, and the file carries a .exe suffix), so resolution fell
// through to the bare name "opencode" and only worked if it happened to be on
// PATH. A missing daemon binary surfaces as a 502 on the whole free lane.
//
// The resolver is imported through the module's public surface. If it is not
// exported, these tests fail — that is deliberate: an untestable resolver is
// how the gap survived in the first place.

let mod = null;

beforeEach(async () => {
  mod = await import("../../open-sse/services/opencodeServiceBridge.js");
});

afterEach(() => {
  delete process.env.OPENCODE_BIN;
});

const resolve = () => mod.resolveOpencodeBin;

describe("resolveOpencodeBin platform coverage", () => {
  it("is exported so the resolver can be tested", () => {
    expect(typeof resolve()).toBe("function");
  });

  it("honours OPENCODE_BIN when it points at an existing file", () => {
    const tmp = path.join(os.tmpdir(), `fake-opencode-${process.pid}`);
    fs.writeFileSync(tmp, "#!/bin/sh\n");
    process.env.OPENCODE_BIN = tmp;

    expect(resolve()()).toBe(tmp);

    fs.unlinkSync(tmp);
  });

  it("ignores OPENCODE_BIN when the path does not exist", () => {
    process.env.OPENCODE_BIN = path.join(os.tmpdir(), "definitely-not-here-xyz");
    expect(resolve()()).not.toBe(process.env.OPENCODE_BIN);
  });

  it("returns a non-empty string even when nothing is installed", () => {
    const got = resolve()();
    expect(typeof got).toBe("string");
    expect(got.length).toBeGreaterThan(0);
  });
});

describe("resolveOpencodeBin Windows candidates", () => {
  it("builds a Windows candidate list including the .exe suffix", () => {
    // The Windows branch must be reachable from the platform flag rather than
    // hardcoded, so it can be exercised on a Linux CI box.
    const list = mod.opencodeBinCandidates({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local", APPDATA: "C:\\Users\\t\\AppData\\Roaming", USERPROFILE: "C:\\Users\\t" },
      homedir: "C:\\Users\\t",
    });

    expect(list.some((c) => c.endsWith("opencode.exe"))).toBe(true);
    expect(list.some((c) => c.includes("AppData"))).toBe(true);
  });

  it("uses .cmd/.exe npm shims on Windows since the npm global bin is a shim", () => {
    const list = mod.opencodeBinCandidates({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\t\\AppData\\Roaming" },
      homedir: "C:\\Users\\t",
    });

    const hasShim = list.some((c) => /opencode\.(exe|cmd|ps1)$/i.test(c));
    expect(hasShim).toBe(true);
  });

  it("keeps Unix candidates on a Unix platform and never mixes in .exe", () => {
    const list = mod.opencodeBinCandidates({
      platform: "linux",
      env: {},
      homedir: "/home/t",
    });

    expect(list).toContain("/usr/local/bin/opencode");
    expect(list).toContain("/usr/bin/opencode");
    expect(list.some((c) => c.endsWith(".exe"))).toBe(false);
  });
});
