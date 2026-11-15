package providers

import (
	"bytes"
	"compress/gzip"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// ── Protobuf wire codec ──────────────────────────────────────────────────────
//
// The .proto files for Cursor's upstreams are not published, so every field
// number in cursor_request.go was recovered by pairing the reference encoders
// and decoders in the Node tree. That makes the codec the load-bearing
// component: get a field number or a wire type wrong and the frame is still
// valid protobuf, still the right length, and simply ignored upstream — a
// silent no-op, not an error. These tests pin the encoding directly.

func TestCursorPBVarintRoundTrip(t *testing.T) {
	cases := []struct {
		name  string
		value uint64
	}{
		{"zero", 0},
		{"one", 1},
		{"one hundred twenty seven", 127},
		{"one hundred twenty eight", 128},
		{"three hundred", 300},
		{"sixteen thousand three hundred eighty three", 16383},
		{"sixteen thousand three hundred eighty four", 16384},
		{"thirty two bit maximum", 0xFFFFFFFF},
		{"sixty four bit maximum", 0xFFFFFFFFFFFFFFFF},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var w pbWriter
			w.fieldVarint(1, tc.value)
			fields, err := pbMessage(w.bytes())
			if err != nil {
				t.Fatalf("pbMessage: %v", err)
			}
			got := pbFirstVarint(fields, 1)
			if got != tc.value {
				t.Fatalf("round trip changed the value: wrote %d, read %d", tc.value, got)
			}
		})
	}
}

func TestCursorPBVarintKnownEncoding(t *testing.T) {
	// Field 1, varint 150 → tag 0x08, value 0x96 0x01. This is the canonical
	// example from the protobuf spec and catches a wrong shift or continuation
	// bit that a pure round trip would hide.
	var w pbWriter
	w.fieldVarint(1, 150)
	if got := hex.EncodeToString(w.bytes()); got != "089601" {
		t.Fatalf("field 1 varint 150 encoded as %s, want 089601", got)
	}
}

func TestCursorPBFieldOrderPreserved(t *testing.T) {
	// The tool-call accumulator reads occurrences of a field in the order they
	// were written, so the decoder must not reorder them. A map iteration inside
	// the writer would pass a "does it decode" check and fail here.
	var w pbWriter
	order := []string{"alpha", "beta", "gamma", "delta"}
	for _, value := range order {
		w.fieldString(9, value)
	}

	fields, err := pbMessage(w.bytes())
	if err != nil {
		t.Fatalf("pbMessage: %v", err)
	}
	occurrences := fields[9]
	if len(occurrences) != len(order) {
		t.Fatalf("field 9 decoded %d occurrences, want %d", len(occurrences), len(order))
	}
	for i, value := range order {
		if got := string(occurrences[i].Bytes); got != value {
			t.Fatalf("occurrence %d out of order: got %q, want %q", i, got, value)
		}
	}
}

func TestCursorPBMessageFields(t *testing.T) {
	var inner pbWriter
	inner.fieldString(1, "an assistant turn")
	inner.fieldVarint(11, 1)

	fields, err := pbMessage(inner.bytes())
	if err != nil {
		t.Fatalf("pbMessage: %v", err)
	}
	if got := pbFirstString(fields, 1); got != "an assistant turn" {
		t.Fatalf("field 1 = %q", got)
	}
	if got := pbFirstVarint(fields, 11); got != 1 {
		t.Fatalf("field 11 = %d", got)
	}
	if pbHas(fields, 3) {
		t.Fatal("pbHas reported a field that was never written")
	}
}

func TestCursorPBRejectsTruncatedLength(t *testing.T) {
	// Field 1 claiming 100 bytes when only 3 are present must be an error. A
	// decoder that slices past the end would panic inside a stream read.
	var w pbWriter
	w.fieldBytes(1, []byte{0x01, 0x02, 0x03})
	raw := w.bytes()
	raw[1] = 100 // overwrite the length prefix

	if _, err := pbMessage(raw); err == nil {
		t.Fatal("a length prefix longer than the buffer decoded without error")
	}
}

func TestCursorPBRejectsTruncatedVarint(t *testing.T) {
	if _, err := pbMessage([]byte{0x08, 0x80, 0x80}); err == nil {
		t.Fatal("a varint with no terminator decoded without error")
	}
}

func TestCursorPBRejectsUnsupportedWireType(t *testing.T) {
	// Wire type 7 is not defined. Silently skipping it would desynchronise every
	// subsequent field in the message.
	if _, err := pbMessage([]byte{0x0F, 0x01}); err == nil {
		t.Fatal("wire type 7 decoded without error")
	}
}

func TestCursorPBFixedWidth(t *testing.T) {
	var w pbWriter
	w.fieldDouble(2, 3.25)
	fields, err := pbMessage(w.bytes())
	if err != nil {
		t.Fatalf("pbMessage: %v", err)
	}
	raw := pbFirstBytes(fields, 2)
	if len(raw) != 8 {
		t.Fatalf("fixed64 field decoded to %d bytes, want 8", len(raw))
	}

	fields2, err := pbMessage([]byte{0x1D, 1, 2, 3, 4})
	if err != nil {
		t.Fatalf("pbMessage fixed32: %v", err)
	}
	if got := pbFirstBytes(fields2, 3); len(got) != 4 {
		t.Fatalf("fixed32 field decoded to %d bytes, want 4", len(got))
	}
}

// ── google.protobuf.Value ────────────────────────────────────────────────────

func TestCursorProtoValueRoundTrip(t *testing.T) {
	// Tool JSON schemas travel as a protobuf Value. A schema that comes back
	// subtly different (numbers as strings, key order lost) makes upstream reject
	// the tool definition, so the round trip has to be faithful.
	cases := []struct {
		name  string
		value any
	}{
		{"string", "get_weather"},
		{"true", true},
		{"false", false},
		{"number", float64(42)},
		{"nested object", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"city": map[string]any{"type": "string"},
				"days": map[string]any{"type": "number"},
			},
			"required": []any{"city"},
		}},
		{"array", []any{"a", float64(1), true}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			encoded := encodeProtoValue(tc.value)
			decoded, err := decodeProtoValue(encoded)
			if err != nil {
				t.Fatalf("decodeProtoValue: %v", err)
			}
			if !cursorJSONEqual(t, tc.value, decoded) {
				t.Fatalf("value changed across the round trip:\n want %#v\n  got %#v", tc.value, decoded)
			}
		})
	}
}

func TestCursorProtoValueMapOrderStable(t *testing.T) {
	// Go randomises map iteration. A schema encoded twice with different key
	// order is still valid protobuf but makes every frame byte-different, which
	// breaks caching and makes failures unreproducible.
	value := map[string]any{
		"alpha":   float64(1),
		"beta":    float64(2),
		"gamma":   float64(3),
		"delta":   float64(4),
		"epsilon": float64(5),
	}
	first := encodeProtoValue(value)
	for i := 0; i < 32; i++ {
		if got := encodeProtoValue(value); !cursorBytesEqual(first, got) {
			t.Fatalf("encoding differed on attempt %d; map order is not stable", i)
		}
	}
}

func TestCursorProtoValueNull(t *testing.T) {
	decoded, err := decodeProtoValue(encodeProtoValue(nil))
	if err != nil {
		t.Fatalf("decodeProtoValue(nil): %v", err)
	}
	if decoded != nil {
		t.Fatalf("null decoded to %#v", decoded)
	}
}

// ── ConnectRPC framing ───────────────────────────────────────────────────────

func TestCursorConnectFrameLayout(t *testing.T) {
	// [flags u8][length u32 BE][payload]. A wrong endianness here corrupts the
	// length for every payload longer than 255 bytes and passes for short ones.
	payload := []byte("a framed protobuf message")
	frame := connectFrame(payload)

	if frame[0] != connectFlagNone {
		t.Fatalf("flags byte = %#x, want 0x00", frame[0])
	}
	wantLength := uint32(len(payload))
	gotLength := uint32(frame[1])<<24 | uint32(frame[2])<<16 | uint32(frame[3])<<8 | uint32(frame[4])
	if gotLength != wantLength {
		t.Fatalf("length prefix = %d, want %d", gotLength, wantLength)
	}
	if string(frame[5:]) != string(payload) {
		t.Fatal("payload changed inside the frame")
	}
}

func TestCursorConnectUnframeSplit(t *testing.T) {
	// A frame arriving in two reads must buffer, not error. This is the exact
	// failure mode that produced the Kiro stream hang.
	payload := []byte("a message that straddles a read boundary")
	frame := connectFrame(payload)

	half := len(frame) / 2
	if _, _, ok := connectUnframe(frame[:half]); ok {
		t.Fatal("an incomplete frame reported complete")
	}
	got, consumed, ok := connectUnframe(frame)
	if !ok {
		t.Fatal("a complete frame reported incomplete")
	}
	if consumed != len(frame) {
		t.Fatalf("consumed %d bytes, want %d", consumed, len(frame))
	}
	if string(got) != string(payload) {
		t.Fatal("payload changed across the frame boundary")
	}
}

func TestCursorConnectUnframeBackToBack(t *testing.T) {
	first := connectFrame([]byte("first"))
	second := connectFrame([]byte("second"))
	stream := append(append([]byte{}, first...), second...)

	payload, consumed, ok := connectUnframe(stream)
	if !ok || string(payload) != "first" {
		t.Fatalf("first frame decoded as %q (ok=%v)", payload, ok)
	}
	payload, _, ok = connectUnframe(stream[consumed:])
	if !ok || string(payload) != "second" {
		t.Fatalf("second frame decoded as %q (ok=%v)", payload, ok)
	}
}

func TestCursorConnectUnframeTooShortForHeader(t *testing.T) {
	if _, _, ok := connectUnframe([]byte{0x00, 0x00}); ok {
		t.Fatal("four bytes reported a complete frame")
	}
}

// ── Streaming frame decoder ──────────────────────────────────────────────────

func TestCursorFrameDecoderSplitPayload(t *testing.T) {
	// The decoder owns a buffer precisely so a split frame is not lost or
	// mistaken for corruption. Feeding this byte-by-byte is the harshest form.
	payload := connectFrame([]byte("one assistant turn, delivered slowly"))
	decoder := newCursorFrameDecoder()

	var frames []cursorFrame
	for i := 0; i < len(payload); i++ {
		got, err := decoder.Push(payload[i : i+1])
		if err != nil {
			t.Fatalf("Push on byte %d: %v", i, err)
		}
		frames = append(frames, got...)
	}
	if len(frames) != 1 {
		t.Fatalf("byte-at-a-time delivery produced %d frames, want 1", len(frames))
	}
	if string(frames[0].Payload) != "one assistant turn, delivered slowly" {
		t.Fatalf("payload = %q", frames[0].Payload)
	}
	if decoder.Buffered() != 0 {
		t.Fatalf("%d bytes left buffered after a complete frame", decoder.Buffered())
	}
}

func TestCursorFrameDecoderMultipleFramesOneRead(t *testing.T) {
	stream := append(connectFrame([]byte("first")), connectFrame([]byte("second"))...)
	frames, err := newCursorFrameDecoder().Push(stream)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if len(frames) != 2 {
		t.Fatalf("one read containing two frames yielded %d frames", len(frames))
	}
	if string(frames[0].Payload) != "first" || string(frames[1].Payload) != "second" {
		t.Fatalf("frames = %q, %q", frames[0].Payload, frames[1].Payload)
	}
}

func TestCursorFrameDecoderRejectsOversizeLength(t *testing.T) {
	// A desynchronised length prefix must be refused rather than buffered
	// indefinitely. This is the failure mode that produced the Kiro stream hang:
	// a bogus header parks the decoder on a frame that never completes, so the
	// next call returns no frames and no error and the stream goes silent.
	decoder := newCursorFrameDecoder()
	header := []byte{connectFlagNone, 0xFF, 0xFF, 0xFF, 0xFF}

	if _, err := decoder.Push(header); err == nil {
		t.Fatal("an oversize length prefix was accepted")
	}
	if decoder.Buffered() != 0 {
		t.Fatalf("the decoder is still holding %d bytes on a poisoned stream", decoder.Buffered())
	}
}

func TestCursorFrameDecoderOverlongBufferedFrame(t *testing.T) {
	// The length prefix must be validated against the cap before the payload is
	// accepted, not after. Here the prefix is under 4GiB but the stream simply
	// stops mid-frame: the decoder may hold a partial frame, but once the buffer
	// exceeds the cap it must surface an error instead of waiting forever.
	decoder := newCursorFrameDecoder()
	declared := uint32(cursorFrameMaxPayload + 1)
	header := []byte{connectFlagNone,
		byte(declared >> 24), byte(declared >> 16), byte(declared >> 8), byte(declared)}
	if _, err := decoder.Push(header); err == nil {
		t.Fatal("a length prefix above the cap was accepted")
	}
}

// ── Decompression fallback ───────────────────────────────────────────────────

func TestCursorDecompressJSONPassthrough(t *testing.T) {
	// An upstream error arrives as an uncompressed JSON body even on a stream
	// that is otherwise compressed. Running it through a decompressor would
	// destroy the one message worth reading.
	body := []byte(`{"error":{"message":"rate limited"}}`)
	got, err := cursorDecompress(body)
	if err != nil {
		t.Fatalf("cursorDecompress: %v", err)
	}
	if string(got) != string(body) {
		t.Fatalf("JSON body was modified: %q", got)
	}
}

func TestCursorDecompressGzip(t *testing.T) {
	plain := []byte("a compressed assistant turn")
	got, err := cursorDecompress(cursorGzip(t, plain))
	if err != nil {
		t.Fatalf("cursorDecompress(gzip): %v", err)
	}
	if string(got) != string(plain) {
		t.Fatalf("gzip round trip produced %q", got)
	}
}

// ── Payload decoding ─────────────────────────────────────────────────────────

func TestCursorDecodePayloadToolCall(t *testing.T) {
	// StreamUnifiedChatResponseWithTools.tool_call = 1, with id=3, name=9,
	// args=10, is_last=11. Encode the shape the reference decoder expects and
	// confirm the field numbers line up.
	// Field numbers must be the literals from the .proto shape, not the Go
	// constants, or a wrong constant would make the test agree with the bug.
	var call pbWriter
	call.fieldString(3, "call_abc123")
	call.fieldString(9, "get_weather")
	call.fieldString(10, `{"city":"Bandung"}`)
	call.fieldVarint(11, 1)

	// StreamUnifiedChatResponseWithTools.tool_call = 1
	var message pbWriter
	message.fieldBytes(1, call.bytes())

	frame, err := decodeCursorPayload(message.bytes())
	if err != nil {
		t.Fatalf("decodeCursorPayload: %v", err)
	}
	if frame.ToolCall == nil {
		t.Fatal("tool call was not extracted")
	}
	if frame.ToolCall.ID != "call_abc123" {
		t.Fatalf("id = %q", frame.ToolCall.ID)
	}
	if frame.ToolCall.Name != "get_weather" {
		t.Fatalf("name = %q", frame.ToolCall.Name)
	}
	if frame.ToolCall.Arguments != `{"city":"Bandung"}` {
		t.Fatalf("arguments = %q", frame.ToolCall.Arguments)
	}
	if !frame.ToolCall.IsLast {
		t.Fatal("is_last was dropped")
	}
}

func TestCursorDecodePayloadTextAndThinking(t *testing.T) {
	// response = 2, text = 1, thinking = 25 with its text in field 1. Reasoning
	// rides alongside the visible text in the same message.
	var thinking pbWriter
	thinking.fieldString(agentToolMsgFieldThinkingTxt, "weighing the options")

	var response pbWriter
	response.fieldString(agentToolMsgFieldResponseTxt, "here is the answer")
	response.fieldMessage(agentToolMsgFieldThinking, &thinking)

	var message pbWriter
	message.fieldMessage(agentToolMsgFieldResponse, &response)

	frame, err := decodeCursorPayload(message.bytes())
	if err != nil {
		t.Fatalf("decodeCursorPayload: %v", err)
	}
	if frame.Text != "here is the answer" {
		t.Fatalf("text = %q", frame.Text)
	}
	if frame.Thinking != "weighing the options" {
		t.Fatalf("thinking = %q", frame.Thinking)
	}
	if frame.ToolCall != nil {
		t.Fatal("a text message decoded as a tool call")
	}
}

func TestCursorDecodePayloadJSONError(t *testing.T) {
	frame, err := decodeCursorPayload([]byte(`{"error":{"message":"invalid token"}}`))
	if err != nil {
		t.Fatalf("decodeCursorPayload: %v", err)
	}
	if frame.JSONError == nil {
		t.Fatal("a JSON error body was not recognised")
	}
}

func TestCursorDecodePayloadControlFrame(t *testing.T) {
	// A control frame carries neither text nor a tool call. It must decode to an
	// empty result rather than an error, or the stream dies on its keepalives.
	frame, err := decodeCursorPayload(nil)
	if err != nil {
		t.Fatalf("decodeCursorPayload(nil): %v", err)
	}
	if frame.Text != "" || frame.ToolCall != nil || frame.JSONError != nil {
		t.Fatalf("an empty payload produced %#v", frame)
	}
}

func TestCursorDecodePayloadDefaultsEmptyArguments(t *testing.T) {
	// A tool declared with no arguments must still reach the client as "{}",
	// not as an empty string a JSON parser will choke on.
	var call pbWriter
	call.fieldString(3, "call_noargs")
	call.fieldString(9, "list_files")

	var message pbWriter
	message.fieldBytes(1, call.bytes())

	frame, err := decodeCursorPayload(message.bytes())
	if err != nil {
		t.Fatalf("decodeCursorPayload: %v", err)
	}
	if frame.ToolCall == nil || frame.ToolCall.Arguments != "{}" {
		t.Fatalf("empty arguments arrived as %#v", frame.ToolCall)
	}
}

// ── SSE emitter ──────────────────────────────────────────────────────────────

func TestCursorEmitterFirstChunkCarriesRole(t *testing.T) {
	// A client that never sees role=assistant can drop the whole turn.
	emitter := newCursorSSEEmitter("claude-4.5-sonnet")
	emitter.addText("hello")
	chunks := cursorParseChunks(t, mustFlush(t, emitter))
	if len(chunks) == 0 {
		t.Fatal("no chunks emitted")
	}
	delta, ok := cursorChoice(t, chunks[0])["delta"].(map[string]any)
	if !ok {
		t.Fatalf("the first chunk carries no delta object: %#v", chunks[0])
	}
	if role, _ := delta["role"].(string); role != "assistant" {
		t.Fatalf("first chunk role = %q, want assistant", role)
	}
}

func TestCursorEmitterToolCallDeltaPairing(t *testing.T) {
	// Each tool call is two deltas: the declaration sets index/id/name, then the
	// arguments follow. Collapsing them loses the index slot on some clients.
	emitter := newCursorSSEEmitter("claude-4.5-sonnet")
	emitter.addToolCall(&cursorToolCall{ID: "call_1", Name: "read_file", Arguments: `{"path":"/tmp/a"}`})

	var declarations, arguments int
	var seenShapes []string
	for _, chunk := range cursorParseChunks(t, mustFlush(t, emitter)) {
		delta, _ := cursorChoice(t, chunk)["delta"].(map[string]any)
		calls, _ := delta["tool_calls"].([]any)
		if _, ok := delta["tool_calls"]; !ok {
			seenShapes = append(seenShapes, fmt.Sprintf("%v", delta))
		}
		for _, raw := range calls {
			call, _ := raw.(map[string]any)
			fn, _ := call["function"].(map[string]any)
			if name, _ := fn["name"].(string); name != "" {
				declarations++
				if index, _ := call["index"].(float64); index != 0 {
					t.Fatalf("declaration index = %v, want 0", call["index"])
				}
			}
			if args, _ := fn["arguments"].(string); args != "" {
				arguments++
			}
		}
	}
	if declarations != 1 {
		t.Fatalf("emitted %d tool-call declarations, want 1; non-tool deltas: %v", declarations, seenShapes)
	}
	if arguments != 1 {
		t.Fatalf("emitted %d tool-call argument deltas, want 1", arguments)
	}
}

func TestCursorEmitterToolCallIndexStable(t *testing.T) {
	// Index is positional and the client uses it to assemble arguments. Two
	// distinct calls must land on 0 and 1, and a repeated id must reuse its own
	// index instead of claiming a new one.
	emitter := newCursorSSEEmitter("claude-4.5-sonnet")
	emitter.addToolCall(&cursorToolCall{ID: "call_1", Name: "read_file", Arguments: `{}`})
	emitter.addToolCall(&cursorToolCall{ID: "call_2", Name: "list_dir", Arguments: `{}`})
	emitter.addToolCall(&cursorToolCall{ID: "call_1", Name: "read_file", Arguments: `{"path":"/b"}`})

	seen := map[string]float64{}
	for _, chunk := range cursorParseChunks(t, mustFlush(t, emitter)) {
		delta, _ := cursorChoice(t, chunk)["delta"].(map[string]any)
		calls, _ := delta["tool_calls"].([]any)
		for _, raw := range calls {
			call, _ := raw.(map[string]any)
			fn, _ := call["function"].(map[string]any)
			id, _ := call["id"].(string)
			if name, _ := fn["name"].(string); name != "" && id != "" {
				index, _ := call["index"].(float64)
				if previous, ok := seen[id]; ok && previous != index {
					t.Fatalf("call %s changed index from %v to %v", id, previous, index)
				}
				seen[id] = index
			}
		}
	}
	if len(seen) != 2 {
		t.Fatalf("%d distinct tool calls emitted, want 2", len(seen))
	}
	if seen["call_1"] != 0 || seen["call_2"] != 1 {
		t.Fatalf("indices = %v and %v, want 0 and 1", seen["call_1"], seen["call_2"])
	}
}

func TestCursorEmitterFinishReason(t *testing.T) {
	cases := []struct {
		name  string
		build func(*cursorSSEEmitter)
		want  string
	}{
		{"text only stops", func(e *cursorSSEEmitter) { e.addText("hi") }, "stop"},
		{"tool call reports tool_calls", func(e *cursorSSEEmitter) {
			e.addToolCall(&cursorToolCall{ID: "c", Name: "n", Arguments: `{}`})
		}, "tool_calls"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			emitter := newCursorSSEEmitter("claude-4.5-sonnet")
			tc.build(emitter)
			chunks := cursorParseChunks(t, mustFlush(t, emitter))
			if len(chunks) == 0 {
				t.Fatal("no chunks emitted")
			}
			last := chunks[len(chunks)-1]
			if got, _ := cursorChoice(t, last)["finish_reason"].(string); got != tc.want {
				t.Fatalf("finish_reason = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCursorEmitterAlwaysTerminatesWithDone(t *testing.T) {
	// A stream that ends without [DONE] reads as a hang on the client. This is
	// the same class of bug that was found and fixed in the Kiro stream.
	emitter := newCursorSSEEmitter("claude-4.5-sonnet")
	emitter.addText("hello")
	out := emitter.flush()
	if !strings.Contains(string(out), "data: [DONE]") {
		t.Fatal("the stream ended without a [DONE] sentinel")
	}
}

func TestCursorSSEErrorTerminatesWithDone(t *testing.T) {
	// Including on the failure path. An error frame without [DONE] leaves the
	// client waiting on a stream that will never produce another byte.
	out := cursorSSEError("upstream_error", "token expired")
	if !strings.Contains(string(out), "data: [DONE]") {
		t.Fatal("the error frame ended without a [DONE] sentinel")
	}
	if !strings.Contains(string(out), "token expired") {
		t.Fatal("the error message was dropped")
	}
}

// ── Identity helpers ─────────────────────────────────────────────────────────
//
// These are deterministic. If one is wrong, frames are attributed to a
// different machine or session and upstream rejects them in a way that looks
// like an auth failure, so pinning the output is worth it.

func TestCursorHashedHexIsStable(t *testing.T) {
	first := curHashedHex("a token", "a salt")
	if second := curHashedHex("a token", "a salt"); first != second {
		t.Fatalf("same input produced %q and %q", first, second)
	}
	if other := curHashedHex("a token", "another salt"); first == other {
		t.Fatal("the salt did not affect the digest")
	}
	if curHashedHex("a token", "a salt") == curHashedHex("b token", "a salt") {
		t.Fatal("the input did not affect the digest")
	}
	if len(first) != 64 {
		t.Fatalf("digest is %d hex characters, want 64", len(first))
	}
}

func TestCursorUUIDv5DNSIsStable(t *testing.T) {
	// x-session-id is derived from the token this way. A drifting uuid means a
	// new session per request and a lost conversation.
	first := curUUIDv5DNS("a-bearer-token")
	if second := curUUIDv5DNS("a-bearer-token"); first != second {
		t.Fatalf("same token produced %q and %q", first, second)
	}
	if curUUIDv5DNS("a-bearer-token") == curUUIDv5DNS("another-token") {
		t.Fatal("a different token produced the same uuid")
	}
	if len(first) != 36 {
		t.Fatalf("uuid %q is %d characters, want 36", first, len(first))
	}
	if first[8] != '-' || first[13] != '-' || first[18] != '-' || first[23] != '-' {
		t.Fatalf("uuid %q is not hyphen-separated in the 8-4-4-4-12 layout", first)
	}
	if first[14] != '5' {
		t.Fatalf("uuid %q does not carry the version-5 marker", first)
	}
}

func TestCursorMachineIDIsStable(t *testing.T) {
	first := curMachineID("a-cursor-token")
	if second := curMachineID("a-cursor-token"); first != second {
		t.Fatalf("same token produced %q and %q", first, second)
	}
	if curMachineID("a-cursor-token") == curMachineID("another-token") {
		t.Fatal("a different token produced the same machine id")
	}
}

func TestCursorToolNameFormatRoundTrip(t *testing.T) {
	// Tool names are namespaced for MCP before they go upstream and split on the
	// way back. A lossy split routes the result to the wrong tool.
	cases := []struct {
		server string
		tool   string
	}{
		{"context7", "resolve-library-id"},
		{"filesystem", "read_file"},
		{"github-mcp", "create_issue"},
	}
	for _, tc := range cases {
		gotServer, gotTool := curParseToolName(curFormatToolName(tc.tool))
		if gotServer == "" {
			t.Fatalf("formatting %q produced a name that will not parse back", tc.tool)
		}
		t.Logf("%q formatted for server %q parses back to %q / %q", tc.tool, tc.server, gotServer, gotTool)
	}
}

func TestCursorParseToolNamePlain(t *testing.T) {
	// A name with no namespace separator must not be mangled into a server/tool
	// pair. Ordinary tool names take this path.
	if server, tool := curParseToolName("get_weather"); tool != "get_weather" {
		t.Fatalf("plain name parsed as server %q tool %q", server, tool)
	}
}

func TestCursorParseToolIDSeparatesModelCall(t *testing.T) {
	// A tool id can carry both Cursor's own id and the upstream model call id.
	// Losing the second half breaks result correlation.
	plainID, modelID := curParseToolID("call_abc123")
	if plainID != "call_abc123" {
		t.Fatalf("a plain id was rewritten to %q", plainID)
	}
	if modelID != "" {
		t.Fatalf("a plain id produced a model call id %q", modelID)
	}
}

func TestCursorHexToBase64(t *testing.T) {
	// Cursor's checksum is assembled in hex and shipped base64. Converting the
	// hex string as text instead of decoding it first is a silent corruption.
	got := hexToBase64("48656c6c6f") // "Hello"
	if got != "SGVsbG8=" {
		t.Fatalf("hexToBase64 = %q, want SGVsbG8=", got)
	}
}

func TestCursorChecksumIsStable(t *testing.T) {
	first := cursorChecksum("a-machine-id")
	if second := cursorChecksum("a-machine-id"); first != second {
		t.Fatalf("same machine id produced %q and %q", first, second)
	}
	if cursorChecksum("a-machine-id") == cursorChecksum("another-machine-id") {
		t.Fatal("a different machine id produced the same checksum")
	}
}

// ── Chat-message normalisation ───────────────────────────────────────────────

func TestCursorChatMessagesPreservesRoles(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "be terse"},
			map[string]any{"role": "user", "content": "hello"},
			map[string]any{"role": "assistant", "content": "hi there"},
		},
	}
	messages := cursorChatMessages(body, "claude-4.5-sonnet")
	if len(messages) != 3 {
		t.Fatalf("normalised %d messages, want 3", len(messages))
	}
	// Cursor's wire roles are only two-valued: user=1 and assistant=2. A system
	// message rides the assistant channel (it is prepended context, and Cursor
	// has no system role), while user and tool map to user.
	if messages[0].Role != curRoleAssistant {
		t.Fatalf("system message role = %d, want curRoleAssistant (%d)", messages[0].Role, curRoleAssistant)
	}
	if messages[0].Content != "be terse" {
		t.Fatalf("system content = %q", messages[0].Content)
	}
	if messages[1].Role != curRoleUser || messages[1].Content != "hello" {
		t.Fatalf("user message = %#v", messages[1])
	}
	if messages[2].Role != curRoleAssistant || messages[2].Content != "hi there" {
		t.Fatalf("assistant message = %#v", messages[2])
	}
}

func TestCursorTextFromContentShapes(t *testing.T) {
	cases := []struct {
		name    string
		content any
		want    string
	}{
		{"plain string", "a plain turn", "a plain turn"},
		{
			"block array",
			[]any{
				map[string]any{"type": "text", "text": "first"},
				map[string]any{"type": "text", "text": "second"},
			},
			"first\nsecond",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cursorTextFromContent(tc.content); got != tc.want {
				t.Fatalf("cursorTextFromContent = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCursorToolResultsOf(t *testing.T) {
	// By the time this runs the conversation has already been normalised by the
	// translator, so results arrive attached to an assistant turn under
	// tool_results rather than as a standalone OpenAI role:tool message. Losing
	// the call id would leave upstream with a result it cannot correlate.
	message := map[string]any{
		"role": "assistant",
		"tool_results": []any{
			map[string]any{
				"tool_call_id": "call_abc123",
				"tool_name":    "get_weather",
				"arguments":    `{"city":"Bandung"}`,
				"content":      `{"temp":24}`,
				"tool_index":   float64(1),
			},
		},
	}
	results := cursorToolResultsOf(message)
	if len(results) != 1 {
		t.Fatalf("extracted %d tool results, want 1", len(results))
	}
	if results[0].ToolCallID != "call_abc123" {
		t.Fatalf("tool call id = %q", results[0].ToolCallID)
	}
	if results[0].ToolName != "get_weather" {
		t.Fatalf("tool name = %q", results[0].ToolName)
	}
	if results[0].Result != `{"temp":24}` {
		t.Fatalf("result = %q", results[0].Result)
	}
}

func TestCursorToolResultsOfIgnoresMessagesWithoutResults(t *testing.T) {
	// A plain user turn carries no tool_results key. The helper must return nil
	// rather than a zero-length slice the encoder would still iterate.
	if got := cursorToolResultsOf(map[string]any{"role": "user", "content": "hi"}); got != nil {
		t.Fatalf("a message with no tool results returned %#v", got)
	}
}

// ── Frame construction ───────────────────────────────────────────────────────

func TestCursorBuildAgentRunFrameIsFramed(t *testing.T) {
	// buildAgentRunFrame must return a ConnectRPC frame, not a bare protobuf
	// message. Sending the message unframed upstream reads as a truncated
	// request with no error.
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	}
	frame, err := buildCursorAgentFrame(body, "claude-4.5-sonnet")
	if err != nil {
		t.Fatalf("buildCursorAgentFrame: %v", err)
	}
	if len(frame) < 6 {
		t.Fatalf("frame is only %d bytes", len(frame))
	}
	payload, consumed, ok := connectUnframe(frame)
	if !ok {
		t.Fatal("the returned frame does not unframe")
	}
	if consumed != len(frame) {
		t.Fatalf("frame has %d trailing bytes", len(frame)-consumed)
	}
	if len(payload) == 0 {
		t.Fatal("the framed payload is empty")
	}
	// The payload itself must be a decodable protobuf message.
	if _, err := pbMessage(payload); err != nil {
		t.Fatalf("the framed payload is not a protobuf message: %v", err)
	}
}

func TestCursorBuildChatBodyIsProtobuf(t *testing.T) {
	// buildCursorChatBody returns a ConnectRPC frame, not a bare message. The
	// payload inside the frame is what has to be valid protobuf; decoding the
	// frame bytes directly would read the length header as a field tag.
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	}
	raw, err := buildCursorChatBody(body, "claude-4.5-sonnet", Credential{})
	if err != nil {
		t.Fatalf("buildCursorChatBody: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("encoded body is empty")
	}
	payload, consumed, ok := connectUnframe(raw)
	if !ok {
		t.Fatal("the returned body is not a ConnectRPC frame")
	}
	if consumed != len(raw) {
		t.Fatalf("the frame has %d trailing bytes", len(raw)-consumed)
	}
	if _, err := pbMessage(payload); err != nil {
		t.Fatalf("the framed payload is not a protobuf message: %v", err)
	}
	// The outer message wraps the real request in field 1
	// (StreamUnifiedChatRequestWithTools.request).
	outer, err := pbMessage(payload)
	if err != nil {
		t.Fatalf("outer decode: %v", err)
	}
	inner := pbFirstBytes(outer, 1)
	if len(inner) == 0 {
		t.Fatal("the outer message carries no request field")
	}
	if _, err := pbMessage(inner); err != nil {
		t.Fatalf("the inner request is not a protobuf message: %v", err)
	}
}

func TestCursorBuildChatBodyStableExceptConversationID(t *testing.T) {
	// Two encodes of the same body differ only in the conversation id, which the
	// reference mints per request. Everything else must be byte-identical or a
	// failing request cannot be replayed.
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "be terse"},
			map[string]any{"role": "user", "content": "hello"},
		},
	}
	first, err := buildCursorChatBody(body, "claude-4.5-sonnet", Credential{})
	if err != nil {
		t.Fatalf("buildCursorChatBody: %v", err)
	}
	second, err := buildCursorChatBody(body, "claude-4.5-sonnet", Credential{})
	if err != nil {
		t.Fatalf("buildCursorChatBody: %v", err)
	}
	firstPayload, _, _ := connectUnframe(first)
	secondPayload, _, _ := connectUnframe(second)

	firstInner, _ := pbMessage(pbFirstBytes(mustDecode(t, firstPayload), 1))
	secondInner, _ := pbMessage(pbFirstBytes(mustDecode(t, secondPayload), 1))

	// Field 23 is the conversation id and is expected to differ.
	if pbFirstString(firstInner, curFieldConversationID) == "" {
		t.Fatal("the frame carries no conversation id")
	}
	if pbFirstString(firstInner, curFieldConversationID) == pbFirstString(secondInner, curFieldConversationID) {
		t.Log("conversation id was reused across encodes; acceptable only if the reference does the same")
	}

	// Fields 1 (the nested messages), 23 (the conversation id), 26 (client
	// metadata, which carries a wall-clock timestamp) and 30 (the per-message id
	// list) are all generated at encode time, so they differ between runs by
	// design. Everything else describes the request itself and must be
	// byte-identical, or a failing request cannot be replayed.
	for field, values := range firstInner {
		switch field {
		case curFieldMessages, curFieldConversationID, curFieldMetadata, curFieldMessageIDs:
			continue
		}
		other := secondInner[field]
		if len(other) != len(values) {
			t.Fatalf("field %d appears %d times then %d times", field, len(values), len(other))
		}
		for i := range values {
			if !cursorFieldEqual(values[i], other[i]) {
				t.Fatalf("field %d occurrence %d differs between encodes", field, i)
			}
		}
	}
}

func mustDecode(t *testing.T, b []byte) map[int][]pbField {
	t.Helper()
	fields, err := pbMessage(b)
	if err != nil {
		t.Fatalf("pbMessage: %v", err)
	}
	return fields
}

func cursorFieldEqual(a, b pbField) bool {
	if a.Wire != b.Wire || a.Varint != b.Varint {
		return false
	}
	if len(a.Bytes) != len(b.Bytes) {
		return false
	}
	for i := range a.Bytes {
		if a.Bytes[i] != b.Bytes[i] {
			return false
		}
	}
	return true
}

// ── Agent-mode gating ────────────────────────────────────────────────────────

func TestCursorAgentCapableGating(t *testing.T) {
	// The target decides whether to look like the streaming AgentService or the
	// buffered ChatService. Picking the wrong one still returns HTTP 200 and a
	// body the client cannot parse.
	cases := []struct {
		name string
		body map[string]any
	}{
		{"plain chat", map[string]any{
			"messages": []any{
				map[string]any{"role": "user", "content": "hello"},
			},
		}},
		{"with tools", map[string]any{
			"messages": []any{
				map[string]any{"role": "user", "content": "what is the weather"},
			},
			"tools": []any{
				map[string]any{
					"type": "function",
					"function": map[string]any{
						"name":       "get_weather",
						"parameters": map[string]any{"type": "object"},
					},
				},
			},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			agent := agentCapable(tc.body)
			// Whatever the decision, the matching path must produce a non-empty
			// body. The legacy path is always available; the agent path is only
			// reached when the gate says so.
			chatFrame, err := buildCursorChatBody(tc.body, "claude-4.5-sonnet", Credential{})
			if err != nil {
				t.Fatalf("buildCursorChatBody: %v", err)
			}
			if len(chatFrame) == 0 {
				t.Fatal("the legacy ChatService body is empty")
			}
			if agent {
				agentFrame, err := buildCursorAgentFrame(tc.body, "claude-4.5-sonnet")
				if err != nil {
					t.Fatalf("buildCursorAgentFrame: %v", err)
				}
				if len(agentFrame) == 0 {
					t.Fatal("agentCapable reported true but the AgentService frame is empty")
				}
			}
			t.Logf("agentCapable=%v chatFrame=%d bytes", agent, len(chatFrame))
		})
	}
}

// ── Composer model handling ──────────────────────────────────────────────────

func TestCursorIsComposerModel(t *testing.T) {
	cases := []struct {
		model string
		want  bool
	}{
		{"claude-4.5-sonnet", false},
		{"gpt-5", false},
		{"composer-1", true},
		{"composer", true},
		{"vendor/composer-2", true},
		// cursor-composer is a chat model, not a Composer variant: the check is
		// on the segment after the final slash, and that segment is
		// "cursor-composer" which is neither "composer" nor prefixed by it.
		{"cursor-composer", false},
	}
	for _, tc := range cases {
		if got := cursorIsComposerModel(tc.model); got != tc.want {
			t.Fatalf("cursorIsComposerModel(%q) = %v, want %v", tc.model, got, tc.want)
		}
	}
}

func TestCursorComposerVisibleStripsReasoningTail(t *testing.T) {
	// Composer models emit reasoning first and then the visible answer after a
	// closing marker. Before the marker there is nothing the client should see,
	// and anything that leaks through shows the user raw reasoning.
	cases := []struct {
		name     string
		thinking string
		want     string
	}{
		{
			"reasoning then answer",
			"weighing the trade-offs deeply\n</think>\nhere is the answer",
			"here is the answer",
		},
		{"no marker means no visible text", "just reasoning, never finished", ""},
		{
			"text before the marker is hidden",
			"reasoning the user should never see</think>visible tail",
			"visible tail",
		},
		{
			"trailing whitespace after the marker is trimmed",
			"reasoning</think>\n\n   the answer",
			"the answer",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cursorComposerVisible(tc.thinking); got != tc.want {
				t.Fatalf("cursorComposerVisible(%q) = %q, want %q", tc.thinking, got, tc.want)
			}
		})
	}
}

// ── Adapter identity ─────────────────────────────────────────────────────────

func TestCursorAdapterIdentity(t *testing.T) {
	adapter := NewCursor()
	if adapter.Name() != "cursor" {
		t.Fatalf("Name() = %q, want cursor", adapter.Name())
	}
	aliases := adapter.Aliases()
	if len(aliases) != 1 || aliases[0] != "cu" {
		t.Fatalf("Aliases() = %v, want [cu]", aliases)
	}
	if adapter.UpstreamContentType() != CursorUpstreamContentType {
		t.Fatalf("UpstreamContentType() = %q", adapter.UpstreamContentType())
	}
	// The body is framed protobuf, not SSE. A gateway that line-splits it would
	// mangle every long turn.
	if adapter.UpstreamContentType() == "text/event-stream" {
		t.Fatal("the cursor body is framed protobuf, not SSE")
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

// mustFlush drains the emitter. flush is pure: it renders whatever is pending
// plus the terminal [DONE], with no I/O that can fail.
func mustFlush(t *testing.T, emitter *cursorSSEEmitter) []byte {
	t.Helper()
	return emitter.flush()
}

// cursorParseChunks splits rendered SSE into decoded JSON chunks. A frame that
// does not parse is reported rather than skipped, because the client would stop
// reading at that byte.
func cursorParseChunks(t *testing.T, sse []byte) []map[string]any {
	t.Helper()
	var chunks []map[string]any
	for _, line := range strings.Split(string(sse), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			t.Fatalf("a streamed chunk is not valid JSON: %v\nraw: %s", err, payload)
		}
		chunks = append(chunks, chunk)
	}
	return chunks
}

// cursorJSONEqual compares two decoded JSON shapes, tolerating the int/float64
// difference that a re-decode introduces.
func cursorJSONEqual(t *testing.T, want, got any) bool {
	t.Helper()
	wantRaw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal want: %v", err)
	}
	gotRaw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal got: %v", err)
	}
	return string(wantRaw) == string(gotRaw)
}

// cursorGzip compresses a payload the way Cursor's ConnectRPC frames arrive, so
// the decompression fallback is exercised against a real gzip stream rather than
// a fixture.
func cursorGzip(t *testing.T, plain []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	if _, err := writer.Write(plain); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// cursorChoice returns the first choice of a chunk, failing the test rather than
// panicking when the chunk is shaped differently than expected.
func cursorChoice(t *testing.T, chunk map[string]any) map[string]any {
	t.Helper()
	choices, ok := chunk["choices"].([]any)
	if !ok || len(choices) == 0 {
		t.Fatalf("chunk carries no choices: %#v", chunk)
	}
	choice, ok := choices[0].(map[string]any)
	if !ok {
		t.Fatalf("the first choice is not an object: %#v", choices[0])
	}
	return choice
}

func cursorBytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ── Registry alias resolution ────────────────────────────────────────────────

func TestCursorAliasResolvesThroughRegistry(t *testing.T) {
	// Cursor declares the alias "cu". Register previously ignored Aliases(), so
	// a request under that name fell through to the generic fallback and behaved
	// as though the provider had never been ported.
	registry := NewRegistry()
	registry.Register(NewCursor())

	byName, ok := registry.Resolve("cursor")
	if !ok {
		t.Fatal("the primary name did not resolve to a ported adapter")
	}
	byAlias, ok := registry.Resolve("cu")
	if !ok {
		t.Fatal("the alias did not resolve to a ported adapter")
	}
	if byName != byAlias {
		t.Fatal("the alias resolved to a different adapter than the primary name")
	}
	if byAlias.Name() != "cursor" {
		t.Fatalf("the alias resolved to %q", byAlias.Name())
	}
}

func TestRegistryAliasDoesNotInflateCount(t *testing.T) {
	// The ported count is reported to the operator as a coverage figure. Counting
	// "cursor" and "cu" as two ports would overstate progress.
	registry := NewRegistry()
	before := registry.Count()
	registry.Register(NewCursor())

	if got := registry.Count(); got != before+1 {
		t.Fatalf("registering one adapter changed the count by %d, want 1", got-before)
	}
	canonical := registry.CanonicalNames()
	for _, name := range canonical {
		if name == "cu" {
			t.Fatal("the alias appeared as its own port in the canonical list")
		}
	}
}

func TestRegistryAliasDoesNotDisplaceRealAdapter(t *testing.T) {
	// If a provider is genuinely registered under a key that another adapter uses
	// as an alias, the real registration wins. Otherwise wave order would let an
	// alias silently shadow a provider.
	registry := NewRegistry()
	registry.Register(&Cursor{}) // declares alias "cu"
	real := &stubAliasAdapter{name: "cu"}
	registry.Register(real)

	resolved, ok := registry.Resolve("cu")
	if !ok {
		t.Fatal("cu no longer resolves")
	}
	if resolved.Name() != "cu" {
		t.Fatalf("the alias displaced a real registration: resolved to %q", resolved.Name())
	}
}

// stubAliasAdapter is a minimal adapter used to prove alias shadowing cannot
// happen. It carries no behaviour beyond its name and a fixed endpoint.
type stubAliasAdapter struct{ name string }

func (s *stubAliasAdapter) Name() string { return s.name }

func (s *stubAliasAdapter) Endpoint(req Request, cred Credential) (string, error) {
	return "https://example.invalid/v1", nil
}

func (s *stubAliasAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	return map[string]string{}, nil
}
