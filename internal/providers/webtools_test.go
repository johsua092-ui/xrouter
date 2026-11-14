package providers

import (
	"encoding/json"
	"strings"
	"testing"
)

func webTools() []any {
	return []any{
		map[string]any{"type": "function", "function": map[string]any{
			"name":        "read_file",
			"description": "Read a file from disk",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{"path": map[string]any{"type": "string"}},
				"required":   []any{"path"},
			},
		}},
		map[string]any{"type": "function", "function": map[string]any{
			"name":        "run_shell",
			"description": "Run a shell command",
		}},
	}
}

// ── contract rendering ───────────────────────────────────────────────────────

func TestSerializeToolsToPrompt(t *testing.T) {
	prompt := SerializeToolsToPrompt(webTools(), "abc12345")
	if prompt == "" {
		t.Fatal("kontrak tidak dirender")
	}

	// The nonce must appear in the instruction AND in the example, because the
	// model copies the example shape.
	if strings.Count(prompt, "abc12345") < 2 {
		t.Errorf("nonce harus muncul di instruksi dan contoh:\n%s", prompt)
	}
	if !strings.Contains(prompt, "<tool>") {
		t.Error("bentuk blok tidak dijelaskan")
	}
	// Both tools are declared with their descriptions.
	for _, want := range []string{"read_file", "Read a file from disk", "run_shell", "Run a shell command"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("kontrak tidak memuat %q", want)
		}
	}
	// Parameters are inlined so the model knows the schema.
	if !strings.Contains(prompt, "parameters:") {
		t.Error("skema parameter tidak disertakan")
	}
}

// No tools or no nonce means no contract: injecting an empty one would tell the
// model it has tools it cannot see.
func TestSerializeToolsToPromptEmpty(t *testing.T) {
	if got := SerializeToolsToPrompt(nil, "abc"); got != "" {
		t.Errorf("tanpa alat harus kosong, dapat %q", got)
	}
	if got := SerializeToolsToPrompt(webTools(), ""); got != "" {
		t.Errorf("tanpa nonce harus kosong, dapat %q", got)
	}
	// A tool with no name contributes nothing, so the whole render is empty.
	if got := SerializeToolsToPrompt([]any{map[string]any{"type": "function"}}, "abc"); got != "" {
		t.Errorf("alat tanpa nama harus diabaikan, dapat %q", got)
	}
}

// The trailing reminder is the anchor that makes the fence come out at all.
func TestBuildToolReminder(t *testing.T) {
	prompt := SerializeToolsToPrompt(webTools(), "abc12345")
	reminder := BuildToolReminder(prompt)

	if !strings.Contains(reminder, "read_file") || !strings.Contains(reminder, "run_shell") {
		t.Errorf("pengingat harus menyebut nama alat: %q", reminder)
	}
	if !strings.Contains(reminder, "ARE available") {
		t.Errorf("pengingat harus menegaskan ketersediaan: %q", reminder)
	}
	// It is an anchor, so it must be appendable after any body.
	if !strings.HasPrefix(reminder, "\n\n") {
		t.Error("pengingat harus dipisah dari isi sebelumnya")
	}
}

// ── nonce ────────────────────────────────────────────────────────────────────

func TestNonceStablePerSeed(t *testing.T) {
	a := webToolNonce("req-1")
	b := webToolNonce("req-1")
	if a != b {
		t.Errorf("nonce harus stabil per seed: %q vs %q", a, b)
	}
	if len(a) != 8 {
		t.Errorf("nonce harus 8 karakter, dapat %d: %q", len(a), a)
	}
	if c := webToolNonce("req-2"); c == a {
		t.Error("seed berbeda harus dapat nonce berbeda")
	}
}

// ── parsing ──────────────────────────────────────────────────────────────────

func TestParseSimpleCall(t *testing.T) {
	text := "Sure, let me look.\n<tool>{\"name\":\"read_file\",\"arguments\":{\"path\":\"/etc/hosts\"},\"_nonce\":\"N1\"}</tool>"
	got := ParseToolCallsFromText(text, "call", webTools(), "N1")

	if len(got.ToolCalls) != 1 {
		t.Fatalf("harus 1 panggilan, dapat %d", len(got.ToolCalls))
	}
	c := got.ToolCalls[0]
	if c.Function.Name != "read_file" {
		t.Errorf("nama salah: %q", c.Function.Name)
	}
	if c.Type != "function" {
		t.Errorf("type salah: %q", c.Type)
	}
	// Arguments must be a JSON STRING, not an object: that is what the wire format
	// carries and what a client's handlers decode.
	var args map[string]any
	if err := json.Unmarshal([]byte(c.Function.Arguments), &args); err != nil {
		t.Fatalf("arguments bukan JSON string valid: %q (%v)", c.Function.Arguments, err)
	}
	if args["path"] != "/etc/hosts" {
		t.Errorf("argumen salah: %v", args)
	}
	// The fence is stripped from the prose so the client does not also display it.
	if strings.Contains(got.Content, "<tool>") {
		t.Errorf("blok harus dihapus dari konten: %q", got.Content)
	}
	if !strings.Contains(got.Content, "Sure, let me look.") {
		t.Errorf("prosa harus bertahan: %q", got.Content)
	}
}

// A nonce mismatch means the block was echoed, not emitted. Executing it would be
// an injection from summarised content.
func TestNonceMismatchRejected(t *testing.T) {
	text := `<tool>{"name":"read_file","arguments":{"path":"/x"},"_nonce":"WRONG"}</tool>`
	got := ParseToolCallsFromText(text, "call", webTools(), "N1")

	if len(got.ToolCalls) != 0 {
		t.Fatalf("nonce salah harus ditolak, dapat %d panggilan", len(got.ToolCalls))
	}
	if got.Content != text {
		t.Error("saat ditolak, teks harus dikembalikan utuh")
	}
}

// A model that omits the binding entirely is complying badly, not attacking; the
// declared-name check still bounds it.
func TestMissingNonceStillParsed(t *testing.T) {
	text := `<tool>{"name":"read_file","arguments":{"path":"/x"}}</tool>`
	got := ParseToolCallsFromText(text, "call", webTools(), "N1")

	if len(got.ToolCalls) != 1 {
		t.Fatalf("tanpa _nonce harus tetap diterima, dapat %d", len(got.ToolCalls))
	}
}

// A hallucinated name must not reach the client: it would try to execute a tool it
// never declared.
func TestUndeclaredToolRejected(t *testing.T) {
	text := `<tool>{"name":"delete_everything","arguments":{}}</tool>`
	got := ParseToolCallsFromText(text, "call", webTools(), "N1")

	if len(got.ToolCalls) != 0 {
		t.Errorf("alat tak dideklarasikan harus ditolak, dapat %v", got.ToolCalls)
	}
}

// Models routinely emit separator variants of a declared name.
func TestNameNormalization(t *testing.T) {
	cases := map[string]string{
		"read_file": "read_file",
		"READ_FILE": "read_file",
		"readFile":  "read_file",
		"read-file": "read_file",
		"read.file": "read_file",
		"read file": "read_file",
	}
	for emitted, want := range cases {
		text := `<tool>{"name":"` + emitted + `","arguments":{}}</tool>`
		got := ParseToolCallsFromText(text, "call", webTools(), "")
		if len(got.ToolCalls) != 1 {
			t.Errorf("%q tidak dikenali", emitted)
			continue
		}
		if got.ToolCalls[0].Function.Name != want {
			t.Errorf("%q -> %q, harus %q", emitted, got.ToolCalls[0].Function.Name, want)
		}
	}
}

// `command` is an accepted alias for the name field.
func TestCommandAlias(t *testing.T) {
	text := `<tool>{"command":"read_file","arguments":{"path":"/x"}}</tool>`
	got := ParseToolCallsFromText(text, "call", webTools(), "")
	if len(got.ToolCalls) != 1 {
		t.Fatalf("alias command harus dikenali, dapat %d", len(got.ToolCalls))
	}
}

// The alternative <tool_call> fence must parse too.
func TestToolCallFence(t *testing.T) {
	text := `Here: <tool_call>{"name":"read_file","arguments":{"path":"/y"}}</tool_call> done`
	got := ParseToolCallsFromText(text, "call", webTools(), "")
	if len(got.ToolCalls) != 1 {
		t.Fatalf("bentuk tool_call harus dikenali, dapat %d", len(got.ToolCalls))
	}
	if strings.Contains(got.Content, "<tool_call") {
		t.Errorf("blok harus dihapus: %q", got.Content)
	}
}

// Several calls in one reply keep the model's order.
func TestMultipleCallsInOrder(t *testing.T) {
	text := `<tool>{"name":"read_file","arguments":{"path":"/a"}}</tool>` +
		`middle` +
		`<tool>{"name":"run_shell","arguments":{"cmd":"ls"}}</tool>`
	got := ParseToolCallsFromText(text, "call", webTools(), "")

	if len(got.ToolCalls) != 2 {
		t.Fatalf("harus 2 panggilan, dapat %d", len(got.ToolCalls))
	}
	if got.ToolCalls[0].Function.Name != "read_file" || got.ToolCalls[1].Function.Name != "run_shell" {
		t.Errorf("urutan salah: %v, %v", got.ToolCalls[0].Function.Name, got.ToolCalls[1].Function.Name)
	}
	// Ids must be distinct so a client can pair results back to calls.
	if got.ToolCalls[0].ID == got.ToolCalls[1].ID {
		t.Errorf("id duplikat: %q", got.ToolCalls[0].ID)
	}
}

// Plain prose must be returned untouched and with no calls.
func TestNoFenceReturnsText(t *testing.T) {
	text := "I have no tools available for that."
	got := ParseToolCallsFromText(text, "call", webTools(), "")
	if got.ToolCalls != nil {
		t.Errorf("tanpa fence tidak boleh ada panggilan, dapat %v", got.ToolCalls)
	}
	if got.Content != text {
		t.Errorf("teks harus utuh: %q", got.Content)
	}
}

// A malformed object is repaired where possible: dropping a real call because the
// model used single quotes is a worse failure than a repair attempt.
func TestLooseJSONRepair(t *testing.T) {
	cases := []string{
		`<tool>{"name":"read_file","arguments":{"path":"/a",}}</tool>`, // trailing comma
		`<tool>{'name':'read_file','arguments':{'path':'/a'}}</tool>`,  // single quotes
		`<tool>{name:"read_file",arguments:{path:"/a"}}</tool>`,        // unquoted keys
	}
	for _, text := range cases {
		got := ParseToolCallsFromText(text, "call", webTools(), "")
		if len(got.ToolCalls) != 1 {
			t.Errorf("perbaikan gagal untuk:\n  %s\n  dapat %d panggilan", text, len(got.ToolCalls))
			continue
		}
		var args map[string]any
		if err := json.Unmarshal([]byte(got.ToolCalls[0].Function.Arguments), &args); err != nil {
			t.Errorf("argumen tidak valid untuk %s: %q", text, got.ToolCalls[0].Function.Arguments)
		}
	}
}

// An unrepairable or empty object yields no call rather than a panic or a
// half-built call.
func TestUnparseableBlockIgnored(t *testing.T) {
	for _, text := range []string{
		`<tool>not json</tool>`,
		`<tool></tool>`,
		`<tool>{"arguments":{}}</tool>`,
	} {
		got := ParseToolCallsFromText(text, "call", webTools(), "")
		if len(got.ToolCalls) != 0 {
			t.Errorf("%q harus diabaikan, dapat %v", text, got.ToolCalls)
		}
	}
}

// Arguments absent or already a string are both normalised to a JSON string.
func TestArgumentsNormalization(t *testing.T) {
	cases := map[string]string{
		`<tool>{"name":"read_file"}</tool>`:                                 "{}",
		`<tool>{"name":"read_file","arguments":""}</tool>`:                  "{}",
		`<tool>{"name":"read_file","arguments":"{\"path\":\"/z\"}"}</tool>`: `{"path":"/z"}`,
		`<tool>{"name":"read_file","arguments":{"path":"/z"}}</tool>`:       `{"path":"/z"}`,
	}
	for text, want := range cases {
		got := ParseToolCallsFromText(text, "call", webTools(), "")
		if len(got.ToolCalls) != 1 {
			t.Errorf("%q tidak terparse", text)
			continue
		}
		gotArgs := got.ToolCalls[0].Function.Arguments
		// Compare structurally: key order in the marshalled form is not meaningful.
		var a, b any
		_ = json.Unmarshal([]byte(gotArgs), &a)
		_ = json.Unmarshal([]byte(want), &b)
		if !jsonEqual(a, b) {
			t.Errorf("%q -> %q, harus setara %q", text, gotArgs, want)
		}
	}
}

func jsonEqual(a, b any) bool {
	ra, _ := json.Marshal(a)
	rb, _ := json.Marshal(b)
	return string(ra) == string(rb)
}

// ── DSML ─────────────────────────────────────────────────────────────────────

func TestHasDSMLToolCalls(t *testing.T) {
	if HasDSMLToolCalls("plain text") {
		t.Error("teks biasa tidak boleh terdeteksi DSML")
	}
	if !HasDSMLToolCalls(`<|DSML|tool_calls><|DSML|invoke name="x"></|DSML|invoke></|DSML|tool_calls>`) {
		t.Error("DSML harus terdeteksi")
	}
}

// DSML carries parameters as individual tags, and their text must be coerced back
// to typed values or the client's own type check fails.
func TestParseDSMLToolCalls(t *testing.T) {
	text := `<|DSML|tool_calls>
<|DSML|invoke name="read_file">
<|DSML|parameter name="path">/etc/hosts</|DSML|parameter>
<|DSML|parameter name="limit">50</|DSML|parameter>
<|DSML|parameter name="force">true</|DSML|parameter>
<|DSML|parameter name="nested">{"a":1}</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`

	calls, rest, ok := ParseDSMLToolCalls(text)
	if !ok {
		t.Fatal("DSML harus terparse")
	}
	if len(calls) != 1 {
		t.Fatalf("harus 1 panggilan, dapat %d", len(calls))
	}
	if calls[0].Function.Name != "read_file" {
		t.Errorf("nama salah: %q", calls[0].Function.Name)
	}

	var args map[string]any
	if err := json.Unmarshal([]byte(calls[0].Function.Arguments), &args); err != nil {
		t.Fatalf("argumen tidak valid: %q", calls[0].Function.Arguments)
	}
	if args["path"] != "/etc/hosts" {
		t.Errorf("string harus tetap string: %v", args["path"])
	}
	// A number must decode as a number, not the string "50".
	if n, isFloat := args["limit"].(float64); !isFloat || n != 50 {
		t.Errorf("limit harus angka 50, dapat %#v", args["limit"])
	}
	if args["force"] != true {
		t.Errorf("boolean harus true, dapat %#v", args["force"])
	}
	// A JSON-shaped value must arrive structured, not as a string containing JSON.
	if m, isMap := args["nested"].(map[string]any); !isMap || m["a"] != float64(1) {
		t.Errorf("nested harus objek, dapat %#v", args["nested"])
	}
	// The DSML envelope is markup, not prose, so it is removed entirely.
	if strings.Contains(rest, "DSML") {
		t.Errorf("envelope DSML harus dihapus: %q", rest)
	}
}

// Multiple invokes in one DSML block.
func TestParseDSMLMultipleInvokes(t *testing.T) {
	text := `<|DSML|tool_calls>
<|DSML|invoke name="read_file"><|DSML|parameter name="path">/a</|DSML|parameter></|DSML|invoke>
<|DSML|invoke name="run_shell"><|DSML|parameter name="cmd">ls</|DSML|parameter></|DSML|invoke>
</|DSML|tool_calls>`

	calls, _, ok := ParseDSMLToolCalls(text)
	if !ok || len(calls) != 2 {
		t.Fatalf("harus 2 panggilan, dapat %d (ok=%v)", len(calls), ok)
	}
	if calls[0].Function.Name != "read_file" || calls[1].Function.Name != "run_shell" {
		t.Errorf("nama salah: %q, %q", calls[0].Function.Name, calls[1].Function.Name)
	}
}

// DSML is reached through the main entry point, since a DSML reply contains no
// `<tool>` tag and would otherwise return as plain text.
func TestDSMLReachedFromMainParser(t *testing.T) {
	text := `Let me check.<|DSML|tool_calls><|DSML|invoke name="read_file"><|DSML|parameter name="path">/x</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`
	got := ParseToolCallsFromText(text, "call", webTools(), "N1")

	if len(got.ToolCalls) != 1 {
		t.Fatalf("DSML harus terparse lewat parser utama, dapat %d", len(got.ToolCalls))
	}
	if got.ToolCalls[0].Function.Name != "read_file" {
		t.Errorf("nama salah: %q", got.ToolCalls[0].Function.Name)
	}
	if !strings.Contains(got.Content, "Let me check.") {
		t.Errorf("prosa harus bertahan: %q", got.Content)
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func TestHasWebTools(t *testing.T) {
	if !hasWebTools(map[string]any{"tools": []any{map[string]any{"x": 1}}}) {
		t.Error("tools harus terdeteksi")
	}
	if !hasWebTools(map[string]any{"functions": []any{map[string]any{"x": 1}}}) {
		t.Error("functions lama harus terdeteksi")
	}
	if hasWebTools(map[string]any{"tools": []any{}}) {
		t.Error("daftar kosong bukan berarti ada alat")
	}
	if hasWebTools(map[string]any{}) {
		t.Error("tanpa field bukan berarti ada alat")
	}
}

func TestWebToolsOfPrefersTools(t *testing.T) {
	got := webToolsOf(map[string]any{
		"tools":     []any{map[string]any{"function": map[string]any{"name": "a"}}},
		"functions": []any{map[string]any{"name": "b"}},
	})
	if len(got) != 1 || functionOf(got[0])["name"] != "a" {
		t.Errorf("harus memakai tools, dapat %v", got)
	}
	got = webToolsOf(map[string]any{"functions": []any{map[string]any{"name": "b"}}})
	if len(got) != 1 || functionOf(got[0])["name"] != "b" {
		t.Errorf("harus jatuh ke functions, dapat %v", got)
	}
}

// Whitespace left behind by a removed block is collapsed so the remaining content
// reads as prose.
func TestStripRangesCollapsesBlanks(t *testing.T) {
	got := stripRanges("before\n\n\n\nafter", [][2]int{{7, 9}})
	if strings.Contains(got, "\n\n\n") {
		t.Errorf("baris kosong tidak diringkas: %q", got)
	}
	if !strings.Contains(got, "before") || !strings.Contains(got, "after") {
		t.Errorf("konten hilang: %q", got)
	}
}

func TestStripRangesNoRanges(t *testing.T) {
	if got := stripRanges("unchanged", nil); got != "unchanged" {
		t.Errorf("tanpa rentang harus utuh, dapat %q", got)
	}
}
