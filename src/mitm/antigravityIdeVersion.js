"use strict";

// Rewrite Antigravity IDE identity markers on generation requests bound for the
// Antigravity backend so upstream AG 2.x accepts them.
//
// Matches decolua/9router behavior:
// 1. Only generation endpoints (:generateContent / :streamGenerateContent) are rewritten.
//    Non-chat onboarding/setup endpoints (:loadCodeAssist, :onboardUser, :fetchAvailableModels,
//    :retrieveUserQuotaSummary) pass through cleanly without injecting unauthorized fields,
//    preventing Google's protobuf error: 'Invalid JSON payload received. Unknown name "metadata": Cannot find field.'
// 2. Only rewrites metadata if metadata is already present in the request payload. Never injects
//    a new "metadata" property into payload objects that do not define it.

const ANTIGRAVITY_IDE_VERSION = "2.32.1";
// Language server build shipped inside that hub; useful as a secondary marker.
const ANTIGRAVITY_LANGUAGE_SERVER_VERSION = "44.9.1";
const ANTIGRAVITY_IDE_VERSION_OVERRIDE_ENABLED = true;

// Canonical identity the shipped client presents.
const ANTIGRAVITY_IDE_NAME = "antigravity";
const ANTIGRAVITY_IDE_TYPE = 9;

// The platform tail of a UA, e.g. "linux/x64" in "antigravity/hub/2.32.1 linux/x64".
const UA_PLATFORM_RE = /\b(linux|darwin|win32|windows|freebsd|aarch64|arm64|x64|amd64)\b[^\s]*/i;

// In decolua/9router, only chat generation endpoints are rewritten
const ANTIGRAVITY_IDENTITY_URL_PARTS = [
  ":generateContent",
  ":streamGenerateContent",
];

/**
 * Force the Antigravity UA token regardless of what the caller sent.
 */
function rewriteAntigravityUserAgent(userAgent) {
  const platform = typeof userAgent === "string" ? (userAgent.match(UA_PLATFORM_RE)?.[0] || "").trim() : "";
  const tail = platform.includes("/") ? platform : "linux/x64";
  return `antigravity/hub/${ANTIGRAVITY_IDE_VERSION} ${tail}`;
}

/** True for URLs on the generation surface. */
function isAntigravityIdentityUrl(requestUrl) {
  const url = String(requestUrl || "");
  return ANTIGRAVITY_IDENTITY_URL_PARTS.some((part) => url.includes(part));
}

function shouldRewriteMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  if (String(metadata.ideName || "").toLowerCase() === "antigravity") return true;
  if (String(metadata.ideType || "").toUpperCase() === "ANTIGRAVITY") return true;
  return Object.prototype.hasOwnProperty.call(metadata, "ideVersion");
}

/**
 * Stamp canonical identity onto existing metadata.
 * Does NOT inject new metadata into payloads that do not have it,
 * matching decolua/9router to avoid Google Protobuf schema rejection.
 */
function stampAntigravityIdentity(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  let stamped = false;

  const checkAndStamp = (target) => {
    if (target && typeof target === "object" && target.metadata && typeof target.metadata === "object" && !Array.isArray(target.metadata)) {
      target.metadata.ideVersion = ANTIGRAVITY_IDE_VERSION;
      target.metadata.ideName = ANTIGRAVITY_IDE_NAME;
      target.metadata.ideType = ANTIGRAVITY_IDE_TYPE;
      stamped = true;
    }
  };

  checkAndStamp(parsed);
  if (parsed.request) checkAndStamp(parsed.request);

  return stamped;
}

/**
 * Apply the Antigravity identity to an outbound request.
 *
 * Returns the (possibly rewritten) body buffer and headers. `applied` reports
 * whether anything changed so callers can log or assert on the rewrite.
 */
function applyAntigravityIdeVersionOverride(bodyBuffer, headers, requestUrl) {
  if (!ANTIGRAVITY_IDE_VERSION_OVERRIDE_ENABLED || !isAntigravityIdentityUrl(requestUrl)) {
    return { bodyBuffer, headers, applied: false, version: ANTIGRAVITY_IDE_VERSION };
  }

  const nextHeaders = { ...headers };
  const uaKey = Object.keys(nextHeaders).find((k) => k.toLowerCase() === "user-agent") || "user-agent";
  const nextUserAgent = rewriteAntigravityUserAgent(nextHeaders[uaKey]);
  const userAgentChanged = nextUserAgent !== nextHeaders[uaKey];
  nextHeaders[uaKey] = nextUserAgent;

  let bodyChanged = false;
  let nextBodyBuffer = bodyBuffer;
  try {
    const parsed = JSON.parse(bodyBuffer.toString());
    if (stampAntigravityIdentity(parsed)) {
      nextBodyBuffer = Buffer.from(JSON.stringify(parsed));
      bodyChanged = nextBodyBuffer.length !== bodyBuffer.length ||
        !nextBodyBuffer.equals(bodyBuffer);
      if (bodyChanged) {
        const lenKey = Object.keys(nextHeaders).find((k) => k.toLowerCase() === "content-length");
        if (lenKey) nextHeaders[lenKey] = String(nextBodyBuffer.length);
      }
    }
  } catch {
    // Non-JSON body (or an empty one): the UA rewrite still applies.
  }

  return {
    bodyBuffer: nextBodyBuffer,
    headers: nextHeaders,
    applied: userAgentChanged || bodyChanged,
    version: ANTIGRAVITY_IDE_VERSION,
  };
}

module.exports = {
  ANTIGRAVITY_IDE_VERSION,
  ANTIGRAVITY_LANGUAGE_SERVER_VERSION,
  ANTIGRAVITY_IDE_NAME,
  ANTIGRAVITY_IDE_TYPE,
  ANTIGRAVITY_IDENTITY_URL_PARTS,
  applyAntigravityIdeVersionOverride,
  isAntigravityIdentityUrl,
  rewriteAntigravityUserAgent,
  stampAntigravityIdentity,
  shouldRewriteMetadata,
};
