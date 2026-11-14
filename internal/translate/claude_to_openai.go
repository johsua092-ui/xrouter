package translate

// Port of open-sse/translator/request/claude-to-openai.js.
//
// Two behaviours in the original are easy to lose in a rewrite because they look
// like edge-case handling but are load-bearing:
//
//  1. A mid-conversation `system` turn becomes a `user` turn wrapped in
//     <instructions>. Anthropic rejects a request whose final turn is an assistant
//     prefill, and clients do send mid-conversation system reminders.
//  2. A tool result carrying an image emits the text tool message AND re-attaches
//     the image to the following user turn, tagged with the call id. The OpenAI
//     tool role is text-only, so without the re-attachment a screenshot a tool
//     returned would silently vanish.

func init() {
	Register(FormatClaude, FormatOpenAI, claudeToOpenAIRequest, nil)
}

// claudeToOpenAIRequest converts a Claude Messages body to OpenAI chat.
func claudeToOpenAIRequest(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error) {
	result := map[string]any{
		"model":    model,
		"messages": []any{},
		"stream":   stream,
	}

	// Max tokens: adjustMaxTokens clamps the value when a provider advertises a
	// smaller ceiling. Without a provider ceiling in scope the original's own
	// guard applies — only carry it through when it is a positive number.
	if mt, ok := asInt(body["max_tokens"]); ok && mt > 0 {
		result["max_tokens"] = mt
	}

	if v, ok := body["temperature"]; ok && v != nil {
		result["temperature"] = v
	}

	// System: a string or an array of text blocks. The billing header Anthropic
	// clients prepend is stripped — it is transport metadata, not model input, and
	// upstreams that re-scan it reject the request.
	if sys, ok := body["system"]; ok && sys != nil {
		var systemContent string
		if blocks := asSlice(sys); blocks != nil {
			texts := make([]string, 0, len(blocks))
			for _, b := range blocks {
				t := stripAnthropicBillingHeader(asString(asMap(b)["text"]))
				if t != "" {
					texts = append(texts, t)
				}
			}
			systemContent = joinLines(texts)
		} else {
			systemContent = stripAnthropicBillingHeader(asString(sys))
		}
		if systemContent != "" {
			appendMessage(&result, map[string]any{
				"role":    string(RoleSystem),
				"content": systemContent,
			})
		}
	}

	if msgs := asSlice(body["messages"]); msgs != nil {
		for _, raw := range msgs {
			msg := asMap(raw)
			if msg == nil {
				continue
			}
			converted, err := convertClaudeMessage(msg)
			if err != nil {
				return nil, err
			}
			for _, c := range converted {
				appendMessage(&result, c)
			}
		}
	}

	// OpenAI requires every tool_call to have a response. Fill the gaps before the
	// body leaves, otherwise a strict upstream rejects the whole request.
	fixMissingToolResponsesOpenAI(asSlice(result["messages"]))

	if tools := asSlice(body["tools"]); tools != nil {
		out := make([]any, 0, len(tools))
		for _, raw := range tools {
			t := asMap(raw)
			if t == nil {
				continue
			}
			schema := t["input_schema"]
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			out = append(out, map[string]any{
				"type": OpenAIFunction,
				"function": map[string]any{
					"name":        asString(t["name"]),
					"description": asString(t["description"]),
					"parameters":  schema,
				},
			})
		}
		result["tools"] = out
	}

	if tc, ok := body["tool_choice"]; ok && tc != nil {
		result["tool_choice"] = convertToolChoice(tc)
	}

	// reasoning_effort wins over the nested reasoning.effort, matching the original
	// precedence: an explicit top-level field is the caller overriding the envelope.
	if v, ok := body["reasoning_effort"]; ok && v != nil {
		result["reasoning_effort"] = v
	} else if r := asMap(body["reasoning"]); r != nil {
		if v, ok := r["effort"]; ok && v != nil {
			result["reasoning_effort"] = v
		}
	}
	if r, ok := body["reasoning"]; ok && r != nil {
		result["reasoning"] = r
	}

	return result, nil
}

// appendMessage pushes onto the result's message list. The list is created in the
// constructor, so a nil here means the body was mutated by an earlier translator;
// recreate it rather than dropping the message.
func appendMessage(result *map[string]any, msg map[string]any) {
	msgs, ok := (*result)["messages"].([]any)
	if !ok {
		msgs = []any{}
	}
	(*result)["messages"] = append(msgs, msg)
}

// joinLines joins non-empty fragments with newlines.
func joinLines(parts []string) string {
	var out string
	for _, p := range parts {
		if p == "" {
			continue
		}
		if out != "" {
			out += "\n"
		}
		out += p
	}
	return out
}

// stripAnthropicBillingHeader removes a leading x-anthropic-billing-header line.
func stripAnthropicBillingHeader(text string) string {
	if text == "" {
		return ""
	}
	// Only a header at the very start is stripped, and only the one line plus its
	// terminator. Doing this with a prefix check keeps the behaviour obvious and
	// avoids compiling a regex on every message.
	const prefix = "x-anthropic-billing-header:"
	if len(text) < len(prefix) || !equalFold(text[:len(prefix)], prefix) {
		return text
	}
	i := indexByte(text, '\n')
	if i < 0 {
		return ""
	}
	// Consume a preceding \r as well.
	if i > 0 && text[i-1] == '\r' {
		i--
	}
	return text[i+1:]
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

// fixMissingToolResponsesOpenAI inserts "[No response received]" tool messages for
// any assistant tool_call that has no contiguous following tool reply.
//
// Contiguity is the whole point: only tool messages immediately after the
// assistant turn count as answered. A later tool message answering the same id is
// a different exchange, and treating it as the reply would reorder the
// conversation in a way the model reads as a correction.
func fixMissingToolResponsesOpenAI(messages []any) {
	for i := 0; i < len(messages); i++ {
		msg := asMap(messages[i])
		if msg == nil || asString(msg["role"]) != string(RoleAssistant) {
			continue
		}
		calls := asSlice(msg["tool_calls"])
		if len(calls) == 0 {
			continue
		}

		responded := map[string]bool{}
		insertAt := i + 1
		for j := i + 1; j < len(messages); j++ {
			next := asMap(messages[j])
			if next == nil || asString(next["role"]) != string(RoleTool) {
				break
			}
			id := asString(next["tool_call_id"])
			if id == "" {
				break
			}
			responded[id] = true
			insertAt = j + 1
		}

		var missing []any
		for _, raw := range calls {
			id := asString(asMap(raw)["id"])
			if id == "" || responded[id] {
				continue
			}
			missing = append(missing, map[string]any{
				"role":         string(RoleTool),
				"tool_call_id": id,
				"content":      "[No response received]",
			})
		}
		if len(missing) == 0 {
			continue
		}

		tail := append([]any{}, messages[insertAt:]...)
		messages = append(messages[:insertAt], missing...)
		messages = append(messages, tail...)
		i = insertAt + len(missing) - 1
	}
}

// systemReminderText wraps mid-conversation system text in <instructions> tags.
// Claude models treat those as authoritative directives, which is what keeps a
// mid-conversation system turn effective once it has been folded into a user turn.
func systemReminderText(content any) string {
	var parts []string
	if blocks := asSlice(content); blocks != nil {
		for _, raw := range blocks {
			b := asMap(raw)
			if b == nil || asString(b["type"]) != ClaudeText {
				continue
			}
			if t := asString(b["text"]); t != "" {
				parts = append(parts, t)
			}
		}
	} else if s, ok := content.(string); ok {
		parts = append(parts, s)
	}
	text := joinLines(parts)
	if trimSpace(text) == "" {
		return ""
	}
	return "<instructions>\n" + text + "\n</instructions>"
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && isSpace(s[start]) {
		start++
	}
	for end > start && isSpace(s[end-1]) {
		end--
	}
	return s[start:end]
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

// convertClaudeMessage converts one Claude message into zero or more OpenAI
// messages.
func convertClaudeMessage(msg map[string]any) ([]map[string]any, error) {
	// A client may send content as a bare block object. Normalise it to the
	// one-element array every branch below expects. This has to happen before the
	// role branch: systemReminderText only reads arrays and strings, so a bare
	// object system turn would otherwise be dropped outright.
	if c, ok := msg["content"]; ok && c != nil {
		if _, isArr := c.([]any); !isArr {
			if _, isStr := c.(string); !isStr {
				msg["content"] = []any{c}
			}
		}
	}

	role := asString(msg["role"])

	// Mid-conversation system turn folds into a user turn.
	if role == string(RoleSystem) {
		text := systemReminderText(msg["content"])
		if text == "" {
			return nil, nil
		}
		return []map[string]any{{"role": string(RoleUser), "content": text}}, nil
	}

	outRole := string(RoleAssistant)
	if role == string(RoleUser) || role == string(RoleTool) {
		outRole = string(RoleUser)
	}

	if s, ok := msg["content"].(string); ok {
		return []map[string]any{{"role": outRole, "content": s}}, nil
	}

	blocks := asSlice(msg["content"])
	if blocks == nil {
		return nil, nil
	}

	var parts []any
	var toolCalls []any
	var toolResults []any

	for _, raw := range blocks {
		block := asMap(raw)
		if block == nil {
			continue
		}
		switch asString(block["type"]) {
		case ClaudeText:
			parts = append(parts, map[string]any{
				"type": OpenAIText,
				"text": asString(block["text"]),
			})

		case ClaudeImage:
			src := asMap(block["source"])
			if asString(src["type"]) == "base64" {
				parts = append(parts, map[string]any{
					"type": OpenAIImageURL,
					"image_url": map[string]any{
						"url": encodeDataURI(asString(src["media_type"]), asString(src["data"])),
					},
				})
			}

		case ClaudeToolUse:
			args := block["input"]
			if args == nil {
				args = map[string]any{}
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":   asString(block["id"]),
				"type": OpenAIFunction,
				"function": map[string]any{
					"name":      asString(block["name"]),
					"arguments": mustJSON(args),
				},
			})

		case ClaudeToolResult:
			resultContent, resultImages := toolResultContent(block)
			toolResults = append(toolResults, map[string]any{
				"role":         string(RoleTool),
				"tool_call_id": asString(block["tool_use_id"]),
				"content":      resultContent,
			})
			// Re-attach any returned image to the user turn that follows, tagged
			// with the call it came from, so it is not lost to the text-only role.
			if len(resultImages) > 0 {
				parts = append(parts, map[string]any{
					"type": OpenAIText,
					"text": "[Image from tool result " + asString(block["tool_use_id"]) + "]",
				})
				parts = append(parts, resultImages...)
			}
		}
	}

	if len(toolResults) > 0 {
		out := append([]map[string]any{}, mapsOf(toolResults)...)
		if len(parts) > 0 {
			out = append(out, map[string]any{
				"role":    string(RoleUser),
				"content": collapseTextParts(parts),
			})
		}
		return out, nil
	}

	if len(toolCalls) > 0 {
		result := map[string]any{"role": string(RoleAssistant)}
		if len(parts) > 0 {
			result["content"] = collapseTextParts(parts)
		}
		result["tool_calls"] = toolCalls
		return []map[string]any{result}, nil
	}

	if len(parts) > 0 {
		return []map[string]any{{
			"role":    outRole,
			"content": collapseTextParts(parts),
		}}, nil
	}

	if len(blocks) == 0 {
		return []map[string]any{{"role": outRole, "content": ""}}, nil
	}

	return nil, nil
}

// toolResultContent flattens a tool_result block into text plus any images.
func toolResultContent(block map[string]any) (string, []any) {
	var images []any

	switch c := block["content"].(type) {
	case string:
		return c, nil
	case []any:
		var texts []string
		for _, raw := range c {
			inner := asMap(raw)
			if inner == nil {
				continue
			}
			switch asString(inner["type"]) {
			case ClaudeImage:
				src := asMap(inner["source"])
				if asString(src["type"]) == "base64" {
					images = append(images, map[string]any{
						"type": OpenAIImageURL,
						"image_url": map[string]any{
							"url": encodeDataURI(asString(src["media_type"]), asString(src["data"])),
						},
					})
				}
			case ClaudeText:
				texts = append(texts, asString(inner["text"]))
			}
		}
		text := joinLines(texts)
		if text != "" {
			return text, images
		}
		if len(images) > 0 {
			return "", images
		}
		// No text and no images: preserve the structured payload as JSON rather
		// than sending an empty tool reply, which some upstreams reject.
		return mustJSON(c), nil
	case nil:
		return "", nil
	default:
		return mustJSON(c), nil
	}
}

// mapsOf narrows a []any of maps to []map[string]any.
func mapsOf(in []any) []map[string]any {
	out := make([]map[string]any, 0, len(in))
	for _, v := range in {
		if m := asMap(v); m != nil {
			out = append(out, m)
		}
	}
	return out
}

// convertToolChoice maps Claude tool_choice onto the OpenAI shape.
func convertToolChoice(choice any) any {
	if choice == nil {
		return "auto"
	}
	if s, ok := choice.(string); ok {
		return s
	}
	m := asMap(choice)
	switch asString(m["type"]) {
	case "auto":
		return "auto"
	case "any":
		// Anthropic "any" means "must call some tool"; OpenAI spells that "required".
		return "required"
	case "tool":
		return map[string]any{
			"type":     OpenAIFunction,
			"function": map[string]any{"name": asString(m["name"])},
		}
	default:
		return "auto"
	}
}
