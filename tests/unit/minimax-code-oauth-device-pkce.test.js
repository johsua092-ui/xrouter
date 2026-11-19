import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

test("MiniMax Code OAuth device-code PKCE wiring and validation", async (t) => {
  // 1. Verify route.js does NOT exclude minimax-code / minimax-code-global from device-code PKCE
  const routePath = path.join(rootDir, "src/app/api/oauth/[provider]/[action]/route.js");
  const routeContent = fs.readFileSync(routePath, "utf8");
  const noPkceDeviceMatch = routeContent.match(/const noPkceDeviceProviders = \[([\s\S]*?)\];/);
  assert.ok(noPkceDeviceMatch, "noPkceDeviceProviders array must exist in route.js");
  assert.ok(
    !noPkceDeviceMatch[1].includes('"minimax-code"'),
    'noPkceDeviceProviders in route.js must NOT include "minimax-code" (requires PKCE challenge)'
  );
  assert.ok(
    !noPkceDeviceMatch[1].includes('"minimax-code-global"'),
    'noPkceDeviceProviders in route.js must NOT include "minimax-code-global" (requires PKCE challenge)'
  );

  // 2. Verify route.js does NOT exclude minimax-code / minimax-code-global from poll PKCE
  const noPkcePollMatch = routeContent.match(/const noPkceProviders = \[([\s\S]*?)\];/);
  assert.ok(noPkcePollMatch, "noPkceProviders array must exist in route.js");
  assert.ok(
    !noPkcePollMatch[1].includes('"minimax-code"'),
    'noPkceProviders in route.js must NOT include "minimax-code" (requires PKCE verifier on poll)'
  );
  assert.ok(
    !noPkcePollMatch[1].includes('"minimax-code-global"'),
    'noPkceProviders in route.js must NOT include "minimax-code-global" (requires PKCE verifier on poll)'
  );

  // 3. Verify OAuthModal registers minimax-code and minimax-code-global under deviceCodeProviders
  const modalPath = path.join(rootDir, "src/shared/components/OAuthModal.js");
  const modalContent = fs.readFileSync(modalPath, "utf8");
  const deviceCodeMatch = modalContent.match(/const deviceCodeProviders = \[([\s\S]*?)\];/);
  assert.ok(deviceCodeMatch, "deviceCodeProviders array must exist in OAuthModal.js");
  assert.ok(
    deviceCodeMatch[1].includes('"minimax-code"'),
    'deviceCodeProviders in OAuthModal.js must include "minimax-code"'
  );
  assert.ok(
    deviceCodeMatch[1].includes('"minimax-code-global"'),
    'deviceCodeProviders in OAuthModal.js must include "minimax-code-global"'
  );

  // 4. Verify minimax-code providers throw if codeChallenge is omitted
  const sharedPath = path.join(rootDir, "src/lib/oauth/providers/minimax-code-shared.js");
  const sharedContent = fs.readFileSync(sharedPath, "utf8");
  assert.ok(
    sharedContent.includes('if (!codeChallenge) throw new Error("MiniMax Code sign-in requires a PKCE code challenge");'),
    "minimax-code-shared.js must guard against missing codeChallenge"
  );
});
