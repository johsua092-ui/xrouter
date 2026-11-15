package providers

// Tests for the Kiro port.
//
// The framing is the part that cannot be eyeballed: EventStream is
// length-prefixed binary with two CRC32s, and a wrong offset does not raise an
// error — it yields plausible garbage that reaches the client as text. So these
// tests BUILD real frames (computing both checksums the way AWS does) rather
// than asserting against captured fixtures, and they split those frames across
// reads to exercise the buffering path.
//
// Coverage:
//   1. Frame encoder/decoder round trip, every header type.
//   2. Frame split across arbitrary read boundaries.
//   3. Both CRC failure modes (prelude and message).
//   4. Frame-bound arithmetic rejection (bad totals, oversize).
//   5. EventStream → SSE conversion: text, thinking hoisting, reasoning, code.
//   6. Tool accumulation: string fragments, object replacement, type flip.
//   7. Stop-reason merge and disposition taxonomy.
//   8. Session replay freeze/replay protocol.
//   9. Canonicalizer validation taxonomy.
//  10. Model resolution suffix folding.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"strings"
	"testing"

	"github.com/johsua092-ui/xrouter/internal/translate"
)

// ── frame construction ───────────────────────────────────────────────────────
//
// The encoder is the mirror of the decoder under test. Keeping it here rather
// than in the package is deliberate: a shared encoder would let one bug cancel
// another, and a test that validates the decoder against the decoder proves
// nothing.

type kiroTestHeader struct {
	name  string
	value any
	// kind is the EventStream header type byte. Zero means "infer from value".
	kind byte
}

// encodeKiroFrame builds one complete EventStream message:
//
//	[total u32][headers u32][prelude CRC u32][header block][payload][message CRC u32]
//
// All fields big-endian, both checksums IEEE CRC32 — matching the AWS spec the
// upstream follows.
func encodeKiroFrame(t *testing.T, headers []kiroTestHeader, payload []byte) []byte {
	t.Helper()

	var headerBlock []byte
	for _, h := range headers {
		kind := h.kind
		var valueBytes []byte

		switch v := h.value.(type) {
		case string:
			if kind == 0 {
				kind = 7
			}
			valueBytes = append(u16(len(v)), []byte(v)...)
		case []byte:
			if kind == 0 {
				kind = 6
			}
			valueBytes = append(u16(len(v)), v...)
		case bool:
			if kind == 0 {
				if v {
					kind = 0
				} else {
					kind = 1
				}
			}
		case int8:
			if kind == 0 {
				kind = 2
			}
			valueBytes = []byte{byte(v)}
		case int16:
			if kind == 0 {
				kind = 3
			}
			valueBytes = u16Bytes(uint16(v))
		case int32:
			if kind == 0 {
				kind = 4
			}
			valueBytes = u32Bytes(uint32(v))
		default:
			t.Fatalf("encodeKiroFrame: unsupported header value type %T", h.value)
		}

		headerBlock = append(headerBlock, byte(len(h.name)))
		headerBlock = append(headerBlock, []byte(h.name)...)
		headerBlock = append(headerBlock, kind)
		headerBlock = append(headerBlock, valueBytes...)
	}

	total := 12 + len(headerBlock) + len(payload) + 4
	frame := make([]byte, 0, total)
	frame = append(frame, u32Bytes(uint32(total))...)
	frame = append(frame, u32Bytes(uint32(len(headerBlock)))...)

	prelude := crc32.ChecksumIEEE(frame[:8])
	frame = append(frame, u32Bytes(prelude)...)
	frame = append(frame, headerBlock...)
	frame = append(frame, payload...)

	messageCRC := crc32.ChecksumIEEE(frame)
	frame = append(frame, u32Bytes(messageCRC)...)

	if len(frame) != total {
		t.Fatalf("encodeKiroFrame: built %d bytes, declared total %d", len(frame), total)
	}
	return frame
}

// kiroEventFrame is the common shape: an :event-type header plus a JSON payload.
func kiroEventFrame(t *testing.T, eventType string, payload any) []byte {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return encodeKiroFrame(t, []kiroTestHeader{
		{name: ":message-type", value: "event"},
		{name: ":event-type", value: eventType},
	}, raw)
}

func u16(n int) []byte         { return u16Bytes(uint16(n)) }
func u16Bytes(n uint16) []byte { b := make([]byte, 2); binary.BigEndian.PutUint16(b, n); return b }
func u32Bytes(n uint32) []byte { b := make([]byte, 4); binary.BigEndian.PutUint32(b, n); return b }

// ── 1. round trip ────────────────────────────────────────────────────────────

func TestKiroEventStreamRoundTrip(t *testing.T) {
	frames := [][]byte{
		kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "hello"}),
		kiroEventFrame(t, "reasoningContentEvent", map[string]any{"text": "weighing it"}),
		kiroEventFrame(t, "toolUseEvent", map[string]any{
			"toolUseId": "call_1", "name": "search", "input": `{"q":"x"}`,
		}),
		kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "end_turn"}),
	}
	blob := []byte{}
	for _, f := range frames {
		blob = append(blob, f...)
	}

	events, err := DecodeKiroEventStream(strings.NewReader(string(blob)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(events) != 4 {
		t.Fatalf("got %d events, want 4", len(events))
	}
	wantTypes := []string{
		"assistantResponseEvent", "reasoningContentEvent", "toolUseEvent", "messageStopEvent",
	}
	for i, want := range wantTypes {
		if got := events[i].HeaderValue(":event-type"); got != want {
			t.Errorf("event %d: type %q, want %q", i, got, want)
		}
	}
	if got, _ := events[0].Payload["content"].(string); got != "hello" {
		t.Errorf("event 0 content = %q", got)
	}
	if got, _ := events[3].Payload["stopReason"].(string); got != "end_turn" {
		t.Errorf("event 3 stopReason = %q", got)
	}
}

func TestKiroEventStreamHeaderTypes(t *testing.T) {
	// Every header type the decoder claims to walk, in one frame. The decoder
	// has to advance correctly past each one to reach the payload, so a wrong
	// width shows up as a failed payload assertion rather than a silent skip.
	frame := encodeKiroFrame(t, []kiroTestHeader{
		{name: ":message-type", value: "event"},
		{name: "bool-true", value: true},
		{name: "bool-false", value: false},
		{name: "i8", value: int8(-7)},
		{name: "i16", value: int16(1234)},
		{name: "i32", value: int32(70000)},
		{name: "blob", value: []byte{0xde, 0xad, 0xbe, 0xef}},
		{name: "str", value: "typed"},
	}, []byte(`{"ok":true}`))

	events, err := DecodeKiroEventStream(strings.NewReader(string(frame)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	h := events[0].Headers

	if v, _ := h["bool-true"].(bool); !v {
		t.Error("bool-true did not decode to true")
	}
	if v, ok := h["bool-false"].(bool); !ok || v {
		t.Error("bool-false did not decode to false")
	}
	if v, _ := h["i8"].(int8); v != -7 {
		t.Errorf("i8 = %v, want -7", h["i8"])
	}
	if v, _ := h["i16"].(int16); v != 1234 {
		t.Errorf("i16 = %v, want 1234", h["i16"])
	}
	if v, _ := h["i32"].(int32); v != 70000 {
		t.Errorf("i32 = %v, want 70000", h["i32"])
	}
	if v, _ := h["blob"].([]byte); string(v) != "\xde\xad\xbe\xef" {
		t.Errorf("blob = %v", h["blob"])
	}
	if v, _ := h["str"].(string); v != "typed" {
		t.Errorf("str = %v", v)
	}
	if ok, _ := events[0].Payload["ok"].(bool); !ok {
		t.Error("payload did not survive the header walk")
	}
}

func TestKiroEventStreamFrameWithNoPayload(t *testing.T) {
	frame := encodeKiroFrame(t, []kiroTestHeader{
		{name: ":message-type", value: "event"},
		{name: ":event-type", value: "metadataEvent"},
	}, nil)

	events, err := DecodeKiroEventStream(strings.NewReader(string(frame)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	if events[0].Payload != nil {
		t.Errorf("payload = %v, want nil for an empty body", events[0].Payload)
	}
}

func TestKiroEventStreamWhitespacePayloadTreatedAsAbsent(t *testing.T) {
	frame := encodeKiroFrame(t, []kiroTestHeader{
		{name: ":message-type", value: "event"},
	}, []byte("  \n\t "))

	events, err := DecodeKiroEventStream(strings.NewReader(string(frame)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if events[0].Payload != nil {
		t.Errorf("payload = %v, want nil for whitespace-only body", events[0].Payload)
	}
}

// ── 2. split reads ───────────────────────────────────────────────────────────

func TestKiroEventStreamSplitAcrossReads(t *testing.T) {
	// Three frames, replayed at every split point in the blob. The decoder owns
	// its own buffer, so no split may lose or duplicate a frame — including a
	// split inside the 12-byte prelude and inside a checksum.
	frames := [][]byte{
		kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "alpha"}),
		kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "beta"}),
		kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "end_turn"}),
	}
	blob := []byte{}
	for _, f := range frames {
		blob = append(blob, f...)
	}

	for split := 0; split <= len(blob); split++ {
		reader := &kiroChunkedReader{data: blob, steps: []int{split}}
		events, err := DecodeKiroEventStream(reader)
		if err != nil {
			t.Fatalf("split at %d: decode: %v", split, err)
		}
		if len(events) != 3 {
			t.Fatalf("split at %d: got %d events, want 3", split, len(events))
		}
		if got, _ := events[0].Payload["content"].(string); got != "alpha" {
			t.Fatalf("split at %d: first content = %q", split, got)
		}
		if got, _ := events[1].Payload["content"].(string); got != "beta" {
			t.Fatalf("split at %d: second content = %q", split, got)
		}
	}
}

func TestKiroEventStreamOneByteReads(t *testing.T) {
	// The worst case for the buffer: every frame arrives one byte per read.
	// Multiple frames per read is the complementary case below.
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "x"})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "end_turn"})...)

	decoder := NewKiroEventStreamDecoder()
	var events []KiroEvent
	for i := 0; i < len(blob); i++ {
		got, err := decoder.Push(blob[i : i+1])
		if err != nil {
			t.Fatalf("byte %d: %v", i, err)
		}
		events = append(events, got...)
	}
	if decoder.Buffered() != 0 {
		t.Errorf("buffered %d bytes after a complete stream", decoder.Buffered())
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
}

func TestKiroEventStreamMultipleFramesPerRead(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "a"})...)
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "b"})...)
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "c"})...)

	decoder := NewKiroEventStreamDecoder()
	events, err := decoder.Push(blob) // all three in one read
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("got %d events from one read, want 3", len(events))
	}
}

// kiroChunkedReader replays a blob with explicit read boundaries, so a split can
// be placed exactly where it hurts.
type kiroChunkedReader struct {
	data  []byte
	pos   int
	steps []int
}

func (r *kiroChunkedReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	take := len(p)
	if len(r.steps) > 0 {
		if r.steps[0] < take {
			take = r.steps[0]
		}
		r.steps = r.steps[1:]
	}
	if take == 0 {
		// A zero-byte read is legal for an io.Reader and must not spin the
		// decode loop; return one byte so progress is still made.
		take = 1
	}
	if r.pos+take > len(r.data) {
		take = len(r.data) - r.pos
	}
	n := copy(p, r.data[r.pos:r.pos+take])
	r.pos += n
	return n, nil
}

// ── 3. CRC failure modes ─────────────────────────────────────────────────────

func TestKiroEventStreamPreludeCRCFailure(t *testing.T) {
	frame := kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "hi"})
	frame[8] ^= 0xff // corrupt the prelude CRC

	_, err := DecodeKiroEventStream(strings.NewReader(string(frame)))
	if err == nil {
		t.Fatal("expected a prelude CRC error")
	}
	if !strings.Contains(err.Error(), "prelude CRC") {
		t.Errorf("error = %v, want a prelude CRC message", err)
	}
}

func TestKiroEventStreamMessageCRCFailure(t *testing.T) {
	frame := kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "hi"})
	frame[len(frame)-1] ^= 0xff // corrupt the trailing message CRC

	_, err := DecodeKiroEventStream(strings.NewReader(string(frame)))
	if err == nil {
		t.Fatal("expected a message CRC error")
	}
	if !strings.Contains(err.Error(), "message CRC") {
		t.Errorf("error = %v, want a message CRC message", err)
	}
}

func TestKiroEventStreamPayloadCorruptionDetected(t *testing.T) {
	// Flipping a payload byte breaks the message CRC, which is the whole point
	// of the checksum: a corrupted frame must not reach the client as text.
	frame := kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "trust-me"})
	frame[len(frame)-6] ^= 0x01

	_, err := DecodeKiroEventStream(strings.NewReader(string(frame)))
	if err == nil {
		t.Fatal("expected corruption to be detected")
	}
}

// ── 4. bounds arithmetic ─────────────────────────────────────────────────────

func TestKiroEventStreamRejectsOversizeTotal(t *testing.T) {
	frame := kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "hi"})
	binary.BigEndian.PutUint32(frame[0:4], uint32(KiroEventStreamMaxMessage+1))

	decoder := NewKiroEventStreamDecoder()
	_, err := decoder.Push(frame)
	if err == nil {
		t.Fatal("expected an oversize total to be rejected")
	}
	if !strings.Contains(err.Error(), "bounds are invalid") {
		t.Errorf("error = %v, want a bounds error", err)
	}
}

func TestKiroEventStreamRejectsUndersizeTotal(t *testing.T) {
	frame := kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "hi"})
	binary.BigEndian.PutUint32(frame[0:4], 15) // below the 16-byte floor
	binary.BigEndian.PutUint32(frame[8:12], crc32.ChecksumIEEE(frame[0:8]))

	decoder := NewKiroEventStreamDecoder()
	if _, err := decoder.Push(frame); err == nil {
		t.Fatal("expected a sub-16 total to be rejected")
	}
}

func TestKiroEventStreamRejectsHeadersLongerThanFrame(t *testing.T) {
	frame := kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "hi"})
	total := binary.BigEndian.Uint32(frame[0:4])
	binary.BigEndian.PutUint32(frame[4:8], total) // headers claim the whole frame
	binary.BigEndian.PutUint32(frame[8:12], crc32.ChecksumIEEE(frame[0:8]))

	decoder := NewKiroEventStreamDecoder()
	if _, err := decoder.Push(frame); err == nil {
		t.Fatal("expected headers > total-16 to be rejected")
	}
}

func TestKiroEventStreamTruncatedFrameIsReported(t *testing.T) {
	frame := kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "half"})
	partial := frame[:len(frame)-8] // frame header says more is coming

	_, err := DecodeKiroEventStream(strings.NewReader(string(partial)))
	if err == nil {
		t.Fatal("expected a truncated stream to be reported")
	}
	if !strings.Contains(err.Error(), "truncated") {
		t.Errorf("error = %v, want a truncation message", err)
	}
}

func TestKiroEventStreamPartialFrameStaysBuffered(t *testing.T) {
	frame := kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "waiting"})

	decoder := NewKiroEventStreamDecoder()
	events, err := decoder.Push(frame[:len(frame)-5])
	if err != nil {
		t.Fatalf("partial push returned an error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("got %d events from a partial frame, want 0", len(events))
	}
	if decoder.Buffered() != len(frame)-5 {
		t.Errorf("buffered %d, want %d", decoder.Buffered(), len(frame)-5)
	}

	events, err = decoder.Push(frame[len(frame)-5:])
	if err != nil {
		t.Fatalf("completing push: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events after completing the frame, want 1", len(events))
	}
}

func TestKiroEventStreamDuplicateHeaderRejected(t *testing.T) {
	frame := encodeKiroFrame(t, []kiroTestHeader{
		{name: "dup", value: "one"},
		{name: "dup", value: "two"},
	}, []byte(`{}`))

	_, err := DecodeKiroEventStream(strings.NewReader(string(frame)))
	if err == nil {
		t.Fatal("expected a duplicate header to be rejected")
	}
	if !strings.Contains(err.Error(), "duplicate header") {
		t.Errorf("error = %v, want a duplicate-header message", err)
	}
}

func TestKiroEventStreamUnknownHeaderTypeRejected(t *testing.T) {
	frame := encodeKiroFrame(t, []kiroTestHeader{
		{name: "weird", value: int32(1), kind: 42},
	}, []byte(`{}`))

	_, err := DecodeKiroEventStream(strings.NewReader(string(frame)))
	if err == nil {
		t.Fatal("expected an unknown header type to be rejected, not skipped")
	}
	if !strings.Contains(err.Error(), "unknown type") {
		t.Errorf("error = %v, want an unknown-type message", err)
	}
}

// TestKiroEventStreamHeaderLengthIncludesTypeByte is a regression guard for the
// header walk. The name length and the type byte are separate fields and the
// header block length counts both; getting this off by one desynchronises the
// payload read without failing any single bounds check.
func TestKiroEventStreamHeaderLengthIncludesTypeByte(t *testing.T) {
	// "abcdefgh" (8) + 1 type + 2 value-length + 3 value = 14 bytes per header,
	// plus a 1-byte name length. Two headers = 28 bytes of header block.
	frame := encodeKiroFrame(t, []kiroTestHeader{
		{name: "abcdefgh", value: "abc"},
		{name: ":event-type", value: "assistantResponseEvent"},
	}, []byte(`{"n":1}`))

	if got := binary.BigEndian.Uint32(frame[4:8]); got == 0 {
		t.Fatal("header block length is zero")
	}
	events, err := DecodeKiroEventStream(strings.NewReader(string(frame)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(events[0].Headers) != 2 {
		t.Fatalf("got %d headers, want 2", len(events[0].Headers))
	}
	if got, _ := events[0].Headers["abcdefgh"].(string); got != "abc" {
		t.Errorf("abcdefgh = %q, want \"abc\"", got)
	}
	if got, _ := events[0].Payload["n"].(float64); got != 1 {
		t.Errorf("payload n = %v, want 1", events[0].Payload["n"])
	}
}

// ── 5. EventStream → SSE ─────────────────────────────────────────────────────

// kiroSSEEvents splits an SSE blob into the JSON of each data frame, dropping
// [DONE] and comments — the shape assertions want the frames, not the framing.
func kiroSSEEvents(t *testing.T, raw []byte) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		body := strings.TrimPrefix(line, "data: ")
		if body == "[DONE]" {
			continue
		}
		var frame map[string]any
		if err := json.Unmarshal([]byte(body), &frame); err != nil {
			t.Fatalf("SSE frame is not valid JSON: %v (%s)", err, body)
		}
		out = append(out, frame)
	}
	return out
}

func kiroDeltaOf(t *testing.T, frame map[string]any) map[string]any {
	t.Helper()
	choices, _ := frame["choices"].([]any)
	if len(choices) == 0 {
		return nil
	}
	choice, _ := choices[0].(map[string]any)
	delta, _ := choice["delta"].(map[string]any)
	return delta
}

func kiroFinishOf(t *testing.T, frame map[string]any) string {
	t.Helper()
	choices, _ := frame["choices"].([]any)
	if len(choices) == 0 {
		return ""
	}
	choice, _ := choices[0].(map[string]any)
	reason, _ := choice["finish_reason"].(string)
	return reason
}

func TestKiroSSETextTurn(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "Hello"})...)
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": " world"})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "end_turn"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if !strings.Contains(string(out), "data: [DONE]") {
		t.Error("stream did not terminate with [DONE]")
	}

	frames := kiroSSEEvents(t, out)
	var text strings.Builder
	roleSeen := false
	for _, frame := range frames {
		delta := kiroDeltaOf(t, frame)
		if delta == nil {
			continue
		}
		if role, _ := delta["role"].(string); role == "assistant" {
			roleSeen = true
		}
		if content, _ := delta["content"].(string); content != "" {
			text.WriteString(content)
		}
	}
	if !roleSeen {
		t.Error("first delta did not carry role=assistant")
	}
	if got := text.String(); got != "Hello world" {
		t.Errorf("assembled text = %q, want \"Hello world\"", got)
	}

	last := frames[len(frames)-1]
	if got := kiroFinishOf(t, last); got != "stop" {
		t.Errorf("finish_reason = %q, want \"stop\"", got)
	}
}

func TestKiroSSEStripsInlineThinking(t *testing.T) {
	// The thinking span opens in one frame and closes in a later one, so the
	// visible text must come out clean and the span must reappear as
	// reasoning_content.
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "before<thinking>we"})...)
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "ighing it</thinking>after"})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "end_turn"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	var visible, reasoning strings.Builder
	for _, frame := range kiroSSEEvents(t, out) {
		delta := kiroDeltaOf(t, frame)
		if delta == nil {
			continue
		}
		if c, _ := delta["content"].(string); c != "" {
			visible.WriteString(c)
		}
		if r, _ := delta["reasoning_content"].(string); r != "" {
			reasoning.WriteString(r)
		}
	}
	if got := visible.String(); got != "beforeafter" {
		t.Errorf("visible = %q, want \"beforeafter\"", got)
	}
	if strings.Contains(visible.String(), "thinking") {
		t.Error("raw thinking tags leaked into the visible text")
	}
	if got := reasoning.String(); got != "weighing it" {
		t.Errorf("reasoning = %q, want \"weighing it\"", got)
	}
}

func TestKiroSSEReasoningEvent(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "reasoningContentEvent", map[string]any{"text": "step one"})...)
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "answer"})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "end_turn"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	var reasoning, visible strings.Builder
	for _, frame := range kiroSSEEvents(t, out) {
		delta := kiroDeltaOf(t, frame)
		if delta == nil {
			continue
		}
		if r, _ := delta["reasoning_content"].(string); r != "" {
			reasoning.WriteString(r)
		}
		if c, _ := delta["content"].(string); c != "" {
			visible.WriteString(c)
		}
	}
	if got := reasoning.String(); got != "step one" {
		t.Errorf("reasoning = %q, want \"step one\"", got)
	}
	if got := visible.String(); got != "answer" {
		t.Errorf("visible = %q, want \"answer\"", got)
	}
}

func TestKiroSSECodeEventBecomesContent(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "codeEvent", map[string]any{"content": "func main() {}"})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "end_turn"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	var visible strings.Builder
	for _, frame := range kiroSSEEvents(t, out) {
		if delta := kiroDeltaOf(t, frame); delta != nil {
			if c, _ := delta["content"].(string); c != "" {
				visible.WriteString(c)
			}
		}
	}
	if got := visible.String(); got != "func main() {}" {
		t.Errorf("code event content = %q", got)
	}
}

func TestKiroSSEUsageFromMetrics(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "hi"})...)
	blob = append(blob, kiroEventFrame(t, "metricsEvent", map[string]any{
		"inputTokens": 12, "outputTokens": 34,
		"cacheReadInputTokens": 5, "cacheCreationInputTokens": 7,
	})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "end_turn"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	frames := kiroSSEEvents(t, out)
	last := frames[len(frames)-1]

	usage, _ := last["usage"].(map[string]any)
	if usage == nil {
		t.Fatal("final frame carried no usage")
	}
	if got, _ := usage["prompt_tokens"].(float64); got != 12 {
		t.Errorf("prompt_tokens = %v, want 12", usage["prompt_tokens"])
	}
	if got, _ := usage["completion_tokens"].(float64); got != 34 {
		t.Errorf("completion_tokens = %v, want 34", usage["completion_tokens"])
	}
	if got, _ := usage["total_tokens"].(float64); got != 46 {
		t.Errorf("total_tokens = %v, want 46", usage["total_tokens"])
	}
	if got, _ := usage["cache_read_input_tokens"].(float64); got != 5 {
		t.Errorf("cache_read_input_tokens = %v, want 5", usage["cache_read_input_tokens"])
	}
	if got, _ := usage["cache_creation_input_tokens"].(float64); got != 7 {
		t.Errorf("cache_creation_input_tokens = %v, want 7", usage["cache_creation_input_tokens"])
	}
}

func TestKiroSSEEmptyTurnIsAnError(t *testing.T) {
	// A stream that ends with no output and no stop reason reads downstream as a
	// hang, so it must be an explicit error with a [DONE].
	blob := kiroEventFrame(t, "contextUsageEvent", map[string]any{"contextUsagePercentage": 10})

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	text := string(out)
	if !strings.Contains(text, "kiro_missing_terminal") {
		t.Errorf("expected a missing-terminal error, got:\n%s", text)
	}
	if !strings.Contains(text, "data: [DONE]") {
		t.Error("error stream did not terminate with [DONE]")
	}
}

func TestKiroSSEEventStreamErrorFrameBecomesTerminalError(t *testing.T) {
	blob := encodeKiroFrame(t, []kiroTestHeader{
		{name: ":message-type", value: "error"},
		{name: ":event-type", value: "internalServerException"},
		{name: ":error-message", value: "boom"},
	}, []byte(`{"message":"upstream said no"}`))

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	text := string(out)
	if !strings.Contains(text, "kiro_upstream_eventstream_error") {
		t.Errorf("expected an eventstream error code, got:\n%s", text)
	}
	if !strings.Contains(text, "data: [DONE]") {
		t.Error("error stream did not terminate with [DONE]")
	}
}

func TestKiroSSETruncationAfterOutputBecomesLength(t *testing.T) {
	// Content already streamed plus a budget stop is a truncated answer, not a
	// failed turn: finish_reason "length" preserves what the client received.
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "partial answer"})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "max_tokens"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	frames := kiroSSEEvents(t, out)
	if got := kiroFinishOf(t, frames[len(frames)-1]); got != "length" {
		t.Errorf("finish_reason = %q, want \"length\"", got)
	}
	if strings.Contains(string(out), "terminal_incomplete") {
		t.Error("a truncated-but-usable turn was reported as a terminal failure")
	}
}

func TestKiroSSERefusalIsTerminal(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "I can"})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "content_filtered"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if !strings.Contains(string(out), "kiro_terminal_refusal") {
		t.Errorf("expected a refusal terminal, got:\n%s", out)
	}
}

func TestKiroSSEMetadataStopReasonHonoured(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "hi"})...)
	blob = append(blob, kiroEventFrame(t, "metadataEvent", map[string]any{
		"metadataEvent": map[string]any{"stopReason": "end_turn"},
	})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	frames := kiroSSEEvents(t, out)
	if got := kiroFinishOf(t, frames[len(frames)-1]); got != "stop" {
		t.Errorf("finish_reason = %q, want \"stop\"", got)
	}
}

func TestKiroSSEEmptyResponseEventDoesNotEmitBlankDelta(t *testing.T) {
	// An empty assistantResponseEvent is a no-op, not a blank content delta:
	// strict clients render an empty delta as a visible gap.
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": ""})...)
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "real"})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "end_turn"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	for _, frame := range kiroSSEEvents(t, out) {
		delta := kiroDeltaOf(t, frame)
		if delta == nil {
			continue
		}
		if content, has := delta["content"]; has {
			if s, _ := content.(string); s == "" {
				t.Error("an empty content delta was emitted")
			}
		}
	}
}

// ── 6. tool calls ────────────────────────────────────────────────────────────

func TestKiroSSEToolCallStringFragments(t *testing.T) {
	// Kiro streams the input as fragments to be concatenated. Two echoes of the
	// same call, second carrying the remainder.
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_abc", "name": "search", "input": `{"q":`,
	})...)
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_abc", "name": "search", "input": `"kiro"}`,
	})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "tool_use"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	var declared, args string
	for _, frame := range kiroSSEEvents(t, out) {
		delta := kiroDeltaOf(t, frame)
		if delta == nil {
			continue
		}
		calls, _ := delta["tool_calls"].([]any)
		for _, raw := range calls {
			call, _ := raw.(map[string]any)
			if id, _ := call["id"].(string); id == "call_abc" {
				declared = id
			}
			if fn, _ := call["function"].(map[string]any); fn != nil {
				if a, _ := fn["arguments"].(string); a != "" {
					args = a
				}
			}
		}
	}
	if declared != "call_abc" {
		t.Errorf("tool call was not declared with its id (declared=%q)", declared)
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(args), &parsed); err != nil {
		t.Fatalf("tool arguments are not valid JSON: %v (%q)", err, args)
	}
	if got, _ := parsed["q"].(string); got != "kiro" {
		t.Errorf("tool argument q = %q, want \"kiro\"", got)
	}

	frames := kiroSSEEvents(t, out)
	if got := kiroFinishOf(t, frames[len(frames)-1]); got != "tool_calls" {
		t.Errorf("finish_reason = %q, want \"tool_calls\"", got)
	}
}

func TestKiroSSEToolCallObjectInputReplaces(t *testing.T) {
	// An object fragment replaces rather than appends: it is a complete value,
	// not a chunk of one.
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_obj", "name": "calc", "input": map[string]any{"expr": "1+1", "precision": 3},
	})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "tool_use"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	var args string
	for _, frame := range kiroSSEEvents(t, out) {
		delta := kiroDeltaOf(t, frame)
		if delta == nil {
			continue
		}
		calls, _ := delta["tool_calls"].([]any)
		for _, raw := range calls {
			call, _ := raw.(map[string]any)
			if fn, _ := call["function"].(map[string]any); fn != nil {
				if a, _ := fn["arguments"].(string); a != "" {
					args = a
				}
			}
		}
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(args), &parsed); err != nil {
		t.Fatalf("arguments are not valid JSON: %v (%q)", err, args)
	}
	if got, _ := parsed["expr"].(string); got != "1+1" {
		t.Errorf("expr = %q, want \"1+1\"", got)
	}
	if got, _ := parsed["precision"].(float64); got != 3 {
		t.Errorf("precision = %v, want 3", parsed["precision"])
	}
}

func TestKiroSSEToolInputTypeFlipIsCorruption(t *testing.T) {
	// A fragment-type change joins into JSON with the wrong shape. Dropping the
	// call is strictly safer than emitting arguments the client will misread, and
	// the turn must not be reported as a success.
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_flip", "name": "search", "input": `{"q":"a`,
	})...)
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_flip", "name": "search", "input": map[string]any{"q": "a"},
	})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "tool_use"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	text := string(out)
	if !strings.Contains(text, "invalid_kiro_tool_call") {
		t.Errorf("expected the corrupt call to be reported, got:\n%s", text)
	}
}

func TestKiroSSEToolRenameMidCallDropped(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_rn", "name": "first", "input": `{"a":1}`,
	})...)
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_rn", "name": "second", "input": `{"b":2}`,
	})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "tool_use"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	// The buffer is discarded, so no call should reach the client under either
	// name with mismatched arguments.
	text := string(out)
	if strings.Contains(text, `"arguments":"{\"b\"`) {
		t.Error("a renamed tool call was emitted")
	}
}

func TestKiroSSEMultipleToolCallsAllEmitted(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_1", "name": "alpha", "input": `{"x":1}`,
	})...)
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_2", "name": "beta", "input": `{"y":2}`,
	})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "tool_use"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	seen := map[string]bool{}
	for _, frame := range kiroSSEEvents(t, out) {
		delta := kiroDeltaOf(t, frame)
		if delta == nil {
			continue
		}
		calls, _ := delta["tool_calls"].([]any)
		for _, raw := range calls {
			call, _ := raw.(map[string]any)
			if id, _ := call["id"].(string); id != "" {
				seen[id] = true
			}
		}
	}
	if !seen["call_1"] || !seen["call_2"] {
		t.Errorf("not every tool call reached the client: %v", seen)
	}
}

func TestKiroSSEToolCallWithoutIDGetsSynthetic(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"name": "no_id_tool", "input": `{"k":1}`,
	})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "tool_use"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	found := false
	for _, frame := range kiroSSEEvents(t, out) {
		delta := kiroDeltaOf(t, frame)
		if delta == nil {
			continue
		}
		calls, _ := delta["tool_calls"].([]any)
		for _, raw := range calls {
			call, _ := raw.(map[string]any)
			if id, _ := call["id"].(string); strings.HasPrefix(id, "call_") {
				found = true
			}
		}
	}
	if !found {
		t.Error("a tool call without an upstream id was not given a synthetic one")
	}
}

func TestKiroSSEMCPEnvelopeValidation(t *testing.T) {
	// The upstream wraps MCP calls in a tool_call envelope; an envelope missing
	// the nested name or arguments is not deliverable.
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_mcp", "name": "tool_call", "input": `{"arguments":{"a":1}}`,
	})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "tool_use"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if !strings.Contains(string(out), "missing nested MCP tool name") {
		t.Errorf("expected the malformed envelope to be reported, got:\n%s", out)
	}
}

func TestKiroSSEValidMCPEnvelopePasses(t *testing.T) {
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "toolUseEvent", map[string]any{
		"toolUseId": "call_mcp_ok", "name": "tool_call",
		"input": `{"name":"real_tool","arguments":{"a":1}}`,
	})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "tool_use"})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if strings.Contains(string(out), "invalid_kiro_tool_call") {
		t.Errorf("a well-formed envelope was rejected:\n%s", out)
	}
}

// ── 7. stop reasons ──────────────────────────────────────────────────────────

func TestKiroStopDispositionTaxonomy(t *testing.T) {
	cases := []struct {
		reason   string
		tools    bool
		expected string
	}{
		{"end_turn", false, "complete"},
		{"", false, "complete"},
		{"tool_use", false, "tool_use"},
		{"", true, "tool_use"},
		{"max_tokens", false, "length"},
		{"max_tokens", true, "terminal_incomplete"},
		{"model_context_window_exceeded", false, "terminal_incomplete"},
		{"cancelled", false, "terminal_incomplete"},
		{"pause_turn", false, "terminal_incomplete"},
		{"refusal", false, "terminal_refusal"},
		{"content_filtered", false, "terminal_refusal"},
		{"guardrail_intervened", false, "terminal_refusal"},
		{"malformed_model_output", false, "retryable_protocol_failure"},
		{"something_new", false, "unknown_failure"},
	}
	for _, tc := range cases {
		got := kiroStopDisposition(tc.reason, tc.tools)
		if got != tc.expected {
			t.Errorf("disposition(%q, tools=%v) = %q, want %q", tc.reason, tc.tools, got, tc.expected)
		}
	}
}

func TestKiroStopReasonNormalisation(t *testing.T) {
	cases := map[string]string{
		"endTurn":           "end_turn",
		"end_turn":          "end_turn",
		"stop":              "end_turn",
		"stopSequence":      "end_turn",
		"toolUse":           "tool_use",
		"tool_calls":        "tool_use",
		"maxTokens":         "max_tokens",
		"length":            "max_tokens",
		"max_output_tokens": "max_tokens",
	}
	for input, want := range cases {
		if got := normalizeKiroStopReason(input); got != want {
			t.Errorf("normalize(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestKiroStopReasonMergeKeepsMostSevere(t *testing.T) {
	// A later "end_turn" must not erase an earlier refusal.
	if got := mergeKiroStopReason("refusal", "end_turn"); got != "refusal" {
		t.Errorf("merge(refusal, end_turn) = %q, want \"refusal\"", got)
	}
	if got := mergeKiroStopReason("end_turn", "max_tokens"); got != "max_tokens" {
		t.Errorf("merge(end_turn, max_tokens) = %q, want \"max_tokens\"", got)
	}
	if got := mergeKiroStopReason("", "end_turn"); got != "end_turn" {
		t.Errorf("merge(\"\", end_turn) = %q, want \"end_turn\"", got)
	}
	if got := mergeKiroStopReason("end_turn", ""); got != "end_turn" {
		t.Errorf("merge(end_turn, \"\") = %q, want \"end_turn\"", got)
	}
}

func TestKiroSSEStopSeverityAcrossFrames(t *testing.T) {
	// metadataEvent and messageStopEvent both report a stop; the severe one wins
	// regardless of arrival order.
	blob := []byte{}
	blob = append(blob, kiroEventFrame(t, "assistantResponseEvent", map[string]any{"content": "hi"})...)
	blob = append(blob, kiroEventFrame(t, "messageStopEvent", map[string]any{"stopReason": "refusal"})...)
	blob = append(blob, kiroEventFrame(t, "metadataEvent", map[string]any{
		"metadataEvent": map[string]any{"stopReason": "end_turn"},
	})...)

	out, err := kiroSSEFromBytes("claude-sonnet-4.5", blob)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if !strings.Contains(string(out), "kiro_terminal_refusal") {
		t.Errorf("the later end_turn erased the refusal:\n%s", out)
	}
}

// ── 8. session replay ────────────────────────────────────────────────────────

func TestKiroReplayFreezesFirstTurn(t *testing.T) {
	store := NewKiroReplayStore()
	history := []any{
		map[string]any{"userInputMessage": map[string]any{"content": "first question"}},
		map[string]any{"assistantResponseMessage": map[string]any{"content": "first answer"}},
	}
	current := map[string]any{"userInputMessage": map[string]any{"content": "second question"}}

	result := store.ApplyKiroSessionReplay(
		"conv-1", "conn-1", "claude-sonnet-4.5",
		"system prompt", "PREFIX-A", "TIME-A",
		history, current,
	)
	if result.Replayed {
		t.Error("a fresh session reported itself as replayed")
	}
	if store.Size() != 1 {
		t.Errorf("store size = %d after one conversation, want 1", store.Size())
	}

	// The frozen start carries the prefix; the current turn carries only its own.
	start, _ := result.History[0].(map[string]any)
	startUser, _ := start["userInputMessage"].(map[string]any)
	startContent, _ := startUser["content"].(string)
	if !strings.HasPrefix(startContent, "PREFIX-A") {
		t.Errorf("frozen start does not carry the prefix: %q", startContent)
	}

	curUser, _ := result.CurrentMessage["userInputMessage"].(map[string]any)
	curContent, _ := curUser["content"].(string)
	if strings.HasPrefix(curContent, "PREFIX-A") {
		t.Error("the current turn received the cacheable prefix as well")
	}
	if !strings.HasPrefix(curContent, "TIME-A") {
		t.Errorf("current turn is missing the time context: %q", curContent)
	}
}

func TestKiroReplayReplaysIdenticalStartOnSecondCall(t *testing.T) {
	store := NewKiroReplayStore()
	first := store.ApplyKiroSessionReplay(
		"conv-2", "conn-2", "claude-sonnet-4.5",
		"sys", "PREFIX", "TIME-1",
		[]any{
			map[string]any{"userInputMessage": map[string]any{"content": "q1"}},
			map[string]any{"assistantResponseMessage": map[string]any{"content": "a1"}},
		},
		map[string]any{"userInputMessage": map[string]any{"content": "q2"}},
	)
	frozenStart, _ := first.History[0].(map[string]any)
	frozenContent := ""
	if u, ok := frozenStart["userInputMessage"].(map[string]any); ok {
		frozenContent, _ = u["content"].(string)
	}

	// Second call: the client re-sends the whole conversation, with a different
	// opening turn (which the replay must overwrite with the frozen one).
	second := store.ApplyKiroSessionReplay(
		"conv-2", "conn-2", "claude-sonnet-4.5",
		"sys", "PREFIX", "TIME-2",
		[]any{
			map[string]any{"userInputMessage": map[string]any{"content": "q1 BUT EDITED"}},
			map[string]any{"assistantResponseMessage": map[string]any{"content": "a1"}},
			map[string]any{"userInputMessage": map[string]any{"content": "q2"}},
			map[string]any{"assistantResponseMessage": map[string]any{"content": "a2"}},
		},
		map[string]any{"userInputMessage": map[string]any{"content": "q3"}},
	)
	if !second.Replayed {
		t.Fatal("the second turn of the same conversation was not replayed")
	}

	replayedStart, _ := second.History[0].(map[string]any)
	replayedUser, _ := replayedStart["userInputMessage"].(map[string]any)
	replayedContent, _ := replayedUser["content"].(string)
	if replayedContent != frozenContent {
		t.Errorf("the frozen start changed between calls:\n first=%q\nsecond=%q", frozenContent, replayedContent)
	}
	if strings.Contains(replayedContent, "EDITED") {
		t.Error("the client's edited opening turn leaked through the replay")
	}

	// The volatile time context belongs on the current turn only.
	curUser, _ := second.CurrentMessage["userInputMessage"].(map[string]any)
	curContent, _ := curUser["content"].(string)
	if !strings.HasPrefix(curContent, "TIME-2") {
		t.Errorf("the current turn did not receive the fresh time context: %q", curContent)
	}
}

func TestKiroReplayDifferentModelDoesNotReuse(t *testing.T) {
	store := NewKiroReplayStore()
	store.ApplyKiroSessionReplay(
		"conv-3", "conn-3", "claude-sonnet-4.5", "sys", "P", "T",
		[]any{map[string]any{"userInputMessage": map[string]any{"content": "q"}}},
		map[string]any{"userInputMessage": map[string]any{"content": "c"}},
	)
	result := store.ApplyKiroSessionReplay(
		"conv-3", "conn-3", "claude-opus-4.1", "sys", "P", "T",
		[]any{map[string]any{"userInputMessage": map[string]any{"content": "q"}}},
		map[string]any{"userInputMessage": map[string]any{"content": "c"}},
	)
	if result.Replayed {
		t.Error("a session was replayed across a model change")
	}
}

func TestKiroReplayDifferentSystemPromptDoesNotReuse(t *testing.T) {
	store := NewKiroReplayStore()
	store.ApplyKiroSessionReplay(
		"conv-4", "conn-4", "m", "sys-a", "P", "T",
		[]any{map[string]any{"userInputMessage": map[string]any{"content": "q"}}},
		map[string]any{"userInputMessage": map[string]any{"content": "c"}},
	)
	result := store.ApplyKiroSessionReplay(
		"conv-4", "conn-4", "m", "sys-b", "P", "T",
		[]any{map[string]any{"userInputMessage": map[string]any{"content": "q"}}},
		map[string]any{"userInputMessage": map[string]any{"content": "c"}},
	)
	if result.Replayed {
		t.Error("a session was replayed across a system-prompt change")
	}
}

func TestKiroReplayEmptyConversationIDIsNotStored(t *testing.T) {
	store := NewKiroReplayStore()
	store.ApplyKiroSessionReplay(
		"", "conn-5", "m", "sys", "P", "T",
		[]any{map[string]any{"userInputMessage": map[string]any{"content": "q"}}},
		map[string]any{"userInputMessage": map[string]any{"content": "c"}},
	)
	if store.Size() != 0 {
		t.Errorf("store size = %d for an empty conversation id, want 0", store.Size())
	}
}

func TestKiroReplayClear(t *testing.T) {
	store := NewKiroReplayStore()
	store.ApplyKiroSessionReplay(
		"conv-6", "conn-6", "m", "sys", "P", "T",
		[]any{map[string]any{"userInputMessage": map[string]any{"content": "q"}}},
		map[string]any{"userInputMessage": map[string]any{"content": "c"}},
	)
	if store.Size() == 0 {
		t.Fatal("nothing was stored")
	}
	store.Clear()
	if store.Size() != 0 {
		t.Errorf("store size = %d after Clear, want 0", store.Size())
	}
}

func TestKiroReplayStoreIsBounded(t *testing.T) {
	store := NewKiroReplayStore()
	for i := 0; i < 5100; i++ {
		store.ApplyKiroSessionReplay(
			fmt.Sprintf("conv-%d", i), "conn", "m", "sys", "P", "T",
			[]any{map[string]any{"userInputMessage": map[string]any{"content": "q"}}},
			map[string]any{"userInputMessage": map[string]any{"content": "c"}},
		)
	}
	if store.Size() > 5000 {
		t.Errorf("store grew to %d, past its 5000 bound", store.Size())
	}
}

func TestKiroReplayEvictionIsSafe(t *testing.T) {
	// Eviction costs a cache miss, never correctness: the request still comes
	// back well-formed with a usable current turn.
	store := NewKiroReplayStore()
	for i := 0; i < 5001; i++ {
		store.ApplyKiroSessionReplay(
			fmt.Sprintf("c-%d", i), "conn", "m", "sys", "P", "T",
			[]any{map[string]any{"userInputMessage": map[string]any{"content": "q"}}},
			map[string]any{"userInputMessage": map[string]any{"content": "c"}},
		)
	}
	result := store.ApplyKiroSessionReplay(
		"c-0", "conn", "m", "sys", "P", "T",
		[]any{map[string]any{"userInputMessage": map[string]any{"content": "q"}}},
		map[string]any{"userInputMessage": map[string]any{"content": "c"}},
	)
	if result.CurrentMessage == nil {
		t.Fatal("an evicted conversation produced no current message")
	}
	user, _ := result.CurrentMessage["userInputMessage"].(map[string]any)
	if user == nil {
		t.Fatal("the current message has no userInputMessage")
	}
	if content, _ := user["content"].(string); content == "" {
		t.Error("the current message is empty after eviction")
	}
}

func TestKiroReplayWithToolResultFirstTurnInsertsStart(t *testing.T) {
	// A conversation that opens with tool results cannot have its opening turn
	// replaced (there is no user turn to freeze), so a synthetic start is
	// prepended instead and the original opening stays intact.
	store := NewKiroReplayStore()
	history := []any{
		map[string]any{"userInputMessage": map[string]any{
			"content": "results",
			"userInputMessageContext": map[string]any{
				"toolResults": []any{map[string]any{"toolUseId": "t1", "content": "ok"}},
			},
		}},
	}
	result := store.ApplyKiroSessionReplay(
		"conv-7", "conn-7", "m", "sys", "PREFIX", "TIME",
		history,
		map[string]any{"userInputMessage": map[string]any{"content": "next"}},
	)
	if len(result.History) < 2 {
		t.Fatalf("history has %d turns, expected a synthetic start prepended", len(result.History))
	}
	first, _ := result.History[0].(map[string]any)
	firstUser, _ := first["userInputMessage"].(map[string]any)
	firstContent, _ := firstUser["content"].(string)
	if !strings.HasPrefix(firstContent, "PREFIX") {
		t.Errorf("the synthetic start does not carry the prefix: %q", firstContent)
	}
}

// ── 9. canonicalizer ─────────────────────────────────────────────────────────

func TestKiroCanonicalizeAcceptsAlternatingConversation(t *testing.T) {
	history := []any{
		map[string]any{"userInputMessage": map[string]any{"content": "q1"}},
		map[string]any{"assistantResponseMessage": map[string]any{"content": "a1"}},
	}
	current := map[string]any{"userInputMessage": map[string]any{"content": "q2"}}

	result := translate.CanonicalizeKiroConversation(history, current, "claude-sonnet-4.5", nil, nil)
	if !result.Valid {
		t.Fatalf("a well-formed conversation was rejected: %v", result.Errors)
	}
	if len(result.History) != 2 {
		t.Errorf("history has %d turns, want 2", len(result.History))
	}
}

func TestKiroCanonicalizeStripsToolSpecsFromEarlierTurns(t *testing.T) {
	// Tool specs are legal only on the current turn; an earlier turn carrying
	// them is a rejection, so they must be stripped.
	spec := translate.KiroToolSpec{}
	spec.ToolSpecification.Name = "search"
	specs := []any{spec}

	history := []any{
		map[string]any{"userInputMessage": map[string]any{
			"content": "q1",
			"userInputMessageContext": map[string]any{
				"tools": []any{map[string]any{"toolSpecification": map[string]any{"name": "search"}}},
			},
		}},
		map[string]any{"assistantResponseMessage": map[string]any{"content": "a1"}},
	}
	current := map[string]any{"userInputMessage": map[string]any{"content": "q2"}}

	result := translate.CanonicalizeKiroConversation(history, current, "claude-sonnet-4.5", specs, map[string]string{"search": "search"})
	if !result.Valid {
		t.Fatalf("canonicalize rejected the conversation: %v", result.Errors)
	}
	first, _ := result.History[0].(map[string]any)
	firstUser, _ := first["userInputMessage"].(map[string]any)
	ctx, _ := firstUser["userInputMessageContext"].(map[string]any)
	if ctx != nil {
		if _, has := ctx["tools"]; has {
			t.Error("tool specs survived on an earlier turn")
		}
	}
	// ...and they must be present on the current turn.
	curUser, _ := result.CurrentMessage["userInputMessage"].(map[string]any)
	curCtx, _ := curUser["userInputMessageContext"].(map[string]any)
	if curCtx == nil {
		t.Fatal("the current turn has no context")
	}
	if _, has := curCtx["tools"]; !has {
		t.Error("tool specs are missing from the current turn")
	}
}

func TestKiroCanonicalizeFlattensOrphanLeadingResults(t *testing.T) {
	// A conversation may not open with tool results: there is no call for them
	// to answer.
	history := []any{
		map[string]any{"userInputMessage": map[string]any{
			"content": "orphan",
			"userInputMessageContext": map[string]any{
				"toolResults": []any{map[string]any{"toolUseId": "t9", "content": "leftover"}},
			},
		}},
		map[string]any{"assistantResponseMessage": map[string]any{"content": "a1"}},
	}
	current := map[string]any{"userInputMessage": map[string]any{"content": "q2"}}

	result := translate.CanonicalizeKiroConversation(history, current, "claude-sonnet-4.5", nil, nil)
	if !result.Valid {
		t.Fatalf("orphan results were not repaired: %v", result.Errors)
	}
	if result.Repairs["orphanResults"] == 0 {
		t.Error("the orphan-results repair was not recorded")
	}
	first, _ := result.History[0].(map[string]any)
	firstUser, _ := first["userInputMessage"].(map[string]any)
	if ctx, ok := firstUser["userInputMessageContext"].(map[string]any); ok {
		if _, has := ctx["toolResults"]; has {
			t.Error("orphan tool results survived canonicalization")
		}
	}
}

func TestKiroCanonicalizeSynthesisesCurrentTurnWhenMissing(t *testing.T) {
	// A nil current message is not an error here: the last history user turn
	// becomes the current turn, which is the only sensible reading when the
	// client sent everything as history. Validating it as a failure would reject
	// a body Kiro accepts.
	result := translate.CanonicalizeKiroConversation(
		[]any{map[string]any{"userInputMessage": map[string]any{"content": "q1"}}},
		nil, "claude-sonnet-4.5", nil, nil,
	)
	if !result.Valid {
		t.Fatalf("a nil current message was rejected: %v", result.Errors)
	}
	if len(result.History) != 0 {
		t.Errorf("history has %d turns, want 0 — the lone user turn became the current message", len(result.History))
	}
	user, _ := result.CurrentMessage["userInputMessage"].(map[string]any)
	if got, _ := user["content"].(string); got != "q1" {
		t.Errorf("current content = %q, want \"q1\"", got)
	}
}

func TestKiroCanonicalizeNilCurrentWithEmptyHistory(t *testing.T) {
	// With nothing at all to work from, the synthesised "continue" turn keeps the
	// body shippable rather than producing an empty conversation.
	result := translate.CanonicalizeKiroConversation(nil, nil, "claude-sonnet-4.5", nil, nil)
	if !result.Valid {
		t.Fatalf("an empty body was rejected: %v", result.Errors)
	}
	user, _ := result.CurrentMessage["userInputMessage"].(map[string]any)
	if got, _ := user["content"].(string); got != kiroEmptyUserPlaceholder {
		t.Errorf("current content = %q, want the empty-user placeholder %q", got, kiroEmptyUserPlaceholder)
	}
}

func TestKiroCanonicalizeMergesAdjacentSameRoleTurns(t *testing.T) {
	history := []any{
		map[string]any{"userInputMessage": map[string]any{"content": "part one"}},
		map[string]any{"userInputMessage": map[string]any{"content": "part two"}},
		map[string]any{"assistantResponseMessage": map[string]any{"content": "a1"}},
	}
	current := map[string]any{"userInputMessage": map[string]any{"content": "q2"}}

	result := translate.CanonicalizeKiroConversation(history, current, "m", nil, nil)
	if !result.Valid {
		t.Fatalf("adjacent user turns were not merged: %v", result.Errors)
	}
	if len(result.History) != 2 {
		t.Errorf("history has %d turns, want 2 after merging", len(result.History))
	}
	first, _ := result.History[0].(map[string]any)
	firstUser, _ := first["userInputMessage"].(map[string]any)
	content, _ := firstUser["content"].(string)
	if !strings.Contains(content, "part one") || !strings.Contains(content, "part two") {
		t.Errorf("merged content lost a part: %q", content)
	}
}

func TestKiroCanonicalizePrependsUserWhenHistoryOpensWithAssistant(t *testing.T) {
	history := []any{
		map[string]any{"assistantResponseMessage": map[string]any{"content": "unprompted"}},
	}
	current := map[string]any{"userInputMessage": map[string]any{"content": "q"}}

	result := translate.CanonicalizeKiroConversation(history, current, "m", nil, nil)
	if !result.Valid {
		t.Fatalf("an assistant-first history was not repaired: %v", result.Errors)
	}
	first, _ := result.History[0].(map[string]any)
	if _, ok := first["userInputMessage"]; !ok {
		t.Error("no user turn was prepended before the assistant turn")
	}
}

func TestKiroCanonicalizeEmptyHistoryStillProducesValidBody(t *testing.T) {
	result := translate.CanonicalizeKiroConversation(
		nil,
		map[string]any{"userInputMessage": map[string]any{"content": "hello"}},
		"m", nil, nil,
	)
	if !result.Valid {
		t.Fatalf("an empty history with a current turn was rejected: %v", result.Errors)
	}
	user, _ := result.CurrentMessage["userInputMessage"].(map[string]any)
	if content, _ := user["content"].(string); content != "hello" {
		t.Errorf("current content = %q, want \"hello\"", content)
	}
}

func TestKiroCanonicalizeUnpairableToolsFailValidation(t *testing.T) {
	// Two calls, one result. The structural check must catch the mismatch so the
	// body is repaired (flattened) rather than sent as a guaranteed 400.
	specs := []any{map[string]any{
		"toolSpecification": map[string]any{"name": "search"},
	}}
	history := []any{
		map[string]any{"userInputMessage": map[string]any{"content": "q1"}},
		map[string]any{"assistantResponseMessage": map[string]any{
			"content": "",
			"toolUses": []any{
				map[string]any{"toolUseId": "t1", "name": "search", "input": map[string]any{"q": "a"}},
				map[string]any{"toolUseId": "t2", "name": "search", "input": map[string]any{"q": "b"}},
			},
		}},
		map[string]any{"userInputMessage": map[string]any{
			"content": "",
			"userInputMessageContext": map[string]any{
				"toolResults": []any{map[string]any{"toolUseId": "t1", "content": "one"}},
			},
		}},
	}
	current := map[string]any{"userInputMessage": map[string]any{"content": "q2"}}

	result := translate.CanonicalizeKiroConversation(history, current, "m", specs, map[string]string{"search": "search"})
	if !result.Valid {
		t.Fatalf("the repair pass did not produce a valid body: %v", result.Errors)
	}
	if result.Repairs["missingResults"] == 0 && result.Repairs["invalidToolUses"] == 0 {
		t.Error("the unpaired tool calls were not recorded as repaired")
	}
}

// kiroToolResultsPlaceholder / kiroEmptyUserPlaceholder mirror the canonicalizer's
// placeholders. Named here so the tests assert on the real strings the request
// path emits.
const (
	kiroToolResultsPlaceholder = "Tool results provided."
	kiroEmptyUserPlaceholder   = "continue"
)

// kiroValidationOf runs the canonicalizer and returns its verdict, which is the
// only externally observable route to the structural check. An unrepaired-invalid
// body shows up as Valid=false; a repaired one as Valid=true plus a repair count.
func kiroValidationOf(t *testing.T, history []any, current map[string]any, specNames map[string]bool) translate.KiroConversation {
	t.Helper()
	specs := []any{}
	for name := range specNames {
		spec := translate.KiroToolSpec{}
		spec.ToolSpecification.Name = name
		specs = append(specs, spec)
	}
	return translate.CanonicalizeKiroConversation(history, current, "m", specs, nil)
}

func TestKiroValidationNamesTheFailingTurn(t *testing.T) {
	// An orphan leading result is repaired rather than rejected, and the repair
	// is recorded with its count so the log names what happened. The flattened
	// text also lands on the current turn, which is where the turn ends up.
	history := []any{
		map[string]any{"userInputMessage": map[string]any{
			"content": "orphan",
			"userInputMessageContext": map[string]any{
				"toolResults": []any{map[string]any{"toolUseId": "t1", "content": "leftover"}},
			},
		}},
	}
	current := map[string]any{"userInputMessage": map[string]any{"content": "q"}}

	result := translate.CanonicalizeKiroConversation(history, current, "m", nil, nil)
	if !result.Valid {
		t.Fatalf("the orphan repair did not produce a valid body: %v", result.Errors)
	}
	if result.Repairs["orphanResults"] != 1 {
		t.Errorf("orphanResults repair count = %d, want 1", result.Repairs["orphanResults"])
	}
	user, _ := result.CurrentMessage["userInputMessage"].(map[string]any)
	content, _ := user["content"].(string)
	if !strings.Contains(content, "[Tool result: leftover]") {
		t.Errorf("the orphan result was dropped instead of flattened: %q", content)
	}
	if ctx, ok := user["userInputMessageContext"].(map[string]any); ok {
		if _, has := ctx["toolResults"]; has {
			t.Error("orphan tool results survived on the current turn")
		}
	}
}

func TestKiroValidationRejectsDuplicateToolIDs(t *testing.T) {
	// A duplicate upstream tool-use id does not have to flatten the turn: the
	// reconciler reserves a distinct id per call, so the second becomes "dup_2"
	// and the pairing stays structural. Flattening to text would lose a perfectly
	// usable tool call.
	spec := translate.KiroToolSpec{}
	spec.ToolSpecification.Name = "search"
	history := []any{
		map[string]any{"userInputMessage": map[string]any{"content": "q1"}},
		map[string]any{"assistantResponseMessage": map[string]any{
			"content": "",
			"toolUses": []any{
				map[string]any{"toolUseId": "dup", "name": "search", "input": map[string]any{}},
			},
		}},
		map[string]any{"userInputMessage": map[string]any{
			"content": "",
			"userInputMessageContext": map[string]any{
				"toolResults": []any{map[string]any{"toolUseId": "dup", "content": "r"}},
			},
		}},
		map[string]any{"assistantResponseMessage": map[string]any{
			"content": "",
			"toolUses": []any{
				map[string]any{"toolUseId": "dup", "name": "search", "input": map[string]any{}},
			},
		}},
		map[string]any{"userInputMessage": map[string]any{
			"content": "",
			"userInputMessageContext": map[string]any{
				"toolResults": []any{map[string]any{"toolUseId": "dup", "content": "r"}},
			},
		}},
	}
	current := map[string]any{"userInputMessage": map[string]any{"content": "q"}}

	result := translate.CanonicalizeKiroConversation(history, current, "m", []any{spec}, map[string]string{"search": "search"})
	if !result.Valid {
		t.Fatalf("the duplicate id was not reconciled: %v", result.Errors)
	}

	// Both calls must survive, under distinct ids.
	ids := []string{}
	for _, turn := range result.History {
		turnMap, _ := turn.(map[string]any)
		assistant, _ := turnMap["assistantResponseMessage"].(map[string]any)
		if assistant == nil {
			continue
		}
		calls, _ := assistant["toolUses"].([]any)
		for _, raw := range calls {
			call, _ := raw.(map[string]any)
			if id, _ := call["toolUseId"].(string); id != "" {
				ids = append(ids, id)
			}
		}
	}
	if len(ids) != 2 {
		t.Fatalf("got %d tool calls, want 2 (ids=%v)", len(ids), ids)
	}
	if ids[0] == ids[1] {
		t.Errorf("both calls kept the same id %q, so the pairing is ambiguous", ids[0])
	}
	if ids[0] != "dup" {
		t.Errorf("the first call's id was rewritten from \"dup\" to %q", ids[0])
	}
	if ids[1] != "dup_2" {
		t.Errorf("the second call was not renumbered: got %q, want \"dup_2\"", ids[1])
	}
}

func TestKiroValidationRejectsUnknownToolName(t *testing.T) {
	// A call to a tool that was never declared cannot be executed by the client,
	// so it is stripped from the structured turns and recorded as invalid.
	spec := translate.KiroToolSpec{}
	spec.ToolSpecification.Name = "declared"
	history := []any{
		map[string]any{"userInputMessage": map[string]any{"content": "q1"}},
		map[string]any{"assistantResponseMessage": map[string]any{
			"content": "",
			"toolUses": []any{
				map[string]any{"toolUseId": "t1", "name": "undeclared", "input": map[string]any{}},
			},
		}},
		map[string]any{"userInputMessage": map[string]any{
			"content": "",
			"userInputMessageContext": map[string]any{
				"toolResults": []any{map[string]any{"toolUseId": "t1", "content": "r"}},
			},
		}},
	}
	current := map[string]any{"userInputMessage": map[string]any{"content": "q"}}

	result := translate.CanonicalizeKiroConversation(history, current, "m", []any{spec}, map[string]string{"declared": "declared"})
	if !result.Valid {
		t.Fatalf("the repair pass did not produce a valid body: %v", result.Errors)
	}
	if result.Repairs["invalidToolUses"] == 0 {
		t.Errorf("the undeclared tool name was not recorded as repaired: %v", result.Repairs)
	}
}

func TestKiroToolSpecNormalisationSanitisesNames(t *testing.T) {
	tools := []any{map[string]any{
		"function": map[string]any{
			"name":        "my.tool-name!",
			"description": "does a thing",
			"parameters":  map[string]any{"type": "object"},
		},
	}}
	specs, nameMap := translate.NormalizeKiroToolSpecs(tools)
	if len(specs) == 0 {
		t.Fatal("no spec was produced")
	}
	original, ok := nameMap["my.tool-name!"]
	if !ok {
		t.Fatalf("the name map has no entry for the original: %v", nameMap)
	}
	if original == "my.tool-name!" {
		t.Error("an illegal tool name was not sanitised")
	}
	for _, ch := range original {
		if !isKiroToolNameChar(ch) {
			t.Errorf("sanitised name %q still contains an illegal character %q", original, ch)
		}
	}
}

func isKiroToolNameChar(ch rune) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
		(ch >= '0' && ch <= '9') || ch == '_' || ch == '-'
}

// ── 10. model resolution ─────────────────────────────────────────────────────

func TestResolveKiroModelSuffixFolding(t *testing.T) {
	cases := []struct {
		model    string
		upstream string
		agentic  bool
		thinking bool
	}{
		{"claude-sonnet-4.5", "claude-sonnet-4.5", false, false},
		{"claude-sonnet-4.5-agentic", "claude-sonnet-4.5", true, false},
		{"claude-sonnet-4.5-thinking", "claude-sonnet-4.5", false, true},
		{"claude-sonnet-4.5-agentic-thinking", "claude-sonnet-4.5", true, true},
	}
	for _, tc := range cases {
		got := ResolveKiroModel(tc.model)
		if got.Upstream != tc.upstream {
			t.Errorf("%q: upstream = %q, want %q", tc.model, got.Upstream, tc.upstream)
		}
		if got.Agentic != tc.agentic {
			t.Errorf("%q: agentic = %v, want %v", tc.model, got.Agentic, tc.agentic)
		}
		if got.Thinking != tc.thinking {
			t.Errorf("%q: thinking = %v, want %v", tc.model, got.Thinking, tc.thinking)
		}
	}
}

func TestKiroUpstreamContentType(t *testing.T) {
	var k Kiro
	if got := k.UpstreamContentType(); got != "application/vnd.amazon.eventstream" {
		t.Errorf("UpstreamContentType = %q", got)
	}
}

func TestKiroImplementsStreamDecoder(t *testing.T) {
	// The gateway dispatches on this interface. If Kiro stopped satisfying it,
	// the binary EventStream would be handed to the SSE line path and reach the
	// client as garbage — with no compile error anywhere.
	var adapter any = &Kiro{}
	if _, ok := adapter.(StreamDecoder); !ok {
		t.Fatal("*Kiro no longer implements StreamDecoder, so the gateway would not route it to streamDecoded")
	}
}

func TestKiroThinkingSystemPrefixClampsBudget(t *testing.T) {
	// The budget is clamped, not rejected: a client asking for more than Kiro
	// accepts still gets a working request.
	under := BuildKiroThinkingSystemPrefix(-1)
	if !strings.Contains(under, fmt.Sprintf("%d", KiroThinkingBudgetDefault)) {
		t.Errorf("a non-positive budget was not replaced with the default: %q", under)
	}
	over := BuildKiroThinkingSystemPrefix(1_000_000)
	if !strings.Contains(over, fmt.Sprintf("%d", KiroThinkingBudgetMax)) {
		t.Errorf("an oversize budget was not clamped to the max: %q", over)
	}
	if !strings.Contains(over, "<thinking_mode>enabled</thinking_mode>") {
		t.Errorf("the thinking-mode tag is missing: %q", over)
	}
}

// ── 11. loose readers ────────────────────────────────────────────────────────

func TestKiroLooseReaders(t *testing.T) {
	if got, ok := asFloatLoose("12.5"); !ok || got != 12.5 {
		t.Errorf("asFloatLoose(\"12.5\") = %v, %v", got, ok)
	}
	if got, ok := asFloatLoose(float64(3)); !ok || got != 3 {
		t.Errorf("asFloatLoose(3) = %v, %v", got, ok)
	}
	if _, ok := asFloatLoose("not a number"); ok {
		t.Error("asFloatLoose accepted garbage")
	}
	if got := intLoose("42"); got != 42 {
		t.Errorf("intLoose(\"42\") = %d, want 42", got)
	}
	if got := intLoose(nil); got != 0 {
		t.Errorf("intLoose(nil) = %d, want 0", got)
	}

	m := map[string]any{"a": 1, "b": "two"}
	if got := firstString(m, "missing", "b"); got != "two" {
		t.Errorf("firstString fell through to a non-string: %q", got)
	}
	if got := firstValue(m, "missing", "a"); got != 1 {
		t.Errorf("firstValue = %v, want 1", got)
	}
}

func TestKiroCamelCaseNormalisation(t *testing.T) {
	cases := map[string]string{
		"endTurn":     "end_turn",
		"maxTokens":   "max_tokens",
		"already_snk": "already_snk",
		"kebab-case":  "kebab_case",
	}
	for input, want := range cases {
		if got := normalizeKiroCamelCase(input); got != want {
			t.Errorf("normalizeKiroCamelCase(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestKiroSubstringHelpers(t *testing.T) {
	if !containsSubstring("content_filtered", "filter") {
		t.Error("containsSubstring missed a match")
	}
	if containsSubstring("end_turn", "filter") {
		t.Error("containsSubstring reported a false match")
	}
	if got := indexOfSubstring("abcabc", "c"); got != 2 {
		t.Errorf("indexOfSubstring = %d, want 2", got)
	}
	if got := indexOfSubstring("abc", "z"); got != -1 {
		t.Errorf("indexOfSubstring(missing) = %d, want -1", got)
	}
}

func TestKiroStripThinkingLeavesUnterminatedSpanOpen(t *testing.T) {
	// A span that never closes must stay suppressed, not leak its opening tag.
	state := &kiroStreamState{}
	visible, reasoning := kiroStripThinking("prefix<thinking>still going", state)
	if visible != "prefix" {
		t.Errorf("visible = %q, want \"prefix\"", visible)
	}
	if reasoning != "still going" {
		t.Errorf("reasoning = %q", reasoning)
	}
	if !state.inThinking {
		t.Error("the state did not record that a span is open")
	}

	// The next call continues inside the span.
	visible, reasoning = kiroStripThinking(" and done</thinking>tail", state)
	if visible != "tail" {
		t.Errorf("visible after close = %q, want \"tail\"", visible)
	}
	if reasoning != " and done" {
		t.Errorf("reasoning after close = %q", reasoning)
	}
	if state.inThinking {
		t.Error("the state did not clear after the span closed")
	}
}

func TestKiroStripThinkingWholeFrameIsReasoning(t *testing.T) {
	state := &kiroStreamState{}
	visible, reasoning := kiroStripThinking("<thinking>only thoughts</thinking>", state)
	if visible != "" {
		t.Errorf("visible = %q, want \"\"", visible)
	}
	if reasoning != "only thoughts" {
		t.Errorf("reasoning = %q", reasoning)
	}
}

func TestKiroStripThinkingNoSpanPassesThrough(t *testing.T) {
	state := &kiroStreamState{}
	visible, reasoning := kiroStripThinking("plain text", state)
	if visible != "plain text" {
		t.Errorf("visible = %q, want \"plain text\"", visible)
	}
	if reasoning != "" {
		t.Errorf("reasoning = %q, want \"\"", reasoning)
	}
}
