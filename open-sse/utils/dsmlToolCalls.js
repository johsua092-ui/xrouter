import crypto from "node:crypto";

const FW = "[｜|]+";
const DSML_CALLS_BLOCK_RE = new RegExp(`<${FW}DSML${FW}\\s+calls>([\\s\\S]*?)<\\/${FW}DSML${FW}\\s+calls>`, "i");
const DSML_OPEN_RE = new RegExp(`<${FW}DSML${FW}:(\\w+)([^>]*)>`, "i");

function dsmlCloseRe(name) {
  return new RegExp(`</${FW}DSML${FW}:${name}\\s*>`, "i");
}

const DSML_CHILD_NAME_ONLY_RE = /<(\w+)>([\s\S]*?)<\/\1>/g;
const DSML_CHILD_NAMED_RE = /<parameter\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/parameter>/gi;

const STRAY_CLOSE_SRC =
  `</${FW}DSML${FW}(?:tool_calls|invoke|parameter|calls)\\s*>\\n*` + `|</(?:parameter|invoke)>\\n*`;
const DSML_STRAY_CLOSE_RE = new RegExp(STRAY_CLOSE_SRC, "gi");
const DSML_PARTIAL_OPEN_RE = new RegExp(`(<${FW}DSML${FW}[^<]*)$`, "i");

export function parseDsmlToolCalls(text) {
  if (!text || typeof text !== "string") {
    return { content: text || "", toolCalls: [], holdback: "" };
  }

  const toolCalls = [];
  let remaining = text;

  // 1. Dialect A: Nested calls block <｜｜DSML｜｜ calls> ... </｜｜DSML｜｜ calls>
  let matchCalls;
  while ((matchCalls = remaining.match(DSML_CALLS_BLOCK_RE)) !== null) {
    const fullMatch = matchCalls[0];
    const inner = matchCalls[1];
    const openIdx = matchCalls.index;

    // Parse invokes inside the calls block
    const invokeRe = new RegExp(`<${FW}DSML${FW}\\s+invoke\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/${FW}DSML${FW}\\s+invoke>`, "gi");
    let inv;
    while ((inv = invokeRe.exec(inner)) !== null) {
      const toolName = inv[1];
      const invokeBody = inv[2];
      const paramRe = new RegExp(`<(?:${FW}DSML${FW}\\s+)?parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/(?:${FW}DSML${FW}\\s+)?parameter>`, "gi");
      let param;
      const args = {};
      while ((param = paramRe.exec(invokeBody)) !== null) {
        let val = param[2].trim();
        try {
          if ((val.startsWith("{") && val.endsWith("}")) || (val.startsWith("[") && val.endsWith("]"))) {
            val = JSON.parse(val);
          }
        } catch {}
        args[param[1]] = val;
      }
      toolCalls.push({
        id: `call_dsml_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify(args) },
      });
    }

    remaining = remaining.slice(0, openIdx) + remaining.slice(openIdx + fullMatch.length);
  }

  // 2. Dialect B: Named tags <｜DSML｜:tool_name> ... </｜DSML｜:tool_name>
  let cleaned = "";
  while (remaining.length > 0) {
    const openMatch = remaining.match(DSML_OPEN_RE);
    if (!openMatch || openMatch.index === undefined) {
      let tail = remaining.replace(DSML_STRAY_CLOSE_RE, "");
      const partial = tail.match(DSML_PARTIAL_OPEN_RE);
      let holdback = "";
      if (partial) {
        tail = tail.slice(0, partial.index);
        holdback = partial[1];
      }
      cleaned += tail;
      break;
    }

    const before = remaining.slice(0, openMatch.index).replace(DSML_STRAY_CLOSE_RE, "");
    cleaned += before;

    const toolName = openMatch[1];
    const afterOpen = remaining.slice(openMatch.index + openMatch[0].length);
    const closeRe = dsmlCloseRe(toolName);
    const closeMatch = afterOpen.match(closeRe);
    if (!closeMatch) {
      return { content: cleaned, toolCalls, holdback: openMatch[0] + afterOpen };
    }

    const inner = afterOpen.slice(0, closeMatch.index);
    const args = parseDsmlArgs(inner);
    toolCalls.push({
      id: `call_dsml_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
      type: "function",
      function: { name: toolName, arguments: JSON.stringify(args) },
    });

    remaining = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  }

  // Strip stray tags and FINISHED marker
  const strayRe = new RegExp(`<\\/?${FW}DSML${FW}[^>]*>\\n*`, "gi");
  cleaned = cleaned.replace(strayRe, "").replace(/FINISHED/g, "").trim();

  return { content: cleaned, toolCalls, holdback: "" };
}

function parseDsmlArgs(inner) {
  const args = {};
  const namedRe = new RegExp(DSML_CHILD_NAMED_RE);
  let m;
  const consumed = new Set();
  while ((m = namedRe.exec(inner)) !== null) {
    args[m[1]] = m[2].trim();
    consumed.add(m[0]);
  }
  const bareRe = new RegExp(DSML_CHILD_NAME_ONLY_RE);
  while ((m = bareRe.exec(inner)) !== null) {
    if (consumed.has(m[0])) continue;
    let nested = false;
    for (const c of consumed) {
      if (c.includes(m[0]) && c !== m[0]) {
        nested = true;
        break;
      }
    }
    if (nested) continue;
    args[m[1]] = m[2].trim();
    consumed.add(m[0]);
  }
  return args;
}

export function hasDsmlToolCalls(text) {
  if (!text || typeof text !== "string") return false;
  return /[/]?[｜|]+DSML[｜|]+/i.test(text);
}
