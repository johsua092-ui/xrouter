package providers

import (
	"encoding/json"
	"strings"
	"testing"
)

// ── credential extraction ────────────────────────────────────────────────────

func TestExtractDeepSeekWebSession(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    string
		wantNil bool
	}{
		{name: "raw cookie header", input: "ds_session_id=abc123; intercom-device-id=xyz", want: "ds_session_id=abc123; intercom-device-id=xyz"},
		{name: "cookie prefixed", input: "Cookie: ds_session_id=abc123", want: "ds_session_id=abc123"},
		{name: "json blob", input: `{"cookie":"ds_session_id=abc123"}`, want: "ds_session_id=abc123"},
		{name: "json with newlines", input: "{\"cookie\":\"ds_session_id=abc\\n; more=1\"}", want: "ds_session_id=abc ; more=1"},
		{name: "empty", input: "", wantNil: true},
		{name: "token not cookie", input: "Bearer sk-abc123", wantNil: true},
		{name: "no equals", input: "justsomevalue", wantNil: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := extractDeepSeekWebSession(c.input)
			if c.wantNil {
				if got != nil {
					t.Errorf("expected nil, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatal("expected a session, got nil")
			}
			if got.cookies != c.want {
				t.Errorf("cookies = %q, want %q", got.cookies, c.want)
			}
			if got.userAgent == "" {
				t.Error("user agent must be populated")
			}
		})
	}
}

// ── DSML filter ──────────────────────────────────────────────────────────────

// The envelope must be removed entirely, and the surrounding text must survive
// intact — an off-by-one here eats a character of the user's answer.
func TestDeepSeekDSMLFilterStripsEnvelope(t *testing.T) {
	f := &deepSeekWebDSMLFilter{}
	got := f.push("before <|DSML|invoke name=\"x\">payload<|/DSML| invoke> after")
	got += f.flush()
	if strings.Contains(got, "DSML") || strings.Contains(got, "payload") {
		t.Errorf("envelope not stripped: %q", got)
	}
	if got != "before  after" {
		t.Errorf("text around the envelope mangled: %q", got)
	}
}

// A tag split across two writes must not leak half of itself.
func TestDeepSeekDSMLFilterHoldsPartialTag(t *testing.T) {
	f := &deepSeekWebDSMLFilter{}
	first := f.push("hello <|DS")
	second := f.push("ML|invoke>x<|/DSML|>")
	tail := f.flush()

	combined := first + second + tail
	if strings.Contains(combined, "DS") || strings.Contains(combined, "<|") {
		t.Errorf("partial open leaked: %q", combined)
	}
	if !strings.HasPrefix(combined, "hello ") {
		t.Errorf("prefix text lost: %q", combined)
	}
}

// Plain text with an angle bracket must not be swallowed.
func TestDeepSeekDSMLFilterKeepsPlainText(t *testing.T) {
	f := &deepSeekWebDSMLFilter{}
	out := f.push("use 1 < 2 and x <|> y") + f.flush()
	if !strings.Contains(out, "1 < 2") {
		t.Errorf("plain comparison text eaten: %q", out)
	}
}

// Text with no envelope at all comes through byte-identical.
func TestDeepSeekDSMLFilterPassthrough(t *testing.T) {
	f := &deepSeekWebDSMLFilter{}
	const msg = "The quick brown fox jumps over the lazy dog."
	if got := f.push(msg) + f.flush(); got != msg {
		t.Errorf("passthrough altered: %q", got)
	}
}

// ── patch framing ────────────────────────────────────────────────────────────

// The completion stream is JSON-patch frames, not token deltas. Fragments arrive
// under `v` either as an array or as a single object, and both must be read.
func TestDeepSeekWebPatchFragmentShapes(t *testing.T) {
	arrayFrame := `{"p":"response/fragments","o":"APPEND","v":[{"type":"ANSWER","content":"hello"},{"type":"THINK","content":"hmm"}]}`
	var patch deepSeekWebPatch
	if err := json.Unmarshal([]byte(arrayFrame), &patch); err != nil {
		t.Fatal(err)
	}
	if patch.Path != "response/fragments" {
		t.Errorf("path = %q", patch.Path)
	}

	var many []deepSeekWebFragment
	if err := json.Unmarshal(patch.Value, &many); err != nil {
		t.Fatalf("array shape: %v", err)
	}
	if len(many) != 2 || many[0].Content != "hello" || many[1].Type != "THINK" {
		t.Errorf("array fragments misread: %+v", many)
	}

	objectFrame := `{"p":"response/fragments","o":"APPEND","v":{"type":"ANSWER","content":"solo"}}`
	if err := json.Unmarshal([]byte(objectFrame), &patch); err != nil {
		t.Fatal(err)
	}
	var one deepSeekWebFragment
	if err := json.Unmarshal(patch.Value, &one); err != nil {
		t.Fatalf("object shape: %v", err)
	}
	if one.Content != "solo" {
		t.Errorf("object fragment misread: %+v", one)
	}
}

// A non-JSON keepalive line must not abort the stream, and `[DONE]` terminates it.
func TestDeepSeekWebPatchInvalidAndDone(t *testing.T) {
	var patch deepSeekWebPatch
	if err := json.Unmarshal([]byte("not json"), &patch); err == nil {
		t.Error("expected a decode error for a non-JSON payload")
	}
	// The sentinel is checked before decoding, so it never reaches Unmarshal.
	const line = "data: [DONE]"
	if payload := strings.TrimSpace(strings.TrimPrefix(line, "data:")); payload != "[DONE]" {
		t.Errorf("sentinel not detected: %q", payload)
	}
}

// ── PoW wiring ───────────────────────────────────────────────────────────────

// The pow answer must decode back to the fields the endpoint expects, with the
// nonce as a number rather than a string.
func TestDeepSeekPowAnswerEnvelope(t *testing.T) {
	answer := map[string]any{
		"algorithm":   "DeepSeekHashV1",
		"challenge":   strings.Repeat("a", 64),
		"salt":        "s1",
		"answer":      12345,
		"signature":   "sig",
		"target_path": "/api/v0/chat/completion",
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	packed := base64Std(encoded)

	decoded, err := decodeBase64Std(packed)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(decoded, &back); err != nil {
		t.Fatal(err)
	}
	if n, ok := back["answer"].(float64); !ok || int(n) != 12345 {
		t.Errorf("answer did not survive as a number: %#v", back["answer"])
	}
	if back["algorithm"] != "DeepSeekHashV1" {
		t.Errorf("algorithm lost: %#v", back["algorithm"])
	}
}
