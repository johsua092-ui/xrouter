package translate

// Port of open-sse/translator/request/openai-to-claude.js and
// response/openai-to-claude.js.
//
// Three behaviours here are the reason this converter is not a field rename:
//
//  1. tool_result is emitted in its OWN user message immediately after the
//     tool_use turn. Claude requires that placement; folding them together is
//     accepted by some gateways and rejected by Anthropic.
//  2. cache_control is attached to the last assistant block and the last tool.
//     Without it every request pays full prompt cost instead of reading the
//     cached prefix.
//  3. tool_choice types are filtered against Claude's accepted set. A
//     passthrough of OpenAI's "function" returns a 400, so an unknown type is
//     downgraded to "auto" rather than forwarded.

// claudeOAuthToolPrefix matches real Claude Code, which uses an empty prefix.
// The original used "proxy_" and the comment records why it was removed: it is a
// detectable fingerprint difference.
const claudeOAuthToolPrefix = ""

// claudeToolChoiceTypes are the values Claude accepts for tool_choice.type.
var claudeToolChoiceTypes = map[string]bool{
	"auto": true, "any": true, "tool": true, "none": true,
}

// ClaudeSystemPrompt is the Claude Code system prompt the converter prepends.
//
// It is a var so a deployment can replace it, and it is appended as its own text
// block ahead of the caller's system content — matching the Node order, where the
// Claude Code block is first and the caller's content follows with a 1h cache TTL.
var ClaudeSystemPrompt = "You are Claude Code, Anthropic's official CLI for Claude."

func init() {
	Register(FormatOpenAI, FormatClaude, openAIToClaudeRequest, openAIToClaudeResponse)
}

// openAIToClaudeRequest converts an OpenAI chat body to Claude Messages.
func openAIToClaudeRequest(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error) {
	result := map[string]any{
		"model":  model,
		"stream": stream,
	}

	// max_tokens is required by Claude, so a body that omits it still gets a
	// usable ceiling rather than a 400.
	if mt, ok := asInt(body["max_tokens"]); ok && mt > 0 {
		result["max_tokens"] = mt
	} else {
		result["max_tokens"] = 8192
	}

	if v, ok := body["temperature"]; ok && v != nil {
		result["temperature"] = v
	}

	// Tool names are mapped so the response side can restore the client's names.
	toolNameMap := map[string]string{}

	var systemParts []string

	if messages := asSlice(body["messages"]); messages != nil {
		for _, raw := range messages {
			msg := asMap(raw)
			if msg == nil || asString(msg["role"]) != string(RoleSystem) {
				continue
			}
			if s, ok := msg["content"].(string); ok {
				systemParts = append(systemParts, s)
			} else {
				systemParts = append(systemParts, extractTextContent(msg["content"], "\n"))
			}
		}

		var claudeMessages []any
		currentRole := ""
		var currentBlocks []any

		flush := func() {
			if currentRole != "" && len(currentBlocks) > 0 {
				claudeMessages = append(claudeMessages, map[string]any{
					"role":    currentRole,
					"content": currentBlocks,
				})
				currentBlocks = nil
			}
		}

		for _, raw := range messages {
			msg := asMap(raw)
			if msg == nil {
				continue
			}
			role := asString(msg["role"])
			if role == string(RoleSystem) {
				continue
			}
			newRole := string(RoleAssistant)
			if role == string(RoleUser) || role == string(RoleTool) {
				newRole = string(RoleUser)
			}

			blocks := contentBlocksFromMessage(msg, role)
			hasToolUse := hasBlockType(blocks, ClaudeToolUse)
			hasToolResult := hasBlockType(blocks, ClaudeToolResult)

			if hasToolResult {
				var toolResults, others []any
				for _, b := range blocks {
					if asString(asMap(b)["type"]) == ClaudeToolResult {
						toolResults = append(toolResults, b)
					} else {
						others = append(others, b)
					}
				}
				flush()

				// Claude requires tool_result in its own user message directly
				// after the tool_use turn.
				if len(toolResults) > 0 {
					claudeMessages = append(claudeMessages, map[string]any{
						"role":    string(RoleUser),
						"content": toolResults,
					})
				}
				if len(others) > 0 {
					currentRole = newRole
					currentBlocks = append(currentBlocks, others...)
				}
				continue
			}

			if currentRole != newRole {
				flush()
				currentRole = newRole
			}
			currentBlocks = append(currentBlocks, blocks...)

			// A tool_use turn is flushed immediately so the following tool_result
			// lands in its own message rather than sharing this one.
			if hasToolUse {
				flush()
			}
		}
		flush()

		// Cache the last assistant block so the prompt prefix is reused.
		for i := len(claudeMessages) - 1; i >= 0; i-- {
			msg := asMap(claudeMessages[i])
			if asString(msg["role"]) != string(RoleAssistant) {
				continue
			}
			content := asSlice(msg["content"])
			if len(content) == 0 {
				continue
			}
			for j := len(content) - 1; j >= 0; j-- {
				block := asMap(content[j])
				switch asString(block["type"]) {
				case ClaudeText, ClaudeToolUse, ClaudeToolResult, ClaudeImage:
					block["cache_control"] = map[string]any{"type": "ephemeral"}
				}
			}
			break
		}

		result["messages"] = claudeMessages
	}

	// response_format becomes a system instruction, because Claude has no
	// response_format field.
	if rf := asMap(body["response_format"]); rf != nil {
		switch asString(rf["type"]) {
		case "json_schema":
			if js := asMap(rf["json_schema"]); js != nil {
				if schema := js["schema"]; schema != nil {
					systemParts = append(systemParts,
						"You must respond with valid JSON that strictly follows this JSON schema:\n```json\n"+
							mustJSONIndent(schema)+"\n```\nRespond ONLY with the JSON object, no other text.")
				}
			}
		case "json_object":
			systemParts = append(systemParts,
				"You must respond with valid JSON. Respond ONLY with a JSON object, no other text.")
		}
	}

	// The Claude Code block always leads, with the caller's content as a second
	// block carrying a 1h cache TTL.
	claudeCodePrompt := map[string]any{"type": ClaudeText, "text": ClaudeSystemPrompt}
	if len(systemParts) > 0 {
		result["system"] = []any{
			claudeCodePrompt,
			map[string]any{
				"type":          ClaudeText,
				"text":          joinLines(systemParts),
				"cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"},
			},
		}
	} else {
		result["system"] = []any{claudeCodePrompt}
	}

	if tools := asSlice(body["tools"]); tools != nil {
		var out []any
		for _, raw := range tools {
			tool := asMap(raw)
			if tool == nil {
				continue
			}
			// Built-in tools (web_search_20250305) pass through unconverted.
			toolType := asString(tool["type"])
			if toolType != "" && toolType != OpenAIFunction {
				out = append(out, tool)
				continue
			}

			// Function tools arrive in two shapes: the OpenAI spec with a parent
			// `type`, and a bare `{function: {...}}`. Both must yield the same
			// name; strict Anthropic-compatible gateways reject the request with
			// "invalid tool type" when the bare shape falls through.
			toolData := asMap(tool["function"])
			if toolData == nil {
				toolData = tool
			}
			originalName := asString(toolData["name"])
			toolName := claudeOAuthToolPrefix + originalName
			toolNameMap[toolName] = originalName

			schema := toolData["parameters"]
			if schema == nil {
				schema = toolData["input_schema"]
			}
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}, "required": []any{}}
			}

			out = append(out, map[string]any{
				"name":         toolName,
				"description":  asString(toolData["description"]),
				"input_schema": schema,
			})
		}
		if len(out) > 0 {
			last := asMap(out[len(out)-1])
			last["cache_control"] = map[string]any{"type": "ephemeral", "ttl": "1h"}
			result["tools"] = out
		}
	}

	if tc, ok := body["tool_choice"]; ok && tc != nil {
		result["tool_choice"] = convertOpenAIToolChoice(tc)
	}

	if len(toolNameMap) > 0 {
		result["_toolNameMap"] = toolNameMap
	}

	return result, nil
}

// extractTextContent flattens a content value to text, joining parts with sep.
func extractTextContent(content any, sep string) string {
	if s, ok := content.(string); ok {
		return s
	}
	parts := asSlice(content)
	var texts []string
	for _, raw := range parts {
		part := asMap(raw)
		if part == nil || asString(part["type"]) != OpenAIText {
			continue
		}
		texts = append(texts, asString(part["text"]))
	}
	out := ""
	for i, t := range texts {
		if i > 0 {
			out += sep
		}
		out += t
	}
	return out
}

func hasBlockType(blocks []any, want string) bool {
	for _, b := range blocks {
		if asString(asMap(b)["type"]) == want {
			return true
		}
	}
	return false
}

// contentBlocksFromMessage converts one OpenAI message's content into Claude blocks.
func contentBlocksFromMessage(msg map[string]any, role string) []any {
	var blocks []any

	switch role {
	case string(RoleTool):
		blocks = append(blocks, buildToolResultBlock(
			asString(msg["tool_call_id"]),
			convertToolResultContent(msg["content"]),
			msg,
		))

	case string(RoleUser):
		if s, ok := msg["content"].(string); ok {
			if s != "" {
				blocks = append(blocks, map[string]any{"type": ClaudeText, "text": s})
			}
		} else if parts := asSlice(msg["content"]); parts != nil {
			for _, raw := range parts {
				part := asMap(raw)
				if part == nil {
					continue
				}
				switch asString(part["type"]) {
				case OpenAIText:
					if text := asString(part["text"]); text != "" {
						blocks = append(blocks, map[string]any{"type": ClaudeText, "text": text})
					}
				case ClaudeToolResult:
					blocks = append(blocks, buildToolResultBlock(
						asString(part["tool_use_id"]), part["content"], part))
				case OpenAIImageURL:
					if b := imageBlockFromURL(imageURLOf(part)); b != nil {
						blocks = append(blocks, b)
					}
				case OpenAIImage:
					if src := asMap(part["source"]); src != nil {
						blocks = append(blocks, map[string]any{"type": ClaudeImage, "source": src})
					}
				case OpenAIFile:
					// Only PDF is a valid Claude document type; other mimes are
					// dropped rather than rejected upstream.
					file := asMap(part["file"])
					if file == nil {
						continue
					}
					if parsed := parseDataURI(asString(file["file_data"])); parsed != nil {
						if parsed.mimeType == "application/pdf" {
							blocks = append(blocks, map[string]any{
								"type": ClaudeDocument,
								"source": map[string]any{
									"type":       "base64",
									"media_type": parsed.mimeType,
									"data":       parsed.base64,
								},
							})
						}
					}
				}
			}
		}

	case string(RoleAssistant):
		if parts := asSlice(msg["content"]); parts != nil {
			for _, raw := range parts {
				part := asMap(raw)
				if part == nil {
					continue
				}
				switch asString(part["type"]) {
				case OpenAIText:
					if text := asString(part["text"]); text != "" {
						blocks = append(blocks, map[string]any{"type": ClaudeText, "text": text})
					}
				case ClaudeToolUse:
					// Name already carries the prefix from tool declarations.
					blocks = append(blocks, map[string]any{
						"type":  ClaudeToolUse,
						"id":    asString(part["id"]),
						"name":  asString(part["name"]),
						"input": part["input"],
					})
				case ClaudeThinking:
					// cache_control is not allowed on a thinking block.
					clean := map[string]any{}
					for k, v := range part {
						if k == "cache_control" {
							continue
						}
						clean[k] = v
					}
					blocks = append(blocks, clean)
				}
			}
		} else if msg["content"] != nil {
			var text string
			if s, ok := msg["content"].(string); ok {
				text = s
			} else {
				text = extractTextContent(msg["content"], "\n")
			}
			if text != "" {
				blocks = append(blocks, map[string]any{"type": ClaudeText, "text": text})
			}
		}

		if calls := asSlice(msg["tool_calls"]); calls != nil {
			for _, raw := range calls {
				call := asMap(raw)
				if call == nil || asString(call["type"]) != OpenAIFunction {
					continue
				}
				fn := asMap(call["function"])
				args := asString(fn["arguments"])
				var input any
				if parsed := parseJSONObject(args); parsed != nil {
					input = parsed
				} else {
					// Not valid JSON: forward the raw string so the model still
					// sees what the caller sent.
					input = args
				}
				blocks = append(blocks, map[string]any{
					"type":  ClaudeToolUse,
					"id":    asString(call["id"]),
					"name":  claudeOAuthToolPrefix + asString(fn["name"]),
					"input": input,
				})
			}
		}
	}

	return blocks
}

// imageURLOf reads the url out of an image_url part, tolerating the string form
// some clients send.
func imageURLOf(part map[string]any) string {
	switch iu := part["image_url"].(type) {
	case string:
		return iu
	case map[string]any:
		return asString(iu["url"])
	}
	return ""
}

// imageBlockFromURL turns a data URI or http(s) URL into a Claude image block.
func imageBlockFromURL(url string) map[string]any {
	if url == "" {
		return nil
	}
	if parsed := parseDataURI(url); parsed != nil {
		return map[string]any{
			"type": ClaudeImage,
			"source": map[string]any{
				"type":       "base64",
				"media_type": parsed.mimeType,
				"data":       parsed.base64,
			},
		}
	}
	if hasPrefix(url, "http://") || hasPrefix(url, "https://") {
		return map[string]any{
			"type":   ClaudeImage,
			"source": map[string]any{"type": "url", "url": url},
		}
	}
	return nil
}

// convertToolResultContent converts an OpenAI tool message's content array to
// Claude tool_result content. Claude accepts image blocks but not OpenAI
// image_url parts, so each URL is parsed into the base64 or url source form.
func convertToolResultContent(content any) any {
	parts := asSlice(content)
	if parts == nil {
		return content
	}

	var out []any
	for _, raw := range parts {
		part := asMap(raw)
		if part == nil {
			continue
		}
		switch asString(part["type"]) {
		case OpenAIText:
			if text := asString(part["text"]); text != "" {
				out = append(out, map[string]any{"type": ClaudeText, "text": text})
			}
		case OpenAIImageURL:
			if b := imageBlockFromURL(imageURLOf(part)); b != nil {
				out = append(out, b)
			}
		case ClaudeImage:
			if src := asMap(part["source"]); src != nil {
				out = append(out, map[string]any{"type": ClaudeImage, "source": src})
			}
		}
	}

	// Nothing convertible: keep the original payload rather than sending an
	// empty tool result, which reads to the model as "the tool returned nothing".
	if len(out) == 0 {
		return content
	}
	return out
}

// buildToolResultBlock assembles a tool_result block.
//
// is_error is always emitted. Zed's Anthropic wire types and other strict serde
// parsers require it as a non-optional bool; Anthropic's public API treats it as
// optional with a false default, so emitting it is safe everywhere.
func buildToolResultBlock(toolUseID string, content any, source map[string]any) map[string]any {
	return map[string]any{
		"type":        ClaudeToolResult,
		"tool_use_id": toolUseID,
		"content":     content,
		"is_error":    resolveToolResultIsError(source),
	}
}

// resolveToolResultIsError reads both the OpenAI-style is_error flag and a
// status field of "error".
func resolveToolResultIsError(source map[string]any) bool {
	if source == nil {
		return false
	}
	if asBool(source["is_error"]) {
		return true
	}
	return asString(source["status"]) == "error"
}

// convertOpenAIToolChoice maps an OpenAI tool_choice onto Claude's shape.
//
// Claude accepts only auto, any, tool and none. Anything unrecognised becomes
// auto rather than being forwarded, because a passthrough of OpenAI's "function"
// type is a 400.
func convertOpenAIToolChoice(choice any) any {
	if choice == nil {
		return map[string]any{"type": "auto"}
	}

	if s, ok := choice.(string); ok {
		if s == "required" {
			return map[string]any{"type": "any"}
		}
		// "auto", "none" and anything unexpected all fall back to auto.
		return map[string]any{"type": "auto"}
	}

	if m := asMap(choice); m != nil {
		// The OpenAI forced-tool shape is checked first: it also carries a
		// `.type` of "function", which is not in Claude's accepted set, so the
		// native passthrough below would reject it.
		if fn := asMap(m["function"]); fn != nil {
			if name := asString(fn["name"]); name != "" {
				return map[string]any{"type": "tool", "name": name}
			}
		}
		if t := asString(m["type"]); claudeToolChoiceTypes[t] {
			return m
		}
	}

	return map[string]any{"type": "auto"}
}

// mustJSONIndent renders a schema for the JSON-mode system instruction.
func mustJSONIndent(v any) string {
	b, err := indentJSON(v)
	if err != nil {
		return mustJSON(v)
	}
	return string(b)
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
