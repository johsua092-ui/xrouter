// Amazon Quick (AWS) — native OAuth provider over the Quick bidi chat
// WebSocket. Protocol reverse-engineered from the desktop app (v1.2.4660);
// wire spec + pitfalls: magpie-aws-quick PROTOCOL.md.
//
// There is no OpenAI-shaped HTTP endpoint upstream: AwsQuickExecutor owns the
// whole request (WS turn → OpenAI SSE), so transport only carries the format
// tag used for request translation. Chat credentials live on the connection:
// accessToken = id_token (~1h, used as the WS `token` + qbs-event bearer),
// refreshToken (AWS rotates it on EVERY refresh), expiresAt epoch ms, and
// providerSpecificData {tenantUrl, wsHost, actorArn, awsAccountId, …}.
//
// "Models" are Quick agent modes (server routes them: fast → claude-haiku-5-5,
// smart → claude-opus-5-5, balanced/advanced → server-routed), all 1M context
// (verified via turn_usage.context_window).

export default {
  id: "aws-quick",
  priority: 10,
  alias: "aq",
  display: {
    name: "Amazon Quick",
    icon: "cloud",
    color: "#FF9900",
    website: "https://quick.aws.com",
    notice: {
      signupUrl: "https://quick.aws.com",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    format: "openai",
  },
  models: [
    { id: "fast", name: "Quick Fast", contextLength: 1000000 },
    { id: "balanced", name: "Quick Balanced", contextLength: 1000000 },
    { id: "smart", name: "Quick Smart", contextLength: 1000000 },
    { id: "advanced", name: "Quick Advanced", contextLength: 1000000 },
  ],
  oauth: {
    scopes: ["quicksight:read_write"],
    // Hop-1 discovery page: the login flow reads issuer/tenant/region from here.
    discoveryUrl: "https://quick.aws.com/sn",
    // id_token lives ~1h; the default 5min lead is tight for a token the WS
    // handshake bakes into a long-lived socket URL — renew 10min early.
    refreshLeadMs: 10 * 60 * 1000,
  },
  features: {
    usage: true,
  },
};
