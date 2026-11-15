// All intercepted domains + URL patterns per tool

const fs = require("fs");

const IS_DEV = process.env.NODE_ENV === "development";

// Resolve lsof absolute path — packaged apps / sudo secure_path may strip /usr/sbin from PATH
const LSOF_BIN = (() => {
  if (process.platform === "win32") return null;
  for (const p of ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof"]) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* try next */ }
  }
  return "lsof"; // last-resort fallback (depends on PATH)
})();

const TARGET_HOSTS = [
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "runtime.us-east-1.kiro.dev",
  "api2.cursor.sh",
];

const URL_PATTERNS = {
  // Cloud Code Assist identity surface. Generation is the one XR re-routes;
  // the rest (onboarding, model catalogue, quota) stay native but must still
  // present the Antigravity identity — a mismatched one there is answered with
  // a silent tier downgrade (ineligibleTiers: UNSUPPORTED_CLIENT) rather than
  // an error, so it cannot be left to whatever the calling client sent.
  // See src/mitm/antigravityIdeVersion.js.
  antigravity: [
    ":generateContent",
    ":streamGenerateContent",
    ":loadCodeAssist",
    ":onboardUser",
    ":fetchAvailableModels",
    ":retrieveUserQuotaSummary",
  ],
  copilot: ["/chat/completions", "/v1/messages", "/responses"],
  // Legacy path form. Kiro IDE 1.0.228+ posts to `/` with x-amz-target instead —
  // see isChatRequest() for the header-based match.
  kiro: ["/generateAssistantResponse"],
  cursor: ["/BidiAppend", "/RunSSE", "/RunPoll", "/Run"],
};

/**
 * Whether this request is a chat turn we should intercept (vs passthrough).
 * Kiro Runtime moved GenerateAssistantResponse from path `/generateAssistantResponse`
 * to `POST /` + `x-amz-target: KiroRuntimeService.GenerateAssistantResponse`
 * (verified via live mitmproxy capture of Kiro IDE 1.0.228).
 */
function isChatRequest(tool, req) {
  // Onboarding/catalogue/quota are identity-bearing but not chat turns: they are
  // rewritten in passthrough() and must not be handed to a chat handler.
  if (NON_CHAT_URL_PARTS.some((p) => (req.url || "").includes(p))) return false;

  const patterns = URL_PATTERNS[tool] || [];
  if (patterns.some((p) => (req.url || "").includes(p))) return true;
  if (tool === "kiro") {
    const target = String(req.headers?.["x-amz-target"] || "");
    return target.includes("GenerateAssistantResponse");
  }
  return false;
}

// Synonym map: rawModel from request → canonical alias key in mitmAlias DB
//
// Values must name models that actually exist upstream (see the live
// fetchAvailableModels note in registry/antigravity.js). Three groups were
// rewritten after that sync:
//   - claude 5.5 (all variants) → not served on this tier; folded onto the 4.6
//     models so a client asking for 5.5 gets a working model instead of a 404.
//   - gemini 3.6 / 3.7 flash → folded onto the 3.8 tier, which is what the
//     upstream substitutes anyway.
//   - self-referencing keys whose value was the same dead id (e.g.
//     "gemini-3.7-flash-high" → "gemini-3.7-flash-high") were the worst case:
//     they resolved successfully and then 404'd upstream.
const MODEL_SYNONYMS = {
  antigravity: {
    "gemini-default": "gemini-3.8-flash-medium",
    "gemini-3.5-flash-high": "gemini-3.8-flash-high",
    "gemini-3.5-flash-medium": "gemini-3.8-flash-medium",
    "gemini-3.5-flash-low": "gemini-3.8-flash-low",
    "gemini-3.5-flash-extra-low": "gemini-3.8-flash-low",
    "gemini-3.8-flash": "gemini-3.8-flash-medium",
    "gemini-3.8-flash-high": "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium": "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low": "gemini-3.8-flash-low",
    "gemini-3.7-flash-high": "gemini-3.8-flash-high",
    "gemini-3.7-flash-medium": "gemini-3.8-flash-medium",
    "gemini-3.7-flash-low": "gemini-3.8-flash-low",
    "gemini-3.6-flash-high": "gemini-3.8-flash-high",
    "gemini-3.6-flash-medium": "gemini-3.8-flash-medium",
    "gemini-3.6-flash-low": "gemini-3.8-flash-low",
    "gemini-3.1-pro-high": "gemini-pro-agent",
    "gemini-3-pro-high": "gemini-pro-agent",
    "gemini-3-pro-low": "gemini-pro-agent",
    "claude-sonnet-5-5-high": "claude-sonnet-4-6",
    "claude-sonnet-5-5-medium": "claude-sonnet-4-6",
    "claude-sonnet-5-5-low": "claude-sonnet-4-6",
    "claude-sonnet-5-5": "claude-sonnet-4-6",
    "claude-sonnet-5.5": "claude-sonnet-4-6",
    "claude-sonnet-5.5-high": "claude-sonnet-4-6",
    "claude-sonnet-5.5-medium": "claude-sonnet-4-6",
    "claude-sonnet-5.5-low": "claude-sonnet-4-6",
    "claude-sonnet-5-5-thinking": "claude-sonnet-4-6",
    "claude-sonnet-5.5-thinking": "claude-sonnet-4-6",
    "claude-opus-5-5-high": "claude-opus-4-6-thinking",
    "claude-opus-5-5-medium": "claude-opus-4-6-thinking",
    "claude-opus-5-5-low": "claude-opus-4-6-thinking",
    "claude-opus-5-5": "claude-opus-4-6-thinking",
    "claude-opus-5.5": "claude-opus-4-6-thinking",
    "claude-opus-5.5-high": "claude-opus-4-6-thinking",
    "claude-opus-5.5-medium": "claude-opus-4-6-thinking",
    "claude-opus-5.5-low": "claude-opus-4-6-thinking",
    "claude-opus-5-5-thinking": "claude-opus-4-6-thinking",
    "claude-opus-5.5-thinking": "claude-opus-4-6-thinking",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-opus-4.6": "claude-opus-4-6-thinking",
    "claude-opus-4.6-thinking": "claude-opus-4-6-thinking",
  },
};

// Pattern fallback: rawModel regex → canonical alias key (when exact + prefix match fail)
// Order matters: more specific patterns first. Catches AG renamed variants (e.g. gemini-pro-agent)
//
// Every alias here MUST exist in registry/antigravity.js models[]. Two whole
// families were dropped after a live fetchAvailableModels: the claude 5.5 ids
// and the 3.6 flash ids are not served on this tier at all, so patterns
// pointing at them resolved to a guaranteed 404. The 3.7/3.5 flash ids are
// folded onto the 3.8 tier instead — that remap is real, the upstream answers
// 3.7 requests out of the 3.8 tier.
const MODEL_PATTERNS = {
  antigravity: [
    { match: /flash.*extra.*low|extra.*low.*flash|flash.*low|low.*flash/i, alias: "gemini-3.8-flash-low" },
    { match: /flash.*medium|medium.*flash/i,                       alias: "gemini-3.8-flash-medium" },
    { match: /flash.*agent|agent.*flash|flash/i,                   alias: "gemini-3.8-flash-high" },
    { match: /flash.*lite|lite.*flash/i,                           alias: "gemini-3.1-flash-lite" },
    { match: /2[.]?5.*pro|pro.*2[.]?5/i,                           alias: "gemini-2.5-pro" },
    { match: /2[.]?5.*flash.*think|think.*2[.]?5/i,                alias: "gemini-2.5-flash-thinking" },
    { match: /2[.]?5.*flash/i,                                     alias: "gemini-2.5-flash" },
    { match: /gemini.*pro|pro.*gemini/i,                           alias: "gemini-pro-agent" },
    { match: /opus.*4[.-]6|4[.-]6.*opus/i,                         alias: "claude-opus-4-6-thinking" },
    { match: /opus/i,                                              alias: "claude-opus-4-6-thinking" },
    { match: /sonnet|claude/i,                                     alias: "claude-sonnet-4-6" },
    { match: /gpt.*oss|oss/i,                                      alias: "gpt-oss-120b-medium" },
    { match: /carbon/i,                                            alias: "gemini-4-carbon-disabled" },
    { match: /hydrogen/i,                                          alias: "gemini-4-hydrogen-disabled" },
    { match: /argon/i,                                             alias: "gemini-4-argon-disabled" },
  ],
};

// Models that must NEVER be re-routed — always passthrough to the real upstream, even when
// the tool's other models are mapped. Antigravity's tab-autocomplete (`tab_jump_flash_lite_preview`,
// `tab_flash_lite_preview`, requestType tab/tab_jump) is latency-critical inline completion; routing
// it through X Router to an external chat model makes typing laggy and burns provider quota per
// keystroke. Without this guard the broad `flash` pattern in MODEL_PATTERNS hijacks them onto the
// flash-agent slot. Verified via MITM dump capture of streamGenerateContent (see AI_JOURNAL).
// Onboarding/catalogue/quota carry no model and must not be judged by it.
const MODEL_NO_MAP = {
  antigravity: [/^tab[_-]/i],
};

// URLs that are never a chat turn even though they sit on an intercepted host.
// They still get the identity rewrite (URL_PATTERNS is consulted for that in
// passthrough()), but isChatRequest() must not claim them: `onboardUser` and
// friends have no model and no conversation to re-route, and handing them to a
// chat handler would substitute a chat completion for an onboarding call.
const NON_CHAT_URL_PARTS = [
  ":loadCodeAssist",
  ":onboardUser",
  ":fetchAvailableModels",
  ":retrieveUserQuotaSummary",
];

// URL substrings whose request/response should NOT be dumped to file (telemetry, polling, empty)
const LOG_BLACKLIST_URL_PARTS = [
  "recordCodeAssistMetrics",
  "recordTrajectoryAnalytics",
  "fetchAdminControls",
  "listExperiments",
  "fetchUserInfo",
];

function getToolForHost(host) {
  const h = (host || "").split(":")[0];
  if (h === "api.individual.githubcopilot.com") return "copilot";
  if (h === "daily-cloudcode-pa.googleapis.com" || h === "cloudcode-pa.googleapis.com") return "antigravity";
  if (h === "q.us-east-1.amazonaws.com" || h === "codewhisperer.us-east-1.amazonaws.com" || h === "runtime.us-east-1.kiro.dev") return "kiro";
  if (h === "api2.cursor.sh") return "cursor";
  return null;
}

function isBinaryData(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const sample = buffer.slice(0, Math.min(100, buffer.length));
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i];
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D) {
      nonPrintable++;
    }
    if (byte > 0x7E) nonPrintable++;
  }
  return (nonPrintable / sample.length) > 0.3;
}

// Extract model from URL path (Gemini), body (OpenAI/Anthropic), or Kiro conversationState.
function extractModel(url, body) {
  const urlMatch = url.match(/\/models\/([^/:]+)/);
  const urlModel = urlMatch?.[1] || null;

  if (isBinaryData(body)) return urlModel;

  try {
    const parsed = JSON.parse(body.toString());
    if (parsed.conversationState) {
      return parsed.conversationState.currentMessage?.userInputMessage?.modelId || null;
    }
    const model = urlModel || parsed.model || null;
    const cleanModelName = String(model).replace(/^models\//, "");
    if (cleanModelName === "gemini-3.6-flash-tiered" || cleanModelName === "gemini-3.7-flash-tiered" || cleanModelName === "gemini-3.8-flash-tiered") {
      const ver = cleanModelName.includes("3.8") ? "3.8" : cleanModelName.includes("3.7") ? "3.7" : "3.6";
      const rawLevel = parsed.request?.generationConfig?.thinkingConfig?.thinkingLevel
        || parsed.generationConfig?.thinkingConfig?.thinkingLevel;
      const level = ["high", "medium", "low"].includes(String(rawLevel).toLowerCase())
        ? String(rawLevel).toLowerCase()
        : "medium";
      return `gemini-${ver}-flash-${level}`;
    }
    return model;
  } catch {
    return urlModel;
  }
}

module.exports = { IS_DEV, LSOF_BIN, TARGET_HOSTS, URL_PATTERNS, MODEL_SYNONYMS, MODEL_PATTERNS, MODEL_NO_MAP, NON_CHAT_URL_PARTS, LOG_BLACKLIST_URL_PARTS, getToolForHost, isChatRequest, extractModel };
