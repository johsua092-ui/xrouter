package providers

// Package glue for the Kiro port: this file wires the two halves together and
// owns the EventStream→SSE conversion.
//
// The split exists because of an import direction. internal/translate cannot
// import internal/providers (providers imports translate for the format bridge),
// so the model-folding helpers and the session-replay store live in providers
// while their call sites are in translate. WireKiro installs them once at
// startup, the same way the replay store is handed over.
//
// The response side is here rather than in translate because it is not a
// translation between two JSON dialects — it is a binary protocol decode. Every
// Kiro frame has to be length-prefixed, CRC32-verified and type-walked before
// there is any JSON to translate at all.

import (
	"encoding/json"

	"github.com/johsua092-ui/xrouter/internal/translate"
)

// WireKiro connects the translate package's Kiro hooks to this package's
// implementations. Idempotent: calling it twice installs the same functions.
//
// It is called from RegisterWave7 so the wiring cannot be forgotten when the
// adapter is registered — a Kiro adapter without these hooks would build a
// payload with an unfolded model id and no effort fields, which fails upstream in
// a way that looks like an auth problem.
func WireKiro() {
	translate.WireKiroHelpers(
		func(model string) translate.KiroModelResolution {
			res := ResolveKiroModel(model)
			return translate.KiroModelResolution{
				Upstream: res.Upstream,
				Agentic:  res.Agentic,
				Thinking: res.Thinking,
			}
		},
		BuildKiroThinkingSystemPrefix,
		func() string { return KiroAgenticSystemPrompt },
		KiroProfileARN,
		BuildKiroAdditionalModelRequestFieldsForModel,
		UsesKiroNativeGptEffort,
	)
	translate.SetKiroReplayFunc(kiroReplayAdapter)
}

// kiroStore is the process-wide replay store. One store, not one per adapter:
// the freeze/replay protocol is per conversation, and a second adapter instance
// would produce a second store and defeat the cache it exists to protect.
var kiroStore = NewKiroReplayStore()

// kiroReplayAdapter bridges the store to the signature translate expects.
func kiroReplayAdapter(conversationID, connectionID, modelID, systemPrompt, contentPrefix, currentContentPrefix string, history []any, currentMessage map[string]any) ([]any, map[string]any) {
	result := kiroStore.ApplyKiroSessionReplay(
		conversationID, connectionID, modelID,
		systemPrompt, contentPrefix, currentContentPrefix,
		history, currentMessage,
	)
	return result.History, result.CurrentMessage
}

// kiroSSEChunk renders one OpenAI chat.completion.chunk frame.
//
// Kiro's own executor emits this intermediate shape and the rest of the gateway
// knows how to translate onward from it, so the decoder produces that rather than
// trying to speak every client dialect itself.
func kiroSSEChunk(id string, created int64, model string, delta map[string]any, finishReason string, usage map[string]any) []byte {
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

// kiroSSEError renders a terminal error frame. A stream that ends without a
// terminal frame reads as a hang to a client, so every failure path emits one.
func kiroSSEError(code, message string, details map[string]any) []byte {
	payload := map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    "upstream_error",
			"code":    code,
		},
	}
	if len(details) > 0 {
		payload["error"].(map[string]any)["details"] = details
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return []byte("data: [DONE]\n\n")
	}
	out := append(append([]byte("data: "), raw...), '\n', '\n')
	return append(out, []byte("data: [DONE]\n\n")...)
}

// KiroEventStreamDecoderToSSE converts an AWS EventStream body into OpenAI SSE.
//
// This is the whole Kiro response path. The upstream sends binary frames; the
// client expects SSE. Everything between is here:
//
//   - assistantResponseEvent carries text, but may carry <thinking>…</thinking>
//     inline. The thinking span is hoisted out into reasoning_content and the
//     visible text is emitted without it, because OpenAI clients render the text
//     verbatim and would otherwise show the raw tags.
//   - reasoningContentEvent carries reasoning directly.
//   - toolUseEvent accumulates a tool call across frames. Kiro streams the input
//     as fragments that may be strings (concatenated) or objects (replaced), and
//     it detects a fragment-type change as corruption rather than silently
//     joining them into invalid JSON.
//   - messageStopEvent / metadataEvent carry the stop reason, and it is merged by
//     severity because a later frame can downgrade an earlier one.
//   - meteringEvent and metricsEvent carry usage.
//
// A turn that produced nothing and never declared a stop is a failure, not an
// empty success: an empty success reads as a silent hang downstream.
type kiroStreamState struct {
	buffer             []byte
	chunkIndex         int
	toolCounter        int
	tools              map[string]*kiroToolBuffer
	bufferedToolBytes  int
	hasText            bool
	hasReasoning       bool
	hasCode            bool
	hasToolCalls       bool
	sawToolUse         bool
	explicitStop       bool
	stopReason         string
	terminalProvenance string
	transportState     string
	totalContentLength int
	contextUsagePct    float64
	hasContextUsage    bool
	hasMetering        bool
	usage              map[string]any
	inThinking         bool
	toolValidationErr  string
	validatedFrames    int
	finished           bool
}

type kiroToolBuffer struct {
	id          string
	name        string
	inputKind   string
	inputChunks []string
	inputObject map[string]any
	inputBytes  int
}

// kiroEventTypeCounts is the diagnostic counter over the event types the decoder
// understands. An unknown type is counted under "other" rather than dropped
// silently, so a protocol drift shows up in the diagnostics instead of as a
// mysteriously empty response.
var kiroKnownEventTypes = map[string]bool{
	"assistantResponseEvent": true,
	"reasoningContentEvent":  true,
	"codeEvent":              true,
	"toolUseEvent":           true,
	"messageStopEvent":       true,
	"metadataEvent":          true,
	"MetadataEvent":          true,
	"contextUsageEvent":      true,
	"meteringEvent":          true,
	"metricsEvent":           true,
}

// normalizeKiroStopReason folds the upstream's spelling variants onto the
// vocabulary the disposition logic reads.
func normalizeKiroStopReason(value string) string {
	reason := normalizeKiroCamelCase(value)
	switch reason {
	case "endturn", "end_turn", "stop", "stop_sequence":
		return "end_turn"
	case "tooluse", "tool_use", "tool_calls":
		return "tool_use"
	case "maxtokens", "max_tokens", "max_output_tokens", "length":
		return "max_tokens"
	}
	return reason
}

// normalizeKiroCamelCase lowercases and snake-cases a camelCase identifier, so
// "maxTokens" and "max_tokens" reach the same case arm.
func normalizeKiroCamelCase(value string) string {
	out := make([]byte, 0, len(value)+4)
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c == ' ' || c == '-' {
			out = append(out, '_')
			continue
		}
		if c >= 'A' && c <= 'Z' {
			if i > 0 && value[i-1] >= 'a' && value[i-1] <= 'z' {
				out = append(out, '_')
			}
			out = append(out, c+('a'-'A'))
			continue
		}
		out = append(out, c)
	}
	return string(out)
}

// kiroTruncationStopReasons are the stop reasons that mean "usable as far as it
// got, then the budget ran out". These map to finish_reason "length" rather than
// being treated as an incomplete failure, because discarding a partial answer the
// client already received is worse than reporting it as truncated.
//
// cancelled and pause_turn are deliberately absent: those are abandoned turns
// whose partial content must stay private.
var kiroTruncationStopReasons = map[string]bool{
	"model_context_window_exceeded": true,
	"max_tokens":                    true,
}

// kiroStopDisposition classifies a stop reason into the exit the stream takes.
func kiroStopDisposition(stopReason string, hasToolCalls bool) string {
	switch {
	case stopReason == "malformed_model_output" || stopReason == "invalid_model_output":
		return "retryable_protocol_failure"
	case stopReason == "cancelled" || stopReason == "pause_turn" || stopReason == "model_context_window_exceeded":
		return "terminal_incomplete"
	case stopReason == "refusal" || kiroMatchesAny(stopReason, []string{"content", "filter", "guardrail", "safety", "policy", "blocked"}):
		return "terminal_refusal"
	case stopReason == "max_tokens":
		if hasToolCalls {
			return "terminal_incomplete"
		}
		return "length"
	case stopReason != "" && stopReason != "end_turn" && stopReason != "tool_use":
		return "unknown_failure"
	case hasToolCalls || stopReason == "tool_use":
		return "tool_use"
	case stopReason == "" || stopReason == "end_turn":
		return "complete"
	}
	return "unknown_failure"
}

// kiroStopSeverity ranks a stop reason so a merge keeps the most severe. A later
// frame reporting "end_turn" must not erase an earlier "refusal".
func kiroStopSeverity(reason string) int {
	switch kiroStopDisposition(reason, false) {
	case "terminal_refusal":
		return 6
	case "terminal_incomplete":
		return 5
	case "unknown_failure":
		return 4
	case "retryable_protocol_failure":
		return 3
	case "length":
		return 2
	}
	return 1
}

func mergeKiroStopReason(current, incoming string) string {
	if incoming == "" {
		return current
	}
	if current == "" {
		return incoming
	}
	if kiroStopSeverity(incoming) > kiroStopSeverity(current) {
		return incoming
	}
	return current
}

func kiroMatchesAny(haystack string, needles []string) bool {
	for _, needle := range needles {
		if needle != "" && containsSubstring(haystack, needle) {
			return true
		}
	}
	return false
}

// kiroStripThinking hoists an inline <thinking>…</thinking> span out of the
// visible text.
//
// Kiro streams the span across response events, so the state has to persist
// between calls: a span that opened in frame 3 may close in frame 9. While inside
// the span, the visible content is empty — emitting it would leak raw tags into
// the client's answer.
func kiroStripThinking(content string, state *kiroStreamState) (visible, reasoning string) {
	const openTag = "<thinking>"
	const closeTag = "</thinking>"

	if state.inThinking {
		end := indexOfSubstring(content, closeTag)
		if end < 0 {
			return "", content
		}
		state.inThinking = false
		after := content[end+len(closeTag):]
		if len(after) > 0 && after[0] == '\n' {
			after = after[1:]
		}
		return after, content[:end]
	}

	start := indexOfSubstring(content, openTag)
	if start < 0 {
		return content, ""
	}
	end := indexOfSubstring(content[start+len(openTag):], closeTag)
	if end < 0 {
		state.inThinking = true
		return content[:start], content[start+len(openTag):]
	}
	absEnd := start + len(openTag) + end
	reasoning = content[start+len(openTag) : absEnd]
	after := content[absEnd+len(closeTag):]
	if len(after) > 0 && after[0] == '\n' {
		after = after[1:]
	}
	return content[:start] + after, reasoning
}

func containsSubstring(haystack, needle string) bool {
	if needle == "" {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func indexOfSubstring(haystack, needle string) int {
	if needle == "" {
		return 0
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
