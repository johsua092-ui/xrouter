export default {
  id: "koma-free",
  priority: 156,
  alias: "koma-free",
  aliases: ["koma", "komafree"],
  uiAlias: "koma-free",
  category: "free",
  hasFree: true,
  noAuth: true,
  display: {
    name: "Koma Free (Unlimited)",
    icon: "bolt",
    color: "#00ADD8",
    textIcon: "KOMA",
    website: "https://koma.run",
    notice: {
      apiKeyUrl: "https://koma.run",
    },
  },
  authType: "none",
  authModes: ["none"],
  transport: {
    baseUrl: "https://koma.run/api/v1/koma-free/chat/completions",
    format: "openai",
  },
  models: [
    { id: "koma/apple", name: "Koma Apple (vLLM)", contextLength: 131072 },
  ],
  passthroughModels: true,
};
