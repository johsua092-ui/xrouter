import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect, buildDefaultEmptyStreamTerminal } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { EMPTY_STREAM_ERROR } from "../../config/errorConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildStreamErrorBytes, formatSSE } from "../../utils/streamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveToSemanticCache } from "../../rtk/semanticCache.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { calledModelName } from "../../utils/modelAlias.js";
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials, aliasModel }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials, aliasModel);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials, aliasModel);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, aliasModel);
}

// The empty-stream error frame per client format. OpenAI-style clients get an
// error payload, then [DONE]; Anthropic clients (Claude Code) need an
// `event: error` with Anthropic's envelope; every Responses client (Codex) gets
// the response.failed terminal used for aborts, whether the route is a
// passthrough or translated from a chat-format provider.
function buildEmptyStreamTerminal(sourceFormat) {
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) return () => buildAbortedResponsesTerminalBytes();
  if (sourceFormat === FORMATS.CLAUDE) {
    return (message) => new TextEncoder().encode(
      formatSSE({ type: "error", error: { type: EMPTY_STREAM_ERROR.claudeType, message } }, FORMATS.CLAUDE)
    );
  }
  return (message) => buildDefaultEmptyStreamTerminal(message);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log, credentials, requestedModel }) {
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}` } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  // The name the client called is the only one it is allowed to see.
  const aliasModel = calledModelName(requestedModel, model);
  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials, aliasModel });

  // Terminal bytes when the stream aborts after HTTP 200 was already sent, so the
  // client sees a real error instead of a silently truncated stream.
  // Responses passthrough keeps its own response.failed shape; every other client
  // format gets the OpenAI error frame + [DONE], or `event: error` for Claude.
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough
    ? buildAbortedResponsesTerminalBytes
    : (message) => buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, message, sourceFormat);
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  // In-band error frame when the stream produced nothing, in the client's own
  // error shape.
  const emptyStreamTerminal = buildEmptyStreamTerminal(sourceFormat);
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs, emptyStreamTerminal);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId, requestedModel, apiKey,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: { ...SSE_HEADERS, ...upstreamResponseHeaders(providerResponse.headers) } })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestedModel, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log, semanticCacheEnabled }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    // An empty stream is NOT a success. This was hardcoded to "success", so a
    // request that produced no content at all was recorded green — the
    // dashboard, the usage view and anything reading requestDetails all agreed
    // nothing was wrong while the caller received an empty body. Recording it
    // truthfully is what makes the failure findable; pipeWithDisconnect emits
    // the client-facing error frame.
    const producedNothing = !contentObj?.content && !contentObj?.thinking &&
      !(usage?.completion_tokens > 0);
    const detailStatus = producedNothing ? "error" : "success";

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, requestedModel, apiKey,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: detailStatus
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });
    if (producedNothing && log?.errorLine) {
      log.errorLine(reqTag, "✗", `EMPTY STREAM · ${provider}/${model} · no content and no completion tokens`);
    }

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, requestedModel, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));

    // Cache completed streaming response for repeat prompt acceleration
    if (semanticCacheEnabled && safeContent && safeContent !== "[Empty streaming response]") {
      try {
        const syntheticResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: safeContent,
                ...(safeThinking ? { reasoning_content: safeThinking } : {})
              },
              finish_reason: "stop"
            }
          ],
          usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
        const nonStreamBody = { ...body, stream: false };
        saveToSemanticCache(nonStreamBody, `${provider}/${model}`, syntheticResponse);
        if (requestedModel && requestedModel !== `${provider}/${model}`) {
          saveToSemanticCache(nonStreamBody, requestedModel, syntheticResponse);
        }
      } catch (err) {
        // fail-open
      }
    }
  };

  return { onStreamComplete, streamDetailId };
}
