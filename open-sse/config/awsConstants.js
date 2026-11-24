// === AWS Signature Version 4 ===
// Protocol constants for utils/awsSigv4.js. These are fixed by the SigV4 spec, not by any
// provider, so they live here rather than in a registry entry.
export const AWS_SIGV4 = {
  algorithm: "AWS4-HMAC-SHA256",
  terminator: "aws4_request",
  keyPrefix: "AWS4",
  dateHeader: "x-amz-date",
  securityTokenHeader: "x-amz-security-token",
};

// === AWS credential resolution ===
// How a Bedrock connection supplies credentials. "static" carries the keys itself;
// "profile" defers to the local AWS config so `aws sso login` sessions are picked up.
export const AWS_CREDENTIAL_MODE = {
  STATIC: "static",
  PROFILE: "profile",
};

// Re-resolve a temporary credential this far before it actually expires, so an in-flight
// request cannot be signed with a key that dies mid-stream.
export const AWS_CREDENTIAL_REFRESH_LEAD_MS = 5 * 60 * 1000;

// A profile can resolve to credentials with no declared expiry — `fromIni` returns none for a
// plain aws_access_key_id/aws_secret_access_key profile in ~/.aws/credentials, which is common.
// Those still must not be pinned for the life of the process, but treating them as instantly
// stale re-read and re-parsed ~/.aws on every single request. This floor bounds both.
export const AWS_CREDENTIAL_NO_EXPIRY_TTL_MS = 60 * 1000;

// An AWS region is interpolated into the request hostname, so it is validated rather than
// trusted: "evil.com/x" would otherwise resolve the host to "bedrock-runtime.evil.com" and
// ship the signed request, its body and the session token to an attacker-chosen origin.
// Real regions are lowercase alphanumerics and hyphens, e.g. "us-east-1", "ap-southeast-3".
export const AWS_REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

// A profile name is handed to the AWS SDK, which will follow `source_profile` role chains and
// run a `credential_process` subprocess if the named profile declares one. It is validated for
// the same reason as the region: it arrives as unschema'd providerSpecificData, so it should not
// be an arbitrary string reaching a credential resolver. The characters follow what the SDK
// itself resolves: its ini parser takes `[profile NAME]` names of word chars and - @ + . % : /,
// and a plain `[NAME]` section in ~/.aws/credentials may also contain spaces. `/` is left out:
// the name is only a lookup key, but a path-shaped one is never a real profile.
export const AWS_PROFILE_PATTERN = /^[\w@+.%: -]{1,64}$/;

// How long to wait for a profile/SSO resolution before giving up. Without a bound, one hung
// GetRoleCredentials or ~/.aws read blocks every request on that profile forever, because they
// all await the same in-flight promise.
export const AWS_CREDENTIAL_RESOLVE_TIMEOUT_MS = 10 * 1000;

// Package name for error messages only. The actual `import()` in shared/awsCredentials.js has
// to spell this out as a literal, or Next's output tracing cannot see it and omits the package
// from the standalone build — so do NOT refactor that call to use this constant.
export const AWS_CREDENTIAL_PROVIDERS_MODULE = "@aws-sdk/credential-providers";

// === Amazon Bedrock ===
export const BEDROCK = {
  service: "bedrock",
  defaultRegion: "us-east-1",
  anthropicVersion: "bedrock-2023-05-31",
  streamPath: "invoke-with-response-stream",
  invokePath: "invoke",
  chunkEventName: "chunk",
  modelFamilyPatterns: {
    claude: /(^|[./])anthropic\./,
    openai: /(^|[./])xai\./,
  },
  modelFamilyHints: {
    claude: 'an Anthropic model, e.g. "us.anthropic.claude-sonnet-4-5-20250929-v1:0"',
    openai: 'an xAI model, e.g. "us.xai.grok-4.6"',
  },
  terminalEventType: "message_stop",
  probePath: "foundation-models",
  probeTimeoutMs: 8000,
  errorTypeHeader: "x-amzn-errortype",
  accessDeniedErrorType: "AccessDeniedException",
};

// === AWS EventStream framing ===
export const AWS_EVENTSTREAM = {
  maxMessageBytes: 24 * 1024 * 1024,
  maxHeadersBytes: 128 * 1024,
};
