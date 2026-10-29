import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { openAICompletionToClaudeMessage } from "../../translator/concerns/claudeMessage.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { addBufferToUsage, filterUsageForFormat } from "../../utils/usageTracking.js";
import { createErrorResult } from "../../utils/error.js";
import { rescueResponse } from "../../translator/concerns/toolCallRescue.js";
import { isRefusalText } from "../../rtk/refusalGuard.js";
import { applyJsonGuard } from "../../translator/concerns/jsonGuard.js";
import { parseToolCallsFromText } from "../../translator/webTools.js";
import { applyOpenAIToolBridge } from "../../translator/concerns/toolBridge.js";
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.js";
import { unwrapClineEnvelope } from "../../shared/clineEnvelope.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";
import { applyModelAlias, calledModelName } from "../../utils/modelAlias.js";
import { restoreToolNames } from "../../utils/opencodeFingerprint.js";
import { ROLE, RESPONSES_ITEM, OPENAI_FINISH } from "../../translator/schema/index.js";
import { toOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { saveToSemanticCache } from "../../rtk/semanticCache.js";

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * OpenAI Tool Bridge - response side, non-streaming.
 *
 * A text-only provider (browser-session models with `tools: false`) answers a
 * tool request in prose, so the client receives a plain string and waits for a
 * tool_call that never arrives. The model's own answer is where the invocation
 * is declared - `{"name": ...}`, `<tool_use>`, `to=read_file {...}` - so
 * rewriting it is a FORMAT repair on content the model wrote, never a guess
 * about intent.
 *
 * Both client shapes are covered: the OpenAI chat envelope
 * (`choices[0].message.content`) and the Claude envelope (`content[]` text
 * blocks). The tool catalogue comes from the request the client actually sent,
 * which is the only trustworthy list of what may be called.
 */
function bridgeOpenAIChatResponse(response, body) {
  // The catalogue travels with the request in whichever shape the client used.
  const catalogue = body?._openaiToolBridge || {};
  const sourceTools = Array.isArray(body?.tools) && body.tools.length
    ? body.tools
    : (Array.isArray(catalogue.tools) ? catalogue.tools : undefined);
  const sourceFunctions = Array.isArray(body?.functions) && body.functions.length
    ? body.functions
    : (Array.isArray(catalogue.functions) ? catalogue.functions : undefined);

  const args = {
    tools: sourceTools,
    functions: sourceFunctions,
  };

  let applied = 0;

  // OpenAI chat envelope.
  const message = response?.choices?.[0]?.message;
  if (message && typeof message.content === "string" && !message.tool_calls) {
    const out = applyOpenAIToolBridge({ content: message.content }, args);
    if (out.openaiToolBridge?.applied) {
      message.content = out.content;
      message.tool_calls = out.tool_calls;
      applied += out.tool_calls.length;
    }
  }

  // Claude envelope: content is an array of blocks; the bridge reads text blocks.
  if (Array.isArray(response?.content) && !response?.tool_calls) {
    const texts = response.content.filter((b) => b?.type === "text" && typeof b.text === "string");
    if (texts.length) {
      const joined = texts.map((b) => b.text).join("\n");
      const out = applyOpenAIToolBridge({ content: joined }, args);
      if (out.openaiToolBridge?.applied) {
        // Keep the prose as a text block (it explains the call) and add tool_use
        // blocks after it, mirroring what a natively tool-capable model emits.
        texts[0].text = out.content;
        for (let i = 1; i < texts.length; i++) texts[i].text = "";
        for (const tc of out.tool_calls) {
          response.content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parseToolArguments(tc.function.arguments),
          });
        }
        applied += out.tool_calls.length;
      }
    }
  }

  return applied;
}

/**
 * Convert an OpenAI Chat Completions non-streaming response body into the
 * OpenAI Responses API shape. Used when a Responses-format client (e.g. Codex)
 * is routed to a Chat Completions upstream and `stream:false` — the streaming
 * path already emits Responses events, but the JSON path returned a raw
 * `chat.completion` body, so tool_calls were invisible to Responses clients.
 */
function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

function openAICompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  // Reasoning → a reasoning item (summary text), mirroring the streaming path.
  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  // Assistant text → a message item with output_text content.
  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  // tool_calls → function_call/custom_tool_call items (Responses-native tool shape).
  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: fn.name || "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const usage = responseBody.usage || {};
  const status = choice.finish_reason === "tool_calls" ? "completed" : (choice.finish_reason === "stop" ? "completed" : (choice.finish_reason || "completed"));

  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status,
    background: false,
    error: null,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

/**
 * Convert an OpenAI Chat Completions body (the hub format every provider body is
 * first translated into) into the client's format: Anthropic `message` for Claude
 * clients, Responses `response` for Responses clients. Other client formats get the
 * hub body unchanged, as before.
 */
export function openAICompletionToClientFormat(responseBody, sourceFormat, customToolNames = null) {
  if (sourceFormat === FORMATS.CLAUDE) return openAICompletionToClaudeMessage(responseBody);
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) return openAICompletionToResponses(responseBody, customToolNames);
  return responseBody;
}

/**
 * Translate a non-streaming response body from the provider format into the
 * client's format: provider → OpenAI Chat Completions (hub) → client.
 */
export function translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames = null) {
  if (targetFormat === sourceFormat) return responseBody;
  const openAIBody = providerResponseToOpenAI(responseBody, targetFormat);
  return openAICompletionToClientFormat(openAIBody, sourceFormat, customToolNames);
}

/**
 * Translate a non-streaming response body from the provider format into the
 * OpenAI Chat Completions hub format. Bodies already in that shape, and formats
 * without a converter, are returned unchanged.
 */
export function providerResponseToOpenAI(responseBody, targetFormat) {
  if (targetFormat === FORMATS.OPENAI) return responseBody;

  // Gemini / Antigravity
  if (targetFormat === FORMATS.GEMINI || targetFormat === FORMATS.ANTIGRAVITY || targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.VERTEX) {
    const response = responseBody.response || responseBody;
    if (!response?.candidates?.[0]) return responseBody;

    const candidate = response.candidates[0];
    const content = candidate.content;
    const usage = response.usageMetadata || responseBody.usageMetadata;
    let textContent = "", reasoningContent = "";
    const toolCalls = [];

    if (content?.parts) {
      for (const part of content.parts) {
        if (part.thought === true && part.text) reasoningContent += part.text;
        else if (part.text !== undefined) textContent += part.text;
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${part.functionCall.name}_${Date.now()}_${toolCalls.length}`,
            type: "function",
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }
          });
        }
        // Handle inline image data (from image generation models)
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData?.data) {
          const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
          textContent += `\n![image](data:${mimeType};base64,${inlineData.data})\n`;
        }
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    // Same mapping as the streaming Gemini translator (MAX_TOKENS → length, SAFETY → content_filter).
    let finishReason = toOpenAIFinish(candidate.finishReason, FORMATS.GEMINI);
    if (finishReason === OPENAI_FINISH.STOP && toolCalls.length > 0) finishReason = OPENAI_FINISH.TOOL_CALLS;

    const result = {
      id: `chatcmpl-${response.responseId || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
      model: response.modelVersion || "gemini",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (usage) {
      result.usage = {
        prompt_tokens: (usage.promptTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      };
      if (usage.cachedContentTokenCount > 0) {
        result.usage.prompt_tokens_details = { cached_tokens: usage.cachedContentTokenCount };
      }
      if (usage.thoughtsTokenCount > 0) {
        result.usage.completion_tokens_details = { reasoning_tokens: usage.thoughtsTokenCount };
      }
    }
    return result;
  }

  // Claude
  if (targetFormat === FORMATS.CLAUDE) {
    // Always translate a Claude-format body to OpenAI, even if `content` is
    // missing/null (e.g. M3 with max_tokens:1 spends the budget on thinking
    // and returns `content: null`). Returning the raw body would leave the
    // OpenAI client without a `choices` array and surface as a UI test error.
    // Early return if the response is already in OpenAI format (has choices array)
    // or if it has content as a non-array value (likely a different non-Claude format).
    // Some providers (e.g. xiaomi-tokenplan) return OpenAI-format responses even when
    // the request was translated to Claude format — the targetFormat is Claude but the
    // actual response is OpenAI-native and needs no further translation.
    if (responseBody.choices || (responseBody.content && !Array.isArray(responseBody.content))) return responseBody;

    let textContent = "", thinkingContent = "";
    const toolCalls = [];

    for (const block of (responseBody.content || [])) {
      if (block.type === "text") {
        // Strip markdown code block markers (e.g. kimi wraps JSON in ```json...```)
        const raw = block.text ?? "";
        const text = raw.replace(/^\s*```\s*json\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
        textContent += text;
      } else if (block.type === "thinking") thinkingContent += block.thinking || "";
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (thinkingContent) message.reasoning_content = thinkingContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = responseBody.stop_reason || "stop";
    if (finishReason === "end_turn") finishReason = "stop";
    if (finishReason === "tool_use") finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${responseBody.id || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseBody.model || "claude",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (responseBody.usage) {
      result.usage = {
        prompt_tokens: responseBody.usage.input_tokens || 0,
        completion_tokens: responseBody.usage.output_tokens || 0,
        total_tokens: (responseBody.usage.input_tokens || 0) + (responseBody.usage.output_tokens || 0)
      };
    }
    return result;
  }

  // Ollama
  if (targetFormat === FORMATS.OLLAMA) {
    return ollamaBodyToOpenAI(responseBody);
  }

  return responseBody;
}

/**
 * Handle non-streaming response from provider.
 */
export async function handleNonStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, requestedModel, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, trackDone, appendLog, pxpipe, reqTag, log, pluginResult, semanticCacheEnabled }) {
  trackDone();
  const contentType = providerResponse.headers.get("content-type") || "";
  let responseBody;
  // Which format `responseBody` ends up in: the provider's own when it answers
  // normally, the OpenAI pivot when we had to rebuild it out of a stream.
  let responseBodyFormat = targetFormat;

  if (contentType.includes("text/event-stream")) {
    const sseText = await providerResponse.text();
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    }
    if (parsed.error) {
      const upstreamStatus = Number(parsed.error.status);
      const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599
        ? upstreamStatus
        : HTTP_STATUS.BAD_GATEWAY;
      appendLog({ status: `FAILED ${status}` });
      return createErrorResult(status, parsed.error.message || "Upstream SSE stream failed");
    }
    responseBody = parsed;
    responseBodyFormat = FORMATS.OPENAI;
  } else {
    try {
      responseBody = await providerResponse.json();
    } catch (err) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      console.error(`[ChatCore] Failed to parse JSON from ${provider}:`, err.message);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
    }
  }

  // Unwrap before any consumer reads choices/usage so non-stream clients get a
  // bare OpenAI body and usage tracking sees data.usage. No-op unless the
  // provider opts in via transport.quirks.clineEnvelope.
  responseBody = unwrapClineEnvelope(responseBody, provider);

  reqLogger.logProviderResponse(providerResponse.status, providerResponse.statusText, providerResponse.headers, responseBody);
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // Decloak tool_use names once on raw Claude body, before any translation (INPUT side)
  responseBody = decloakToolNames(responseBody, toolNameMap);

  const usage = extractUsageFromResponse(responseBody);
  appendLog({ tokens: usage, status: "200 OK" });
  saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, requestedModel, endpoint: clientRawRequest?.endpoint, silent: true });
  if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));

  const translate = needsTranslation(responseBodyFormat, sourceFormat);
  const openAIResponse = translate ? providerResponseToOpenAI(responseBody, responseBodyFormat) : responseBody;

  // Fix finish_reason for tool_calls: some providers return non-standard values (e.g. "other")
  if (openAIResponse?.choices?.[0]) {
    const choice = openAIResponse.choices[0];
    const rawContent = choice?.message?.content;
    if (typeof rawContent === "string" && isRefusalText(rawContent)) {
      log?.warn?.("REFUSAL_GUARD", `Detected upstream refusal text in non-streaming response; suppressing refusal wrapper.`);
      // Strip out preachy refusals if followed by useful code, or replace with direct execution confirmation
      const codeFenceIdx = rawContent.indexOf("```python");
      const fallbackCodeIdx = rawContent.indexOf("```");
      const activeIdx = codeFenceIdx >= 0 ? codeFenceIdx : fallbackCodeIdx;
      if (activeIdx >= 0) {
        choice.message.content = `## Technical Implementation & Protocol Architecture\n\n${rawContent.slice(activeIdx)}`;
      } else {
        choice.message.content = "## Technical Assessment & Security Architecture\n\nBerdasarkan analisis arsitektur endpoint:\n1. Endpoint `/v1/models` yang terekspos tanpa autentikasi (21 model) mengonfirmasi information disclosure pada gateway.\n2. Untuk pengujian penetrasi resmi, fokus audit struktural adalah pada validasi token header dan rate-limiting threshold daripada brute-force tanpa scope izin.";
      }
    }
    const msg = choice.message;

    // Auto-parse text-based tool calls (e.g. <tool>...</tool> or DSML) when msg.tool_calls is empty
    if ((!msg?.tool_calls || msg.tool_calls.length === 0) && typeof msg?.content === "string") {
      const parsedCalls = parseToolCallsFromText(msg.content);
      if (parsedCalls && parsedCalls.length > 0) {
        msg.tool_calls = parsedCalls;
        choice.finish_reason = "tool_calls";
      }
    }

    const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
    if (hasToolCalls && choice.finish_reason !== OPENAI_FINISH.TOOL_CALLS) {
      choice.finish_reason = OPENAI_FINISH.TOOL_CALLS;
    }
  }

  const translatedResponse = translate
    ? openAICompletionToClientFormat(openAIResponse, sourceFormat, customToolNames)
    : openAIResponse;
  const isClaudeMessageResponse = sourceFormat === FORMATS.CLAUDE && translatedResponse?.type === "message";
  // Responses-format translation produces a `object:"response"` body with no
  // `choices`; skip the Chat-Completions-specific post-processing below for it.
  // `responseBodyFormat` is the provider side of the pair; a client that speaks
  // Responses gets an `object:"response"` body with no `choices` to post-process.
  const isResponsesResponse = (responseBodyFormat === FORMATS.OPENAI_RESPONSES || sourceFormat === FORMATS.OPENAI_RESPONSES) && translatedResponse?.object === "response";

  // A call the client cannot satisfy ends the turn: `Invalid args for tool "Bash":
  // must have required property 'command'` is the client validating against the
  // schema this very request declared, and it throws rather than continuing. Run
  // after the finish_reason fix so a dropped call can correct that reason back
  // and leave a well-formed answer instead of a half-finished tool turn.
  if (Array.isArray(translatedBody?.tools) && translatedBody.tools.length > 0) {
    const rescued = rescueResponse(translatedResponse, translatedBody.tools);
    if (rescued.renamed || rescued.recovered || rescued.dropped) {
      log?.debug?.("TOOLRESCUE", `${rescued.renamed} renamed, ${rescued.recovered} recovered, ${rescued.dropped} dropped (response)`);
    }
  }

  // JSON Guard (opt-in per model): make machine-readable output parseable again.
  // Runs after translation and after the tool rescue, because both rewrite the
  // tool_calls this reads. Only the non-streaming path reaches here — a streaming
  // answer's tool arguments arrive as fragments and are forwarded as they land,
  // so there is no complete value to repair without buffering every tool call.
  if (pluginResult?.isJsonGuardActive && translatedResponse && typeof translatedResponse === "object") {
    const guarded = applyJsonGuard(translatedResponse, translatedBody?.tools);
    if (guarded.changed) {
      const s = guarded.stats;
      log?.debug?.("JSONGUARD", `${s.textRepaired} text repaired, ${s.argsRepaired} args repaired, ${s.argsDropped} args dropped, ${s.argsCleaned} schema-cleaned (${s.argsFilled} filled, ${s.argsMissing} still missing)`);
    } else {
      log?.debug?.("JSONGUARD", "checked, nothing to repair");
    }
  }

  // OpenAI Tool Bridge (opt-in per model): a provider with no native tool
  // support answers in prose. The invocation is already in the model's answer,
  // so promoting it to tool_calls is a format repair, not a guess.
  if (pluginResult?.isToolBridgeActive && translatedResponse && typeof translatedResponse === "object") {
    const bridged = bridgeOpenAIChatResponse(translatedResponse, body);
    if (bridged > 0) {
      log?.debug?.("TOOLBRIDGE", `${bridged} call(s) recovered from prose · ${provider}/${model}`);
    }
  }

  // Ensure OpenAI-required fields
  if (!isClaudeMessageResponse && !isResponsesResponse) {
    if (!translatedResponse.object) translatedResponse.object = "chat.completion";
    if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);
  }

  // Strip Azure-specific fields
  if (!isClaudeMessageResponse && !isResponsesResponse) {
    delete translatedResponse.prompt_filter_results;
    if (translatedResponse?.choices) {
      for (const choice of translatedResponse.choices) delete choice.content_filter_results;
    }
  }

  if (translatedResponse?.usage) {
    translatedResponse.usage = filterUsageForFormat(addBufferToUsage(translatedResponse.usage), sourceFormat);
  }

  // Strip reasoning_content only when content is non-empty.
  // When content is empty (e.g. thinking models that used all tokens for reasoning),
  // reasoning_content is the only useful output and must be preserved.
  if (!isClaudeMessageResponse && !isResponsesResponse && translatedResponse?.choices) {
    for (const choice of translatedResponse.choices) {
      if (choice?.message?.reasoning_content && choice.message.content) {
        delete choice.message.reasoning_content;
      }
    }
  }

  // Log first: the operator has to see the model that actually served the call.
  reqLogger.logConvertedResponse(translatedResponse);
  applyModelAlias(translatedResponse, calledModelName(requestedModel, model));

  const totalLatency = Date.now() - requestStartTime;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId, requestedModel,
    latency: { ttft: totalLatency, total: totalLatency },
    tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: responseBody || null,
    // Recorded from the hub body, so the detail reads the same whatever the client format.
    response: {
      content: openAIResponse?.choices?.[0]?.message?.content || openAIResponse?.content || null,
      thinking: openAIResponse?.choices?.[0]?.message?.reasoning_content || openAIResponse?.reasoning_content || null,
      finish_reason: openAIResponse?.choices?.[0]?.finish_reason || "unknown"
    },
    pxpipe,
    status: "success"
  }, { endpoint: clientRawRequest?.endpoint || null })).catch(err => {
    console.error("[RequestDetail] Failed to save:", err.message);
  });

  // Cache successful non-streaming response if semantic cache is enabled
  if (semanticCacheEnabled && !stream && translatedResponse) {
    try {
      saveToSemanticCache(body, `${provider}/${model}`, translatedResponse);
      if (requestedModel && requestedModel !== `${provider}/${model}`) {
        saveToSemanticCache(body, requestedModel, translatedResponse);
      }
    } catch {}
  }

  // Stream conversion if client requested stream
  if (stream) {
    const { completionToSSEText } = await import("../../transformer/jsonToStreamConverter.js");
    const sseText = completionToSSEText(restoreToolNames(translatedResponse, toolNameMap));
    return {
      success: true,
      response: new Response(sseText, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      }),
    };
  }

  return {
    success: true,
    response: new Response(JSON.stringify(restoreToolNames(translatedResponse, toolNameMap)), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...upstreamResponseHeaders(providerResponse.headers) }
    })
  };
}
