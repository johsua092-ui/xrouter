package providers

import "testing"

// The tests below pin the behaviours that would silently break routing if they
// regressed: URL assembly order, the no-auth header deletion, and the {accountId}
// template. They mirror the Node executor's own semantics rather than inventing
// new ones.

func TestEndpointAppendsChatCompletions(t *testing.T) {
	a := NewOpenAICompat("ovh", "https://example.test/v1")
	got, err := a.Endpoint(Request{Model: "m"}, Credential{})
	if err != nil {
		t.Fatal(err)
	}
	if want := "https://example.test/v1/chat/completions"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestEndpointDoesNotDoubleAppend(t *testing.T) {
	a := NewOpenAICompat("x", "https://example.test/v1/chat/completions")
	got, _ := a.Endpoint(Request{}, Credential{})
	if want := "https://example.test/v1/chat/completions"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestEndpointStripsTrailingSlash(t *testing.T) {
	a := NewOpenAICompat("x", "https://example.test/v1/")
	got, _ := a.Endpoint(Request{}, Credential{})
	if want := "https://example.test/v1/chat/completions"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

// A runtime base url from the connection must beat the descriptor default: this is
// how every openai-compatible-* node routes to its own upstream.
func TestEndpointPrefersConnectionBaseURL(t *testing.T) {
	a := NewOpenAICompat("openai-compatible-chat-abc", "https://descriptor.test/v1")
	got, _ := a.Endpoint(Request{}, Credential{BaseURL: "https://connection.test/v1"})
	if want := "https://connection.test/v1/chat/completions"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestEndpointResolvesAccountIDTemplate(t *testing.T) {
	a := NewOpenAICompat("azure", "https://{accountId}.openai.azure.com/v1")
	got, err := a.Endpoint(Request{}, Credential{Extra: map[string]string{"accountId": "acme"}})
	if err != nil {
		t.Fatal(err)
	}
	if want := "https://acme.openai.azure.com/v1/chat/completions"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

// Missing accountId must fail loudly, not produce a malformed upstream url.
func TestEndpointFailsWithoutAccountID(t *testing.T) {
	a := NewOpenAICompat("azure", "https://{accountId}.openai.azure.com/v1")
	if _, err := a.Endpoint(Request{}, Credential{}); err == nil {
		t.Fatal("expected an error when the accountId template has no value")
	}
}

func TestURLSuffixWins(t *testing.T) {
	a := &OpenAICompat{Provider: "special", BaseURL: "https://e.test", URLSuffix: "/custom/path"}
	got, _ := a.Endpoint(Request{}, Credential{})
	if want := "https://e.test/custom/path"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

// NoAuth must DELETE the header, not set it empty.
func TestNoAuthDeletesAuthorization(t *testing.T) {
	a := &OpenAICompat{Provider: "ovh", BaseURL: "https://e.test", NoAuth: true}
	h, err := a.Headers(Request{}, Credential{APIKey: "should-not-appear"})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := h["Authorization"]; present {
		t.Fatal("Authorization must not be present for a no-auth provider")
	}
	if _, present := h["authorization"]; present {
		t.Fatal("lowercase authorization must not be present either")
	}
}

func TestBearerHeader(t *testing.T) {
	a := NewOpenAICompat("x", "https://e.test")
	h, _ := a.Headers(Request{}, Credential{APIKey: "sk-abc"})
	if got := h["Authorization"]; got != "Bearer sk-abc" {
		t.Fatalf("got %q", got)
	}
}

func TestAccessTokenUsedWhenNoAPIKey(t *testing.T) {
	a := NewOpenAICompat("x", "https://e.test")
	h, _ := a.Headers(Request{}, Credential{AccessToken: "oauth-tok"})
	if got := h["Authorization"]; got != "Bearer oauth-tok" {
		t.Fatalf("got %q", got)
	}
}

// A stream request must advertise SSE.
func TestStreamAdvertisesSSE(t *testing.T) {
	a := NewOpenAICompat("x", "https://e.test")
	h, _ := a.Headers(Request{Stream: true}, Credential{APIKey: "k"})
	if got := h["Accept"]; got != "text/event-stream" {
		t.Fatalf("got %q", got)
	}
	h2, _ := a.Headers(Request{Stream: false}, Credential{APIKey: "k"})
	if _, present := h2["Accept"]; present {
		t.Fatal("non-stream request should not advertise SSE")
	}
}

// Beta flags the client sent must survive.
func TestClientBetaHeaderPassesThrough(t *testing.T) {
	a := NewOpenAICompat("x", "https://e.test")
	h, _ := a.Headers(Request{}, Credential{
		APIKey:     "k",
		RawHeaders: map[string]string{"anthropic-beta": "context-management-2025-06-27"},
	})
	if got := h["anthropic-beta"]; got != "context-management-2025-06-27" {
		t.Fatalf("got %q", got)
	}
}

// x-api-key providers take the raw key, not a bearer.
func TestNoBearerUsesRawAPIKeyHeader(t *testing.T) {
	a := &OpenAICompat{Provider: "anthropic-compatible-x", BaseURL: "https://e.test", NoBearer: true, AnthropicVersion: true}
	h, _ := a.Headers(Request{}, Credential{APIKey: "sk-ant-1"})
	if got := h["x-api-key"]; got != "sk-ant-1" {
		t.Fatalf("got %q", got)
	}
	if got := h["anthropic-version"]; got != AnthropicAPIVersion {
		t.Fatalf("got %q", got)
	}
	if _, present := h["Authorization"]; present {
		t.Fatal("x-api-key path must not also send a bearer")
	}
}

func TestRegistryResolveAndFallback(t *testing.T) {
	r := NewRegistry()
	RegisterDefaults(r)

	a, explicit := r.Resolve("github")
	if !explicit {
		t.Fatal("github should be explicitly registered")
	}
	if a.Name() != "github" {
		t.Fatalf("got %q", a.Name())
	}

	// an unported provider still resolves, via the fallback
	fb, explicit := r.Resolve("some-new-provider")
	if explicit {
		t.Fatal("fallback should not report as explicitly registered")
	}
	if fb == nil {
		t.Fatal("fallback must exist so unported providers still route")
	}

	if r.Count() < 9 {
		t.Fatalf("expected the descriptor table registered, got %d", r.Count())
	}
}

func TestRegistryNamesSorted(t *testing.T) {
	r := NewRegistry()
	RegisterDefaults(r)
	names := r.Names()
	for i := 1; i < len(names); i++ {
		if names[i-1] > names[i] {
			t.Fatalf("names not sorted: %v", names)
		}
	}
}
