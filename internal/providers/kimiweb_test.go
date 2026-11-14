package providers

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
)

// ── credential extraction ────────────────────────────────────────────────────

// The dashboard invites a paste from DevTools, so every form a user can
// realistically copy must be accepted.
func TestExtractKimiAccessToken(t *testing.T) {
	cases := map[string]string{
		"plain-token-abc":                   "plain-token-abc",
		`{"access_token":"json-token"}`:     "json-token",
		`{"token":"tok-field"}`:             "tok-field",
		`"Bearer bare-bearer"`:              "bare-bearer",
		"authorization: Bearer hdr-token":   "hdr-token",
		"Authorization: bearer lower-token": "lower-token",
		"access_token=cookie-tok; other=1":  "cookie-tok",
		"kimi-auth=cookie-auth; other=2":    "cookie-auth",
		`{"refresh_token":"r"}`:             "", // refresh alone is not an access token
	}
	for input, want := range cases {
		if got := ExtractKimiAccessToken(input); got != want {
			t.Errorf("ExtractKimiAccessToken(%q) = %q, harus %q", input, got, want)
		}
	}
}

// A mis-pasted cookie header that matches nothing must be rejected, not sent as a
// token: sending it produces a 401 that looks like an expired credential.
func TestExtractKimiAccessTokenRejectsJunk(t *testing.T) {
	for _, input := range []string{"", "   ", "session=abc", "a=b;c=d", "some;thing"} {
		if got := ExtractKimiAccessToken(input); got != "" {
			t.Errorf("ExtractKimiAccessToken(%q) = %q, harus kosong", input, got)
		}
	}
}

func TestExtractKimiRefreshToken(t *testing.T) {
	cases := map[string]string{
		`{"access_token":"a","refresh_token":"refresh-me"}`: "refresh-me",
		"refresh_token=rt-cookie":                           "rt-cookie",
		"plain-refresh":                                     "", // no key, no match
		"":                                                  "",
	}
	for input, want := range cases {
		if got := ExtractKimiRefreshToken(input); got != want {
			t.Errorf("ExtractKimiRefreshToken(%q) = %q, harus %q", input, got, want)
		}
	}
}

// ── Connect framing ──────────────────────────────────────────────────────────

func TestFrameConnectMessage(t *testing.T) {
	payload := []byte(`{"a":1}`)
	framed := FrameConnectMessage(payload)

	if len(framed) != 5+len(payload) {
		t.Fatalf("panjang kerangka salah: %d", len(framed))
	}
	if framed[0] != 0 {
		t.Errorf("flag harus 0, dapat %d", framed[0])
	}
	if got := binary.BigEndian.Uint32(framed[1:5]); int(got) != len(payload) {
		t.Errorf("panjang header salah: %d, harus %d", got, len(payload))
	}
	if !bytes.Equal(framed[5:], payload) {
		t.Errorf("payload salah: %s", framed[5:])
	}
}

// The frame must round-trip, which is the property the whole protocol rests on.
func TestFrameRoundTrip(t *testing.T) {
	original := map[string]any{"chat_id": "", "scenario": "SCENARIO_K2D5", "n": float64(42)}
	payload, _ := json.Marshal(original)

	frame, consumed, err := DecodeKimiFrame(FrameConnectMessage(payload), 0)
	if err != nil {
		t.Fatalf("decode gagal: %v", err)
	}
	if consumed != len(payload)+5 {
		t.Errorf("consumed salah: %d, harus %d", consumed, len(payload)+5)
	}
	if frame.Message["scenario"] != "SCENARIO_K2D5" {
		t.Errorf("payload tidak utuh: %v", frame.Message)
	}
}

// A partial frame means "read more", NOT "invalid". Collapsing the two would
// truncate a legitimate stream.
func TestDecodeKimiFramePartial(t *testing.T) {
	framed := FrameConnectMessage([]byte(`{"x":1}`))

	// Header incomplete.
	if _, consumed, err := DecodeKimiFrame(framed[:3], 0); consumed != 0 || err != nil {
		t.Errorf("header sebagian harus minta lebih banyak: consumed=%d err=%v", consumed, err)
	}
	// Header complete, payload short.
	if _, consumed, err := DecodeKimiFrame(framed[:6], 0); consumed != 0 || err != nil {
		t.Errorf("payload sebagian harus minta lebih banyak: consumed=%d err=%v", consumed, err)
	}
	// Full frame decodes.
	if _, consumed, err := DecodeKimiFrame(framed, 0); consumed != len(framed) || err != nil {
		t.Errorf("frame penuh harus ter-decode: consumed=%d err=%v", consumed, err)
	}
}

// Decoding several frames from one buffer advances correctly.
func TestDecodeKimiFrameStream(t *testing.T) {
	var buf []byte
	for _, s := range []string{`{"i":1}`, `{"i":2}`, `{"i":3}`} {
		buf = append(buf, FrameConnectMessage([]byte(s))...)
	}

	offset, count := 0, 0
	for {
		frame, consumed, err := DecodeKimiFrame(buf, offset)
		if err != nil {
			t.Fatalf("frame %d gagal: %v", count, err)
		}
		if consumed == 0 {
			break
		}
		offset += consumed
		count++
		if frame.Message["i"] != float64(count) {
			t.Errorf("frame %d isi salah: %v", count, frame.Message)
		}
	}
	if count != 3 {
		t.Errorf("harus 3 frame, dapat %d", count)
	}
}

// An oversized length is a hard error, not "wait for more": no legitimate frame is
// that large and waiting would buffer without bound.
func TestDecodeKimiFrameOversize(t *testing.T) {
	buf := []byte{0, 0x7f, 0xff, 0xff, 0xff}
	_, consumed, err := DecodeKimiFrame(buf, 0)
	if err == nil || consumed != -1 {
		t.Errorf("frame raksasa harus error keras: consumed=%d err=%v", consumed, err)
	}
}

// A compressed frame is refused rather than mis-parsed.
func TestDecodeKimiFrameCompressed(t *testing.T) {
	framed := FrameConnectMessage([]byte(`{"a":1}`))
	framed[0] = kimiFlagCompressed
	_, consumed, err := DecodeKimiFrame(framed, 0)
	if err == nil || consumed != -1 {
		t.Errorf("frame terkompresi harus ditolak: consumed=%d err=%v", consumed, err)
	}
	if !strings.Contains(err.Error(), "compressed") {
		t.Errorf("pesan error harus menyebut kompresi: %v", err)
	}
}

// Unknown flag bits are refused rather than ignored.
func TestDecodeKimiFrameBadFlags(t *testing.T) {
	framed := FrameConnectMessage([]byte(`{"a":1}`))
	framed[0] = 0x08
	_, consumed, err := DecodeKimiFrame(framed, 0)
	if err == nil || consumed != -1 {
		t.Errorf("flag tak dikenal harus ditolak: consumed=%d err=%v", consumed, err)
	}
}

// A non-JSON payload is a hard error.
func TestDecodeKimiFrameBadJSON(t *testing.T) {
	framed := FrameConnectMessage([]byte(`{not json`))
	_, consumed, err := DecodeKimiFrame(framed, 0)
	if err == nil || consumed != -1 {
		t.Errorf("JSON rusak harus error: consumed=%d err=%v", consumed, err)
	}
}

// An empty payload is legal: the frame carries only flags.
func TestDecodeKimiFrameEmptyPayload(t *testing.T) {
	frame, consumed, err := DecodeKimiFrame(FrameConnectMessage(nil), 0)
	if err != nil {
		t.Fatalf("frame kosong tidak boleh error: %v", err)
	}
	if consumed != 5 {
		t.Errorf("consumed salah: %d", consumed)
	}
	if frame.Message != nil {
		t.Errorf("payload kosong harus tanpa pesan: %v", frame.Message)
	}
}

// The end-of-stream flag marks the terminal frame.
func TestEndStreamFlag(t *testing.T) {
	framed := FrameConnectMessage([]byte(`{"ok":true}`))
	framed[0] = kimiFlagEndStream
	frame, _, err := DecodeKimiFrame(framed, 0)
	if err != nil {
		t.Fatalf("decode gagal: %v", err)
	}
	if frame.Flags&kimiFlagEndStream == 0 {
		t.Error("flag end-stream harus terbaca")
	}
	if frame.EndStreamError() != "" {
		t.Errorf("tanpa error field harus kosong, dapat %q", frame.EndStreamError())
	}
}

// The endpoint error is read only from the terminal frame.
func TestEndStreamError(t *testing.T) {
	framed := FrameConnectMessage([]byte(`{"error":{"code":"RESOURCE_EXHAUSTED","message":"quota"}}`))
	framed[0] = kimiFlagEndStream
	frame, _, _ := DecodeKimiFrame(framed, 0)

	got := frame.EndStreamError()
	if !strings.Contains(got, "RESOURCE_EXHAUSTED") || !strings.Contains(got, "quota") {
		t.Errorf("error tidak terbaca: %q", got)
	}

	// An error on a NON-terminal frame is not fatal.
	mid := FrameConnectMessage([]byte(`{"error":{"code":"X","message":"y"}}`))
	frame, _, _ = DecodeKimiFrame(mid, 0)
	if frame.EndStreamError() != "" {
		t.Error("error di frame tengah tidak boleh dianggap fatal")
	}
}

// ── delta extraction ─────────────────────────────────────────────────────────

func TestExtractKimiDelta(t *testing.T) {
	cases := []struct {
		name string
		msg  string
		kind string
		text string
	}{
		{"append text", `{"op":"append","mask":"block.text.content","block":{"text":{"content":"Hel"}}}`, "text", "Hel"},
		{"append think", `{"op":"append","mask":"block.think.content","block":{"think":{"content":"hmm"}}}`, "think", "hmm"},
		{"set text", `{"op":"set","mask":"block.text","block":{"text":{"content":"Full"}}}`, "text", "Full"},
		{"set think", `{"op":"set","mask":"block.think","block":{"think":{"content":"Hmm"}}}`, "think", "Hmm"},
		{"empty text", `{"op":"append","mask":"block.text.content","block":{"text":{"content":""}}}`, "", ""},
		{"unknown mask", `{"op":"append","mask":"block.meta.x","block":{"meta":{"content":"m"}}}`, "", ""},
		{"unknown op", `{"op":"delete","mask":"block.text.content","block":{"text":{"content":"x"}}}`, "", ""},
		{"no block", `{"op":"append","mask":"block.text.content"}`, "", ""},
	}
	for _, c := range cases {
		var msg map[string]any
		if err := json.Unmarshal([]byte(c.msg), &msg); err != nil {
			t.Fatalf("%s: JSON uji rusak: %v", c.name, err)
		}
		got := ExtractKimiDelta(msg)
		if c.kind == "" {
			if got != nil {
				t.Errorf("%s: harus nil, dapat %+v", c.name, got)
			}
			continue
		}
		if got == nil {
			t.Errorf("%s: harus %s, dapat nil", c.name, c.kind)
			continue
		}
		if got.Kind != c.kind || got.Text != c.text {
			t.Errorf("%s: dapat %s/%q, harus %s/%q", c.name, got.Kind, got.Text, c.kind, c.text)
		}
	}
}

// Thinking is separated from text so a client can render it in its own channel.
func TestExtractKimiDeltaSeparatesThinking(t *testing.T) {
	var msg map[string]any
	_ = json.Unmarshal([]byte(`{"op":"append","mask":"block.think.content","block":{"think":{"content":"reasoning"}}}`), &msg)
	got := ExtractKimiDelta(msg)
	if got == nil || got.Kind != "think" {
		t.Fatalf("harus berpikir, dapat %+v", got)
	}
	if got.Kind == "text" {
		t.Error("reasoning tidak boleh bercampur ke output")
	}
}

func TestExtractKimiDeltaNil(t *testing.T) {
	if got := ExtractKimiDelta(nil); got != nil {
		t.Errorf("pesan nil harus nil, dapat %+v", got)
	}
}

// ── folding ──────────────────────────────────────────────────────────────────

func TestFoldKimiMessages(t *testing.T) {
	got, err := FoldKimiMessages([]any{
		map[string]any{"role": "system", "content": "You are terse."},
		map[string]any{"role": "system", "content": "Never apologise."},
		map[string]any{"role": "user", "content": "hi"},
		map[string]any{"role": "assistant", "content": "hello"},
		map[string]any{"role": "user", "content": "again"},
	})
	if err != nil {
		t.Fatalf("fold gagal: %v", err)
	}

	// Multiple system messages join into one, since the upstream takes a single
	// system prompt.
	if got.SystemPrompt != "You are terse.\n\nNever apologise." {
		t.Errorf("system prompt salah: %q", got.SystemPrompt)
	}
	// The first user turn is unprefixed; later ones are labelled.
	if !strings.HasPrefix(got.Prompt, "hi") {
		t.Errorf("giliran pertama harus tanpa label: %q", got.Prompt)
	}
	for _, want := range []string{"Assistant: hello", "User: again"} {
		if !strings.Contains(got.Prompt, want) {
			t.Errorf("prompt tidak memuat %q:\n%s", want, got.Prompt)
		}
	}
	// The system prompt must not leak into the conversation.
	if strings.Contains(got.Prompt, "terse") {
		t.Errorf("system prompt bocor ke percakapan:\n%s", got.Prompt)
	}
}

// A tool result is labelled so the model can tell it from user speech.
func TestFoldKimiToolResult(t *testing.T) {
	got, err := FoldKimiMessages([]any{
		map[string]any{"role": "user", "content": "read it"},
		map[string]any{"role": "tool", "name": "read_file", "content": "file contents"},
	})
	if err != nil {
		t.Fatalf("fold gagal: %v", err)
	}
	if !strings.Contains(got.Prompt, "[Tool Result (read_file)]:") {
		t.Errorf("hasil alat harus berlabel:\n%s", got.Prompt)
	}
	if !strings.Contains(got.Prompt, "file contents") {
		t.Errorf("isi hasil alat hilang:\n%s", got.Prompt)
	}
}

// A tool result without a name falls back to the call id, then to a generic label,
// so the turn is never rendered nameless.
func TestFoldKimiToolResultNameFallback(t *testing.T) {
	got, _ := FoldKimiMessages([]any{
		map[string]any{"role": "tool", "tool_call_id": "call_7", "content": "x"},
	})
	if !strings.Contains(got.Prompt, "[Tool Result (call_7)]:") {
		t.Errorf("harus jatuh ke id panggilan:\n%s", got.Prompt)
	}
	got, _ = FoldKimiMessages([]any{
		map[string]any{"role": "tool", "content": "x"},
	})
	if !strings.Contains(got.Prompt, "[Tool Result (tool)]:") {
		t.Errorf("harus jatuh ke label generik:\n%s", got.Prompt)
	}
}

// The model's own earlier call is rendered back so it does not repeat it.
func TestFoldKimiAssistantToolCall(t *testing.T) {
	got, err := FoldKimiMessages([]any{
		map[string]any{"role": "user", "content": "go"},
		map[string]any{
			"role":    "assistant",
			"content": "calling now",
			"tool_calls": []any{
				map[string]any{
					"id": "call_1",
					"function": map[string]any{
						"name":      "read_file",
						"arguments": `{"path":"/x"}`,
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("fold gagal: %v", err)
	}
	if !strings.Contains(got.Prompt, "Assistant: calling now") {
		t.Errorf("prosa asisten hilang:\n%s", got.Prompt)
	}
	if !strings.Contains(got.Prompt, "<tool>") || !strings.Contains(got.Prompt, "read_file") {
		t.Errorf("panggilan alat harus dirender:\n%s", got.Prompt)
	}
}

// Content parts are joined; a non-text part is refused rather than dropped.
func TestFoldKimiContentParts(t *testing.T) {
	got, err := FoldKimiMessages([]any{
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "part one "},
			map[string]any{"type": "input_text", "text": "part two"},
		}},
	})
	if err != nil {
		t.Fatalf("bagian teks harus diterima: %v", err)
	}
	if got.Prompt != "part one part two" {
		t.Errorf("bagian tidak tergabung: %q", got.Prompt)
	}

	// An image part is refused: silently dropping it would have the model answer
	// about a picture it never received.
	_, err = FoldKimiMessages([]any{
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "http://x/y.png"}},
		}},
	})
	if err == nil {
		t.Error("bagian gambar harus ditolak")
	}
}

// Non-string, non-array content is refused.
func TestFoldKimiBadContent(t *testing.T) {
	if _, err := FoldKimiMessages([]any{
		map[string]any{"role": "user", "content": 42},
	}); err == nil {
		t.Error("konten bertipe salah harus ditolak")
	}
}

// Nil content is an absent message, not an error.
func TestFoldKimiNilContent(t *testing.T) {
	got, err := FoldKimiMessages([]any{
		map[string]any{"role": "user", "content": nil},
		map[string]any{"role": "user", "content": "real"},
	})
	if err != nil {
		t.Fatalf("konten nil tidak boleh error: %v", err)
	}
	if got.Prompt != "real" {
		t.Errorf("pesan kosong harus dilewati: %q", got.Prompt)
	}
}

// ── request body ─────────────────────────────────────────────────────────────

func TestBuildKimiRequestBody(t *testing.T) {
	cfg := KimiWebModels["k3"]
	raw, err := BuildKimiRequestBody(KimiFoldedMessages{
		Prompt:       "hello",
		SystemPrompt: "be terse",
	}, cfg, cfg.DefaultReasoningEffort)
	if err != nil {
		t.Fatalf("build gagal: %v", err)
	}

	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("body bukan JSON: %v", err)
	}

	if body["scenario"] != "SCENARIO_K2D5" {
		t.Errorf("scenario salah: %v", body["scenario"])
	}
	// The message is the provider's own schema, not a messages array.
	msg, _ := body["message"].(map[string]any)
	if msg == nil {
		t.Fatal("message hilang")
	}
	if msg["role"] != "user" {
		t.Errorf("role salah: %v", msg["role"])
	}
	blocks, _ := msg["blocks"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("harus 1 blok, dapat %d", len(blocks))
	}
	block, _ := blocks[0].(map[string]any)
	text, _ := block["text"].(map[string]any)
	if text["content"] != "hello" {
		t.Errorf("prompt salah: %v", text["content"])
	}

	// Options carry thinking, the system prompt, and the reasoning effort.
	opts, _ := body["options"].(map[string]any)
	if opts["thinking"] != true {
		t.Errorf("thinking harus aktif: %v", opts["thinking"])
	}
	if opts["system_prompt"] != "be terse" {
		t.Errorf("system prompt salah: %v", opts["system_prompt"])
	}
	if opts["reasoning_effort"] != "REASONING_EFFORT_NONE" {
		t.Errorf("reasoning effort salah: %v", opts["reasoning_effort"])
	}
}

// Without a system prompt the field is omitted rather than sent empty, and the
// same goes for an unsupported reasoning effort.
func TestBuildKimiRequestBodyOmitsEmpty(t *testing.T) {
	raw, _ := BuildKimiRequestBody(KimiFoldedMessages{Prompt: "hi"}, KimiWebModels["k3"], "")
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	opts, _ := body["options"].(map[string]any)

	if _, present := opts["system_prompt"]; present {
		t.Error("system prompt kosong harus dihilangkan")
	}
	if _, present := opts["reasoning_effort"]; present {
		t.Error("reasoning effort kosong harus dihilangkan")
	}
	if opts["enable_plugin"] != false {
		t.Errorf("plugin harus nonaktif: %v", opts["enable_plugin"])
	}
}

// An unknown model is refused before any request is made: the scenario is
// model-specific and guessing it produces a confusing upstream error.
func TestKimiUnknownModel(t *testing.T) {
	if _, known := KimiWebModels["gpt-4"]; known {
		t.Error("model asing tidak boleh terdaftar")
	}
	if len(KimiWebModels) != 2 {
		t.Errorf("harus 2 model, dapat %d", len(KimiWebModels))
	}
	for id, cfg := range KimiWebModels {
		if cfg.Scenario == "" {
			t.Errorf("%s tanpa scenario", id)
		}
		if cfg.DefaultReasoningEffort == "" {
			t.Errorf("%s tanpa effort default", id)
		}
		// The default must be one the model actually declares support for.
		supported := false
		for _, e := range cfg.SupportedReasoning {
			if e == cfg.DefaultReasoningEffort {
				supported = true
			}
		}
		if !supported {
			t.Errorf("%s: effort default %q tidak ada di daftar didukung %v",
				id, cfg.DefaultReasoningEffort, cfg.SupportedReasoning)
		}
	}
}

// The framed body is what actually goes on the wire.
func TestKimiFramedBodyIsConnectFrame(t *testing.T) {
	raw, _ := BuildKimiRequestBody(KimiFoldedMessages{Prompt: "x"}, KimiWebModels["k3"], "")
	framed := FrameConnectMessage(raw)

	if framed[0] != 0 {
		t.Errorf("flag harus 0, dapat %d", framed[0])
	}
	if got := binary.BigEndian.Uint32(framed[1:5]); int(got) != len(raw) {
		t.Errorf("panjang header %d, payload %d", got, len(raw))
	}
	// The framed body must decode back to the same envelope.
	frame, _, err := DecodeKimiFrame(framed, 0)
	if err != nil {
		t.Fatalf("kerangka tidak bisa dibaca balik: %v", err)
	}
	if frame.Message["scenario"] != "SCENARIO_K2D5" {
		t.Errorf("envelope tidak utuh: %v", frame.Message)
	}
}
