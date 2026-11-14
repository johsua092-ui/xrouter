package translate

import "encoding/json"

// Port of open-sse/translator/response/openai-to-claude.js.
//
// Four behaviours here are load-bearing and easy to drop in a rewrite:
//
//  1. Tool arguments are BUFFERED and emitted once, sanitised, before the block
//     stops. Streaming them through would forward the bad params that non-Anthropic
//     models emit (Read with a string limit, a negative offset, pages on a non-PDF)
//     and Claude Code rejects the whole turn.
//  2. The buffers are flushed when finish_reason arrives, which is the only point
//     where the complete argument JSON exists.
//  3. input_tokens is prompt_tokens MINUS cache tokens, because OpenAI's
//     prompt_tokens already includes them. Reporting the raw value double-counts
//     and inflates billed input on every cached turn.
//  4. message_start is emitted exactly once, on the first chunk, with the id
//     derived from the upstream id and a fallback chain that avoids a short or
//     placeholder id.

// openAIToClaudeResponse converts one OpenAI stream chunk into Claude SSE frames.
func openAIToClaudeResponse(chunk map[string]any, state *StreamState) ([]map[string]any, error) {
	if chunk == nil {
		return nil, nil
	}
	choices := asSlice(chunk["choices"])
	if len(choices) == 0 {
		return nil, nil
	}
	if state == nil {
		state = NewStreamState()
	}
	if state.Scratch == nil {
		state.Scratch = map[string]any{}
	}

	ows := fetchOpenAIResponseState(state)
	var results []map[string]any

	choice := asMap(choices[0])
	delta := asMap(choice["delta"])

	// Usage rides on the final chunk for OpenAI.
	if usage := asMap(chunk["usage"]); usage != nil {
		promptTokens := numOf(usage["prompt_tokens"])
		outputTokens := numOf(usage["completion_tokens"])

		details := asMap(usage["prompt_tokens_details"])
		cacheRead := numOf(details["cached_tokens"])
		cacheCreate := numOf(details["cache_creation_tokens"])

		// OpenAI's prompt_tokens includes the cached and cache-creation tokens,
		// so subtracting them yields the true input count. Passing prompt_tokens
		// straight through double-counts and inflates billed input.
		inputTokens := promptTokens - cacheRead - cacheCreate
		if inputTokens < 0 {
			inputTokens = 0
		}

		usageOut := map[string]any{
			"input_tokens":  inputTokens,
			"output_tokens": outputTokens,
		}
		if cacheRead > 0 {
			usageOut["cache_read_input_tokens"] = cacheRead
		}
		if cacheCreate > 0 {
			usageOut["cache_creation_input_tokens"] = cacheCreate
		}
		ows.usage = usageOut
	}

	// message_start goes out exactly once, on the first chunk.
	if !ows.messageStartSent {
		ows.messageStartSent = true

		id := stripPrefix(asString(chunk["id"]), "chatcmpl-")
		// A short or placeholder id is unusable as a message id, so fall through
		// to the upstream trace fields before minting one.
		if len(id) < 8 || id == "chat" {
			id = asString(asMap(chunk["extend_fields"])["requestId"])
			if id == "" {
				id = asString(asMap(chunk["extend_fields"])["traceId"])
			}
			if id == "" {
				id = "msg_" + itoa(CreatedNow())
			}
		}
		ows.messageID = id

		model := asString(chunk["model"])
		if model == "" {
			model = modelFallbackID
		}
		ows.model = model
		ows.nextBlockIndex = 0

		results = append(results, map[string]any{
			"type": ClaudeEventMessageStart,
			"message": map[string]any{
				"id":            ows.messageID,
				"type":          "message",
				"role":          string(RoleAssistant),
				"model":         ows.model,
				"content":       []any{},
				"stop_reason":   nil,
				"stop_sequence": nil,
				"usage":         map[string]any{"input_tokens": 0, "output_tokens": 0},
			},
		})
	}

	// Reasoning travels across vendor shapes: reasoning_content, reasoning,
	// reasoning_details. It becomes its own thinking block.
	if reasoning := ExtractReasoningText(delta); reasoning != "" {
		stopTextBlock(ows, &results)

		if !ows.thinkingBlockStarted {
			ows.thinkingBlockIndex = ows.nextBlockIndex
			ows.nextBlockIndex++
			ows.thinkingBlockStarted = true
			results = append(results, map[string]any{
				"type":          ClaudeEventContentBlockStart,
				"index":         ows.thinkingBlockIndex,
				"content_block": map[string]any{"type": ClaudeThinking, "thinking": ""},
			})
		}

		results = append(results, map[string]any{
			"type":  ClaudeEventContentBlockDelta,
			"index": ows.thinkingBlockIndex,
			"delta": map[string]any{"type": ClaudeDeltaThinking, "thinking": reasoning},
		})
	}

	if content := asString(delta["content"]); content != "" {
		stopThinkingBlock(ows, &results)

		if !ows.textBlockStarted {
			ows.textBlockIndex = ows.nextBlockIndex
			ows.nextBlockIndex++
			ows.textBlockStarted = true
			ows.textBlockClosed = false
			results = append(results, map[string]any{
				"type":          ClaudeEventContentBlockStart,
				"index":         ows.textBlockIndex,
				"content_block": map[string]any{"type": ClaudeText, "text": ""},
			})
		}

		results = append(results, map[string]any{
			"type":  ClaudeEventContentBlockDelta,
			"index": ows.textBlockIndex,
			"delta": map[string]any{"type": ClaudeDeltaText, "text": content},
		})
	}

	// Tool calls. GLM and Fireworks repeat id with a null name on every argument
	// chunk, so the block is opened once per index — keyed rather than counted.
	if calls := asSlice(delta["tool_calls"]); calls != nil {
		for _, raw := range calls {
			call := asMap(raw)
			if call == nil {
				continue
			}
			idx, _ := asInt(call["index"])

			fn := asMap(call["function"])
			callID := asString(call["id"])

			if callID != "" {
				if _, open := ows.toolCalls[idx]; !open {
					stopThinkingBlock(ows, &results)
					stopTextBlock(ows, &results)

					blockIndex := ows.nextBlockIndex
					ows.nextBlockIndex++

					name := asString(fn["name"])
					ows.toolCalls[idx] = &claudeToolState{
						id:         callID,
						name:       name,
						blockIndex: blockIndex,
					}

					// The client sent its own name; the request side may have
					// prefixed it, so the response strips it back.
					if state.ToolNameMap != nil {
						if original, ok := state.ToolNameMap[name]; ok {
							name = original
						}
					}

					results = append(results, map[string]any{
						"type":  ClaudeEventContentBlockStart,
						"index": blockIndex,
						"content_block": map[string]any{
							"type":  ClaudeToolUse,
							"id":    callID,
							"name":  name,
							"input": map[string]any{},
						},
					})
				}
			}

			if args := asString(fn["arguments"]); args != "" {
				if info, ok := ows.toolCalls[idx]; ok {
					info.argBuffer += args
				}
			}
		}
	}

	if finish := asString(choice["finish_reason"]); finish != "" {
		stopThinkingBlock(ows, &results)
		stopTextBlock(ows, &results)

		// Flush the buffered arguments once, sanitised, before stopping each block.
		for _, idx := range sortedToolIndexes(ows.toolCalls) {
			info := ows.toolCalls[idx]
			if info.argBuffer != "" {
				results = append(results, map[string]any{
					"type":  ClaudeEventContentBlockDelta,
					"index": info.blockIndex,
					"delta": map[string]any{
						"type":         ClaudeDeltaInputJSON,
						"partial_json": sanitizeToolArgs(info.name, info.argBuffer),
					},
				})
			}
			results = append(results, map[string]any{
				"type":  ClaudeEventContentBlockStop,
				"index": info.blockIndex,
			})
		}

		ows.finishReason = finish

		finalUsage := ows.usage
		if finalUsage == nil {
			finalUsage = map[string]any{"input_tokens": 0, "output_tokens": 0}
		}
		results = append(results, map[string]any{
			"type":  ClaudeEventMessageDelta,
			"delta": map[string]any{"stop_reason": FromOpenAIFinish(finish, "claude")},
			"usage": finalUsage,
		})
		results = append(results, map[string]any{"type": ClaudeEventMessageStop})
	}

	if len(results) == 0 {
		return nil, nil
	}
	return results, nil
}

// legacyClaudeOAuthToolPrefix is the prefix older request translators emitted.
// The response side strips it defensively so tool names from such turns resolve
// back for argument sanitisation. The current request translator emits no prefix,
// making this a no-op — deliberately kept, and deliberately not coupled to the
// request prefix.
const legacyClaudeOAuthToolPrefix = "proxy_"

// modelFallbackID is reported when the upstream chunk carries no model name.
// A Claude client shows this string in its status line, so it is named rather
// than left empty.
const modelFallbackID = "claude"

// claudeToolState tracks one tool call across chunks.
type claudeToolState struct {
	id         string
	name       string
	blockIndex int
	argBuffer  string
}

// openAIResponseState is the converter-local state carried in StreamState.Scratch.
type openAIResponseState struct {
	messageStartSent     bool
	messageID            string
	model                string
	nextBlockIndex       int
	thinkingBlockIndex   int
	thinkingBlockStarted bool
	textBlockIndex       int
	textBlockStarted     bool
	textBlockClosed      bool
	toolCalls            map[int]*claudeToolState
	usage                map[string]any
	finishReason         string
}

func fetchOpenAIResponseState(state *StreamState) *openAIResponseState {
	if s, ok := state.Scratch["openai_to_claude"].(*openAIResponseState); ok {
		return s
	}
	s := &openAIResponseState{toolCalls: map[int]*claudeToolState{}}
	state.Scratch["openai_to_claude"] = s
	return s
}

// stopThinkingBlock closes the thinking block when one is open. Emitted before a
// text or tool block starts, because Claude requires non-overlapping blocks.
func stopThinkingBlock(ows *openAIResponseState, results *[]map[string]any) {
	if !ows.thinkingBlockStarted {
		return
	}
	*results = append(*results, map[string]any{
		"type":  ClaudeEventContentBlockStop,
		"index": ows.thinkingBlockIndex,
	})
	ows.thinkingBlockStarted = false
}

func stopTextBlock(ows *openAIResponseState, results *[]map[string]any) {
	if !ows.textBlockStarted || ows.textBlockClosed {
		return
	}
	ows.textBlockClosed = true
	*results = append(*results, map[string]any{
		"type":  ClaudeEventContentBlockStop,
		"index": ows.textBlockIndex,
	})
	ows.textBlockStarted = false
}

// sanitizeToolArgs repairs the parameter types non-Anthropic models get wrong.
//
// Claude Code's Read tool rejects a string limit, a negative offset, or a pages
// argument on a non-PDF file. The model emits all three. Repairing here means the
// turn still runs instead of failing validation and losing the tool result.
// Unparseable JSON is passed through unchanged so a malformed call is visible
// rather than silently emptied.
func sanitizeToolArgs(toolName, argsJSON string) string {
	args := parseJSONObject(argsJSON)
	if args == nil {
		return argsJSON
	}

	name := stripPrefix(toolName, legacyClaudeOAuthToolPrefix)
	if name == "Read" {
		sanitizeReadArgs(args)
	}

	out, err := json.Marshal(args)
	if err != nil {
		return argsJSON
	}
	return string(out)
}

// sanitizeReadArgs coerces Read's parameters into the ranges the tool accepts.
func sanitizeReadArgs(args map[string]any) {
	// A numeric string is what most models emit for a number field.
	if s, ok := args["limit"].(string); ok && isAllDigits(s) {
		if n, ok := parseInt(s); ok {
			args["limit"] = n
		}
	}
	if s, ok := args["offset"].(string); ok && isSignedDigits(s) {
		if n, ok := parseInt(s); ok {
			args["offset"] = n
		}
	}

	if n, ok := asInt(args["limit"]); ok {
		// Above the ceiling is clamped; at or below zero the field is dropped so
		// the tool's own default applies rather than an invalid value.
		if n > 2000 {
			args["limit"] = 2000
		}
		if n < 1 {
			delete(args, "limit")
		}
	}
	if n, ok := asInt(args["offset"]); ok && n < 0 {
		args["offset"] = 0
	}

	if _, present := args["pages"]; present {
		if !isValidPDFPagesArg(args["file_path"], args["pages"]) {
			delete(args, "pages")
		}
	}
}

// isValidPDFPagesArg accepts pages only on a .pdf path and only in the "N" or
// "N-M" form.
func isValidPDFPagesArg(filePath, pages any) bool {
	path, ok := filePath.(string)
	if !ok || !hasSuffixFold(path, ".pdf") {
		return false
	}
	s, ok := pages.(string)
	if !ok || s == "" {
		return false
	}
	dashSeen := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= '0' && c <= '9' {
			continue
		}
		if c == '-' && !dashSeen {
			dashSeen = true
			continue
		}
		return false
	}
	return true
}

// sortedToolIndexes returns the tool indices in ascending order. Map iteration is
// random in Go, and the Node original relies on Map insertion order, so the order
// is pinned explicitly to keep the emitted block sequence stable.
func sortedToolIndexes(m map[int]*claudeToolState) []int {
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

func stripPrefix(s, prefix string) string {
	if hasPrefix(s, prefix) {
		return s[len(prefix):]
	}
	return s
}

func hasSuffixFold(s, suffix string) bool {
	if len(s) < len(suffix) {
		return false
	}
	tail := s[len(s)-len(suffix):]
	for i := 0; i < len(suffix); i++ {
		a, b := tail[i], suffix[i]
		if 'A' <= a && a <= 'Z' {
			a += 'a' - 'A'
		}
		if 'A' <= b && b <= 'Z' {
			b += 'a' - 'A'
		}
		if a != b {
			return false
		}
	}
	return true
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func isSignedDigits(s string) bool {
	if hasPrefix(s, "-") {
		s = s[1:]
	}
	return isAllDigits(s)
}

// parseInt parses a base-10 integer. Written locally to keep the translator free
// of a strconv dependency in its hot path.
func parseInt(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	neg := false
	if s[0] == '-' {
		neg = true
		s = s[1:]
		if s == "" {
			return 0, false
		}
	}
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		n = n*10 + int(s[i]-'0')
	}
	if neg {
		n = -n
	}
	return n, true
}
