import { ANTIGRAVITY_IDE_BASE_URL, ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_OAUTH_CLIENT } from "../shared.js";

export default {
  id: "antigravity",
  priority: 20,
  alias: "ag",
  uiAlias: "ag",
  display: {
    name: "Antigravity",
    icon: "rocket_launch",
    color: "#F59E0B",
    website: "https://antigravity.google",
    notice: {
      signupUrl: "https://antigravity.google",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  serviceKinds: ["llm", "image", "webSearch"],
  transport: {
    baseUrls: [
      ANTIGRAVITY_IDE_BASE_URL,
      "https://cloudcode-pa.googleapis.com",
      "https://daily-cloudcode-pa.sandbox.googleapis.com",
      "https://autopush-cloudcode-pa.sandbox.googleapis.com",
    ],
    format: "antigravity",
    // Argon high-reasoning prefill can exceed the global 360s budget on large contexts.
    stallTimeoutMs: 600000,
    headers: {
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    },
    retry: {
      "429": {
        attempts: 3,
      },
      "500": {
        attempts: 3,
      },
      "503": {
        attempts: 3,
      },
    },
    usage: {
      quotaApiUrl: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:fetchAvailableModels`,
      quotaSummaryApiUrl: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:retrieveUserQuotaSummary`,
      loadProjectApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
    clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || ANTIGRAVITY_OAUTH_CLIENT.clientId,
    clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || ANTIGRAVITY_OAUTH_CLIENT.clientSecret,
  },
  models: [
    // Model catalogue synced against a live `v1internal:fetchAvailableModels`
    // for a free-tier Antigravity account. Two corrections came out of it:
    //
    //   - The gemini-4 generation ships DISABLED (`gemini-4-argon-disabled`,
    //     `gemini-4-carbon-disabled`, `gemini-4-hydrogen-disabled`). Mapping
    //     the enabled names made every such request a 404 "Requested entity
    //     was not found" — indistinguishable from a stale-client rejection, so
    //     it read as an identity problem rather than a dead model.
    //   - The claude 5.5 ids and the 3.7 flash ids are not served at all. The
    //     3.7 requests are remapped onto the 3.8 tier upstream, and no claude
    //     5.5 model exists on this tier.
    //
    // Keep entries that the catalogue no longer lists out of this table: an
    // advertised model that 404s upstream is worse than an absent one.
    { id: "gemini-4-argon-disabled", name: "Gemini 4 Argon (Disabled)", upstreamModelId: "gemini-4-argon-disabled" },
    { id: "gemini-4-carbon-disabled", name: "Gemini 4 Carbon (Disabled)", upstreamModelId: "gemini-4-carbon-disabled" },
    { id: "gemini-4-hydrogen-disabled", name: "Gemini 4 Hydrogen (Disabled)", upstreamModelId: "gemini-4-hydrogen-disabled" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", upstreamModelId: "gemini-3.8-flash-high" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", upstreamModelId: "gemini-3.8-flash-medium" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", upstreamModelId: "gemini-3.8-flash-low" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", upstreamModelId: "gemini-3.8-flash-tiered" },
    { id: "gemini-3.8-flash-tiered", name: "Gemini 3.8 Flash (Tiered)", upstreamModelId: "gemini-3.8-flash-tiered" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash", upstreamModelId: "gemini-3-flash" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", upstreamModelId: "gemini-3.1-flash-lite" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", upstreamModelId: "gemini-3.5-flash-lite" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", upstreamModelId: "gemini-2.5-flash" },
    { id: "gemini-2.5-flash-thinking", name: "Gemini 2.5 Flash (Thinking)", upstreamModelId: "gemini-2.5-flash-thinking" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", upstreamModelId: "gemini-2.5-flash-lite" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", upstreamModelId: "gemini-2.5-pro" },
    { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", upstreamModelId: "gemini-pro-agent" },
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", upstreamModelId: "gemini-pro-agent" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", upstreamModelId: "claude-opus-4-6-thinking" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", upstreamModelId: "claude-sonnet-4-6" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", upstreamModelId: "gpt-oss-120b-medium" },
    // Image generation models
    { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash (Image)", kind: "image", imageGen: true, capabilities: ["textToImage"] },
  ],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    apiEndpoint: "https://daily-cloudcode-pa.googleapis.com",
    apiVersion: "v1internal",
    loadCodeAssistEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    onboardUserEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
    loadCodeAssistUserAgent: ANTIGRAVITY_IDE_USER_AGENT,
    refreshLeadMs: 300000,
  },
  searchViaChat: {
    defaultModel: "gemini-2.5-flash",
    endpoint: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:generateContent`,
    freeTier: "Free - Google Search grounding through an Antigravity OAuth account.",
  },
  features: {
    usage: true,
  },
};
