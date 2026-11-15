package providers

// The Kiro response path: AWS EventStream frames in, OpenAI SSE out.
//
// Frames are decoded by KiroEventStreamDecoder (kiro.go) and turned into
// chat.completion.chunk here. The ordering rules below are all load-bearing and
// each one exists because a live run broke without it.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// KiroUpstreamContentType is what the CodeWhisperer surfaces answer with. It is
// not text/event-stream, which is exactly why the gateway must not hand this
// stream to the SSE path.
const KiroUpstreamContentType = "application/vnd.amazon.eventstream"

// DecodeStream converts the upstream EventStream body into SSE.
//
// The returned reader is lazy: frames are decoded as the client reads, so a slow
// client applies backpressure to the upstream instead of the whole answer being
// buffered. That matters because Kiro turns routinely run to tens of thousands of
// tokens.
func (k *Kiro) DecodeStream(model string, body io.Reader) (io.Reader, error) {
	return newKiroSSEStream(body, model), nil
}

// UpstreamContentType reports the EventStream media type.
func (k *Kiro) UpstreamContentType() string { return KiroUpstreamContentType }

// kiroSSEStream is the lazy decoder. It implements io.Reader by pulling frames
// from the upstream and buffering the SSE bytes they produce.
type kiroSSEStream struct {
	source   io.Reader
	decoder  *KiroEventStreamDecoder
	model    string
	state    *kiroStreamState
	response string
	created  int64

	pending []byte
	err     error
	done    bool
	// sawFrameOnce guards the in-band keepalive: a client that sees no bytes at
	// all while the model thinks may time out its own read, and Kiro can spend a
	// long time emitting only metering frames before the first text.
	sawFrameOnce bool
}

// kiroReasoningAdvance mirrors the Node default. Reasoning is emitted as
// reasoning_content, which downstream translators map onto Claude thinking blocks
// or Responses reasoning items.
func newKiroSSEStream(source io.Reader, model string) *kiroSSEStream {
	now := time.Now()
	return &kiroSSEStream{
		source:   source,
		decoder:  NewKiroEventStreamDecoder(),
		model:    ResolveKiroModel(model).Upstream,
		response: fmt.Sprintf("chatcmpl-%d", now.UnixNano()),
		created:  now.Unix(),
		state: &kiroStreamState{
			tools:          map[string]*kiroToolBuffer{},
			transportState: "consuming_response",
		},
	}
}

// Read pulls SSE bytes out of the decoder.
//
// Two invariants hold, and both matter for a streaming client:
//   - It never returns a nil error with no bytes. Each iteration either produces
//     output or ends the stream, so a caller cannot spin.
//   - It sets s.done when it stops, so the next call returns io.EOF promptly
//     instead of re-entering advance on a spent upstream.
//
// Errors are already rendered as terminal SSE frames by the time they reach
// here, which is why the only error this returns is EOF.
func (s *kiroSSEStream) Read(p []byte) (int, error) {
	for len(s.pending) == 0 {
		if s.done {
			return 0, io.EOF
		}
		if !s.advance() {
			s.done = true
			if len(s.pending) == 0 {
				return 0, io.EOF
			}
		}
	}
	n := copy(p, s.pending)
	s.pending = s.pending[n:]
	return n, nil
}

// advance pulls one upstream chunk and appends whatever SSE it produced.
//
// The returned bool reports whether the stream can still make progress. A false
// return means there is nothing left to read and no terminal frame was emitted,
// so Read must stop rather than call again: the previous version retried
// unconditionally, which turned a spent upstream into an unkillable busy loop —
// the client saw a request that never completed.
func (s *kiroSSEStream) advance() (live bool) {
	buf := make([]byte, 32*1024)
	n, err := s.source.Read(buf)

	if n > 0 {
		events, decodeErr := s.decoder.Push(buf[:n])
		if decodeErr != nil {
			// The decoder consumed the offending frame before it could verify
			// the message CRC, so nothing is buffered and the boundary is lost.
			// Report the corruption and end the stream; finishWithError always
			// emits a terminal frame, so the client is never left hanging.
			s.finishWithError("kiro_missing_terminal", decodeErr.Error(), map[string]any{
				"transport_state": "corrupt_frame",
			})
			s.done = true
			return false
		}
		for _, event := range events {
			if s.handleEvent(event) {
				s.done = true
				break
			}
		}
		if len(events) > 0 && !s.done {
			s.sawFrameOnce = true
		}
		return !s.done || len(s.pending) > 0
	}

	if err != nil {
		if errors.Is(err, io.EOF) {
			s.finalise()
			return false
		}
		s.finishWithError("kiro_missing_terminal", err.Error(), map[string]any{
			"transport_state": "upstream_error",
		})
		s.done = true
		return false
	}

	// A read that returned no bytes and no error made no progress. Treating it as
	// end-of-stream is the only safe reading: the alternative is a busy loop that
	// never terminates, which is exactly what a streaming client experiences as a
	// hung request. Reachable in practice — a peer that has finished writing but
	// not yet closed the connection returns a zero-length read.
	s.finalise()
	return false
}

// handleEvent decodes one frame into SSE. Returns true when the stream is
// finished and no further frames should be read.
func (s *kiroSSEStream) handleEvent(event KiroEvent) bool {
	messageType := event.HeaderValue(":message-type")
	if messageType == "error" || messageType == "exception" {
		message, _ := event.Payload["message"].(string)
		if message == "" {
			message = "Kiro upstream sent an EventStream " + messageType
		}
		s.finishWithError("kiro_upstream_eventstream_error", message, map[string]any{
			"transport_state": "upstream_error",
		})
		return true
	}

	eventType := event.HeaderValue(":event-type")
	s.state.validatedFrames++

	switch eventType {
	case "assistantResponseEvent":
		content, _ := event.Payload["content"].(string)
		if content == "" {
			return false
		}
		visible, reasoning := kiroStripThinking(content, s.state)
		if reasoning != "" {
			s.state.hasReasoning = true
			s.state.totalContentLength += len(reasoning)
			s.emit(map[string]any{"reasoning_content": reasoning})
		}
		// The guard matters: an empty visible span after stripping thinking is
		// normal (the whole frame was reasoning), but emitting an empty content
		// delta makes strict clients render a gap.
		if visible != "" || !s.state.hasReasoning {
			s.state.hasText = s.state.hasText || visible != ""
			s.state.totalContentLength += len(visible)
			s.emit(map[string]any{"content": visible})
		}

	case "reasoningContentEvent":
		content := kiroReasoningText(event.Payload)
		if content == "" {
			return false
		}
		s.state.hasReasoning = true
		s.state.totalContentLength += len(content)
		s.emit(map[string]any{"reasoning_content": content})

	case "codeEvent":
		content, _ := event.Payload["content"].(string)
		if content == "" {
			return false
		}
		s.state.hasCode = true
		s.state.totalContentLength += len(content)
		s.emit(map[string]any{"content": content})

	case "toolUseEvent":
		s.state.sawToolUse = true
		s.accumulateToolUse(event.Payload)

	case "messageStopEvent":
		s.state.explicitStop = true
		reason := normalizeKiroStopReason(firstString(event.Payload, "stopReason", "stop_reason"))
		if reason == "" {
			if s.state.sawToolUse {
				reason = "tool_use"
			} else {
				reason = "end_turn"
			}
		}
		merged := mergeKiroStopReason(s.state.stopReason, reason)
		if merged != s.state.stopReason {
			s.state.terminalProvenance = "message_stop_event"
		}
		s.state.stopReason = merged

	case "metadataEvent", "MetadataEvent":
		metadata, _ := event.Payload["metadataEvent"].(map[string]any)
		if metadata == nil {
			metadata, _ = event.Payload["metadata"].(map[string]any)
		}
		if metadata == nil {
			metadata = event.Payload
		}
		reason := normalizeKiroStopReason(firstString(metadata, "stopReason", "stop_reason"))
		if reason != "" {
			s.state.explicitStop = true
			merged := mergeKiroStopReason(s.state.stopReason, reason)
			if merged != s.state.stopReason {
				s.state.terminalProvenance = "metadata_stop_reason"
			}
			s.state.stopReason = merged
		}

	case "contextUsageEvent":
		if pct, ok := asFloatLoose(event.Payload["contextUsagePercentage"]); ok {
			s.state.contextUsagePct = pct
			s.state.hasContextUsage = true
		}

	case "meteringEvent":
		s.state.hasMetering = true
		metering, _ := event.Payload["meteringEvent"].(map[string]any)
		if metering == nil {
			metering = event.Payload
		}
		if credits, ok := asFloatLoose(metering["usage"]); ok {
			if s.state.usage == nil {
				s.state.usage = map[string]any{}
			}
			s.state.usage["kiro_credits"] = credits
			unit, _ := metering["unit"].(string)
			if unit == "" {
				unit = "credit"
			}
			s.state.usage["kiro_credit_unit"] = unit
		}

	case "metricsEvent":
		metrics, _ := event.Payload["metricsEvent"].(map[string]any)
		if metrics == nil {
			metrics = event.Payload
		}
		prompt := intLoose(metrics["inputTokens"])
		completion := intLoose(metrics["outputTokens"])
		if prompt != 0 || completion != 0 {
			if s.state.usage == nil {
				s.state.usage = map[string]any{}
			}
			s.state.usage["prompt_tokens"] = prompt
			s.state.usage["completion_tokens"] = completion
			s.state.usage["total_tokens"] = prompt + completion
			if cacheRead := intLoose(firstValue(metrics, "cacheReadInputTokens", "cache_read_input_tokens")); cacheRead != 0 {
				s.state.usage["cache_read_input_tokens"] = cacheRead
			}
			if cacheCreate := intLoose(firstValue(metrics, "cacheCreationInputTokens", "cache_creation_input_tokens")); cacheCreate != 0 {
				s.state.usage["cache_creation_input_tokens"] = cacheCreate
			}
		}
	}

	// A validated frame that produced no client bytes gets an SSE comment, so a
	// long thinking stretch does not look like a dead connection. Clients ignore
	// comments by spec.
	if !s.state.finished && s.state.validatedFrames > 0 && len(s.pending) == 0 && !s.sawFrameOnce {
		s.pending = append(s.pending, []byte(": kiro-upstream\n\n")...)
	}
	return false
}

// kiroReasoningText reads a reasoning payload from either the nested envelope or
// a bare string. The upstream has used both shapes.
func kiroReasoningText(payload map[string]any) string {
	value, ok := payload["reasoningContentEvent"]
	if !ok {
		value = payload
	}
	switch v := value.(type) {
	case string:
		return v
	case map[string]any:
		if text, ok := v["text"].(string); ok && text != "" {
			return text
		}
		if content, ok := v["content"].(string); ok && content != "" {
			return content
		}
	}
	if content, ok := payload["content"].(string); ok {
		return content
	}
	return ""
}

// accumulateToolUse folds one toolUseEvent into the pending tool map.
//
// Frame validation is deliberately strict here. A fragment-type change (string
// chunks then an object, or the reverse) is corruption, not a merge case: joining
// them would produce JSON that parses into the wrong shape, and a tool call with
// wrong arguments is worse than a dropped one. The per-tool validation happens at
// emit time so one bad call does not take the others down with it.
func (s *kiroSSEStream) accumulateToolUse(payload map[string]any) {
	values := []any{payload}
	if raw, ok := payload["toolUseEvent"]; ok {
		if arr, ok := raw.([]any); ok {
			values = arr
		} else {
			values = []any{raw}
		}
	}

	for _, raw := range values {
		value, ok := raw.(map[string]any)
		if !ok || value == nil {
			continue
		}
		name, _ := value["name"].(string)
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}

		id, hasID := value["toolUseId"].(string)
		if !hasID || strings.TrimSpace(id) == "" {
			id = fmt.Sprintf("call_%d_%d", s.created, len(s.state.tools)+1)
		}

		tool, exists := s.state.tools[id]
		if !exists {
			tool = &kiroToolBuffer{id: id, name: name}
			s.state.tools[id] = tool
			s.state.bufferedToolBytes += len(id) + len(name) + 32
		} else if tool.name != name {
			// A rename mid-call would emit a call whose name does not match its
			// arguments; drop the buffer rather than emit a wrong tool.
			s.state.toolValidationErr = "Kiro tool name changed between fragments"
			continue
		}

		s.appendToolInput(tool, value["input"])
	}
}

func (s *kiroSSEStream) appendToolInput(tool *kiroToolBuffer, input any) {
	if input == nil {
		return
	}
	switch v := input.(type) {
	case string:
		if tool.inputKind != "" && tool.inputKind != "string" {
			s.state.toolValidationErr = "Kiro tool input changed fragment type"
			return
		}
		tool.inputKind = "string"
		tool.inputChunks = append(tool.inputChunks, v)
		s.state.bufferedToolBytes += len(v)
	case map[string]any:
		if tool.inputKind != "" && tool.inputKind != "object" {
			s.state.toolValidationErr = "Kiro tool input changed fragment type"
			return
		}
		tool.inputKind = "object"
		s.state.bufferedToolBytes -= tool.inputBytes
		tool.inputObject = v
		raw, err := json.Marshal(v)
		if err != nil {
			s.state.toolValidationErr = "Kiro tool input is not serialisable"
			return
		}
		tool.inputBytes = len(raw)
		s.state.bufferedToolBytes += tool.inputBytes
	default:
		s.state.toolValidationErr = "Kiro tool input must be a JSON object"
	}
}

// emitTools flushes every accumulated tool call as two deltas: one declaring the
// call, one carrying its arguments.
//
// Validation is per tool. An unusable call is dropped and logged; the others in
// the same turn still go out. An earlier version threw out of this loop, which
// discarded every complete call in the turn alongside the broken one — the client
// saw a turn that answered nothing.
func (s *kiroSSEStream) emitTools() {
	for _, tool := range s.state.tools {
		input, ok := tool.parsedInput()
		if !ok {
			s.state.toolValidationErr = "Kiro tool call input is not a valid object"
			continue
		}
		// The upstream wraps MCP tools in a generic `tool_call` envelope whose
		// input must name the real tool and carry its arguments. Unwrapping is
		// the client's job, but the envelope has to be well-formed to reach it.
		if tool.name == "tool_call" {
			nested, _ := input["name"].(string)
			if strings.TrimSpace(nested) == "" {
				s.state.toolValidationErr = "Invalid Kiro tool_call payload: missing nested MCP tool name"
				continue
			}
			if _, has := input["arguments"]; !has {
				s.state.toolValidationErr = "Invalid Kiro tool_call payload: missing nested MCP tool arguments"
				continue
			}
		}

		index := s.state.toolCounter
		s.state.toolCounter++

		s.emit(map[string]any{
			"tool_calls": []any{map[string]any{
				"index": index,
				"id":    tool.id,
				"type":  "function",
				"function": map[string]any{
					"name":      tool.name,
					"arguments": "",
				},
			}},
		})

		serialized, err := json.Marshal(input)
		if err != nil {
			continue
		}
		s.emit(map[string]any{
			"tool_calls": []any{map[string]any{
				"index": index,
				"function": map[string]any{
					"arguments": string(serialized),
				},
			}},
		})

		// Tool arguments are billed output like any other completion bytes.
		// Leaving them out of the total made the /4 estimator report zero output
		// tokens for every turn whose entire answer was a tool call.
		s.state.totalContentLength += len(tool.name) + len(serialized)
		s.state.hasToolCalls = true
	}
	s.state.tools = map[string]*kiroToolBuffer{}
	s.state.bufferedToolBytes = 0
}

func (t *kiroToolBuffer) parsedInput() (map[string]any, bool) {
	switch t.inputKind {
	case "object":
		if t.inputObject == nil {
			return nil, false
		}
		return t.inputObject, true
	case "string":
		var parsed map[string]any
		if err := json.Unmarshal([]byte(strings.Join(t.inputChunks, "")), &parsed); err != nil {
			return nil, false
		}
		if parsed == nil {
			return nil, false
		}
		return parsed, true
	}
	return nil, false
}

// emit appends one chat.completion.chunk. The first delta of a stream carries the
// role, which is how an OpenAI client knows a message has begun.
func (s *kiroSSEStream) emit(delta map[string]any) {
	if s.state.chunkIndex == 0 {
		merged := map[string]any{"role": "assistant"}
		for k, v := range delta {
			merged[k] = v
		}
		delta = merged
	}
	s.state.chunkIndex++
	s.pending = append(s.pending, kiroSSEChunk(s.response, s.created, s.model, delta, "", nil)...)
}

// finishWithError emits a terminal error frame plus [DONE]. The [DONE] matters:
// without it a client keeps its connection open waiting for a terminal.
func (s *kiroSSEStream) finishWithError(code, message string, details map[string]any) {
	s.state.finished = true
	if s.state.transportState == "" {
		s.state.transportState = "corrupt_frame"
	}
	detail := map[string]any{
		"terminal_provenance": s.state.terminalProvenance,
		"transport_state":     s.state.transportState,
		"stop_reason":         s.state.stopReason,
		"stop_disposition":    "terminal_incomplete",
		"response_state":      "no_semantic_output",
	}
	for k, v := range details {
		detail[k] = v
	}
	s.pending = append(s.pending, kiroSSEError(code, message, detail)...)
}

// finalise closes a stream that ended cleanly.
//
// The ordering here is the contract:
//  1. A trailing partial frame is corruption, not a clean end.
//  2. A non-success stop disposition is a terminal error — unless the model
//     already streamed content and the reason is a budget exhaustion, which is
//     what finish_reason "length" exists for.
//  3. Tools flush before the emptiness check, because a turn whose whole answer
//     is a tool call has no text and is not empty.
//  4. A turn with no output and no explicit stop is a failure, not an empty
//     success.
func (s *kiroSSEStream) finalise() {
	if s.state.finished {
		return
	}
	if s.decoder.Buffered() > 0 {
		s.finishWithError("kiro_missing_terminal", "Kiro EventStream ended with a truncated frame", map[string]any{
			"transport_state":        "incomplete_frame",
			"incomplete_frame_bytes": s.decoder.Buffered(),
		})
		return
	}
	s.state.transportState = "clean_eof"

	truncatedAfterOutput := s.truncatedButUsable()

	declared := kiroStopDisposition(s.state.stopReason, s.state.sawToolUse)
	if !truncatedAfterOutput && kiroTerminalDisposition(declared) {
		s.finishWithError(kiroDispositionCode(declared),
			"Kiro ended with non-success stop reason: "+s.state.stopReason,
			map[string]any{
				"transport_state":  s.state.transportState,
				"stop_disposition": declared,
			})
		return
	}

	s.emitTools()

	if s.state.toolValidationErr != "" && !s.state.hasToolCalls &&
		!s.state.hasText && !s.state.hasReasoning && !s.state.hasCode {
		s.finishWithError("invalid_kiro_tool_call", s.state.toolValidationErr, map[string]any{
			"transport_state":  s.state.transportState,
			"stop_disposition": "retryable_protocol_failure",
		})
		return
	}

	if !s.state.hasText && !s.state.hasReasoning && !s.state.hasCode && !s.state.hasToolCalls && !s.state.explicitStop {
		s.finishWithError("kiro_missing_terminal", "Kiro EventStream ended without model output", map[string]any{
			"transport_state": s.state.transportState,
		})
		return
	}

	disposition := kiroStopDisposition(s.state.stopReason, s.state.hasToolCalls)
	if !truncatedAfterOutput && kiroTerminalDisposition(disposition) {
		s.finishWithError(kiroDispositionCode(disposition),
			"Kiro ended with non-success stop reason: "+s.state.stopReason,
			map[string]any{
				"transport_state":  s.state.transportState,
				"stop_disposition": disposition,
			})
		return
	}

	s.fillEstimatedUsage()

	finishReason := "stop"
	switch {
	case truncatedAfterOutput:
		finishReason = "length"
	case s.state.hasToolCalls:
		finishReason = "tool_calls"
	case disposition == "length":
		finishReason = "length"
	}

	s.state.finished = true
	s.pending = append(s.pending, kiroSSEChunk(s.response, s.created, s.model, map[string]any{}, finishReason, s.state.usage)...)
	s.pending = append(s.pending, []byte("data: [DONE]\n\n")...)
}

// truncatedButUsable reports the case where the model already streamed content
// and then hit a budget ceiling. That is a truncated answer, which finish_reason
// "length" describes, not a failed turn. Discarding bytes the client already
// received is strictly worse than labelling them truncated.
func (s *kiroSSEStream) truncatedButUsable() bool {
	if kiroStopDisposition(s.state.stopReason, false) != "terminal_incomplete" {
		return false
	}
	if !kiroTruncationStopReasons[s.state.stopReason] {
		return false
	}
	return s.state.chunkIndex > 0
}

func kiroTerminalDisposition(disposition string) bool {
	switch disposition {
	case "retryable_protocol_failure", "terminal_incomplete", "terminal_refusal", "unknown_failure":
		return true
	}
	return false
}

func kiroDispositionCode(disposition string) string {
	switch disposition {
	case "retryable_protocol_failure":
		return "kiro_retryable_protocol_failure"
	case "terminal_refusal":
		return "kiro_terminal_refusal"
	case "terminal_incomplete":
		return "kiro_terminal_incomplete"
	}
	return "kiro_unknown_stop_reason"
}

// fillEstimatedUsage falls back to an estimate when the upstream reported
// metering and context usage but no token counts. The divisor is 4 because that
// is the crate-wide heuristic the Node engine uses; it is an estimate either way
// and is only emitted when the real numbers are absent.
func (s *kiroSSEStream) fillEstimatedUsage() {
	if !s.state.hasMetering || !s.state.hasContextUsage {
		return
	}
	if usage, ok := s.state.usage["total_tokens"]; ok && usage != nil && intLoose(usage) != 0 {
		return
	}
	completion := 0
	if s.state.totalContentLength > 0 {
		completion = s.state.totalContentLength / 4
		if completion < 1 {
			completion = 1
		}
	}
	prompt := int(s.state.contextUsagePct * float64(KiroDefaultContextWindow) / 100)
	if s.state.usage == nil {
		s.state.usage = map[string]any{}
	}
	s.state.usage["prompt_tokens"] = prompt
	s.state.usage["completion_tokens"] = completion
	s.state.usage["total_tokens"] = prompt + completion
}

// ── loose JSON readers ───────────────────────────────────────────────────────

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if s, ok := m[key].(string); ok {
			return s
		}
	}
	return ""
}

func firstValue(m map[string]any, keys ...string) any {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			return v
		}
	}
	return nil
}

func asFloatLoose(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(n, 64)
		return f, err == nil
	}
	return 0, false
}

func intLoose(v any) int {
	f, ok := asFloatLoose(v)
	if !ok {
		return 0
	}
	return int(f)
}

// kiroSSEFromBytes is a convenience for the non-streaming path and for tests: it
// decodes a complete EventStream blob into SSE bytes.
func kiroSSEFromBytes(model string, raw []byte) ([]byte, error) {
	stream := newKiroSSEStream(bytes.NewReader(raw), model)
	var out bytes.Buffer
	if _, err := io.Copy(&out, stream); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// kiroSSEScannerLabels are the SSE field names the decoder emits. Named so the
// tests assert on a constant rather than a literal.
const (
	kiroSSEDataPrefix = "data: "
	kiroSSEDone       = "data: [DONE]\n\n"
)

// bufio is used by the tests and by any caller that wants to scan the output; the
// import is kept here so the pairing of the decoder with a line scanner is
// visible in one file.
var _ = bufio.NewReader
