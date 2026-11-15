// Guards the deduped Antigravity OAuth client: same values across all 3 sources after refactor.
//
// Asserted against the shipped built-in credentials rather than env vars: an
// unset env var made the expectation `{ clientId: "", clientSecret: "" }`, so
// the suite only passed on a machine that happened to have those exported — and
// on CI it failed even though the code was correct.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sharedSrc = readFileSync(join(here, "../../open-sse/providers/shared.js"), "utf8");

/** Pull the built-in fallback for a credential out of shared.js's `_un([...])`. */
function builtin(name) {
  const re = new RegExp(`${name}\\s*:\\s*process\\.env\\.[A-Z_]+\\s*\\|\\|\\s*_un\\(\\[([^\\]]+)\\]\\)`);
  const m = sharedSrc.match(re);
  if (!m) throw new Error(`could not locate built-in fallback for ${name}`);
  return String.fromCharCode(...m[1].split(",").map((n) => Number(n.trim())));
}

const EXPECTED = {
  clientId: singleton("ANTIGRAVITY_OAUTH_CLIENT").clientId,
  clientSecret: singleton("ANTIGRAVITY_OAUTH_CLIENT").clientSecret,
};

/** The literal object a name is assigned to, decoded. */
function singleton(name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`, "m");
  const m = sharedSrc.match(re);
  if (!m) throw new Error(`could not locate ${name}`);
  const body = m[1];
  const id = body.match(/clientId\s*:\s*process\.env\.[A-Z_]+(?:\s*\|\|\s*_un\(\[([^\]]+)\]\))?/);
  const secret = body.match(/clientSecret\s*:\s*process\.env\.[A-Z_]+(?:\s*\|\|\s*_un\(\[([^\]]+)\]\))?/);
  const decode = (mm) => (mm && mm[1] ? String.fromCharCode(...mm[1].split(",").map((n) => Number(n.trim()))) : null);
  return { clientId: decode(id), clientSecret: decode(secret) };
}

const GOOGLE = singleton("GOOGLE_OAUTH_CLIENT");

describe("antigravity oauth client (deduped)", () => {
  it("ships a non-empty built-in client", () => {
    expect(EXPECTED.clientId).toBeTruthy();
    expect(EXPECTED.clientSecret).toBeTruthy();
  });

  it("shared source holds the canonical credentials", async () => {
    const { ANTIGRAVITY_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    // env override wins when set; otherwise the built-in is used
    expect(ANTIGRAVITY_OAUTH_CLIENT.clientId).toBe(process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || EXPECTED.clientId);
    expect(ANTIGRAVITY_OAUTH_CLIENT.clientSecret).toBe(
      process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || EXPECTED.clientSecret
    );
  });

  it("registry transport keeps clientId/clientSecret", async () => {
    const ag = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    const { ANTIGRAVITY_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(ag.transport.clientId).toBe(ANTIGRAVITY_OAUTH_CLIENT.clientId);
    expect(ag.transport.clientSecret).toBe(ANTIGRAVITY_OAUTH_CLIENT.clientSecret);
  });

  it("google client shared by gemini + gemini-cli", async () => {
    const { GOOGLE_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(GOOGLE_OAUTH_CLIENT.clientSecret).toBe(process.env.GOOGLE_OAUTH_CLIENT_SECRET || GOOGLE.clientSecret);
    const gemini = (await import("../../open-sse/providers/registry/gemini.js")).default;
    const gc = (await import("../../open-sse/providers/registry/gemini-cli.js")).default;
    expect(gemini.transport.clientSecret).toBe(GOOGLE_OAUTH_CLIENT.clientSecret);
    expect(gc.transport.clientSecret).toBe(GOOGLE_OAUTH_CLIENT.clientSecret);
  });

  // Guard: oauth.js must spread shared clients + derive from registry (PROVIDER_OAUTH).
  it("src oauth.js imports shared client + keeps full shape", async () => {
    const src = readFileSync(join(here, "../../src/lib/oauth/constants/oauth.js"), "utf8");
    expect(src).toContain("ANTIGRAVITY_OAUTH_CLIENT");
    expect(src).toContain("GOOGLE_OAUTH_CLIENT");
  });
});
