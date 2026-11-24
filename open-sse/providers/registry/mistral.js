export default {
  id: "mistral",
  priority: 80,
  alias: "mistral",
  display: {
    name: "Mistral",
    icon: "air",
    color: "#FF7000",
    textIcon: "MI",
    website: "https://mistral.ai",
    notice: {
      apiKeyUrl: "https://console.mistral.ai/api-keys",
    },
  },
  category: "apikey",
  thinkingConfig: {
    // Mistral only speaks top-level reasoning_effort, and the accepted set is
    // model-gated (deepseek-v4-1-flash-1017: none|low|high|xhigh,
    // mistral-large: low|medium|high). "auto" = send nothing, use the model default.
    options: ["auto", "none", "low", "medium", "high", "xhigh"],
    defaultMode: "auto",
  },
  transport: {
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    validateUrl: "https://api.mistral.ai/v1/models",
    // Mistral's chat schema is strict (extra="forbid"): a Claude/DeepSeek-shaped
    // `thinking` object is rejected with 422 extra_forbidden, so thinking must go
    // through the dedicated "mistral" format (reasoning_effort only, clamped).
    thinkingFormat: "mistral",
    quirks: {
      dropClientMetadata: true,
    },
  },
  models: [
    { id: "mistral-large-latest", name: "Mistral Large 3" },
    { id: "codestral-latest", name: "Codestral" },
    { id: "mistral-medium-latest", name: "Mistral Medium 3" },
    { id: "mistral-embed", name: "Mistral Embed", kind: "embedding" },
  ],
  serviceKinds: ["llm","imageToText","embedding"],
  embeddingConfig: { baseUrl: "https://api.mistral.ai/v1/embeddings", authType: "apikey", authHeader: "bearer" },
};
