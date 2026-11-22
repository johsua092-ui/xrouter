package providers

// Wave 19: providers whose upstream contract differs from plain OpenAI-compat.
// Each of these was previously answered by the generic fallback, which meant a
// request went to the wrong URL or with the wrong auth shape — the connection
// looked healthy and every call failed.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------- azure

// azureAdapter speaks the deployment-scoped Azure OpenAI route. The model id is
// a deployment name, the key travels in `api-key` rather than Authorization, and
// the API version is mandatory — three differences the generic adapter cannot
// express.
type azureAdapter struct{}

func (a *azureAdapter) Name() string { return "azure" }

func (a *azureAdapter) Endpoint(req Request, cred Credential) (string, error) {
	base := firstNonEmpty(cred.BaseURL, cred.Extra["azureEndpoint"], "https://api.openai.com")
	version := firstNonEmpty(cred.Extra["apiVersion"], "2024-10-01-preview")
	deployment := firstNonEmpty(cred.Extra["deployment"], req.Model, "gpt-4")
	return strings.TrimSuffix(base, "/") + "/openai/deployments/" +
		url.PathEscape(deployment) + "/chat/completions?api-version=" + url.QueryEscape(version), nil
}

func (a *azureAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	headers := map[string]string{"Content-Type": "application/json"}
	if key := firstNonEmpty(cred.APIKey, cred.AccessToken); key != "" {
		headers["api-key"] = key
	}
	if org := cred.Extra["organization"]; org != "" {
		headers["OpenAI-Organization"] = org
	}
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}
	return headers, nil
}

// ---------------------------------------------------------------- ollama-local

// ollamaLocalAdapter hits a resident Ollama on /api/chat rather than /v1. The
// host is per-connection, because "local" is wherever the operator installed it.
type ollamaLocalAdapter struct{}

func (a *ollamaLocalAdapter) Name() string { return "ollama-local" }

func (a *ollamaLocalAdapter) Endpoint(req Request, cred Credential) (string, error) {
	host := firstNonEmpty(cred.BaseURL, cred.Extra["host"], os.Getenv("OLLAMA_HOST"), "http://127.0.0.1:11434")
	return strings.TrimSuffix(host, "/") + "/api/chat", nil
}

func (a *ollamaLocalAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	headers := map[string]string{"Content-Type": "application/json"}
	if cred.APIKey != "" {
		headers["Authorization"] = "Bearer " + cred.APIKey
	}
	return headers, nil
}

// ---------------------------------------------------------------- kimchi

// kimchiAdapter forwards to an OpenAI-compatible gateway that rejects the
// Anthropic-only fields the translator leaves behind. It also insists on the
// system prompt being the first message rather than a top-level field.
type kimchiAdapter struct{}

func (a *kimchiAdapter) Name() string { return "kimchi" }

func (a *kimchiAdapter) Endpoint(req Request, cred Credential) (string, error) {
	base := firstNonEmpty(cred.BaseURL, "https://api.kimchi.dev/v1")
	return strings.TrimSuffix(base, "/") + "/chat/completions", nil
}

func (a *kimchiAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	key := firstNonEmpty(cred.APIKey, cred.AccessToken)
	if key == "" {
		return nil, errNoCredential("kimchi")
	}
	return map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer " + key,
	}, nil
}

func (a *kimchiAdapter) RewriteBody(req Request, cred Credential, body []byte) ([]byte, error) {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, nil
	}
	for _, field := range []string{
		"anthropic_version", "anthropic_beta", "client_metadata",
		"mcp_servers", "stop_sequences", "thinking", "top_k",
	} {
		delete(parsed, field)
	}

	if systemText := flattenSystem(parsed["system"]); systemText != "" {
		messages, _ := parsed["messages"].([]any)
		merged := false
		for _, raw := range messages {
			message, ok := raw.(map[string]any)
			if !ok || str(message["role"]) != "system" {
				continue
			}
			switch content := message["content"].(type) {
			case string:
				message["content"] = systemText + "\n\n" + content
			case []any:
				message["content"] = append([]any{map[string]any{"type": "text", "text": systemText}}, content...)
			}
			merged = true
			break
		}
		if !merged {
			messages = append([]any{map[string]any{"role": "system", "content": systemText}}, messages...)
			parsed["messages"] = messages
		}
		delete(parsed, "system")
	}

	if messages, ok := parsed["messages"].([]any); ok {
		for _, raw := range messages {
			message, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			delete(message, "cache_control")
			parts, ok := message["content"].([]any)
			if !ok {
				continue
			}
			clean := make([]any, 0, len(parts))
			for _, part := range parts {
				if object, ok := part.(map[string]any); ok {
					delete(object, "cache_control")
					delete(object, "signature")
					clean = append(clean, object)
					continue
				}
				clean = append(clean, part)
			}
			message["content"] = clean
		}
	}

	return json.Marshal(parsed)
}

// flattenSystem turns either a string or an array of text parts into one string.
func flattenSystem(raw any) string {
	switch value := raw.(type) {
	case string:
		return strings.TrimSpace(value)
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			if object, ok := item.(map[string]any); ok {
				if text := str(object["text"]); text != "" {
					parts = append(parts, text)
				}
			} else if text := str(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	}
	return ""
}

// ---------------------------------------------------------------- freepi

// freepiAdapter keeps the CLI's ad-slot telemetry alive. Upstream pauses an
// account with 403 `ads_required` when the client stops fetching banners, so the
// heartbeat is part of the protocol, not a nicety.
type freepiAdapter struct {
	client *http.Client
}

const freepiCLIVersion = "0.6.25"

func (a *freepiAdapter) Name() string { return "freepi" }

func (a *freepiAdapter) Endpoint(req Request, cred Credential) (string, error) {
	base := firstNonEmpty(cred.BaseURL, "https://api.freepi.ai/v1")
	return strings.TrimSuffix(base, "/") + "/chat/completions", nil
}

func (a *freepiAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	key := firstNonEmpty(cred.APIKey, cred.AccessToken)
	if key == "" {
		return nil, errNoCredential("freepi")
	}
	return map[string]string{
		"Content-Type":     "application/json",
		"Authorization":    "Bearer " + key,
		"x-client-version": freepiCLIVersion,
		"x-client-os":      runtime.GOOS,
		"x-client-arch":    runtime.GOARCH,
		"x-session-id":     firstNonEmpty(cred.Extra["sessionId"], req.RequestID),
		"x-turn-id":        req.RequestID,
	}, nil
}

// Preflight fetches the next banner slot. Failure is logged by the caller and
// never blocks the completion: a chat that works is better than a chat withheld
// because the ad service blinked.
func (a *freepiAdapter) Preflight(ctx context.Context, req Request, cred Credential) {
	key := firstNonEmpty(cred.APIKey, cred.AccessToken)
	if key == "" {
		return
	}
	client := a.client
	if client == nil {
		client = &http.Client{Timeout: 4 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://api.freepi.ai/ads/next?slot=banner", nil)
	if err != nil {
		return
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("x-session-id", firstNonEmpty(cred.Extra["sessionId"], req.RequestID))
	request.Header.Set("x-turn-id", req.RequestID)
	request.Header.Set("x-client-version", freepiCLIVersion)
	request.Header.Set("x-client-os", runtime.GOOS)
	request.Header.Set("x-client-arch", runtime.GOARCH)
	request.Header.Set("x-ad-trigger", "user_message")
	request.Header.Set("x-ad-context", "none")
	response, err := client.Do(request)
	if err != nil {
		return
	}
	defer response.Body.Close()
	_, _ = bytes.NewBuffer(nil).ReadFrom(response.Body)
}

// ---------------------------------------------------------------- github

// githubAdapter speaks Copilot. A GitHub token is not accepted upstream: it has
// to be exchanged at api.github.com/copilot_internal/v2/token for a short-lived
// Copilot token, and the request has to carry the VS Code extension identity or
// Copilot answers 400. Both are why the generic adapter never worked here.
type githubAdapter struct {
	mu     sync.Mutex
	tokens map[string]copilotToken
}

type copilotToken struct {
	token   string
	expires time.Time
}

const (
	copilotEditorVersion = "vscode/1.110.0"
	copilotChatVersion   = "copilot-chat/0.38.0"
	copilotUserAgent     = "GitHubCopilotChat/0.38.0"
	copilotAPIVersion    = "2025-04-01"
)

func (a *githubAdapter) Name() string { return "github" }

func (a *githubAdapter) Endpoint(req Request, cred Credential) (string, error) {
	base := firstNonEmpty(cred.BaseURL, "https://api.githubcopilot.com/chat/completions")
	if !strings.Contains(base, "/chat/completions") && !strings.Contains(base, "/responses") && !strings.Contains(base, "/messages") {
		base = strings.TrimSuffix(base, "/") + "/chat/completions"
	}
	return base, nil
}

func (a *githubAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	token := firstNonEmpty(cred.AccessToken, cred.Extra["copilotToken"])
	if token == "" {
		token = a.mint(cred.APIKey)
	}
	if token == "" {
		return nil, errNoCredential("github")
	}
	headers := map[string]string{
		"Authorization":                        "Bearer " + token,
		"Content-Type":                         "application/json",
		"copilot-integration-id":               "vscode-chat",
		"editor-version":                       copilotEditorVersion,
		"editor-plugin-version":                copilotChatVersion,
		"user-agent":                           copilotUserAgent,
		"openai-intent":                        "conversation-panel",
		"x-github-api-version":                 copilotAPIVersion,
		"x-vscode-user-agent-library-version":  "electron-fetch",
		"X-Initiator":                          "user",
	}
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	} else {
		headers["Accept"] = "application/json"
	}
	return headers, nil
}

// mint exchanges a GitHub token for a Copilot token, caching it until just before
// expiry. Failures return empty and the caller reports a missing credential
// rather than sending a token Copilot will reject.
func (a *githubAdapter) mint(githubToken string) string {
	if githubToken == "" {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if cached, ok := a.tokens[githubToken]; ok && time.Now().Before(cached.expires) {
		return cached.token
	}

	request, err := http.NewRequest(http.MethodGet, "https://api.github.com/copilot_internal/v2/token", nil)
	if err != nil {
		return ""
	}
	request.Header.Set("Authorization", "token "+githubToken)
	request.Header.Set("User-Agent", copilotUserAgent)
	request.Header.Set("Editor-Version", copilotEditorVersion)
	request.Header.Set("Editor-Plugin-Version", copilotChatVersion)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("x-github-api-version", copilotAPIVersion)

	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ""
	}
	var payload struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expires_at"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil || payload.Token == "" {
		return ""
	}
	expiry := time.Unix(payload.ExpiresAt, 0).Add(-2 * time.Minute)
	if payload.ExpiresAt == 0 {
		expiry = time.Now().Add(10 * time.Minute)
	}
	if a.tokens == nil {
		a.tokens = make(map[string]copilotToken, 4)
	}
	a.tokens[githubToken] = copilotToken{token: payload.Token, expires: expiry}
	return payload.Token
}

// errNoCredential is the honest failure for an adapter that cannot call upstream
// without a token. Better a clear 502 than a request sent with an empty header.
func errNoCredential(provider string) error {
	return fmt.Errorf("%s: no credential configured", provider)
}

// ---------------------------------------------------------------- registration

// RegisterWave19 installs the adapters from wave 19.
func RegisterWave19(r *Registry) {
	r.Register(&azureAdapter{})
	r.Register(&ollamaLocalAdapter{})

	r.Register(&kimchiAdapter{})
	r.Register(&githubAdapter{tokens: make(map[string]copilotToken, 4)})
	r.Register(&freepiAdapter{})
}
