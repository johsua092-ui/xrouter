#!/usr/bin/env bash
# Bukti bahwa translator benar-benar mengubah body sebelum ke upstream.
#
# Caranya: pasang upstream palsu di localhost yang mencatat body masuk, arahkan
# provider ke sana lewat BaseURL di DB... tapi DB itu read-only dari sisi kita.
# Jadi cara yg dipakai: unit-level, panggil pipeline langsung dgn body Claude dan
# provider qoder, lalu cetak hasil konversinya. Ini menguji jalur kode yang sama
# yang dipakai gateway, tanpa perlu upstream nyata.
set -u
cd /root/xrouter
export PATH=/usr/local/go/bin:$PATH

cat > /tmp/translate_proof_test.go <<'GO'
package translate

import (
	"encoding/json"
	"testing"
)

// Body Claude Messages asli, seperti yang dikirim Claude Code.
func claudeBody() map[string]any {
	return map[string]any{
		"model":      "qwen3-coder",
		"max_tokens": 64,
		"system": []any{
			map[string]any{"type": "text", "text": "You are Claude Code."},
			map[string]any{"type": "text", "text": "be terse"},
		},
		"messages": []any{
			map[string]any{
				"role":    "user",
				"content": []any{map[string]any{"type": "text", "text": "hi"}},
			},
		},
	}
}

// Dengan translator: Claude -> OpenAI (pivot pertama).
func TestProofClaudeToOpenAIChangesBody(t *testing.T) {
	body := claudeBody()
	out, err := TranslateRequest(nil, body, PipelineOptions{
		Source: FormatClaude, Target: FormatOpenAI, Model: "qwen3-coder",
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. `system` array Claude harus lenyap, jadi pesan role=system.
	if _, masihAda := out["system"]; masihAda {
		t.Error("BUG: field `system` Claude masih ada setelah konversi ke OpenAI")
	}
	// 2. Content block-nya harus jadi string, bukan array of blocks.
	msgs, _ := out["messages"].([]any)
	if len(msgs) == 0 {
		t.Fatal("pesan hilang")
	}
	sys, _ := msgs[0].(map[string]any)
	if role, _ := sys["role"].(string); role != "system" {
		t.Errorf("pesan pertama role=%v, harus system", sys["role"])
	}
	// 3. System Claude Code + caller harus tergabung.
	text, _ := sys["content"].(string)
	if !contains(text, "be terse") || !contains(text, "Claude Code") {
		t.Errorf("system tidak tergabung dgn benar: %q", text)
	}

	b, _ := json.MarshalIndent(out, "", "  ")
	t.Logf("HASIL KONVERSI:\n%s", b)
}

// Tanpa translator (dialek sama): body harus LOLOS APA ADANYA.
func TestProofSameDialectPassesThrough(t *testing.T) {
	body := claudeBody()
	out, err := TranslateRequest(nil, body, PipelineOptions{
		Source: FormatClaude, Target: FormatClaude, Model: "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := out["system"]; !ok {
		t.Error("BUG: body dialek sama justru diubah")
	}
}

// Response: chunk OpenAI harus jadi frame SSE Claude.
func TestProofOpenAIChunkBecomesClaudeFrames(t *testing.T) {
	state := NewStreamState()
	chunk := map[string]any{
		"id":      "chatcmpl-abc123def456",
		"model":   "qwen3-coder",
		"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "hello"}}},
	}
	frames, err := TranslateResponse(nil, chunk, state, PipelineOptions{
		Source: FormatClaude, Target: FormatOpenAI,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) == 0 {
		t.Fatal("tidak ada frame dihasilkan")
	}
	// Frame pertama wajib message_start.
	if got, _ := frames[0]["type"].(string); got != "message_start" {
		t.Errorf("frame[0]=%v, harus message_start", frames[0]["type"])
	}
	b, _ := json.MarshalIndent(frames, "", "  ")
	t.Logf("FRAME SSE CLAUDE:\n%s", b)
}
GO

cp /tmp/translate_proof_test.go internal/translate/zz_proof_test.go
go test ./internal/translate/ -run 'TestProof' -v 2>&1 | head -70
rm -f internal/translate/zz_proof_test.go
