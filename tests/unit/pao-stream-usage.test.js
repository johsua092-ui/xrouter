import { describe, expect, it } from 'vitest';
import { addBufferToUsage } from '../../open-sse/utils/usageTracking.js';
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from '../../open-sse/utils/stream.js';
import { FORMATS } from '../../open-sse/translator/formats.js';

describe('provider usage is preserved at the client boundary', () => {
  it('does not report an extra context reservation as billed prompt tokens', () => {
    const usage = { prompt_tokens: 22, completion_tokens: 6, total_tokens: 28 };
    expect(addBufferToUsage(usage)).toEqual({ prompt_tokens: 22, completion_tokens: 6, total_tokens: 28 });
    expect(usage.prompt_tokens).toBe(22);
  });
  it('keeps Anthropic input and cache counts unchanged', () => {
    expect(addBufferToUsage({ input_tokens: 15, output_tokens: 4, cache_read_input_tokens: 10 })).toEqual({ input_tokens: 15, output_tokens: 4, cache_read_input_tokens: 10 });
  });
});

describe('Responses providers serving OpenAI chat clients', () => {
  it.each([false, true])('ends a completed stream with exactly one DONE, upstream sentinel=%s', async (sentinel) => {
    const events = [
      { type: 'response.created', response: { id: 'resp_test', model: 'grok-4.7', status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: 'สวัสดี', output_index: 0, content_index: 0 },
      { type: 'response.completed', response: { id: 'resp_test', model: 'grok-4.7', status: 'completed', usage: { input_tokens: 22, output_tokens: 6, total_tokens: 28 }, output: [] } },
    ];
    const wire = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + (sentinel ? 'data: [DONE]\n\n' : '');
    const source = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); c.close(); } });
    const transformed = source.pipeThrough(createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, 'grok-cli'));
    const output = await new Response(transformed).text();
    expect(output).toContain('สวัสดี');
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(output.trimEnd()).toMatch(/data: \[DONE\]$/);
    const chunks = output.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
    expect(chunks.findLast(c => c.usage)?.usage).toMatchObject({ prompt_tokens: 22, completion_tokens: 6 });
  });
});

describe('OpenAI passthrough final usage', () => {
  it.each([false, true])('records late provider usage and emits one DONE, newline=%s', async (newline) => {
    let recorded;
    const frames = [
      { choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    ].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + (newline ? 'data: [DONE]\n\n' : 'data: [DONE]');
    const source = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames)); c.close(); } });
    const transform = createPassthroughStreamWithLogger('openai', null, 'fixture', null, { messages: [] }, (_content, usage) => { recorded = usage; });
    const output = await new Response(source.pipeThrough(transform)).text();
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(recorded).toMatchObject({ prompt_tokens: 7, completion_tokens: 3 });
  });
});
