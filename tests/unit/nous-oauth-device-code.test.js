import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

test("Nous OAuth device-code wiring in OAuthModal and OAuth API routes", () => {
  // 1. Verify OAuthModal registers nous under deviceCodeProviders
  const modalPath = path.join(rootDir, "src/shared/components/OAuthModal.js");
  const modalContent = fs.readFileSync(modalPath, "utf8");
  const deviceCodeMatch = modalContent.match(/const deviceCodeProviders = \[([\s\S]*?)\];/);
  assert.ok(deviceCodeMatch, "deviceCodeProviders array must exist in OAuthModal.js");
  assert.ok(
    deviceCodeMatch[1].includes('"nous"'),
    'deviceCodeProviders in OAuthModal.js must include "nous"'
  );

  // 2. Verify route.js registers nous under noPkceDeviceProviders (action === "device-code")
  const routePath = path.join(rootDir, "src/app/api/oauth/[provider]/[action]/route.js");
  const routeContent = fs.readFileSync(routePath, "utf8");
  const noPkceDeviceMatch = routeContent.match(/const noPkceDeviceProviders = \[([\s\S]*?)\];/);
  assert.ok(noPkceDeviceMatch, "noPkceDeviceProviders array must exist in route.js");
  assert.ok(
    noPkceDeviceMatch[1].includes('"nous"'),
    'noPkceDeviceProviders in route.js must include "nous"'
  );

  // 3. Verify route.js registers nous under noPkceProviders (action === "poll")
  const noPkcePollMatch = routeContent.match(/const noPkceProviders = \[([\s\S]*?)\];/);
  assert.ok(noPkcePollMatch, "noPkceProviders array must exist in route.js");
  assert.ok(
    noPkcePollMatch[1].includes('"nous"'),
    'noPkceProviders in route.js must include "nous"'
  );

  // 4. Verify nous provider export has flowType device_code
  const nousOAuthPath = path.join(rootDir, "src/lib/oauth/providers/nous.js");
  const nousOAuthContent = fs.readFileSync(nousOAuthPath, "utf8");
  assert.ok(
    nousOAuthContent.includes('flowType: "device_code"'),
    'nous.js must declare flowType: "device_code"'
  );
  assert.ok(
    nousOAuthContent.includes("requestDeviceCode:"),
    "nous.js must implement requestDeviceCode"
  );
  assert.ok(
    nousOAuthContent.includes("pollToken:"),
    "nous.js must implement pollToken"
  );
});
