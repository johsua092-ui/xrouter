export const PROFILE_PRESETS = [
  { name: 'pao-code', label: 'เขียนโค้ด', maxOutputTokens: 4096, targets: ['gcli/grok-4.7', 'crowllm/gemini-3-flash:free'] },
  { name: 'pao-chat', label: 'ถามทั่วไป', maxOutputTokens: 2048, targets: ['gcli/grok-4.7', 'crowllm/gemini-3-flash:free'] },
  { name: 'pao-economy', label: 'ประหยัด', maxOutputTokens: 1024, targets: ['crowllm/gemini-3-flash:free'] },
];

export function applyProfileBudget(body, budgets = {}) {
  const limit = Number(budgets[body.model]?.maxOutputTokens);
  if (!Number.isSafeInteger(limit) || limit < 1) return body;
  const result = { ...body };
  const fields = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'];
  let provided = false;
  for (const field of fields) if (result[field] !== undefined) {
    const requested = Number(result[field]);
    result[field] = Number.isFinite(requested) && requested > 0 ? Math.min(requested, limit) : limit;
    provided = true;
  }
  if (!provided) result[body.input ? 'max_output_tokens' : 'max_tokens'] = limit;
  return result;
}
