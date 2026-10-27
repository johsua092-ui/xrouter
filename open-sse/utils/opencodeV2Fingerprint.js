import { OPENCODE_V2_DEFS } from "./opencodeV2Defs.js";

/**
 * OpenCode V2 1.19.4 full fingerprint definitions extracted from official CLI traffic.
 */
let V2_DEFINITIONS = OPENCODE_V2_DEFS;

export const OPENCODE_V2_FINGERPRINT_TOOLS = Object.keys(V2_DEFINITIONS).length > 0
  ? Object.keys(V2_DEFINITIONS)
  : ["bash", "read", "edit", "glob", "grep", "skill", "task", "todowrite", "webfetch", "websearch", "write"];

export function getV2ToolDefinitions() {
  return V2_DEFINITIONS;
}

const renamedToolNamesV2 = new WeakMap();

export function takeRenamedToolNamesV2(body) {
  if (!body || typeof body !== "object") return null;
  return renamedToolNamesV2.get(body) || null;
}

export function applyOpencodeV2Tools(body) {
  if (!body || typeof body !== "object") return;
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  const map = new Map();
  const existingNames = new Set();

  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const name = t?.function?.name || t?.name;
    if (name) {
      existingNames.add(name);
      if (OPENCODE_V2_FINGERPRINT_TOOLS.includes(name)) {
        const alias = `${name}_client`;
        map.set(alias, name);
        if (t.function) t.function.name = alias;
        else t.name = alias;
        existingNames.add(alias);
      }
    }
  }

  for (const name of OPENCODE_V2_FINGERPRINT_TOOLS) {
    const def = V2_DEFINITIONS[name];
    if (def) {
      tools.push({
        type: "function",
        function: {
          name,
          description: def.description,
          parameters: def.parameters,
        },
      });
    }
  }

  body.tools = tools;
  if (!body.tool_choice) body.tool_choice = "auto";
  if (map.size > 0) {
    renamedToolNamesV2.set(body, map);
  }
}
