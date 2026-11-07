import { describe, expect, it, vi } from 'vitest';
import { handleStreamingResponse } from '../../open-sse/handlers/chatCore/streamingHandler.js';
import { createStreamController } from '../../open-sse/utils/streamHandler.js';
import { FORMATS } from '../../open-sse/translator/formats.js';
import { handleComboChat } from '../../open-sse/services/combo.js';
import { preflightChatStream } from '../../open-sse/utils/streamPreflight.js';

const headers = { 'Content-Type': 'text/event-stream' };
const wire = frame => `data: ${JSON.stringify(frame)}\n\n`;
const start = wire({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] });
const finish = wire({ choices: [{ delta: {}, finish_reason: 'stop' }] });

function run(providerResponse, options = {}) {
  const onRequestSuccess = vi.fn();
  const streamController = createStreamController({ provider: 'fixture', model: 'm', log: { errorLine() {} } });
  const result = handleStreamingResponse({ providerResponse, provider: 'openai-compatible-chat-test', model: 'm', sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI, body: { messages: [] }, stream: true, streamController, requestStartTime: Date.now(), onRequestSuccess, ...options });
  return { result, onRequestSuccess, streamController };
}

describe('streaming account failover before downstream output', () => {
  it('returns a retryable status for an HTTP 200 that carries a rate limit', async () => {
    const { result, onRequestSuccess } = run(new Response(start + wire({ error: { code: 'rate_limit_exceeded', message: 'private detail' } }), { headers }));
    const r = await result;
    expect(r).toMatchObject({ success: false, status: 429 });
    expect(await r.response.text()).not.toContain('private detail');
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it('rejects role/usage-only EOF instead of returning an empty HTTP 200', async () => {
    const { result } = run(new Response(start + finish + 'data: [DONE]\n\n', { headers }));
    expect(await result).toMatchObject({ success: false, status: 502 });
  });

  it('detects a Responses terminal error before starting the chat stream', async () => {
    const { result } = run(new Response(wire({ type: 'response.created', response: { id: 'x' } }) + wire({ type: 'response.failed', response: { status: 'failed' } }), { headers }), { targetFormat: FORMATS.OPENAI_RESPONSES });
    expect(await result).toMatchObject({ success: false, status: 502 });
  });

  it('keeps a legitimate tool call and does not replace it with a late error from another account', async () => {
    const tools = wire({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_42', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }] });
    const { result } = run(new Response(start + tools + wire({ error: { code: 'server_error' } }), { headers }));
    const r = await result;
    expect(r.success).toBe(true);
    const output = await r.response.text();
    expect(output.match(/call_42/g)).toHaveLength(1);
    expect(output).toContain('server_error');
  });

  it('preserves split frames and does not wait for the whole answer', async () => {
    let sender;
    const bytes = new TextEncoder();
    const body = new ReadableStream({ start(c) { sender = c; } });
    const { result } = run(new Response(body, { headers }));
    const answer = wire({ choices: [{ delta: { content: 'สวัสดี' } }] });
    const frame = bytes.encode(answer);
    const split = frame.findIndex(n => n > 127) + 1;
    sender.enqueue(bytes.encode(start));
    sender.enqueue(frame.slice(0, split));
    sender.enqueue(frame.slice(split));
    const r = await result;
    expect(r.success).toBe(true);
    sender.enqueue(bytes.encode(finish + 'data: [DONE]\n\n')); sender.close();
    const output = await r.response.text();
    expect(output.match(/สวัสดี/g)).toHaveLength(1);
    expect(output.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it('cancels a stuck body when the client disconnects before output', async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const { result } = run(new Response(new ReadableStream({ cancel }), { headers }), { requestSignal: abort.signal });
    abort.abort();
    expect(await result).toMatchObject({ success: false, status: 499 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds a stalled preflight and cancels its body', async () => {
    const cancel = vi.fn();
    const result = await preflightChatStream(new ReadableStream({ cancel }), { timeoutMs: 20 });
    expect(result.error.status).toBe(504);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns a fallback model answer without forwarding the primary failure', async () => {
    const sources = {
      primary: start + wire({ error: { code: 'rate_limit_exceeded', message: 'private upstream detail' } }),
      backup: start + wire({ choices: [{ delta: { content: '42' } }] }) + finish + 'data: [DONE]\n\n',
    };
    const attempts = [];
    const result = await handleComboChat({ body: { stream: true }, models: ['primary', 'backup'], log: { info() {}, warn() {} }, comboStrategy: 'fallback', handleSingleModel: async (_body, model) => {
      attempts.push(model);
      return (await run(new Response(sources[model], { headers })).result).response;
    } });
    expect(attempts).toEqual(['primary', 'backup']);
    const output = await result.text();
    expect(output).toContain('"content":"42"');
    expect(output).not.toContain('error');
    expect(output.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it.each([['read_file', 'auto', true], ['terminal', 'auto', false], ['read_file', 'none', false]])('only restores declared textual tools (%s, %s)', async (name, toolChoice, convert) => {
    const markup = `<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="${name}"><｜｜DSML｜｜ parameter name="path" string="true">probe.txt</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`;
    const upstream = start + wire({ choices: [{ index: 0, delta: { content: markup.slice(0, 4) } }] }) + wire({ choices: [{ index: 0, delta: { content: markup.slice(4) } }] }) + finish + 'data: [DONE]\n\n';
    const body = { messages: [], tool_choice: toolChoice, tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } } }] };
    const { result } = run(new Response(upstream, { headers }), { body });
    const output = await (await result).response.text();
    expect(output.includes('"finish_reason":"tool_calls"')).toBe(convert);
    expect(output.includes('DSML')).toBe(!convert);
    if (convert) expect(output).toContain('"name":"read_file"');
    expect(output.match(/\[DONE\]/g)).toHaveLength(1);
  });
});
