import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

test("Nous OAuth test configuration in testUtils", async () => {
  const testUtilsPath = path.join(rootDir, "src/app/api/providers/[id]/test/testUtils.js");
  const content = fs.readFileSync(testUtilsPath, "utf8");

  // Verify OAUTH_TEST_CONFIG contains nous
  assert.ok(content.includes("nous: {"), "OAUTH_TEST_CONFIG must have nous configuration");
  assert.ok(content.includes("createNousApiKeyProbe"), "OAUTH_TEST_CONFIG.nous must use createNousApiKeyProbe");
  assert.ok(content.includes("refreshNousToken"), "testUtils must import and use refreshNousToken");

  // Verify refreshOAuthToken handles nous
  assert.ok(
    content.includes('if (provider === "nous") {'),
    "refreshOAuthToken must handle nous provider"
  );
});
