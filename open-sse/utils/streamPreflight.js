import { HTTP_STATUS, STREAM_PREFLIGHT_MAX_BYTES, STREAM_PREFLIGHT_TIMEOUT_MS } from '../config/runtimeConfig.js';
import { RESPONSES_EVENT, RESPONSES_ITEM } from '../translator/schema/index.js';
import { SSE_DATA_PREFIX, SSE_DONE_DATA } from './sseConstants.js';

const failure = (status, message) => ({ status, message });
const emptyStream = () => failure(HTTP_STATUS.BAD_GATEWAY, 'Upstream ended the stream before producing a response');
const hasValue = value => typeof value === 'string' ? value.length > 0 : Array.isArray(value) && value.length > 0;

function errorStatus(error) {
  const status = Number(error?.status ?? error?.status_code ?? error?.code);
  if (status >= 400 && status <= 599 && Number.isInteger(status)) return status;
  const code = `${error?.code || ''} ${error?.type || ''}`;
  if (/rate.limit|too.many.requests|quota/i.test(code)) return HTTP_STATUS.RATE_LIMITED;
  if (/invalid.api.key|authentication|unauthorized/i.test(code)) return HTTP_STATUS.UNAUTHORIZED;
  if (/permission.denied|forbidden/i.test(code)) return HTTP_STATUS.FORBIDDEN;
  return HTTP_STATUS.BAD_GATEWAY;
}

function inspectLine(line) {
  const text = line.trim();
  const payload = text.startsWith(SSE_DATA_PREFIX) ? text.slice(SSE_DATA_PREFIX.length).trim() : text.startsWith('{') ? text : '';
  if (payload === SSE_DONE_DATA) return { error: emptyStream() };
  if (!payload) return null;
  let frame;
  try { frame = JSON.parse(payload); } catch { return null; }
  if (!frame || typeof frame !== 'object') return null;
  if (frame.error || frame.type === 'error' || frame.type === RESPONSES_EVENT.FAILED || frame.response?.status === 'failed') {
    const status = errorStatus(frame.error || frame.response?.error || frame);
    return { error: failure(status, `Upstream rejected the stream before output (HTTP ${status})`) };
  }
  if (Array.isArray(frame.choices)) {
    return frame.choices.some(choice => {
      const delta = choice?.delta || {};
      return ['content', 'reasoning_content', 'reasoning', 'thought', 'refusal', 'tool_calls'].some(name => hasValue(delta[name])) || Boolean(delta.function_call || delta.audio) || choice?.finish_reason === 'content_filter';
    }) ? { accepted: true } : null;
  }
  if (frame.type === RESPONSES_EVENT.OUTPUT_ITEM_ADDED || frame.type === RESPONSES_EVENT.OUTPUT_ITEM_DONE) {
    const item = frame.item;
    if (item && [RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL].includes(item.type)) return { accepted: true };
    if (item?.content?.some?.(block => hasValue(block?.text) || hasValue(block?.refusal))) return { accepted: true };
  }
  if (typeof frame.type === 'string' && frame.type.startsWith('response.') && frame.type.endsWith('.delta') && hasValue(frame.delta)) return { accepted: true };
  if ([RESPONSES_EVENT.COMPLETED, RESPONSES_EVENT.DONE].includes(frame.type) && frame.response?.output?.some?.(item => item?.content?.some?.(part => hasValue(part?.text) || hasValue(part?.refusal)) || [RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL].includes(item?.type))) return { accepted: true };
  return null;
}

/** Hold only metadata before the first real output. Replay bytes unchanged on success. */
export async function preflightChatStream(body, { signal, timeoutMs = STREAM_PREFLIGHT_TIMEOUT_MS } = {}) {
  if (!body) return { error: emptyStream() };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const buffered = [];
  let bytes = 0;
  let pending = '';
  let replay = false;
  let timer;
  let abort;
  const interrupt = new Promise(resolve => {
    abort = () => resolve({ error: failure(HTTP_STATUS.CLIENT_CLOSED_REQUEST, 'Client cancelled the request') });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => resolve({ error: failure(HTTP_STATUS.GATEWAY_TIMEOUT, 'Upstream timed out before producing a response') }), timeoutMs);
  });

  const accepted = () => {
    replay = true;
    return { body: new ReadableStream({
      async pull(controller) {
        if (buffered.length) { controller.enqueue(buffered.shift()); return; }
        try {
          const next = await reader.read();
          if (next.done) { reader.releaseLock(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { reader.releaseLock(); controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
    }) };
  };

  try {
    while (true) {
      const next = await Promise.race([interrupt, reader.read()]);
      if (next.error) return next;
      if (next.done) {
        const terminal = inspectLine(pending + decoder.decode());
        return terminal?.accepted ? accepted() : { error: terminal?.error || emptyStream() };
      }
      buffered.push(next.value);
      bytes += next.value.byteLength;
      pending += decoder.decode(next.value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        const result = inspectLine(line);
        if (result?.error) return result;
        if (result?.accepted) return accepted();
      }
      // A provider may carry unknown extension frames. Keep memory bounded and
      // let the normal transform handle them once the prefix limit is reached.
      if (bytes >= STREAM_PREFLIGHT_MAX_BYTES) return accepted();
    }
  } catch {
    return { error: failure(HTTP_STATUS.BAD_GATEWAY, 'Upstream connection closed before producing a response') };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (!replay) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
