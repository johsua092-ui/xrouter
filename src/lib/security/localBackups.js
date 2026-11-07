import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { getAdapter } from '../db/driver.js';
import { DATA_FILE } from '../db/paths.js';
import { getDataDir } from '../dataDir.js';
import { sealValue, openValue, vaultKeyPath } from './credentialVault.js';

const directory = () => path.join(getDataDir(), 'backups-encrypted');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let running;
let scheduler;

export function listLocalBackups() {
  if (!fs.existsSync(directory())) return [];
  return fs.readdirSync(directory()).filter(name => /^backup-[\dTZ.-]+\.xrb$/.test(name)).sort().reverse().map(id => {
    const file = path.join(directory(), id);
    return { id, bytes: fs.statSync(file).size, createdAt: fs.statSync(file).mtime.toISOString(), encrypted: true };
  });
}

export async function createLocalBackup() {
  if (running) return running;
  running = (async () => {
    await getAdapter();
    fs.mkdirSync(directory(), { recursive: true });
    const id = `backup-${new Date().toISOString().replace(/:/g, '-')}.xrb`;
    const temporary = path.join(directory(), `${crypto.randomUUID()}.sqlite.tmp`);
    const source = new DatabaseSync(DATA_FILE, { readOnly: true });
    try {
      await backup(source, temporary);
      const bytes = fs.readFileSync(temporary);
      const envelope = { format: 'xrouter-local-backup-v1', createdAt: new Date().toISOString(), sha256: hash(bytes), payload: sealValue(bytes.toString('base64')), keyScope: process.platform === 'win32' ? 'WindowsCurrentUser' : 'EnvironmentKey' };
      if (fs.existsSync(vaultKeyPath())) envelope.wrappedKey = fs.readFileSync(vaultKeyPath()).toString('base64');
      const target = path.join(directory(), id);
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(envelope), { mode: 0o600 });
      fs.renameSync(`${target}.tmp`, target);
      return { id, path: target, encrypted: true, sha256: envelope.sha256 };
    } finally { source.close(); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  })();
  try { return await running; } finally { running = null; }
}

export async function verifyLocalBackup(id) {
  if (typeof id !== 'string' || !/^backup-[\dTZ.-]+\.xrb$/.test(id)) throw new Error('Invalid backup name');
  const envelope = JSON.parse(fs.readFileSync(path.join(directory(), id), 'utf8'));
  if (envelope.format !== 'xrouter-local-backup-v1') throw new Error('Unsupported backup format');
  const bytes = Buffer.from(openValue(envelope.payload), 'base64');
  if (hash(bytes) !== envelope.sha256) throw new Error('Backup integrity check failed');
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xrouter-restore-check-'));
  const temporary = path.join(temporaryDirectory, 'restore.sqlite');
  let db;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    db = new DatabaseSync(temporary, { readOnly: true });
    const integrity = Object.values(db.prepare('PRAGMA quick_check').get())[0];
    const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
    const connections = db.prepare('SELECT COUNT(*) AS n FROM providerConnections').get().n;
    if (integrity !== 'ok') throw new Error('Restored database is damaged');
    return { id, integrity, sha256Matched: true, tables, connections, restoredIntoTemporaryDatabase: true };
  } finally {
    db?.close();
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(temporary + suffix)) fs.unlinkSync(temporary + suffix);
    fs.rmdirSync(temporaryDirectory);
  }
}

export function startLocalBackupScheduler() {
  if (scheduler || process.env.NEXT_PHASE?.includes('build') || process.env.DISABLE_LOCAL_BACKUPS === 'true') return;
  const check = async () => {
    const db = await getAdapter();
    const settings = JSON.parse(db.get('SELECT data FROM settings WHERE id=1')?.data || '{}');
    if (settings.localBackupEnabled === false) return;
    const latest = listLocalBackups()[0];
    if (!latest || Date.now() - Date.parse(latest.createdAt) >= 24 * 60 * 60 * 1000) {
      const created = await createLocalBackup();
      await verifyLocalBackup(created.id);
    }
  };
  const first = setTimeout(() => check().catch(() => console.error('[LocalBackup] Backup failed; see maintenance status.')), 30000);
  first.unref?.();
  scheduler = setInterval(() => check().catch(() => console.error('[LocalBackup] Backup failed; see maintenance status.')), 60 * 60 * 1000);
  scheduler.unref?.();
}
