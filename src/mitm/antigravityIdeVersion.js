"use strict";

// Rewrite Antigravity IDE identity markers on requests bound for the Antigravity
// backend so upstream AG 2.x accepts them.
//
// Version pins the shipped desktop hub (antigravity 2.32.1 over language server
// 44.9.1, from the official linux-x64 tarball's resources/version). The hub
// always launches the LS with `--override_ide_version <hub version>` and
// `--override_user_agent_name antigravity`, so both the metadata ideVersion and
// the `antigravity/<...>` UA token must carry the hub version — not whatever the
// calling client (Cockpit / third-party tooling) happens to send.
//
// The backend gates on this identity in three escalating ways (verified live
// against daily-cloudcode-pa.googleapis.com):
//
//   UA antigravity/hub/2.32.1  → accepted
//   UA antigravity/hub/1.0.0   → 404 "Requested entity was not found"
//   UA curl/8.0 (non-AG)       → 403 "You do not have a valid license of this product"
//
// and on the code-assist endpoints a mismatched identity does not error at all —
// it silently downgrades the account to a generic Gemini Code Assist tier
// (`ineligibleTiers: [{ reasonCode: "UNSUPPORTED_CLIENT" }]`), so the account
// never gets its Antigravity tier or its Antigravity-only models.
//
// Two consequences drove the shape of this module:
//
//  1. The identity must be applied to EVERY request that carries it, not just
//     the generation endpoints. `loadCodeAssist` / `onboardUser` are exactly
//     where the silent downgrade happens, so scoping the rewrite to
//     `:generateContent` left onboarding fingerprinted as the calling client.
//
//  2. The identity must be applied UNCONDITIONALLY, not only when the incoming
//     body already looks like Antigravity. A third-party client that sends no
//     `metadata` — or sends one that names a different IDE — is the precise case
//     this rewrite exists to repair, and it was the one case the old
//     `shouldRewriteMetadata()` gate skipped.

const ANTIGRAVITY_IDE_VERSION = "2.32.1";
// Language server build shipped inside that hub; useful as a secondary marker.
const ANTIGRAVITY_LANGUAGE_SERVER_VERSION = "44.9.1";
const ANTIGRAVITY_IDE_VERSION_OVERRIDE_ENABLED = true;

// Canonical identity the shipped client presents. `ideType: 9` is the numeric
// enum the real client sends on the wire (PLUGIN_TYPE/IDE_TYPE table); the
// string form is kept alongside it because the onboarding path has historically
// been observed accepting the string and the numeric form is additive.
const ANTIGRAVITY_IDE_NAME = "antigravity";
const ANTIGRAVITY_IDE_TYPE = 9;

// The platform tail of a UA, e.g. "linux/x64" in "antigravity/hub/2.32.1 linux/x64".
// Matched with an anchored group so a caller's *version* is never mistaken for
// its platform: a naive /antigravity\/([^\s]+)/ against
// "antigravity/hub/1.0.0 linux/x64" captures "hub/1.0.0", which then gets
// re-emitted as the platform and produces a bogus UA.
const UA_PLATFORM_RE = /\b(linux|darwin|win32|windows|freebsd|aarch64|arm64|x64|amd64)\b[^\s]*/i;

// Endpoints that must present the Antigravity identity. Anything under
// `v1internal:` is the Cloud Code Assist surface: generation, model catalogue,
// onboarding and quota all read the same identity, so all of them are in scope.
const ANTIGRAVITY_IDENTITY_URL_PARTS = [
  ":generateContent",
  ":streamGenerateContent",
  ":loadCodeAssist",
  ":onboardUser",
  ":fetchAvailableModels",
  ":retrieveUserQuotaSummary",
];

/**
 * Force the Antigravity UA token regardless of what the caller sent.
 *
 * The old behaviour only rewrote a UA that already contained `antigravity/`,
 * which meant a third-party client (`curl`, a Cockpit build, a bare fetch) was
 * forwarded verbatim and earned a 403 "no valid license". The identity is
 * pinned here instead: the platform token is preserved when the caller supplied
 * one so a genuinely different host still reads as its own architecture, and
 * the version is always the hub version.
 */
function rewriteAntigravityUserAgent(userAgent) {
  const platform = typeof userAgent === "string" ? (userAgent.match(UA_PLATFORM_RE)?.[0] || "").trim() : "";
  const tail = platform.includes("/") ? platform : "linux/x64";
  return `antigravity/hub/${ANTIGRAVITY_IDE_VERSION} ${tail}`;
}

/** True for URLs on the Cloud Code Assist identity surface. */
function isAntigravityIdentityUrl(requestUrl) {
  const url = String(requestUrl || "");
  return ANTIGRAVITY_IDENTITY_URL_PARTS.some((part) => url.includes(part));
}

/**
 * Stamp the canonical identity onto a parsed request body.
 *
 * Metadata is created when absent rather than skipped — an absent `metadata` is
 * the signature of exactly the client this rewrite is meant to correct. Both
 * nested (`body.request.metadata`) and root (`body.metadata`) placements are
 * stamped because the generation and onboarding paths differ: generation nests
 * identity inside `request`, onboarding sends it at the root.
 */
function stampAntigravityIdentity(parsed) {
  const targets = [];
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    targets.push(parsed);
    if (parsed.request && typeof parsed.request === "object" && !Array.isArray(parsed.request)) {
      targets.push(parsed.request);
    }
  }

  for (const target of targets) {
    const existing = target.metadata;
    const metadata = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    metadata.ideVersion = ANTIGRAVITY_IDE_VERSION;
    metadata.ideName = ANTIGRAVITY_IDE_NAME;
    metadata.ideType = ANTIGRAVITY_IDE_TYPE;
    target.metadata = metadata;
  }

  return targets.length > 0;
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
      // The stamped body is a different length, so a stale content-length would
      // make the upstream read a truncated request. Node's http client uses the
      // header when it is set rather than recomputing it.
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
};
