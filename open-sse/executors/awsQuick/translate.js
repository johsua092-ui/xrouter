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

// ---------------------------------------------------------------------------
// Byte measurement without allocator churn.
//
// Lengths used to come from `new TextEncoder().encode(s).length`, which
// allocates a full Uint8Array copy of the input on every call — and the
// truncation paths called it inside binary searches and re-measured the same
// block up to four times. Rendering one 150-message transcript with 200 KB
// tool results cost ~8 000 encodes / ~150 MB of transient ArrayBuffers to emit
// a 60 KB frame, and capText(1 MB → 16 KB) allocated 3.2 MB to produce 16 KB.
//
// Now: lengths come from Buffer.byteLength (a scan, no allocation), each block
// is measured once, and cuts are found by scanning in small chunks — the scan
// stops as soon as the budget is exceeded, so capping a 1 MB body to 16 KB
// never touches the last ~98% of it. Cuts land on code point boundaries, so no
// half surrogate pairs reach the wire.
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte length of `s`, without materialising the encoding.
 * Counts like TextEncoder: a lone surrogate becomes U+FFFD (3 bytes).
 */
export const byteLen = (s) => Buffer.byteLength(String(s ?? ""), "utf8");

/** user_message.text is hard-capped at 64 KB server-side; stay under it. */
export const UPSTREAM_TEXT_LIMIT = 60 * 1024;
const SYSTEM_CAP = 24 * 1024;
const USER_TURN_CAP = 20 * 1024;
const TOOL_RESULT_CAP = 16 * 1024;
const TRUNC_MARK = "\n…[truncated]";
const TRUNC_MARK_BYTES = byteLen(TRUNC_MARK);

// Scan granularity: big enough for Buffer.byteLength to run at C++ speed, small
// enough that the transient slice stays a few KB.
const SCAN_CHUNK = 4096;

const isHighSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Longest prefix of `s` within `max` UTF-8 bytes → {text, bytes}.
 * Returns `s` itself (same reference) when it already fits.
 * Scans whole chunks, then walks code points only inside the one chunk that
 * straddles the budget — no binary search, no re-encoding.
 */
function fitPrefix(s, max) {
  if (max <= 0) return { text: "", bytes: 0 };
  const n = s.length;
  let bytes = 0;
  let i = 0;
  while (i < n) {
    let end = i + SCAN_CHUNK;
    if (end >= n) end = n;
    else if (isHighSurrogate(s.charCodeAt(end - 1))) end += 1; // never split a pair
    const chunkBytes = Buffer.byteLength(s.slice(i, end), "utf8");
    if (bytes + chunkBytes <= max) {
      bytes += chunkBytes;
      i = end;
      continue;
    }
    // Budget runs out inside [i, end): step code point by code point.
    while (i < end) {
      const c = s.charCodeAt(i);
      let cost;
      let units = 1;
      if (c < 0x80) cost = 1;
      else if (c < 0x800) cost = 2;
      else if (isHighSurrogate(c)) {
        if (i + 1 < n && isLowSurrogate(s.charCodeAt(i + 1))) {
          cost = 4;
          units = 2;
        } else cost = 3; // lone high surrogate → U+FFFD
      } else cost = 3; // BMP 3-byte char, or lone low surrogate → U+FFFD
      if (bytes + cost > max) return { text: s.slice(0, i), bytes };
      bytes += cost;
      i += units;
    }
  }
  return { text: s, bytes };
}

/** Truncate to a byte budget, appending a marker. */
/**
 * Keep the head and the tail of an over-long system prompt. Operating specs put
 * hard rules first and the response-format/attribution rules last, so a plain
 * head cut silently drops half of them; the middle (usually examples) is what
 * can go.
 */
export function capMiddle(s, maxBytes) {
  const str = String(s ?? "");
  if (byteLen(str) <= maxBytes) return str;
  const mark = "\n\n…[middle of the instructions truncated]…\n\n";
  const markBytes = byteLen(mark);
  const room = maxBytes - markBytes;
  if (room <= 1024) return capText(str, maxBytes);
  const headBytes = Math.floor(room * 0.6);
  const tailBytes = room - headBytes;
  const head = fitPrefix(str, headBytes).text;
  const tail = tailSuffix(str, tailBytes).text;
  return head + mark + tail;
}

export function capText(s, maxBytes) {
  const str = String(s ?? "");
  const head = fitPrefix(str, maxBytes);
  if (head.text === str) return str; // fits: unchanged, no marker, no encode
  const room = maxBytes - TRUNC_MARK_BYTES;
  if (room <= 0) return head.text;
  return fitPrefix(str, room).text + TRUNC_MARK;
}

const STALE_TOOL_CAP = 2 * 1024;

/** Longest suffix of `s` within `max` UTF-8 bytes → {text, bytes}. */
function tailSuffix(s, max) {
  if (max <= 0) return { text: "", bytes: 0 };
  let bytes = 0;
  let i = s.length;
  while (i > 0) {
    let start = i - SCAN_CHUNK;
    if (start <= 0) start = 0;
    else if (isHighSurrogate(s.charCodeAt(start - 1))) start -= 1; // never split a pair
    const chunkBytes = Buffer.byteLength(s.slice(start, i), "utf8");
    if (bytes + chunkBytes <= max) {
      bytes += chunkBytes;
      i = start;
      continue;
    }
    // Budget runs out inside [start, i): walk back code point by code point.
    let room = max - bytes;
    let j = i;
    while (j > start) {
      const c = s.charCodeAt(j - 1);
      let cost;
      let k = j - 1;
      if (c < 0x80) cost = 1;
      else if (c < 0x800) cost = 2;
      else if (isLowSurrogate(c) && k > start && isHighSurrogate(s.charCodeAt(k - 1))) {
        cost = 4;
        k -= 1;
      } else cost = 3; // BMP 3-byte char, or lone surrogate → U+FFFD
      if (cost > room) return { text: s.slice(j), bytes };
      room -= cost;
      bytes += cost;
      j = k;
    }
    i = j;
  }
  return { text: s, bytes };
}

/**
 * Shrink a tool result to `max` bytes keeping head + tail (file headers and
 * trailing errors both matter) and telling the model how to get the rest —
 * a silent cut makes it guess, a vanished result makes it re-run blindly.
 * Returns {text, bytes} so the caller never has to measure the result again.
 */
function shrinkTool(body, max, total = byteLen(body)) {
  if (total <= max) return { text: body, bytes: total };
  const mark = `\n…[${total}-byte result, middle omitted to fit Quick's frame — re-run the tool with a narrower range if you need it]…\n`;
  const markBytes = byteLen(mark);
  const room = max - markBytes;
  if (room < 256) {
    const whole = `[${total}-byte result omitted to fit Quick's frame — re-run the tool if you need it]`;
    return { text: whole, bytes: byteLen(whole) };
  }
  const head = fitPrefix(body, Math.floor((room * 2) / 3));
  const tail = tailSuffix(body, room - head.bytes);
  return { text: head.text + mark + tail.text, bytes: head.bytes + markBytes + tail.bytes };
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
 *
 * Every block carries its own byte length (`b.bytes`), measured once per
 * render — the sort, the water-fill and the overflow loop all reuse it instead
 * of re-encoding bodies. `b.headBytes` covers the tool_result header line.
 */
function fitBlocks(blocks, maxBytes, cut) {
  for (const b of blocks) if (b.bytes === undefined) b.bytes = byteLen(b.body);
  let avail = maxBytes - blocks.reduce((n, b) => n + 2 + (b.tool ? b.headBytes + 1 : b.bytes), 0);
  const tools = blocks.filter((b) => b.tool).sort((a, b) => a.bytes - b.bytes);
  let left = tools.length;
  for (const b of tools) {
    const share = Math.max(0, Math.floor(avail / left--));
    if (b.bytes > share) {
      const shrunk = shrinkTool(b.body, share, b.bytes);
      b.body = shrunk.text;
      b.bytes = shrunk.bytes;
      cut();
    }
    avail -= b.bytes;
  }
  // Rendered size is additive per part (header + "\n" + body), so it comes
  // from the cached lengths instead of a fresh encode of each block.
  const sizes = blocks.map((b) => (b.tool ? b.headBytes + 1 + b.bytes : b.bytes));
  let used = sizes.reduce((n, x) => n + x + 2, 0);
  let dropped = 0;
  while (used > maxBytes && dropped < blocks.length - 1) {
    used -= sizes[dropped++] + 2;
    cut();
  }
  const kept = blocks.slice(dropped).map((b) => ({ ...b, rendered: renderBlock(b) }));
  if (used > maxBytes && kept.length) {
    const lastBlock = kept[kept.length - 1];
    lastBlock.rendered = capText(lastBlock.rendered, Math.max(0, maxBytes - 2));
    cut();
  }
  return { kept, dropped };
}

function toolBlock(m, cap, cut) {
  const text = textOf(m.content);
  let body = text;
  let bytes = byteLen(text);
  if (bytes > cap) {
    const shrunk = shrinkTool(text, cap, bytes);
    body = shrunk.text;
    bytes = shrunk.bytes;
    cut();
  }
  const head = toolHead(m);
  return { tool: true, head, headBytes: byteLen(head), body, bytes };
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
      return { tool: false, role: "user", body: t || "(empty)" };
    }
    return { tool: false, role: canonRole(m.role), body: transcriptLine(m) };
  });
  if (!blocks.length) blocks.push({ tool: false, body: "(empty)" });
  const sysBytes = parts.reduce((n, s) => n + byteLen(s) + 2, 0);
  const { kept, dropped } = fitBlocks(blocks, maxBytes - sysBytes - (blocks.length > 1 ? HISTORY_HEAD_RESERVE : 0), cut);
  const last = kept.pop();
  // A tool result whose assistant tool_call fell outside the window is
  // unanswerable — the model would see an output for a call it never made.
  let orphanTools = 0;
  // A trimmed transcript must open on a user turn: a leading tool result answers
  // a call the model cannot see, and a leading assistant turn makes the model
  // continue its own old sentence instead of answering the new question.
  while (kept.length > 1 && (kept[0].tool || kept[0].role === "assistant")) {
    kept.shift();
    orphanTools++;
    cut();
  }
  if (stats) stats.omittedMessages = (stats.omittedMessages || 0) + dropped + orphanTools;
  if (kept.length || dropped || orphanTools) {
    const total = dropped + orphanTools;
    const head = total
      ? `[conversation so far — ${total} earlier message(s) omitted to fit Quick's 64 KB frame]\n`
      : "[conversation so far]\n";
    parts.push(head + kept.map(renderBlock).join("\n\n"));
  }
  parts.push(renderBlock(last));
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
  if (stats && dropped) stats.omittedMessages = (stats.omittedMessages || 0) + dropped;
  return dropped ? `[${dropped} earlier message(s) omitted to fit Quick's 64 KB frame]\n` + kept.map((b) => b.rendered).join("\n\n") : kept.map((b) => b.rendered).join("\n\n");
}
