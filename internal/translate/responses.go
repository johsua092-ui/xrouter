package translate

import "strings"

// OpenAI Responses API ⇄ OpenAI Chat Completions request translation.
//
// The Responses API is not a chat API with different field names: history is a
// flat list of typed items (message / function_call / function_call_output /
// reasoning / additional_tools) rather than role-tagged messages, the system
// prompt is `instructions`, and tools are declared without a `function` wrapper.
// Both directions matter — a Responses client may be routed to a chat-only
// provider, and a chat client may be routed to a Responses-only one.

const maxToolNameLen = 128

// clampResponsesCallID truncates a call id to the length Responses accepts. A
// long id is rejected outright by some upstreams, and truncation keeps the
// pairing intact because both the call and its output are clamped the same way.
func clampResponsesCallID(id string) string {
	if len(id) <= 64 {
		return id
	}
	return id[:64]
}

// coerceResponsesArguments renders tool arguments as the JSON string Responses
// expects, accepting an already-serialised string or a structured value.
func coerceResponsesArguments(value any) string {
	switch v := value.(type) {
	case nil:
		return "{}"
	case string:
		if strings.TrimSpace(v) == "" {
			return "{}"
		}
		return v
	default:
		return mustJSON(v)
	}
}

// coerceResponsesOutput renders a tool result as a string. Responses requires a
// string here; a structured value is serialised rather than dropped.
func coerceResponsesOutput(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	if value == nil {
		return ""
	}
	return mustJSON(value)
}

// normalizeResponsesInput accepts the shapes clients send for `input`: an array
// of items, or a bare string that represents a single user message.
func normalizeResponsesInput(input any) []any {
	if input == nil {
		return nil
	}
	if s, ok := input.(string); ok {
		return []any{map[string]any{
			"type":    ResponsesMessage,
			"role":    string(RoleUser),
			"content": []any{map[string]any{"type": ResponsesInputText, "text": s}},
		}}
	}
	return asSlice(input)
}

// normalizeToolParameters guarantees an object schema carries `properties`.
// Codex's Responses validator rejects an object schema without it.
func normalizeToolParameters(params map[string]any) map[string]any {
	if params == nil {
		return map[string]any{"type": "object", "properties": map[string]any{}}
	}
	if asString(params["type"]) == "object" && params["properties"] == nil {
		out := make(map[string]any, len(params)+1)
		for k, v := range params {
			out[k] = v
		}
		out["properties"] = map[string]any{}
		return out
	}
	return params
}

// openaiResponsesToOpenAIRequest converts a Responses body into a chat body.
func openaiResponsesToOpenAIRequest(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error) {
	if body["input"] == nil {
		return body, nil
	}

	result := make(map[string]any, len(body)+1)
	for k, v := range body {
		result[k] = v
	}
	messages := make([]any, 0, 8)

	if instructions := asString(body["instructions"]); instructions != "" {
		messages = append(messages, map[string]any{
			"role":    string(RoleSystem),
			"content": instructions,
		})
	}

	items := normalizeResponsesInput(body["input"])
	if items == nil {
		return body, nil
	}

	var currentAssistant map[string]any
	pendingReasoning := ""
	pendingEncrypted := ""
	additionalTools := make([]any, 0, 2)
	customToolNames := map[string]bool{}
	order := make([]string, 0, 4)

	extractReasoning := func(item map[string]any) string {
		texts := make([]string, 0, 2)
		if summary := asSlice(item["summary"]); summary != nil {
			for _, raw := range summary {
				if s := asString(asMap(raw)["text"]); s != "" {
					texts = append(texts, s)
				}
			}
		} else if content := asSlice(item["content"]); content != nil {
			for _, raw := range content {
				if s := asString(asMap(raw)["text"]); s != "" {
					texts = append(texts, s)
				}
			}
		}
		return strings.Join(texts, "\n")
	}

	attachReasoning := func(msg map[string]any) {
		if pendingReasoning != "" {
			msg["reasoning_content"] = pendingReasoning
		}
		if pendingEncrypted != "" {
			msg["encrypted_content"] = pendingEncrypted
		}
		pendingReasoning = ""
		pendingEncrypted = ""
	}

	flushAssistant := func() {
		if currentAssistant != nil {
			messages = append(messages, currentAssistant)
			currentAssistant = nil
		}
	}

	for _, raw := range items {
		item := asMap(raw)
		if item == nil {
			continue
		}
		itemType := asString(item["type"])
		if itemType == "" && asString(item["role"]) != "" {
			// Droid CLI sends role-based items with no type field.
			itemType = ResponsesMessage
		}

		switch itemType {
		case ResponsesMessage:
			flushAssistant()

			var content any
			if parts := asSlice(item["content"]); parts != nil {
				converted := make([]any, 0, len(parts))
				for _, rawPart := range parts {
					part := asMap(rawPart)
					if part == nil {
						continue
					}
					switch asString(part["type"]) {
					case ResponsesInputText, ResponsesOutputText:
						converted = append(converted, map[string]any{
							"type": OpenAIText,
							"text": asString(part["text"]),
						})
					case ResponsesInputImage:
						url := asString(part["image_url"])
						if url == "" {
							url = asString(part["file_id"])
						}
						detail := asString(part["detail"])
						if detail == "" {
							detail = "auto"
						}
						converted = append(converted, map[string]any{
							"type":      OpenAIImageURL,
							"image_url": map[string]any{"url": url, "detail": detail},
						})
					default:
						converted = append(converted, part)
					}
				}
				content = converted
			} else {
				content = item["content"]
			}

			msg := map[string]any{"role": asString(item["role"]), "content": content}
			if asString(item["role"]) == string(RoleAssistant) {
				attachReasoning(msg)
			} else {
				pendingReasoning = ""
				pendingEncrypted = ""
			}
			messages = append(messages, msg)

		case ResponsesFunctionCall, ResponsesCustomToolCall:
			if currentAssistant == nil {
				currentAssistant = map[string]any{
					"role":       string(RoleAssistant),
					"content":    nil,
					"tool_calls": []any{},
				}
				attachReasoning(currentAssistant)
			}
			name := asString(item["name"])
			if strings.TrimSpace(name) == "" {
				// Nameless calls are rejected by strict upstreams (#444).
				continue
			}
			if itemType == ResponsesCustomToolCall {
				customToolNames[name] = true
			}
			var arguments string
			if itemType == ResponsesCustomToolCall {
				arguments = mustJSON(map[string]any{"input": coerceResponsesOutput(item["input"])})
			} else {
				arguments = coerceResponsesArguments(item["arguments"])
			}
			calls := asSlice(currentAssistant["tool_calls"])
			currentAssistant["tool_calls"] = append(calls, map[string]any{
				"id":   asString(item["call_id"]),
				"type": OpenAIFunction,
				"function": map[string]any{
					"name":      name,
					"arguments": arguments,
				},
			})

		case ResponsesFunctionCallOutput, ResponsesCustomToolCallOut:
			flushAssistant()
			messages = append(messages, map[string]any{
				"role":         string(RoleTool),
				"tool_call_id": asString(item["call_id"]),
				"content":      coerceResponsesOutput(item["output"]),
			})

		case ResponsesAdditionalTools:
			additionalTools = append(additionalTools, asSlice(item["tools"])...)

		case ResponsesReasoning:
			if txt := extractReasoning(item); txt != "" {
				if pendingReasoning != "" {
					pendingReasoning += "\n" + txt
				} else {
					pendingReasoning = txt
				}
			}
			if enc := asString(item["encrypted_content"]); enc != "" {
				pendingEncrypted = enc
			}
		}
	}

	flushAssistant()
	result["messages"] = messages

	responseTools := make([]any, 0, len(asSlice(body["tools"]))+len(additionalTools))
	responseTools = append(responseTools, asSlice(body["tools"])...)
	responseTools = append(responseTools, additionalTools...)

	if len(responseTools) > 0 {
		converted := make([]any, 0, len(responseTools))
		for _, raw := range responseTools {
			tool := asMap(raw)
			if tool == nil {
				continue
			}
			if tool["function"] != nil {
				// Already in chat format.
				converted = append(converted, tool)
				continue
			}
			name := asString(tool["name"])
			if strings.TrimSpace(name) == "" {
				// Hosted tools carry no name and cannot be expressed as a
				// function declaration; Gemini rejects a nameless declaration.
				continue
			}
			if asString(tool["type"]) == "custom" {
				customToolNames[name] = true
				formatHint := strings.TrimSpace(
					strings.Join([]string{
						asString(asMap(tool["format"])["syntax"]),
						asString(asMap(tool["format"])["definition"]),
					}, "\n"))
				description := asString(tool["description"])
				if formatHint != "" {
					description = strings.TrimSpace(description + "\n\n" + formatHint)
				}
				converted = append(converted, map[string]any{
					"type": OpenAIFunction,
					"function": map[string]any{
						"name":        name,
						"description": description,
						"parameters": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"input": map[string]any{
									"type":        "string",
									"description": "Raw freeform input for this custom tool",
								},
							},
							"required":             []any{"input"},
							"additionalProperties": false,
						},
					},
				})
				continue
			}
			converted = append(converted, map[string]any{
				"type": OpenAIFunction,
				"function": map[string]any{
					"name":        name,
					"description": asString(tool["description"]),
					"parameters":  normalizeToolParameters(asMap(tool["parameters"])),
					"strict":      tool["strict"],
				},
			})
		}
		result["tools"] = converted
	}

	if len(customToolNames) > 0 {
		for name := range customToolNames {
			order = append(order, name)
		}
		result["_customToolNames"] = order
	}

	if maxOut, ok := result["max_output_tokens"]; ok {
		if _, exists := result["max_tokens"]; !exists {
			result["max_tokens"] = maxOut
		}
		delete(result, "max_output_tokens")
	}

	delete(result, "input")
	delete(result, "instructions")
	delete(result, "include")
	delete(result, "prompt_cache_key")
	delete(result, "store")
	if reasoning := asMap(result["reasoning"]); reasoning != nil {
		if effort := asString(reasoning["effort"]); effort != "" {
			result["reasoning_effort"] = effort
		}
	}
	delete(result, "reasoning")
	delete(result, "client_metadata")

	return result, nil
}

// extractInstructionsText flattens an instruction-bearing message into the
// string Responses wants for `instructions`.
func extractInstructionsText(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	parts := asSlice(content)
	texts := make([]string, 0, len(parts))
	for _, raw := range parts {
		part := asMap(raw)
		if part == nil {
			continue
		}
		if s := asString(part["text"]); s != "" {
			texts = append(texts, s)
			continue
		}
		if s := asString(part["content"]); s != "" {
			texts = append(texts, s)
		}
	}
	return strings.Join(texts, "\n")
}

// buildReasoningInputItem rebuilds a Responses reasoning item from chat fields,
// preserving the encrypted continuity blob that store=false backends require
// across turns.
func buildReasoningInputItem(msg map[string]any) map[string]any {
	if msg == nil {
		return nil
	}
	encrypted := asString(msg["encrypted_content"])
	if encrypted == "" {
		encrypted = asString(msg["reasoning_encrypted_content"])
	}
	if encrypted == "" {
		encrypted = asString(asMap(msg["reasoning"])["encrypted_content"])
	}

	summary := strings.TrimSpace(asString(msg["reasoning_content"]))
	if summary == "" {
		summary = strings.TrimSpace(asString(msg["reasoning"]))
	}
	if summary == "" {
		details := asSlice(msg["reasoning_details"])
		texts := make([]string, 0, len(details))
		for _, raw := range details {
			detail := asMap(raw)
			if detail == nil {
				continue
			}
			if s := asString(detail["text"]); s != "" {
				texts = append(texts, s)
				continue
			}
			if s := asString(detail["content"]); s != "" {
				texts = append(texts, s)
			}
		}
		summary = strings.Join(texts, "\n")
	}

	if encrypted == "" && summary == "" {
		return nil
	}

	item := map[string]any{"type": ResponsesReasoning}
	if summary != "" {
		item["summary"] = []any{map[string]any{"type": ResponsesSummaryText, "text": summary}}
	}
	if encrypted != "" {
		item["encrypted_content"] = encrypted
	}
	return item
}

// openaiToOpenAIResponsesRequest converts a chat body into a Responses body.
func openaiToOpenAIResponsesRequest(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error) {
	if body["input"] != nil {
		// Already Responses-shaped (Cursor CLI posts this to /chat/completions).
		out := make(map[string]any, len(body)+2)
		for k, v := range body {
			out[k] = v
		}
		out["model"] = model
		out["stream"] = true
		if out["max_output_tokens"] == nil {
			if v, ok := out["max_completion_tokens"]; ok {
				out["max_output_tokens"] = v
			} else if v, ok := out["max_tokens"]; ok {
				out["max_output_tokens"] = v
			}
		}
		delete(out, "max_tokens")
		delete(out, "max_completion_tokens")
		return out, nil
	}

	result := map[string]any{
		"model":  model,
		"input":  []any{},
		"stream": true,
		"store":  false,
	}
	input := result["input"].([]any)

	hasInstructions := false
	for _, raw := range asSlice(body["messages"]) {
		msg := asMap(raw)
		if msg == nil {
			continue
		}
		role := asString(msg["role"])

		if role == string(RoleSystem) || role == string(RoleDeveloper) {
			if !hasInstructions {
				result["instructions"] = extractInstructionsText(msg["content"])
				hasInstructions = true
			}
			continue
		}

		if role == string(RoleUser) || role == string(RoleAssistant) {
			if role == string(RoleAssistant) {
				if item := buildReasoningInputItem(msg); item != nil {
					input = append(input, item)
				}
			}

			contentType := ResponsesOutputText
			if role == string(RoleUser) {
				contentType = ResponsesInputText
			}

			content := make([]any, 0, 4)
			switch c := msg["content"].(type) {
			case string:
				content = append(content, map[string]any{"type": contentType, "text": c})
			case []any:
				for _, rawPart := range c {
					part := asMap(rawPart)
					if part == nil {
						continue
					}
					switch asString(part["type"]) {
					case OpenAIText:
						content = append(content, map[string]any{
							"type": contentType,
							"text": asString(part["text"]),
						})
					case OpenAIImageURL:
						url := asString(part["image_url"])
						detail := "auto"
						if img := asMap(part["image_url"]); img != nil {
							url = asString(img["url"])
							if d := asString(img["detail"]); d != "" {
								detail = d
							}
						}
						content = append(content, map[string]any{
							"type":      ResponsesInputImage,
							"image_url": url,
							"detail":    detail,
						})
					case ResponsesInputImage:
						content = append(content, part)
					default:
						text := asString(part["text"])
						if text == "" {
							text = asString(part["content"])
						}
						if text == "" {
							text = mustJSON(part)
						}
						content = append(content, map[string]any{"type": contentType, "text": text})
					}
				}
			}

			if len(content) > 0 {
				input = append(input, map[string]any{
					"type":    ResponsesMessage,
					"role":    role,
					"content": content,
				})
			}
		}

		if role == string(RoleAssistant) {
			for _, rawCall := range asSlice(msg["tool_calls"]) {
				call := asMap(rawCall)
				if call == nil {
					continue
				}
				name := strings.TrimSpace(asString(asMap(call["function"])["name"]))
				if name == "" {
					continue
				}
				if len(name) > maxToolNameLen {
					name = name[:maxToolNameLen]
				}
				input = append(input, map[string]any{
					"type":      ResponsesFunctionCall,
					"call_id":   clampResponsesCallID(asString(call["id"])),
					"name":      name,
					"arguments": coerceResponsesArguments(asMap(call["function"])["arguments"]),
				})
			}
		}

		if role == string(RoleTool) {
			input = append(input, map[string]any{
				"type":    ResponsesFunctionCallOutput,
				"call_id": clampResponsesCallID(asString(msg["tool_call_id"])),
				"output":  coerceResponsesOutput(msg["content"]),
			})
		}
	}
	result["input"] = input

	if !hasInstructions {
		result["instructions"] = ""
	}

	if tools := asSlice(body["tools"]); tools != nil {
		converted := make([]any, 0, len(tools))
		for _, raw := range tools {
			tool := asMap(raw)
			if tool == nil {
				continue
			}
			if asString(tool["type"]) == OpenAIFunction {
				name := strings.TrimSpace(asString(asMap(tool["function"])["name"]))
				if name == "" {
					continue
				}
				if len(name) > maxToolNameLen {
					name = name[:maxToolNameLen]
				}
				converted = append(converted, map[string]any{
					"type":        OpenAIFunction,
					"name":        name,
					"description": asString(asMap(tool["function"])["description"]),
					"parameters":  normalizeToolParameters(asMap(asMap(tool["function"])["parameters"])),
					"strict":      asMap(tool["function"])["strict"],
				})
				continue
			}
			converted = append(converted, tool)
		}
		result["tools"] = converted
	}

	for _, key := range []string{"temperature", "top_p", "reasoning", "service_tier", "prompt_cache_key"} {
		if v, ok := body[key]; ok {
			result[key] = v
		}
	}
	if v, ok := body["max_output_tokens"]; ok {
		result["max_output_tokens"] = v
	} else if v, ok := body["max_completion_tokens"]; ok {
		result["max_output_tokens"] = v
	} else if v, ok := body["max_tokens"]; ok {
		result["max_output_tokens"] = v
	}
	if effort := asString(body["reasoning_effort"]); effort != "" {
		result["reasoning"] = map[string]any{"effort": effort, "summary": "auto"}
	}

	return result, nil
}

func init() {
	Register(FormatOpenAIResponses, FormatOpenAI, openaiResponsesToOpenAIRequest, nil)
	Register(FormatOpenAI, FormatOpenAIResponses, openaiToOpenAIResponsesRequest, nil)
}
