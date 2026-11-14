package translate

// Port of open-sse/translator/response/claude-to-openai.js.
//
// The state carried across chunks is the interesting part. Three things in the
// original exist to stop specific, reproducible client-visible bugs:
//
//  1. Cache tokens are captured in message_start. Anthropic sends input+cache
//     there and only output in message_delta, so a converter that reads usage
//     from the delta alone reports cache_read as 0 and under-bills.
//  2. Built-in server tool blocks (web search) are suppressed end to end. Their
//     index is remembered from content_block_start so the matching deltas and the
//     stop frame are dropped — otherwise the client sees an empty tool call.
//  3. A refusal carries no content blocks. Anthropic's own explanation is emitted
//     as message text so the client shows why the turn is empty.

func init() {
	Register(FormatClaude, FormatOpenAI, nil, claudeToOpenAIResponse)
}

// claudeStreamState is the converter-local state carried in StreamState.Scratch.
type claudeStreamState struct {
	messageID       string
	model           string
	toolCallIndex   int
	serverToolIndex int
	finishReason    string
	finishSent      bool
	usage           map[string]any
	// toolCalls maps the upstream content-block index to the OpenAI tool_call
	// entry, so an input_json_delta can append to the right arguments buffer.
	toolCalls map[int]map[string]any
}

// claudeState fetches or creates the converter state.
func claudeState(state *StreamState) *claudeStreamState {
	if state == nil {
		state = NewStreamState()
	}
	if state.Scratch == nil {
		state.Scratch = map[string]any{}
	}
	if s, ok := state.Scratch["claude"].(*claudeStreamState); ok {
		return s
	}
	s := &claudeStreamState{
		serverToolIndex: -1,
		toolCalls:       map[int]map[string]any{},
	}
	state.Scratch["claude"] = s
	return s
}

// claudeToOpenAIResponse converts one Claude SSE frame into OpenAI chunks. A nil
// return means the frame produced no output.
func claudeToOpenAIResponse(chunk map[string]any, state *StreamState) ([]map[string]any, error) {
	if chunk == nil {
		return nil, nil
	}
	cs := claudeState(state)

	var results []map[string]any
	chunkify := func(delta map[string]any, finish any) map[string]any {
		id := cs.messageID
		if id == "" {
			id = "msg_" + itoa(CreatedNow())
		}
		return BuildChunk("chatcmpl-"+id, CreatedNow(), cs.model, delta, finish)
	}

	switch asString(chunk["type"]) {
	case ClaudeEventMessageStart:
		message := asMap(chunk["message"])
		cs.messageID = asString(message["id"])
		if cs.messageID == "" {
			cs.messageID = "msg_" + itoa(CreatedNow())
		}
		cs.model = asString(message["model"])
		cs.toolCallIndex = 0

		// Capture prompt-side usage now. message_delta later carries only
		// output_tokens, so reading cache there would reset it to zero.
		if usage := asMap(message["usage"]); usage != nil {
			input := numOf(usage["input_tokens"])
			cacheRead := numOf(usage["cache_read_input_tokens"])
			cacheCreate := numOf(usage["cache_creation_input_tokens"])
			prompt := input + cacheRead + cacheCreate
			cs.usage = map[string]any{
				"prompt_tokens":     prompt,
				"completion_tokens": 0,
				"total_tokens":      prompt,
				"input_tokens":      input,
				"output_tokens":     0,
			}
			if cacheRead > 0 {
				cs.usage["cache_read_input_tokens"] = cacheRead
			}
			if cacheCreate > 0 {
				cs.usage["cache_creation_input_tokens"] = cacheCreate
			}
		}
		results = append(results, chunkify(map[string]any{"role": string(RoleAssistant)}, nil))

	case ClaudeEventContentBlockStart:
		block := asMap(chunk["content_block"])
		idx, _ := asInt(chunk["index"])

		if asString(block["type"]) == ClaudeServerToolUse {
			// Built-in tool handled server-side. Remember the index so the
			// matching deltas and stop frame are suppressed.
			cs.serverToolIndex = idx
			break
		}
		if asString(block["type"]) == ClaudeToolUse {
			toolCallIndex := cs.toolCallIndex
			cs.toolCallIndex++

			// A cloaked tool name is restored here so the client sees the name it
			// sent rather than the provider-suffixed one.
			name := asString(block["name"])
			if state != nil && state.ToolNameMap != nil {
				if original, ok := state.ToolNameMap[name]; ok && original != "" {
					name = original
				}
			}

			toolCall := map[string]any{
				"index": toolCallIndex,
				"id":    asString(block["id"]),
				"type":  OpenAIFunction,
				"function": map[string]any{
					"name":      name,
					"arguments": "",
				},
			}
			cs.toolCalls[idx] = toolCall
			results = append(results, chunkify(map[string]any{
				"tool_calls": []any{toolCall},
			}, nil))
		}

	case ClaudeEventContentBlockDelta:
		idx, _ := asInt(chunk["index"])
		if idx == cs.serverToolIndex {
			break
		}
		delta := asMap(chunk["delta"])
		switch asString(delta["type"]) {
		case ClaudeDeltaText:
			if text := asString(delta["text"]); text != "" {
				results = append(results, chunkify(map[string]any{"content": text}, nil))
			}
		case ClaudeDeltaThinking:
			if text := asString(delta["thinking"]); text != "" {
				results = append(results, chunkify(ReasoningDelta(text, false), nil))
			}
		case "redacted_thinking", "redacted_thinking_delta":
			// Pass the redacted payload through as reasoning rather than dropping
			// it or treating the block as empty content.
			if data := asString(delta["data"]); data != "" {
				results = append(results, chunkify(ReasoningDelta(data, false), nil))
			}
		case ClaudeDeltaInputJSON:
			partial := asString(delta["partial_json"])
			if partial == "" {
				break
			}
			if toolCall, ok := cs.toolCalls[idx]; ok {
				fn := asMap(toolCall["function"])
				fn["arguments"] = asString(fn["arguments"]) + partial
				results = append(results, chunkify(map[string]any{
					"tool_calls": []any{
						map[string]any{
							"index": toolCall["index"],
							"id":    toolCall["id"],
							"function": map[string]any{
								"arguments": partial,
							},
						},
					},
				}, nil))
			}
		}

	case ClaudeEventContentBlockStop:
		idx, _ := asInt(chunk["index"])
		if idx == cs.serverToolIndex {
			cs.serverToolIndex = -1
		}

	case ClaudeEventMessageDelta:
		if usage := asMap(chunk["usage"]); usage != nil {
			prev := cs.usage
			if prev == nil {
				prev = map[string]any{}
			}
			input := pickInt(usage["input_tokens"], prev["input_tokens"])
			output := numOf(usage["output_tokens"])
			cacheRead := pickInt(usage["cache_read_input_tokens"], prev["cache_read_input_tokens"])
			cacheCreate := pickInt(usage["cache_creation_input_tokens"], prev["cache_creation_input_tokens"])
			prompt := input + cacheRead + cacheCreate

			cs.usage = map[string]any{
				"prompt_tokens":     prompt,
				"completion_tokens": output,
				"total_tokens":      prompt + output,
				"input_tokens":      input,
				"output_tokens":     output,
			}
			if cacheRead > 0 {
				cs.usage["cache_read_input_tokens"] = cacheRead
			}
			if cacheCreate > 0 {
				cs.usage["cache_creation_input_tokens"] = cacheCreate
			}
		}

		delta := asMap(chunk["delta"])
		stopReason := asString(delta["stop_reason"])
		if stopReason == "" {
			break
		}
		cs.finishReason = ToOpenAIFinish(stopReason, "claude")

		// A refusal has no content blocks. Surface Anthropic's explanation so the
		// client shows why the turn came back empty.
		if stopReason == ClaudeStopRefusal {
			if details := asMap(delta["stop_details"]); details != nil {
				if explanation := asString(details["explanation"]); explanation != "" {
					results = append(results, chunkify(map[string]any{"content": explanation}, nil))
				}
			}
		}

		final := chunkify(map[string]any{}, cs.finishReason)
		if cs.usage != nil {
			final["usage"] = ToOpenAIUsage(map[string]any{
				"input_tokens":                cs.usage["input_tokens"],
				"output_tokens":               cs.usage["output_tokens"],
				"cache_read_input_tokens":     cs.usage["cache_read_input_tokens"],
				"cache_creation_input_tokens": cs.usage["cache_creation_input_tokens"],
			}, "claude")
		}
		results = append(results, final)
		cs.finishSent = true

	case ClaudeEventMessageStop:
		if cs.finishSent {
			break
		}
		finish := cs.finishReason
		if finish == "" {
			if len(cs.toolCalls) > 0 {
				finish = FinishToolCalls
			} else {
				finish = FinishStop
			}
		}
		final := chunkify(map[string]any{}, finish)
		if cs.usage != nil {
			input := numOf(cs.usage["input_tokens"])
			output := numOf(cs.usage["output_tokens"])
			final["usage"] = map[string]any{
				"prompt_tokens":     input,
				"completion_tokens": output,
				"total_tokens":      input + output,
			}
		}
		results = append(results, final)
		cs.finishSent = true
	}

	if len(results) == 0 {
		return nil, nil
	}
	return results, nil
}

// pickInt prefers a present numeric value, falling back to the previous one. This
// is how the delta merges with the cache captured at message_start.
func pickInt(v any, fallback any) int {
	if n, ok := asInt(v); ok {
		return n
	}
	return numOf(fallback)
}

// itoa is a tiny integer formatter for id generation, avoiding a strconv import
// in the hot path.
func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
