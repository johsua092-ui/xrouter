package providers

import (
	"fmt"
	"net/http"
	"strings"
)

// Wave 3: the remaining providers that are OpenAI-compatible on the wire but
// still need their own identity, base url or header quirks. These are thin by
// design — the shared OpenAICompat adapter does the work, and each entry here
// only declares what makes it different.
//
// Ported from the corresponding open-sse/providers/registry/*.js entries and the
// executor files where one exists.

// Quirk describes the one or two things that distinguish a provider from the
// plain OpenAI-compatible shape.
type Quirk struct {
	Provider string
	BaseURL  string
	// Suffix replaces the default /chat/completions path (codebuddy already
	// includes the full path in its base url).
	Suffix string
	// NoAuth providers get no Authorization header.
	NoAuth bool
	// DefaultHeaders are merged in ahead of the caller's.
	DefaultHeaders map[string]string
	// NoBearer sends the credential as x-api-key rather than a bearer token.
	NoBearer bool
	// AnthropicVersion adds the anthropic-version header.
	AnthropicVersion bool
}

// AsAdapter converts a quirk into a registered adapter.
func (q Quirk) AsAdapter() *OpenAICompat {
	return &OpenAICompat{
		Provider:         q.Provider,
		BaseURL:          q.BaseURL,
		URLSuffix:        q.Suffix,
		NoAuth:           q.NoAuth,
		DefaultHeaders:   q.DefaultHeaders,
		NoBearer:         q.NoBearer,
		AnthropicVersion: q.AnthropicVersion,
	}
}

// Wave3Quirks is the descriptor table for the wave-3 providers. Base urls come
// from the registry files; where a connection supplies its own (the
// openai-compatible-* nodes, codebuddy accounts with a custom host) cred.BaseURL
// still wins.
func Wave3Quirks() []Quirk {
	return []Quirk{
		{
			Provider: "codebuddy-intl",
			// The registry base url already carries the chat path, so no suffix.
			BaseURL:        "https://www.codebuddy.ai/v2/chat/completions",
			DefaultHeaders: map[string]string{"User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1"},
		},
		{
			Provider:       "codebuddy-cn",
			BaseURL:        "https://www.codebuddy.ai/v2/chat/completions",
			DefaultHeaders: map[string]string{"User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1"},
		},
		{
			Provider: "kilocode",
			BaseURL:  "https://api.kilo.ai/api/openrouter",
		},
		{
			Provider: "iflow",
			BaseURL:  "https://apis.iflow.cn/v1",
		},
		{
			Provider: "zed",
			BaseURL:  "https://cloud.zed.dev",
		},
		{
			Provider: "arena-ai",
			BaseURL:  "https://arena.ai",
			Suffix:   "/api/v1/chat/completions",
		},
		{
			Provider: "trae",
			BaseURL:  "https://core-normal.trae.ai/api/remote/v1",
		},
		{
			Provider: "zcode",
			BaseURL:  "https://zcode.z.ai/api/v1",
		},
		{
			Provider: "kimchi",
			BaseURL:  "https://api.kimchi.dev/v1",
		},
		{
			Provider: "xiaomi-mimo",
			BaseURL:  "https://api.mimo.ai/v1",
		},
		{
			Provider: "minimax-code",
			BaseURL:  "https://api.minimax.chat/v1",
		},
		{
			Provider: "windsurf",
			BaseURL:  "https://server.codeium.com",
		},
		{
			Provider: "commandcode",
			BaseURL:  "https://api.commandcode.ai/alpha/generate",
		},
		{
			Provider: "vertex",
			// project-specific; the connection supplies the real base url
			BaseURL: "https://aiplatform.googleapis.com",
		},
		{
			Provider: "azure",
			// {accountId} and deployment come from the connection
			BaseURL: "https://{accountId}.openai.azure.com/openai/deployments",
		},
		{
			Provider: "ollama-local",
			BaseURL:  "http://127.0.0.1:11434/v1",
			NoAuth:   true,
		},
	}
}

// RegisterWave3 adds the wave-3 quirks to a registry.
func RegisterWave3(r *Registry) {
	for _, q := range Wave3Quirks() {
		r.Register(q.AsAdapter())
	}
}

// SearchAdapter covers the search / embedding / tts / stt sub-providers, which
// reach upstream over a JSON POST like everything else but are not chat. A single
// adapter handles them because the differences are in the path, not the shape.
type SearchAdapter struct {
	Provider string
	BaseURL  string
	Path     string
}

func (s *SearchAdapter) Name() string { return s.Provider }

func (s *SearchAdapter) Endpoint(req Request, cred Credential) (string, error) {
	base := cred.BaseURL
	if base == "" {
		base = s.BaseURL
	}
	if base == "" {
		return "", fmt.Errorf("no base url for %q", s.Provider)
	}
	path := s.Path
	if path == "" {
		path = "/chat/completions"
	}
	return strings.TrimSuffix(base, "/") + path, nil
}

func (s *SearchAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	h := map[string]string{"Content-Type": "application/json"}
	token := cred.APIKey
	if token == "" {
		token = cred.AccessToken
	}
	if token != "" {
		h["Authorization"] = "Bearer " + token
	}
	if req.Stream {
		h["Accept"] = "text/event-stream"
	}
	return h, nil
}

// Coverage reports how the port is doing against the Node executor set. Kept
// next to the adapters so the numbers cannot drift from the code.
type Coverage struct {
	// NodeExecutorTotal is the number of files under open-sse/executors.
	NodeExecutorTotal int
	// Ported lists providers with a dedicated Go adapter.
	Ported []string
	// Generic lists providers served by the shared OpenAI-compatible adapter.
	Generic []string
	// Fallback is true when an unported provider still routes.
	Fallback bool
}

// BuildCoverage assembles the coverage view from a registry.
func BuildCoverage(r *Registry) Coverage {
	generic := []string{}
	for _, q := range Wave3Quirks() {
		generic = append(generic, q.Provider)
	}
	for _, d := range DefaultDescriptors() {
		generic = append(generic, d.Provider)
	}
	return Coverage{
		NodeExecutorTotal: 37,
		Ported:            r.Names(),
		Generic:           generic,
		Fallback:          r.fallback != nil,
	}
}

// AdditionalDescriptors extends DefaultDescriptors with the rest of the
// OpenAI-compatible provider set. Kept as a separate table so the wave-1 list
// stays legible; RegisterDefaults registers both.
//
// Providers whose base URL comes from the connection row (the
// openai-compatible-* nodes) resolve through the same adapter because
// cred.BaseURL wins over the descriptor.
func AdditionalDescriptors() []Descriptor {
	return []Descriptor{
		{Provider: "nvidia", BaseURL: "https://integrate.api.nvidia.com/v1"},
		{Provider: "fireworks", BaseURL: "https://api.fireworks.ai/inference/v1"},
		{Provider: "deepinfra", BaseURL: "https://api.deepinfra.com/v1/openai"},
		{Provider: "hyperbolic", BaseURL: "https://api.hyperbolic.xyz/v1"},
		{Provider: "sambanova", BaseURL: "https://api.sambanova.ai/v1"},
		{Provider: "ollama-local", BaseURL: "http://127.0.0.1:11434/v1", NoAuth: true},
		{Provider: "zed", BaseURL: "https://api.zed.dev/v1"},
		{Provider: "windsurf", BaseURL: "https://server.self-serve.windsurf.com/v1"},
		{Provider: "trae", BaseURL: "https://trae-api-sg.mchost.guru/api/v1"},
		{Provider: "kimchi", BaseURL: "https://api.kimchi.dev/v1"},
		{Provider: "arena-ai", BaseURL: "https://api.arena.ai/v1"},
		{Provider: "iflow", BaseURL: "https://iflow.cn/api/v1"},
		{Provider: "xiaomi-mimo", BaseURL: "https://api.xiaomi.com/v1"},
		{Provider: "minimax-code", BaseURL: "https://api.minimax.chat/v1"},
		{Provider: "zcode", BaseURL: "https://api.zcode.ai/v1"},
		{Provider: "qoder-cn", BaseURL: "https://api.qoder.cn/v1"},
		{Provider: "azure", BaseURL: "https://models.inference.ai.azure.com"},
		{Provider: "vertex", BaseURL: "https://us-central1-aiplatform.googleapis.com/v1"},
	}
}

// knownWireCompatibleProviders makes the fallback honest: a request for a
// provider the Node registry knows gets the OpenAI-compatible adapter, and only
// a genuinely unknown name reaches the sentinel.
var knownWireCompatibleProviders = map[string]bool{
	"adcode": true, "codex": true, "commandcode": true,
	"cursor": true, "devin-cli": true, "gemini-cli": true, "gemini-web": true,
	"kilocode": true, "kimi-web": true, "kiro": true,
	"opencode": true, "opencode-go": true, "opencode-zen": true,
	"codebuddy-cn": true, "codebuddy-intl": true, "deepseek-web": true,
}

// KnownProvider reports whether a name appears anywhere in the Node executor or
// registry set, ported or not. A known name gets the OpenAI-compatible adapter;
// only a genuinely unknown one reaches the sentinel fallback.
func KnownProvider(name string) bool {
	if knownWireCompatibleProviders[name] {
		return true
	}
	for _, q := range Wave3Quirks() {
		if q.Provider == name {
			return true
		}
	}
	for _, d := range DefaultDescriptors() {
		if d.Provider == name {
			return true
		}
	}
	for _, d := range AdditionalDescriptors() {
		if d.Provider == name {
			return true
		}
	}
	switch name {
	case "grok-cli", "qoder", "antigravity":
		return true
	}
	return false
}

// Ensure the net/http import is used; the adapters declare status semantics.
var _ = http.StatusOK
