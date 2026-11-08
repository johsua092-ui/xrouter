import { describe, expect, it, beforeAll } from 'vitest';
import crypto from 'node:crypto';
beforeAll(() => { process.env.CREDENTIAL_VAULT_KEY = crypto.randomBytes(32).toString('base64'); });

describe('provider credentials at rest', () => {
  it('seals nested tokens, preserves provider metadata and reads old plaintext rows', async () => {
    const { sealCredentials, openCredentials } = await import('../../src/lib/security/credentialVault.js');
    const original = { accessToken: 'fixture-access-value', refreshToken: 'fixture-refresh-value', providerSpecificData: { idToken: 'fixture-id-value', email: 'fixture@example.invalid', enabledModels: ['test-model'] } };
    const stored = sealCredentials(original);
    expect(JSON.stringify(stored)).not.toContain('fixture-access-value');
    expect(JSON.stringify(stored)).not.toContain('fixture-refresh-value');
    expect(JSON.stringify(stored)).not.toContain('fixture-id-value');
    expect(openCredentials(stored)).toEqual(original);
    expect(openCredentials(original)).toEqual(original);
    expect(original.accessToken).toBe('fixture-access-value');
  });
  it('rejects tampered ciphertext instead of returning it as a usable token', async () => {
    const { sealCredentials, openCredentials } = await import('../../src/lib/security/credentialVault.js');
    const stored = sealCredentials({ apiKey: 'fixture-provider-key' });
    stored.apiKey = stored.apiKey.slice(0, -6) + 'AAAAAA';
    expect(() => openCredentials(stored)).toThrow();
  });
  it('redacts nested credentials from dashboard API responses', async () => {
    const { redactCredentials } = await import('../../src/lib/security/credentialVault.js');
    const safe = redactCredentials({ id: 'fixture', apiKey: 'do-not-return', providerSpecificData: { idToken: 'nested-private-value', accountId: 'public-account-id' } });
    expect(JSON.stringify(safe)).not.toContain('do-not-return');
    expect(JSON.stringify(safe)).not.toContain('nested-private-value');
    expect(safe.providerSpecificData.accountId).toBe('public-account-id');
  });
});
