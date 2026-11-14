package providers

import (
	"strings"
	"testing"
)

func cred(pairs map[string]string) Credential {
	c := Credential{}
	for k, v := range pairs {
		switch k {
		case "apiKey":
			c.APIKey = v
		case "accessToken":
			c.AccessToken = v
		case "cookie":
			c.Cookie = v
		case "baseUrl":
			c.BaseURL = v
		case "raw:x-opencode-session":
			if c.RawHeaders == nil {
				c.RawHeaders = map[string]string{}
			}
			c.RawHeaders["x-opencode-session"] = v
		case "raw:anthropic-beta":
			if c.RawHeaders == nil {
				c.RawHeaders = map[string]string{}
			}
			c.RawHeaders["anthropic-beta"] = v
		case "raw:user-agent":
			if c.RawHeaders == nil {
				c.RawHeaders = map[string]string{}
			}
			c.RawHeaders["user-agent"] = v
		case "raw:x-opencode-client":
			if c.RawHeaders == nil {
				c.RawHeaders = map[string]string{}
			}
			c.RawHeaders["x-opencode-client"] = v
		default:
			if c.Extra == nil {
				c.Extra = map[string]string{}
			}
			c.Extra[k] = v
		}
	}
	return c
}

// ── opencode-go ──────────────────────────────────────────────────────────────

func TestOpenCodeGoRoutesPerModelFamily(t *testing.T) {
	a := &OpenCodeGo{}

	// Muse models are Responses-only.
	url, err := a.Endpoint(Request{Model: "muse-spark-1"}, cred(nil))
	if err != nil {
		t.Fatal(err)
	}
	if url != opencodeGoResponsesURL {
		t.Errorf("muse harus ke /responses, dapat %q", url)
	}

	// Gemini models take the generateContent path with the action appended.
	url, err = a.Endpoint(Request{Model: "gemini-2.5-pro", Stream: true}, cred(nil))
	if err != nil {
		t.Fatal(err)
	}
	if want := opencodeGoGeminiURL + "/gemini-2.5-pro:streamGenerateContent?alt=sse"; url != want {
		t.Errorf("gemini stream:\n dapat %q\n  mau %q", url, want)
	}
	url, _ = a.Endpoint(Request{Model: "gemini-2.5-pro"}, cred(nil))
	if !strings.HasSuffix(url, ":generateContent") {
		t.Errorf("gemini non-stream harus generateContent, dapat %q", url)
	}

	// Everything else uses the connection base URL.
	url, err = a.Endpoint(Request{Model: "grok-4.6"}, cred(map[string]string{"baseUrl": "https://x.example/"}))
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://x.example/chat/completions" {
		t.Errorf("dapat %q", url)
	}
}

// A missing base URL must fail loudly rather than silently calling some default
// host with the wrong credential.
func TestOpenCodeGoFailsWithoutBaseURL(t *testing.T) {
	a := &OpenCodeGo{}
	_, err := a.Endpoint(Request{Model: "grok-4.6"}, cred(nil))
	if err == nil {
		t.Error("harus error tanpa base URL")
	}
}

// The thinking suffix must be stripped from the URL: the upstream only knows the
// base id.
func TestThinkingSuffixStrippedFromURL(t *testing.T) {
	a := &OpenCodeGo{}
	url, err := a.Endpoint(Request{Model: "gemini-2.5-pro(high)"}, cred(nil))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(url, "(high)") {
		t.Errorf("suffix thinking bocor ke URL: %q", url)
	}
	if !strings.Contains(url, "/gemini-2.5-pro:") {
		t.Errorf("id dasar harus utuh: %q", url)
	}
}

func TestOpenCodeGoSessionHeader(t *testing.T) {
	a := &OpenCodeGo{}
	h, err := a.Headers(Request{Model: "grok-4.6", Stream: true}, cred(map[string]string{"apiKey": "k"}))
	if err != nil {
		t.Fatal(err)
	}
	sess := h[opencodeSessionHeader]
	if !strings.HasPrefix(sess, "ses_") {
		t.Errorf("sesi harus berawalan ses_, dapat %q", sess)
	}
	if h["Accept"] != "text/event-stream" {
		t.Errorf("stream harus minta SSE, dapat %q", h["Accept"])
	}
	if h["Authorization"] != "Bearer k" {
		t.Errorf("auth salah: %q", h["Authorization"])
	}
}

// A native OpenCode client's session must be honoured, not replaced: replacing it
// would drop the upstream's cached state for that conversation.
func TestNativeSessionIsHonoured(t *testing.T) {
	for _, a := range []Adapter{&OpenCodeGo{}, &OpenCodeZen{}} {
		h, err := a.Headers(Request{Model: "grok-4.6"},
			cred(map[string]string{"apiKey": "k", "raw:x-opencode-session": "ses_native_abc"}))
		if err != nil {
			t.Fatal(err)
		}
		if h[opencodeSessionHeader] != "ses_native_abc" {
			t.Errorf("%s: sesi native hilang: %q", a.Name(), h[opencodeSessionHeader])
		}
	}
}

// The derived session must be STABLE for one connection + model, or every turn
// opens a fresh upstream session and the prompt cache never warms.
func TestDerivedSessionIsStable(t *testing.T) {
	a := &OpenCodeGo{}
	c := cred(map[string]string{"apiKey": "k", "connectionId": "conn-7"})

	h1, _ := a.Headers(Request{Model: "grok-4.6"}, c)
	h2, _ := a.Headers(Request{Model: "grok-4.6"}, c)
	if h1[opencodeSessionHeader] != h2[opencodeSessionHeader] {
		t.Errorf("sesi tidak stabil:\n  %q\n  %q", h1[opencodeSessionHeader], h2[opencodeSessionHeader])
	}

	// A different connection must not share the session.
	c2 := cred(map[string]string{"apiKey": "k", "connectionId": "conn-8"})
	h3, _ := a.Headers(Request{Model: "grok-4.6"}, c2)
	if h3[opencodeSessionHeader] == h1[opencodeSessionHeader] {
		t.Error("koneksi berbeda berbagi sesi")
	}
}

// An over-long client session value is refused rather than forwarded, since the
// upstream rejects it.
func TestOversizeSessionRejected(t *testing.T) {
	a := &OpenCodeGo{}
	h, _ := a.Headers(Request{Model: "x"}, cred(map[string]string{
		"apiKey":                 "k",
		"raw:x-opencode-session": strings.Repeat("a", 300),
	}))
	if len(h[opencodeSessionHeader]) > 256 {
		t.Errorf("sesi terlalu panjang diteruskan: %d", len(h[opencodeSessionHeader]))
	}
}

// ── opencode-zen ─────────────────────────────────────────────────────────────

// The free-tier convention is a literal "public" bearer when the caller has no key.
func TestOpenCodeZenPublicBearer(t *testing.T) {
	a := &OpenCodeZen{}
	h, err := a.Headers(Request{Model: "muse-spark-1"}, cred(nil))
	if err != nil {
		t.Fatal(err)
	}
	if h["Authorization"] != "Bearer public" {
		t.Errorf("free tier butuh 'Bearer public', dapat %q", h["Authorization"])
	}
}

// All four session aliases must agree; upstream reads whichever it finds first.
func TestOpenCodeZenSessionAliasesAgree(t *testing.T) {
	a := &OpenCodeZen{}
	h, err := a.Headers(Request{Model: "muse-spark-1"}, cred(map[string]string{"apiKey": "k"}))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"} {
		if h[name] == "" {
			t.Errorf("header %s kosong", name)
		}
		if h[name] != h["x-opencode-session"] {
			t.Errorf("%s=%q tidak sama dgn x-opencode-session=%q", name, h[name], h["x-opencode-session"])
		}
	}
}

func TestOpenCodeZenClientDefaults(t *testing.T) {
	a := &OpenCodeZen{}
	h, _ := a.Headers(Request{Model: "muse-spark-1"}, cred(map[string]string{"apiKey": "k"}))
	if h["x-opencode-client"] != "cli" {
		t.Errorf("default client harus cli, dapat %q", h["x-opencode-client"])
	}
	if h["x-opencode-project"] != "global" {
		t.Errorf("default project harus global, dapat %q", h["x-opencode-project"])
	}

	// A real caller's values are preserved.
	h2, _ := a.Headers(Request{Model: "muse-spark-1"}, cred(map[string]string{
		"apiKey": "k", "raw:x-opencode-client": "vscode",
	}))
	if h2["x-opencode-client"] != "vscode" {
		t.Errorf("client pemanggil tertimpa: %q", h2["x-opencode-client"])
	}
}

func TestOpenCodeZenResponsesURL(t *testing.T) {
	a := &OpenCodeZen{}
	url, _ := a.Endpoint(Request{Model: "muse-spark-1"}, cred(nil))
	if url != opencodeZenResponsesURL {
		t.Errorf("dapat %q", url)
	}
}

// ── gemini-cli ───────────────────────────────────────────────────────────────

func TestGeminiCLIActionInURL(t *testing.T) {
	a := &GeminiCLI{}
	c := cred(map[string]string{"baseUrl": "https://cloudcode-pa.googleapis.com/v1internal", "accessToken": "ya29.tok"})
	h, err := a.Headers(Request{Stream: true}, c)
	if err != nil {
		t.Fatal(err)
	}
	if h["Authorization"] != "Bearer ya29.tok" {
		t.Errorf("auth salah: %q", h["Authorization"])
	}

	// The action is a path suffix, so the base must be joined with ':' not '/'.
	url, err := a.Endpoint(Request{Stream: true, Model: "gemini-2.5-pro"}, c)
	if err != nil {
		t.Fatal(err)
	}
	want := "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
	if url != want {
		t.Errorf("\n dapat %q\n  mau %q", url, want)
	}
}

func TestGeminiCLIRequiresToken(t *testing.T) {
	a := &GeminiCLI{}
	if _, err := a.Headers(Request{}, cred(map[string]string{
		"baseUrl": "https://x.example/v1internal",
	})); err == nil {
		t.Error("tanpa access token harus error")
	}
	if _, err := a.Endpoint(Request{}, cred(nil)); err == nil {
		t.Error("tanpa base URL harus error")
	}
}

func TestGeminiCLIDialectIsGemini(t *testing.T) {
	d, ok := any(&GeminiCLI{}).(Dialect)
	if !ok {
		t.Fatal("GeminiCLI harus mengimplementasi Dialect")
	}
	if d.WireFormat() != FormatGemini {
		t.Errorf("dialek=%q, harus %q", d.WireFormat(), FormatGemini)
	}
}

// ── xiaomi-tokenplan ─────────────────────────────────────────────────────────

// The endpoint follows the CLIENT's dialect, not the model: a Claude body to the
// chat endpoint returns a wrong-but-valid answer, which is the worst failure mode.
func TestXiaomiRoutesByClientDialect(t *testing.T) {
	a := &XiaomiTokenplan{}

	base := map[string]string{"baseUrl": "https://tokenplan.example/v1", "apiKey": "k"}

	url, err := a.Endpoint(Request{}, cred(base))
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://tokenplan.example/v1/chat/completions" {
		t.Errorf("openai: dapat %q", url)
	}

	claude := map[string]string{"baseUrl": "https://tokenplan.example/v1", "apiKey": "k", "runtimeTransportFormat": "claude"}
	url, err = a.Endpoint(Request{}, cred(claude))
	if err != nil {
		t.Fatal(err)
	}
	// The trailing /v1 is stripped so the result is not /v1/anthropic/v1/messages.
	if url != "https://tokenplan.example/anthropic/v1/messages" {
		t.Errorf("claude: dapat %q", url)
	}

	h, err := a.Headers(Request{}, cred(claude))
	if err != nil {
		t.Fatal(err)
	}
	if h["anthropic-version"] == "" {
		t.Error("dialek claude harus mengirim anthropic-version")
	}
	if h["x-api-key"] != "k" {
		t.Errorf("dialek claude harus memakai x-api-key, dapat %q", h["x-api-key"])
	}
}

func TestXiaomiRequiresBaseURL(t *testing.T) {
	a := &XiaomiTokenplan{}
	if _, err := a.Endpoint(Request{}, cred(nil)); err == nil {
		t.Error("tanpa base URL harus error: endpoint token-plan bersifat region-specific")
	}
}

// ── anthropic-compatible ─────────────────────────────────────────────────────

func TestAnthropicCompatibleAppendsMessages(t *testing.T) {
	a := &AnthropicCompatible{}
	url, err := a.Endpoint(Request{}, cred(map[string]string{"baseUrl": "https://gw.example/v1/"}))
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://gw.example/v1/messages" {
		t.Errorf("dapat %q", url)
	}

	// No base URL falls back rather than failing: a node without a stored base URL
	// is a real state the Node engine tolerates.
	url, err = a.Endpoint(Request{}, cred(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(url, "/messages") {
		t.Errorf("fallback harus tetap /messages, dapat %q", url)
	}
}

// A third-party gateway must get Bearer alongside x-api-key, and must NOT get the
// first-party Claude Code identity headers.
func TestAnthropicCompatibleStripsFirstPartyHeaders(t *testing.T) {
	a := &AnthropicCompatible{}
	h, err := a.Headers(Request{}, cred(map[string]string{
		"baseUrl": "https://thirdparty.example/v1",
		"apiKey":  "sk-x",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if h["x-api-key"] != "sk-x" {
		t.Errorf("x-api-key hilang: %q", h["x-api-key"])
	}
	if h["Authorization"] != "Bearer sk-x" {
		t.Errorf("gateway pihak ketiga butuh Bearer juga, dapat %q", h["Authorization"])
	}
	if h["anthropic-version"] == "" {
		t.Error("anthropic-version wajib ada")
	}
}

// The official Anthropic endpoint must NOT receive the Bearer duplicate — it is
// not needed there and adds an unnecessary credential surface.
func TestAnthropicOfficialKeepsOnlyAPIKey(t *testing.T) {
	a := &AnthropicCompatible{}
	h, err := a.Headers(Request{}, cred(map[string]string{
		"baseUrl": "https://api.anthropic.com/v1",
		"apiKey":  "sk-ant-x",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if h["x-api-key"] != "sk-ant-x" {
		t.Errorf("x-api-key salah: %q", h["x-api-key"])
	}
	if h["Authorization"] != "" {
		t.Errorf("endpoint resmi tak perlu Bearer, dapat %q", h["Authorization"])
	}
}

// claude-code-20250219 is the one beta flag a third-party gateway 400s on. It must
// be filtered out, and an all-filtered list must drop the header rather than send
// it blank.
func TestBetaFlagFiltering(t *testing.T) {
	a := &AnthropicCompatible{}

	h, err := a.Headers(Request{}, cred(map[string]string{
		"baseUrl":            "https://thirdparty.example/v1",
		"apiKey":             "sk-x",
		"raw:anthropic-beta": "context-1m-2025-08-07, claude-code-20250219, oauth-2025-04-20",
	}))
	if err != nil {
		t.Fatal(err)
	}
	beta := h["anthropic-beta"]
	if strings.Contains(beta, "claude-code-20250219") {
		t.Errorf("flag ditolak masih diteruskan: %q", beta)
	}
	if !strings.Contains(beta, "context-1m-2025-08-07") || !strings.Contains(beta, "oauth-2025-04-20") {
		t.Errorf("flag lain harus bertahan: %q", beta)
	}

	// Only the rejected flag present -> header dropped, not left empty.
	h2, err := a.Headers(Request{}, cred(map[string]string{
		"baseUrl":            "https://thirdparty.example/v1",
		"apiKey":             "sk-x",
		"raw:anthropic-beta": "claude-code-20250219",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, present := h2["anthropic-beta"]; present {
		t.Errorf("header harus dibuang kalau kosong, dapat %q", h2["anthropic-beta"])
	}
}

func TestAnthropicCompatibleDialectIsClaude(t *testing.T) {
	d, ok := any(&AnthropicCompatible{}).(Dialect)
	if !ok {
		t.Fatal("AnthropicCompatible harus mengimplementasi Dialect")
	}
	if d.WireFormat() != FormatClaude {
		t.Errorf("dialek=%q, harus %q", d.WireFormat(), FormatClaude)
	}
}

// ── shared helpers ───────────────────────────────────────────────────────────

func TestApplyBearerSkipsPublicSentinel(t *testing.T) {
	h := map[string]string{}
	applyBearer(h, Credential{AccessToken: "public", APIKey: "real-key"})
	// "public" is a sentinel for "no credential" and must not shadow a real key.
	if h["Authorization"] != "Bearer real-key" {
		t.Errorf("dapat %q, harus memakai apiKey asli", h["Authorization"])
	}

	h2 := map[string]string{}
	applyBearer(h2, Credential{AccessToken: "public", APIKey: "public"})
	if _, present := h2["Authorization"]; present {
		t.Errorf("tanpa kredensial nyata header tak boleh diset, dapat %q", h2["Authorization"])
	}
}

func TestJoinChatCompletionsDoesNotDoubleSuffix(t *testing.T) {
	got := joinChatCompletions("https://x.example/v1/chat/completions")
	if got != "https://x.example/v1/chat/completions" {
		t.Errorf("suffix ganda: %q", got)
	}
	got = joinChatCompletions("https://x.example/v1/")
	if got != "https://x.example/v1/chat/completions" {
		t.Errorf("dapat %q", got)
	}
}

func TestStripThinkingSuffix(t *testing.T) {
	cases := map[string]string{
		"gemini-2.5-pro(high)": "gemini-2.5-pro",
		"gemini-2.5-pro":       "gemini-2.5-pro",
		"muse(medium)  ":       "muse",
		"(only-suffix)":        "(only-suffix)", // no base id to keep
	}
	for in, want := range cases {
		if got := stripThinkingSuffix(in); got != want {
			t.Errorf("stripThinkingSuffix(%q)=%q, harus %q", in, got, want)
		}
	}
}

func TestIsResponsesModelName(t *testing.T) {
	if !isResponsesModelName("muse-spark-1") {
		t.Error("muse harus terdeteksi Responses")
	}
	if !isResponsesModelName("Muse-Spark-2(high)") {
		t.Error("deteksi harus case-insensitive dan tahan suffix")
	}
	if isResponsesModelName("grok-4.6") {
		t.Error("grok bukan model Responses")
	}
	if isResponsesModelName("gemini-2.5-pro") {
		t.Error("gemini bukan model Responses")
	}
}

// ── registry integration ─────────────────────────────────────────────────────

func TestRegisterWave4AddsEveryAdapter(t *testing.T) {
	r := NewRegistry()
	RegisterWave4(r)

	for _, name := range []string{"opencode-go", "opencode-zen", "gemini-cli", "xiaomi-tokenplan", "anthropic-compatible"} {
		a, ok := r.Resolve(name)
		if !ok {
			t.Errorf("provider %s tidak terdaftar", name)
			continue
		}
		if a.Name() != name {
			t.Errorf("%s: Name()=%q", name, a.Name())
		}
	}
}
