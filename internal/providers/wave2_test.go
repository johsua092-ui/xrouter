package providers

import (
	"encoding/json"
	"testing"
	"time"
)

// ── grok-cli ──────────────────────────────────────────────────────────────────

func TestGrokEndpointDefaultsToResponsesRoot(t *testing.T) {
	g := NewGrokCli()
	got, err := g.Endpoint(Request{}, Credential{})
	if err != nil {
		t.Fatal(err)
	}
	if want := "https://cli-chat-proxy.grok.com/v1/responses"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestGrokEndpointHonoursConnectionOverride(t *testing.T) {
	g := NewGrokCli()
	got, _ := g.Endpoint(Request{}, Credential{BaseURL: "https://proxy.internal/v1/responses/"})
	if want := "https://proxy.internal/v1/responses"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

// The CLI fingerprint is how upstream decides this is the official client. If any
// of these headers go missing the request stops looking like grok-shell.
func TestGrokFingerprintHeaders(t *testing.T) {
	g := NewGrokCli()
	h, err := g.Headers(Request{Body: []byte(`{"input":[{"role":"user","content":"hi"}]}`)}, Credential{
		AccessToken: "oat-1",
		Extra:       map[string]string{"sessionId": "sess-abc"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := h["x-grok-client-identifier"]; got != "grok-shell" {
		t.Fatalf("identifier %q", got)
	}
	if got := h["x-grok-client-version"]; got != GrokCliVersion {
		t.Fatalf("version %q", got)
	}
	if got := h["User-Agent"]; got != GrokCliUserAgent {
		t.Fatalf("ua %q", got)
	}
	if got := h["Authorization"]; got != "Bearer oat-1" {
		t.Fatalf("auth %q", got)
	}
	// conv and session share an id on chat turns
	if h["x-grok-session-id"] != "sess-abc" || h["x-grok-conv-id"] != "sess-abc" {
		t.Fatalf("session/conv mismatch: %q %q", h["x-grok-session-id"], h["x-grok-conv-id"])
	}
	if h["x-grok-req-id"] == "" {
		t.Fatal("req id must be generated")
	}
	if got := h["x-grok-turn-idx"]; got != "1" {
		t.Fatalf("turn idx %q", got)
	}
}

func TestGrokTurnIdxCountsUserMessages(t *testing.T) {
	g := NewGrokCli()
	body := []byte(`{"input":[
		{"role":"user","type":"message","content":"a"},
		{"role":"assistant","content":"b"},
		{"role":"user","content":"c"}
	]}`)
	if got := g.ResolveTurnIdx("s", body); got != 2 {
		t.Fatalf("got %d want 2", got)
	}
}

// A turn index must never regress for the same session: the backend rejects a
// backwards turn.
func TestGrokTurnIdxMonotonicPerSession(t *testing.T) {
	g := NewGrokCli()
	one := []byte(`{"input":[{"role":"user","content":"a"}]}`)
	two := []byte(`{"input":[{"role":"user","content":"a"},{"role":"user","content":"b"}]}`)

	if got := g.ResolveTurnIdx("sess", one); got != 1 {
		t.Fatalf("first turn %d", got)
	}
	if got := g.ResolveTurnIdx("sess", two); got != 2 {
		t.Fatalf("second turn %d", got)
	}
	// a delta-style request with only one user message must still advance
	if got := g.ResolveTurnIdx("sess", one); got != 3 {
		t.Fatalf("delta should advance to 3, got %d", got)
	}
}

func TestGrokTurnIdxMalformedBodyIsOne(t *testing.T) {
	g := NewGrokCli()
	if got := g.ResolveTurnIdx("", []byte(`not json`)); got != 1 {
		t.Fatalf("got %d want 1", got)
	}
	if got := g.ResolveTurnIdx("", nil); got != 1 {
		t.Fatalf("got %d want 1", got)
	}
}

func TestGrokTurnStoreRespectsTTL(t *testing.T) {
	g := NewGrokCli()
	g.SessionTTL = time.Nanosecond
	g.ResolveTurnIdx("s", []byte(`{"input":[{"role":"user","content":"a"}]}`))
	time.Sleep(2 * time.Millisecond)
	// expired entry must not push the counter forward
	if got := g.ResolveTurnIdx("s", []byte(`{"input":[{"role":"user","content":"a"}]}`)); got != 1 {
		t.Fatalf("expired session should restart at 1, got %d", got)
	}
}

func TestGrokTurnStoreEvictsAtCap(t *testing.T) {
	g := NewGrokCli()
	g.MaxStoreSize = 3
	for _, s := range []string{"a", "b", "c", "d"} {
		g.ResolveTurnIdx(s, []byte(`{"input":[{"role":"user","content":"x"}]}`))
	}
	if n := g.TurnStoreSize(); n > 3 {
		t.Fatalf("store grew past cap: %d", n)
	}
}

func TestGrokEffortVocabulary(t *testing.T) {
	cases := map[string]string{
		"max": "xhigh", "XHIGH": "xhigh", "low": "low",
		"medium": "medium", "high": "high", "": "high", "bogus": "high",
	}
	for in, want := range cases {
		if got := NormalizeEffort(in); got != want {
			t.Fatalf("NormalizeEffort(%q) = %q want %q", in, got, want)
		}
	}
}

func TestGrokEffortSuffixFromModel(t *testing.T) {
	if got := ResolveEffortFromModel("grok-4.5-high"); got != "high" {
		t.Fatalf("got %q", got)
	}
	if got := ResolveEffortFromModel("grok-4.5"); got != "" {
		t.Fatalf("got %q want empty", got)
	}
	if got := stripEffortSuffix("grok-4.5-medium"); got != "grok-4.5" {
		t.Fatalf("got %q", got)
	}
}

// Only the 4.5/4.6/4.7 families accept an effort; build and Composer reject it.
func TestGrokSupportsReasoningEffort(t *testing.T) {
	yes := []string{"grok-4.5", "grok-4.5-high", "grok-4.6", "grok-4.7"}
	no := []string{"grok-build", "grok-4.4", "composer-2", "grok-4.50"}
	for _, m := range yes {
		if !SupportsReasoningEffort(m) {
			t.Fatalf("%s should support effort", m)
		}
	}
	for _, m := range no {
		if SupportsReasoningEffort(m) {
			t.Fatalf("%s should not support effort", m)
		}
	}
}

func TestGrokBodyForcesStreamAndStoreFalse(t *testing.T) {
	raw := map[string]interface{}{
		"model":      "grok-4.5-high",
		"input":      []interface{}{map[string]interface{}{"role": "user", "content": "hi"}},
		"messages":   []interface{}{map[string]interface{}{"role": "user"}},
		"max_tokens": 100,
	}
	out, err := NormalizeGrokBody(raw, "high")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["stream"] != true {
		t.Fatal("stream must be forced true")
	}
	if got["store"] != false {
		t.Fatal("store must be forced false")
	}
	if got["model"] != "grok-4.5" {
		t.Fatalf("model %v should have the effort suffix stripped", got["model"])
	}
	for _, k := range []string{"messages", "max_tokens"} {
		if _, present := got[k]; present {
			t.Fatalf("%s must be dropped", k)
		}
	}
	reasoning, _ := got["reasoning"].(map[string]interface{})
	if reasoning["effort"] != "high" {
		t.Fatalf("reasoning effort %v", reasoning["effort"])
	}
	if reasoning["summary"] != "concise" {
		t.Fatalf("reasoning summary %v", reasoning["summary"])
	}
}

// Anything outside the allowlist must be gone — upstream rejects extras.
func TestGrokBodyAllowlistStripsUnknownFields(t *testing.T) {
	raw := map[string]interface{}{
		"model":       "grok-4.5",
		"input":       []interface{}{},
		"bogus_field": "drop me",
		"seed":        7,
		"logit_bias":  map[string]interface{}{},
		"temperature": 0.5,
	}
	out, _ := NormalizeGrokBody(raw, "")
	var got map[string]interface{}
	json.Unmarshal(out, &got)
	for _, k := range []string{"bogus_field", "seed", "logit_bias"} {
		if _, present := got[k]; present {
			t.Fatalf("%s must be stripped", k)
		}
	}
	if got["temperature"] != 0.5 {
		t.Fatalf("allowlisted field temperature was dropped: %v", got["temperature"])
	}
}

func TestGrokIncludeEncryptedReasoning(t *testing.T) {
	raw := map[string]interface{}{
		"model": "grok-4.5",
		"input": []interface{}{},
	}
	out, _ := NormalizeGrokBody(raw, "high")
	var got map[string]interface{}
	json.Unmarshal(out, &got)
	inc, _ := got["include"].([]interface{})
	found := false
	for _, v := range inc {
		if v == "reasoning.encrypted_content" {
			found = true
		}
	}
	if !found {
		t.Fatalf("encrypted reasoning include missing: %v", got["include"])
	}
}

func TestGrokToolsFlattenNestedFunction(t *testing.T) {
	raw := map[string]interface{}{
		"model": "grok-4.5",
		"input": []interface{}{},
		"tools": []interface{}{
			map[string]interface{}{
				"type": "function",
				"function": map[string]interface{}{
					"name":        "read_file",
					"description": "reads",
					"parameters":  map[string]interface{}{"type": "object"},
				},
			},
		},
	}
	out, _ := NormalizeGrokBody(raw, "")
	var got map[string]interface{}
	json.Unmarshal(out, &got)
	tools, _ := got["tools"].([]interface{})
	if len(tools) != 1 {
		t.Fatalf("expected one tool, got %v", got["tools"])
	}
	tool := tools[0].(map[string]interface{})
	if tool["name"] != "read_file" {
		t.Fatalf("nested function was not flattened: %v", tool)
	}
	if _, nested := tool["function"]; nested {
		t.Fatal("the nested function key must be gone after flattening")
	}
}

func TestGrokHostedToolsPassThrough(t *testing.T) {
	raw := map[string]interface{}{
		"model": "grok-4.5",
		"input": []interface{}{},
		"tools": []interface{}{
			map[string]interface{}{"type": "web_search"},
			map[string]interface{}{"type": "x_search"},
		},
	}
	out, _ := NormalizeGrokBody(raw, "")
	var got map[string]interface{}
	json.Unmarshal(out, &got)
	tools, _ := got["tools"].([]interface{})
	if len(tools) != 2 {
		t.Fatalf("hosted tools must survive, got %v", got["tools"])
	}
}

func TestGrokEmptyToolsAreDeleted(t *testing.T) {
	raw := map[string]interface{}{
		"model":       "grok-4.5",
		"input":       []interface{}{},
		"tools":       []interface{}{},
		"tool_choice": "auto",
	}
	out, _ := NormalizeGrokBody(raw, "")
	var got map[string]interface{}
	json.Unmarshal(out, &got)
	if _, present := got["tools"]; present {
		t.Fatal("empty tools must be removed")
	}
	if _, present := got["tool_choice"]; present {
		t.Fatal("tool_choice must be removed with the tools")
	}
}

func TestGrokToolChoiceDroppedWhenNameUnknown(t *testing.T) {
	raw := map[string]interface{}{
		"model": "grok-4.5",
		"input": []interface{}{},
		"tools": []interface{}{
			map[string]interface{}{"type": "function", "name": "known"},
		},
		"tool_choice": map[string]interface{}{"type": "function", "name": "unknown"},
	}
	out, _ := NormalizeGrokBody(raw, "")
	var got map[string]interface{}
	json.Unmarshal(out, &got)
	if _, present := got["tool_choice"]; present {
		t.Fatal("a tool_choice naming no surviving tool must be dropped")
	}
}

// ── qoder ─────────────────────────────────────────────────────────────────────

func TestQoderEndpointContract(t *testing.T) {
	q := NewQoder("intl")
	got, err := q.Endpoint(Request{}, Credential{})
	if err != nil {
		t.Fatal(err)
	}
	want := "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation" +
		"?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestQoderRegionSelectsBase(t *testing.T) {
	cn := NewQoder("cn")
	if cn.Name() != "qoder-cn" {
		t.Fatalf("name %q", cn.Name())
	}
	got, _ := cn.Endpoint(Request{}, Credential{})
	if want := "https://api-qoder.qoder.com" + QoderChatSigPath; len(got) < len(want) || got[:len(want)] != want {
		t.Fatalf("got %q want prefix %q", got, want)
	}
	// an unknown region must fall back to intl rather than invent one
	if r := NewQoder("mars"); r.Region != "intl" {
		t.Fatalf("region %q", r.Region)
	}
}

func TestQoderCustomAgentID(t *testing.T) {
	q := NewQoder("intl")
	got, _ := q.Endpoint(Request{}, Credential{Extra: map[string]string{"agentId": "agent_x"}})
	if !containsStr([]string{got}, "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_x&Encode=1") {
		t.Fatalf("agent id not substituted: %q", got)
	}
}

// Without a userId the COSY signature is impossible, so the adapter refuses
// rather than sending an unsigned request that upstream would reject.
func TestQoderRequiresUserID(t *testing.T) {
	q := NewQoder("intl")
	if _, err := q.Headers(Request{}, Credential{AccessToken: "tok"}); err == nil {
		t.Fatal("expected an error when userId is missing")
	}
}

func TestQoderRequiresToken(t *testing.T) {
	q := NewQoder("intl")
	_, err := q.Headers(Request{}, Credential{Extra: map[string]string{"userId": "u1"}})
	if err == nil {
		t.Fatal("expected an error when the credential has no token")
	}
	if err.Error() != "qoder credential has no token; reconnect the account" {
		t.Fatalf("message %q", err.Error())
	}
}

func TestQoderHeadersWithUserID(t *testing.T) {
	q := NewQoder("intl")
	h, err := q.Headers(Request{Stream: true}, Credential{
		AccessToken: "dt-1",
		Extra:       map[string]string{"userId": "u1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if h["Authorization"] != "Bearer dt-1" {
		t.Fatalf("auth %q", h["Authorization"])
	}
	if h["Accept"] != "text/event-stream" {
		t.Fatalf("stream must advertise SSE, got %q", h["Accept"])
	}
}

// ── antigravity ───────────────────────────────────────────────────────────────

func TestAntigravityStreamingURL(t *testing.T) {
	a := NewAntigravity()
	got, err := a.Endpoint(Request{Stream: true, Model: "gemini-3.8-flash"}, Credential{})
	if err != nil {
		t.Fatal(err)
	}
	want := AntigravityDefaultBase + "/v1internal:streamGenerateContent?alt=sse"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestAntigravityNonStreamingURL(t *testing.T) {
	a := NewAntigravity()
	got, _ := a.Endpoint(Request{Stream: false, Model: "gemini-3.8-flash"}, Credential{})
	if want := AntigravityDefaultBase + "/v1internal:generateContent"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

// Image models must use the unary action even when the client asked to stream.
func TestAntigravityImageModelForcesUnary(t *testing.T) {
	a := NewAntigravity()
	got, _ := a.Endpoint(Request{Stream: true, Model: "gemini-3.0-nano-banana-16x9"}, Credential{})
	if want := AntigravityDefaultBase + "/v1internal:generateContent"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestAntigravityBaseURLRotation(t *testing.T) {
	a := NewAntigravity()
	got, _ := a.Endpoint(Request{}, Credential{Extra: map[string]string{"urlIndex": "2"}})
	if want := AntigravityIDEBases[2] + "/v1internal:generateContent"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	// out of range falls back to the first base
	got2, _ := a.Endpoint(Request{}, Credential{Extra: map[string]string{"urlIndex": "99"}})
	if want := AntigravityIDEBases[0] + "/v1internal:generateContent"; got2 != want {
		t.Fatalf("got %q want %q", got2, want)
	}
}

func TestAntigravityIdentityHeaders(t *testing.T) {
	a := NewAntigravity()
	h, err := a.Headers(Request{}, Credential{AccessToken: "ya29.tok"})
	if err != nil {
		t.Fatal(err)
	}
	if h["Authorization"] != "Bearer ya29.tok" {
		t.Fatalf("auth %q", h["Authorization"])
	}
	if h["User-Agent"] != AntigravityIDEUserAgent {
		t.Fatalf("ua %q", h["User-Agent"])
	}
	if AntigravityIDEUserAgent != "antigravity/hub/2.32.1 linux/x64" {
		t.Fatalf("fingerprint drifted: %q", AntigravityIDEUserAgent)
	}
}

func TestIsImageModel(t *testing.T) {
	yes := []string{"gemini-3.0-nano-banana-16x9", "gemini-image-4", "imagen-4"}
	no := []string{"gemini-3.8-flash", "gemini-4-argon-high"}
	for _, m := range yes {
		if !isImageModel(m) {
			t.Fatalf("%s should be an image model", m)
		}
	}
	for _, m := range no {
		if isImageModel(m) {
			t.Fatalf("%s should not be an image model", m)
		}
	}
}

// ── wave 3 + coverage ─────────────────────────────────────────────────────────

func TestWave3Registration(t *testing.T) {
	r := NewRegistry()
	RegisterWave3(r)
	for _, want := range []string{"codebuddy-intl", "kilocode", "iflow", "zed", "trae", "ollama-local"} {
		a, explicit := r.Resolve(want)
		if !explicit {
			t.Fatalf("%s should be explicitly registered", want)
		}
		if a.Name() != want {
			t.Fatalf("%s resolved to %q", want, a.Name())
		}
	}
}

func TestOllamaLocalIsNoAuth(t *testing.T) {
	q := Quirk{Provider: "ollama-local", BaseURL: "http://127.0.0.1:11434/v1", NoAuth: true}
	h, _ := q.AsAdapter().Headers(Request{}, Credential{APIKey: "ignored"})
	if _, present := h["Authorization"]; present {
		t.Fatal("ollama-local must not send an Authorization header")
	}
}

func TestCoverageReportsPorts(t *testing.T) {
	r := NewRegistry()
	providers := []Adapter{NewGrokCli(), NewQoder("intl"), NewAntigravity()}
	for _, a := range providers {
		r.Register(a)
	}
	RegisterWave3(r)
	cov := BuildCoverage(r)
	if cov.NodeExecutorTotal != 37 {
		t.Fatalf("total %d", cov.NodeExecutorTotal)
	}
	if len(cov.Ported) != 19 {
		t.Fatalf("expected 19 registered providers, got %d: %v", len(cov.Ported), cov.Ported)
	}
	if len(cov.Generic) < 20 {
		t.Fatalf("expected the generic table, got %d", len(cov.Generic))
	}
}

func TestUUIDShapeMatchesGrokNativePattern(t *testing.T) {
	u := newUUIDv4()
	if len(u) != 36 || !isUUIDShape(u) {
		t.Fatalf("generated id is not uuid shaped: %q", u)
	}
	if isUUIDShape("not-a-uuid") {
		t.Fatal("a non-uuid must not validate")
	}
}
