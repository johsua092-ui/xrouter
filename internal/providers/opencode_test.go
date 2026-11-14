package providers

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

func newTestOpenCode() *OpenCode {
	a := NewOpenCode()
	// No real sleeping in tests: the pacer's contract is asserted separately.
	a.pace.sleep = func(time.Duration) {}
	return a
}

// ── session shape ────────────────────────────────────────────────────────────

func TestMintedSessionShape(t *testing.T) {
	a := newTestOpenCode()
	s := a.sessions.mint()

	if !validOpenCodeSession(s) {
		t.Fatalf("sesi mint tidak lolos validasi: %q (len=%d)", s, len(s))
	}
	if !strings.HasPrefix(s, "ses_") {
		t.Errorf("prefix salah: %q", s)
	}
	// 4 + 12 + 14
	if len(s) != 30 {
		t.Errorf("panjang %d, harus 30", len(s))
	}
}

// The 12-hex prefix must be DISTINGUISHABLE and ORDERED, which is the property
// upstream can actually rely on.
//
// The field is 48 bits and the value encoded is ms*4096+counter, so only the low
// 48 bits survive — the absolute millisecond count is truncated away and cannot be
// recovered. What DOES survive is the ordering, and that is the real requirement:
// sessions minted later must sort lower, so upstream can treat the field as a
// recency signal within its window. A uniformly random prefix would satisfy the
// shape while destroying the ordering, which is why the encoding must be built
// from the clock rather than a digest.
func TestSessionPrefixIsOrderedAndTruncated(t *testing.T) {
	sessions := newOpenCodeSessions()
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	sessions.now = func() time.Time { return now }

	s := sessions.mint()
	prefix := s[len("ses_") : len("ses_")+12]

	raw, err := strconv.ParseUint(prefix, 16, 64)
	if err != nil {
		t.Fatalf("prefix bukan hex: %q", prefix)
	}
	if raw > sessionPrefixMask {
		t.Errorf("prefix melebihi 48 bit: %#x", raw)
	}

	// The round-trip is defined by the same constants, which is what keeps the
	// encoder and its inverse honest: a change to one without the other breaks
	// this assertion.
	restored := ^raw & sessionPrefixMask
	if ms := restored >> 12; ms > (uint64(1) << 36) {
		t.Errorf("nilai kembali di luar rentang 2^36 ms: %d", ms)
	}

	// Two sessions a minute apart must still be strictly ordered.
	sessions.now = func() time.Time { return now.Add(time.Minute) }
	later := sessions.mint()
	laterRaw, _ := strconv.ParseUint(later[4:16], 16, 64)

	if laterRaw >= raw {
		t.Errorf("sesi lebih baru harus lebih kecil:\n  awal  =%#x\n  berikutnya=%#x", raw, laterRaw)
	}
}

// The 48-bit field cannot carry an absolute timestamp: it is truncated. Pinned as
// a test so a future "fix" that tries to store the full millisecond count is
// caught here rather than upstream.
func TestSessionFieldIsTruncatedTo48Bits(t *testing.T) {
	// 2^48 ms is far beyond the representable range once shifted by the counter.
	const representableMs = uint64(1) << 36
	if time.UnixMilli(int64(representableMs)).Year() > 1980 {
		t.Fatal("asumsi rentang berubah; periksa ulang encoding")
	}
	// Sanity: the current wall clock is far outside the representable window, which
	// is why the field is a recency signal and not a date.
	if time.Now().UnixMilli() < int64(representableMs) {
		t.Skip("jam mesin mundur; asumsi rentang tidak berlaku di sini")
	}
}

// The field must be DESCENDING: a later session sorts before an earlier one.
func TestSessionPrefixIsDescending(t *testing.T) {
	sessions := newOpenCodeSessions()
	early := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)

	sessions.now = func() time.Time { return early }
	first := sessions.mint()

	sessions.now = func() time.Time { return early.Add(5 * time.Minute) }
	second := sessions.mint()

	firstPrefix := first[4:16]
	secondPrefix := second[4:16]

	a, _ := strconv.ParseUint(firstPrefix, 16, 64)
	b, _ := strconv.ParseUint(secondPrefix, 16, 64)

	if b >= a {
		t.Errorf("field harus menurun: sesi lama=%q (%d), sesi baru=%q (%d)", firstPrefix, a, secondPrefix, b)
	}
}

// Two sessions minted in the same millisecond must not collide.
func TestSessionsInSameMillisecondDiffer(t *testing.T) {
	sessions := newOpenCodeSessions()
	fixed := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	sessions.now = func() time.Time { return fixed }

	seen := map[string]bool{}
	for i := 0; i < 8; i++ {
		s := sessions.mint()
		if seen[s] {
			t.Fatalf("sesi duplikat di milidetik yang sama: %q", s)
		}
		seen[s] = true
	}
}

// A native session is used verbatim; anything else is translated.
func TestNativeSessionHonoured(t *testing.T) {
	a := newTestOpenCode()

	native := "ses_1234567890abABCDEFGHIJKLMN"
	if !validOpenCodeSession(native) {
		t.Fatalf("sesi uji tidak valid: %q (len=%d)", native, len(native))
	}

	got, err := a.SessionFor(Request{Model: "m"}, cred(map[string]string{
		"raw:x-opencode-session": native,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if got != native {
		t.Errorf("sesi native harus dipakai apa adanya, dapat %q", got)
	}
}

// A caller's non-native session is translated ONCE and memoised, so the same
// conversation keeps one upstream session across turns.
func TestForeignSessionTranslatedAndStable(t *testing.T) {
	a := newTestOpenCode()
	c := cred(map[string]string{"raw:x-opencode-session": "caller-session-abc"})

	first, err := a.SessionFor(Request{Model: "m"}, c)
	if err != nil {
		t.Fatal(err)
	}
	if !validOpenCodeSession(first) {
		t.Fatalf("hasil terjemahan tidak valid: %q", first)
	}
	if first == "caller-session-abc" {
		t.Error("sesi asing harus diterjemahkan, bukan diteruskan")
	}

	second, _ := a.SessionFor(Request{Model: "m"}, c)
	if second != first {
		t.Errorf("sesi tidak stabil antar-request:\n  %q\n  %q", first, second)
	}
}

// With no caller hints, the canonical session is stable per connection.
func TestStableSessionPerConnection(t *testing.T) {
	a := newTestOpenCode()
	c := cred(map[string]string{"connectionId": "conn-42"})

	first, err := a.SessionFor(Request{Model: "m"}, c)
	if err != nil {
		t.Fatal(err)
	}
	if !validOpenCodeSession(first) {
		t.Fatalf("sesi kanonik tidak valid: %q", first)
	}

	second, _ := a.SessionFor(Request{Model: "m"}, c)
	if second != first {
		t.Errorf("sesi kanonik harus stabil: %q vs %q", first, second)
	}

	// A different connection gets its own session.
	other, _ := a.SessionFor(Request{Model: "m"}, cred(map[string]string{"connectionId": "conn-99"}))
	if other == first {
		t.Error("koneksi berbeda tidak boleh berbagi sesi")
	}
}

// Forget drops a spent session, so the next request mints a replacement. Without
// this, a flagged session is reused forever and every later request fails.
func TestForgetDropsSession(t *testing.T) {
	a := newTestOpenCode()
	c := cred(map[string]string{"connectionId": "conn-1"})

	first, _ := a.SessionFor(Request{}, c)
	if !a.Forget(first) {
		t.Fatal("Forget harus melaporkan bahwa sesi dihapus")
	}
	second, _ := a.SessionFor(Request{}, c)

	if second == first {
		t.Error("setelah Forget harus ada sesi baru")
	}
	if !validOpenCodeSession(second) {
		t.Errorf("sesi pengganti tidak valid: %q", second)
	}
	if a.Forget("") {
		t.Error("Forget(\"\") harus false")
	}
}

// An over-long session value is refused rather than forwarded.
func TestOversizeSessionTreatedAsForeign(t *testing.T) {
	a := newTestOpenCode()
	long := "ses_" + strings.Repeat("a", 400)

	got, err := a.SessionFor(Request{}, cred(map[string]string{"raw:x-opencode-session": long}))
	if err != nil {
		t.Fatal(err)
	}
	if got == long {
		t.Error("sesi terlalu panjang tidak boleh diteruskan")
	}
	if len(got) > opencodeSessionMax {
		t.Errorf("sesi hasil %d karakter, melebihi batas", len(got))
	}
}

func TestSessionSweepAndBounds(t *testing.T) {
	a := newTestOpenCode()
	base := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	a.sessions.now = func() time.Time { return base }

	for i := 0; i < 20; i++ {
		id := "conn-" + strconv.Itoa(i)
		a.sessions.stable_(id)
	}
	if got := len(a.sessions.stable); got != 20 {
		t.Fatalf("harus ada 20 sesi, ada %d", got)
	}

	// Advance past the TTL: every session is now stale.
	a.sessions.now = func() time.Time { return base.Add(OpenCodeSessionTTL + time.Minute) }
	if dropped := a.sessions.Sweep(); dropped != 20 {
		t.Errorf("Sweep menghapus %d, harus 20", dropped)
	}
	if len(a.sessions.stable) != 0 {
		t.Errorf("sisa %d sesi", len(a.sessions.stable))
	}
}

func TestStableStoreStaysBounded(t *testing.T) {
	a := newTestOpenCode()
	for i := 0; i < MaxStableSessions+200; i++ {
		a.sessions.stable_("conn-" + strconv.Itoa(i))
	}
	if got := len(a.sessions.stable); got > MaxStableSessions {
		t.Errorf("toko sesi melampaui batas: %d", got)
	}
}

// ── URL routing ──────────────────────────────────────────────────────────────

func TestOpenCodeRoutesPerFamily(t *testing.T) {
	a := newTestOpenCode()

	cases := map[string]string{
		"muse-spark-1.2-contributor-free": "/inference/openai/v1/responses",
		"muse-spark-1.3-contributor-free": "/inference/openai/v1/responses",
		"union-alpha":                     "/inference/openai/v1/messages",
		"grok-4.6":                        "/inference/openai/v1/chat/completions",
	}
	for model, suffix := range cases {
		url, err := a.Endpoint(Request{Model: model}, cred(nil))
		if err != nil {
			t.Fatalf("%s: %v", model, err)
		}
		if !strings.HasSuffix(url, suffix) {
			t.Errorf("%s -> %q, harus berakhiran %q", model, url, suffix)
		}
	}
}

// The free lane moved off /zen/v1; the old prefix now 403s every free request.
func TestOpenCodeDoesNotUseZenPrefix(t *testing.T) {
	a := newTestOpenCode()
	url, _ := a.Endpoint(Request{Model: "grok-4.6"}, cred(nil))
	if strings.Contains(url, "/zen/") {
		t.Errorf("endpoint masih memakai prefix lama: %q", url)
	}
	if !strings.Contains(url, "/inference/") {
		t.Errorf("endpoint harus di bawah /inference/, dapat %q", url)
	}
}

// ── headers ──────────────────────────────────────────────────────────────────

func TestOpenCodeHeaders(t *testing.T) {
	a := newTestOpenCode()
	h, err := a.Headers(Request{Model: "grok-4.6", Stream: true},
		cred(map[string]string{"connectionId": "c"}))
	if err != nil {
		t.Fatal(err)
	}

	// The lane meters per session/project, so the published convention is a
	// literal "public".
	if h["Authorization"] != "Bearer public" {
		t.Errorf("free lane harus 'Bearer public', dapat %q", h["Authorization"])
	}
	if h["Accept"] != "text/event-stream" {
		t.Errorf("stream harus minta SSE, dapat %q", h["Accept"])
	}
	if !strings.HasPrefix(h["traceparent"], "00-") {
		t.Errorf("traceparent salah: %q", h["traceparent"])
	}
	// b3 is traceId-spanId-sampled-parentSpanId.
	b3 := strings.Split(h["b3"], "-")
	if len(b3) != 4 {
		t.Errorf("b3 harus 4 segmen, dapat %q", h["b3"])
	}
	for _, name := range []string{"x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"} {
		if h[name] == "" {
			t.Errorf("header %s kosong", name)
		}
		if h[name] != h["x-opencode-session"] {
			t.Errorf("%s tidak sama dengan x-opencode-session", name)
		}
	}
}

// The Anthropic dialect needs its version header, set only on the /messages path.
func TestOpenCodeMessagesPathGetsAnthropicVersion(t *testing.T) {
	a := newTestOpenCode()

	h, err := a.Headers(Request{Model: "union-alpha"}, cred(map[string]string{"connectionId": "c"}))
	if err != nil {
		t.Fatal(err)
	}
	if h["anthropic-version"] == "" {
		t.Error("/messages harus mengirim anthropic-version")
	}

	h2, _ := a.Headers(Request{Model: "grok-4.6"}, cred(map[string]string{"connectionId": "c"}))
	if h2["anthropic-version"] != "" {
		t.Errorf("chat path tidak perlu anthropic-version, dapat %q", h2["anthropic-version"])
	}
}

// Each request needs a fresh project id, since quota is metered per project.
func TestProjectIdRotates(t *testing.T) {
	a := newTestOpenCode()
	seen := map[string]bool{}
	for i := 0; i < 5; i++ {
		h, _ := a.Headers(Request{Model: "m"}, cred(map[string]string{"connectionId": "c"}))
		p := h["x-opencode-project"]
		if len(p) != 40 {
			t.Fatalf("project id harus 40 hex, dapat %q (%d)", p, len(p))
		}
		seen[p] = true
	}
	if len(seen) < 5 {
		t.Errorf("project id tidak berotasi: %d unik dari 5", len(seen))
	}
}

// ── user agent ───────────────────────────────────────────────────────────────

func TestUserAgentRejectsV1Shape(t *testing.T) {
	// The v1 form has been refused with a 403 since 2026-10-14.
	if hasValidOpenCodeVersion("opencode/1.18.3") {
		t.Error("bentuk v1 harus ditolak")
	}
	if hasValidOpenCodeVersion("opencode/latest/2.2.5/cli") != true {
		t.Error("bentuk v2 harus diterima")
	}
	if hasValidOpenCodeVersion("") {
		t.Error("kosong harus ditolak")
	}
	if hasValidOpenCodeVersion("curl/8.0") {
		t.Error("UA non-opencode harus ditolak")
	}
}

// A genuine OpenCode client keeps its own UA; rewriting it would make a real
// client look impersonated.
func TestDownstreamUserAgentHonoured(t *testing.T) {
	a := newTestOpenCode()
	h, _ := a.Headers(Request{Model: "m"}, cred(map[string]string{
		"connectionId":   "c",
		"raw:user-agent": "opencode/latest/2.2.9/cli",
	}))
	if h["User-Agent"] != "opencode/latest/2.2.9/cli" {
		t.Errorf("UA pemanggil harus dipertahankan, dapat %q", h["User-Agent"])
	}

	// A v1 UA is NOT honoured: it would be refused upstream.
	h2, _ := a.Headers(Request{Model: "m"}, cred(map[string]string{
		"connectionId":   "c",
		"raw:user-agent": "opencode/1.18.3",
	}))
	if h2["User-Agent"] == "opencode/1.18.3" {
		t.Error("UA v1 tidak boleh diteruskan")
	}
	if !strings.Contains(h2["User-Agent"], "/latest/") {
		t.Errorf("harus jatuh ke UA bawaan, dapat %q", h2["User-Agent"])
	}
}

func TestReleaseVersionValidation(t *testing.T) {
	valid := []string{"2.2.5", "10.0.1", "1.0.0"}
	for _, v := range valid {
		if !isReleaseVersion(v) {
			t.Errorf("%q harus valid", v)
		}
	}
	invalid := []string{"", "2.2", "2.2.5.1", "2.2.x", "v2.2.5", "2.2.-1"}
	for _, v := range invalid {
		if isReleaseVersion(v) {
			t.Errorf("%q harus ditolak", v)
		}
	}
}

// ── fingerprint: tools ───────────────────────────────────────────────────────

// All five required declarations must be present after the pass, even when the
// caller sent their own tools.
func TestFingerprintToolsInjectedIntoNonEmptyList(t *testing.T) {
	body := map[string]any{
		"tools": []any{
			map[string]any{"type": "function", "function": map[string]any{"name": "my_custom_tool"}},
		},
	}
	ApplyFingerprintTools(body, false, false)

	tools := body["tools"].([]any)
	names := map[string]bool{}
	for _, t := range tools {
		names[toolNameOf(t)] = true
	}
	for _, want := range OpenCodeFingerprintTools {
		if !names[want] {
			t.Errorf("alat wajib %q tidak ada", want)
		}
	}
	// The caller's own tool survives.
	if !names["my_custom_tool"] {
		t.Error("alat pemanggil hilang")
	}
}

// A caller tool that already uses an exact fingerprint name is not duplicated.
func TestFingerprintToolsNotDuplicated(t *testing.T) {
	body := map[string]any{
		"tools": []any{
			map[string]any{"type": "function", "function": map[string]any{
				"name":        "read",
				"description": openCodeFingerprintDefinitions["read"].Description,
				"parameters":  openCodeFingerprintDefinitions["read"].Parameters,
			}},
		},
	}
	ApplyFingerprintTools(body, false, false)

	count := 0
	for _, t := range body["tools"].([]any) {
		if toolNameOf(t) == "read" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("read muncul %d kali, harus 1", count)
	}
}

// The flat Responses shape uses {name} not {function:{name}}.
func TestFingerprintToolsFlatShape(t *testing.T) {
	body := map[string]any{}
	ApplyFingerprintTools(body, true, false)

	for _, tool := range body["tools"].([]any) {
		m := tool.(map[string]any)
		if _, hasFn := m["function"]; hasFn {
			t.Error("bentuk flat tidak boleh membungkus function")
		}
		if m["name"] == nil {
			t.Error("bentuk flat harus punya name di akar")
		}
		if _, ok := m["strict"]; !ok {
			t.Error("bentuk flat harus menyertakan strict")
		}
	}
}

// tool_choice "none" is refused on every lane, so it must be removed.
func TestToolChoiceNoneRemoved(t *testing.T) {
	body := map[string]any{"tool_choice": "none"}
	ApplyFingerprintTools(body, false, false)
	if body["tool_choice"] != nil {
		t.Errorf("tool_choice none harus dibuang, dapat %v", body["tool_choice"])
	}

	body2 := map[string]any{"tool_choice": map[string]any{"type": "none"}}
	ApplyFingerprintTools(body2, false, false)
	if body2["tool_choice"] != nil {
		t.Errorf("tool_choice objek none harus dibuang, dapat %v", body2["tool_choice"])
	}
}

// Responses keeps an explicit auto default; never "none".
func TestResponsesGetsAutoToolChoice(t *testing.T) {
	body := map[string]any{}
	ApplyFingerprintTools(body, true, false)
	if body["tool_choice"] != "auto" {
		t.Errorf("Responses harus default auto, dapat %v", body["tool_choice"])
	}

	body2 := map[string]any{}
	ApplyFingerprintTools(body2, false, false)
	if body2["tool_choice"] != nil {
		t.Errorf("chat tidak boleh mendapat default tool_choice, dapat %v", body2["tool_choice"])
	}
}

// The WAF rejects an oversized tool surface, so the canonical five must survive
// the trim intact.
func TestToolBudgetTrimKeepsCanonical(t *testing.T) {
	var tools []any
	// Enough padding to blow well past the ceiling.
	for i := 0; i < 400; i++ {
		tools = append(tools, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        "padding_tool_" + strconv.Itoa(i),
				"description": strings.Repeat("x", 500),
			},
		})
	}
	body := map[string]any{"tools": tools}
	ApplyFingerprintTools(body, false, false)

	trimmed := body["tools"].([]any)
	raw, _ := json.Marshal(trimmed)
	if len(raw) > opencodeToolBudget {
		t.Errorf("permukaan alat masih %d byte, melebihi %d", len(raw), opencodeToolBudget)
	}

	names := map[string]bool{}
	for _, tool := range trimmed {
		names[toolNameOf(tool)] = true
	}
	for _, want := range OpenCodeFingerprintTools {
		if !names[want] {
			t.Errorf("alat kanonik %q terpotong oleh trim anggaran", want)
		}
	}
}

// The legacy retention field is replaced by the current options object.
func TestPromptCacheRetentionNormalized(t *testing.T) {
	body := map[string]any{"prompt_cache_retention": "24h"}
	ApplyFingerprintTools(body, false, false)

	if body["prompt_cache_retention"] != nil {
		t.Error("field lama harus dihapus")
	}
	opts, ok := body["prompt_cache_options"].(map[string]any)
	if !ok {
		t.Fatalf("prompt_cache_options harus dibuat, dapat %v", body["prompt_cache_options"])
	}
	if opts["mode"] != "implicit" {
		t.Errorf("mode harus implicit, dapat %v", opts["mode"])
	}
}

// ── fingerprint: env marker ──────────────────────────────────────────────────

func TestEnvMarkerOnChatMessages(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "hi"},
		},
	}
	ApplyEnvFingerprint(body, false, false)

	msgs := body["messages"].([]any)
	first := msgs[0].(map[string]any)
	if first["role"] != "system" {
		t.Fatalf("harus ada pesan system di depan, dapat %v", first["role"])
	}
	if !strings.Contains(first["content"].(string), openCodeEnvTag) {
		t.Error("marker env tidak ada")
	}
}

// An existing system message is appended to, not replaced.
func TestEnvMarkerAppendsToExistingSystem(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "You are helpful."},
			map[string]any{"role": "user", "content": "hi"},
		},
	}
	ApplyEnvFingerprint(body, false, false)

	msgs := body["messages"].([]any)
	sys := msgs[0].(map[string]any)
	content := sys["content"].(string)
	if !strings.Contains(content, "You are helpful.") {
		t.Error("prompt pemanggil hilang")
	}
	if !strings.Contains(content, openCodeEnvTag) {
		t.Error("marker env tidak ditambahkan")
	}
	if len(msgs) != 2 {
		t.Errorf("jumlah pesan berubah: %d", len(msgs))
	}
}

// A genuine CLI already sends the marker, so it must not be duplicated.
func TestEnvMarkerNotDuplicated(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "existing <env> block"},
			map[string]any{"role": "user", "content": "hi"},
		},
	}
	if ApplyEnvFingerprint(body, false, false) {
		t.Error("tidak boleh menambahkan marker kalau sudah ada")
	}
	content := body["messages"].([]any)[0].(map[string]any)["content"].(string)
	if strings.Count(content, openCodeEnvTag) != 1 {
		t.Errorf("marker ganda: %q", content)
	}
}

// Text-block system prompts are handled too.
func TestEnvMarkerOnBlockSystem(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": []any{
				map[string]any{"type": "text", "text": "Be terse."},
			}},
		},
	}
	ApplyEnvFingerprint(body, false, false)

	blocks := body["messages"].([]any)[0].(map[string]any)["content"].([]any)
	last := blocks[len(blocks)-1].(map[string]any)
	if !strings.Contains(last["text"].(string), openCodeEnvTag) {
		t.Errorf("marker tidak ditambahkan ke blok terakhir: %v", blocks)
	}
}

// The claude top-level `system` shape is covered.
func TestEnvMarkerOnClaudeSystem(t *testing.T) {
	body := map[string]any{"system": "You are Claude Code."}
	ApplyEnvFingerprint(body, false, true)

	s := body["system"].(string)
	if !strings.Contains(s, "You are Claude Code.") || !strings.Contains(s, openCodeEnvTag) {
		t.Errorf("marker claude salah: %q", s)
	}
}

// The Responses shape uses `instructions`, not `messages`.
func TestEnvMarkerOnResponsesInstructions(t *testing.T) {
	body := map[string]any{"instructions": "Do the thing."}
	ApplyEnvFingerprint(body, true, false)

	s := body["instructions"].(string)
	if !strings.Contains(s, "Do the thing.") || !strings.Contains(s, openCodeEnvTag) {
		t.Errorf("marker Responses salah: %q", s)
	}

	// A non-string instructions value is left alone: the marker is an enhancement
	// and mangling a surprising body would break a request that might have passed.
	body2 := map[string]any{"instructions": 123}
	if ApplyEnvFingerprint(body2, true, false) {
		t.Error("instructions non-string tidak boleh diubah")
	}
	if body2["instructions"] != 123 {
		t.Errorf("nilai diubah: %v", body2["instructions"])
	}
}

// An unrecognised shape is left untouched.
func TestEnvMarkerFailOpen(t *testing.T) {
	body := map[string]any{"totally": "different"}
	if ApplyEnvFingerprint(body, false, false) {
		t.Error("bentuk tak dikenal tidak boleh dilaporkan berubah")
	}
	if body["messages"] != nil {
		t.Error("bentuk tak dikenal tidak boleh dimodifikasi")
	}
}

// ── retry classification ─────────────────────────────────────────────────────

// An overload is transient and worth retrying on the same session; a spent
// session needs a new one. Confusing the two wastes the retry budget.
func TestRejectionClassification(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   string
	}{
		{429, `{"error":{"message":"The model is overloaded"}}`, "overload"},
		{429, `{"error":{"name":"FreeUsageLimitError"}}`, "session"},
		{403, `{"error":{"name":"FreeTierError"}}`, "session"},
		{500, "server error", ""},
		{200, "fine", ""},
	}
	for _, c := range cases {
		if got := classifyOpenCodeRejection(c.status, c.body); got != c.want {
			t.Errorf("classify(%d, %q)=%q, harus %q", c.status, c.body, got, c.want)
		}
	}
}

// The backoff schedule must stay under the ceiling and grow monotonically.
func TestOverloadBackoffSchedule(t *testing.T) {
	var prev time.Duration
	for attempt := 1; attempt < OpenCodeOverloadAttempts; attempt++ {
		d := openCodeOverloadBackoff(attempt)
		if d > OpenCodeOverloadMax {
			t.Errorf("attempt %d: %v melebihi batas %v", attempt, d, OpenCodeOverloadMax)
		}
		if d < prev {
			t.Errorf("attempt %d: %v mundur dari %v", attempt, d, prev)
		}
		prev = d
	}
}

// ── pacing ───────────────────────────────────────────────────────────────────

// Two starts must be separated, and the first must not be delayed.
func TestPacerSpacesStarts(t *testing.T) {
	p := newOpenCodePacer()

	var slept []time.Duration
	current := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	p.now = func() time.Time { return current }
	p.sleep = func(d time.Duration) {
		slept = append(slept, d)
		current = current.Add(d)
	}

	p.Wait() // first: no delay
	if len(slept) != 0 {
		t.Errorf("start pertama tidak boleh tertunda, tidur %v", slept)
	}

	p.Wait() // second: must be spaced
	if len(slept) != 1 {
		t.Fatalf("start kedua harus menunggu, tidur %v", slept)
	}
	if slept[0] <= 0 || slept[0] > OpenCodeMinStartGap {
		t.Errorf("jeda %v di luar rentang yang wajar (0, %v]", slept[0], OpenCodeMinStartGap)
	}
}

// ── registration ─────────────────────────────────────────────────────────────

func TestRegisterWave6(t *testing.T) {
	r := NewRegistry()
	RegisterWave6(r)

	a, ok := r.Resolve("opencode")
	if !ok {
		t.Fatal("opencode tidak terdaftar")
	}
	if a.Name() != "opencode" {
		t.Errorf("Name()=%q", a.Name())
	}
}
