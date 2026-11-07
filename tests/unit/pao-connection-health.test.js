import { describe, expect, it } from 'vitest';

describe('connection readiness is supported by evidence', () => {
  it('bounds account attempts so a failed provider cannot scan an entire imported pool', async () => {
    const { accountAttemptLimit } = await import('../../src/lib/security/connectionHealth.js');
    expect([undefined, 0, 99, '3', 2].map(accountAttemptLimit)).toEqual([3, 3, 10, 3, 2]);
  });
  it('does not label an imported expired OAuth grant as ready', async () => {
    const { connectionHealth } = await import('../../src/lib/security/connectionHealth.js');
    expect(connectionHealth({ isActive: true, authType: 'oauth', testStatus: 'active', expiresAt: '2020-01-01T00:00:00Z' }, false).state).toBe('expired');
  });
  it('distinguishes model access from a successful inference', async () => {
    const { connectionHealth } = await import('../../src/lib/security/connectionHealth.js');
    const c = { isActive: true, authType: 'apikey', testStatus: 'active' };
    expect(connectionHealth(c, false).state).toBe('credentials_valid');
    expect(connectionHealth(c, true).state).toBe('ready');
  });
  it('keeps a rejected refresh visibly separate from a quota limit', async () => {
    const { connectionHealth } = await import('../../src/lib/security/connectionHealth.js');
    expect(connectionHealth({ credentialHealth: { state: 'reauth_required' }, isActive: false }, false).state).toBe('reauth_required');
    expect(connectionHealth({ isActive: true, errorCode: 402 }, false).state).toBe('quota_exhausted');
  });
});
