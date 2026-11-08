import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
  if (match) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
}
register(pathToFileURL(path.join(root, 'scripts/auth-guard-hooks.mjs')).href);
const { createLocalBackup, verifyLocalBackup } = await import('../src/lib/security/localBackups.js');
const { closeDb } = await import('../src/lib/db/driver.js');
try {
  const backup = await createLocalBackup();
  console.log(JSON.stringify(await verifyLocalBackup(backup.id)));
} finally { await closeDb(); }
