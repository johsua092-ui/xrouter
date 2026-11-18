package providers

// Wave 9 — the non-chat modalities + web-cookie providers, completing the
// Node registry port (56 providers). Same SearchAdapter contract as wave 3:
// JSON POST in, provider-shaped JSON out; the differences are in the path,
// not the shape. Web-cookie providers resolve their BaseURL from the
// connection (session-bound endpoints), matching the Node cookie executors.
//
// NOTE per 2026-11-18 audit: these adapters make the providers RESOLVE. The
// request/response dialect translation per modality (search answer shapes,
// audio bytes, image b64) rides the existing translate pipeline — see
// internal/translate — the same way Node handlers sit behind chatCore.

func RegisterWave9Search(r *Registry) {
	r.Register(&SearchAdapter{Provider: "brave-search", BaseURL: "https://api.search.brave.com/res/v1"})
	r.Register(&SearchAdapter{Provider: "exa", BaseURL: "https://api.exa.ai"})
	r.Register(&SearchAdapter{Provider: "firecrawl", BaseURL: "https://api.firecrawl.dev/v1"})
	r.Register(&SearchAdapter{Provider: "google-pse", BaseURL: "https://www.googleapis.com/customsearch/v1"})
	r.Register(&SearchAdapter{Provider: "jina-ai", BaseURL: "https://api.jina.ai/v1"})
	r.Register(&SearchAdapter{Provider: "jina-reader", BaseURL: "https://r.jina.ai"})
	r.Register(&SearchAdapter{Provider: "linkup", BaseURL: "https://api.linkup.so/v1"})
	r.Register(&SearchAdapter{Provider: "ollama-search", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "perplexity", BaseURL: "https://api.perplexity.ai"})
	r.Register(&SearchAdapter{Provider: "perplexity-agent", BaseURL: "https://api.perplexity.ai"})
	r.Register(&SearchAdapter{Provider: "searchapi", BaseURL: "https://www.searchapi.io/api/v1"})
	r.Register(&SearchAdapter{Provider: "searxng", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "serper", BaseURL: "https://google.serper.dev"})
	r.Register(&SearchAdapter{Provider: "tavily", BaseURL: "https://api.tavily.com"})
	r.Register(&SearchAdapter{Provider: "tinyfish", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "youcom", BaseURL: ""})
}

func RegisterWave9TtsStt(r *Registry) {
	r.Register(&SearchAdapter{Provider: "assemblyai", BaseURL: "https://api.assemblyai.com/v2"})
	r.Register(&SearchAdapter{Provider: "aws-polly", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "cartesia", BaseURL: "https://api.cartesia.ai"})
	r.Register(&SearchAdapter{Provider: "coqui", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "deepgram", BaseURL: "https://api.deepgram.com/v1"})
	r.Register(&SearchAdapter{Provider: "edge-tts", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "elevenlabs", BaseURL: "https://api.elevenlabs.io/v1"})
	r.Register(&SearchAdapter{Provider: "fish-audio", BaseURL: "https://api.fish.audio"})
	r.Register(&SearchAdapter{Provider: "google-tts", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "inworld", BaseURL: "https://api.inworld.ai"})
	r.Register(&SearchAdapter{Provider: "local-device", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "playht", BaseURL: "https://api.play.ht/api/v2"})
	r.Register(&SearchAdapter{Provider: "selfhosted-stt", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "selfhosted-tts", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "tortoise", BaseURL: ""})
}

func RegisterWave9Image(r *Registry) {
	r.Register(&SearchAdapter{Provider: "black-forest-labs", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "comfyui", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "fal-ai", BaseURL: "https://queue.fal.run"})
	r.Register(&SearchAdapter{Provider: "nanobanana", BaseURL: "https://api.nanobananaapi.ai/v1"})
	r.Register(&SearchAdapter{Provider: "recraft", BaseURL: "https://external.api.recraft.ai/v1"})
	r.Register(&SearchAdapter{Provider: "runwayml", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "sdwebui", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "stability-ai", BaseURL: "https://api.stability.ai/v2beta"})
	r.Register(&SearchAdapter{Provider: "topaz", BaseURL: ""})
}

func RegisterWave9WebCookie(r *Registry) {
// chatgpt-web: session-bound; BaseURL resolves from the connection cookie profile.
	r.Register(&SearchAdapter{Provider: "chatgpt-web", BaseURL: "https://chatgpt.com/backend-api"})
// claude-web: session-bound; BaseURL resolves from the connection cookie profile.
	r.Register(&SearchAdapter{Provider: "claude-web", BaseURL: "https://claude.ai/api"})
// copilot-web: session-bound; BaseURL resolves from the connection cookie profile.
	r.Register(&SearchAdapter{Provider: "copilot-web", BaseURL: "https://copilot.microsoft.com/c/api"})
// grok-web: session-bound; BaseURL resolves from the connection cookie profile.
	r.Register(&SearchAdapter{Provider: "grok-web", BaseURL: "https://grok.com/rest/app-chat"})
// yuanbao-web: session-bound; BaseURL resolves from the connection cookie profile.
	r.Register(&SearchAdapter{Provider: "yuanbao-web", BaseURL: "https://yuanbao.tencent.com/api"})
// zai-web: session-bound; BaseURL resolves from the connection cookie profile.
	r.Register(&SearchAdapter{Provider: "zai-web", BaseURL: "https://chat.z.ai/api/v1"})
}

func RegisterWave9Misc(r *Registry) {
	r.Register(&SearchAdapter{Provider: "gemini", BaseURL: "https://generativelanguage.googleapis.com/v1beta"})
	r.Register(&SearchAdapter{Provider: "huggingface", BaseURL: "https://router.huggingface.co"})
	r.Register(&SearchAdapter{Provider: "notion-web", BaseURL: "https://www.notion.so/api/v3"})
	r.Register(&SearchAdapter{Provider: "nous", BaseURL: "https://api.nousresearch.com/v1"})
	r.Register(&SearchAdapter{Provider: "ollama", BaseURL: "https://ollama.com"})
	r.Register(&SearchAdapter{Provider: "selfhosted-embedding", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "v1m", BaseURL: "https://v1m.ir/v1"})
	r.Register(&SearchAdapter{Provider: "vertex-partner", BaseURL: ""})
	r.Register(&SearchAdapter{Provider: "voyage-ai", BaseURL: "https://api.voyageai.com/v1"})
	r.Register(&SearchAdapter{Provider: "xquik", BaseURL: "https://xquik.com/api/v1"})
}
