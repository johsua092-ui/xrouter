package providers

import (
	"strings"
)

// Wave 8 — the chat-LLM long tail from the Node registry (main, 2026-11-18).
//
// Two groups, matching the Node executor contract:
//   - 38 OpenAI /chat/completions upstreams via the wave-1 OpenAICompat
//     adapter (URL/headers only, bearer auth default).
//   - 7 Anthropic /v1/messages upstreams via a small AnthropicCompatAdapter
//     wrapper (x-api-key + anthropic-version, per-provider BaseURL) that
//     reuses the AnthropicCompatible header logic from wave 4.
//
// Sources: open-sse/providers/registry/<id>.js transport.baseUrls + auth.
// Console/signup URLs are deliberately not carried over. claude/glm/kimi/
// minimax keep their full transport path in BaseURL because their Node
// executors append only the model segment, not /messages.

func RegisterWave8(r *Registry) {
	r.Register(NewOpenAICompat("agnes", "https://apihub.agnes-ai.com/v1"))
	r.Register(NewOpenAICompat("alicode", "https://coding.dashscope.aliyuncs.com/v1"))
	r.Register(NewOpenAICompat("alicode-intl", "https://coding-intl.dashscope.aliyuncs.com/v1"))
	r.Register(NewOpenAICompat("alims-intl", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"))
	r.Register(NewOpenAICompat("alitp-intl", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"))
	r.Register(NewOpenAICompat("api-airforce", "https://api.airforce/v1"))
	r.Register(NewOpenAICompat("atria", "https://api.atria-asi.ai/v1"))
	r.Register(NewOpenAICompat("bai", "https://api.b.ai/v1"))
	r.Register(NewOpenAICompat("baidu", "https://qianfan.baidubce.com/v2"))
	r.Register(NewOpenAICompat("bazaarlink", "https://bazaarlink.ai/api/v1"))
	r.Register(NewOpenAICompat("blackbox", "https://api.blackbox.ai/v1"))
	r.Register(NewOpenAICompat("bluesminds", "https://api.bluesminds.com/v1"))
	r.Register(NewOpenAICompat("byteplus", "https://ark.ap-southeast.bytepluses.com/api/coding/v3"))
	r.Register(NewOpenAICompat("chutes", "https://llm.chutes.ai/v1"))
	r.Register(NewOpenAICompat("cline", "https://api.cline.bot/api/v1"))
	r.Register(NewOpenAICompat("clinepass", "https://api.cline.bot/api/v1"))
	r.Register(NewOpenAICompat("cloudflare-ai", "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1"))
	r.Register(NewOpenAICompat("cohere", "https://api.cohere.ai/v1"))
	r.Register(NewOpenAICompat("dahl", "https://inference.dahl.global/v1"))
	r.Register(NewOpenAICompat("dothoosh", "https://gateway.dothoosh.com/v1"))
	r.Register(NewOpenAICompat("featherless", "https://api.featherless.ai/v1"))
	r.Register(NewOpenAICompat("gitlab", "https://gitlab.com/api/v4"))
	r.Register(NewOpenAICompat("glm-cn", "https://open.bigmodel.cn/api/coding/paas/v4"))
	r.Register(NewOpenAICompat("llm7", "https://api.llm7.io/v1"))
	r.Register(NewOpenAICompat("morph", "https://api.morphllm.com/v1"))
	r.Register(NewOpenAICompat("muse", "https://api.meta.ai/v1"))
	r.Register(NewOpenAICompat("nebius", "https://api.studio.nebius.ai/v1"))
	r.Register(NewOpenAICompat("openai", "https://api.openai.com/v1"))
	r.Register(NewOpenAICompat("poolside", "https://inference.poolside.ai/v1"))
	r.Register(NewOpenAICompat("river", "https://api.river.ai/v1"))
	r.Register(NewOpenAICompat("siliconflow", "https://api.siliconflow.com/v1"))
	r.Register(NewOpenAICompat("tencent", "https://api.hunyuan.cloud.tencent.com/v1"))
	r.Register(NewOpenAICompat("tokenharbor", "https://tokenharbor.ai/v1"))
	r.Register(NewOpenAICompat("tokenrouter", "https://api.tokenrouter.com/v1"))
	r.Register(NewOpenAICompat("venice", "https://api.venice.ai/api/v1"))
	r.Register(NewOpenAICompat("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1"))
	r.Register(NewOpenAICompat("volcengine-ark", "https://ark.cn-beijing.volces.com/api/coding/v3"))
	r.Register(NewOpenAICompat("xai", "https://api.x.ai/v1"))
}

// AnthropicCompatAdapter binds a per-provider BaseURL to the shared
// AnthropicCompatible header/endpoint logic. Endpoint mirrors wave 4:
// BaseURL already ends in /v1 (or the vendor path), append /messages.
type AnthropicCompatAdapter struct {
	ProviderID string
	BaseURL    string
}

func (a *AnthropicCompatAdapter) Name() string       { return a.ProviderID }
func (a *AnthropicCompatAdapter) WireFormat() string { return FormatClaude }

func (a *AnthropicCompatAdapter) Endpoint(req Request, cred Credential) (string, error) {
	base := strings.TrimSuffix(a.BaseURL, "/")
	return base + "/messages", nil
}

func (a *AnthropicCompatAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	// Delegate to the wave-4 logic: same dialect, same quirks. The receiver
	// only differs in which BaseURL the endpoint builder uses.
	ac := AnthropicCompatible{}
	return ac.Headers(req, cred)
}

func RegisterWave8Anthropic(r *Registry) {
	r.Register(&AnthropicCompatAdapter{ProviderID: "anthropic", BaseURL: "https://api.anthropic.com"})
	r.Register(&AnthropicCompatAdapter{ProviderID: "claude", BaseURL: "https://api.anthropic.com"})
	r.Register(&AnthropicCompatAdapter{ProviderID: "glm", BaseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic"})
	r.Register(&AnthropicCompatAdapter{ProviderID: "kimi", BaseURL: "https://api.kimi.com/coding"})
	r.Register(&AnthropicCompatAdapter{ProviderID: "minimax", BaseURL: "https://api.minimax.io/anthropic"})
	r.Register(&AnthropicCompatAdapter{ProviderID: "minimax-cn", BaseURL: "https://api.minimaxi.com/anthropic"})
	r.Register(&AnthropicCompatAdapter{ProviderID: "minimax-code-global", BaseURL: "https://agent.minimax.io/mavis/api/v1/llm"})
}
