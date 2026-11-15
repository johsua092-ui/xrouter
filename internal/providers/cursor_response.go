package providers

// Cursor response decoding: ConnectRPC frames in, OpenAI SSE out.
//
// Two shapes arrive here:
//
//   - The legacy ChatService replies with a buffered body of framed protobuf
//     messages, each carrying either a ClientSideToolV2Call (field 1) or a
//     StreamUnifiedChatResponse (field 2, text in field 1 and thinking in
//     field 25).
//   - AgentService replies with a live duplex stream whose frames are
//     AgentServerMessage variants: interaction_update (1), exec (2), kv (4).
//     Exec and kv are *requests* — they must be answered on the same stream.
//
// Both funnel into the same SSE emitter as every other provider: OpenAI
// chat.completion.chunk frames terminated by [DONE].

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// CursorUpstreamContentType is what Cursor answers with. The body is framed
// protobuf, not SSE, so the gateway must not hand it to the SSE line reader.
const CursorUpstreamContentType = "application/x-connect+proto"

// cursorFrame is one ConnectRPC frame after unframing.
type cursorFrame struct {
	Flags   byte
	Payload []byte
}

// cursorFrameDecoder buffers a byte stream and yields complete frames.
//
// A frame can be split across reads, so the decoder owns its buffer the same way
// the Kiro EventStream decoder does. The length prefix is 4 bytes big-endian
// after a 1-byte flags field.
type cursorFrameDecoder struct {
	buf []byte
}

func newCursorFrameDecoder() *cursorFrameDecoder { return &cursorFrameDecoder{} }

// Buffered reports how many bytes are held pending a complete frame.
func (d *cursorFrameDecoder) Buffered() int { return len(d.buf) }

// cursorFrameMaxPayload bounds one frame. Cursor returns whole assistant turns
// in a single frame on the legacy path, so this is generous; it exists to stop a
// desynchronised length prefix from allocating without limit.
const cursorFrameMaxPayload = 32 * 1024 * 1024

// Push appends a read and returns every frame that is now complete.
func (d *cursorFrameDecoder) Push(chunk []byte) ([]cursorFrame, error) {
	d.buf = append(d.buf, chunk...)
	if len(d.buf) > cursorFrameMaxPayload {
		return nil, fmt.Errorf("cursor: buffered bytes exceed %d without a complete frame", cursorFrameMaxPayload)
	}

	var frames []cursorFrame
	for {
		// A length prefix above the cap never unframes. Report it rather than
		// spinning, so the stream fails loudly instead of going silent.
		if len(d.buf) >= 5 {
			declared := int(binary.BigEndian.Uint32(d.buf[1:5]))
			if declared > cursorFrameMaxPayload {
				// Drop the poisoned bytes so a caller that inspects the decoder
				// after a failed push sees a clean buffer.
				d.buf = d.buf[:0]
				return nil, fmt.Errorf("cursor: frame declares %d bytes, above the %d cap", declared, cursorFrameMaxPayload)
			}
		}

		payload, consumed, ok := connectUnframe(d.buf)
		if !ok {
			break
		}
		flags := d.buf[0]
		d.buf = d.buf[consumed:]

		// A trailer frame carries end-of-stream metadata, not a message body.
		if flags&connectFlagTrailer != 0 {
			continue
		}
		if flags&connectFlagGzip != 0 {
			decompressed, err := cursorDecompress(payload)
			if err != nil {
				return nil, fmt.Errorf("cursor: frame decompression failed: %w", err)
			}
			payload = decompressed
		}
		frames = append(frames, cursorFrame{Flags: flags, Payload: payload})
	}
	return frames, nil
}

// cursorDecompress mirrors the Node fallback chain: gzip first, then zlib, then
// raw deflate. The upstream uses gzip in practice, but a trailer-associated
// frame has been observed in zlib form, and a frame that fails to decode would
// otherwise surface as an empty turn.
func cursorDecompress(payload []byte) ([]byte, error) {
	// A JSON error body is not compressed even when the flag says so.
	if len(payload) > 2 && payload[0] == '{' && payload[1] == '"' {
		return payload, nil
	}

	if reader, err := gzip.NewReader(bytes.NewReader(payload)); err == nil {
		if out, err := io.ReadAll(reader); err == nil {
			reader.Close()
			return out, nil
		}
		reader.Close()
	}
	if reader, err := zlib.NewReader(bytes.NewReader(payload)); err == nil {
		if out, err := io.ReadAll(reader); err == nil {
			reader.Close()
			return out, nil
		}
		reader.Close()
	}
	rawReader := flate.NewReader(bytes.NewReader(payload))
	if out, err := io.ReadAll(rawReader); err == nil {
		rawReader.Close()
		return out, nil
	}
	rawReader.Close()
	return nil, errors.New("payload is not gzip, zlib or raw deflate")
}

// cursorDecodedFrame is one message extracted from a payload.
//
// A payload carries at most one of these: a tool call, assistant text, or
// nothing (a control frame). Thinking travels alongside text in the same
// response message.
type cursorDecodedFrame struct {
	Text     string
	Thinking string
	ToolCall *cursorToolCall
	// IsJSONError is set when the payload was an upstream JSON error body rather
	// than a protobuf message.
	JSONError map[string]any
}

// cursorToolCall is a decoded tool invocation.
type cursorToolCall struct {
	ID        string
	Name      string
	Arguments string
	IsLast    bool
}

// decodeCursorPayload extracts the message from one framed payload.
func decodeCursorPayload(payload []byte) (cursorDecodedFrame, error) {
	// An upstream error can arrive as a plain JSON body on either path.
	if len(payload) > 0 && payload[0] == '{' {
		var probe map[string]any
		if err := json.Unmarshal(payload, &probe); err == nil {
			if _, has := probe["error"]; has {
				return cursorDecodedFrame{JSONError: probe}, nil
			}
		}
	}

	fields, err := pbMessage(payload)
	if err != nil {
		return cursorDecodedFrame{}, err
	}

	// StreamUnifiedChatResponseWithTools.tool_call = 1
	if raw := pbFirstBytes(fields, agentToolMsgFieldCall); raw != nil {
		id, name, args := decodeAgentToolCall(raw)
		if id != "" && name != "" {
			isLast := pbFirstVarint(mustPBMessage(raw), agentToolCallFieldIsLast) != 0
			if args == "" {
				args = "{}"
			}
			return cursorDecodedFrame{ToolCall: &cursorToolCall{
				ID: id, Name: name, Arguments: args, IsLast: isLast,
			}}, nil
		}
	}

	// StreamUnifiedChatResponseWithTools.response = 2
	if raw := pbFirstBytes(fields, agentToolMsgFieldResponse); raw != nil {
		inner, err := pbMessage(raw)
		if err != nil {
			return cursorDecodedFrame{}, err
		}
		out := cursorDecodedFrame{Text: pbFirstString(inner, agentToolMsgFieldResponseTxt)}
		// Thinking (field 25) wraps another message with its text in field 1.
		if thinkingRaw := pbFirstBytes(inner, agentToolMsgFieldThinking); thinkingRaw != nil {
			thinking, err := pbMessage(thinkingRaw)
			if err == nil {
				out.Thinking = pbFirstString(thinking, agentToolMsgFieldThinkingTxt)
			}
		}
		return out, nil
	}

	return cursorDecodedFrame{}, nil
}

// mustPBMessage decodes and discards the error. Used where the bytes have
// already been validated by an enclosing decode.
func mustPBMessage(b []byte) map[int][]pbField {
	fields, err := pbMessage(b)
	if err != nil {
		return map[int][]pbField{}
	}
	return fields
}

// cursorSSEEmitter renders OpenAI chunks and accumulates the non-streaming body.
//
// It is shared by both wire formats so the two paths cannot drift in their
// chunk shape, tool-call indexing, or finish-reason logic.
type cursorSSEEmitter struct {
	responseID string
	created    int64
	model      string

	pending []byte

	chunkIndex int
	toolIndex  int
	sawText    bool
	sawTool    bool
	// toolCalls preserves declaration order. A Go map would randomise it and the
	// client indexes tool calls positionally.
	toolCalls []*cursorToolCall
	toolSeen  map[string]bool
}

func newCursorSSEEmitter(model string) *cursorSSEEmitter {
	now := time.Now()
	return &cursorSSEEmitter{
		// Claude clients derive Anthropic's message id by stripping "chatcmpl-",
		// so the remainder must already be in Anthropic's msg_ form.
		responseID: fmt.Sprintf("chatcmpl-msg_%d", now.UnixNano()),
		created:    now.Unix(),
		model:      model,
		toolSeen:   map[string]bool{},
	}
}

// emitChunk appends one chat.completion.chunk. The first delta carries the role
// so a client knows a message has begun.
func (e *cursorSSEEmitter) emitChunk(delta map[string]any, finishReason string) {
	if e.chunkIndex == 0 && finishReason == "" {
		merged := map[string]any{"role": "assistant"}
		for k, v := range delta {
			merged[k] = v
		}
		delta = merged
	}
	e.chunkIndex++
	e.pending = append(e.pending, cursorSSEChunk(e.responseID, e.created, e.model, delta, finishReason, nil)...)
}

// addText emits a visible-text delta.
func (e *cursorSSEEmitter) addText(text string) {
	if text == "" {
		return
	}
	e.sawText = true
	e.emitChunk(map[string]any{"content": text}, "")
}

// addThinking emits a reasoning delta. Reasoning stays in reasoning_content,
// which downstream translators map onto Claude thinking blocks.
func (e *cursorSSEEmitter) addThinking(text string) {
	if text == "" {
		return
	}
	e.emitChunk(map[string]any{"reasoning_content": text}, "")
}

// addToolCall emits the declaration delta plus the argument delta for one call.
//
// Two deltas, not one: the declaration establishes index/id/name so a client can
// create the slot, and the arguments arrive separately because a later fragment
// may append to them.
func (e *cursorSSEEmitter) addToolCall(call *cursorToolCall) {
	index := e.toolIndex
	if e.toolSeen[call.ID] {
		index = -1
		for i, existing := range e.toolCalls {
			if existing.ID == call.ID {
				index = i
				break
			}
		}
		if index < 0 {
			return
		}
	} else {
		e.toolSeen[call.ID] = true
		e.toolCalls = append(e.toolCalls, call)
		e.toolIndex = len(e.toolCalls)
	}

	e.sawTool = true
	e.emitChunk(map[string]any{
		"tool_calls": []any{map[string]any{
			"index": index,
			"id":    call.ID,
			"type":  "function",
			"function": map[string]any{
				"name":      call.Name,
				"arguments": "",
			},
		}},
	}, "")
	e.emitChunk(map[string]any{
		"tool_calls": []any{map[string]any{
			"index": index,
			"function": map[string]any{
				"arguments": call.Arguments,
			},
		}},
	}, "")
}

// finishIfFlushed declares the turn over. Emitted only when content is already
// in flight: an early terminal closes the stream before a retry can recover it.
func (e *cursorSSEEmitter) flush() []byte {
	finishReason := "stop"
	if e.sawTool {
		finishReason = "tool_calls"
	}
	e.emitChunk(map[string]any{}, finishReason)
	e.pending = append(e.pending, []byte("data: [DONE]\n\n")...)
	out := e.pending
	e.pending = nil
	return out
}

// cursorSSEError renders an SSE error frame plus [DONE]. A stream that ends
// without a terminal reads as a hang, so every failure path emits one.
func cursorSSEError(code, message string) []byte {
	payload := map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    "upstream_error",
			"code":    code,
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return []byte("data: [DONE]\n\n")
	}
	out := append(append([]byte("data: "), raw...), '\n', '\n')
	return append(out, []byte("data: [DONE]\n\n")...)
}

// cursorSSEChunk renders one OpenAI chat.completion.chunk frame.
func cursorSSEChunk(id string, created int64, model string, delta map[string]any, finishReason string, usage map[string]any) []byte {
	choice := map[string]any{
		"index":         0,
		"delta":         delta,
		"finish_reason": nil,
	}
	if finishReason != "" {
		choice["finish_reason"] = finishReason
	}
	frame := map[string]any{
		"id":      id,
		"object":  "chat.completion.chunk",
		"created": created,
		"model":   model,
		"choices": []any{choice},
	}
	if usage != nil {
		frame["usage"] = usage
	}
	raw, err := json.Marshal(frame)
	if err != nil {
		return nil
	}
	return append(append([]byte("data: "), raw...), '\n', '\n')
}

// cursorExtractError pulls a readable message out of an upstream error body.
func cursorExtractError(body map[string]any) string {
	if body == nil {
		return ""
	}
	errField, _ := body["error"].(map[string]any)
	if errField == nil {
		return ""
	}
	if details, ok := errField["details"].([]any); ok && len(details) > 0 {
		if detail, ok := details[0].(map[string]any); ok {
			if debug, ok := detail["debug"].(map[string]any); ok {
				if inner, ok := debug["details"].(map[string]any); ok {
					if title, _ := inner["title"].(string); title != "" {
						return title
					}
					if text, _ := inner["detail"].(string); text != "" {
						return text
					}
				}
			}
		}
	}
	if message, _ := errField["message"].(string); message != "" {
		return message
	}
	return ""
}

// cursorIsRateLimited reports whether an upstream error is a quota failure.
func cursorIsRateLimited(body map[string]any) bool {
	if body == nil {
		return false
	}
	errField, _ := body["error"].(map[string]any)
	if errField == nil {
		return false
	}
	code, _ := errField["code"].(string)
	return code == "resource_exhausted"
}

// decodeCursorBufferedBody converts a complete legacy ChatService body into SSE.
//
// The legacy path returns the whole turn in one body, so this walks every frame,
// accumulates text, thinking and tool calls, and emits SSE. Duplicate tool-call
// fragments are merged by id; a call left without an is_last marker is still
// finalised, because dropping it would lose the turn's answer.
func decodeCursorBufferedBody(raw []byte, model string) ([]byte, error) {
	decoder := newCursorFrameDecoder()
	frames, err := decoder.Push(raw)
	if err != nil {
		return nil, err
	}
	if decoder.Buffered() > 0 {
		return nil, fmt.Errorf("cursor: body ended with a truncated frame (%d bytes)", decoder.Buffered())
	}

	emitter := newCursorSSEEmitter(model)
	composer := cursorIsComposerModel(model)
	thinkingAcc := ""
	emittedComposerVisible := 0
	order := []string{}
	byID := map[string]*cursorToolCall{}

	for _, frame := range frames {
		decoded, err := decodeCursorPayload(frame.Payload)
		if err != nil {
			// A frame that decodes to a protocol error is reported only when
			// nothing usable has been produced yet; otherwise the bytes the
			// client already received are kept and the turn is closed normally.
			if emitter.chunkIndex == 0 {
				return cursorSSEError("cursor_decode_failed", err.Error()), nil
			}
			break
		}
		if decoded.JSONError != nil {
			if emitter.chunkIndex == 0 {
				return cursorSSEError("cursor_upstream_error", cursorExtractError(decoded.JSONError)), nil
			}
			break
		}

		if decoded.Text != "" {
			emitter.addText(decoded.Text)
		}
		if decoded.Thinking != "" {
			thinkingAcc += decoded.Thinking
			if composer {
				// Composer puts the visible answer after </think> in the thinking
				// channel and never sends a text delta. Emit only the new tail.
				visible := cursorComposerVisible(thinkingAcc)
				if len(visible) > emittedComposerVisible {
					delta := visible[emittedComposerVisible:]
					emittedComposerVisible = len(visible)
					emitter.addText(delta)
				}
			}
		}
		if decoded.ToolCall != nil {
			call := decoded.ToolCall
			if existing, ok := byID[call.ID]; ok {
				existing.Arguments += call.Arguments
				existing.IsLast = call.IsLast
			} else {
				clone := *call
				byID[call.ID] = &clone
				order = append(order, call.ID)
			}
		}
	}

	// A thinking-only turn still has to answer. Composer keeps the trailing
	// visible span; every other model gets the reasoning text as its answer.
	if !emitter.sawText && thinkingAcc != "" {
		fallback := strings.TrimSpace(thinkingAcc)
		if composer {
			fallback = strings.TrimSpace(cursorComposerVisible(thinkingAcc))
		}
		if fallback != "" {
			emitter.addText(fallback)
		}
	}

	for _, id := range order {
		call := byID[id]
		if call.Arguments == "" {
			call.Arguments = "{}"
		}
		emitter.addToolCall(call)
	}

	if emitter.chunkIndex == 0 {
		return cursorSSEError("cursor_empty_turn", "Cursor returned an empty turn"), nil
	}
	return emitter.flush(), nil
}

// cursorIsComposerModel reports whether a model id names a Composer variant,
// which carries its visible answer in the thinking channel.
func cursorIsComposerModel(model string) bool {
	base := model
	if idx := strings.LastIndex(base, "/"); idx >= 0 {
		base = base[idx+1:]
	}
	lower := strings.ToLower(base)
	return lower == "composer" || strings.HasPrefix(lower, "composer-") || strings.HasPrefix(lower, "composer.")
}

// cursorComposerVisible returns the text after the final </think> marker.
func cursorComposerVisible(thinking string) string {
	const endTag = "</think>"
	idx := strings.LastIndex(thinking, endTag)
	if idx < 0 {
		return ""
	}
	return strings.TrimLeft(thinking[idx+len(endTag):], " \t\r\n")
}
