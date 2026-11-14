package providers

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// ── model resolution ─────────────────────────────────────────────────────────

// The hex alone does not identify a model — the same hex serves more than one
// mode, and the server reads the mode. Resolution therefore has to carry both,
// and the alias chain has to survive a suffix.
func TestResolveGeminiWebModel(t *testing.T) {
	cases := []struct {
		in       string
		wantID   string
		wantHex  string
		wantMode int
		think    bool
	}{
		{"gemini-3.8-flash", "gemini-3.8-flash", "56fdd199312815e2", 1, false},
		{"gemini-3.5-flash-lite", "gemini-3.5-flash-lite", "8c46e95b1a07cecc", 6, false},
		{"gemini-3.1-pro", "gemini-3.1-pro", "e6fa609c3fa255c0", 3, false},
		{"gemini-4-argon", "gemini-4-argon", "95a4c0abcba24364", 8, false},
		// Argon is the case that makes mode load-bearing: hex alone returns Flash.
		{"argon", "gemini-4-argon", "95a4c0abcba24364", 8, false},
		// Legacy names collapse onto current ids.
		{"gemini-2.5-flash", "gemini-3.8-flash", "56fdd199312815e2", 1, false},
		{"gemini-1.5-pro", "gemini-3.1-pro", "e6fa609c3fa255c0", 3, false},
		{"flash", "gemini-3.8-flash", "56fdd199312815e2", 1, false},
		// Uppercase and padding resolve the same.
		{"  GEMINI-3.8-FLASH  ", "gemini-3.8-flash", "56fdd199312815e2", 1, false},
		// Thinking suffix.
		{"gemini-3.8-flash-thinking", "gemini-3.8-flash-thinking", "56fdd199312815e2", 1, true},
		{"gemini-3.5-flash-lite:thinking", "gemini-3.5-flash-lite-thinking", "8c46e95b1a07cecc", 6, true},
		// A thinking suffix must survive the alias chain, not get dropped by it.
		{"gemini-2.5-flash-thinking", "gemini-3.8-flash-thinking", "56fdd199312815e2", 1, true},
		{"gemini-2.0-pro-thinking", "gemini-3.1-pro-thinking", "e6fa609c3fa255c0", 3, true},
	}
	for _, c := range cases {
		id, m, ok := ResolveGeminiWebModel(c.in)
		if !ok {
			t.Errorf("ResolveGeminiWebModel(%q) reported not servable", c.in)
			continue
		}
		if id != c.wantID || m.HexID != c.wantHex || m.Mode != c.wantMode || m.Thinking != c.think {
			t.Errorf("ResolveGeminiWebModel(%q) = %s{hex:%s mode:%d think:%v}, want %s{hex:%s mode:%d think:%v}",
				c.in, id, m.HexID, m.Mode, m.Thinking,
				c.wantID, c.wantHex, c.wantMode, c.think)
		}
	}
}

func TestResolveGeminiWebModelUnknownFallsBack(t *testing.T) {
	id, m, ok := ResolveGeminiWebModel("gpt-9-turbo")
	if ok {
		t.Errorf("unknown model reported servable")
	}
	if id != geminiWebDefaultModel {
		t.Errorf("fallback id = %q, want %q", id, geminiWebDefaultModel)
	}
	if m.HexID == "" || m.Mode == 0 {
		t.Errorf("fallback model is not usable: %+v", m)
	}
}

// ── the 97-slot payload ──────────────────────────────────────────────────────

// The upstream reads positional fields, so the array must be exactly 97 long and
// an omitted slot must be present as null. A shorter array does not mean "use
// defaults" — the later slots shift and the request changes meaning.
func TestBuildGeminiWebInnerShape(t *testing.T) {
	encoded, err := BuildGeminiWebInner("hello", 1, false, "req-abc")
	if err != nil {
		t.Fatalf("BuildGeminiWebInner: %v", err)
	}
	var inner []any
	if err := json.Unmarshal([]byte(encoded), &inner); err != nil {
		t.Fatalf("payload is not valid JSON: %v", err)
	}
	if len(inner) != geminiWebInnerSlots {
		t.Fatalf("slot count = %d, want %d", len(inner), geminiWebInnerSlots)
	}

	// Prompt lives at 0 as [prompt, 0, null...].
	prompt, ok := inner[0].([]any)
	if !ok || len(prompt) != 7 {
		t.Fatalf("slot 0 = %#v, want a 7-element array", inner[0])
	}
	if prompt[0] != "hello" {
		t.Errorf("slot 0 prompt = %v, want hello", prompt[0])
	}
	if inner[1].([]any)[0] != "en" {
		t.Errorf("slot 1 language = %v, want en", inner[1])
	}
	if inner[7] != float64(1) {
		t.Errorf("slot 7 = %v, want 1", inner[7])
	}
	if inner[59] != "req-abc" {
		t.Errorf("slot 59 uuid = %v, want req-abc", inner[59])
	}
	if inner[79] != float64(1) {
		t.Errorf("slot 79 mode = %v, want 1", inner[79])
	}
}

// The mode and thinking slots are the whole reason the model table exists.
func TestBuildGeminiWebInnerModeAndThinking(t *testing.T) {
	_, argon, _ := ResolveGeminiWebModel("gemini-4-argon")
	enc, err := BuildGeminiWebInner("x", argon.Mode, argon.Thinking, "u")
	if err != nil {
		t.Fatalf("BuildGeminiWebInner: %v", err)
	}
	var inner []any
	if err := json.Unmarshal([]byte(enc), &inner); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if inner[79] != float64(8) {
		t.Errorf("argon mode = %v, want 8", inner[79])
	}
	if inner[80] != float64(geminiWebThinkingNormal) {
		t.Errorf("non-thinking slot 80 = %v, want %d", inner[80], geminiWebThinkingNormal)
	}
	if inner[96] != float64(0) {
		t.Errorf("non-thinking slot 96 = %v, want 0", inner[96])
	}

	_, think, _ := ResolveGeminiWebModel("gemini-3.1-pro-thinking")
	enc, err = BuildGeminiWebInner("x", think.Mode, think.Thinking, "u")
	if err != nil {
		t.Fatalf("BuildGeminiWebInner: %v", err)
	}
	if err := json.Unmarshal([]byte(enc), &inner); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if inner[80] != float64(geminiWebThinkingExtended) {
		t.Errorf("thinking slot 80 = %v, want %d", inner[80], geminiWebThinkingExtended)
	}
	if inner[96] != float64(1) {
		t.Errorf("thinking slot 96 = %v, want 1", inner[96])
	}
}

// Unset slots must be JSON null, not absent and not zero — the upstream
// distinguishes "no value" from "value 0".
func TestBuildGeminiWebInnerUnsetSlotsAreNull(t *testing.T) {
	enc, err := BuildGeminiWebInner("x", 1, false, "u")
	if err != nil {
		t.Fatalf("BuildGeminiWebInner: %v", err)
	}
	for _, slot := range []int{3, 4, 5, 8, 9, 12} {
		var inner []any
		if err := json.Unmarshal([]byte(enc), &inner); err != nil {
			t.Fatalf("bad JSON: %v", err)
		}
		if inner[slot] != nil {
			t.Errorf("slot %d = %#v, want null", slot, inner[slot])
		}
	}
	// And the wire form really says null rather than omitting the field, which
	// would be impossible in an array anyway — guard against a future switch to
	// an object map.
	if !strings.Contains(enc, "null") {
		t.Errorf("payload has no null slots: %s", enc[:80])
	}
}

// ── prompt folding ───────────────────────────────────────────────────────────

func TestBuildGeminiWebPrompt(t *testing.T) {
	msgs := []any{
		map[string]any{"role": "system", "content": "be terse"},
		map[string]any{"role": "user", "content": "first"},
		map[string]any{"role": "assistant", "content": "reply one"},
		map[string]any{"role": "user", "content": "second"},
	}
	got := BuildGeminiWebPrompt(msgs)
	if !strings.Contains(got, "System:\nbe terse") {
		t.Errorf("system text not hoisted: %q", got)
	}
	if !strings.Contains(got, "User: first") || !strings.Contains(got, "Assistant: reply one") {
		t.Errorf("history not rendered: %q", got)
	}
	if !strings.Contains(got, "Current user message:\nsecond") {
		t.Errorf("last user turn not labelled: %q", got)
	}
	// The last user turn must not also appear in the history block.
	if strings.Count(got, "second") != 1 {
		t.Errorf("last user turn duplicated: %q", got)
	}
}

func TestBuildGeminiWebPromptSingleTurn(t *testing.T) {
	got := BuildGeminiWebPrompt([]any{
		map[string]any{"role": "user", "content": "just this"},
	})
	if got != "just this" {
		t.Errorf("single-turn prompt = %q, want bare content", got)
	}
}

// Content may arrive as a parts list rather than a string.
func TestBuildGeminiWebPromptPartsList(t *testing.T) {
	got := BuildGeminiWebPrompt([]any{
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "alpha"},
			map[string]any{"type": "text", "text": "beta"},
		}},
	})
	if got != "alphabeta" {
		t.Errorf("parts list = %q, want alphabeta", got)
	}
}

// Empty turns are dropped rather than rendered as blank history lines.
func TestBuildGeminiWebPromptDropsEmpty(t *testing.T) {
	got := BuildGeminiWebPrompt([]any{
		map[string]any{"role": "user", "content": "   "},
		map[string]any{"role": "assistant", "content": ""},
		map[string]any{"role": "user", "content": "real"},
	})
	if got != "real" {
		t.Errorf("empty turns not dropped: %q", got)
	}
}

// A strMessage with no user turn at all must not produce a dangling label.
func TestBuildGeminiWebPromptSystemOnly(t *testing.T) {
	got := BuildGeminiWebPrompt([]any{
		map[string]any{"role": "system", "content": "only system"},
	})
	if !strings.Contains(got, "only system") {
		t.Errorf("system-only prompt dropped content: %q", got)
	}
	if strings.Contains(got, "Current user message") {
		t.Errorf("system-only prompt invented a user turn: %q", got)
	}
}

// ── stream parsing ───────────────────────────────────────────────────────────

// wrb.frFrame builds one stream line of the shape the endpoint emits.
func wrbFrFrame(t *testing.T, inner []any) string {
	t.Helper()
	payload, err := json.Marshal(inner)
	if err != nil {
		t.Fatalf("marshal inner: %v", err)
	}
	envelope := []any{[]any{"wrb.fr", "assistant", string(payload), nil, nil, nil, "generic"}}
	line, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return string(line)
}

// geminiWebInnerWithText places text at inner[4][0][1].
//
// The slot is a list of string chunks and the parser joins ALL of them, exactly as
// the Node original does — so the fixture uses a single-element list. Adding filler
// strings here would be joined into the answer and the test would be asserting on
// its own fixture rather than on the parser.
func geminiWebInnerWithText(text string) []any {
	inner := make([]any, 20)
	slot4 := make([]any, 1)
	slot40 := make([]any, 2)
	slot40[1] = []any{text}
	slot4[0] = slot40
	inner[4] = slot4
	return inner
}

func TestParseGeminiWebStream(t *testing.T) {
	body := strings.Join([]string{
		")]}'",
		"1234",
		"",
		wrbFrFrame(t, geminiWebInnerWithText("hello ")),
		`{"unrelated": true}`,
		wrbFrFrame(t, geminiWebInnerWithText("hello world")),
	}, "\n")

	got := ParseGeminiWebStream(body)
	if got != "hello world" {
		t.Errorf("parsed text = %q, want %q", got, "hello world")
	}
}

// Non-frame noise and truncated lines are skipped, not fatal.
func TestParseGeminiWebStreamTolerantOfGarbage(t *testing.T) {
	body := strings.Join([]string{
		"not json at all",
		`["wrb.fr"]`,
		`["wrb.fr","x",12345]`,
		`["wrb.fr","x","not json payload"]`,
		wrbFrFrame(t, geminiWebInnerWithText("survived")),
	}, "\n")
	if got := ParseGeminiWebStream(body); got != "survived" {
		t.Errorf("parsed text = %q, want survived", got)
	}
}

// A frame whose text slot is missing must not clear a previously good answer.
func TestParseGeminiWebStreamKeepsLastGood(t *testing.T) {
	empty := make([]any, 20)
	empty[4] = []any{[]any{nil, nil}}
	body := strings.Join([]string{
		wrbFrFrame(t, geminiWebInnerWithText("good answer")),
		wrbFrFrame(t, empty),
	}, "\n")
	if got := ParseGeminiWebStream(body); got != "good answer" {
		t.Errorf("parsed text = %q, want the earlier good answer", got)
	}
}

// The reasoning slot is inner[4][0][37][0][0], and the LONGEST chain wins —
// later frames omit or truncate the slot once it freezes.
func TestParseGeminiWebReasoningTakesLongest(t *testing.T) {
	frame := func(chain string) string {
		inner := make([]any, 20)
		slot4 := make([]any, 1)
		slot40 := make([]any, 38)
		slot40[37] = []any{[]any{chain}}
		slot4[0] = slot40
		inner[4] = slot4
		// The parser skips short lines, so pad the frame past the length guard.
		return wrbFrFrame(t, inner) + strings.Repeat(" ", 300)
	}
	body := strings.Join([]string{
		frame("short chain"),
		frame("a much longer chain of thought that must win"),
		frame("truncated"),
	}, "\n")
	got := ParseGeminiWebReasoning(body)
	if got != "a much longer chain of thought that must win" {
		t.Errorf("reasoning = %q, want the longest chain", got)
	}
}

// A reasoning slot that is absent yields empty, not a panic.
func TestParseGeminiWebReasoningAbsent(t *testing.T) {
	body := wrbFrFrame(t, geminiWebInnerWithText("no reasoning here")) + strings.Repeat(" ", 300)
	if got := ParseGeminiWebReasoning(body); got != "" {
		t.Errorf("reasoning = %q, want empty", got)
	}
}

// ── code-artifact cleaning ───────────────────────────────────────────────────

// Code-execution fences carry an event index and are stripped from the answer.
func TestCleanGeminiWebText(t *testing.T) {
	in := "The answer is 42.\n```python?code_reference&code_event_index=3\nprint(6*7)\n```\nDone."
	got := CleanGeminiWebText(in)
	if strings.Contains(got, "code_event_index") {
		t.Errorf("artifact survived: %q", got)
	}
	if !strings.Contains(got, "The answer is 42.") || !strings.Contains(got, "Done.") {
		t.Errorf("prose was lost: %q", got)
	}
}

// If stripping empties the reply, the whole answer WAS the code execution, so the
// marker degrades to a plain fence instead of vanishing.
func TestCleanGeminiWebTextAllArtifact(t *testing.T) {
	in := "```python?code_reference&code_event_index=1\nprint(1)\n```"
	got := CleanGeminiWebText(in)
	if got == "" {
		t.Fatalf("entire reply vanished, which reads downstream as an upstream failure")
	}
	if strings.Contains(got, "code_event_index") {
		t.Errorf("marker survived in degraded form: %q", got)
	}
	if !strings.HasPrefix(got, "```python") {
		t.Errorf("degraded fence not plain: %q", got)
	}
}

// ── session scrape + cache ───────────────────────────────────────────────────

func TestParseGeminiWebSessionParams(t *testing.T) {
	html := `<html><script>window.WIZ_global_data = {"SNlM0e":"AO-x_at-token","cfb2h":"boq_build_20260315.08_p0"};</script></html>`
	s, ok := ParseGeminiWebSessionParams(html)
	if !ok {
		t.Fatalf("session not parsed from a realistic page")
	}
	if s.At != "AO-x_at-token" {
		t.Errorf("at = %q", s.At)
	}
	if s.Bl != "boq_build_20260315.08_p0" {
		t.Errorf("bl = %q, want the page's build label", s.Bl)
	}
}

// A page with an at token but no build label falls back to the constant.
func TestParseGeminiWebSessionParamsBuildFallback(t *testing.T) {
	s, ok := ParseGeminiWebSessionParams(`{"SNlM0e":"tok"}`)
	if !ok {
		t.Fatalf("session not parsed")
	}
	if s.Bl != geminiWebDefaultBL {
		t.Errorf("bl = %q, want the default build label", s.Bl)
	}
}

// No at token means no usable session — not a session with an empty token.
func TestParseGeminiWebSessionParamsMissing(t *testing.T) {
	if _, ok := ParseGeminiWebSessionParams(`<html>nothing here</html>`); ok {
		t.Errorf("parsed a session out of a page with no token")
	}
}

func TestGeminiWebSessionCacheTTL(t *testing.T) {
	c := NewGeminiWebSessionCache()
	now := time.Unix(1_700_000_000, 0)
	c.now = func() time.Time { return now }

	c.Put("cookie-a", geminiWebSession{At: "tok", Bl: "bl"})
	if _, ok := c.Get("cookie-a"); !ok {
		t.Fatalf("fresh entry not returned")
	}
	if c.Size() != 1 {
		t.Errorf("size = %d, want 1", c.Size())
	}

	// Just inside the TTL.
	now = now.Add(geminiWebSessionTTL - time.Second)
	if _, ok := c.Get("cookie-a"); !ok {
		t.Errorf("entry expired early")
	}
	// Just past it.
	now = now.Add(2 * time.Second)
	if _, ok := c.Get("cookie-a"); ok {
		t.Errorf("entry outlived its TTL")
	}
}

// Cache keys are per-cookie: one account's token must never be handed to another.
func TestGeminiWebSessionCacheIsKeyedPerCookie(t *testing.T) {
	c := NewGeminiWebSessionCache()
	c.Put("cookie-a", geminiWebSession{At: "tok-a", Bl: "bl"})
	if _, ok := c.Get("cookie-b"); ok {
		t.Errorf("cookie-b served with cookie-a's session")
	}
}

func TestGeminiWebSessionCacheInvalidate(t *testing.T) {
	c := NewGeminiWebSessionCache()
	c.Put("cookie-a", geminiWebSession{At: "tok", Bl: "bl"})
	c.Invalidate("cookie-a")
	if _, ok := c.Get("cookie-a"); ok {
		t.Errorf("invalidated entry still served")
	}
	if c.Size() != 0 {
		t.Errorf("size after invalidate = %d, want 0", c.Size())
	}
}

// ── request shaping ──────────────────────────────────────────────────────────

// The session token and build label go in the QUERY, so the URL cannot be formed
// before the scrape — that ordering is why the adapter holds the cache.
func TestGeminiWebStreamQuery(t *testing.T) {
	q := GeminiWebStreamQuery(geminiWebSession{At: "tok", Bl: "bl-123"}, "req-1")
	for _, want := range []string{"bl=bl-123", "f.sid=req-1", "_reqid=req-1", "hl=en", "rt=c"} {
		if !strings.Contains(q, want) {
			t.Errorf("query %q missing %q", q, want)
		}
	}
}

// Keys are sorted so the query string is stable across calls — a value that
// changes between identical requests looks like a new session to the upstream.
func TestGeminiWebStreamQueryIsStable(t *testing.T) {
	s := geminiWebSession{At: "tok", Bl: "bl"}
	if GeminiWebStreamQuery(s, "r") != GeminiWebStreamQuery(s, "r") {
		t.Errorf("query string is not deterministic")
	}
}

func TestGeminiWebHeaders(t *testing.T) {
	h := GeminiWebHeaders("SID=abc; HSID=def")
	if h["Cookie"] != "SID=abc; HSID=def" {
		t.Errorf("cookie not forwarded: %q", h["Cookie"])
	}
	if h["X-Same-Domain"] != "1" {
		t.Errorf("X-Same-Domain = %q, want 1", h["X-Same-Domain"])
	}
	if h["X-Goog-AuthUser"] != "0" {
		t.Errorf("X-Goog-AuthUser = %q, want 0", h["X-Goog-AuthUser"])
	}
	// Both jspb extension headers must be present; the endpoint rejects a request
	// missing either.
	if h["x-goog-ext-73010989-jspb"] == "" || h["x-goog-ext-73010990-jspb"] == "" {
		t.Errorf("jspb extension headers missing: %v", h)
	}
	if h["Origin"] != "https://gemini.google.com" {
		t.Errorf("origin = %q", h["Origin"])
	}
}

// ── adapter surface ──────────────────────────────────────────────────────────

func TestGeminiWebAdapterIdentity(t *testing.T) {
	a := NewGeminiWeb()
	if a.Name() != "gemini-web" {
		t.Errorf("name = %q", a.Name())
	}
	if a.WireFormat() != FormatGemini {
		t.Errorf("wire format = %q, want %q", a.WireFormat(), FormatGemini)
	}
}

// Endpoint without a primed session must fail loudly rather than emit a URL with
// an empty session token, which would look like an auth rejection upstream.
func TestGeminiWebEndpointWithoutSession(t *testing.T) {
	a := NewGeminiWeb()
	if _, err := a.Endpoint(Request{}, Credential{Cookie: "SID=x"}); err == nil {
		t.Errorf("endpoint formed without a session")
	}
}

func TestGeminiWebEndpointWithSession(t *testing.T) {
	a := NewGeminiWeb()
	a.Sessions().Put("SID=x", geminiWebSession{At: "tok", Bl: "bl-9"})
	url, err := a.Endpoint(Request{RequestID: "req-7"}, Credential{Cookie: "SID=x"})
	if err != nil {
		t.Fatalf("Endpoint: %v", err)
	}
	if !strings.HasPrefix(url, geminiWebStreamURL) {
		t.Errorf("url does not target the stream endpoint: %q", url)
	}
	if !strings.Contains(url, "bl=bl-9") || !strings.Contains(url, "_reqid=req-7") {
		t.Errorf("url missing session values: %q", url)
	}
}

func TestGeminiWebHeadersWithoutCookie(t *testing.T) {
	a := NewGeminiWeb()
	if _, err := a.Headers(Request{}, Credential{}); err == nil {
		t.Errorf("headers built without a cookie")
	}
}
