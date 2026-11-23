// Quick app-only UI markup → plain Markdown.
//
// Quick's built-in system prompt tells the model to answer with app widgets:
//   <decision question="…"><option description="…">Label</option>…</decision>
//   <artifact …>…</artifact>            (canvas wrappers)
//   <sources>…</sources>                (citation blocks)
// None of that renders outside the Quick app, so clients (Claude Code, Codex,
// OpenCode, …) used to receive raw tags. This module rewrites the known tags
// into Markdown bullets and drops the wrappers; everything else passes through
// untouched (including the <tool_call> convention, which is parsed later).
//
// Two entry points:
//   sanitizeQuickMarkup(text)      – whole string (non-stream)
//   createQuickMarkupFilter()      – streaming; push() text, end() flush

const KNOWN_OPEN = ["<decision", "<option", "<artifact", "<sources", "<source"];
const KNOWN_CLOSE = ["</decision>", "</option>", "</artifact>", "</sources>", "</source>"];
// Longest tag prefix we may need to hold back to decide what a partial "<…" is.
const HOLD_CAP = 64 * 1024;

function attr(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (!m) return "";
  const raw = m[2] !== undefined ? m[2] : m[3] || "";
  return raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** Rewrite one complete <option …>Label</option> to a Markdown bullet. */
function optionToBullet(tag, label) {
  const desc = attr(tag, "description").trim();
  const name = label.replace(/\s+/g, " ").trim();
  if (!name && !desc) return "";
  if (!name) return `- ${desc}`;
  return desc ? `- **${name}** — ${desc}` : `- **${name}**`;
}

/**
 * Transform a chunk that starts with a known tag. Returns
 * { out, consumed } where consumed is how many chars of `s` were handled,
 * or null when `s` is an incomplete construct (caller should hold and wait).
 */
function consumeTag(s) {
  const lower = s.toLowerCase();

  // <option …>Label</option> — must wait for the full element
  if (lower.startsWith("<option")) {
    const gt = s.indexOf(">");
    if (gt < 0) return null;
    const close = lower.indexOf("</option>", gt);
    if (close < 0) return null;
    const tag = s.slice(0, gt + 1);
    const label = s.slice(gt + 1, close);
    return { out: optionToBullet(tag, label), consumed: close + "</option>".length };
  }
  if (lower.startsWith("</option>")) return { out: "", consumed: "</option>".length };

  // <decision question="…"> → bold question line
  if (lower.startsWith("<decision")) {
    const gt = s.indexOf(">");
    if (gt < 0) return null;
    const question = attr(s.slice(0, gt + 1), "question").trim();
    return { out: question ? `\n**${question}**\n` : "\n", consumed: gt + 1 };
  }
  if (lower.startsWith("</decision>")) return { out: "\n", consumed: "</decision>".length };

  // <artifact …> / <sources> wrappers: drop the tag, keep the content
  for (const [open, close] of [["<artifact", "</artifact>"], ["<sources", "</sources>"]]) {
    if (lower.startsWith(open)) {
      const gt = s.indexOf(">");
      if (gt < 0) return null;
      const body = lower.startsWith("<sources") ? "\n\n**Sources**\n" : "";
      return { out: body, consumed: gt + 1 };
    }
    if (lower.startsWith(close)) return { out: "", consumed: close.length };
  }

  // <source …>Title</source> → bullet (attributes optional)
  if (lower.startsWith("<source") && /^<source[\s>]/i.test(s)) {
    const gt = s.indexOf(">");
    if (gt < 0) return null;
    const close = lower.indexOf("</source>", gt);
    if (close < 0) return null;
    const title = s.slice(gt + 1, close).replace(/\s+/g, " ").trim();
    const url = attr(s.slice(0, gt + 1), "url") || attr(s.slice(0, gt + 1), "href");
    const out = title ? `- ${url ? `[${title}](${url})` : title}\n` : url ? `- ${url}\n` : "";
    return { out, consumed: close + "</source>".length };
  }
  if (lower.startsWith("</source>")) return { out: "", consumed: "</source>".length };

  return null; // not a known tag
}

function couldBeTagPrefix(rest) {
  const lower = rest.toLowerCase();
  if (lower === "<" || lower === "</") return true;
  // `rest` is a prefix of a known tag (still growing) OR already starts with
  // one and is only waiting for its ">" / element close — both must be held.
  return [...KNOWN_OPEN, ...KNOWN_CLOSE].some((t) => t.startsWith(lower) || lower.startsWith(t));
}

/** Whole-string transform (non-stream path). */
export function sanitizeQuickMarkup(text) {
  let s = String(text ?? "");
  if (!s.includes("<")) return s;
  let out = "";
  let guard = 0;
  while (s && guard++ < 5000) {
    const lt = s.indexOf("<");
    if (lt < 0) { out += s; break; }
    out += s.slice(0, lt);
    const rest = s.slice(lt);
    const hit = consumeTag(rest);
    if (hit) {
      out += hit.out;
      s = rest.slice(hit.consumed);
      continue;
    }
    // Unknown tag / bare "<": emit it literally and move on.
    out += "<";
    s = rest.slice(1);
  }
  return tidy(out);
}

/** Collapse the blank lines the original markup and our bullets introduce. */
function tidy(out) {
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}(?=\n?- )/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Streaming filter. Holds back a trailing incomplete tag (or a "<" that may
 * still grow into one) so tags split across chunks are never emitted raw.
 */
export function createQuickMarkupFilter() {
  let buf = "";
  let done = false;

  return {
    push(chunk) {
      if (done) return "";
      buf += chunk ?? "";
      let out = "";
      for (;;) {
        const lt = buf.indexOf("<");
        if (lt < 0) { out += buf; buf = ""; break; }
        out += buf.slice(0, lt);
        const rest = buf.slice(lt);
        const hit = consumeTag(rest);
        if (hit) {
          out += hit.out;
          buf = rest.slice(hit.consumed);
          continue;
        }
        if (couldBeTagPrefix(rest)) {
          // Incomplete known tag — keep everything from "<" buffered.
          buf = rest;
          break;
        }
        // Unknown markup: pass the "<" through and keep scanning.
        out += "<";
        buf = rest.slice(1);
      }
      if (buf.length > HOLD_CAP) { out += buf; buf = ""; } // fail open
      return tidy(out);
    },
    end() {
      const rest = buf;
      buf = "";
      if (!rest) return "";
      const hit = consumeTag(rest);
      if (hit) return hit.out + rest.slice(hit.consumed);
      return rest;
    },
  };
}
