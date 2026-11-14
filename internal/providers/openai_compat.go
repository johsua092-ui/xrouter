package providers

import (
	"fmt"
	"net/http"
	"strings"
)

// OpenAICompat is the Go port of open-sse/executors/default.js.
//
// It covers every provider whose upstream speaks the OpenAI chat-completions
// dialect: the openai-compatible-* nodes, ovh, github, grok-cli and the rest of
// the 37. In the live database these account for the bulk of active connections,
// so this is the adapter that has to be right before any provider-specific port
// is worth writing.
//
// Faithful to the Node behaviour that matters:
//   - BaseURL comes from the connection first, the descriptor second.
//   - {accountId} in the URL is substituted from credential Extra.
//   - A URL already ending in /chat/completions is used as-is; anything else gets
//     /chat/completions appended.
//   - noAuth providers get no Authorization header at all, and the header is
//     deleted rather than blanked so nothing leaks an empty bearer.
//   - stream requests advertise Accept: text/event-stream.
type OpenAICompat struct {
	// Provider is the registry key, matching the Node provider id.
	Provider string
	// BaseURL is the descriptor default, used when the connection has no override.
	BaseURL string
	// URLSuffix is appended after BaseURL for providers whose chat path is not the
	// standard /chat/completions (config.urlSuffix in Node).
	URLSuffix string
	// NoAuth mirrors config.noAuth / authType "none" — ovh and friends.
	NoAuth bool
	// DefaultHeaders are merged in before the caller's own, exactly as
	// config.headers is in the Node executor.
	DefaultHeaders map[string]string
	// UsesBearer selects bearer auth. False means the credential is an API key sent
	// on a raw header (x-api-key), as the anthropic-compatible branch does.
	NoBearer bool
	// AnthropicVersion adds the anthropic-version header when set.
	AnthropicVersion bool
}

// NewOpenAICompat builds the standard adapter for a provider.
func NewOpenAICompat(provider, baseURL string) *OpenAICompat {
	return &OpenAICompat{Provider: provider, BaseURL: baseURL}
}

func (o *OpenAICompat) Name() string { return o.Provider }

// Endpoint mirrors DefaultExecutor.resolveUrl(). The order matters: a runtime
// base URL wins over the descriptor, and the {accountId} template is resolved
// before the suffix is appended.
func (o *OpenAICompat) Endpoint(req Request, cred Credential) (string, error) {
	base := cred.BaseURL
	if base == "" {
		base = o.BaseURL
	}
	if base == "" {
		return "", fmt.Errorf("no base url configured for provider %q", o.Provider)
	}

	if strings.Contains(base, "{accountId}") {
		accountID := ""
		if cred.Extra != nil {
			accountID = cred.Extra["accountId"]
		}
		if accountID == "" {
			return "", fmt.Errorf("provider %q requires accountId in providerSpecificData", o.Provider)
		}
		base = strings.ReplaceAll(base, "{accountId}", accountID)
	}

	trimmed := strings.TrimSuffix(base, "/")

	if o.URLSuffix != "" {
		return trimmed + o.URLSuffix, nil
	}
	if strings.HasSuffix(trimmed, "/chat/completions") {
		return trimmed, nil
	}
	return trimmed + "/chat/completions", nil
}

// Headers mirrors DefaultExecutor.buildHeaders() for the OpenAI-compatible path.
func (o *OpenAICompat) Headers(req Request, cred Credential) (map[string]string, error) {
	headers := map[string]string{"Content-Type": "application/json"}
	for k, v := range o.DefaultHeaders {
		headers[k] = v
	}

	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}

	if o.NoAuth {
		// delete rather than blank: an empty Authorization header makes some
		// upstreams reject the request outright.
		delete(headers, "Authorization")
		delete(headers, "authorization")
		return headers, nil
	}

	token := cred.APIKey
	if token == "" {
		token = cred.AccessToken
	}

	if o.NoBearer {
		if token != "" {
			headers["x-api-key"] = token
		}
		if o.AnthropicVersion && headers["anthropic-version"] == "" {
			headers["anthropic-version"] = AnthropicAPIVersion
		}
		return headers, nil
	}

	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}

	// client-supplied beta flags survive the hop, as they do in Node
	if v, ok := cred.RawHeaders["anthropic-beta"]; ok && v != "" {
		headers["anthropic-beta"] = v
	}

	return headers, nil
}

// AnthropicAPIVersion is the value Node sends on anthropic-compatible upstreams.
const AnthropicAPIVersion = "2023-06-01"

// ── Provider descriptor table ─────────────────────────────────────────────────
//
// Moved out of code and into a table so a new OpenAI-compatible provider is one
// line, not a new file. The Node side has the same shape in config/providers.

// Descriptor is the minimum an OpenAI-compatible provider needs.
type Descriptor struct {
	Provider string
	BaseURL  string
	NoAuth   bool
	Suffix   string
}

// BuildFromDescriptors turns the table into registered adapters.
func BuildFromDescriptors(ps ...Descriptor) []*OpenAICompat {
	out := make([]*OpenAICompat, 0, len(ps))
	for _, d := range ps {
		a := &OpenAICompat{
			Provider:  d.Provider,
			BaseURL:   d.BaseURL,
			NoAuth:    d.NoAuth,
			URLSuffix: d.Suffix,
		}
		out = append(out, a)
	}
	return out
}

// DefaultDescriptors are the OpenAI-compatible providers with a fixed public base
// URL. Providers whose base URL comes from the connection row (the
// openai-compatible-* nodes) still resolve correctly through the same adapter
// because cred.BaseURL wins over the descriptor.
func DefaultDescriptors() []Descriptor {
	return []Descriptor{
		{Provider: "ovh", BaseURL: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", NoAuth: true},
		{Provider: "github", BaseURL: "https://models.inference.ai.azure.com"},
		{Provider: "grok-cli", BaseURL: "https://api.x.ai/v1"},
		{Provider: "deepseek", BaseURL: "https://api.deepseek.com/v1"},
		{Provider: "openrouter", BaseURL: "https://openrouter.ai/api/v1"},
		{Provider: "groq", BaseURL: "https://api.groq.com/openai/v1"},
		{Provider: "together", BaseURL: "https://api.together.xyz/v1"},
		{Provider: "mistral", BaseURL: "https://api.mistral.ai/v1"},
		{Provider: "cerebras", BaseURL: "https://api.cerebras.ai/v1"},
	}
}

// RegisterDefaults wires the OpenAI-compatible adapter for every descriptor and
// installs the generic instance as the registry fallback, so an unported provider
// still routes instead of 500-ing.
func RegisterDefaults(r *Registry) {
	for _, a := range BuildFromDescriptors(DefaultDescriptors()...) {
		r.Register(a)
	}
	// fallback: the node-style "openai-compatible-*" provider whose base URL is
	// always supplied by the connection.
	r.SetFallback(&OpenAICompat{Provider: "__fallback__"})
}

// Ensure http import is used even if the file is trimmed during refactor.
var _ = http.StatusOK
