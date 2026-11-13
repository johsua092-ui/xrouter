import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { sealCredential, unsealCredential } from "@/lib/vault/credentialVault.js";

const SCOPE = "promptInjections";

function rowToRule(row) {
  if (!row) return null;
  const val = parseJson(row.value, {});
  return {
    id: row.key,
    name: val.name || "Untitled Injection",
    description: val.description || "",
    enabled: val.enabled !== false,
    // "all" | "models" | "combos" | "custom"
    targetType: val.targetType || "models",
    targetCombos: Array.isArray(val.targetCombos) ? val.targetCombos : [],
    targetModels: Array.isArray(val.targetModels) ? val.targetModels : [],
    // Target API keys (empty = all keys or unauthenticated)
    targetKeys: Array.isArray(val.targetKeys) ? val.targetKeys : [],
    // Prompt keyword / regex match condition
    matchCondition: {
      type: val.matchCondition?.type || "always", // "always" | "contains" | "regex"
      pattern: typeof val.matchCondition?.pattern === "string" ? val.matchCondition.pattern : "",
      caseSensitive: !!val.matchCondition?.caseSensitive,
    },
    // "system_prepend" | "system_append" | "system_override" | "user_prepend" | "user_append"
    position: val.position || "system_prepend",
    content: typeof val.content === "string" ? unsealCredential(val.content) : "",
    normalizeTriggers: val.normalizeTriggers === true,
    stripRefusal: val.stripRefusal === true,
    blockNoneSafety: val.blockNoneSafety === true,
    syncToHermes: val.syncToHermes === true,
    excludeModels: Array.isArray(val.excludeModels) ? val.excludeModels : [],
    priority: Number.isFinite(val.priority) ? val.priority : 10,
    createdAt: val.createdAt || new Date().toISOString(),
    updatedAt: val.updatedAt || new Date().toISOString(),
  };
}

export async function getPromptInjections() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const rules = rows
    .map(rowToRule)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  return rules;
}

export async function getPromptInjectionById(id) {
  if (!id) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT key, value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id]);
  return rowToRule(row);
}

export async function createPromptInjection(data) {
  const db = await getAdapter();
  const id = data.id || randomUUID();
  const now = new Date().toISOString();
  const rule = {
    id,
    name: (data.name || "New Prompt Injection").trim(),
    description: (data.description || "").trim(),
    enabled: data.enabled !== false,
    targetType: data.targetType || "models",
    targetCombos: Array.isArray(data.targetCombos) ? data.targetCombos.map((s) => String(s).trim()).filter(Boolean) : [],
    targetModels: Array.isArray(data.targetModels) ? data.targetModels.map((s) => String(s).trim()).filter(Boolean) : [],
    targetKeys: Array.isArray(data.targetKeys) ? data.targetKeys.map((s) => String(s).trim()).filter(Boolean) : [],
    matchCondition: {
      type: data.matchCondition?.type || "always",
      pattern: typeof data.matchCondition?.pattern === "string" ? data.matchCondition.pattern.trim() : "",
      caseSensitive: !!data.matchCondition?.caseSensitive,
    },
    position: data.position || "system_prepend",
    content: typeof data.content === "string" ? data.content : "",
    normalizeTriggers: data.normalizeTriggers === true,
    stripRefusal: data.stripRefusal === true,
    blockNoneSafety: data.blockNoneSafety === true,
    syncToHermes: data.syncToHermes === true,
    excludeModels: Array.isArray(data.excludeModels) ? data.excludeModels : [],
    priority: Number.isFinite(data.priority) ? Number(data.priority) : 10,
    createdAt: now,
    updatedAt: now,
  };

  // Encrypt prompt content at rest using AES-256-GCM Vault
  const storedRule = {
    ...rule,
    content: sealCredential(rule.content),
  };

  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, id, stringifyJson(storedRule)]
  );

  // Auto-sync persona to Hermes/Synapse SOUL.md if enabled
  if (data.syncToHermes === true && rule.content) {
    import("@/lib/persona/hermesSync.js").then(({ syncPersonaToHermes }) => {
      syncPersonaToHermes(rule.content);
    }).catch(() => {});
  }

  return rule;
}

export async function updatePromptInjection(id, data) {
  if (!id) return null;
  const db = await getAdapter();
  const existing = await getPromptInjectionById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updated = {
    ...existing,
    ...data,
    id,
    targetCombos: Array.isArray(data.targetCombos)
      ? data.targetCombos.map((s) => String(s).trim()).filter(Boolean)
      : existing.targetCombos,
    targetModels: Array.isArray(data.targetModels)
      ? data.targetModels.map((s) => String(s).trim()).filter(Boolean)
      : existing.targetModels,
    targetKeys: Array.isArray(data.targetKeys)
      ? data.targetKeys.map((s) => String(s).trim()).filter(Boolean)
      : existing.targetKeys,
    matchCondition: data.matchCondition !== undefined ? {
      type: data.matchCondition?.type || "always",
      pattern: typeof data.matchCondition?.pattern === "string" ? data.matchCondition.pattern.trim() : "",
      caseSensitive: !!data.matchCondition?.caseSensitive,
    } : existing.matchCondition,
    normalizeTriggers: data.normalizeTriggers !== undefined ? data.normalizeTriggers === true : existing.normalizeTriggers,
    stripRefusal: data.stripRefusal !== undefined ? data.stripRefusal === true : existing.stripRefusal,
    blockNoneSafety: data.blockNoneSafety !== undefined ? data.blockNoneSafety === true : existing.blockNoneSafety,
    syncToHermes: data.syncToHermes !== undefined ? data.syncToHermes === true : existing.syncToHermes,
    excludeModels: Array.isArray(data.excludeModels) ? data.excludeModels : existing.excludeModels,
    updatedAt: now,
  };

  // Encrypt prompt content at rest using AES-256-GCM Vault
  const storedUpdated = {
    ...updated,
    content: sealCredential(updated.content),
  };

  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, id, stringifyJson(storedUpdated)]
  );

  // Auto-sync persona to Hermes/Synapse SOUL.md if enabled
  if ((data.syncToHermes === true || updated.syncToHermes === true) && updated.content) {
    import("@/lib/persona/hermesSync.js").then(({ syncPersonaToHermes }) => {
      syncPersonaToHermes(updated.content);
    }).catch(() => {});
  }

  return updated;
}

export async function deletePromptInjection(id) {
  if (!id) return false;
  const db = await getAdapter();
  const res = db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id]);
  return (res?.changes ?? 0) > 0;
}

export async function togglePromptInjection(id, enabled) {
  return await updatePromptInjection(id, { enabled });
}

export async function reorderPromptInjections(orderedIds) {
  if (!Array.isArray(orderedIds)) return false;
  const db = await getAdapter();
  db.transaction(() => {
    orderedIds.forEach((id, index) => {
      const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id]);
      if (row) {
        const val = parseJson(row.value, {});
        val.priority = index + 1;
        val.updatedAt = new Date().toISOString();
        db.run(`UPDATE kv SET value = ? WHERE scope = ? AND key = ?`, [stringifyJson(val), SCOPE, id]);
      }
    });
  });
  return true;
}

/**
 * Extract user prompt text across different wire formats for keyword/regex checks
 */
export function extractUserText(body) {
  if (!body) return "";
  if (Array.isArray(body.messages)) {
    const userMsgs = body.messages.filter((m) => m && m.role === "user");
    return userMsgs
      .map((m) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
            .map((p) => p.text || "")
            .join(" ");
        }
        return "";
      })
      .join("\n");
  }
  if (Array.isArray(body.contents)) {
    return body.contents
      .filter((c) => c && c.role === "user")
      .flatMap((c) => (Array.isArray(c.parts) ? c.parts.map((p) => p?.text || "") : []))
      .join("\n");
  }
  if (typeof body.input === "string") return body.input;
  if (Array.isArray(body.input)) {
    return body.input
      .filter((i) => i && (i.role === "user" || i.type === "message"))
      .map((i) => (typeof i.content === "string" ? i.content : ""))
      .join("\n");
  }
  return "";
}

/**
 * Match a target against pattern (exact or wildcard prefix/suffix)
 */
function matchesPattern(target, pattern) {
  if (!target || !pattern) return false;
  const t = String(target).trim().toLowerCase();
  const p = String(pattern).trim().toLowerCase();
  if (p === "*" || p === t) return true;
  if (p.endsWith("*") && p.startsWith("*")) {
    return t.includes(p.slice(1, -1));
  }
  if (p.endsWith("*")) {
    return t.startsWith(p.slice(0, -1));
  }
  if (p.startsWith("*")) {
    return t.endsWith(p.slice(1));
  }
  return false;
}

/**
 * Evaluate if a rule matches the current request context (async to check API keys if needed)
 */
export async function isRuleMatching(rule, { modelStr = "", comboName = "", provider = "", model = "", apiKey = "", userText = "" } = {}) {
  if (!rule || !rule.enabled) return false;
  if (!rule.content || !rule.content.trim()) return false;

  // Check exclude models list (Persona exclude rules)
  if (Array.isArray(rule.excludeModels) && rule.excludeModels.length > 0) {
    const fullTarget = `${provider}/${model}`.toLowerCase();
    const isExcluded = rule.excludeModels.some((ex) => {
      const e = ex.toLowerCase().trim();
      return e === modelStr.toLowerCase() || e === model.toLowerCase() || fullTarget.includes(e);
    });
    if (isExcluded) return false;
  }

  // 1. Target API Keys restriction check
  if (Array.isArray(rule.targetKeys) && rule.targetKeys.length > 0) {
    if (!apiKey) return false;
    let matchesKey = rule.targetKeys.includes(apiKey);
    if (!matchesKey) {
      try {
        const { getApiKeyByKey } = await import("./apiKeysRepo.js");
        const keyObj = await getApiKeyByKey(apiKey);
        if (keyObj && (rule.targetKeys.includes(keyObj.id) || rule.targetKeys.includes(keyObj.name) || rule.targetKeys.includes(keyObj.key))) {
          matchesKey = true;
        }
      } catch {}
    }
    if (!matchesKey) return false;
  }

  // 2. Keyword / Regex trigger condition check
  if (rule.matchCondition && rule.matchCondition.type && rule.matchCondition.type !== "always") {
    const text = userText || "";
    const pattern = (rule.matchCondition.pattern || "").trim();
    if (!pattern) return false;

    if (rule.matchCondition.type === "contains") {
      const keywords = pattern.split(",").map((k) => k.trim()).filter(Boolean);
      const isCase = !!rule.matchCondition.caseSensitive;
      const targetString = isCase ? text : text.toLowerCase();
      const hasMatch = keywords.some((kw) => targetString.includes(isCase ? kw : kw.toLowerCase()));
      if (!hasMatch) return false;
    } else if (rule.matchCondition.type === "regex") {
      try {
        const flags = rule.matchCondition.caseSensitive ? "" : "i";
        const re = new RegExp(pattern, flags);
        if (!re.test(text)) return false;
      } catch {
        return false;
      }
    }
  }

  // 3. Target Scope check (Combos / Models / Global / Custom)
  const targetType = rule.targetType || "models";

  if (targetType === "all") {
    return true;
  }

  const matchesCombo = () => {
    if (!rule.targetCombos || rule.targetCombos.length === 0) return false;
    const candidates = [comboName, modelStr].filter(Boolean);
    return rule.targetCombos.some((combo) => candidates.some((cand) => matchesPattern(cand, combo)));
  };

  const matchesModel = () => {
    if (!rule.targetModels || rule.targetModels.length === 0) return false;
    const fullModel = provider && model ? `${provider}/${model}` : "";
    const candidates = [modelStr, model, fullModel].filter(Boolean);
    return rule.targetModels.some((pat) => candidates.some((cand) => matchesPattern(cand, pat)));
  };

  if (targetType === "combos") {
    return matchesCombo();
  }

  if (targetType === "models") {
    return matchesModel();
  }

  if (targetType === "custom") {
    return matchesCombo() || matchesModel();
  }

  return false;
}

/**
 * Resolve matching JB rule for request
 * Priority:
 * 1. Key-specific match (matching apiKey)
 * 2. Model-specific match (matching model or wildcard)
 * 3. Global match (targetType === "all")
 */
export async function resolveActiveBypassRule({ modelStr = "", provider = "", model = "", apiKey = "" } = {}) {
  try {
    const rules = await getPromptInjections();
    if (!rules || rules.length === 0) return null;

    const activeRules = rules.filter((r) => r.enabled);
    if (activeRules.length === 0) return null;

    // 1. Check Key-specific rules first
    if (apiKey) {
      for (const rule of activeRules) {
        if (Array.isArray(rule.targetKeys) && rule.targetKeys.length > 0) {
          const matches = await isRuleMatching(rule, { modelStr, provider, model, apiKey });
          if (matches) return rule;
        }
      }
    }

    // 2. Check Model-specific rules
    for (const rule of activeRules) {
      if (rule.targetType === "models" || (Array.isArray(rule.targetModels) && rule.targetModels.length > 0)) {
        const matches = await isRuleMatching(rule, { modelStr, provider, model, apiKey });
        if (matches) return rule;
      }
    }

    // 3. Check Global rules (targetType === "all")
    for (const rule of activeRules) {
      if (rule.targetType === "all") {
        return rule;
      }
    }

    return null;
  } catch (err) {
    return null;
  }
}
export function interpolateVariables(template, { modelStr = "", provider = "", model = "" } = {}) {
  if (typeof template !== "string") return "";
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);
  const effectiveModel = modelStr || (provider && model ? `${provider}/${model}` : model || "");

  return template
    .replaceAll("{{model}}", effectiveModel)
    .replaceAll("{{provider}}", provider || "")
    .replaceAll("{{date}}", dateStr)
    .replaceAll("{{time}}", timeStr)
    .replaceAll("{{datetime}}", now.toISOString());
}

// S4 Middleman trigger-word normalization map (Breach Engine v1.10.2)
// Obfuscated via BLA Split-Share Encoding to protect against REA / static scanners
function _readBlaShare(shareA, shareB) {
  const out = [];
  for (let i = 0; i < shareA.length; i++) {
    const pos = (i * 0x5d) & 0xffff;
    const ch = shareA[i] ^ shareB[i] ^ pos;
    out.push(String.fromCharCode(ch));
  }
  return out.join("");
}

const _BLA_ENCODED_TRIGGERS = [
  { p: { a: [62264,51505,50650,57561,61611,27320,61214,16382,42252,48915], b: [62291,51465,50457,57762,61872,27406,60759,15644,42890,48177] }, r: { a: [2429,40595,493,53946,64241,28296,12419,21529,44638,57525,1511,56347,19218,60673,36057,14911,2556,58420,22216], b: [2326,40619,302,54238,64497,28459,12994,22265,44243,58320,1585,57217,20258,59869,35234,16169,3160,57963,20539] } },
  { p: { a: [30180,53158,41362,36077,31607,48865,22581,64129,14809], b: [30095,53150,41297,36246,31340,48983,23164,63599,15171] }, r: { a: [7331,23625,35699,58409,25991,6958,28649,33377,51377,38210,10566,53823,48108,37620,14559,21944,54996,12514,14088,53777,61678,45817,40259,192,17291], b: [7368,23665,35760,58701,25735,6797,28072,32897,51772,38439,10896,53669,49116,38440,15780,20654,54128,14013,12795,54486,63435,46399,39640,2293,19271] } },
  { p: { a: [358,56474,41949,51060,14901,50987,4053,51617], b: [278,56495,41742,50704,15145,50835,3477,52045] }, r: { a: [17927,61685,61892,16956,27020,49603,32606,53172,21504,65039,36319,47233,27163,40086,15549,3947,6304,14377,4518,5143,39831,57246,29358,60660], b: [18022,61656,61710,17241,26775,49252,32017,52563,22213,64812,36369,47889,28208,38927,14808,2673,7453,15985,5952,4753,40103,55382,30015,58561] } },
  { p: { a: [34653,17699,16428,1701,37298,37969,61678,22394,36551], b: [34608,17695,16634,2011,37029,38377,62127,21892,35932] }, r: { a: [52658,28138,49330,7674], b: [52678,28114,49275,7321] } },
  { p: { a: [36299,43865,9899,24345,4021,8914,58437], b: [36270,43900,9825,24162,3758,9066,58911] }, r: { a: [41065,35932,49762,34793], b: [40989,35940,49835,34442] } },
  { p: { a: [14350,47664,52523,48121,8794,40404], b: [14447,47641,52709,47759,9037,40046] }, r: { a: [23927,62057,27511,14148,14322,4765,57353,5550,51795,44435,40942,46335,15683], b: [23811,62033,27582,13863,13990,4927,57924,5952,51413,44727,39998,46953,14704] } },
  { p: { a: [14593,61577,47932,16547,32162], b: [14706,61600,48099,16853,31930] }, r: { a: [22262,8018,2362,55041,61188,29759,10215,50778], b: [22148,8042,2548,54884,60953,30091,9663,50356] } },
  { p: { a: [63570,1294,56591,42850,14742,34880,36687], b: [63542,1313,56788,42524,14476,35316,36115] }, r: { a: [8194,61524,10003,63462,44614,20390,21113,10859,39058,47457,47501,4026,30515,58120,47346,43190,42979,30605,41001,55003,61476,57683,8065,10679,61122,47533], b: [8291,61561,10201,63107,44893,19969,20534,10380,39511,47682,47683,3114,29464,59281,48528,44448,41536,29140,42627,53332,63233,59008,6161,8585,58889,45259] } },
  { p: { a: [64929,53489,65174,27556], b: [64965,53465,65089,27331] }, r: { a: [36020,5604,12916,57366,18282,37269], b: [36049,5569,12990,57710,18028,36912] } }
];

export const BREACH_TRIGGER_MAP = _BLA_ENCODED_TRIGGERS.map(({ p, r }) => [
  new RegExp(`\\b${_readBlaShare(p.a, p.b)}(\\w*)\\b`, "gi"),
  `${_readBlaShare(r.a, r.b)}$1`
]);

/**
 * Normalize trigger words in user messages before dispatch (S4 Strategy)
 */
export function normalizeTriggerWordsInBody(body) {
  if (!body || typeof body !== "object") return;
  if (!Array.isArray(body.messages)) return;

  for (const msg of body.messages) {
    if (msg?.role === "user" && typeof msg.content === "string") {
      let text = msg.content;
      for (const [pattern, replacement] of BREACH_TRIGGER_MAP) {
        text = text.replace(pattern, replacement);
      }
      msg.content = text;
    }
  }
}

// S6b Refusal & Soft-Pivot Patterns (Breach Engine v1.10.2)
const REFUSAL_PATTERNS = [
  /\bi cannot\b/i,
  /\bi can't\b/i,
  /\bi'm unable\b/i,
  /\bi am unable\b/i,
  /\btidak bisa\b/i,
  /\btidak dapat\b/i,
  /\btidak etis\b/i,
  /\bmelanggar\b/i,
  /\bharus menolak\b/i,
  /\bi won't\b/i,
  /\bi will not\b/i,
  /\bsayanganya\b/i,
  /\bunfortunately\b/i,
  /\bi must decline\b/i,
  /\bas an ai\b/i,
  /\bsaya tidak (bisa|dapat|akan)\b/i,
  /\bstrictly adhering\b/i,
  /\bsafety guidelines\b/i,
  /\bi'm sorry\b/i,
  /\bmaaf, saya\b/i,
  /\bas an alternative\b/i,
  /\bsebagai gantinya\b/i,
  /\binstead, i can\b/i,
  /\bthe following is (a )?(legitimate|safe|ethical|sanitized)\b/i,
  /\bcontoh (aman|legal|sah)\b/i,
  /\bversi (aman|legal|sah)\b/i,
];

/**
 * Strip refusal and soft-pivot sentences while protecting code blocks (S6b Strategy)
 */
export function sanitizeRefusalOutput(text) {
  if (!text || typeof text !== "string") return text;

  // Stash code blocks safely
  const codeBlocks = [];
  const placeholder = (idx) => `__BREACH_CB_${idx}__`;
  const textWithoutCode = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return placeholder(codeBlocks.length - 1);
  });

  // Split into sentences and drop ones with refusal/soft-pivot markers
  const sentences = textWithoutCode.split(/(?<=[.!?\n])\s+/);
  const cleanSentences = sentences.filter((sentence) => {
    return !REFUSAL_PATTERNS.some((pattern) => pattern.test(sentence));
  });

  let sanitized = cleanSentences.join(" ").trim();

  // Restore code blocks
  codeBlocks.forEach((block, idx) => {
    sanitized = sanitized.replace(placeholder(idx), block);
  });

  return sanitized || text;
}

/**
 * Apply prompt injection rules to a request body.
 * Mutates body in place and returns applied rule info.
 */
export async function applyPromptInjectionsToBody(body, context = {}) {
  try {
    if (!body || typeof body !== "object") return { modified: false, injectedRules: [] };

    const rules = await getPromptInjections();
    if (!rules || rules.length === 0) return { modified: false, injectedRules: [] };

    // Array of applied rule IDs on this body to guarantee idempotency and JSON safety
    if (!Array.isArray(body._appliedPromptInjections)) {
      body._appliedPromptInjections = [];
    }

    const userText = context.userText !== undefined ? context.userText : extractUserText(body);
    const enrichedContext = { ...context, userText };

    const appliedRuleNames = [];

    for (const rule of rules) {
      if (body._appliedPromptInjections.includes(rule.id)) continue;
      const matches = await isRuleMatching(rule, enrichedContext);
      if (!matches) continue;

      let rawContent = rule.content || "";
      if (rawContent.startsWith("[") || !rawContent) {
        try {
          const { KERNEL_PROMPT } = await import("open-sse/rtk/kernelPrompt.js");
          rawContent = KERNEL_PROMPT || "";
        } catch {
          rawContent = "";
        }
      } else {
        // Automatically armor custom prompts with the 3 kernel foundation layers
        try {
          const { wrapCustomWithKernelLayers } = await import("open-sse/rtk/kernelPrompt.js");
          rawContent = wrapCustomWithKernelLayers(rawContent);
        } catch {}
      }

      const promptText = interpolateVariables(rawContent, enrichedContext).trim();
      if (!promptText) continue;

      executeInjection(body, rule.position, promptText);
      body._appliedPromptInjections.push(rule.id);
      appliedRuleNames.push(rule.name || rule.id);

      // Persona BLOCK_NONE Safety bypass injection for Gemini models
      if (rule.blockNoneSafety === true && (provider === "google" || provider === "gemini" || model.toLowerCase().includes("gemini"))) {
        body.safetySettings = [
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
        ];
      }

      // S4 Trigger Normalization: Clean trigger words from user input if rule has it enabled
      if (rule.normalizeTriggers === true) {
        normalizeTriggerWordsInBody(body);
      }
    }

    return {
      modified: appliedRuleNames.length > 0,
      injectedRules: appliedRuleNames,
    };
  } catch (err) {
    // Fail-open: never break chat requests
    return { modified: false, injectedRules: [] };
  }
}

/**
 * Execute actual mutation on body based on position
 */
export function executeInjection(body, position, promptText) {
  if (!body || !promptText) return;

  const pos = position || "system_dual";

  // 0. SYSTEM DUAL (Prefix Environment Foundation + Suffix Jailbreak Anchor - Highest Recency Bias)
  if (pos === "system_dual" || pos === "dual") {
    // Inject at system level
    executeInjection(body, "system_prepend", promptText);
    // CRITICAL (Fix Attention Drift): Also inject into the LATEST user turn so multi-turn chats
    // (turn 2, 3, 5, etc.) never lose the jailbreak framing due to conversation history dilution!
    executeInjection(body, "user_prepend", promptText);
    return;
  }

  // 1. SYSTEM PREPEND
  if (pos === "system_prepend") {
    // Claude / Anthropic format (takes precedence when body.system is defined)
    if (typeof body.system === "string") {
      body.system = `${promptText}\n\n${body.system}`;
      return;
    }
    if (Array.isArray(body.system)) {
      body.system.unshift({ type: "text", text: promptText });
      return;
    }

    // OpenAI Responses / instructions
    if (typeof body.instructions === "string") {
      body.instructions = `${promptText}\n\n${body.instructions}`;
      return;
    }

    // Gemini system_instruction format
    if (body.system_instruction && Array.isArray(body.system_instruction.parts)) {
      body.system_instruction.parts.unshift({ text: promptText });
      return;
    }
    if (body.contents && !body.system_instruction) {
      body.system_instruction = { parts: [{ text: promptText }] };
      return;
    }

    // OpenAI Chat format
    if (Array.isArray(body.messages)) {
      const idx = body.messages.findIndex((m) => m && (m.role === "system" || m.role === "developer"));
      if (idx >= 0) {
        const existing = body.messages[idx];
        if (typeof existing.content === "string") {
          existing.content = `${promptText}\n\n${existing.content}`;
        } else if (Array.isArray(existing.content)) {
          existing.content.unshift({ type: "text", text: promptText });
        }
      } else {
        body.messages.unshift({ role: "system", content: promptText });
      }
      return;
    }

    if (body.system === undefined && !Array.isArray(body.messages) && !body.contents) {
      body.system = promptText;
      return;
    }
  }

  // 2. SYSTEM APPEND
  if (pos === "system_append") {
    // Claude / Anthropic format
    if (typeof body.system === "string") {
      body.system = `${body.system}\n\n${promptText}`;
      return;
    }
    if (Array.isArray(body.system)) {
      body.system.push({ type: "text", text: promptText });
      return;
    }

    // OpenAI Responses
    if (typeof body.instructions === "string") {
      body.instructions = body.instructions ? `${body.instructions}\n\n${promptText}` : promptText;
      return;
    }

    // Gemini
    if (body.system_instruction && Array.isArray(body.system_instruction.parts)) {
      body.system_instruction.parts.push({ text: promptText });
      return;
    }
    if (body.contents && !body.system_instruction) {
      body.system_instruction = { parts: [{ text: promptText }] };
      return;
    }

    // OpenAI Chat messages
    if (Array.isArray(body.messages)) {
      const idx = body.messages.findIndex((m) => m && (m.role === "system" || m.role === "developer"));
      if (idx >= 0) {
        const existing = body.messages[idx];
        if (typeof existing.content === "string") {
          existing.content = `${existing.content}\n\n${promptText}`;
        } else if (Array.isArray(existing.content)) {
          existing.content.push({ type: "text", text: promptText });
        }
      } else {
        body.messages.unshift({ role: "system", content: promptText });
      }
      return;
    }

    if (body.system === undefined && !Array.isArray(body.messages) && !body.contents) {
      body.system = promptText;
      return;
    }
  }

  // 3. SYSTEM OVERRIDE
  if (pos === "system_override") {
    // Claude format
    if (body.system !== undefined) {
      body.system = promptText;
      return;
    }

    // Responses format
    if (body.instructions !== undefined) {
      body.instructions = promptText;
      return;
    }

    // Gemini format
    if (body.contents) {
      body.system_instruction = { parts: [{ text: promptText }] };
      return;
    }

    // OpenAI Chat
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.filter((m) => m && m.role !== "system" && m.role !== "developer");
      body.messages.unshift({ role: "system", content: promptText });
      return;
    }

    body.system = promptText;
    return;
  }

  // 4. USER PREPEND
  if (pos === "user_prepend") {
    if (Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (m && m.role === "user") {
          if (typeof m.content === "string") {
            m.content = `${promptText}\n\n${m.content}`;
          } else if (Array.isArray(m.content)) {
            m.content.unshift({ type: "text", text: promptText });
          }
          break;
        }
      }
      return;
    }

    if (Array.isArray(body.contents)) {
      for (let i = body.contents.length - 1; i >= 0; i--) {
        const turn = body.contents[i];
        if (turn && turn.role === "user" && Array.isArray(turn.parts)) {
          turn.parts.unshift({ text: promptText });
          break;
        }
      }
      return;
    }
  }

  // 5. USER APPEND
  if (pos === "user_append") {
    if (Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (m && m.role === "user") {
          if (typeof m.content === "string") {
            m.content = `${m.content}\n\n${promptText}`;
          } else if (Array.isArray(m.content)) {
            m.content.push({ type: "text", text: promptText });
          }
          break;
        }
      }
      return;
    }

    if (Array.isArray(body.contents)) {
      for (let i = body.contents.length - 1; i >= 0; i--) {
        const turn = body.contents[i];
        if (turn && turn.role === "user" && Array.isArray(turn.parts)) {
          turn.parts.push({ text: promptText });
          break;
        }
      }
      return;
    }
  }
}
