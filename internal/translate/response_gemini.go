package translate

import "strings"

// Gemini-family response translation.
//
// Upstream Gemini streams `candidates[0].content.parts` and marks internal
// reasoning with `thought: true`; OpenAI clients expect `choices[0].delta` with
// `content` / `reasoning_content` / `tool_calls`. The two shapes carry the same
// information in different places, so the work here is positional rather than
// semantic: which part becomes which delta.

// geminiChunkMeta returns the identity fields every emitted OpenAI chunk carries.
func geminiChunkMeta(state *StreamState) (string, int64, string) {
	id := "chatcmpl-" + stateString(state, "messageId", "gemini")
	model := state.Model
	if model == "" {
		model = "gemini"
	}
	return id, CreatedNow(), model
}

func stateString(state *StreamState, key, fallback string) string {
	if state == nil || state.Scratch == nil {
		return fallback
	}
	if v, ok := state.Scratch[key].(string); ok && v != "" {
		return v
	}
	return fallback
}

func stateInt(state *StreamState, key string) int {
	if state == nil || state.Scratch == nil {
		return 0
	}
	if v, ok := state.Scratch[key].(int); ok {
		return v
	}
	return 0
}

func stateBump(state *StreamState, key string) int {
	current := stateInt(state, key)
	if state.Scratch == nil {
		state.Scratch = map[string]any{}
	}
	state.Scratch[key] = current + 1
	return current
}

// geminiToOpenAIResponse converts one Gemini stream frame into OpenAI chunks.
func geminiToOpenAIResponse(chunk map[string]any, state *StreamState) ([]map[string]any, error) {
	if chunk == nil {
		return nil, nil
	}

	// Antigravity and Cloud Code wrap the payload in `response`.
	response := chunk
	if inner := asMap(chunk["response"]); inner != nil {
		response = inner
	}

	candidates := asSlice(response["candidates"])
	if len(candidates) == 0 {
		return nil, nil
	}
	candidate := asMap(candidates[0])
	if candidate == nil {
		return nil, nil
	}

	results := make([]map[string]any, 0, 4)

	if state != nil && stateString(state, "messageId", "") == "" {
		messageID := asString(response["responseId"])
		if messageID == "" {
			messageID = "msg_" + itoa(CreatedNow())
		}
		if state.Scratch == nil {
			state.Scratch = map[string]any{}
		}
		state.Scratch["messageId"] = messageID
		if model := asString(response["modelVersion"]); model != "" {
			state.Model = model
		}
		state.Scratch["functionIndex"] = 0
		state.Scratch["geminiToolCallCount"] = 0

		id, created, model := geminiChunkMeta(state)
		results = append(results, BuildChunk(id, created, model,
			map[string]any{"role": string(RoleAssistant)}, nil))
	}

	content := asMap(candidate["content"])
	if content != nil {
		for _, rawPart := range asSlice(content["parts"]) {
			part := asMap(rawPart)
			if part == nil {
				continue
			}

			signature := asString(part["thoughtSignature"])
			if signature == "" {
				signature = asString(part["thought_signature"])
			}
			if signature != "" && state != nil {
				if state.Scratch == nil {
					state.Scratch = map[string]any{}
				}
				state.Scratch["pendingThoughtSignature"] = signature
			}

			isThought := part["thought"] == true
			text := asString(part["text"])
			call := asMap(part["functionCall"])

			if text != "" {
				delta := map[string]any{"content": text}
				if isThought {
					delta = ReasoningDelta(text, false)
				}
				id, created, model := geminiChunkMeta(state)
				results = append(results, BuildChunk(id, created, model, delta, nil))
			}

			if call != nil {
				id, created, model := geminiChunkMeta(state)
				index := 0
				if state != nil {
					index = stateBump(state, "functionIndex")
					if state.Scratch != nil {
						state.Scratch["geminiToolCallCount"] = stateInt(state, "geminiToolCallCount") + 1
					}
				}
				name := asString(call["name"])
				callID := asString(call["id"])
				if callID == "" {
					callID = name + "-" + itoa(CreatedNow()) + "-" + itoa(int64(index))
				}
				args := call["args"]
				if args == nil {
					args = map[string]any{}
				}
				results = append(results, BuildChunk(id, created, model, map[string]any{
					"tool_calls": []any{
						map[string]any{
							"id":    callID,
							"index": index,
							"type":  OpenAIFunction,
							"function": map[string]any{
								"name":      name,
								"arguments": mustJSON(args),
							},
						},
					},
				}, nil))
			}

			inline := asMap(part["inlineData"])
			if inline == nil {
				inline = asMap(part["inline_data"])
			}
			if inline != nil && asString(inline["data"]) != "" {
				mime := asString(inline["mimeType"])
				if mime == "" {
					mime = asString(inline["mime_type"])
				}
				if mime == "" {
					mime = DefaultImageMIME
				}
				id, created, model := geminiChunkMeta(state)
				results = append(results, BuildChunk(id, created, model, map[string]any{
					"images": []any{
						map[string]any{
							"type":      OpenAIImageURL,
							"image_url": map[string]any{"url": encodeDataURI(mime, asString(inline["data"]))},
						},
					},
				}, nil))
			}
		}
	}

	if usageMeta := asMap(response["usageMetadata"]); usageMeta != nil && state != nil {
		prompt, _ := asInt(usageMeta["promptTokenCount"])
		completion, _ := asInt(usageMeta["candidatesTokenCount"])
		total, _ := asInt(usageMeta["totalTokenCount"])
		if total == 0 {
			total = prompt + completion
		}
		if state.Scratch == nil {
			state.Scratch = map[string]any{}
		}
		state.Scratch["usage"] = BuildUsage(UsageArgs{
			PromptTokens:     prompt,
			CompletionTokens: completion,
			TotalTokens:      total,
			CachedTokens:     intOr(usageMeta["cachedContentTokenCount"]),
			ReasoningTokens:  intOr(usageMeta["thoughtsTokenCount"]),
		})
	}

	if finish := asString(candidate["finishReason"]); finish != "" {
		reason := ToOpenAIFinish(finish, "gemini")
		if reason == FinishStop && stateInt(state, "geminiToolCallCount") > 0 {
			reason = FinishToolCalls
		}
		id, created, model := geminiChunkMeta(state)
		final := BuildChunk(id, created, model, map[string]any{}, reason)
		if state != nil && state.Scratch != nil {
			if usage, ok := state.Scratch["usage"].(map[string]any); ok {
				final["usage"] = usage
			}
		}
		results = append(results, final)
		if state != nil {
			if state.Scratch == nil {
				state.Scratch = map[string]any{}
			}
			state.Scratch["finishReason"] = reason
		}
	}

	if len(results) == 0 {
		return nil, nil
	}
	return results, nil
}

// openAIToGeminiResponse converts an OpenAI chunk into the Gemini/Antigravity
// stream shape.
//
// Tool calls are accumulated and emitted once on the finish frame: OpenAI
// streams a call as fragments (name in one chunk, argument text across several)
// while a Gemini candidate carries one complete functionCall part.
func openAIToGeminiResponse(chunk map[string]any, state *StreamState) ([]map[string]any, error) {
	if chunk == nil || state == nil {
		return nil, nil
	}
	if state.Scratch == nil {
		state.Scratch = map[string]any{}
	}

	choices := asSlice(chunk["choices"])
	if len(choices) == 0 {
		if usage := asMap(chunk["usage"]); usage != nil {
			state.Scratch["usage"] = usage
		}
		return nil, nil
	}
	choice := asMap(choices[0])
	if choice == nil {
		return nil, nil
	}

	delta := asMap(choice["delta"])
	finishReason := asString(choice["finish_reason"])

	accum, _ := state.Scratch["toolCallAccum"].(map[int]*geminiToolAccum)
	if accum == nil {
		accum = map[int]*geminiToolAccum{}
		state.Scratch["toolCallAccum"] = accum
	}
	if _, ok := state.Scratch["responseId"]; !ok {
		id := asString(chunk["id"])
		if id == "" {
			id = "resp_" + itoa(CreatedNow())
		}
		state.Scratch["responseId"] = id
	}
	if _, ok := state.Scratch["modelVersion"]; !ok {
		state.Scratch["modelVersion"] = asString(chunk["model"])
	}

	parts := make([]any, 0, 4)

	if delta != nil {
		if reasoning := asString(delta["reasoning_content"]); reasoning != "" {
			parts = append(parts, map[string]any{"thought": true, "text": reasoning})
		}
		if content := asString(delta["content"]); content != "" {
			parts = append(parts, map[string]any{"text": content})
		}
		if calls := asSlice(delta["tool_calls"]); calls != nil {
			for _, rawCall := range calls {
				call := asMap(rawCall)
				if call == nil {
					continue
				}
				idx := intOr(call["index"])
				entry := accum[idx]
				if entry == nil {
					entry = &geminiToolAccum{}
					accum[idx] = entry
				}
				if id := asString(call["id"]); id != "" {
					entry.ID = id
				}
				if fn := asMap(call["function"]); fn != nil {
					entry.Name += asString(fn["name"])
					entry.Arguments += asString(fn["arguments"])
				}
			}
			if len(parts) == 0 && finishReason == "" {
				return nil, nil
			}
		}
	}

	if finishReason != "" {
		for idx := 0; idx < len(accum); idx++ {
			entry := accum[idx]
			if entry == nil {
				continue
			}
			var args any = map[string]any{}
			if entry.Arguments != "" {
				if parsed := parseJSONObject(entry.Arguments); parsed != nil {
					args = parsed
				}
			}
			parts = append(parts, map[string]any{
				"functionCall": map[string]any{
					"name": entry.Name,
					"args": args,
				},
			})
		}
	}

	if len(parts) == 0 && finishReason == "" {
		return nil, nil
	}
	if len(parts) == 0 && finishReason != "" {
		parts = append(parts, map[string]any{"text": ""})
	}

	candidate := map[string]any{
		"content": map[string]any{"role": string(GeminiModel), "parts": parts},
	}
	if finishReason != "" {
		switch finishReason {
		case FinishLength:
			candidate["finishReason"] = GeminiFinishMaxTokens
		case FinishContentFilter:
			candidate["finishReason"] = GeminiFinishSafety
		default:
			candidate["finishReason"] = GeminiFinishStop
		}
	}

	response := map[string]any{
		"candidates":   []any{candidate},
		"modelVersion": stateString(state, "modelVersion", ""),
		"responseId":   stateString(state, "responseId", ""),
	}

	usage := asMap(chunk["usage"])
	if usage == nil {
		usage = asMap(state.Scratch["usage"])
	}
	if usage != nil {
		prompt := intOr(usage["prompt_tokens"])
		completion := intOr(usage["completion_tokens"])
		total := intOr(usage["total_tokens"])
		if total == 0 {
			total = prompt + completion
		}
		meta := map[string]any{
			"promptTokenCount":     prompt,
			"candidatesTokenCount": completion,
			"totalTokenCount":      total,
		}
		if details := asMap(usage["completion_tokens_details"]); details != nil {
			if reasoning := intOr(details["reasoning_tokens"]); reasoning > 0 {
				meta["thoughtsTokenCount"] = reasoning
			}
		}
		if details := asMap(usage["prompt_tokens_details"]); details != nil {
			if cached := intOr(details["cached_tokens"]); cached > 0 {
				meta["cachedContentTokenCount"] = cached
			}
		}
		response["usageMetadata"] = meta
	}

	if finishReason != "" {
		state.Scratch["toolCallAccum"] = map[int]*geminiToolAccum{}
	}

	return []map[string]any{{"response": response}}, nil
}

// geminiToolAccum is the per-index accumulator for a streamed tool call.
type geminiToolAccum struct {
	ID        string
	Name      string
	Arguments string
}

func init() {
	Register(FormatGemini, FormatOpenAI, nil, geminiToOpenAIResponse)
	Register(FormatGeminiCLI, FormatOpenAI, nil, geminiToOpenAIResponse)
	Register(FormatAntigravity, FormatOpenAI, nil, geminiToOpenAIResponse)
	Register(FormatVertex, FormatOpenAI, nil, geminiToOpenAIResponse)
	Register(FormatOpenAI, FormatAntigravity, nil, openAIToGeminiResponse)
	Register(FormatOpenAI, FormatGemini, nil, openAIToGeminiResponse)
}

// hasPrefixFold is a small helper used by the Responses converter when matching
// event names that differ only in case between providers.
func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

// intOr reads a whole number, defaulting to zero when the value is absent or
// not numeric. Response metadata is frequently sparse, so callers want the
// value, not the presence flag.
func intOr(v any) int {
	n, _ := asInt(v)
	return n
}
