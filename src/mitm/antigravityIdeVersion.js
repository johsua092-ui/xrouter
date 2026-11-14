"use strict";

// Rewrite Antigravity IDE markers on generation requests so upstream AG 2.x
// backend accepts them. Catalog and other passthrough requests retain the
// client's current identity.
//
// Version pins the shipped desktop hub (antigravity 2.32.1 over language server
// 44.9.1, from the official linux-x64 tarball's resources/version). The hub
// always launches the LS with `--override_ide_version <hub version>` and
// `--override_user_agent_name antigravity`, so both the metadata ideVersion and
// the `antigravity/<...>` UA token must carry the hub version — not whatever the
// calling client (Cockpit / third-party tooling) happens to send.

const ANTIGRAVITY_IDE_VERSION = "2.32.1";
// Language server build shipped inside that hub; useful as a secondary marker.
const ANTIGRAVITY_LANGUAGE_SERVER_VERSION = "44.9.1";
const ANTIGRAVITY_IDE_VERSION_OVERRIDE_ENABLED = true;

function shouldRewriteMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  if (String(metadata.ideName || "").toLowerCase() === "antigravity") return true;
  if (String(metadata.ideType || "").toUpperCase() === "ANTIGRAVITY") return true;
  return Object.prototype.hasOwnProperty.call(metadata, "ideVersion");
}

function rewriteAntigravityUserAgent(userAgent, version) {
  if (typeof userAgent !== "string" || !userAgent.includes("antigravity/")) return userAgent;
  return userAgent.replace(/antigravity\/[^\s]+/, `antigravity/${version}`);
}

function applyAntigravityIdeVersionOverride(bodyBuffer, headers, requestUrl) {
  const isGenerationEndpoint = requestUrl?.includes(":generateContent") ||
    requestUrl?.includes(":streamGenerateContent");
  if (!ANTIGRAVITY_IDE_VERSION_OVERRIDE_ENABLED || !isGenerationEndpoint) {
    return { bodyBuffer, headers, applied: false, version: ANTIGRAVITY_IDE_VERSION };
  }

  const nextHeaders = { ...headers };
  const nextUserAgent = rewriteAntigravityUserAgent(nextHeaders["user-agent"], ANTIGRAVITY_IDE_VERSION);
  const userAgentChanged = nextUserAgent !== nextHeaders["user-agent"];
  if (userAgentChanged) nextHeaders["user-agent"] = nextUserAgent;

  try {
    const parsed = JSON.parse(bodyBuffer.toString());
    if (!shouldRewriteMetadata(parsed?.metadata)) {
      return { bodyBuffer, headers: nextHeaders, applied: userAgentChanged, version: ANTIGRAVITY_IDE_VERSION };
    }

    parsed.metadata.ideVersion = ANTIGRAVITY_IDE_VERSION;
    const nextBodyBuffer = Buffer.from(JSON.stringify(parsed));
    return { bodyBuffer: nextBodyBuffer, headers: nextHeaders, applied: true, version: ANTIGRAVITY_IDE_VERSION };
  } catch {
    return { bodyBuffer, headers: nextHeaders, applied: userAgentChanged, version: ANTIGRAVITY_IDE_VERSION };
  }
}

module.exports = {
  ANTIGRAVITY_IDE_VERSION,
  ANTIGRAVITY_LANGUAGE_SERVER_VERSION,
  applyAntigravityIdeVersionOverride,
  rewriteAntigravityUserAgent,
};
