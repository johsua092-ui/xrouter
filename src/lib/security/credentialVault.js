import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getDataDir } from '../dataDir.js';

const PREFIX = 'xrv1:';
const SECRET_FIELD = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|cookie(?:header)?|password|sso(?:-rw)?)$|(?:secret|token)$/i;
let cachedKey;
let cachedLocation;

function dpapi(value, decrypt) {
  const action = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $r=[System.Security.Cryptography.ProtectedData]::${action}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value.toString('base64'), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }).trim(), 'base64');
}

export function vaultKeyPath() { return path.join(getDataDir(), 'security', 'vault-key.dpapi'); }

function key() {
  const explicit = process.env.CREDENTIAL_VAULT_KEY;
  const location = explicit ? `env:${explicit}` : vaultKeyPath();
  if (cachedKey && cachedLocation === location) return cachedKey;
  let value;
  if (explicit) {
    value = Buffer.from(explicit, 'base64');
  } else {
    if (process.platform !== 'win32') throw new Error('Set CREDENTIAL_VAULT_KEY to a base64-encoded 32-byte key on this platform.');
    fs.mkdirSync(path.dirname(location), { recursive: true });
    if (!fs.existsSync(location)) {
      const wrapped = dpapi(crypto.randomBytes(32), false);
      const temporary = `${location}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, wrapped, { mode: 0o600 });
      try { fs.linkSync(temporary, location); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      finally { fs.unlinkSync(temporary); }
    }
    value = dpapi(fs.readFileSync(location), true);
  }
  if (value.length !== 32) throw new Error('The credential vault key is invalid.');
  cachedKey = value; cachedLocation = location;
  return value;
}

export function sealValue(value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), nonce);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function openValue(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const bytes = Buffer.from(value.slice(PREFIX.length), 'base64');
  if (bytes.length < 29) throw new Error('The credential vault record is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

function visit(value, operation) {
  if (Array.isArray(value)) return value.map(v => visit(v, operation));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([name, item]) => {
    if (typeof item === 'string' && item && SECRET_FIELD.test(name)) {
      if (operation === 'redact') return [];
      if (operation === 'seal') return [[name, item.startsWith(PREFIX) ? item : sealValue(item)]];
      return [[name, openValue(item)]];
    }
    return [[name, visit(item, operation)]];
  }));
}
export const sealCredentials = value => visit(value, 'seal');
export const openCredentials = value => visit(value, 'open');
export const redactCredentials = value => visit(value, 'redact');

export function migrateCredentialRows(db) {
  let migrated = 0;
  db.exec('PRAGMA secure_delete=ON');
  db.transaction(() => {
    for (const row of db.all('SELECT id,data FROM providerConnections')) {
      const original = JSON.parse(row.data || '{}');
      const sealed = JSON.stringify(sealCredentials(original));
      if (sealed !== row.data) { db.run('UPDATE providerConnections SET data=? WHERE id=?', [sealed, row.id]); migrated++; }
    }
  });
  if (migrated > 0) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  return migrated;
}
