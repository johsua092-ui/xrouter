package providers

// Wave 21: providers whose request side is ordinary but whose failure semantics
// are not. CommandCode streams AI SDK NDJSON from a non-OpenAI route; MiniMax
// Code reports spent credit as 402/403, which the account-fallback loop reads as
// an auth error and therefore retries against a half-spent account forever.

import (
	"encoding/json"
	"net/http"
	"strings"
)

// ---------------------------------------------------------------- commandcode

// commandcodeAdapter targets the alpha generate route, which streams AI SDK
// NDJSON rather than SSE. The response shape is handled by the translator layer;
// what the adapter owns is the route, the session header and the forced stream
// flag the upstream requires.
type commandcodeAdapter struct{}

func (a *commandcodeAdapter) Name() string { return "commandcode" }

func (a *commandcodeAdapter) Endpoint(req Request, cred Credential) (string, error) {
	return firstNonEmpty(cred.BaseURL, "https://api.commandcode.ai/alpha/generate"), nil
}

func (a *commandcodeAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	key := firstNonEmpty(cred.APIKey, cred.AccessToken)
	if key == "" {
		return nil, errNoCredential("commandcode")
	}
	headers := map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer " + key,
		"x-session-id":  uuidV4(),
	}
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}
	return headers, nil
}

// RewriteBody pins stream=true: the generate route has no non-streaming mode, and
// a false value returns an empty body rather than an error.
func (a *commandcodeAdapter) RewriteBody(req Request, cred Credential, body []byte) ([]byte, error) {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, nil
	}
	parsed["stream"] = true
	return json.Marshal(parsed)
}

// ---------------------------------------------------------------- minimax-code

// minimaxCodeAdapter talks to the Mavis agent gateway, which speaks the Anthropic
// messages shape. The adapter's real work is response classification.
type minimaxCodeAdapter struct{}

func (a *minimaxCodeAdapter) Name() string { return "minimax-code" }

func (a *minimaxCodeAdapter) Endpoint(req Request, cred Credential) (string, error) {
	return firstNonEmpty(cred.BaseURL,
		"https://agent.minimax.cn/mavis/api/v1/llm/v1/messages"), nil
}

func (a *minimaxCodeAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	key := firstNonEmpty(cred.APIKey, cred.AccessToken)
	if key == "" {
		return nil, errNoCredential("minimax-code")
	}
	headers := map[string]string{
		"Content-Type":      "application/json",
		"x-api-key":         key,
		"Authorization":     "Bearer " + key,
		"anthropic-version": "2023-06-01",
	}
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}
	return headers, nil
}

// minimaxQuotaWords are the substrings that mean "the balance is gone" rather
// than "the credential is wrong". A 403 that does not contain one of these stays a
// 403 so the refresh path still sees a real auth refusal.
var minimaxQuotaWords = []string{
	"insufficient", "balance", "credit", "quota", "exhaust", "limit",
	"余额", "积分", "额度", "不足", "用完", "上限",
}

// NormalizeError reclassifies spent-credit refusals as 429 so the caller switches
// account instead of refreshing a token that is still valid.
func (a *minimaxCodeAdapter) NormalizeError(req Request, status int, header http.Header, body []byte) (int, []byte) {
	if status != http.StatusPaymentRequired && status != http.StatusForbidden && status != http.StatusTooManyRequests {
		return status, body
	}
	if status == http.StatusTooManyRequests {
		return status, body // already the right signal
	}
	lower := strings.ToLower(string(body))
	hit := false
	for _, word := range minimaxQuotaWords {
		if strings.Contains(lower, strings.ToLower(word)) {
			hit = true
			break
		}
	}
	if !hit {
		return status, body
	}

	message := strings.TrimSpace(string(body))
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err == nil {
		for _, path := range [][2]string{
			{"error", "message"}, {"message", ""}, {"msg", ""}, {"base_resp", "status_msg"},
		} {
			if value := pickString(parsed, path[0], path[1]); value != "" {
				message = value
				break
			}
		}
	}
	payload, _ := json.Marshal(map[string]any{
		"type": "error",
		"error": map[string]any{
			"type":    "rate_limit_error",
			"message": "usage limit reached: " + message,
		},
	})
	return http.StatusTooManyRequests, payload
}

// pickString reads a string at root[key] or root[key][nested].
func pickString(root map[string]any, key, nested string) string {
	value, ok := root[key]
	if !ok {
		return ""
	}
	if nested == "" {
		return str(value)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	return str(object[nested])
}

// ---------------------------------------------------------------- registration

// RegisterWave21 installs the adapters from wave 21.
func RegisterWave21(r *Registry) {
	r.Register(&commandcodeAdapter{})
	r.Register(&minimaxCodeAdapter{})
}
