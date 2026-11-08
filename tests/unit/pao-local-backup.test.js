import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('encrypted local backup recovery', () => {
  it('restores a sealed SQLite snapshot into a temporary database and validates integrity', async () => {
    const { createLocalBackup, verifyLocalBackup } = await import('../../src/lib/security/localBackups.js');
    const { getAdapter } = await import('../../src/lib/db/driver.js');
    const db = await getAdapter();
    db.run('INSERT INTO kv(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value', ['backup-fixture', 'private', 'fixture-sensitive-backup-data']);
    const result = await createLocalBackup();
    expect(fs.readFileSync(result.path, 'utf8')).not.toContain('fixture-sensitive-backup-data');
    const verified = await verifyLocalBackup(result.id);
    expect(verified.integrity).toBe('ok');
    expect(verified.sha256Matched).toBe(true);
    expect(verified.tables).toBeGreaterThan(5);
  });
  it('refuses filenames outside the local backup directory', async () => {
    const { verifyLocalBackup } = await import('../../src/lib/security/localBackups.js');
    await expect(verifyLocalBackup('../outside.sqlite')).rejects.toThrow();
  });
});
