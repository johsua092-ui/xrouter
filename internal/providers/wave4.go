package providers

import (
	"errors"
	"fmt"
	"strings"

	"github.com/johsua092-ui/xrouter/internal/translate"
)

// Wave 4 — the remaining executors that only vary the URL or the headers, and
// therefore need no custom request body shaping.
//
// Each Node executor subclassed DefaultExecutor/BaseExecutor and overrode at most
// buildUrl and buildHeaders. Because the Go adapter contract already separates
// exactly those two concerns, each of these ports is a translation of one URL
// builder and one header builder — no behaviour is dropped, and nothing is
// invented.
//
// Executors with a custom execute() (adcode's Firebase token minting, the web
// cookie executors, kiro's EventStream, cursor's protobuf, codex, devin) are NOT
// covered here: those carry protocol behaviour a URL/header override cannot
// express, and a stub adapter would claim coverage it does not have.

// ── constants borrowed from the wave-1 table ─────────────────────────────────
//
// AnthropicAPIVersion already lives in openai_compat.go; it is not redeclared
// here. The compatibility fallback below is wave-4 specific because it applies to a
// dynamic `anthropic-compatible-*` node, not to a fixed provider row.

var _ = AnthropicAPIVersion

// anthropicCompatFallback is the endpoint used by an `anthropic-compatible-*`
// node whose stored credential has no base URL. Sending such a credential to the
// real Anthropic endpoint would be wrong but silent; the Node engine makes the
// same choice deliberately for the same reason.
const anthropicCompatFallback = "https://api.anthropic.com/v1"

// ── opencode-go ──────────────────────────────────────────────────────────────

// OpenCodeGo routes per model family: Muse Spark models live on the Responses
// endpoint, Gemini models on a generateContent path, everything else on the
// ordinary chat-completions URL. Getting this wrong sends a Responses-shaped body
// to a chat endpoint, which fails upstream with an opaque validation error.
type OpenCodeGo struct{}

func (a *OpenCodeGo) Name() string       { return "opencode-go" }
func (a *OpenCodeGo) WireFormat() string { return FormatOpenAI }

const (
	opencodeGoResponsesURL = "https://opencode.ai/inference/go/v1/responses"
	opencodeGoGeminiURL    = "https://opencode.ai/inference/go/v1/models"
	// opencodeSessionHeader carries the session affinity value. The upstream
	// keeps prompt state per session, so a changing value costs a cold start.
	opencodeSessionHeader = "x-opencode-session"
)

func (a *OpenCodeGo) Endpoint(req Request, cred Credential) (string, error) {
	if isGeminiModelName(req.Model) {
		return fmt.Sprintf("%s/%s:%s", opencodeGoGeminiURL, stripThinkingSuffix(req.Model), geminiAction(req.Stream)), nil
	}
	if isResponsesModelName(req.Model) {
		return opencodeGoResponsesURL, nil
	}
	if cred.BaseURL != "" {
		return joinChatCompletions(cred.BaseURL), nil
	}
	return "", errors.New("opencode-go: no base URL on either the connection or the provider config")
}

func (a *OpenCodeGo) Headers(req Request, cred Credential) (map[string]string, error) {
	h := baseJSONHeaders()
	applyBearer(h, cred)
	// The session must be derived from the same inputs as the Node engine, or a
	// conversation started under one implementation loses its upstream state when
	// it continues under the other.
	h[opencodeSessionHeader] = sessionHeaderValue("opencode-go", req, cred)
	if req.Stream {
		h["Accept"] = "text/event-stream"
	}
	return h, nil
}

// ── opencode-zen ─────────────────────────────────────────────────────────────

// OpenCodeZen is the free-tier sibling of opencode-go. It additionally publishes
// the session under three extra header names, sends a client/project identifier,
// and falls back to a literal "public" bearer for free-tier models — which is the
// provider's published convention, not a leaked credential.
type OpenCodeZen struct{}

func (a *OpenCodeZen) Name() string       { return "opencode-zen" }
func (a *OpenCodeZen) WireFormat() string { return FormatOpenAI }

const opencodeZenResponsesURL = "https://opencode.ai/inference/v1/responses"

func (a *OpenCodeZen) Endpoint(req Request, cred Credential) (string, error) {
	if isResponsesModelName(req.Model) {
		return opencodeZenResponsesURL, nil
	}
	if cred.BaseURL != "" {
		return joinChatCompletions(cred.BaseURL), nil
	}
	return "", errors.New("opencode-zen: no base URL on either the connection or the provider config")
}

func (a *OpenCodeZen) Headers(req Request, cred Credential) (map[string]string, error) {
	h := baseJSONHeaders()

	// Three session aliases plus the canonical header. Upstream reads whichever it
	// finds first, so all four must agree.
	session := sessionHeaderValue("opencode-zen", req, cred)
	h[opencodeSessionHeader] = session
	h["x-opencode-session-id"] = session
	h["x-session-affinity"] = session
	h["x-session-id"] = session

	// Downstream headers are forwarded only for these three, and each has a
	// documented default. The client identity is taken from the caller rather than
	// hardcoded so a real OpenCode CLI keeps reporting itself.
	h["x-opencode-client"] = headerFallback(cred, "x-opencode-client", "cli")
	h["x-opencode-project"] = headerFallback(cred, "x-opencode-project", "global")

	if cred.APIKey != "" {
		h["Authorization"] = "Bearer " + cred.APIKey
	} else {
		// Free-tier convention: the provider meters these models without an account.
		h["Authorization"] = "Bearer public"
	}
	if ua := headerFrom(cred, "user-agent"); ua != "" {
		h["User-Agent"] = ua
	}
	if req.Stream {
		h["Accept"] = "text/event-stream"
	}
	return h, nil
}

// ── gemini-cli ───────────────────────────────────────────────────────────────

// GeminiCLI is the Cloud Code Assist wrapper around generateContent. Two things
// make it distinct: the action is part of the URL rather than a header, and the
// request body is wrapped in {project, model, request} — which the translator
// layer produces, so this adapter only has to place it.
type GeminiCLI struct{}

func (a *GeminiCLI) Name() string       { return "gemini-cli" }
func (a *GeminiCLI) WireFormat() string { return FormatGemini }

// geminiCLIUserAgent is the client identifier Google's Code Assist expects. It is
// version-shaped on purpose: the endpoint refuses requests without a recognised
// client string.
const geminiCLIUserAgent = "GeminiCLI/1.0.0 (linux; x86_64)"

func (a *GeminiCLI) Endpoint(req Request, cred Credential) (string, error) {
	base := strings.TrimSuffix(cred.BaseURL, "/")
	if base == "" {
		return "", errors.New("gemini-cli: the connection has no base URL (Cloud Code Assist project endpoint)")
	}
	// The action is appended as a path segment on the project base, e.g.
	// https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent
	return fmt.Sprintf("%s:%s", base, geminiAction(req.Stream)), nil
}

func (a *GeminiCLI) Headers(req Request, cred Credential) (map[string]string, error) {
	h := baseJSONHeaders()
	if cred.AccessToken == "" {
		return nil, errors.New("gemini-cli: missing OAuth access token")
	}
	h["Authorization"] = "Bearer " + cred.AccessToken
	h["User-Agent"] = geminiCLIUserAgent
	h["X-Goog-Api-Client"] = GEMINI_CLI_APIClient
	if req.Stream {
		h["Accept"] = "text/event-stream"
	} else {
		h["Accept"] = "application/json"
	}
	return h, nil
}

// ── xiaomi-tokenplan ─────────────────────────────────────────────────────────

// XiaomiTokenplan routes per *source dialect*, not per model: the same key has
// both an Anthropic-shaped endpoint and a chat-completions one, and which is
// correct is decided by the format the client spoke. Sending a Claude body to the
// chat endpoint silently returns a wrong-but-valid answer, so the split matters.
type XiaomiTokenplan struct{}

func (a *XiaomiTokenplan) Name() string { return "xiaomi-tokenplan" }

// WireFormat is dynamic for this provider — it follows the client's dialect. The
// declared value is the default used when no transport hint is present;
// Endpoint re-reads the hint per request.
func (a *XiaomiTokenplan) WireFormat() string { return FormatOpenAI }

// TransportFormat returns the dialect this specific request should use.
func (a *XiaomiTokenplan) TransportFormat(cred Credential) string {
	if cred.Extra["runtimeTransportFormat"] == "claude" {
		return FormatClaude
	}
	return FormatOpenAI
}

func (a *XiaomiTokenplan) Endpoint(req Request, cred Credential) (string, error) {
	base := strings.TrimSuffix(cred.BaseURL, "/")
	if base == "" {
		return "", errors.New("xiaomi-tokenplan: the connection has no base URL (token-plan endpoints are region-specific)")
	}
	// Strip a trailing /v1 before appending the Anthropic path: the region base
	// already ends in it, and leaving it produces /v1/anthropic/v1/messages.
	root := strings.TrimSuffix(base, "/v1")
	if a.TransportFormat(cred) == FormatClaude {
		return root + "/anthropic/v1/messages", nil
	}
	return base + "/chat/completions", nil
}

func (a *XiaomiTokenplan) Headers(req Request, cred Credential) (map[string]string, error) {
	h := baseJSONHeaders()
	applyBearer(h, cred)
	if a.TransportFormat(cred) == FormatClaude {
		// An Anthropic-dialect endpoint is checked for the version header before
		// the key, so it is set here rather than left to the default.
		h["anthropic-version"] = AnthropicAPIVersion
		if cred.APIKey != "" {
			h["x-api-key"] = cred.APIKey
		}
	}
	if req.Stream {
		h["Accept"] = "text/event-stream"
	}
	return h, nil
}

// ── anthropic-compatible nodes ───────────────────────────────────────────────

// AnthropicCompatible serves `anthropic-compatible-*` dynamic nodes: a
// user-supplied base URL fronting something that speaks the Anthropic dialect.
//
// Two behaviours are load-bearing and easy to lose:
//
//  1. When the base URL is NOT api.anthropic.com, the first-party Claude Code
//     identity headers are stripped and Bearer auth is sent alongside x-api-key.
//     A third-party gateway rejects the first-party headers and often reads only
//     Bearer; forwarding them verbatim breaks the node entirely.
//  2. `claude-code-20250219` is filtered out of the beta list for those same
//     gateways, since they do not implement that beta and 400 on it.
type AnthropicCompatible struct{}

func (a *AnthropicCompatible) Name() string       { return "anthropic-compatible" }
func (a *AnthropicCompatible) WireFormat() string { return FormatClaude }

func (a *AnthropicCompatible) Endpoint(req Request, cred Credential) (string, error) {
	base := strings.TrimSuffix(cred.BaseURL, "/")
	if base == "" {
		base = anthropicCompatFallback
	}
	return base + "/messages", nil
}

func (a *AnthropicCompatible) Headers(req Request, cred Credential) (map[string]string, error) {
	h := baseJSONHeaders()

	base := strings.TrimSuffix(cred.BaseURL, "/")
	officialAnthropic := base == "" || strings.Contains(base, "api.anthropic.com")

	if cred.APIKey != "" {
		h["x-api-key"] = cred.APIKey
	} else if cred.AccessToken != "" {
		h["Authorization"] = "Bearer " + cred.AccessToken
	}
	if h["anthropic-version"] == "" {
		h["anthropic-version"] = AnthropicAPIVersion
	}

	if !officialAnthropic {
		// A gateway in front of something other than Anthropic reads either
		// header; sending both is what makes an unknown gateway work.
		if cred.APIKey != "" {
			h["Authorization"] = "Bearer " + cred.APIKey
		}
		delete(h, "anthropic-dangerous-direct-browser-access")
		delete(h, "x-app")

		// The client beta flags survive the hop, minus the one these gateways
		// reject. An empty result drops the header rather than sending a blank.
		if beta := filterClientBeta(cred, "claude-code-20250219"); beta != "" {
			h["anthropic-beta"] = beta
		}
	} else if beta := filterClientBeta(cred, ""); beta != "" {
		h["anthropic-beta"] = beta
	}

	if req.Stream {
		h["Accept"] = "text/event-stream"
	}
	return h, nil
}

// ── shared helpers ───────────────────────────────────────────────────────────

// GEMINI_CLI_APIClient identifies the Google API client. Kept as a constant
// because the endpoint validates it against a known set.
const GEMINI_CLI_APIClient = "gl-node/22.0.0"

func baseJSONHeaders() map[string]string {
	return map[string]string{"Content-Type": "application/json"}
}

// applyBearer sets the Authorization header from an access token, falling back to
// an API key. A token literally equal to "public" is skipped: Node treats that
// sentinel as "no credential" and sending "Bearer public" to a provider that
// never asked for it would replace a real key.
func applyBearer(h map[string]string, cred Credential) {
	switch {
	case cred.AccessToken != "" && cred.AccessToken != "public":
		h["Authorization"] = "Bearer " + cred.AccessToken
	case cred.APIKey != "" && cred.APIKey != "public":
		h["Authorization"] = "Bearer " + cred.APIKey
	case cred.Cookie != "":
		h["Authorization"] = "Bearer " + cred.Cookie
	}
}

// geminiAction maps the stream flag onto the generateContent action pair.
func geminiAction(stream bool) string {
	if stream {
		return "streamGenerateContent?alt=sse"
	}
	return "generateContent"
}

// isGeminiModelName matches the model families served over the Gemini path.
func isGeminiModelName(model string) bool {
	m := strings.ToLower(stripThinkingSuffix(model))
	return strings.HasPrefix(m, "gemini") || strings.Contains(m, "gemini-")
}

// isResponsesModelName matches the families served over the Responses API.
//
// Matched by suffix family rather than by an exact id list so a new model in the
// same family routes correctly without a code change — an exact list would send a
// brand-new Muse Spark id to the chat endpoint and fail upstream.
func isResponsesModelName(model string) bool {
	m := strings.ToLower(stripThinkingSuffix(model))
	return strings.Contains(m, "muse") || strings.Contains(m, "muse-spark")
}

// stripThinkingSuffix removes a trailing "(level)" qualifier. The upstream only
// recognises the base id, so a thinking suffix left in place produces a 404.
func stripThinkingSuffix(model string) string {
	m := strings.TrimSpace(model)
	if !strings.HasSuffix(m, ")") {
		return m
	}
	if open := strings.LastIndex(m, "("); open > 0 {
		return strings.TrimSpace(m[:open])
	}
	return m
}

// joinChatCompletions appends the chat path once, tolerating a base that already
// carries it. A doubled suffix is accepted by almost no upstream.
func joinChatCompletions(base string) string {
	b := strings.TrimSuffix(strings.TrimSpace(base), "/")
	if strings.HasSuffix(b, "/chat/completions") {
		return b
	}
	return b + "/chat/completions"
}

// sessionHeaderValue derives the upstream session affinity value.
//
// A client that already sent a valid x-opencode-session is believed, so a native
// OpenCode CLI keeps its own session. Otherwise the value is derived from the
// connection and the conversation anchor — never from a random value, or every
// turn of one conversation would land on a different upstream session.
func sessionHeaderValue(scope string, req Request, cred Credential) string {
	if existing := headerFrom(cred, opencodeSessionHeader); existing != "" && len(existing) <= 256 {
		return existing
	}

	anchor := cred.Extra["sessionId"]
	if anchor == "" {
		anchor = cred.Extra["connectionId"]
	}
	if anchor == "" {
		anchor = cred.APIKey
	}
	anchor += "\x00" + req.Model

	sum := sha256Hex(scope + "\x00" + headerFrom(cred, "x-opencode-client") + "\x00" + anchor)
	return "ses_" + sum[:30]
}

// filterClientBeta returns the caller's anthropic-beta list with one flag removed.
func filterClientBeta(cred Credential, drop string) string {
	raw := headerFrom(cred, "anthropic-beta")
	if raw == "" {
		return ""
	}
	kept := make([]string, 0, 4)
	for _, part := range strings.Split(raw, ",") {
		f := strings.TrimSpace(part)
		if f == "" || f == drop {
			continue
		}
		kept = append(kept, f)
	}
	return strings.Join(kept, ",")
}

// headerFrom reads a header case-insensitively from the credential's passthrough
// set. Headers arrive with whatever casing the client chose.
func headerFrom(cred Credential, name string) string {
	if v, ok := cred.RawHeaders[name]; ok {
		return v
	}
	for k, v := range cred.RawHeaders {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return ""
}

// headerFallback reads a header or returns a default.
func headerFallback(cred Credential, name, fallback string) string {
	if v := headerFrom(cred, name); v != "" {
		return v
	}
	return fallback
}

// RegisterWave4 adds the URL/header-only adapters to a registry.
func RegisterWave4(r *Registry) {
	r.Register(&OpenCodeGo{})
	r.Register(&OpenCodeZen{})
	r.Register(&GeminiCLI{})
	r.Register(&XiaomiTokenplan{})
	r.Register(&AnthropicCompatible{})
}

// RegisterWave5 adds adapters that carry a protocol behaviour beyond URL and
// headers — currently AdCode's Firebase token lifecycle.
func RegisterWave5(r *Registry) {
	r.Register(&AdCode{})
}

// ensure the dialect constants stay referenced even if a future refactor drops
// the direct uses above.
var _ = translate.FormatGemini
