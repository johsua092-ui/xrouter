export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  aliases: ["opencode"],
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "cli",
    },
    retry: {
      429: { attempts: 2, delayMs: 1500 },
      502: { attempts: 3, delayMs: 2000 },
      503: { attempts: 3, delayMs: 2000 },
    },
    forceStream: true,
    noAuth: true,
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
    },
  },
  models: [
    { id: "muse-wonder-1.0", name: "Muse Wonder 1.0 (Flagship)", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "mimo-v2.6-flash-free", name: "MiMo v2.6 Flash Free" },
    { id: "space-bunny-free", name: "Space Bunny (MiniMax M3.1 Flash Free)" },
    { id: "big-pickle", name: "Big Pickle Free" },
    { id: "cat-jam-free", name: "Cat Jam Free" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
    { id: "glm-5.3-flash-free", name: "GLM 5.3 Flash Free" },
    { id: "longcat-2.5-preview-free", name: "Longcat 2.5 Preview Free" },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek v4.1 Flash Free" },
    { id: "iceman-contributor-free", name: "Iceman Contributor Free", targetFormat: "openai-responses" },
    // Upstream OpenCode has officially deprecated/retired muse-spark-1.* free contributor models
    // { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    // { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "union-alpha", name: "Union Alpha Free", targetFormat: "claude" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free", kind: "systemone" },
    // Additional Free-tier models (subject to OpenCode free quota)
    { id: "gpt-4o-mini-free", name: "GPT-4o Mini Free", targetFormat: "openai", note: "Free tier quota limited; may return 502 if daily limit reached (see OpenCode free limits)." },
    { id: "claude-3-haiku-free", name: "Claude 3 Haiku Free", targetFormat: "claude", note: "Free tier quota limited; count toward daily free usage." },
    { id: "llama-3.1-8b-free", name: "Llama 3.1 8B Instruct Free", targetFormat: "openai", note: "Free tier; may be rate-limited. Good for lightweight tasks." },
    { id: "mixtral-8x7b-free", name: "Mixtral 8x7B Instruct Free", targetFormat: "openai", note: "Free tier; community model via OpenRouter backend (if enabled)." },

  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/inference/v1/systemone",
    headers: {
      "x-opencode-client": "cli",
      "User-Agent": "opencode/latest/2.0.32/cli",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/inference/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
