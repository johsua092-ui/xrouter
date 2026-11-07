import { describe, expect, it } from 'vitest';
describe('profile output budgets', () => {
  it('caps requested output without changing messages or unconfigured profiles', async () => {
    const { applyProfileBudget } = await import('../../src/lib/security/modelProfiles.js');
    const body = { model: 'pao-chat', messages: [{ role: 'user', content: 'hello' }], max_tokens: 9000 };
    expect(applyProfileBudget(body, { 'pao-chat': { maxOutputTokens: 512 } }).max_tokens).toBe(512);
    expect(body.max_tokens).toBe(9000);
    expect(applyProfileBudget(body, {}).max_tokens).toBe(9000);
  });
});
