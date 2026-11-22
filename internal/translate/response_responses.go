package translate

import "strings"

// OpenAI Responses API ⇄ OpenAI Chat Completions response translation.
//
// The Responses API streams a typed event stream, not chat chunks: an object
// header, then item lifecycle events (`response.output_item.added`,
// `response.output_text.delta`, `response.output_item.done`), and a terminal
// `response.completed` carrying the assembled output and usage. A client on the
// Responses endpoint renders nothing if those events are missing — it is not
// tolerant of plain chat chunks the way a chat client is.

// responsesState reads the bookkeeping this converter keeps in the shared state.
func responsesState(state *StreamState) map[string]any {
	if state.Scratch == nil {
		state.Scratch = map[string]any{}
	}
	if existing, ok := state.Scratch["responses"].(map[string]any); ok {
		return existing
	}
	created := map[string]any{
		"responseId":   "",
		"sequence":     float64(0),
		"outputIndex":  float64(0),
		"itemId":       "",
		"itemAdded":    false,
		"textBuffer":   "",
		"toolAccum":    map[int]*geminiToolAccum{},
		"itemSeq":      float64(0),
		"usageEmitted": false,
	}
	state.Scratch["responses"] = created
	return created
}

func nextSequence(book map[string]any) int {
	seq := int(numOr(book["sequence"], 0))
	book["sequence"] = float64(seq + 1)
	return seq
}

func numOr(v any, fallback float64) float64 {
	if f, ok := asFloat(v); ok {
		return f
	}
	return fallback
}

// openAIResponsesResponse converts an OpenAI chat chunk into Responses events.
func openAIResponsesResponse(chunk map[string]any, state *StreamState) ([]map[string]any, error) {
	if chunk == nil || state == nil {
		return nil, nil
	}
	book := responsesState(state)

	if state.Model == "" {
		state.Model = asString(chunk["model"])
	}
	if asString(book["responseId"]) == "" {
		id := asString(chunk["id"])
		if id == "" {
			id = "resp_" + itoa(CreatedNow())
		}
		book["responseId"] = "resp_" + id
	}

	responseID := asString(book["responseId"])
	model := state.Model
	if model == "" {
		model = "unknown"
	}

	events := make([]map[string]any, 0, 4)

	responseShell := func(status string, output []any) map[string]any {
		return map[string]any{
			"id":         responseID,
			"object":     "response",
			"created_at": CreatedNow(),
			"model":      model,
			"status":     status,
			"output":     output,
		}
	}

	if !asBool(book["created"]) {
		book["created"] = true
		events = append(events, map[string]any{
			"type":     ResponsesEventCreated,
			"sequence": nextSequence(book),
			"response": responseShell("in_progress", []any{}),
		})
	}

	choices := asSlice(chunk["choices"])
	if len(choices) > 0 {
		choice := asMap(choices[0])
		delta := asMap(choice["delta"])
		finish := asString(choice["finish_reason"])

		if delta != nil {
			if reasoning := asString(delta["reasoning_content"]); reasoning != "" {
				events = append(events, map[string]any{
					"type":          ResponsesEventReasoningSummaryTextDelta,
					"sequence":      nextSequence(book),
					"item_id":       asString(book["itemId"]),
					"output_index":  int(numOr(book["outputIndex"], 0)),
					"summary_index": 0,
					"delta":         reasoning,
				})
			}

			if content := asString(delta["content"]); content != "" {
				if !asBool(book["itemAdded"]) {
					book["itemAdded"] = true
					itemID := "msg_" + itoa(CreatedNow()) + "_" + itoa(int64(int(numOr(book["itemSeq"], 0))))
					book["itemSeq"] = float64(int(numOr(book["itemSeq"], 0)) + 1)
					book["itemId"] = itemID
					events = append(events, map[string]any{
						"type":         ResponsesEventOutputItemAdded,
						"sequence":     nextSequence(book),
						"output_index": int(numOr(book["outputIndex"], 0)),
						"item": map[string]any{
							"id":      itemID,
							"type":    ResponsesMessage,
							"status":  "in_progress",
							"role":    string(RoleAssistant),
							"content": []any{},
						},
					})
				}
				book["textBuffer"] = asString(book["textBuffer"]) + content
				events = append(events, map[string]any{
					"type":          ResponsesEventOutputTextDelta,
					"sequence":      nextSequence(book),
					"item_id":       asString(book["itemId"]),
					"output_index":  int(numOr(book["outputIndex"], 0)),
					"content_index": 0,
					"delta":         content,
				})
			}

			if calls := asSlice(delta["tool_calls"]); calls != nil {
				accum, _ := book["toolAccum"].(map[int]*geminiToolAccum)
				if accum == nil {
					accum = map[int]*geminiToolAccum{}
					book["toolAccum"] = accum
				}
				for _, raw := range calls {
					call := asMap(raw)
					if call == nil {
						continue
					}
					idx := int(numOr(call["index"], 0))
					entry := accum[idx]
					if entry == nil {
						entry = &geminiToolAccum{}
						accum[idx] = entry
					}
					if id := asString(call["id"]); id != "" {
						entry.ID = id
					}
					if fn := asMap(call["function"]); fn != nil {
						if name := asString(fn["name"]); name != "" {
							if entry.Name == "" {
								events = append(events, map[string]any{
									"type":         ResponsesEventOutputItemAdded,
									"sequence":     nextSequence(book),
									"output_index": int(numOr(book["outputIndex"], 0)) + idx,
									"item": map[string]any{
										"id":        entry.ID,
										"type":      ResponsesFunctionCall,
										"status":    "in_progress",
										"call_id":   entry.ID,
										"name":      name,
										"arguments": "",
									},
								})
							}
							entry.Name += name
						}
						if args := asString(fn["arguments"]); args != "" {
							entry.Arguments += args
							events = append(events, map[string]any{
								"type":         ResponsesEventFunctionCallArgsDelta,
								"sequence":     nextSequence(book),
								"item_id":      entry.ID,
								"output_index": int(numOr(book["outputIndex"], 0)) + idx,
								"delta":        args,
							})
						}
					}
				}
			}
		}

		if finish != "" {
			output := make([]any, 0, 4)

			if asBool(book["itemAdded"]) {
				itemID := asString(book["itemId"])
				item := map[string]any{
					"id":     itemID,
					"type":   ResponsesMessage,
					"status": "completed",
					"role":   string(RoleAssistant),
					"content": []any{
						map[string]any{
							"type":        ResponsesOutputText,
							"text":        asString(book["textBuffer"]),
							"annotations": []any{},
						},
					},
				}
				events = append(events, map[string]any{
					"type":         ResponsesEventOutputItemDone,
					"sequence":     nextSequence(book),
					"output_index": int(numOr(book["outputIndex"], 0)),
					"item":         item,
				})
				output = append(output, item)
				delete(book, "itemAdded")
			}

			if accum, ok := book["toolAccum"].(map[int]*geminiToolAccum); ok {
				for idx := 0; idx < len(accum); idx++ {
					entry := accum[idx]
					if entry == nil {
						continue
					}
					item := map[string]any{
						"id":        entry.ID,
						"type":      ResponsesFunctionCall,
						"status":    "completed",
						"call_id":   entry.ID,
						"name":      entry.Name,
						"arguments": entry.Arguments,
					}
					events = append(events, map[string]any{
						"type":         ResponsesEventOutputItemDone,
						"sequence":     nextSequence(book),
						"output_index": int(numOr(book["outputIndex"], 0)) + idx,
						"item":         item,
					})
					output = append(output, item)
				}
				book["toolAccum"] = map[int]*geminiToolAccum{}
			}

			final := responseShell("completed", output)
			if usage := asMap(chunk["usage"]); usage != nil {
				final["usage"] = map[string]any{
					"input_tokens":          intOr(usage["prompt_tokens"]),
					"output_tokens":         intOr(usage["completion_tokens"]),
					"total_tokens":          intOr(usage["total_tokens"]),
					"input_tokens_details":  map[string]any{"cached_tokens": intOr(asMap(usage["prompt_tokens_details"])["cached_tokens"])},
					"output_tokens_details": map[string]any{"reasoning_tokens": intOr(asMap(usage["completion_tokens_details"])["reasoning_tokens"])},
				}
			}
			events = append(events, map[string]any{
				"type":     ResponsesEventCompleted,
				"sequence": nextSequence(book),
				"response": final,
			})
		}
	}

	if usage := asMap(chunk["usage"]); usage != nil && len(choices) == 0 {
		book["usage"] = usage
	}

	if len(events) == 0 {
		return nil, nil
	}
	return events, nil
}

// responsesToOpenAIResponse converts a Responses event stream back into chat
// chunks, for a chat client routed to a Responses-only provider.
func responsesToOpenAIResponse(chunk map[string]any, state *StreamState) ([]map[string]any, error) {
	if chunk == nil || state == nil {
		return nil, nil
	}
	book := responsesState(state)

	eventType := asString(chunk["type"])
	if eventType == "" {
		// An already-chat-shaped frame: pass through so the caller sees it.
		return []map[string]any{chunk}, nil
	}

	if state.Model == "" {
		if response := asMap(chunk["response"]); response != nil {
			state.Model = asString(response["model"])
		}
	}
	if asString(book["responseId"]) == "" {
		if response := asMap(chunk["response"]); response != nil {
			book["responseId"] = asString(response["id"])
		}
	}

	responseID := asString(book["responseId"])
	if responseID == "" {
		responseID = "chatcmpl-" + itoa(CreatedNow())
	}
	model := state.Model
	if model == "" {
		model = "unknown"
	}

	delta := func(d map[string]any, finish any) map[string]any {
		return BuildChunk(responseID, CreatedNow(), model, d, finish)
	}

	switch eventType {
	case ResponsesEventCreated:
		if !asBool(book["started"]) {
			book["started"] = true
			return []map[string]any{delta(map[string]any{"role": string(RoleAssistant)}, nil)}, nil
		}
		return nil, nil

	case ResponsesEventOutputTextDelta:
		text := asString(chunk["delta"])
		if text == "" {
			return nil, nil
		}
		return []map[string]any{delta(map[string]any{"content": text}, nil)}, nil

	case ResponsesEventReasoningSummaryTextDelta, ResponsesEventReasoningTextDelta:
		text := asString(chunk["delta"])
		if text == "" {
			return nil, nil
		}
		return []map[string]any{delta(ReasoningDelta(text, false), nil)}, nil

	case ResponsesEventFunctionCallArgsDelta:
		index := 0
		if idx, ok := book["toolIndex"].(map[string]any); ok {
			if v, ok := idx[asString(chunk["item_id"])]; ok {
				index = int(numOr(v, 0))
			}
		} else {
			idxMap := map[string]any{}
			book["toolIndex"] = idxMap
			idxMap[asString(chunk["item_id"])] = float64(0)
		}
		call := map[string]any{
			"index": index,
			"id":    asString(chunk["item_id"]),
			"type":  OpenAIFunction,
			"function": map[string]any{
				"arguments": asString(chunk["delta"]),
			},
		}
		return []map[string]any{delta(map[string]any{"tool_calls": []any{call}}, nil)}, nil

	case ResponsesEventOutputItemDone:
		item := asMap(chunk["item"])
		if item == nil {
			return nil, nil
		}
		if asString(item["type"]) == ResponsesFunctionCall {
			call := map[string]any{
				"index": int(numOr(chunk["output_index"], 0)),
				"id":    asString(item["call_id"]),
				"type":  OpenAIFunction,
				"function": map[string]any{
					"name":      asString(item["name"]),
					"arguments": "",
				},
			}
			return []map[string]any{delta(map[string]any{"tool_calls": []any{call}}, nil)}, nil
		}
		return nil, nil

	case ResponsesEventCompleted, ResponsesEventDone:
		response := asMap(chunk["response"])
		reason := FinishStop
		if response != nil {
			for _, rawItem := range asSlice(response["output"]) {
				if item := asMap(rawItem); item != nil && asString(item["type"]) == ResponsesFunctionCall {
					reason = FinishToolCalls
					break
				}
			}
		}
		final := delta(map[string]any{}, reason)
		if response != nil {
			if usage := asMap(response["usage"]); usage != nil {
				final["usage"] = BuildUsage(UsageArgs{
					PromptTokens:     intOr(usage["input_tokens"]),
					CompletionTokens: intOr(usage["output_tokens"]),
					TotalTokens:      intOr(usage["total_tokens"]),
					CachedTokens:     intOr(asMap(usage["input_tokens_details"])["cached_tokens"]),
					ReasoningTokens:  intOr(asMap(usage["output_tokens_details"])["reasoning_tokens"]),
				})
			}
		}
		return []map[string]any{final}, nil

	case ResponsesEventFailed:
		message := "response failed"
		if response := asMap(chunk["response"]); response != nil {
			if errObj := asMap(response["error"]); errObj != nil {
				message = asString(errObj["message"])
			}
		}
		final := delta(map[string]any{"content": ""}, FinishStop)
		final["error"] = map[string]any{"message": message, "type": "upstream_error"}
		return []map[string]any{final}, nil
	}

	return nil, nil
}

// hasResponsePrefix reports whether an event name belongs to the Responses
// family. Unused by the converters themselves; kept next to them because the
// gateway asks the same question when it decides whether to frame an event.
func hasResponsePrefix(name string) bool {
	return hasPrefixFold(name, "response.")
}

var _ = strings.TrimSpace

func init() {
	Register(FormatOpenAI, FormatOpenAIResponses, nil, openAIResponsesResponse)
	Register(FormatOpenAIResponses, FormatOpenAI, nil, responsesToOpenAIResponse)
}
