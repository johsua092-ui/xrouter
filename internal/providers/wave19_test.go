package providers_test

// Behavioural checks for the wave-19 adapters: the shapes here are the reason
// those providers failed on the generic fallback, so each test asserts the
// specific contract difference.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/johsua092-ui/xrouter/internal/providers"
)

func wave19Registry() *providers.Registry {
	r := providers.NewRegistry()
	providers.RegisterWave19(r)
	return r
}

func TestAzureUsesDeploymentRoute(t *testing.T) {
	adapter, ok := wave19Registry().Resolve("azure")
	if !ok {
		t.Fatal("azure not registered")
	}
	cred := providers.Credential{
		APIKey: "key",
		Extra: map[string]string{
			"azureEndpoint": "https://contoso.openai.azure.com/",
			"deployment":    "gpt-4o",
			"apiVersion":    "2024-10-01-preview",
		},
	}
	endpoint, err := adapter.Endpoint(providers.Request{Model: "ignored", Stream: true}, cred)
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	want := "https://contoso.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-01-preview"
	if endpoint != want {
		t.Fatalf("endpoint = %q, want %q", endpoint, want)
	}
	headers, err := adapter.Headers(providers.Request{Stream: true}, cred)
	if err != nil {
		t.Fatalf("headers: %v", err)
	}
	if headers["api-key"] != "key" {
		t.Fatalf("api-key header missing: %v", headers)
	}
	if _, hasBearer := headers["Authorization"]; hasBearer {
		t.Fatal("azure must not send Authorization; the key goes in api-key")
	}
}

func TestOllamaLocalUsesNativeChatRoute(t *testing.T) {
	adapter, ok := wave19Registry().Resolve("ollama-local")
	if !ok {
		t.Fatal("ollama-local not registered")
	}
	endpoint, err := adapter.Endpoint(providers.Request{Model: "llama3"}, providers.Credential{})
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	if !strings.HasSuffix(endpoint, "/api/chat") {
		t.Fatalf("endpoint = %q, want the native /api/chat route", endpoint)
	}
}

func TestKimchiStripsAnthropicFields(t *testing.T) {
	adapter, ok := wave19Registry().Resolve("kimchi")
	if !ok {
		t.Fatal("kimchi not registered")
	}
	rewriter, ok := adapter.(providers.BodyRewriter)
	if !ok {
		t.Fatal("kimchi must rewrite the body")
	}
	body := []byte(`{
		"model":"kimi-k2",
		"system":"be terse",
		"anthropic_version":"2023-06-01",
		"thinking":{"type":"enabled"},
		"top_k":40,
		"messages":[
			{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"},"signature":"sig"}]}
		]
	}`)
	out, err := rewriter.RewriteBody(providers.Request{Model: "kimi-k2"}, providers.Credential{APIKey: "k"}, body)
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, banned := range []string{"anthropic_version", "thinking", "top_k", "system"} {
		if _, present := parsed[banned]; present {
			t.Fatalf("%s should have been dropped", banned)
		}
	}
	messages, _ := parsed["messages"].([]any)
	first, _ := messages[0].(map[string]any)
	if first["role"] != "system" {
		t.Fatalf("system prompt must become the first message, got %v", first["role"])
	}
	second, _ := messages[1].(map[string]any)
	parts, _ := second["content"].([]any)
	part, _ := parts[0].(map[string]any)
	if _, present := part["cache_control"]; present {
		t.Fatal("cache_control must be stripped from content parts")
	}
	if _, present := part["signature"]; present {
		t.Fatal("signature must be stripped from content parts")
	}
}

func TestGithubTargetsCopilotEndpoint(t *testing.T) {
	adapter, ok := wave19Registry().Resolve("github")
	if !ok {
		t.Fatal("github not registered")
	}
	endpoint, err := adapter.Endpoint(providers.Request{Model: "gpt-4o"}, providers.Credential{})
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	if endpoint != "https://api.githubcopilot.com/chat/completions" {
		t.Fatalf("endpoint = %q", endpoint)
	}
	headers, err := adapter.Headers(providers.Request{Stream: true}, providers.Credential{AccessToken: "copilot-token"})
	if err != nil {
		t.Fatalf("headers: %v", err)
	}
	if headers["Authorization"] != "Bearer copilot-token" {
		t.Fatalf("authorization = %q", headers["Authorization"])
	}
	if headers["copilot-integration-id"] != "vscode-chat" {
		t.Fatalf("copilot identity headers missing: %v", headers)
	}
	if headers["Accept"] != "text/event-stream" {
		t.Fatalf("accept = %q", headers["Accept"])
	}
}

func TestGithubWithoutTokenFailsHonestly(t *testing.T) {
	adapter, _ := wave19Registry().Resolve("github")
	if _, err := adapter.Headers(providers.Request{}, providers.Credential{}); err == nil {
		t.Fatal("github without any token must error, not send an empty bearer")
	}
}
