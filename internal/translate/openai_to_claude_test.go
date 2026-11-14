package translate

import (
	"testing"
)

func TestParseDataURIExtractsMimeAndPayload(t *testing.T) {
	got := parseDataURI("data:image/png;base64,iVBORw0KGgo=")
	if got == nil {
		t.Fatal("expected a parsed data uri")
	}
	if got.mimeType != "image/png" {
		t.Errorf("mime = %q", got.mimeType)
	}
	if got.base64 != "iVBORw0KGgo=" {
		t.Errorf("payload = %q", got.base64)
	}
}

// A wrapped payload must survive. Some clients insert newlines every 76 chars and
// a converter that keeps them produces base64 the live wire rejects.
func TestParseDataURICollapsesNewlines(t *testing.T) {
	got := parseDataURI("data:image/png;base64,iVBOR\nw0KGgo=")
	if got == nil {
		t.Fatal("expected a parsed data uri")
	}
	if got.base64 != "iVBORw0KGgo=" {
		t.Errorf("newlines not collapsed: %q", got.base64)
	}
}

func TestParseDataURIRejectsNonDataURI(t *testing.T) {
	for _, in := range []string{
		"",
		"https://example.com/a.png",
		"data:image/png,rawbytes",
		"data:;base64,payload",
	} {
		if got := parseDataURI(in); got != nil {
			t.Errorf("%q should not parse, got %+v", in, got)
		}
	}
}

// ── openai → claude request ───────────────────────────────────────────────────

func TestOpenAIToClaudeExtractsSystemMessages(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "system", "content": "be terse"},
			map[string]any{"role": "user", "content": "hello"},
		},
	}
	got, err := openAIToClaudeRequest("claude-sonnet-4-5", body, true, nil)
	if err != nil {
		t.Fatal(err)
	}

	system := asSlice(got["system"])
	if len(system) != 2 {
		t.Fatalf("expected 2 system blocks (claude code + caller), got %d", len(system))
	}
	if asString(asMap(system[0])["type"]) != ClaudeText {
		t.Errorf("first system block should be the Claude Code prompt")
	}
	second := asMap(system[1])
	if asString(second["text"]) != "be terse" {
		t.Errorf("caller system text = %q", asString(second["text"]))
	}
	// The caller block must carry the 1h cache TTL, otherwise the prefix is not
	// cached and every turn pays full prompt cost.
	cc := asMap(second["cache_control"])
	if asString(cc["ttl"]) != "1h" {
		t.Errorf("caller system block missing 1h cache_control: %+v", cc)
	}

	// The system messages must not also appear as conversation turns.
	for _, raw := range asSlice(got["messages"]) {
		if asString(asMap(raw)["role"]) == string(RoleSystem) {
			t.Error("system message leaked into the conversation")
		}
	}
}

// tool_result has to sit in its own user message directly after the tool_use
// turn. Claude rejects it when folded in with ordinary content.
func TestOpenAIToClaudeSeparatesToolResultIntoOwnMessage(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "user", "content": "read the file"},
			map[string]any{
				"role":    "assistant",
				"content": "",
				"tool_calls": []any{
					map[string]any{
						"id":   "call_1",
						"type": "function",
						"function": map[string]any{
							"name":      "read",
							"arguments": `{"path":"/etc/hosts"}`,
						},
					},
				},
			},
			map[string]any{
				"role":         "tool",
				"tool_call_id": "call_1",
				"content":      "127.0.0.1 localhost",
			},
		},
	}

	got, err := openAIToClaudeRequest("claude-sonnet-4-5", body, false, nil)
	if err != nil {
		t.Fatal(err)
	}

	var messages []map[string]any
	for _, raw := range asSlice(got["messages"]) {
		messages = append(messages, asMap(raw))
	}
	if len(messages) != 3 {
		t.Fatalf("expected 3 messages, got %d: %s", len(messages), mustJSON(got["messages"]))
	}

	// Message 2 must be the assistant tool_use turn.
	second := messages[1]
	if asString(second["role"]) != string(RoleAssistant) {
		t.Errorf("message[1] role = %q, want assistant", asString(second["role"]))
	}
	if !hasBlockType(asSlice(second["content"]), ClaudeToolUse) {
		t.Error("message[1] should contain the tool_use block")
	}

	// Message 3 must be a user message whose ONLY content is the tool_result.
	third := messages[2]
	if asString(third["role"]) != string(RoleUser) {
		t.Errorf("message[2] role = %q, want user", asString(third["role"]))
	}
	thirdContent := asSlice(third["content"])
	if len(thirdContent) != 1 {
		t.Fatalf("tool_result message should hold exactly one block, got %d", len(thirdContent))
	}
	if asString(asMap(thirdContent[0])["type"]) != ClaudeToolResult {
		t.Errorf("message[2] block type = %q, want tool_result",
			asString(asMap(thirdContent[0])["type"]))
	}
}

// Every tool_result needs an is_error bool even when the caller sent nothing,
// because Zed and other strict serde parsers reject it as optional.
func TestOpenAIToClaudeAlwaysEmitsToolResultIsError(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{"role": "tool", "tool_call_id": "call_9", "content": "ok"},
		},
	}
	got, _ := openAIToClaudeRequest("claude-sonnet-4-5", body, false, nil)
	block := asMap(asSlice(asMap(asSlice(got["messages"])[0])["content"])[0])
	if _, ok := block["is_error"]; !ok {
		t.Fatalf("is_error must always be present: %s", mustJSON(block))
	}
	if asBool(block["is_error"]) {
		t.Error("is_error should default to false")
	}
}

func TestOpenAIToClaudeToolResultIsErrorFromStatus(t *testing.T) {
	body := map[string]any{
		"messages": []any{
			map[string]any{
				"role":         "tool",
				"tool_call_id": "call_9",
				"content":      "boom",
				"status":       "error",
			},
		},
	}
	got, _ := openAIToClaudeRequest("claude-sonnet-4-5", body, false, nil)
	block := asMap(asSlice(asMap(asSlice(got["messages"])[0])["content"])[0])
	if !asBool(block["is_error"]) {
		t.Error("status=error should set is_error")
	}
}

// A bare {function:{...}} tool must be accepted; strict Anthropic-compatible
// gateways answer the untyped shape with "invalid tool type".
func TestOpenAIToClaudeAcceptsBareFunctionTool(t *testing.T) {
	body := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"tools": []any{
			map[string]any{
				"function": map[string]any{
					"name":        "echo",
					"description": "echo it back",
					"parameters":  map[string]any{"type": "object"},
				},
			},
		},
	}

	got, err := openAIToClaudeRequest("claude-sonnet-4-5", body, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	tools := asSlice(got["tools"])
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	tool := asMap(tools[0])
	if asString(tool["name"]) != "echo" {
		t.Errorf("bare function tool name = %q, want echo", asString(tool["name"]))
	}
	if asString(tool["description"]) != "echo it back" {
		t.Errorf("description lost: %q", asString(tool["description"]))
	}
	// The last tool carries the 1h cache TTL so the tool prefix is reused.
	cc := asMap(tool["cache_control"])
	if asString(cc["ttl"]) != "1h" {
		t.Errorf("last tool missing 1h cache_control: %+v", cc)
	}
}

// Built-in tools pass through unconverted instead of being rewritten into the
// function shape.
func TestOpenAIToClaudePassesThroughBuiltinTool(t *testing.T) {
	body := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "search"}},
		"tools": []any{
			map[string]any{"type": "web_search_20250305", "name": "web_search"},
		},
	}
	got, _ := openAIToClaudeRequest("claude-sonnet-4-5", body, false, nil)
	tool := asMap(asSlice(got["tools"])[0])
	if asString(tool["type"]) != "web_search_20250305" {
		t.Errorf("builtin tool type rewritten: %+v", tool)
	}
}

func TestConvertOpenAIToolChoiceRequiredBecomesAny(t *testing.T) {
	got := asMap(convertOpenAIToolChoice("required"))
	if asString(got["type"]) != "any" {
		t.Errorf("required → %q, want any", asString(got["type"]))
	}
}

// OpenAI's "function" type is not in Claude's accepted set and must never be
// forwarded, because it is a 400 upstream.
func TestConvertOpenAIToolChoiceForcedFunctionBecomesTool(t *testing.T) {
	got := asMap(convertOpenAIToolChoice(map[string]any{
		"type":     "function",
		"function": map[string]any{"name": "echo"},
	}))
	if asString(got["type"]) != "tool" {
		t.Errorf("type = %q, want tool", asString(got["type"]))
	}
	if asString(got["name"]) != "echo" {
		t.Errorf("name = %q, want echo", asString(got["name"]))
	}
}

func TestConvertOpenAIToolChoiceUnknownDowngradesToAuto(t *testing.T) {
	for _, in := range []any{"weird", "function", map[string]any{"type": "something_else"}, 42} {
		got := asMap(convertOpenAIToolChoice(in))
		if asString(got["type"]) != "auto" {
			t.Errorf("%v → %q, want auto", in, asString(got["type"]))
		}
	}
}

// response_format is carried as a system instruction because Claude has no such
// field; dropping it silently disables the caller's JSON guarantee.
func TestOpenAIToClaudeCarriesJSONSchemaIntoSystem(t *testing.T) {
	body := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"response_format": map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"schema": map[string]any{
					"type":       "object",
					"properties": map[string]any{"name": map[string]any{"type": "string"}},
				},
			},
		},
	}
	got, _ := openAIToClaudeRequest("claude-sonnet-4-5", body, false, nil)
	system := asSlice(got["system"])
	if len(system) < 2 {
		t.Fatalf("expected caller system block, got %d blocks", len(system))
	}
	text := asString(asMap(system[1])["text"])
	if !contains(text, "valid JSON") || !contains(text, "properties") {
		t.Errorf("schema not carried into the system instruction: %q", text)
	}
}

// ── claude → openai request ───────────────────────────────────────────────────

func TestClaudeToOpenAIFlattensSystemBlocks(t *testing.T) {
	body := map[string]any{
		"system": []any{
			map[string]any{"type": "text", "text": "You are Claude Code."},
			map[string]any{"type": "text", "text": "be terse"},
		},
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	}
	got, err := claudeToOpenAIRequest("gpt-4o", body, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	messages := asSlice(got["messages"])
	if len(messages) != 2 {
		t.Fatalf("expected system + user, got %d", len(messages))
	}
	if asString(asMap(messages[0])["role"]) != string(RoleSystem) {
		t.Error("first message should be the flattened system turn")
	}
	if !contains(asString(asMap(messages[0])["content"]), "be terse") {
		t.Error("system text lost in flatten")
	}
}
