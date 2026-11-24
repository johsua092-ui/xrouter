// Amazon Quick (AWS) executor — native provider over the Quick bidi chat
// WebSocket.
//
// Ported from magpie-aws-quick lib/handler.mjs (MIT; wire spec: that repo's
// PROTOCOL.md). Quick has no OpenAI-shaped HTTP API: the desktop client talks
// to a bidi WebSocket (session_connect → user_message → text_delta/
// thinking_delta/… → message_complete). This executor renders the OpenAI
// message list into Quick's text protocol, runs the turn on a cached
// server-side thread, and re-emits it as chat.completion / chat.completion.chunk.
//
// Like gemini-web/cursor, execute() is a FULL override — BaseExecutor's HTTP
// fetch/retry loop never runs. It still returns { response, url, headers,
// transformedBody, responseFormat }, and error paths return JSON Responses with
// real HTTP statuses so chatCore's 401/403 refresh-retry still fires.
//
// Turn termination, thread reuse (claim-on-use), the tool-call text convention
// and the 64 KB frame budgeting all match the reference implementation; image
// attachments are inline-only (the cloud-upload path is not ported).

import { BaseExecutor } from "./base.js";
import { FORMATS } from "../translator/formats.js";
import { SSE_HEADERS, SSE_DONE } from "../utils/sseConstants.js";
import { QuickSocket, QuickWsError, acquireTurn, getSharedSocket } from "./awsQuick/protocol.js";
import { normalizeTools, buildToolPreamble, createToolCallParser } from "./awsQuick/tools.js";
import { createQuickMarkupFilter } from "./awsQuick/markup.js";
import {
  modeFor,
  effortFor,
  renderTranscript,
  renderDelta,
  textOf,
  byteLen,
  capText,
  canonRole,
  pickImages,
  UPSTREAM_TEXT_LIMIT,
} from "./awsQuick/translate.js";
import {
  chainHashes,
  sessionScope,
  sharedFindContinuation,
  sharedSet,
  sharedTake,
  sharedFindEntry,
  extendHash,
  replyMessage,
  replyAnchor,
  tailAnchor,
} from "./awsQuick/sessions.js";
import { ensureFreshAwsQuickCredentials } from "./awsQuick/credentials.js";
import { refreshAwsQuickToken } from "../services/tokenRefresh.js";
import { probeAwsQuickEntitlements } from "../services/usage/aws-quick.js";

const SURFACE = "QUICK_WORK_DESKTOP_WINDOWS";
const APP_VERSION = "1.2.4660";
// system_prompt shares the user_message frame's ~64 KB budget with `text`;
// cap it so the transcript/tool preamble always keeps real room.
const SYSTEM_PROMPT_CAP = 32 * 1024;
// Text room kept free when inline images claim the frame.
const IMAGE_TEXT_RESERVE = 8 * 1024;

const encoder = new TextEncoder();

function errorResponse(status, message, type = "api_error") {
  return new Response(JSON.stringify({ error: { message, type, code: status } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorType(err) {
  if (err?.kind === "auth") return "authentication_error";
  if (err?.status === 429 || err?.kind === "quota") return "rate_limit_error";
  if (String(err?.code || "").match(/limitexceeded|throttl/i)) return "rate_limit_error";
  return "api_error";
}

function httpStatus(err) {
  if (err instanceof QuickWsError || err?.kind) {
    if (err.kind === "auth") return 401;
    if (err.kind === "quota") return 429;
    if (err.kind === "abort") return 499;
    if (err.kind === "timeout") return 503;
  }
  if (String(err?.code || "").match(/limitexceeded|throttl/i)) return 429;
  return err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
}

/** Usage object from a turn_usage event payload (snake_case wire fields). */
function usageFrom(u) {
  if (!u || typeof u !== "object") return null;
  const input = Number(u.input_tokens ?? u.inputTokens) || 0;
  const cached = Number(u.cache_read_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens) || 0;
  const written = Number(u.cache_write_tokens ?? u.cacheWriteTokens) || 0;
  const completion = Number(u.output_tokens ?? u.outputTokens) || 0;
  // Quick reports non-cached input, cache reads and cache writes separately;
  // OpenAI prompt_tokens is the whole prompt side.
  const prompt = input + cached + written;
  const total = Number(u.total_tokens ?? u.totalTokens) || prompt + completion;
  const cost = Number(u.cost_usd ?? u.costUsd);
  const ctx = Number(u.context_window ?? u.contextWindow);
  const resolved = u.resolved_model_id ?? u.served_model_id ?? u.resolvedModelId;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    // Quick-reported extras; OpenAI clients ignore unknown usage fields.
    ...(Number.isFinite(cost) && cost > 0 ? { cost } : {}),
    ...(Number.isFinite(ctx) && ctx > 0 ? { context_window: ctx } : {}),
    ...(typeof resolved === "string" && resolved ? { resolved_model_id: resolved } : {}),
  };
}

function addUsage(acc, u) {
  if (!u) return acc;
  acc = acc ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  // Each agentic step re-reads the whole thread, so summing prompts counted
  // the same context once per step — clients size their context window from
  // prompt_tokens (Claude Code auto-compacted on it). The prompt is the
  // latest step's; only completions accumulate.
  if (u.prompt_tokens) {
    acc.prompt_tokens = u.prompt_tokens;
    if (u.prompt_tokens_details?.cached_tokens) acc.prompt_tokens_details = { cached_tokens: u.prompt_tokens_details.cached_tokens };
    else delete acc.prompt_tokens_details;
  }
  acc.completion_tokens += u.completion_tokens || 0;
  acc.total_tokens = acc.prompt_tokens + acc.completion_tokens;
  if (u.cost) acc.cost = (acc.cost || 0) + u.cost;
  // Window and model are per-turn facts, not sums: keep the latest.
  if (u.context_window) acc.context_window = u.context_window;
  if (u.resolved_model_id) acc.resolved_model_id = u.resolved_model_id;
  return acc;
}

const newCallId = () => `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** Shared-socket key: one socket per connection per WS host. */
function socketKeyFor(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const id = credentials?.connectionId || credentials?.id || String(credentials?.refreshToken || "").slice(-24) || "anon";
  return `aws-quick:${id}:${psd.wsHost || ""}`;
}

/** Latest session snapshot for the socket handshake, from live credentials. */
function sessionSnapshot(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return {
    id_token: credentials?.accessToken || "",
    ws_host: psd.wsHost || "",
    actor_arn: psd.actorArn || "",
    tenant_url: psd.tenantUrl || "",
    aws_account_id: psd.awsAccountId || "",
    region: psd.region || "",
  };
}

/**
 * Normalized turn output:
 *   {type:'meta', threadId, reused, mode}
 *   {type:'text', text}                       visible answer delta
 *   {type:'reasoning', text}                  thinking_delta
 *   {type:'tool_call', id, name, arguments}   parsed convention block
 *   {type:'usage', usage}                     turn_usage (per message)
 *   {type:'note', text}                       non-fatal oddities worth showing
 *   {type:'done', …}                          terminal bookkeeping
 */
async function* runTurn({ credentials, socket, body, options, signal }) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const convo = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  const systemText = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content))
    .join("\n\n");
  const mode = modeFor(body.model);
  const effort = effortFor(body);
  const tcNone = body.tool_choice === "none" || (typeof body.tool_choice === "object" && body.tool_choice?.type === "none");
  const tools = tcNone ? [] : normalizeTools(body.tools);
  // The client's system prompt rides the dedicated user_message.system_prompt
  // field (verified live: the server honors it as a per-turn system override,
  // even at ~54 KB). It shares the same ~64 KB frame budget as `text`, so both
  // are capped together — the transcript budget shrinks by whatever the system
  // prompt occupies.
  const systemPrompt = systemText ? capText(systemText, SYSTEM_PROMPT_CAP) : "";
  const stats = {};
  if (systemText && byteLen(systemText) > SYSTEM_PROMPT_CAP) stats.truncated = true;
  // custom_prompt is a real per-turn instruction channel (verified live). Use
  // it to tell the model this session is app-driven: with client tools, steer
  // local-environment work to the client-tool convention; gateway connections
  // have no connected device, so built-in device tools cannot run — say so, or
  // the model burns agentic turns on guaranteed failures.
  const customPrompt = tools.length
    ? "Calling context: this chat is driven by an external application. The client tools listed in the message are executed by that application on the user's machine; this session has no connected device, so built-in device tools (local files, apps) cannot run here. For questions about the user's project, files or code, call the client tools to read current contents — earlier tool results may be partial, and a fresh read beats guessing."
    : "Calling context: this chat is driven by an external application and has no connected device. Built-in tools that need the user's device (local files, apps) cannot run in this session — say so plainly rather than attempting them.";
  const textCap = Math.max(8 * 1024, UPSTREAM_TEXT_LIMIT - byteLen(systemPrompt) - byteLen(customPrompt) - 1024);

  // Tool specs are part of thread identity: changing them must not resume a
  // thread whose history lacks the convention.
  const identity = options?.identity || "aws-quick";
  const scope = sessionScope(identity, `${mode}|${effort ?? ""}`, systemText, tools.map((t) => t.name));
  const hashes = chainHashes(scope, convo);
  const cont = sharedFindContinuation(hashes, convo, identity);
  // Fuzzy resume: context extensions (pi-magic-context, rewind hooks, …) can
  // prune or rewrite old messages, breaking the strict prefix chain. Anchor on
  // our last reply echo + its 3 predecessors — content hashes survive the
  // position shifts such edits cause. Only the LAST assistant can yield an
  // appendable delta anyway.
  let fuzzy;
  if (!cont) {
    let a = -1;
    for (let i = convo.length - 1; i >= 0; i--) {
      if (canonRole(convo[i]?.role) === "assistant") {
        a = i;
        break;
      }
    }
    if (a >= 3) {
      const rk = replyAnchor(scope, convo[a]);
      const tk = tailAnchor(scope, convo.slice(a - 3, a));
      const hit = sharedFindEntry((e) => e.replyKey === rk && e.tailKey === tk, identity);
      if (hit) {
        const delta = convo.slice(a + 1);
        if (delta.length && delta.every((m) => ["user", "tool", "function"].includes(canonRole(m.role)))) {
          sharedTake(hit.key, identity);
          fuzzy = { entry: hit.entry, delta };
        }
      }
    }
  }
  const reuse = cont ?? fuzzy;
  // A tool preamble that would leave under ~8 KB for the actual message
  // degrades to names+descriptions first — otherwise the frame hard-cap
  // (a tail cut) would eat the user's question and the model would see
  // only the tool list. Names-only is the last resort: verbose descriptions
  // can keep even the lite preamble over budget, and a shed preamble means
  // zero tool instructions and guaranteed plain-text answers.
  const fitPreamble = () => {
    let pre = buildToolPreamble(tools, body.tool_choice);
    if (byteLen(pre) > textCap - 8192) {
      const lite = buildToolPreamble(tools, body.tool_choice, { lite: true });
      if (byteLen(lite) < byteLen(pre)) {
        pre = lite;
        stats.truncated = true;
      }
    }
    if (byteLen(pre) > textCap - 4096) {
      const names = buildToolPreamble(tools, body.tool_choice, { namesOnly: true });
      if (byteLen(names) < byteLen(pre)) {
        pre = names;
        stats.truncated = true;
      }
    }
    return pre;
  };
  // A reused thread already holds the full spec from its first turn (tool
  // names are part of the scope, so a changed toolset never reuses), and
  // whatever rides in `text` stays in Quick's history — so later turns only
  // get a short reminder. Fresh threads, including the stale-thread retry
  // below, get the full spec.
  const preamble = !tools.length ? "" : reuse ? buildToolPreamble(tools, body.tool_choice, { reminder: true }) : fitPreamble();
  const textBudget = Math.max(4 * 1024, textCap - byteLen(preamble));

  // Images ride user_message.attachments inline as base64; only this turn's
  // images are sent, and inline bytes shrink the text budget.
  const lastAsst = convo.findLastIndex((m) => canonRole(m.role) === "assistant");
  const imageSlice = reuse ? reuse.delta : convo.slice(lastAsst + 1);
  const images = pickImages(imageSlice, Math.max(0, textBudget - IMAGE_TEXT_RESERVE));
  const turnBudget = textBudget - images.bytes;
  const frameCap = textCap - images.bytes;
  const imageNote = images.skipped ? `\n\n[${images.skipped} image(s) not delivered: too large for Quick's inline frame]` : "";

  let threadId = reuse ? reuse.entry.threadId : crypto.randomUUID();

  let text;
  let reused = false;
  if (reuse) {
    text = renderDelta(reuse.delta, { maxBytes: turnBudget, stats }) + imageNote;
    reused = true;
  } else {
    text = renderTranscript(convo, "", { maxBytes: turnBudget, stats }) + imageNote;
  }
  // The tool convention rides inside the user_message text (there is no
  // client-tool channel); on reused threads only the short reminder rides,
  // since every byte of text stays in the thread and counts toward context.
  let upstreamText = preamble ? `${preamble}\n\n${text}` : text;
  if (byteLen(upstreamText) > frameCap) {
    // Last resort before the tail-cutting hard cap: shed the preamble so the
    // user's message survives intact (tool calling degrades, the answer doesn't).
    upstreamText = byteLen(text) <= frameCap ? text : capText(text, frameCap);
    stats.truncated = true;
  }
  if (!upstreamText.trim()) upstreamText = "(empty)";

  const state = { text: "", reasoning: "", usage: null, calls: [] };
  // `let`: a retry starts a brand-new turn, so a partially-consumed <tool_call>
  // from the failed attempt must not corrupt it.
  let parser = tools.length ? createToolCallParser() : null;
  // Quick app-only widgets (<decision>/<option>/<artifact>/<sources>) do not
  // render outside the app: rewrite them to Markdown before tool parsing.
  let markup = createQuickMarkupFilter();
  let fedText = false;
  let sawOutput = false;

  const payload = {
    text: upstreamText,
    message_id: crypto.randomUUID(),
    agent_mode: mode,
    user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    user_locale: (Intl.DateTimeFormat().resolvedOptions().locale || "en-US").replace("_", "-"),
  };
  if (effort) payload.thinking_effort = effort;
  // Quick's built-in prompt asks for app-only widgets (<decision>/<option>,
  // <artifact>, <sources>); external clients cannot render them. Ask for plain
  // Markdown and keep the markup filter as the safety net.
  const plainMarkdownNote =
    "Reply in plain Markdown only. Do not emit <decision>, <option>, <artifact> or <sources> blocks; " +
    "present choices as a Markdown bullet list instead.";
  if (systemPrompt) payload.system_prompt = systemPrompt + "\n\n" + plainMarkdownNote;
  if (customPrompt) payload.custom_prompt = customPrompt;
  // Client-supplied tools own the tool loop; keep Quick's web search out of it.
  if (tools.length) payload.web_search_enabled = false;
  if (images.attachments.length) payload.attachments = images.attachments;

  function emitParsed(r) {
    // r: {text, calls:[{name,arguments}]} — yields normalized items, mutates state.
    const out = [];
    if (r.text) {
      state.text += r.text;
      out.push({ type: "text", text: r.text });
    }
    for (const c of r.calls) {
      const id = newCallId();
      state.calls.push({ id, name: c.name });
      out.push({ type: "tool_call", id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) });
    }
    if (out.length) sawOutput = true;
    return out;
  }

  async function* consume(turnIt) {
    for await (const evt of turnIt) {
      const t = evt.type;
      const p = evt.payload || {};
      if (t === "text_delta" && typeof p.delta === "string") {
        fedText = true;
        const clean = markup.push(p.delta);
        if (clean) {
          const r = parser ? parser.push(clean) : { text: clean, calls: [] };
          yield* emitParsed(r);
        }
      } else if (t === "thinking_delta" && typeof p.delta === "string") {
        sawOutput = true;
        state.reasoning += p.delta;
        yield { type: "reasoning", text: p.delta };
      } else if (t === "turn_usage") {
        const u = usageFrom(p);
        if (u) {
          state.usage = addUsage(state.usage, u);
          yield { type: "usage", usage: u };
        }
      } else if (t === "message_complete") {
        // Fallback: deltas can be dropped; the complete payload carries full text.
        // Only when NO delta arrived — parser buffer would double-count otherwise.
        if (!fedText && typeof p.text === "string" && p.text) {
          const clean = markup.push(p.text);
          if (clean) {
            const r = parser ? parser.push(clean) : { text: clean, calls: [] };
            yield* emitParsed(r);
          }
        }
      } else if (t === "message_start" || t === "connected" || t === "session_established" || t === "keepalive") {
        // noise
      } else if (t === "status") {
        const s = p.status || p.message;
        if (s && !/pong|ok/i.test(String(s))) yield { type: "note", text: `[quick] ${s}` };
      } else if (t === "guardrail_blocked" || t === "error") {
        // Error details may live in payload OR at the event's top level;
        // dump the whole event (truncated) when nothing readable is found.
        const detail = p.message || p.reason || p.error || evt.message || evt.reason || evt.error || evt.code;
        const extra = detail ? "" : ` ${JSON.stringify(evt).slice(0, 400)}`;
        const quota = String(evt.code || "").match(/limitexceeded|throttl|toomanyrequests/i);
        throw new QuickWsError(`${detail || `quick ${t}`}${extra}`, { kind: quota ? "quota" : "stream", code: evt.code });
      }
      // tool_start/tool_arguments/tool_progress/tool_result, runs_updated,
      // task_list_update, title_generated, session_sync … are agent-internal;
      // Quick executes its own tools, so they don't map to OpenAI tool_calls.
    }
    const heldMarkup = markup.end();
    if (heldMarkup) {
      const r = parser ? parser.push(heldMarkup) : { text: heldMarkup, calls: [] };
      yield* emitParsed(r);
    }
    if (parser) {
      const tail = parser.end();
      if (tail.text) yield* emitParsed({ text: tail.text, calls: [] });
      for (const c of tail.calls ?? []) {
        const id = newCallId();
        state.calls.push({ id, name: c.name });
        yield { type: "tool_call", id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) };
      }
      if (tail.dropped) yield { type: "note", text: "[quick] tool call output was truncated and has been ignored" };
    }
  }

  yield { type: "meta", threadId, reused, mode };
  if (stats.truncated) yield { type: "note", text: "Context exceeded Quick's 64KB frame cap; earlier content was truncated" };

  const produced = () => state.text.length > 0 || state.calls.length > 0 || state.reasoning.length > 0;
  // Bounded wait: a request queued behind a wedged holder must fail cleanly
  // (503) instead of hanging forever, and a client abort drops it at once.
  const release = await acquireTurn(socket, { signal });
  try {
    try {
      for await (const o of consume(socket.turn(threadId, payload, { signal }))) yield o;
    } catch (e) {
      // Retry once when nothing was produced: a cached thread may be gone
      // server-side, and a 1006/timeout on a fresh thread means the server never
      // got the message (same threadId is safe to re-send).
      if (produced() || signal?.aborted || e?.kind === "auth") throw e;
      if (!(reuse || e?.kind === "ws" || e?.kind === "timeout" || e?.code === 1006)) throw e;
      const fresh = reuse ? crypto.randomUUID() : threadId;
      const full = renderTranscript(convo, "", { maxBytes: turnBudget, stats }) + imageNote;
      const fullPreamble = tools.length ? fitPreamble() : "";
      const fullText = fullPreamble ? `${fullPreamble}\n\n${full}` : full;
      const capped = byteLen(fullText) > frameCap ? capText(fullText, frameCap) : fullText;
      state.text = "";
      state.reasoning = "";
      state.usage = null;
      state.calls = [];
      fedText = false;
      sawOutput = false;
      parser = tools.length ? createToolCallParser() : null;
      markup = createQuickMarkupFilter();
      threadId = fresh;
      reused = false;
      yield { type: "meta", threadId: fresh, reused: false, mode };
      payload.text = capped.trim() || "(empty)";
      payload.message_id = crypto.randomUUID();
      if (images.attachments.length) payload.attachments = images.attachments;
      else delete payload.attachments;
      for await (const o of consume(socket.turn(fresh, payload, { signal }))) yield o;
    }
  } finally {
    release();
  }

  // Remember where this conversation stands for the next request.
  if (state.text || state.calls.length) {
    const reply = replyMessage(state.text, state.calls);
    const key = extendHash(hashes[convo.length], reply);
    sharedSet(
      key,
      {
        threadId,
        replyKey: replyAnchor(scope, reply),
        tailKey: tailAnchor(scope, convo.slice(-3)),
      },
      identity
    );
  }
  yield { type: "done", threadId, text: state.text, reasoning: state.reasoning, usage: state.usage };
}

function makeId(threadId) {
  return `chatcmpl-quick-${threadId?.slice(0, 8) ?? "x"}-${Date.now().toString(36)}`;
}

export class AwsQuickExecutor extends BaseExecutor {
  constructor() {
    // No HTTP upstream: the executor owns the whole request via the WS. The
    // registry's transport only carries format:"openai" for request translation.
    super("aws-quick", { baseUrl: "" });
  }

  /**
   * Full execute() override — no super.fetch loop. Returns
   * { response, url, headers, transformedBody, responseFormat: FORMATS.OPENAI }.
   */
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const bodyObj = body || {};
    if (!Array.isArray(bodyObj.messages) || !bodyObj.messages.length) {
      return {
        response: errorResponse(400, "messages is required", "invalid_request_error"),
        url: "wss://aws-quick",
        headers: {},
        transformedBody: body,
        responseFormat: FORMATS.OPENAI,
      };
    }

    const psd = credentials?.providerSpecificData || {};
    const fail = (status, message, type) => ({
      response: errorResponse(status, message, type),
      url: "wss://aws-quick",
      headers: {},
      transformedBody: body,
      responseFormat: FORMATS.OPENAI,
    });

    // Client already gone: nothing to connect for, and a turn started here
    // would hold the per-socket mutex with nobody reading it.
    if (signal?.aborted) return fail(499, "Request aborted by client", "api_error");

    if (!psd.wsHost) {
      return fail(401, "Amazon Quick connection is missing providerSpecificData.wsHost — reconnect the provider", "authentication_error");
    }

    // Pre-flight freshness: the id_token is baked into the WS handshake URL, so
    // renew BEFORE the turn (single-flight, rotated RT persisted).
    let creds = credentials;
    try {
      const fresh = await ensureFreshAwsQuickCredentials(credentials, log);
      creds = fresh.credentials;
      if (fresh.error && !creds?.accessToken) {
        return fail(401, fresh.error.message, "authentication_error");
      }
    } catch (e) {
      if (!credentials?.accessToken) {
        return fail(401, `Amazon Quick token refresh failed: ${e.message}`, "authentication_error");
      }
      log?.warn?.("TOKEN_REFRESH", `aws-quick pre-flight refresh failed, using existing token: ${e.message}`);
    }
    if (!creds?.accessToken) {
      return fail(401, "Amazon Quick connection has no access token — reconnect the provider", "authentication_error");
    }

    // One shared socket per connection (globalThis-cached across hot reloads).
    // The session snapshot is refreshed on every execute so a post-refresh
    // handshake uses the new id_token without rebuilding the socket object.
    const socket = getSharedSocket(socketKeyFor(creds), () => new QuickSocket({
      getSession: async () => socket._session,
      outpostId: psd.outpostId || "",
      extra: {
        surfaceType: SURFACE,
        appVersion: psd.appVersion || APP_VERSION,
        channel: psd.stage || "prod",
      },
      log: (msg) => log?.debug?.("AWS-QUICK", msg),
    }));
    socket._session = sessionSnapshot(creds);

    const requestedModel = typeof bodyObj.model === "string" && bodyObj.model.trim() ? bodyObj.model.trim() : "smart";
    const it = runTurn({
      credentials: creds,
      socket,
      body: { ...bodyObj, model: requestedModel },
      options: { identity: creds.connectionId || creds.id || "aws-quick" },
      signal,
    });

    // Pull up to the first real output before answering so auth/session failures
    // surface as real HTTP statuses (chatCore refresh-retries 401/403) instead of
    // a 200 stream that dies immediately.
    // The client can vanish mid-handshake: abort the generator and make the
    // pre-pull abortable, or a dead request parks here holding the mutex.
    const onAbort = () => {
      try {
        Promise.resolve(it.return?.()).catch(() => {});
      } catch {}
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanupAbort = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const next = () => {
      const p = it.next();
      if (!signal) return p;
      return new Promise((resolve, reject) => {
        const onSig = () => reject(new QuickWsError("aborted", { kind: "abort" }));
        signal.addEventListener("abort", onSig, { once: true });
        p.then(
          (v) => {
            signal.removeEventListener("abort", onSig);
            resolve(v);
          },
          (e) => {
            signal.removeEventListener("abort", onSig);
            reject(e);
          }
        );
      });
    };

    const pre = [];
    let done = false;
    let meta;
    try {
      for (;;) {
        const r = await next();
        if (r.done) {
          done = true;
          break;
        }
        if (r.value.type === "meta") {
          meta = r.value;
          continue;
        }
        // Notes (e.g. the 64 KB truncation warning) are real output — keep them
        // even when they are the first thing the turn emits.
        pre.push(r.value);
        if (r.value.type === "note") continue;
        break;
      }
    } catch (e) {
      cleanupAbort();
      if (e instanceof QuickWsError && e.kind === "auth") socket.close().catch(() => {});
      return fail(httpStatus(e), e?.message ?? String(e), errorType(e));
    }

    const items = (async function* () {
      yield* pre;
      if (done) return;
      for (;;) {
        const r = await next();
        if (r.done) return;
        yield r.value;
      }
    })();

    const created = Math.floor(Date.now() / 1000);
    const id = makeId(meta?.threadId);
    const wireModel = requestedModel;

    if (!stream) {
      let text = "";
      let reasoning = "";
      const calls = [];
      let usage;
      try {
        for await (const o of items) {
          if (o.type === "text") text += o.text;
          else if (o.type === "reasoning") reasoning += o.text;
          else if (o.type === "tool_call") calls.push({ id: o.id, type: "function", function: { name: o.name, arguments: o.arguments } });
          else if (o.type === "usage") usage = addUsage(usage, o.usage);
        }
      } catch (e) {
        return fail(httpStatus(e), e?.message ?? String(e), errorType(e));
      } finally {
        cleanupAbort();
      }
      const message = { role: "assistant", content: text };
      if (reasoning) message.reasoning_content = reasoning;
      if (calls.length) message.tool_calls = calls;
      return {
        response: new Response(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: wireModel,
            choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
            usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
        url: "wss://aws-quick",
        headers: {},
        transformedBody: body,
        responseFormat: FORMATS.OPENAI,
      };
    }

    const sseChunk = (delta, finishReason = null, usage) =>
      encoder.encode(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: wireModel,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`
      );
    // OpenAI semantics: streaming usage is opt-in and rides a trailing chunk
    // with an empty choices array (mirrors the reference handler).
    const includeUsage = !!bodyObj.stream_options?.include_usage;
    const readable = new ReadableStream({
      async start(controller) {
        let sentRole = false;
        const role = () => {
          if (sentRole) return;
          sentRole = true;
          controller.enqueue(sseChunk({ role: "assistant", content: "" }));
        };
        let toolIndex = 0;
        let usage;
        try {
          for await (const o of items) {
            if (o.type === "text") {
              role();
              controller.enqueue(sseChunk({ content: o.text }));
            } else if (o.type === "reasoning") {
              role();
              controller.enqueue(sseChunk({ reasoning_content: o.text }));
            } else if (o.type === "tool_call") {
              role();
              controller.enqueue(
                sseChunk({ tool_calls: [{ index: toolIndex++, id: o.id, type: "function", function: { name: o.name, arguments: o.arguments } }] })
              );
            } else if (o.type === "usage") {
              usage = addUsage(usage, o.usage);
            } else if (o.type === "note") {
              role();
              controller.enqueue(sseChunk({ content: `\n\n> ${o.text}` }));
            }
          }
          role();
          controller.enqueue(sseChunk({}, toolIndex > 0 ? "tool_calls" : "stop"));
          if (includeUsage) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: wireModel,
                  choices: [],
                  usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                })}\n\n`
              )
            );
          }
          controller.enqueue(encoder.encode(SSE_DONE));
        } catch (e) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: { message: e?.message ?? String(e), type: errorType(e), code: httpStatus(e) } })}\n\n`)
          );
          controller.enqueue(encoder.encode(SSE_DONE));
        } finally {
          cleanupAbort();
          controller.close();
        }
      },
      cancel() {
        cleanupAbort();
        // Fire-and-forget: a generator torn down mid-flight may reject.
        Promise.resolve(items.return?.()).catch(() => {});
        Promise.resolve(it.return?.()).catch(() => {});
      },
    });
    return {
      response: new Response(readable, { status: 200, headers: { ...SSE_HEADERS } }),
      url: "wss://aws-quick",
      headers: {},
      transformedBody: body,
      responseFormat: FORMATS.OPENAI,
    };
  }

  /**
   * chatCore's 401/403 refresh-retry path: return merged credentials with the
   * ROTATED refresh token; chatCore assigns + persists them (onCredentialsRefreshed).
   */
  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    try {
      const result = await refreshAwsQuickToken(credentials.refreshToken, credentials.providerSpecificData, log);
      if (!result?.accessToken) return null;
      return result;
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `aws-quick refresh error: ${error.message}`);
      return null;
    }
  }

  /** Entitlements probe (qbs-event) — same surface the Usage page uses. */
  async testConnection(credentials, proxyOptions = null) {
    try {
      const psd = credentials?.providerSpecificData || {};
      if (!credentials?.accessToken || !psd.tenantUrl) return false;
      const resp = await probeAwsQuickEntitlements(credentials.accessToken, psd, proxyOptions);
      return !!resp;
    } catch {
      return false;
    }
  }
}

export default AwsQuickExecutor;
