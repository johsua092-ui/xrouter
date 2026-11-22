package translate

import "testing"

func TestGeminiToOpenAIConvertsContents(t *testing.T) {
	body := map[string]any{
		"systemInstruction": map[string]any{
			"parts": []any{map[string]any{"text": "be brief"}},
		},
		"contents": []any{
			map[string]any{
				"role":  "user",
				"parts": []any{map[string]any{"text": "hello"}},
			},
			map[string]any{
				"role": "model",
				"parts": []any{
					map[string]any{"text": "hi"},
					map[string]any{
						"functionCall": map[string]any{
							"name": "lookup",
							"args": map[string]any{"q": "x"},
						},
					},
				},
			},
		},
		"generationConfig": map[string]any{
			"maxOutputTokens": float64(256),
			"temperature":     float64(0.4),
		},
		"tools": []any{
			map[string]any{
				"functionDeclarations": []any{
					map[string]any{"name": "lookup", "description": "find"},
				},
			},
		},
	}

	out, err := geminiToOpenAIRequest("gemini/x", body, true, nil)
	if err != nil {
		t.Fatalf("convert failed: %v", err)
	}
	if out["max_tokens"] != 256 {
		t.Fatalf("max_tokens = %v, want 256", out["max_tokens"])
	}
	if out["temperature"] != float64(0.4) {
		t.Fatalf("temperature = %v", out["temperature"])
	}

	messages := asSlice(out["messages"])
	if len(messages) != 3 {
		t.Fatalf("expected system + user + assistant, got %d", len(messages))
	}
	if asString(asMap(messages[0])["role"]) != string(RoleSystem) {
		t.Fatalf("first message role = %v", asMap(messages[0])["role"])
	}
	assistant := asMap(messages[2])
	calls := asSlice(assistant["tool_calls"])
	if len(calls) != 1 {
		t.Fatalf("expected one tool call, got %d", len(calls))
	}
	call := asMap(calls[0])
	if asString(call["id"]) != "call_lookup" {
		t.Fatalf("derived call id = %q, want call_lookup", asString(call["id"]))
	}
	tools := asSlice(out["tools"])
	if len(tools) != 1 {
		t.Fatalf("expected one tool, got %d", len(tools))
	}
}

func TestOpenAIToGeminiPairsCallsAndResponses(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "you are terse"},
			map[string]any{"role": "user", "content": "weather?"},
			map[string]any{
				"role":    "assistant",
				"content": nil,
				"tool_calls": []any{
					map[string]any{
						"id":   "call_1",
						"type": "function",
						"function": map[string]any{
							"name":      "get.weather",
							"arguments": `{"city":"Paris"}`,
						},
					},
				},
			},
			map[string]any{
				"role":         "tool",
				"tool_call_id": "call_1",
				"content":      `{"temp":21}`,
			},
		},
		"temperature": 0.7,
		"top_p":       0.9,
		"max_tokens":  128,
	}

	out, err := openAIToGeminiRequest("gemini/x", body, true, nil)
	if err != nil {
		t.Fatalf("convert failed: %v", err)
	}

	genCfg := asMap(out["generationConfig"])
	if genCfg["temperature"] != 0.7 {
		t.Fatalf("temperature = %v", genCfg["temperature"])
	}
	if genCfg["maxOutputTokens"] != 128 {
		t.Fatalf("maxOutputTokens = %v", genCfg["maxOutputTokens"])
	}

	sys := asMap(out["systemInstruction"])
	if sys == nil {
		t.Fatal("systemInstruction missing")
	}

	contents := asSlice(out["contents"])
	if len(contents) < 3 {
		t.Fatalf("expected user/model/user turns, got %d", len(contents))
	}
	if asString(asMap(contents[0])["role"]) != string(GeminiUser) {
		t.Fatalf("history must open with a user turn, got %v", asMap(contents[0])["role"])
	}

	var sawCall, sawResponse bool
	for _, raw := range contents {
		for _, rawPart := range asSlice(asMap(raw)["parts"]) {
			part := asMap(rawPart)
			if call := asMap(part["functionCall"]); call != nil {
				sawCall = true
				if asString(call["id"]) != "call_1" {
					t.Fatalf("functionCall id = %q, want call_1", asString(call["id"]))
				}
				if asString(call["name"]) != "get.weather" {
					t.Fatalf("function name = %q", asString(call["name"]))
				}
			}
			if resp := asMap(part["functionResponse"]); resp != nil {
				sawResponse = true
				if asString(resp["id"]) != "call_1" {
					t.Fatalf("functionResponse id = %q, want call_1", asString(resp["id"]))
				}
				if asString(resp["name"]) != "get.weather" {
					t.Fatalf("functionResponse name = %q", asString(resp["name"]))
				}
			}
		}
	}
	if !sawCall || !sawResponse {
		t.Fatalf("expected paired call and response, saw call=%v response=%v", sawCall, sawResponse)
	}
}

func TestGeminiSanitizesFunctionNames(t *testing.T) {
	cases := map[string]string{
		"get weather":  "get_weather",
		"9lives":       "_9lives",
		"ok.name-here": "ok.name-here",
		"":             "_unknown",
	}
	for in, want := range cases {
		if got := sanitizeGeminiFunctionName(in); got != want {
			t.Fatalf("sanitize(%q) = %q, want %q", in, got, want)
		}
	}
	long := ""
	for i := 0; i < 100; i++ {
		long += "a"
	}
	if got := sanitizeGeminiFunctionName(long); len(got) != 64 {
		t.Fatalf("long name truncated to %d, want 64", len(got))
	}
}

func TestToolCallIDUniquifierHandlesRepeats(t *testing.T) {
	u := newToolCallIDUniquifier()
	if got := u.next("call_1"); got != "call_1" {
		t.Fatalf("first = %q", got)
	}
	if got := u.next("call_1"); got != "call_1-2" {
		t.Fatalf("second = %q, want call_1-2", got)
	}
	if got := u.next("call_1"); got != "call_1-3" {
		t.Fatalf("third = %q, want call_1-3", got)
	}
	if got := u.next(""); got != "" {
		t.Fatalf("empty id = %q", got)
	}
}

func TestGeminiStreamConvertsToOpenAIChunks(t *testing.T) {
	state := NewStreamState()
	chunk := map[string]any{
		"candidates": []any{
			map[string]any{
				"content": map[string]any{
					"parts": []any{
						map[string]any{"text": "hello"},
						map[string]any{"thought": true, "text": "thinking"},
					},
				},
				"finishReason": "STOP",
			},
		},
		"usageMetadata": map[string]any{
			"promptTokenCount":     float64(10),
			"candidatesTokenCount": float64(5),
			"totalTokenCount":      float64(15),
		},
		"modelVersion": "gemini-2.5-flash",
		"responseId":   "abc",
	}

	frames, err := geminiToOpenAIResponse(chunk, state)
	if err != nil {
		t.Fatalf("convert failed: %v", err)
	}
	if len(frames) < 3 {
		t.Fatalf("expected role + text + reasoning + finish, got %d", len(frames))
	}

	var sawText, sawReasoning, sawFinish bool
	for _, frame := range frames {
		choices := asSlice(frame["choices"])
		if len(choices) == 0 {
			continue
		}
		choice := asMap(choices[0])
		delta := asMap(choice["delta"])
		if asString(delta["content"]) == "hello" {
			sawText = true
		}
		if asString(delta["reasoning_content"]) == "thinking" {
			sawReasoning = true
		}
		if asString(choice["finish_reason"]) == FinishStop {
			sawFinish = true
			if usage := asMap(frame["usage"]); usage == nil || intOr(usage["total_tokens"]) != 15 {
				t.Fatalf("final frame usage = %v", frame["usage"])
			}
		}
	}
	if !sawText || !sawReasoning || !sawFinish {
		t.Fatalf("missing frames: text=%v reasoning=%v finish=%v", sawText, sawReasoning, sawFinish)
	}
}

func TestVertexStripsCallIds(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "go"},
			map[string]any{
				"role": "assistant",
				"tool_calls": []any{
					map[string]any{
						"id":   "call_9",
						"type": "function",
						"function": map[string]any{
							"name":      "f",
							"arguments": "{}",
						},
					},
				},
			},
			map[string]any{"role": "tool", "tool_call_id": "call_9", "content": "ok"},
		},
	}
	out, err := openAIToVertexRequest("vertex/gemini-2.5", body, false, nil)
	if err != nil {
		t.Fatalf("convert failed: %v", err)
	}
	for _, raw := range asSlice(out["contents"]) {
		for _, rawPart := range asSlice(asMap(raw)["parts"]) {
			part := asMap(rawPart)
			if call := asMap(part["functionCall"]); call != nil {
				if _, ok := call["id"]; ok {
					t.Fatal("vertex functionCall still carries an id")
				}
			}
			if resp := asMap(part["functionResponse"]); resp != nil {
				if _, ok := resp["id"]; ok {
					t.Fatal("vertex functionResponse still carries an id")
				}
			}
		}
	}
}
