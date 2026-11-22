package translate

import "testing"

func TestResponsesToChatBuildsMessagesAndToolPairing(t *testing.T) {
	body := map[string]any{
		"instructions": "be terse",
		"input": []any{
			map[string]any{
				"type": "message",
				"role": "user",
				"content": []any{
					map[string]any{"type": "input_text", "text": "weather?"},
				},
			},
			map[string]any{
				"type":      "function_call",
				"call_id":   "call_7",
				"name":      "get_weather",
				"arguments": `{"city":"Paris"}`,
			},
			map[string]any{
				"type":    "function_call_output",
				"call_id": "call_7",
				"output":  `{"temp":21}`,
			},
		},
		"max_output_tokens": float64(64),
		"reasoning":         map[string]any{"effort": "high"},
		"store":             false,
	}

	out, err := openaiResponsesToOpenAIRequest("x", body, true, nil)
	if err != nil {
		t.Fatalf("convert failed: %v", err)
	}

	messages := asSlice(out["messages"])
	// system, user, assistant (carrying the function_call), tool result
	if len(messages) != 4 {
		t.Fatalf("expected system + user + assistant + tool, got %d", len(messages))
	}
	if asString(asMap(messages[0])["role"]) != string(RoleSystem) {
		t.Fatalf("instructions did not become a system message: %v", messages[0])
	}
	toolMsg := asMap(messages[len(messages)-1])
	if asString(toolMsg["role"]) != string(RoleTool) {
		t.Fatalf("last message role = %v, want tool", toolMsg["role"])
	}
	if asString(toolMsg["tool_call_id"]) != "call_7" {
		t.Fatalf("tool_call_id = %v", toolMsg["tool_call_id"])
	}
	if out["max_tokens"] != float64(64) {
		t.Fatalf("max_tokens = %v, want 64", out["max_tokens"])
	}
	if _, ok := out["max_output_tokens"]; ok {
		t.Fatal("max_output_tokens leaked into the chat body")
	}
	if asString(out["reasoning_effort"]) != "high" {
		t.Fatalf("reasoning_effort = %v", out["reasoning_effort"])
	}
	if _, ok := out["store"]; ok {
		t.Fatal("store leaked into the chat body")
	}
}

func TestResponsesToChatCarriesReasoningIntoAssistantTurn(t *testing.T) {
	body := map[string]any{
		"input": []any{
			map[string]any{
				"type": "reasoning",
				"summary": []any{
					map[string]any{"type": "summary_text", "text": "thought so"},
				},
				"encrypted_content": "blob",
			},
			map[string]any{
				"type":    "message",
				"role":    "assistant",
				"content": []any{map[string]any{"type": "output_text", "text": "answer"}},
			},
		},
	}

	out, err := openaiResponsesToOpenAIRequest("x", body, false, nil)
	if err != nil {
		t.Fatalf("convert failed: %v", err)
	}
	messages := asSlice(out["messages"])
	if len(messages) != 1 {
		t.Fatalf("expected one assistant message, got %d", len(messages))
	}
	msg := asMap(messages[0])
	if asString(msg["reasoning_content"]) != "thought so" {
		t.Fatalf("reasoning_content = %v", msg["reasoning_content"])
	}
	if asString(msg["encrypted_content"]) != "blob" {
		t.Fatalf("encrypted_content = %v", msg["encrypted_content"])
	}
}

func TestChatToResponsesRequestShape(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "sys"},
			map[string]any{"role": "user", "content": "hi"},
			map[string]any{
				"role":    "assistant",
				"content": "calling",
				"tool_calls": []any{
					map[string]any{
						"id":   "call_1",
						"type": "function",
						"function": map[string]any{
							"name":      "f",
							"arguments": `{"a":1}`,
						},
					},
				},
			},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "done"},
		},
		"max_tokens": float64(32),
		"tools": []any{
			map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":       "f",
					"parameters": map[string]any{"type": "object"},
				},
			},
		},
	}

	out, err := openaiToOpenAIResponsesRequest("gpt-5", body, true, nil)
	if err != nil {
		t.Fatalf("convert failed: %v", err)
	}
	if out["instructions"] != "sys" {
		t.Fatalf("instructions = %v", out["instructions"])
	}
	if out["max_output_tokens"] != float64(32) {
		t.Fatalf("max_output_tokens = %v", out["max_output_tokens"])
	}
	if _, ok := out["max_tokens"]; ok {
		t.Fatal("max_tokens leaked into the Responses body")
	}

	items := asSlice(out["input"])
	var sawMessage, sawCall, sawOutput bool
	for _, raw := range items {
		item := asMap(raw)
		switch asString(item["type"]) {
		case "message":
			sawMessage = true
		case "function_call":
			sawCall = true
			if asString(item["call_id"]) != "call_1" {
				t.Fatalf("call_id = %v", item["call_id"])
			}
		case "function_call_output":
			sawOutput = true
			if asString(item["output"]) != "done" {
				t.Fatalf("output = %v", item["output"])
			}
		}
	}
	if !sawMessage || !sawCall || !sawOutput {
		t.Fatalf("missing items: message=%v call=%v output=%v", sawMessage, sawCall, sawOutput)
	}

	tools := asSlice(out["tools"])
	if len(tools) != 1 {
		t.Fatalf("tools = %d", len(tools))
	}
	tool := asMap(tools[0])
	if asString(tool["name"]) != "f" {
		t.Fatalf("tool name = %v", tool["name"])
	}
	if _, ok := tool["function"]; ok {
		t.Fatal("tool kept the chat function wrapper")
	}
	params := asMap(tool["parameters"])
	if params["properties"] == nil {
		t.Fatal("object schema without properties was not repaired")
	}
}

func TestOpenAIChunkToResponsesEvents(t *testing.T) {
	state := NewStreamState()

	first, err := openAIResponsesResponse(map[string]any{
		"id":    "chatcmpl-1",
		"model": "gpt-5",
		"choices": []any{
			map[string]any{"delta": map[string]any{"content": "He"}},
		},
	}, state)
	if err != nil {
		t.Fatalf("convert failed: %v", err)
	}

	var types []string
	for _, event := range first {
		types = append(types, asString(event["type"]))
	}
	// created → output_item.added → output_text.delta
	if len(types) < 3 || types[0] != ResponsesEventCreated {
		t.Fatalf("event types = %v", types)
	}

	final, err := openAIResponsesResponse(map[string]any{
		"id":    "chatcmpl-1",
		"model": "gpt-5",
		"choices": []any{
			map[string]any{"delta": map[string]any{"content": "llo"}, "finish_reason": "stop"},
		},
		"usage": map[string]any{
			"prompt_tokens":     float64(3),
			"completion_tokens": float64(2),
			"total_tokens":      float64(5),
		},
	}, state)
	if err != nil {
		t.Fatalf("convert failed: %v", err)
	}

	var sawDone, sawCompleted bool
	for _, event := range final {
		switch asString(event["type"]) {
		case ResponsesEventOutputItemDone:
			sawDone = true
		case ResponsesEventCompleted:
			sawCompleted = true
			response := asMap(event["response"])
			usage := asMap(response["usage"])
			if intOr(usage["total_tokens"]) != 5 {
				t.Fatalf("usage total = %v", usage["total_tokens"])
			}
			output := asSlice(response["output"])
			if len(output) == 0 {
				t.Fatal("completed event has empty output")
			}
		}
	}
	if !sawDone || !sawCompleted {
		t.Fatalf("done=%v completed=%v", sawDone, sawCompleted)
	}
}

func TestResponsesEventsToOpenAIChunks(t *testing.T) {
	state := NewStreamState()

	created, err := responsesToOpenAIResponse(map[string]any{
		"type":     ResponsesEventCreated,
		"response": map[string]any{"id": "resp_1", "model": "gpt-5"},
	}, state)
	if err != nil || len(created) != 1 {
		t.Fatalf("created: %v %v", created, err)
	}

	delta, err := responsesToOpenAIResponse(map[string]any{
		"type":  ResponsesEventOutputTextDelta,
		"delta": "hi",
	}, state)
	if err != nil || len(delta) != 1 {
		t.Fatalf("delta: %v %v", delta, err)
	}
	choices := asSlice(delta[0]["choices"])
	if asString(asMap(asMap(choices[0])["delta"])["content"]) != "hi" {
		t.Fatalf("delta content = %v", delta[0])
	}

	final, err := responsesToOpenAIResponse(map[string]any{
		"type": ResponsesEventCompleted,
		"response": map[string]any{
			"output": []any{},
			"usage": map[string]any{
				"input_tokens":  float64(4),
				"output_tokens": float64(1),
				"total_tokens":  float64(5),
			},
		},
	}, state)
	if err != nil || len(final) != 1 {
		t.Fatalf("final: %v %v", final, err)
	}
	usage := asMap(final[0]["usage"])
	if intOr(usage["prompt_tokens"]) != 4 {
		t.Fatalf("prompt_tokens = %v", usage["prompt_tokens"])
	}
}
