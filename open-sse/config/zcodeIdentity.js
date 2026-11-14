// ZCode client fingerprint — one source of truth.
//
// Every surface that talks to the zcode.z.ai plan gateway (the chat executor,
// the usage reads, the claim handshake) has to declare the same client
// identity. A version or identity field that differs between calls makes the
// gateway see two different clients and answer 3001 / HTTP 405 code 3012
// "unusual activity". Keep them here so there is exactly one place to bump.

// The start-plan lane is pinned to this version by the gateway itself; newer
// declared versions get HTTP 405 code 3012.
export const ZCODE_APP_VERSION = "3.16.3";

// The coding-plan / usage lane tracks the desktop release.
export const ZCODE_CODING_APP_VERSION = "3.17.2";

// Identity bundle fields the gateway fingerprints, taken from the desktop
// client. Required on every request that carries the plan fingerprint.
export const ZCODE_ANTHROPIC_VERSION = "2023-06-01";
export const ZCODE_ANTHROPIC_BETA = "mid-conversation-system-2026-04-07";

// The desktop client's SDK UA. The gateway rejects a bare `ZCode/<ver>` UA, so
// every lane advertises the full runtime string.
export const ZCODE_SDK_USER_AGENT = (version) =>
  `ZCode/${version} ai-sdk/provider-utils/4.0.27 runtime/node.js/24`;
