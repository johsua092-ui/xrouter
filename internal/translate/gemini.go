package translate

import (
	_ "embed"
	"encoding/json"
	"strings"
	"sync"
)

// Gemini-family request translation.
//
// The Gemini wire shape is not a chat shape: it has `contents` of role-tagged
// part lists, tools live under `functionDeclarations`, and the system prompt is
// its own `systemInstruction` field. Everything the gateway does with a Gemini
// provider therefore goes through one of the two converters below.

//go:embed signatures.json
var signatureRaw []byte

var (
	signatureOnce sync.Once
	signatureSet  map[string]string
)

// ThinkingSignature returns a wire signature constant from the Node config,
// generated into signatures.json at build time.
//
// These are base64 blobs several kilobytes long. They cannot be typed by hand
// without risking a transcription slip that would only show up as a provider
// rejecting a follow-up turn, so they are embedded verbatim.
func ThinkingSignature(name string) string {
	signatureOnce.Do(func() {
		signatureSet = map[string]string{}
		_ = json.Unmarshal(signatureRaw, &signatureSet)
	})
	return signatureSet[name]
}

const (
	agSignatureName     = "DEFAULT_THINKING_AG_SIGNATURE"
	geminiCLISigName    = "DEFAULT_THINKING_GEMINI_CLI_SIGNATURE"
	vertexSignatureName = "DEFAULT_THINKING_VERTEX_SIGNATURE"
)

// defaultSafetySettings mirrors the Node default: every category off. A gateway
// that answers with safety blocks the caller did not ask for is a gateway whose
// callers cannot tell a refusal from a provider outage.
func defaultSafetySettings() []any {
	categories := []string{
		"HARM_CATEGORY_HATE_SPEECH",
		"HARM_CATEGORY_DANGEROUS_CONTENT",
		"HARM_CATEGORY_SEXUALLY_EXPLICIT",
		"HARM_CATEGORY_HARASSMENT",
		"HARM_CATEGORY_CIVIC_INTEGRITY",
	}
	out := make([]any, 0, len(categories))
	for _, c := range categories {
		out = append(out, map[string]any{"category": c, "threshold": "OFF"})
	}
	return out
}

// sanitizeGeminiFunctionName forces a tool name into the alphabet Gemini
// accepts. Gemini's rule is stricter than OpenAI's: [a-zA-Z_] first, then
// [a-zA-Z0-9_.:-], 64 characters max. An invalid name is a 400 on the whole
// request, not a dropped tool.
func sanitizeGeminiFunctionName(name string) string {
	if name == "" {
		return "_unknown"
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '_', r == '.', r == ':', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := b.String()
	if out == "" {
		return "_unknown"
	}
	if !isASCIILetter(out[0]) && out[0] != '_' {
		out = "_" + out
	}
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}

func isASCIILetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// convertOpenAIContentToParts turns an OpenAI message content value into Gemini
// parts. Strings become text parts; an array is walked block by block.
func convertOpenAIContentToParts(content any) []any {
	switch v := content.(type) {
	case nil:
		return nil
	case string:
		if v == "" {
			return nil
		}
		return []any{map[string]any{"text": v}}
	case []any:
		parts := make([]any, 0, len(v))
		for _, raw := range v {
			block := asMap(raw)
			if block == nil {
				if s, ok := raw.(string); ok && s != "" {
					parts = append(parts, map[string]any{"text": s})
				}
				continue
			}
			switch asString(block["type"]) {
			case OpenAIText, "input_text":
				if text := asString(block["text"]); text != "" {
					parts = append(parts, map[string]any{"text": text})
				}
			case OpenAIImageURL:
				if img := asMap(block["image_url"]); img != nil {
					if part := dataURIToInlineData(asString(img["url"])); part != nil {
						parts = append(parts, part)
					}
				}
			case OpenAIImage, "input_image":
				if url := asString(block["image_url"]); url != "" {
					if part := dataURIToInlineData(url); part != nil {
						parts = append(parts, part)
					}
				}
			case OpenAIInputAudio, OpenAIAudioURL:
				// Gemini has no audio-part equivalent on the chat path; the audio
				// is described rather than silently dropped, so the model knows
				// something it cannot hear was attached.
				parts = append(parts, map[string]any{"text": "[audio attachment omitted]"})
			}
		}
		return parts
	default:
		if text := asString(textOf(content)); text != "" {
			return []any{map[string]any{"text": text}}
		}
	}
	return nil
}

// dataURIToInlineData converts a data: URI into a Gemini inlineData part.
func dataURIToInlineData(url string) map[string]any {
	parsed := parseDataURI(url)
	if parsed == nil {
		// A remote image URL cannot be fetched inline here; naming it keeps the
		// reference visible instead of producing an empty part.
		if url != "" {
			return map[string]any{"text": "[image: " + url + "]"}
		}
		return nil
	}
	return map[string]any{
		"inlineData": map[string]any{"mimeType": parsed.mimeType, "data": parsed.base64},
	}
}

// extractGeminiText flattens a Gemini content/systemInstruction value to text.
func extractGeminiText(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case map[string]any:
		parts := asSlice(v["parts"])
		var b strings.Builder
		for _, raw := range parts {
			if part := asMap(raw); part != nil {
				b.WriteString(asString(part["text"]))
			}
		}
		return b.String()
	}
	return ""
}

// isGemini4Model reports whether the model dropped the sampling knobs. Gemini 4
// rejects temperature/topP/topK outright, so forwarding a client's values turns
// an otherwise valid request into a 400.
func isGemini4Model(model string) bool {
	lower := strings.ToLower(model)
	lower = strings.TrimPrefix(lower, "gemini/")
	return strings.HasPrefix(lower, "gemini-4") || strings.HasPrefix(lower, "gemini4")
}

// cleanJSONSchemaForAntigravity strips the JSON-Schema keywords Gemini's
// function-declaration parser rejects. It walks nested object/array schemas,
// because an unsupported keyword inside `properties` fails just as hard as one
// at the root.
func cleanJSONSchemaForAntigravity(schema map[string]any) map[string]any {
	if schema == nil {
		return map[string]any{"type": "object", "properties": map[string]any{}}
	}

	// Keywords Gemini does not accept in a function declaration.
	strip := map[string]bool{
		"$schema": true, "$id": true, "$ref": true, "$defs": true,
		"additionalProperties": true, "examples": true, "default": true,
		"strict": true, "deprecated": true, "readOnly": true, "writeOnly": true,
		"discriminator": true, "x-": true, "patternProperties": true,
		"unevaluatedProperties": true, "propertyNames": true, "definitions": true,
	}

	out := make(map[string]any, len(schema))
	for key, value := range schema {
		if strip[key] {
			continue
		}
		switch key {
		case "properties":
			props, ok := value.(map[string]any)
			if !ok {
				continue
			}
			cleanProps := make(map[string]any, len(props))
			for name, sub := range props {
				if subMap := asMap(sub); subMap != nil {
					cleanProps[name] = cleanJSONSchemaForAntigravity(subMap)
				}
			}
			out[key] = cleanProps
		case "items":
			if itemMap := asMap(value); itemMap != nil {
				out[key] = cleanJSONSchemaForAntigravity(itemMap)
			}
		case "anyOf", "oneOf", "allOf":
			list := asSlice(value)
			cleaned := make([]any, 0, len(list))
			for _, raw := range list {
				if subMap := asMap(raw); subMap != nil {
					cleaned = append(cleaned, cleanJSONSchemaForAntigravity(subMap))
				}
			}
			out[key] = cleaned
		default:
			out[key] = value
		}
	}

	if _, ok := out["type"]; !ok {
		out["type"] = "object"
	}
	if out["type"] == "object" {
		if _, ok := out["properties"]; !ok {
			out["properties"] = map[string]any{}
		}
	}
	return out
}

// normalizeGeminiContents repairs the shape Gemini insists on:
//
//   - consecutive turns of the same role are merged (Gemini requires alternation)
//   - the history must open with a user turn
//   - a trailing model turn that ends in functionCall must be followed by
//     functionResponse parts, or the provider complains about an unanswered call
//
// Duplicated error spam is collapsed for the same reason Node does it: a retry
// loop can inject hundreds of identical failure lines and poison attention.
func normalizeGeminiContents(contents []any, model string) []any {
	gemini4 := isGemini4Model(model)
	out := make([]any, 0, len(contents))

	for _, raw := range contents {
		turn := asMap(raw)
		if turn == nil {
			continue
		}
		role := asString(turn["role"])
		parts := asSlice(turn["parts"])
		if role == "" || parts == nil {
			continue
		}

		cleanParts := make([]any, 0, len(parts))
		for _, rawPart := range parts {
			part := asMap(rawPart)
			if part == nil || len(part) == 0 {
				continue
			}
			if text, ok := part["text"].(string); ok && text != "" &&
				(strings.Contains(text, "model output error:") ||
					strings.Contains(text, "model output must contain either output text")) {
				if isDuplicateTail(cleanParts, out, text) {
					continue
				}
			}
			cleanParts = append(cleanParts, part)
		}
		if len(cleanParts) == 0 {
			continue
		}

		if len(out) > 0 {
			last := asMap(out[len(out)-1])
			if asString(last["role"]) == role {
				merged := append(asSlice(last["parts"]), cleanParts...)
				if gemini4 {
					merged = functionResponsesLast(merged)
				}
				last["parts"] = merged
				continue
			}
		}
		out = append(out, map[string]any{"role": role, "parts": cleanParts})
	}

	if len(out) > 0 {
		first := asMap(out[0])
		if asString(first["role"]) != string(GeminiUser) {
			out = append([]any{map[string]any{
				"role":  string(GeminiUser),
				"parts": []any{map[string]any{"text": "..."}},
			}}, out...)
		}
	}

	if len(out) > 0 {
		last := asMap(out[len(out)-1])
		if asString(last["role"]) == string(GeminiModel) {
			parts := asSlice(last["parts"])
			responses := make([]any, 0, 2)
			for _, rawPart := range parts {
				part := asMap(rawPart)
				if part == nil {
					continue
				}
				call := asMap(part["functionCall"])
				if call == nil {
					continue
				}
				name := asString(call["name"])
				if name == "" {
					name = "tool"
				}
				responses = append(responses, map[string]any{
					"functionResponse": map[string]any{
						"name":     name,
						"response": map[string]any{"result": "Continue."},
					},
				})
			}
			if len(responses) > 0 {
				out = append(out, map[string]any{
					"role":  string(GeminiUser),
					"parts": responses,
				})
			}
		}
	}

	return out
}

// isDuplicateTail reports whether text repeats the last part of this turn or of
// the previous one — the signature of an IDE retry loop.
func isDuplicateTail(cleanParts []any, out []any, text string) bool {
	if len(cleanParts) > 0 {
		if last := asMap(cleanParts[len(cleanParts)-1]); last != nil {
			if asString(last["text"]) == text {
				return true
			}
		}
	}
	if len(out) > 0 {
		prev := asMap(out[len(out)-1])
		prevParts := asSlice(prev["parts"])
		if len(prevParts) > 0 {
			if last := asMap(prevParts[len(prevParts)-1]); last != nil {
				if asString(last["text"]) == text {
					return true
				}
			}
		}
	}
	return false
}

// functionResponsesLast moves functionResponse parts to the end of a part list.
// Gemini 4 rejects a turn that interleaves responses with other parts.
func functionResponsesLast(parts []any) []any {
	responses := make([]any, 0, 2)
	others := make([]any, 0, len(parts))
	for _, raw := range parts {
		part := asMap(raw)
		if part != nil && part["functionResponse"] != nil {
			responses = append(responses, part)
			continue
		}
		others = append(others, part)
	}
	return append(others, responses...)
}

// geminiToOpenAIRequest converts a Gemini request body into an OpenAI chat body.
func geminiToOpenAIRequest(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error) {
	result := map[string]any{
		"model":    model,
		"messages": []any{},
		"stream":   stream,
	}

	if cfg := asMap(body["generationConfig"]); cfg != nil {
		if maxOut, ok := asFloat(cfg["maxOutputTokens"]); ok && maxOut > 0 {
			result["max_tokens"] = int(maxOut)
		}
		if temp, ok := cfg["temperature"]; ok {
			result["temperature"] = temp
		}
		if topP, ok := cfg["topP"]; ok {
			result["top_p"] = topP
		}
		if topK, ok := cfg["topK"]; ok {
			result["top_k"] = topK
		}
	}

	messages := make([]any, 0, 8)
	if systemText := extractGeminiText(body["systemInstruction"]); systemText != "" {
		messages = append(messages, map[string]any{
			"role":    string(RoleSystem),
			"content": systemText,
		})
	}

	for _, raw := range asSlice(body["contents"]) {
		if converted := convertGeminiContent(asMap(raw)); converted != nil {
			messages = append(messages, converted)
		}
	}
	result["messages"] = messages

	if tools := asSlice(body["tools"]); tools != nil {
		openAITools := make([]any, 0, len(tools))
		for _, rawTool := range tools {
			tool := asMap(rawTool)
			if tool == nil {
				continue
			}
			for _, rawFunc := range asSlice(tool["functionDeclarations"]) {
				fn := asMap(rawFunc)
				if fn == nil {
					continue
				}
				params := asMap(fn["parameters"])
				if params == nil {
					params = map[string]any{"type": "object", "properties": map[string]any{}}
				}
				openAITools = append(openAITools, map[string]any{
					"type": OpenAIFunction,
					"function": map[string]any{
						"name":        asString(fn["name"]),
						"description": asString(fn["description"]),
						"parameters":  params,
					},
				})
			}
		}
		if len(openAITools) > 0 {
			result["tools"] = openAITools
		}
	}

	if stop := body["stopSequences"]; stop != nil {
		result["stop"] = stop
	}
	return result, nil
}

// convertGeminiContent converts one Gemini content entry into one OpenAI
// message. A functionResponse collapses the entry into a tool message, which is
// why this returns a single map rather than a list.
func convertGeminiContent(content map[string]any) map[string]any {
	if content == nil {
		return nil
	}
	role := string(RoleAssistant)
	if asString(content["role"]) == string(GeminiUser) {
		role = string(RoleUser)
	}

	parts := asSlice(content["parts"])
	if parts == nil {
		return nil
	}

	openAIParts := make([]any, 0, len(parts))
	toolCalls := make([]any, 0, 2)

	for _, rawPart := range parts {
		part := asMap(rawPart)
		if part == nil {
			continue
		}
		if text, ok := part["text"].(string); ok {
			openAIParts = append(openAIParts, map[string]any{"type": OpenAIText, "text": text})
		}
		if inline := asMap(part["inlineData"]); inline != nil {
			openAIParts = append(openAIParts, map[string]any{
				"type": OpenAIImageURL,
				"image_url": map[string]any{
					"url": encodeDataURI(asString(inline["mimeType"]), asString(inline["data"])),
				},
			})
		}
		if call := asMap(part["functionCall"]); call != nil {
			name := asString(call["name"])
			id := asString(call["id"])
			if id == "" {
				// Gemini has no native call id. Deriving one from the name keeps
				// the matching functionResponse on the same id, which providers
				// require for pairing.
				id = "call_" + name
			}
			args := call["args"]
			if args == nil {
				args = map[string]any{}
			}
			toolCalls = append(toolCalls, map[string]any{
				"id":   id,
				"type": OpenAIFunction,
				"function": map[string]any{
					"name":      name,
					"arguments": mustJSON(args),
				},
			})
		}
		if resp := asMap(part["functionResponse"]); resp != nil {
			name := asString(resp["name"])
			id := asString(resp["id"])
			if id == "" {
				id = "call_" + name
			}
			contentValue := resp["response"]
			if inner := asMap(resp["response"]); inner != nil {
				if result, ok := inner["result"]; ok {
					contentValue = result
				}
			}
			return map[string]any{
				"role":         string(RoleTool),
				"tool_call_id": id,
				"content":      mustJSON(contentValue),
			}
		}
	}

	if len(toolCalls) > 0 {
		out := map[string]any{"role": string(RoleAssistant)}
		if len(openAIParts) > 0 {
			if len(openAIParts) == 1 {
				if only := asMap(openAIParts[0]); only != nil && asString(only["type"]) == OpenAIText {
					out["content"] = asString(only["text"])
				} else {
					out["content"] = openAIParts
				}
			} else {
				out["content"] = openAIParts
			}
		}
		out["tool_calls"] = toolCalls
		return out
	}

	if len(openAIParts) > 0 {
		return map[string]any{"role": role, "content": collapseTextParts(openAIParts)}
	}
	return nil
}

// toolCallIDUniquifier rewrites duplicate tool-call ids so every emitted
// functionCall id is unique across the whole conversation.
//
// Gemini validates id uniqueness across the entire history and answers 400
// INVALID_ARGUMENT on a repeat, while an OpenAI tool_call_id is only unique
// within its own assistant turn — a long agent session legitimately replays the
// same id in a later turn. Uniqueness is per occurrence: two calls sharing an id
// must end up with different emitted ids, so the mapping is consumed in document
// order instead of memoised by id.
type toolCallIDUniquifier struct {
	used map[string]bool
}

func newToolCallIDUniquifier() *toolCallIDUniquifier {
	return &toolCallIDUniquifier{used: map[string]bool{}}
}

func (u *toolCallIDUniquifier) next(id string) string {
	if id == "" {
		return id
	}
	if !u.used[id] {
		u.used[id] = true
		return id
	}
	n := 2
	candidate := id + "-2"
	for u.used[candidate] {
		n++
		candidate = id + "-" + itoa(int64(n))
	}
	u.used[candidate] = true
	return candidate
}

// openAIToGeminiRequest converts an OpenAI chat body into a Gemini body.
func openAIToGeminiRequest(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error) {
	skipSchemaClean := false
	if creds != nil {
		if v, ok := creds["_skipSchemaClean"].(bool); ok {
			skipSchemaClean = v
		}
	}
	return openAIToGeminiBase(model, body, stream, ThinkingSignature(agSignatureName), skipSchemaClean), nil
}

// openAIToGeminiCLIRequest is the Cloud Code Assist variant: same body, the CLI
// signature on synthetic thought parts.
func openAIToGeminiCLIRequest(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error) {
	skipSchemaClean := false
	if creds != nil {
		if v, ok := creds["_skipSchemaClean"].(bool); ok {
			skipSchemaClean = v
		}
	}
	return openAIToGeminiBase(model, body, stream, ThinkingSignature(geminiCLISigName), skipSchemaClean), nil
}

func openAIToGeminiBase(model string, body map[string]any, stream bool, signature string, skipSchemaClean bool) map[string]any {
	result := map[string]any{
		"model":            model,
		"contents":         []any{},
		"generationConfig": map[string]any{},
		"safetySettings":   defaultSafetySettings(),
	}
	genCfg := result["generationConfig"].(map[string]any)

	allowSampling := !isGemini4Model(model)
	if allowSampling {
		if v, ok := body["temperature"]; ok {
			genCfg["temperature"] = v
		}
		if v, ok := body["top_p"]; ok {
			genCfg["topP"] = v
		}
		if v, ok := body["top_k"]; ok {
			genCfg["topK"] = v
		}
	}
	if v, ok := body["max_tokens"]; ok {
		genCfg["maxOutputTokens"] = v
	}
	if len(genCfg) == 0 {
		delete(result, "generationConfig")
	}

	messages := asSlice(body["messages"])

	// id → name across the conversation, plus a per-id queue of tool results.
	// Both are keyed by the ORIGINAL id: a long session can reuse an id in a
	// later turn, and a plain map would answer the earlier turn with the later
	// turn's output.
	idToName := map[string]string{}
	responseQueues := map[string][]string{}
	for _, raw := range messages {
		msg := asMap(raw)
		if msg == nil {
			continue
		}
		if asString(msg["role"]) == string(RoleAssistant) {
			for _, rawCall := range asSlice(msg["tool_calls"]) {
				call := asMap(rawCall)
				if call == nil {
					continue
				}
				if id, name := asString(call["id"]), asString(asMap(call["function"])["name"]); id != "" && name != "" {
					idToName[id] = name
				}
			}
		}
		if asString(msg["role"]) == string(RoleTool) {
			id := asString(msg["tool_call_id"])
			if id != "" {
				responseQueues[id] = append(responseQueues[id], asString(textOf(msg["content"])))
			}
		}
	}
	responseCursor := map[string]int{}
	uniquifier := newToolCallIDUniquifier()

	contents := make([]any, 0, len(messages))
	for i, raw := range messages {
		msg := asMap(raw)
		if msg == nil {
			continue
		}
		role := asString(msg["role"])
		content := msg["content"]

		switch {
		case role == string(RoleSystem) && len(messages) > 1:
			systemText := asString(textOf(content))
			if systemText == "" {
				systemText = extractTextContent(content, "\n")
			}
			result["systemInstruction"] = map[string]any{
				"role":  string(GeminiUser),
				"parts": []any{map[string]any{"text": systemText}},
			}
		case role == string(RoleUser) || (role == string(RoleSystem) && len(messages) == 1):
			parts := convertOpenAIContentToParts(content)
			if len(parts) > 0 {
				contents = append(contents, map[string]any{"role": string(GeminiUser), "parts": parts})
			}
		case role == string(RoleAssistant):
			parts := make([]any, 0, 4)

			if reasoning := asString(msg["reasoning_content"]); reasoning != "" {
				parts = append(parts, map[string]any{"thought": true, "text": reasoning})
				parts = append(parts, map[string]any{"thoughtSignature": signature, "text": ""})
			}
			if text := asString(textOf(content)); text != "" {
				parts = append(parts, map[string]any{"text": text})
			}

			calls := asSlice(msg["tool_calls"])
			if calls != nil {
				type emitted struct {
					origID string
					emitID string
					name   string
				}
				var emittedCalls []emitted
				firstSeen := false

				for _, rawCall := range calls {
					call := asMap(rawCall)
					if call == nil || asString(call["type"]) != OpenAIFunction {
						continue
					}
					fn := asMap(call["function"])
					args := parseJSONObject(asString(fn["arguments"]))

					callSig := ""
					if !firstSeen {
						callSig = signature
						firstSeen = true
					}

					origID := asString(call["id"])
					emitID := uniquifier.next(origID)

					part := map[string]any{
						"functionCall": map[string]any{
							"id":   emitID,
							"name": sanitizeGeminiFunctionName(asString(fn["name"])),
							"args": args,
						},
					}
					if callSig != "" {
						part["thoughtSignature"] = callSig
					}
					parts = append(parts, part)
					emittedCalls = append(emittedCalls, emitted{
						origID: origID,
						emitID: emitID,
						name:   asString(fn["name"]),
					})
				}

				if len(parts) > 0 {
					contents = append(contents, map[string]any{"role": string(GeminiModel), "parts": parts})
				}

				hasResponses := false
				for _, e := range emittedCalls {
					if responseCursor[e.origID] < len(responseQueues[e.origID]) {
						hasResponses = true
						break
					}
				}
				isIntermediate := i < len(messages)-1
				if hasResponses || isIntermediate {
					toolParts := make([]any, 0, len(emittedCalls))
					for _, e := range emittedCalls {
						resp := ""
						if queue := responseQueues[e.origID]; responseCursor[e.origID] < len(queue) {
							resp = queue[responseCursor[e.origID]]
							responseCursor[e.origID]++
						}
						name := e.name
						if name == "" {
							name = idToName[e.origID]
						}
						if name == "" {
							name = e.origID
						}
						parsed := parseJSONObject(resp)
						if parsed == nil {
							parsed = map[string]any{"result": resp}
						}
						toolParts = append(toolParts, map[string]any{
							"functionResponse": map[string]any{
								"id":       e.emitID,
								"name":     sanitizeGeminiFunctionName(name),
								"response": map[string]any{"result": parsed},
							},
						})
					}
					if len(toolParts) > 0 {
						contents = append(contents, map[string]any{"role": string(GeminiUser), "parts": toolParts})
					}
				}
			} else if len(parts) > 0 {
				contents = append(contents, map[string]any{"role": string(GeminiModel), "parts": parts})
			}
		}
	}

	if tools := asSlice(body["tools"]); len(tools) > 0 {
		declarations := make([]any, 0, len(tools))
		for _, rawTool := range tools {
			tool := asMap(rawTool)
			if tool == nil {
				continue
			}
			// Claude-shaped tool (name + input_schema)
			if name := asString(tool["name"]); name != "" && tool["input_schema"] != nil {
				schema := asMap(tool["input_schema"])
				if !skipSchemaClean {
					schema = cleanJSONSchemaForAntigravity(schema)
				}
				if schema == nil {
					schema = map[string]any{"type": "object", "properties": map[string]any{}}
				}
				declarations = append(declarations, map[string]any{
					"name":        sanitizeGeminiFunctionName(name),
					"description": asString(tool["description"]),
					"parameters":  schema,
				})
				continue
			}
			// OpenAI-shaped tool
			if asString(tool["type"]) == OpenAIFunction {
				fn := asMap(tool["function"])
				if fn == nil {
					continue
				}
				schema := asMap(fn["parameters"])
				if !skipSchemaClean {
					schema = cleanJSONSchemaForAntigravity(schema)
				}
				if schema == nil {
					schema = map[string]any{"type": "object", "properties": map[string]any{}}
				}
				declarations = append(declarations, map[string]any{
					"name":        sanitizeGeminiFunctionName(asString(fn["name"])),
					"description": asString(fn["description"]),
					"parameters":  schema,
				})
			}
		}
		if len(declarations) > 0 {
			result["tools"] = []any{map[string]any{"functionDeclarations": declarations}}
		}
	}

	result["contents"] = normalizeGeminiContents(contents, model)
	return result
}

// openAIToVertexRequest is the Gemini body with the Vertex-specific corrections:
// the synthetic signature is swapped for Vertex's own, and functionCall /
// functionResponse ids are removed because Vertex rejects them.
func openAIToVertexRequest(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error) {
	gemini, err := openAIToGeminiRequest(model, body, stream, creds)
	if err != nil {
		return nil, err
	}
	vertexSignature := ThinkingSignature(vertexSignatureName)

	for _, rawTurn := range asSlice(gemini["contents"]) {
		turn := asMap(rawTurn)
		if turn == nil {
			continue
		}
		for _, rawPart := range asSlice(turn["parts"]) {
			part := asMap(rawPart)
			if part == nil {
				continue
			}
			if _, ok := part["thoughtSignature"]; ok {
				part["thoughtSignature"] = vertexSignature
			}
			if call := asMap(part["functionCall"]); call != nil {
				delete(call, "id")
			}
			if resp := asMap(part["functionResponse"]); resp != nil {
				delete(resp, "id")
			}
		}
	}
	return gemini, nil
}

func init() {
	Register(FormatGemini, FormatOpenAI, geminiToOpenAIRequest, nil)
	Register(FormatGeminiCLI, FormatOpenAI, geminiToOpenAIRequest, nil)
	Register(FormatOpenAI, FormatGemini, openAIToGeminiRequest, nil)
	Register(FormatOpenAI, FormatVertex, openAIToVertexRequest, nil)
	Register(FormatOpenAI, FormatGeminiCLI, openAIToGeminiCLIRequest, nil)
}
