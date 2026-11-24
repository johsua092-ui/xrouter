// OpenAI ⇄ Quick message rendering + model/mode mapping.
//
// Ported from magpie-aws-quick lib/translate.mjs (MIT). Quick's user_message
// carries a single `text` field for the conversation; the client's system
// prompt goes through the dedicated `user_message.payload.system_prompt` field
// instead (verified live — the server honors it as a per-turn system override).
// History and tool results are still rendered into the text itself.

/** Text content of one content-part object (OpenAI/Anthropic/Responses shapes). */
function partText(p) {
  if (typeof p === "string") return p;
  const t = p?.type;
  if (t === "text" || t === "input_text" || t === "output_text") return p.text ?? "";
  if (t === "image_url" || t === "input_image" || t === "image") return "[image]";
  if (t === "file" || t === "input_file") return "[file omitted]";
  if (t === "tool_result") return textOf(p.content); // string or nested parts
  if (t === "tool_use") {
    const args = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {});
    return `[called tool ${p.name ?? "tool"}(${args})]`;
  }
  return ""; // thinking/redacted_thinking/audio/etc carry no user-visible text
}

/** Text content of an OpenAI message (string or parts array). */
export function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(partText).filter(Boolean).join("\n");
  }
  return String(content);
}

const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s;

/** One image part as {mimeType, data(base64)} or {url} when it isn't inline data. */
function partImage(p) {
  const t = p?.type;
  if (t !== "image_url" && t !== "input_image" && t !== "image") return null;
  const src = p.source;
  if (src?.type === "base64" && typeof src.data === "string") return { mimeType: src.media_type || "image/png", data: src.data };
  const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? p.url ?? (typeof p.data === "string" && p.mimeType ? `data:${p.mimeType};base64,${p.data}` : "");
  const m = DATA_URL.exec(String(url ?? ""));
  return m ? { mimeType: m[1], data: m[2].replace(/\s+/g, "") } : { url: String(url ?? "") };
}

/** Images in a message's content, including those nested in tool_result parts. */
export function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((p) => (p?.type === "tool_result" ? imagesOf(p.content) : [partImage(p)].filter(Boolean)));
}

const IMAGE_ENTRY_OVERHEAD = 256;

const imageExt = (mimeType) => mimeType?.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "img";
const decodedSize = (data) => {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
};

/**
 * Pick images from `messages` for user_message.attachments. Quick counts
 * inline attachment data against the same ~64 KB frame as the text, so only
 * images whose base64 fits `maxBytes` go inline; the rest land in `skipped`.
 * (magpie's larger-image cloud-upload path is not ported — see the executor's
 * header note.) Names are numbered across the inline set.
 */
export function pickImages(messages, maxBytes) {
  const attachments = [];
  let bytes = 0;
  let skipped = 0;
  let seq = 0;
  for (const m of messages) {
    for (const img of imagesOf(m.content)) {
      const cost = (img.data?.length ?? Infinity) + IMAGE_ENTRY_OVERHEAD;
      if (img.data && bytes + cost <= maxBytes) {
        attachments.push({ type: "image", name: `image-${++seq}.${imageExt(img.mimeType)}`, size: decodedSize(img.data), mimeType: img.mimeType, data: img.data });
        bytes += cost;
        continue;
      }
      skipped++;
    }
  }
  return { attachments, bytes, skipped };
}

/**
 * Canonical role across client dialects: some agents/gateways emit 'ai',
 * 'human', 'observation' etc. instead of the OpenAI names. Thread-reuse
 * prefix matching and transcript rendering both key off this.
 */
export function canonRole(role) {
  const r = String(role ?? "").toLowerCase();
  if (r === "assistant" || r === "ai" || r === "bot" || r === "model" || r === "assistant_message") return "assistant";
  if (r === "user" || r === "human" || r === "input") return "user";
  if (r === "tool" || r === "tool_result" || r === "observation" || r === "tool_output") return "tool";
  return r;
}

/** Agent modes the desktop client can send as `agent_mode`. */
export const AGENT_MODES = Object.freeze(["fast", "balanced", "smart", "advanced"]);

/** Map a requested model id to an agent_mode; unknown → 'smart'. */
export function modeFor(model) {
  const m = String(model ?? "").trim().toLowerCase();
  const bare = m.includes("/") ? m.split("/").pop() : m;
  return AGENT_MODES.includes(bare) ? bare : "smart";
}

/** thinking_effort levels the client understands (off/low/medium/high/max). */
export const EFFORT_LEVELS = Object.freeze(["off", "low", "medium", "high", "max"]);

/**
 * thinking_effort from the body (OpenAI reasoning_effort, thinking_effort, or
 * Anthropic-shim thinking budgets). Returns undefined when unset/invalid
 * (server then uses its default).
 */
export function effortFor(body) {
  const raw = body?.reasoning_effort ?? body?.thinking_effort;
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (EFFORT_LEVELS.includes(v)) return v;
  // magpie/OpenAI spellings → quick levels
  const map = { none: "off", minimal: "low", low: "low", medium: "medium", med: "medium", high: "high", xhigh: "max", max: "max" };
  return map[v] ?? (v === "enabled" || v === "true" ? "high" : v === "disabled" || v === "false" ? "off" : undefined);
}

function renderToolCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) return "";
  return calls
    .map((c) => {
      const name = c?.function?.name ?? c?.name ?? "tool";
      const args = c?.function?.arguments ?? c?.arguments ?? "";
      return `[called tool ${name}(${typeof args === "string" ? args : JSON.stringify(args)})]`;
    })
    .join("\n");
}

const te = new TextEncoder();
export const byteLen = (s) => te.encode(String(s ?? "")).length;

/** user_message.text is hard-capped at 64 KB server-side; stay under it. */
export const UPSTREAM_TEXT_LIMIT = 60 * 1024;
const SYSTEM_CAP = 24 * 1024;
const USER_TURN_CAP = 20 * 1024;
const TOOL_RESULT_CAP = 16 * 1024;
const TRUNC_MARK = "\n…[truncated]";

function fitBytes(s, max) {
  if (byteLen(s) <= max) return s;
  let lo = 0,
    hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (byteLen(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/** Truncate to a byte budget, appending a marker. */
export function capText(s, maxBytes) {
  const str = String(s ?? "");
  if (byteLen(str) <= maxBytes) return str;
  const room = maxBytes - byteLen(TRUNC_MARK);
  if (room <= 0) return fitBytes(str, maxBytes);
  return fitBytes(str, room) + TRUNC_MARK;
}

const STALE_TOOL_CAP = 2 * 1024;

/** Longest suffix of `s` within `max` bytes. */
function tailBytes(s, max) {
  if (max <= 0) return "";
  let lo = 0,
    hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byteLen(s.slice(mid)) <= max) hi = mid;
    else lo = mid + 1;
  }
  return s.slice(lo);
}

/**
 * Shrink a tool result to `max` bytes keeping head + tail (file headers and
 * trailing errors both matter) and telling the model how to get the rest —
 * a silent cut makes it guess, a vanished result makes it re-run blindly.
 */
function shrinkTool(body, max) {
  const total = byteLen(body);
  if (total <= max) return body;
  const mark = `\n…[${total}-byte result, middle omitted to fit Quick's frame — re-run the tool with a narrower range if you need it]…\n`;
  const room = max - byteLen(mark);
  if (room < 256) return `[${total}-byte result omitted to fit Quick's frame — re-run the tool if you need it]`;
  const head = fitBytes(body, Math.floor((room * 2) / 3));
  return head + mark + tailBytes(body, room - byteLen(head));
}

const toolHead = (m) => `[tool_result ${[m.name, m.tool_call_id].filter(Boolean).join(" ")}]`;
const isTool = (m) => canonRole(m.role) === "tool" || m.role === "function";
const renderBlock = (b) => (b.tool ? `${b.head}\n${b.body}` : b.body);

/**
 * Fit blocks into `maxBytes`. Conversation text is fixed; tool-result bodies
 * share what's left by water-filling (small results stay whole, large ones
 * split the remainder evenly), so parallel results all survive partially
 * instead of the oldest vanishing. Only if text alone overflows are the
 * oldest blocks dropped; the last block is never dropped.
 */
function fitBlocks(blocks, maxBytes, cut) {
  let avail = maxBytes - blocks.reduce((n, b) => n + 2 + (b.tool ? byteLen(b.head) + 1 : byteLen(b.body)), 0);
  const tools = blocks
    .filter((b) => b.tool)
    .sort((a, b) => byteLen(a.body) - byteLen(b.body));
  let left = tools.length;
  for (const b of tools) {
    const share = Math.max(0, Math.floor(avail / left--));
    if (byteLen(b.body) > share) {
      b.body = shrinkTool(b.body, share);
      cut();
    }
    avail -= byteLen(b.body);
  }
  const out = blocks.map(renderBlock);
  let used = out.reduce((n, s) => n + byteLen(s) + 2, 0);
  let dropped = 0;
  while (used > maxBytes && dropped < out.length - 1) {
    used -= byteLen(out[dropped++]) + 2;
    cut();
  }
  const kept = out.slice(dropped);
  if (used > maxBytes && kept.length) {
    kept[kept.length - 1] = capText(kept[kept.length - 1], Math.max(0, maxBytes - 2));
    cut();
  }
  return { kept, dropped };
}

function toolBlock(m, cap, cut) {
  let body = textOf(m.content);
  if (byteLen(body) > cap) {
    body = shrinkTool(body, cap);
    cut();
  }
  return { tool: true, head: toolHead(m), body };
}

/** One transcript line for a non-tool message in the rendered history. */
function transcriptLine(m) {
  const text = textOf(m.content);
  const role = canonRole(m.role);
  if (role === "assistant") {
    const calls = renderToolCalls(m.tool_calls);
    return `assistant: ${[text, calls].filter(Boolean).join("\n")}`;
  }
  return `${role}: ${text}`;
}

const HISTORY_HEAD_RESERVE = 96;

/**
 * Full-transcript text for a NEW thread: system prompt + rendered history +
 * the final turn. Everything the model needs in one user_message.
 * Tool results answered before the latest assistant turn are stale and
 * squeezed to STALE_TOOL_CAP; the rest share the budget via fitBlocks.
 * `stats` is mutated with {truncated:true} when anything was cut.
 */
export function renderTranscript(messages, systemText, { maxBytes = Infinity, stats } = {}) {
  const cut = () => {
    if (stats) stats.truncated = true;
  };
  const parts = [];
  if (systemText) {
    if (byteLen(systemText) > SYSTEM_CAP) {
      systemText = capText(systemText, SYSTEM_CAP);
      cut();
    }
    parts.push(`[system instructions]\n${systemText}`);
  }
  let lastAsst = -1;
  messages.forEach((m, i) => {
    if (canonRole(m.role) === "assistant") lastAsst = i;
  });
  const blocks = messages.map((m, i) => {
    if (isTool(m)) return toolBlock(m, i < lastAsst ? STALE_TOOL_CAP : TOOL_RESULT_CAP, cut);
    if (i === messages.length - 1 && canonRole(m.role) === "user") {
      let t = textOf(m.content);
      if (byteLen(t) > USER_TURN_CAP) {
        t = capText(t, USER_TURN_CAP);
        cut();
      }
      return { tool: false, body: t || "(empty)" };
    }
    return { tool: false, body: transcriptLine(m) };
  });
  if (!blocks.length) blocks.push({ tool: false, body: "(empty)" });
  const sysBytes = parts.reduce((n, s) => n + byteLen(s) + 2, 0);
  const { kept, dropped } = fitBlocks(blocks, maxBytes - sysBytes - (blocks.length > 1 ? HISTORY_HEAD_RESERVE : 0), cut);
  const last = kept.pop();
  if (kept.length || dropped) {
    const head = dropped ? `[conversation so far — ${dropped} earlier message(s) omitted]\n` : "[conversation so far]\n";
    parts.push(head + kept.join("\n\n"));
  }
  parts.push(last);
  return parts.join("\n\n");
}

/**
 * Delta text for a REUSED thread: only the new user/tool content.
 * Per-block caps apply first (TOOL_RESULT_CAP / USER_TURN_CAP); then tool
 * results share the remaining budget (fitBlocks) — the current turn's
 * question is never sacrificed for tool output.
 */
export function renderDelta(delta, { maxBytes = Infinity, stats } = {}) {
  const cut = () => {
    if (stats) stats.truncated = true;
  };
  const blocks = [];
  for (const m of delta) {
    if (isTool(m)) {
      blocks.push(toolBlock(m, TOOL_RESULT_CAP, cut));
      continue;
    }
    // assistant messages never appear in a valid delta (findContinuation rejects them)
    if (canonRole(m.role) !== "user") continue;
    let t = textOf(m.content);
    if (!t) continue;
    if (byteLen(t) > USER_TURN_CAP) {
      t = capText(t, USER_TURN_CAP);
      cut();
    }
    blocks.push({ tool: false, body: t });
  }
  if (!blocks.length) return "";
  const { kept, dropped } = fitBlocks(blocks, maxBytes - 48, cut);
  return dropped ? `[${dropped} earlier message(s) omitted]\n` + kept.join("\n\n") : kept.join("\n\n");
}
