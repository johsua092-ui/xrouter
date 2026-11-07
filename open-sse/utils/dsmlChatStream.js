import { parseDsmlToolCalls } from './dsmlToolCalls.js';
import { SSE_DATA_PREFIX, SSE_DONE_DATA } from './sseConstants.js';

const prefixes = ['<|DSML| CALLS>', '<||DSML| CALLS>', '<|DSML|| CALLS>', '<||DSML|| CALLS>'];
const wholeBlock = /^\s*<[｜|]+DSML[｜|]+\s+calls>[\s\S]*<\/[｜|]+DSML[｜|]+\s+calls>\s*$/i;
const maxBufferedBytes = 32 * 1024;

/** Repair a full tool-only DSML answer from OpenAI-compatible gateways.
 * Never reinterpret prose, an incomplete example, or a non-offered tool. */
export function createDsmlChatStream(request) {
  const offered = new Map((Array.isArray(request?.tools) ? request.tools : [])
    .filter(t => t.type === 'function' && typeof t.function?.name === 'string')
    .map(t => [t.function.name, t.function.parameters || {}]));
  const selected = request?.tool_choice?.function?.name;
  if (!offered.size || request?.tool_choice === 'none') return null;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let remaining = '';
  let text = '';
  let buffer = [];
  let bufferedBytes = 0;
  let pass = false;

  const emit = (controller, line) => controller.enqueue(encoder.encode(line));
  const flushHeld = controller => {
    for (const part of buffer) emit(controller, part);
    buffer = [];
    pass = true;
  };

  function validCalls() {
    if (!wholeBlock.test(text)) return null;
    const parsed = parseDsmlToolCalls(text);
    if (parsed.content || parsed.holdback || !parsed.toolCalls.length) return null;
    return parsed.toolCalls.every(call => {
      const name = call.function.name;
      const schema = offered.get(name);
      if (!schema || (selected && selected !== name)) return false;
      const args = JSON.parse(call.function.arguments);
      if (schema.properties && Object.keys(args).some(k => !Object.hasOwn(schema.properties, k))) return false;
      return !Array.isArray(schema.required) || schema.required.every(k => Object.hasOwn(args, k));
    }) ? parsed.toolCalls : null;
  }

  function processLine(line, controller) {
    if (pass) { emit(controller, line); return; }
    const trimmed = line.trim();
    const payload = trimmed.startsWith(SSE_DATA_PREFIX) ? trimmed.slice(SSE_DATA_PREFIX.length).trim() : '';
    let chunk;
    try { if (payload && payload !== SSE_DONE_DATA) chunk = JSON.parse(payload); } catch {}
    const choices = chunk?.choices;
    const choice = choices?.[0];
    const delta = choice?.delta || {};
    if (chunk?.error || payload === SSE_DONE_DATA || choices?.length > 1 || delta.tool_calls?.length || delta.function_call) {
      flushHeld(controller); emit(controller, line); return;
    }
    if (choice?.finish_reason && buffer.length) {
      const calls = choice.finish_reason === 'stop' ? validCalls() : null;
      if (!calls) { flushHeld(controller); emit(controller, line); return; }
      const toolChoice = { index: choice.index ?? 0, delta: { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, ...call })) }, finish_reason: null };
      const toolFrame = { ...chunk, usage: undefined, choices: [toolChoice] };
      emit(controller, `${SSE_DATA_PREFIX} ${JSON.stringify(toolFrame)}\n\n`);
      emit(controller, `${SSE_DATA_PREFIX} ${JSON.stringify({ ...chunk, choices: [{ ...choice, finish_reason: 'tool_calls' }] })}\n`);
      buffer = [];
      pass = true;
      return;
    }
    if (typeof delta.content === 'string' && delta.content.length) {
      text += delta.content;
      const normalized = text.trimStart().replaceAll('｜', '|').toUpperCase();
      if (!prefixes.some(prefix => prefix.startsWith(normalized) || normalized.startsWith(prefix))) {
        flushHeld(controller); emit(controller, line); return;
      }
      buffer.push(line);
    } else if (buffer.length) buffer.push(line);
    else { emit(controller, line); return; }
    bufferedBytes += line.length;
    if (bufferedBytes > maxBufferedBytes) flushHeld(controller);
  }

  return new TransformStream({
    transform(chunk, controller) {
      remaining += decoder.decode(chunk, { stream: true });
      const lines = remaining.split('\n'); remaining = lines.pop() || '';
      for (const line of lines) processLine(`${line}\n`, controller);
      if (remaining.length > maxBufferedBytes) { flushHeld(controller); emit(controller, remaining); remaining = ''; }
    },
    flush(controller) {
      remaining += decoder.decode();
      if (remaining) processLine(`${remaining}\n`, controller);
      flushHeld(controller);
    },
  });
}
