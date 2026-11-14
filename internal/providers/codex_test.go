package providers

import (
	"encoding/json"
	"strings"
	"testing"
)

// The Codex transform is pure body reshaping, so every assertion here runs
// without a network round trip. The tests are written against the backend's
// documented rejections rather than against the Go code's shape: each one names
// the upstream behaviour that would break if the repair were removed.

func codexTransform(t *testing.T, model string, body string) map[string]any {
	t.Helper()
	out, err := NewCodex().TransformBody(model, []byte(body))
	if err != nil {
		t.Fatalf("TransformBody: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("output is not JSON: %v (raw=%s)", err, out)
	}
	return doc
}

func TestCodexEndpointDefault(t *testing.T) {
	url, err := NewCodex().Endpoint(Request{Body: []byte(`{"model":"gpt-5-codex"}`)}, Credential{})
	if err != nil {
		t.Fatalf("Endpoint: %v", err)
	}
	if url != CodexBaseURL {
		t.Fatalf("want %s, got %s", CodexBaseURL, url)
	}
}

// A _compact body appends /compact. The flag is read from the payload, so the
// URL changes based on content the translator never touches.
func TestCodexEndpointCompact(t *testing.T) {
	url, err := NewCodex().Endpoint(
		Request{Body: []byte(`{"model":"gpt-5-codex","_compact":true}`)}, Credential{})
	if err != nil {
		t.Fatalf("Endpoint: %v", err)
	}
	want := CodexBaseURL + CodexCompactPath
	if url != want {
		t.Fatalf("want %s, got %s", want, url)
	}
}

// A per-connection base URL overrides the hosted default.
func TestCodexEndpointBaseURLOverride(t *testing.T) {
	url, err := NewCodex().Endpoint(Request{Body: []byte(`{}`)},
		Credential{BaseURL: "https://proxy.internal/v1/responses/"})
	if err != nil {
		t.Fatalf("Endpoint: %v", err)
	}
	if url != "https://proxy.internal/v1/responses" {
		t.Fatalf("trailing slash not trimmed: %s", url)
	}
}

// The CLI fingerprint is how the backend identifies the caller.
func TestCodexHeadersFingerprint(t *testing.T) {
	h, err := NewCodex().Headers(Request{Model: "gpt-5-codex"},
		Credential{AccessToken: "tok"})
	if err != nil {
		t.Fatalf("Headers: %v", err)
	}
	for k, want := range map[string]string{
		"originator": "codex_cli_rs",
		"User-Agent": "codex_cli_rs/" + CodexCLIVersion,
		"version":    CodexCLIVersion,
		"Accept":     "text/event-stream",
	} {
		if h[k] != want {
			t.Errorf("header %s = %q, want %q", k, h[k], want)
		}
	}
	if h["Authorization"] != "Bearer tok" {
		t.Errorf("Authorization = %q", h["Authorization"])
	}
}

// An apiKey-only connection still authenticates: the Node executor prefers an
// access token but falls back to the key.
func TestCodexHeadersFallsBackToAPIKey(t *testing.T) {
	h, _ := NewCodex().Headers(Request{}, Credential{APIKey: "sk-x"})
	if h["Authorization"] != "Bearer sk-x" {
		t.Fatalf("Authorization = %q", h["Authorization"])
	}
}

// Account binding: workspaceId wins, then chatgptAccountId, then accountId. The
// header must be present exactly once with the highest-priority value, because a
// wrong binding surfaces as token_invalid rather than as a clear auth error.
func TestCodexHeadersAccountBinding(t *testing.T) {
	cases := []struct {
		name       string
		extra      map[string]string
		wantHeader string
	}{
		{"workspace wins", map[string]string{
			"workspaceId": "ws-1", "chatgptAccountId": "acc-1", "accountId": "legacy-1",
		}, "ws-1"},
		{"chatgptAccountId next", map[string]string{
			"chatgptAccountId": "acc-2", "accountId": "legacy-2",
		}, "acc-2"},
		{"accountId last", map[string]string{"accountId": "legacy-3"}, "legacy-3"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := NewCodex().Headers(Request{}, Credential{Extra: tc.extra})
			if h["ChatGPT-Account-ID"] != tc.wantHeader {
				t.Fatalf("ChatGPT-Account-ID = %q, want %q",
					h["ChatGPT-Account-ID"], tc.wantHeader)
			}
		})
	}
}

// With no account id at all the header is absent rather than empty — an empty
// string would be sent and read as a binding.
func TestCodexHeadersNoAccountBindingWhenAbsent(t *testing.T) {
	h, _ := NewCodex().Headers(Request{}, Credential{})
	if _, ok := h["ChatGPT-Account-ID"]; ok {
		t.Fatal("ChatGPT-Account-ID should be absent")
	}
}

// Session identity falls back connection → "default", never empty.
func TestCodexSessionIDFallback(t *testing.T) {
	h, _ := NewCodex().Headers(Request{}, Credential{})
	if h["session_id"] != "default" {
		t.Fatalf("session_id = %q, want default", h["session_id"])
	}
	h, _ = NewCodex().Headers(Request{}, Credential{Extra: map[string]string{"connectionId": "conn-9"}})
	if h["session_id"] != "conn-9" {
		t.Fatalf("session_id = %q, want conn-9", h["session_id"])
	}
}

// ── body repairs ─────────────────────────────────────────────────────────────

// server-generated item ids cannot be resolved with store=false, so replaying
// them 404s the whole conversation. The id is dropped, the item is kept.
func TestCodexStripsServerGeneratedItemIDs(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"input":[
			{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
			{"type":"message","role":"assistant","id":"msg_abc123","content":[{"type":"output_text","text":"yo"}]},
			{"type":"item_reference","id":"rs_deadbeef"}
		]}`)

	input, _ := doc["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("input has %d items, want 2 (item_reference dropped)", len(input))
	}
	second, _ := input[1].(map[string]any)
	if _, ok := second["id"]; ok {
		t.Fatal("msg_ id should have been stripped")
	}
}

// store=false is mandatory regardless of what the client asked for.
func TestCodexForcesStoreFalseAndStreamTrue(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{"model":"gpt-5-codex","store":true,"stream":false}`)
	if doc["store"] != false {
		t.Errorf("store = %v, want false", doc["store"])
	}
	if doc["stream"] != true {
		t.Errorf("stream = %v, want true", doc["stream"])
	}
}

// The backend rejects role=system outright; developer is the accepted spelling.
func TestCodexConvertsSystemToDeveloper(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"input":[
			{"type":"message","role":"system","content":[{"type":"input_text","text":"be terse"}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}
		]}`)
	input, _ := doc["input"].([]any)
	first, _ := input[0].(map[string]any)
	if first["role"] != "developer" {
		t.Fatalf("role = %v, want developer", first["role"])
	}
}

// These are deleted, not forwarded: the backend 400s rather than ignoring them.
func TestCodexDropsRejectedParams(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"temperature":0.7,"top_p":0.9,"max_output_tokens":500,"seed":42,
		"frequency_penalty":0.1,"presence_penalty":0.1,"n":2,
		"user":"cursor","metadata":{"a":1},"previous_response_id":"resp_1"}`)

	for _, k := range []string{
		"temperature", "top_p", "max_output_tokens", "seed", "frequency_penalty",
		"presence_penalty", "n", "user", "metadata", "previous_response_id",
	} {
		if _, ok := doc[k]; ok {
			t.Errorf("%s should have been deleted", k)
		}
	}
}

// The final allowlist sweep is what prevents "routing_unsupported": an unknown
// top-level key is fatal upstream, so it never leaves.
func TestCodexAllowlistSweepDropsUnknownKeys(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"totally_made_up":"x","another_one":123,"_compact":true}`)

	for _, k := range []string{"totally_made_up", "another_one", "_compact"} {
		if _, ok := doc[k]; ok {
			t.Errorf("%s should have been swept", k)
		}
	}
	if doc["model"] != "gpt-5-codex" {
		t.Errorf("allowlisted field was dropped: %v", doc["model"])
	}
}

// service_tier is an enum: "fast" is an alias, anything else is rejected.
func TestCodexServiceTierEnum(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{"model":"gpt-5-codex","service_tier":"fast"}`)
	if doc["service_tier"] != "priority" {
		t.Errorf("fast should map to priority, got %v", doc["service_tier"])
	}

	doc = codexTransform(t, "gpt-5-codex", `{"model":"gpt-5-codex","service_tier":"turbo_ultra"}`)
	if _, ok := doc["service_tier"]; ok {
		t.Error("an unrecognised tier should be dropped, not forwarded")
	}

	doc = codexTransform(t, "gpt-5-codex", `{"model":"gpt-5-codex","service_tier":"priority"}`)
	if doc["service_tier"] != "priority" {
		t.Error("priority should pass through")
	}
}

// ── tools ────────────────────────────────────────────────────────────────────

// A chat-style nested function tool is hoisted flat: Responses has no
// "function" wrapper.
func TestCodexHoistsNestedFunctionTool(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"tools":[{"type":"function","function":{
			"name":"get_weather","description":"look up weather",
			"parameters":{"type":"object","properties":{"city":{"type":"string"}}}
		}}]}`)

	tools, _ := doc["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %d, want 1", len(tools))
	}
	tool, _ := tools[0].(map[string]any)
	if tool["name"] != "get_weather" {
		t.Errorf("name = %v", tool["name"])
	}
	if tool["description"] != "look up weather" {
		t.Errorf("description = %v", tool["description"])
	}
	if _, nested := tool["function"]; nested {
		t.Error("the function wrapper should be gone")
	}
	if tool["type"] != "function" {
		t.Errorf("type = %v", tool["type"])
	}
}

// A function tool with no parameters 400s upstream, so an empty object schema is
// synthesised.
func TestCodexSynthesisesMissingToolParameters(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"tools":[{"type":"function","function":{"name":"ping"}}]}`)
	tools, _ := doc["tools"].([]any)
	tool, _ := tools[0].(map[string]any)
	params, ok := tool["parameters"].(map[string]any)
	if !ok {
		t.Fatal("parameters should be an object")
	}
	if params["type"] != "object" {
		t.Errorf("parameters.type = %v", params["type"])
	}
}

// `\p{...}` in a JSON-schema pattern 400s the entire request on the Codex
// validator — not just that tool — so the pattern is stripped.
func TestCodexStripsUnicodePropertyEscapePatterns(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"tools":[{"type":"function","function":{
			"name":"find","parameters":{"type":"object","properties":{
				"word":{"type":"string","pattern":"^\\p{L}+$"},
				"digits":{"type":"string","pattern":"^[0-9]+$"}
			}}
		}}]}`)

	tools, _ := doc["tools"].([]any)
	tool, _ := tools[0].(map[string]any)
	params, _ := tool["parameters"].(map[string]any)
	props, _ := params["properties"].(map[string]any)

	word, _ := props["word"].(map[string]any)
	if _, ok := word["pattern"]; ok {
		t.Error("the \\p{L} pattern should have been stripped")
	}
	// A plain pattern is fine and must survive — this is the control that proves
	// the filter is targeted rather than dropping every pattern.
	digits, _ := props["digits"].(map[string]any)
	if digits["pattern"] != "^[0-9]+$" {
		t.Errorf("a supported pattern was dropped: %v", digits["pattern"])
	}
}

// Hosted tool types are executed by the backend and must pass through intact.
func TestCodexKeepsHostedAndPassthroughTools(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"tools":[
			{"type":"web_search"},
			{"type":"local_shell"},
			{"type":"custom","name":"apply_patch","format":{"type":"grammar"}},
			{"type":"unknown_vendor_tool"}
		]}`)

	tools, _ := doc["tools"].([]any)
	kept := map[string]bool{}
	for _, raw := range tools {
		if m, ok := raw.(map[string]any); ok {
			if t2, ok := m["type"].(string); ok {
				kept[t2] = true
			}
		}
	}
	for _, want := range []string{"web_search", "local_shell", "custom"} {
		if !kept[want] {
			t.Errorf("tool type %s should have survived", want)
		}
	}
	if kept["unknown_vendor_tool"] {
		t.Error("an unknown tool type should have been dropped")
	}
}

// A tool_choice naming a tool that did not survive normalization 400s, so it is
// removed rather than sent.
func TestCodexDropsDanglingToolChoice(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"tools":[{"type":"function","function":{"name":"kept_tool","parameters":{"type":"object"}}}],
		"tool_choice":{"type":"function","name":"missing_tool"}}`)
	if _, ok := doc["tool_choice"]; ok {
		t.Error("a tool_choice naming an unknown tool should be dropped")
	}

	// Control: a choice naming a tool that DID survive stays.
	doc = codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"tools":[{"type":"function","function":{"name":"kept_tool","parameters":{"type":"object"}}}],
		"tool_choice":{"type":"function","name":"kept_tool"}}`)
	if _, ok := doc["tool_choice"]; !ok {
		t.Error("a valid tool_choice should survive")
	}
}

// ── model + reasoning ────────────────────────────────────────────────────────

// The effort suffix is read off the model id and stripped before the request is
// sent: the backend knows gpt-5-codex, not gpt-5-codex-high.
func TestCodexStripsEffortSuffixFromModel(t *testing.T) {
	cases := []struct{ in, model, effort string }{
		{"gpt-5-codex-high", "gpt-5-codex", "high"},
		{"gpt-5-codex-xhigh", "gpt-5-codex", "xhigh"},
		{"gpt-5-codex-low", "gpt-5-codex", "low"},
		{"gpt-5-codex-medium", "gpt-5-codex", "medium"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			doc := codexTransform(t, tc.in, `{"model":"`+tc.in+`"}`)
			if doc["model"] != tc.model {
				t.Errorf("model = %v, want %v", doc["model"], tc.model)
			}
			r, _ := doc["reasoning"].(map[string]any)
			if r["effort"] != tc.effort {
				t.Errorf("effort = %v, want %v", r["effort"], tc.effort)
			}
		})
	}
}

// "-xhigh" must not be consumed by the "-high" prefix, which would leave a
// stray "x" on the model name and 404 the request.
func TestCodexEffortSuffixIsNotPrefixMatched(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex-xhigh", `{"model":"gpt-5-codex-xhigh"}`)
	if doc["model"] != "gpt-5-codex" {
		t.Fatalf("model = %v — the -xhigh suffix was mis-matched", doc["model"])
	}
}

// With no suffix the family default applies.
func TestCodexDefaultEffort(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{"model":"gpt-5-codex"}`)
	r, _ := doc["reasoning"].(map[string]any)
	if r["effort"] != CodexDefaultEffort {
		t.Errorf("effort = %v, want %s", r["effort"], CodexDefaultEffort)
	}
	if r["summary"] != "auto" {
		t.Errorf("summary = %v, want auto", r["summary"])
	}
}

// UI vocabulary maps onto backend vocabulary: max/ultra both mean xhigh.
func TestCodexEffortVocabularyMapping(t *testing.T) {
	for _, in := range []string{"max", "ultra"} {
		doc := codexTransform(t, "gpt-5-codex", `{"model":"gpt-5-codex","reasoning":{"effort":"`+in+`"}}`)
		r, _ := doc["reasoning"].(map[string]any)
		if r["effort"] != "xhigh" {
			t.Errorf("%s should map to xhigh, got %v", in, r["effort"])
		}
	}
}

// A reasoning model needs the encrypted reasoning payload echoed back across
// turns, so `include` is set. With effort "none" there is nothing to echo.
func TestCodexIncludesEncryptedReasoning(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex-high", `{"model":"gpt-5-codex-high"}`)
	inc, _ := doc["include"].([]any)
	if len(inc) != 1 || inc[0] != "reasoning.encrypted_content" {
		t.Fatalf("include = %v", doc["include"])
	}

	doc = codexTransform(t, "gpt-5-codex-none", `{"model":"gpt-5-codex-none"}`)
	if _, ok := doc["include"]; ok {
		t.Error("effort none should not request encrypted reasoning")
	}
}

// Foreign encrypted reasoning (a Grok blob, say) cannot be decrypted by Codex
// and fails the turn. Only codex_-prefixed content is kept. The sweep runs on
// input, because `messages` is not on the Responses allowlist and is deleted
// before this point — a translated chat body arrives with its history already
// in input.
func TestCodexDropsAlienReasoningItems(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{
		"model":"gpt-5-codex",
		"input":[{"type":"message","role":"assistant","content":[
			{"type":"output_text","text":"keep me"},
			{"type":"reasoning","encrypted_content":"grok_blob_xyz"},
			{"type":"reasoning","encrypted_content":"codex_real_blob"}
		]}]}`)

	input, _ := doc["input"].([]any)
	if len(input) != 1 {
		t.Fatalf("input = %d items, want 1", len(input))
	}
	msg, _ := input[0].(map[string]any)
	content, _ := msg["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("content = %d parts, want 2 (alien reasoning dropped)", len(content))
	}
	for _, raw := range content {
		part, _ := raw.(map[string]any)
		if part["type"] == "reasoning" && part["encrypted_content"] != "codex_real_blob" {
			t.Errorf("alien reasoning survived: %v", part["encrypted_content"])
		}
	}
	// A `messages` array is not a Responses field and must not reach the wire.
	if _, ok := doc["messages"]; ok {
		t.Error("messages is not on the Responses allowlist and should be swept")
	}
}

// A virtual review model resolves to its upstream id before the suffix is read,
// so "…-review" does not eat the effort level.
func TestCodexReviewModelResolvesUpstream(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex-review", `{"model":"gpt-5-codex-review"}`)
	if doc["model"] != "gpt-5-codex" {
		t.Fatalf("model = %v, want gpt-5-codex", doc["model"])
	}
}

// ── degenerate bodies ────────────────────────────────────────────────────────

// A bare string input becomes a one-item array; the backend requires array
// shape.
func TestCodexNormalisesStringInput(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{"model":"gpt-5-codex","input":"hello"}`)
	input, ok := doc["input"].([]any)
	if !ok || len(input) != 1 {
		t.Fatalf("input = %#v", doc["input"])
	}
	item, _ := input[0].(map[string]any)
	if item["role"] != "user" {
		t.Errorf("role = %v", item["role"])
	}
}

// An empty input array is rejected upstream, so a placeholder is inserted.
func TestCodexFillsEmptyInput(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{"model":"gpt-5-codex","input":[]}`)
	input, _ := doc["input"].([]any)
	if len(input) == 0 {
		t.Fatal("an empty input should have been filled")
	}
}

// Default instructions are injected only when absent, and never for lite models
// (which carry instructions as an input prefix instead).
func TestCodexInjectsDefaultInstructions(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex", `{"model":"gpt-5-codex"}`)
	instr, _ := doc["instructions"].(string)
	if !strings.Contains(instr, "You are Codex") {
		t.Fatalf("instructions not injected: %q", instr)
	}

	// Control: a caller-supplied prompt is respected.
	doc = codexTransform(t, "gpt-5-codex", `{"model":"gpt-5-codex","instructions":"be brief"}`)
	if doc["instructions"] != "be brief" {
		t.Errorf("caller instructions were overwritten: %v", doc["instructions"])
	}
}

// A non-JSON body is passed through untouched: a malformed request should fail
// with the backend's own error rather than a rewrite error here.
func TestCodexPassesNonJSONThrough(t *testing.T) {
	body := []byte("not json at all")
	out, err := NewCodex().TransformBody("gpt-5-codex", body)
	if err != nil {
		t.Fatalf("TransformBody returned an error for non-JSON: %v", err)
	}
	if string(out) != string(body) {
		t.Fatalf("body was altered: %q", out)
	}
}

// An empty body is a no-op, which keeps a degenerate request on the wire with
// its original error message.
func TestCodexEmptyBodyNoOp(t *testing.T) {
	out, err := NewCodex().TransformBody("gpt-5-codex", nil)
	if err != nil {
		t.Fatalf("TransformBody: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("expected an empty body, got %q", out)
	}
}

// ── responses-lite ───────────────────────────────────────────────────────────

// Lite models read tools and instructions as an input prefix; the top-level
// fields are blanked so the backend does not see them twice.
func TestCodexLiteShapeMovesToolsIntoInputPrefix(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex-mini", `{
		"model":"gpt-5-codex-mini",
		"instructions":"be terse",
		"tools":[{"type":"function","name":"ping","parameters":{"type":"object"}}],
		"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`)

	input, _ := doc["input"].([]any)
	if len(input) < 3 {
		t.Fatalf("input = %d items, want >= 3 (two prefix items + the user turn)", len(input))
	}
	head, _ := input[0].(map[string]any)
	if head["type"] != "additional_tools" {
		t.Fatalf("first prefix item type = %v, want additional_tools", head["type"])
	}
	second, _ := input[1].(map[string]any)
	if second["type"] != "message" || second["role"] != "developer" {
		t.Fatalf("second prefix item = %#v", second)
	}

	if doc["instructions"] != "" {
		t.Errorf("instructions should be blanked, got %v", doc["instructions"])
	}
	if doc["tools"] != nil {
		t.Errorf("tools should be nil, got %v", doc["tools"])
	}
	if doc["parallel_tool_calls"] != false {
		t.Errorf("parallel_tool_calls = %v, want false", doc["parallel_tool_calls"])
	}

	r, _ := doc["reasoning"].(map[string]any)
	if r["context"] != "all_turns" {
		t.Errorf("lite reasoning.context = %v, want all_turns", r["context"])
	}
	if _, hasSummary := r["summary"]; hasSummary {
		t.Error("lite reasoning should not carry a summary")
	}
}

// Lite models reject none/minimal, so those are floored rather than forwarded.
func TestCodexLiteEffortFloor(t *testing.T) {
	for _, in := range []string{"none", "minimal"} {
		doc := codexTransform(t, "gpt-5-codex-mini", `{"model":"gpt-5-codex-mini","reasoning":{"effort":"`+in+`"}}`)
		r, _ := doc["reasoning"].(map[string]any)
		if r["effort"] != "low" {
			t.Errorf("lite effort %s = %v, want low", in, r["effort"])
		}
	}
}

// Lite model detection strips a trailing "(...)" annotation before matching.
func TestCodexLiteModelDetection(t *testing.T) {
	for _, name := range []string{"gpt-5-codex-mini", "gpt-5-codex-mini (medium)"} {
		if !codexIsResponsesLite(name) {
			t.Errorf("%s should be lite", name)
		}
	}
	// Control: a full-size model is not lite, and a bare "mini" substring alone
	// is not enough to make one.
	for _, name := range []string{"gpt-5-codex", "gpt-5-codex-high", "mini"} {
		if codexIsResponsesLite(name) {
			t.Errorf("%s should not be lite", name)
		}
	}
}

// A lite request sets the opt-in header so the backend expects the prefix shape.
func TestCodexLiteHeader(t *testing.T) {
	h, _ := NewCodex().Headers(Request{Model: "gpt-5-codex-mini"}, Credential{})
	if h["x-openai-internal-codex-responses-lite"] != "true" {
		t.Fatal("lite opt-in header missing")
	}
	h, _ = NewCodex().Headers(Request{Model: "gpt-5-codex"}, Credential{})
	if _, ok := h["x-openai-internal-codex-responses-lite"]; ok {
		t.Fatal("lite header should be absent for a full model")
	}
}

// When the caller already supplied a lite prefix, it is not duplicated.
func TestCodexLitePrefixNotDuplicated(t *testing.T) {
	doc := codexTransform(t, "gpt-5-codex-mini", `{
		"model":"gpt-5-codex-mini",
		"input":[
			{"type":"additional_tools","role":"developer","tools":[]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}
		]}`)
	input, _ := doc["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("input = %d items, want 2 (no duplicate prefix)", len(input))
	}
}

// ── registry wiring ──────────────────────────────────────────────────────────

// The adapter is reachable under its Node provider id and reports the Responses
// dialect, which is what makes the gateway convert the body before dispatch.
func TestCodexRegisteredInWave7(t *testing.T) {
	r := NewRegistry()
	RegisterWave7(r)

	a, ok := r.Resolve("codex")
	if !ok {
		t.Fatal("codex is not registered")
	}
	if a.Name() != "codex" {
		t.Fatalf("name = %s", a.Name())
	}
	d, ok := a.(Dialect)
	if !ok {
		t.Fatal("codex does not implement Dialect")
	}
	if d.WireFormat() != FormatResponses {
		t.Fatalf("WireFormat = %s, want %s", d.WireFormat(), FormatResponses)
	}
	if _, ok := a.(BodyTransformer); !ok {
		t.Fatal("codex does not implement BodyTransformer")
	}
}
