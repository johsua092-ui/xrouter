package translate

// Port of open-sse/translator/request/{openai,claude}-to-kiro.js.
//
// These build the actual AWS CodeWhisperer GenerateAssistantResponse payload. The
// two entry points differ only in how they read the client's message shape; the
// assembly after that is shared, because the output is one wire format either way.
//
// Two behaviours are worth calling out because they look like details and are not:
//
//   - The system prompt does NOT travel in a top-level `systemPrompt` field. The
//     CodeWhisperer surface rejects that with 400 REQUEST_BODY_INVALID. It is
//     prepended to the first user turn's content instead, through the session
//     replay's contentPrefix, so it also lands inside Kiro's cacheable prefix.
//   - The `-agentic` and `-thinking` model suffixes are 9router synthetics. They
//     change what is injected into the request and are stripped before the model
//     id reaches upstream, because Kiro does not advertise them.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Kiro thinking-budget bounds. Duplicated from providers/kiro.go rather than
// imported: the translate package cannot import providers (providers imports
// translate for the format bridge), and these are protocol constants that do not
// vary by consumer.
const (
	KiroDefaultThinkingBudget = 16000
	KiroThinkingBudgetMax     = 32000
)

// ── session identity (utils/sessionManager.js, kiro scope) ───────────────────

var kiroSessionHeaderKeys = []string{"x-session-id", "session-id", "session_id", "x-amp-thread-id"}

const kiroClaudeCodeSessionHeader = "x-claude-code-session-id"

var kiroClaudeCodeSessionRe = regexp.MustCompile(`_session_([a-f0-9-]+)$`)

// KiroSessionIdentity is the conversation identity a request resolves to.
type KiroSessionIdentity struct {
	SessionID string
	// Ephemeral marks an identity minted for this request alone. Only Kiro
	// generates one: its conversationId must be stable across turns for caching
	// to work, but a client that sends no session hint gets a fresh id per
	// request rather than a synthesised stable one, since guessing wrong would
	// merge two unrelated conversations.
	Ephemeral bool
}

// resolveKiroSessionIdentity reads a client-supplied session id from headers and
// body, falling back to a fresh ephemeral id.
//
// The precedence is by how much the value is trusted: a Claude Code session
// survives format translation that drops metadata, so it is checked first, then
// generic session headers, then body fields.
func resolveKiroSessionIdentity(headers map[string]string, body map[string]any, connectionID string) KiroSessionIdentity {
	if claude := extractKiroClaudeCodeSession(body); claude != "" {
		return KiroSessionIdentity{SessionID: "claude:" + claude}
	}
	if v := headerValueFold(headers, kiroClaudeCodeSessionHeader); v != "" {
		return KiroSessionIdentity{SessionID: "claude:" + v}
	}
	for _, key := range kiroSessionHeaderKeys {
		if v := headerValueFold(headers, key); v != "" {
			return KiroSessionIdentity{SessionID: v}
		}
	}
	// x-client-request-id is deliberately not consulted for Kiro: it is
	// per-request, so using it as a conversation id would break caching entirely.
	for _, key := range []string{"prompt_cache_key", "session_id", "conversation_id"} {
		if v := normalizeKiroSessionID(body[key]); v != "" {
			return KiroSessionIdentity{SessionID: v}
		}
	}
	return KiroSessionIdentity{SessionID: generateKiroBinaryStyleID(), Ephemeral: true}
}

// extractKiroClaudeCodeSession pulls the session out of a Claude Code
// metadata.user_id, which is either `_session_<uuid>` or JSON with session_id.
func extractKiroClaudeCodeSession(body map[string]any) string {
	metadata, ok := body["metadata"].(map[string]any)
	if !ok {
		return ""
	}
	userID, _ := metadata["user_id"].(string)
	if userID == "" {
		return ""
	}
	if groups := kiroClaudeCodeSessionRe.FindStringSubmatch(userID); groups != nil {
		return groups[1]
	}
	if strings.HasPrefix(userID, "{") {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(userID), &parsed); err == nil {
			return normalizeKiroSessionID(parsed["session_id"])
		}
	}
	return ""
}

func normalizeKiroSessionID(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 256 {
		return ""
	}
	return s
}

// headerValueFold does a case-insensitive header lookup against a plain map.
// http.Header.Get handles the canonical form; this tolerates the lowercase
// variants the Node engine receives.
func headerValueFold(headers map[string]string, key string) string {
	if headers == nil {
		return ""
	}
	if v := headers[key]; v != "" {
		return normalizeKiroSessionID(v)
	}
	lower := strings.ToLower(key)
	for k, v := range headers {
		if strings.ToLower(k) == lower {
			return normalizeKiroSessionID(v)
		}
	}
	return ""
}

func generateKiroBinaryStyleID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	uuid := fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(buf[0:4]),
		hex.EncodeToString(buf[4:6]),
		hex.EncodeToString(buf[6:8]),
		hex.EncodeToString(buf[8:10]),
		hex.EncodeToString(buf[10:16]))
	return uuid + fmt.Sprintf("%d", time.Now().UnixMilli())
}

// kiroContinuationStore keeps a stable continuation id per conversation.
//
// The continuation id is separate from the session id: the session identifies
// the conversation, the continuation identifies this particular turn stream. It
// has to be stable within a conversation so a retry does not register as a new
// turn, and it must not be reused across conversations.
type kiroContinuationStore struct {
	mu      sync.Mutex
	entries map[string]kiroContinuation
	maxSize int
}

type kiroContinuation struct {
	id       string
	lastUsed time.Time
}

var kiroContinuations = &kiroContinuationStore{
	entries: map[string]kiroContinuation{},
	maxSize: 5000,
}

func (s *kiroContinuationStore) resolve(sessionID, connectionID, scope string, ephemeral bool) string {
	if ephemeral {
		return generateKiroBinaryStyleID()
	}
	key := scope + ":" + connectionID + ":" + sessionID

	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.entries[key]; ok {
		existing.lastUsed = time.Now()
		s.entries[key] = existing
		return existing.id
	}
	id := generateKiroBinaryStyleID()
	if len(s.entries) >= s.maxSize {
		for k := range s.entries {
			delete(s.entries, k)
			break
		}
	}
	s.entries[key] = kiroContinuation{id: id, lastUsed: time.Now()}
	return id
}

func (s *kiroContinuationStore) clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = map[string]kiroContinuation{}
}

// ── payload assembly ─────────────────────────────────────────────────────────

// KiroPayloadResult is the outcome of building a Kiro request body.
type KiroPayloadResult struct {
	// Payload is the GenerateAssistantResponse body, or nil when the
	// conversation could not be made valid.
	Payload map[string]any
	// UpstreamModel is the real Kiro model id, after suffix stripping and alias
	// folding. The executor needs it because the model in the payload is the
	// upstream one, not the client's.
	UpstreamModel string
	// ToolNameMap maps the client's tool names to the sanitised Kiro names. The
	// response path restores the client's names using the reverse of this.
	ToolNameMap map[string]string
	// Errors is the canonicalizer taxonomy when Payload is nil.
	Errors []string
}

// kiroMessageShapes lists the content-block discriminators each client dialect
// can use, so the two converters share one loop.
type kiroBlockTypes struct {
	text        string
	image       string
	toolUse     string
	toolResult  string
	imageInLine bool
}

var kiroOpenAIBlocks = kiroBlockTypes{
	text:       OpenAIText,
	image:      OpenAIImageURL,
	toolUse:    OpenAIFunction,
	toolResult: "",
}

var kiroClaudeBlocks = kiroBlockTypes{
	text:       ClaudeText,
	image:      ClaudeImage,
	toolUse:    ClaudeToolUse,
	toolResult: ClaudeToolResult,
}

// convertKiroMessages flattens a client message list into Kiro's history +
// currentMessage pair.
//
// The algorithm is a pending-buffer merge: consecutive same-role messages
// accumulate into one Kiro turn, because Kiro requires alternation and clients
// routinely send system/developer turns adjacent to the first user turn. The last
// user turn is spliced out as currentMessage, since the payload carries it
// separately.
func convertKiroMessages(messages []any, modelID string, shape kiroBlockTypes, claudeImages bool) ([]any, map[string]any) {
	history := []any{}
	var currentMessage map[string]any

	pendingUserContent := []string{}
	pendingAssistantContent := []string{}
	pendingToolResults := []any{}
	pendingImages := []any{}
	var currentRole string

	flush := func() {
		switch currentRole {
		case string(RoleUser):
			content := strings.TrimSpace(strings.Join(pendingUserContent, "\n\n"))
			if content == "" {
				content = kiroEmptyUserContent(len(pendingToolResults) > 0)
			}
			userMessage := map[string]any{
				"userInputMessage": map[string]any{"content": content, "modelId": modelID},
			}
			uim := userMessage["userInputMessage"].(map[string]any)
			if len(pendingImages) > 0 {
				uim["images"] = append([]any{}, pendingImages...)
			}
			if len(pendingToolResults) > 0 {
				uim["userInputMessageContext"] = map[string]any{
					"toolResults": append([]any{}, pendingToolResults...),
				}
			}
			history = append(history, userMessage)
			currentMessage = userMessage

			pendingUserContent = nil
			pendingToolResults = nil
			pendingImages = nil
		case string(RoleAssistant):
			content := strings.TrimSpace(strings.Join(pendingAssistantContent, "\n\n"))
			if content == "" {
				content = "..."
			}
			history = append(history, map[string]any{
				"assistantResponseMessage": map[string]any{"content": content},
			})
			pendingAssistantContent = nil
		}
	}

	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok || msg == nil {
			continue
		}
		role, _ := msg["role"].(string)

		// system and tool both become user turns: the CodeWhisperer surface has
		// no system role, and a tool result is delivered as the user's next input.
		wasSystem := role == string(RoleSystem) || role == string(RoleDeveloper)
		if wasSystem || role == string(RoleTool) {
			role = string(RoleUser)
		}

		if role != currentRole && currentRole != "" {
			flush()
		}
		currentRole = role

		switch Role(role) {
		case RoleUser:
			content := ""
			if s, ok := msg["content"].(string); ok {
				content = s
			} else if parts, ok := msg["content"].([]any); ok {
				textParts := []string{}
				for _, rawPart := range parts {
					part, ok := rawPart.(map[string]any)
					if !ok {
						continue
					}
					blockType, _ := part["type"].(string)
					switch {
					case blockType == shape.text || part["text"] != nil:
						if text, ok := part["text"].(string); ok {
							textParts = append(textParts, text)
						}
					case blockType == shape.image && !claudeImages:
						url := kiroOpenAIImageURL(part)
						if parsed := parseDataURI(url); parsed != nil {
							pendingImages = append(pendingImages, map[string]any{
								"format": kiroImageFormat(parsed.mimeType),
								"source": map[string]any{"bytes": parsed.base64},
							})
						} else if strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://") {
							// Kiro accepts base64 only. An http image degrades to a
							// text reference so the model at least knows one existed.
							textParts = append(textParts, "[Image: "+url+"]")
						}
					case blockType == shape.image && claudeImages:
						if data, mime := kiroClaudeBase64Image(part); data != "" {
							pendingImages = append(pendingImages, map[string]any{
								"format": kiroImageFormat(mime),
								"source": map[string]any{"bytes": data},
							})
						}
					case blockType == shape.toolResult && shape.toolResult != "":
						resultText := kiroToolResultContent(part)
						pendingToolResults = append(pendingToolResults, map[string]any{
							"toolUseId": kiroRawID(part["tool_use_id"]),
							"status":    kiroToolResultStatus(part),
							"content":   []any{map[string]any{"text": resultText}},
						})
					}
				}
				content = strings.Join(textParts, "\n")
			}

			switch {
			case Role(role) == RoleUser && msg["role"] == string(RoleTool):
				toolContent, _ := msg["content"].(string)
				status := "success"
				if isErr, _ := msg["is_error"].(bool); isErr {
					status = "error"
				} else if s, _ := msg["status"].(string); s == "error" {
					status = "error"
				}
				pendingToolResults = append(pendingToolResults, map[string]any{
					"toolUseId": kiroRawID(msg["tool_call_id"]),
					"status":    status,
					"content":   []any{map[string]any{"text": toolContent}},
				})
			case content != "":
				// A system turn is wrapped in <instructions> tags because Claude
				// models treat that form as an authoritative directive, and the
				// system prompt otherwise loses its precedence once it becomes
				// part of a user turn.
				if wasSystem {
					pendingUserContent = append(pendingUserContent, "<instructions>\n"+content+"\n</instructions>")
				} else {
					pendingUserContent = append(pendingUserContent, content)
				}
			}

		case RoleAssistant:
			textContent := ""
			toolUses := []any{}

			switch content := msg["content"].(type) {
			case []any:
				texts := []string{}
				for _, rawPart := range content {
					part, ok := rawPart.(map[string]any)
					if !ok {
						continue
					}
					blockType, _ := part["type"].(string)
					if blockType == shape.text {
						if text, ok := part["text"].(string); ok {
							texts = append(texts, text)
						}
						continue
					}
					if blockType == shape.toolUse && shape.toolUse != "" {
						toolUses = append(toolUses, part)
					}
				}
				textContent = strings.TrimSpace(strings.Join(texts, "\n"))
			case string:
				textContent = strings.TrimSpace(content)
			}

			if toolCalls, ok := msg["tool_calls"].([]any); ok && len(toolCalls) > 0 {
				toolUses = toolCalls
			}

			if textContent != "" {
				pendingAssistantContent = append(pendingAssistantContent, textContent)
			}

			if len(toolUses) > 0 {
				flush()
				// The toolUses attach to the assistant turn flush() just
				// emitted, so the calls and the preceding text stay one turn.
				if last, ok := history[len(history)-1].(map[string]any); ok {
					if assistant, ok := last["assistantResponseMessage"].(map[string]any); ok {
						assistant["toolUses"] = kiroMapToolUses(toolUses)
					}
				}
				// Forces the next message to start a new turn, so a following
				// assistant message is not merged into this one and lose its
				// toolUses boundary.
				currentRole = ""
			}
		}
	}

	if currentRole != "" {
		flush()
	}

	// The last user turn is the current message. Trailing assistant turns are
	// skipped: they belong to history.
	for i := len(history) - 1; i >= 0; i-- {
		entry, ok := history[i].(map[string]any)
		if !ok {
			continue
		}
		if _, isUser := entry["userInputMessage"]; isUser {
			currentMessage = entry
			history = append(history[:i], history[i+1:]...)
			break
		}
	}

	for _, entry := range history {
		m, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		uim, ok := m["userInputMessage"].(map[string]any)
		if !ok {
			continue
		}
		if ctx, ok := uim["userInputMessageContext"].(map[string]any); ok && len(ctx) == 0 {
			delete(uim, "userInputMessageContext")
		}
		if _, has := uim["modelId"]; !has {
			uim["modelId"] = modelID
		}
	}

	// Kiro requires strict alternation, so consecutive user turns are merged
	// rather than sent as-is. Tool results and images are merged alongside the
	// content: dropping them here would silently lose a tool round-trip.
	merged := []any{}
	for _, entry := range history {
		current, ok := entry.(map[string]any)
		if !ok {
			merged = append(merged, entry)
			continue
		}
		prev, prevOK := lastMap(merged)
		_, currentIsUser := current["userInputMessage"]
		_, prevIsUser := prev["userInputMessage"]
		if currentIsUser && prevOK && prevIsUser {
			prevUser, _ := prev["userInputMessage"].(map[string]any)
			currentUser, _ := current["userInputMessage"].(map[string]any)
			kiroMergeUser(prevUser, currentUser)
			continue
		}
		merged = append(merged, current)
	}

	if currentMessage == nil {
		// An input with no user turn at all (assistant-only) still needs a
		// current message, so tools and content have somewhere to attach.
		currentMessage = map[string]any{
			"userInputMessage": map[string]any{"content": "", "modelId": modelID},
		}
	}

	return merged, currentMessage
}

func lastMap(entries []any) (map[string]any, bool) {
	if len(entries) == 0 {
		return nil, false
	}
	m, ok := entries[len(entries)-1].(map[string]any)
	return m, ok
}

// kiroMapToolUses normalises both client tool-call shapes into Kiro toolUses.
//
// OpenAI puts the name and arguments inside a `function` object with the
// arguments as a JSON string; Claude puts them flat with a parsed input object.
// A JSON string that will not parse becomes an empty object rather than nil,
// because nil means "unusable" downstream and would flatten a callable tool.
func kiroMapToolUses(toolUses []any) []any {
	out := make([]any, 0, len(toolUses))
	for _, raw := range toolUses {
		call, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if fn, ok := call["function"].(map[string]any); ok {
			name, _ := fn["name"].(string)
			arguments := map[string]any{}
			if s, ok := fn["arguments"].(string); ok && s != "" {
				var parsed map[string]any
				if err := json.Unmarshal([]byte(s), &parsed); err == nil && parsed != nil {
					arguments = parsed
				}
			}
			id, _ := call["id"].(string)
			if id == "" {
				id = generateKiroBinaryStyleID()
			}
			out = append(out, map[string]any{
				"toolUseId": id,
				"name":      name,
				"input":     arguments,
			})
			continue
		}
		name, _ := call["name"].(string)
		id, _ := call["toolUseId"].(string)
		if id == "" {
			id, _ = call["id"].(string)
		}
		if id == "" {
			id = generateKiroBinaryStyleID()
		}
		input := call["input"]
		if input == nil {
			input = map[string]any{}
		}
		out = append(out, map[string]any{
			"toolUseId": id,
			"name":      name,
			"input":     input,
		})
	}
	return out
}

func kiroOpenAIImageURL(part map[string]any) string {
	if img, ok := part["image_url"].(map[string]any); ok {
		if url, ok := img["url"].(string); ok {
			return url
		}
	}
	if url, ok := part["image_url"].(string); ok {
		return url
	}
	return ""
}

// kiroClaudeBase64Image reads a Claude image block. Kiro accepts base64 payloads
// only, so any other source type is ignored rather than forwarded.
func kiroClaudeBase64Image(part map[string]any) (string, string) {
	source, ok := part["source"].(map[string]any)
	if !ok {
		return "", ""
	}
	sourceType, _ := source["type"].(string)
	if sourceType != "base64" {
		return "", ""
	}
	data, _ := source["data"].(string)
	if data == "" {
		return "", ""
	}
	mime, _ := source["media_type"].(string)
	if mime == "" {
		mime = DefaultImageMIME
	}
	return data, mime
}

func kiroImageFormat(mime string) string {
	if idx := strings.Index(mime, "/"); idx >= 0 && idx+1 < len(mime) {
		return mime[idx+1:]
	}
	return mime
}

// kiroToolResultContent renders a Claude tool_result block's content.
//
// Images a tool returned (a screenshot, say) ride along as separate user images
// because Kiro tool results are text-only. The placeholder text keeps the
// position visible instead of leaving an empty result.
func kiroToolResultContent(part map[string]any) string {
	switch content := part["content"].(type) {
	case string:
		return content
	case []any:
		texts := []string{}
		hasImage := false
		for _, rawChild := range content {
			child, ok := rawChild.(map[string]any)
			if !ok {
				continue
			}
			childType, _ := child["type"].(string)
			if childType == ClaudeText {
				if text, ok := child["text"].(string); ok {
					texts = append(texts, text)
				}
				continue
			}
			if childType == ClaudeImage {
				if source, ok := child["source"].(map[string]any); ok {
					if sourceType, _ := source["type"].(string); sourceType == "base64" {
						hasImage = true
					}
				}
			}
		}
		if len(texts) > 0 {
			return strings.Join(texts, "\n")
		}
		if hasImage {
			return "(image attached)"
		}
		raw, err := json.Marshal(content)
		if err != nil {
			return ""
		}
		return string(raw)
	case nil:
		return ""
	}
	raw, err := json.Marshal(part["content"])
	if err != nil {
		return ""
	}
	return string(raw)
}

func kiroToolResultStatus(part map[string]any) string {
	if isErr, _ := part["is_error"].(bool); isErr {
		return "error"
	}
	return "success"
}

// kiroExtractSystemText renders a Claude `system` field (string or block array).
func kiroExtractSystemText(system any) string {
	switch s := system.(type) {
	case string:
		return s
	case []any:
		parts := []string{}
		for _, raw := range s {
			if text, ok := raw.(string); ok {
				parts = append(parts, text)
				continue
			}
			if block, ok := raw.(map[string]any); ok {
				if text, ok := block["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
		filtered := parts[:0]
		for _, p := range parts {
			if p != "" {
				filtered = append(filtered, p)
			}
		}
		return strings.Join(filtered, "\n")
	}
	return ""
}

// BuildKiroPayload assembles the GenerateAssistantResponse body.
//
// history and currentMessage arrive already converted from the client's message
// shape; everything from here on is shared between the OpenAI and Claude routes.
func BuildKiroPayload(model string, history []any, currentMessage map[string]any, body map[string]any, stream bool, creds map[string]any, replay kiroReplayFn) KiroPayloadResult {
	resolution := kiroModelResolver(model)
	upstreamModel := resolution.Upstream

	maxTokens := 32000
	if v, ok := asFloat(body["max_tokens"]); ok && v > 0 {
		maxTokens = int(v)
	}

	thinkingBody := applyKiroThinkingOverride(body, model)
	thinkingBudget := resolveKiroThinkingBudget(thinkingBody, creds, resolution.Thinking)
	additionalFields := kiroAdditionalFieldsFn(thinkingBody, upstreamModel)
	usesNativeGptEffort := kiroUsesNativeGptEffortFn(thinkingBody, upstreamModel)

	toolSpecs, nameMap := NormalizeKiroToolSpecs(asAnySlice(body["tools"]))
	canonical := CanonicalizeKiroConversation(history, currentMessage, upstreamModel, toolSpecs, nameMap)
	if !canonical.Valid {
		return KiroPayloadResult{UpstreamModel: upstreamModel, Errors: canonical.Errors}
	}

	authMethod := kiroCredString(creds, "authMethod")
	profileARN := kiroProfileARNResolver(authMethod, kiroCredString(creds, "profileArn"))

	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

	systemPromptParts := []string{}
	if thinkingBudget != nil && !usesNativeGptEffort {
		systemPromptParts = append(systemPromptParts, kiroThinkingPrefixFn(*thinkingBudget))
	}
	if resolution.Agentic {
		systemPromptParts = append(systemPromptParts, kiroAgenticPromptFn())
	}
	if body != nil {
		if sys := kiroExtractSystemText(body["system"]); sys != "" {
			systemPromptParts = append(systemPromptParts, sys)
		}
	}
	systemPrompt := strings.Join(systemPromptParts, "\n\n")
	currentTimeContext := "[Context: Current time is " + timestamp + "]"
	contentPrefix := strings.Join(filterNonEmpty([]string{systemPrompt, currentTimeContext}), "\n\n")

	sessionID, connectionID := "", ""
	if creds != nil {
		sessionID = kiroCredString(creds, "sessionId")
		connectionID = kiroCredString(creds, "connectionId")
	}
	identity := resolveKiroSessionIdentity(credsToStringMap(creds, "rawHeaders"), body, connectionID)
	if sessionID != "" {
		identity = KiroSessionIdentity{SessionID: sessionID}
	}
	conversationID := identity.SessionID
	continuationID := kiroContinuations.resolve(conversationID, connectionID, "kiro", identity.Ephemeral)

	replayed := canonical.History
	replayedCurrent := canonical.CurrentMessage
	if replay != nil {
		result := replay(conversationID, connectionID, upstreamModel, systemPrompt, contentPrefix, currentTimeContext, canonical.History, canonical.CurrentMessage)
		replayed = result.History
		replayedCurrent = result.CurrentMessage
	}

	// The replay rewrote the opening turn, so the conversation has to be
	// re-canonicalized: the frozen start may not pair with what follows it.
	recanonicalized := CanonicalizeKiroConversation(replayed, replayedCurrent, upstreamModel, toolSpecs, nameMap)
	if !recanonicalized.Valid {
		return KiroPayloadResult{UpstreamModel: upstreamModel, Errors: recanonicalized.Errors}
	}

	finalCurrent, _ := recanonicalized.CurrentMessage["userInputMessage"].(map[string]any)
	if finalCurrent == nil {
		return KiroPayloadResult{UpstreamModel: upstreamModel, Errors: []string{"current"}}
	}

	userInputMessage := map[string]any{
		"content": kiroStringOr(finalCurrent["content"]),
		"modelId": upstreamModel,
		"origin":  "AI_EDITOR",
	}
	if ctx, ok := finalCurrent["userInputMessageContext"].(map[string]any); ok && len(ctx) > 0 {
		userInputMessage["userInputMessageContext"] = ctx
	}
	if images, ok := finalCurrent["images"].([]any); ok && len(images) > 0 {
		userInputMessage["images"] = images
	}

	payload := map[string]any{
		"conversationState": map[string]any{
			"chatTriggerType": "MANUAL",
			"conversationId":  conversationID,
			"currentMessage": map[string]any{
				"userInputMessage": userInputMessage,
			},
			"history": recanonicalized.History,
		},
	}
	// The continuation id is separate from the conversation id by design: the
	// upstream uses it to distinguish a continuing turn from a new one in the
	// same conversation.
	payload["conversationState"].(map[string]any)["chatTriggerType"] = "MANUAL"
	if continuationID != "" {
		payload["conversationState"].(map[string]any)["continuationId"] = continuationID
	}

	if profileARN != "" {
		payload["profileArn"] = profileARN
	}
	if additionalFields != nil {
		payload["additionalModelRequestFields"] = additionalFields
	}

	temperature, hasTemp := asFloat(body["temperature"])
	topP, hasTopP := asFloat(body["top_p"])
	if maxTokens > 0 || hasTemp || hasTopP {
		inferenceConfig := map[string]any{}
		if maxTokens > 0 {
			inferenceConfig["maxTokens"] = maxTokens
		}
		if hasTemp {
			inferenceConfig["temperature"] = temperature
		}
		if hasTopP {
			inferenceConfig["topP"] = topP
		}
		payload["inferenceConfig"] = inferenceConfig
	}

	return KiroPayloadResult{
		Payload:       payload,
		UpstreamModel: upstreamModel,
		ToolNameMap:   nameMap,
	}
}

// kiroReplayFn is injected by the providers package so this file stays free of
// the session store, which lives with the adapter that owns its lifetime.
type kiroReplayFn func(conversationID, connectionID, modelID, systemPrompt, contentPrefix, currentContentPrefix string, history []any, currentMessage map[string]any) kiroReplayOutcome

// kiroReplayOutcome is the subset of the replay result the payload builder reads.
type kiroReplayOutcome struct {
	History        []any
	CurrentMessage map[string]any
}

// SetKiroReplayFunc wires the replay store into this package. Called once at
// startup from the providers package, which owns the store.
func SetKiroReplayFunc(fn func(conversationID, connectionID, modelID, systemPrompt, contentPrefix, currentContentPrefix string, history []any, currentMessage map[string]any) ([]any, map[string]any)) {
	if fn == nil {
		kiroReplayHook = nil
		return
	}
	kiroReplayHook = func(conversationID, connectionID, modelID, systemPrompt, contentPrefix, currentContentPrefix string, history []any, currentMessage map[string]any) kiroReplayOutcome {
		h, c := fn(conversationID, connectionID, modelID, systemPrompt, contentPrefix, currentContentPrefix, history, currentMessage)
		return kiroReplayOutcome{History: h, CurrentMessage: c}
	}
}

var kiroReplayHook kiroReplayFn

func init() {
	// The two request routes register here. Both build the same payload; only the
	// message reading differs, which is why the pairs are separate.
	Register(FormatOpenAI, FormatKiro, openAIToKiroRequest, nil)
	Register(FormatClaude, FormatKiro, claudeToKiroRequest, nil)
}

// openAIToKiroRequest converts an OpenAI chat body into a Kiro payload.
func openAIToKiroRequest(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error) {
	messages := asAnySlice(body["messages"])
	resolution := kiroModelResolver(model)
	history, currentMessage := convertKiroMessages(messages, resolution.Upstream, kiroOpenAIBlocks, false)

	result := BuildKiroPayload(model, history, currentMessage, body, stream, creds, kiroReplayHook)
	if result.Payload == nil {
		// A nil payload becomes a 400 without an upstream call, which is the
		// point: an invalid conversation burns a per-account cooldown upstream.
		return nil, fmt.Errorf("kiro: refusing invalid conversation (openai → kiro): %s", strings.Join(result.Errors, ", "))
	}
	return attachKiroMetadata(result), nil
}

// claudeToKiroRequest converts a Claude Messages body into a Kiro payload.
//
// This is the direct route the registry prefers over claude→openai→kiro. The
// OpenAI leg drops Claude-specific request fields, and Kiro's reconciler needs
// the original tool_result ids and is_error flags to pair calls with results.
func claudeToKiroRequest(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error) {
	messages := asAnySlice(body["messages"])
	resolution := kiroModelResolver(model)
	history, currentMessage := convertKiroMessages(messages, resolution.Upstream, kiroClaudeBlocks, true)

	result := BuildKiroPayload(model, history, currentMessage, body, stream, creds, kiroReplayHook)
	if result.Payload == nil {
		return nil, fmt.Errorf("kiro: refusing invalid conversation (claude → kiro): %s", strings.Join(result.Errors, ", "))
	}
	return attachKiroMetadata(result), nil
}

// attachKiroMetadata stamps the routing hints the executor reads.
//
// These travel inside the body because the Adapter interface has no side channel
// for per-request hints: the executor sees the payload and nothing else. The map
// keys are prefixed with an underscore so they are dropped by the same internal-
// tag sweep every provider's body passes through before it reaches the wire.
func attachKiroMetadata(result KiroPayloadResult) map[string]any {
	payload := result.Payload
	payload["_kiroUpstreamModel"] = result.UpstreamModel
	if len(result.ToolNameMap) > 0 {
		reversed := map[string]any{}
		for original, sanitized := range result.ToolNameMap {
			if original != sanitized {
				reversed[sanitized] = original
			}
		}
		if len(reversed) > 0 {
			payload["_kiroToolNameMap"] = reversed
		}
	}
	return payload
}

// ── shared small helpers ─────────────────────────────────────────────────────

func asAnySlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

func kiroCredString(creds map[string]any, key string) string {
	if creds == nil {
		return ""
	}
	s, _ := creds[key].(string)
	return s
}

// credsToStringMap reads a header map out of the credentials bag. The gateway
// passes rawHeaders through as map[string]string; a map[string]any is tolerated
// because a JSON round-trip would produce that shape in tests.
func credsToStringMap(creds map[string]any, key string) map[string]string {
	if creds == nil {
		return nil
	}
	switch v := creds[key].(type) {
	case map[string]string:
		return v
	case map[string]any:
		out := make(map[string]string, len(v))
		for k, raw := range v {
			if s, ok := raw.(string); ok {
				out[k] = s
			}
		}
		return out
	}
	return nil
}

func filterNonEmpty(values []string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

// resolveKiroThinkingBudget decides whether to inject the <thinking_mode> prefix
// and with what budget.
//
// Precedence is explicit client intent first: an explicit none/off returns nil
// and wins over every heuristic, because a client that says "no thinking" must
// not get thinking because its model name happens to contain "thinking".
func resolveKiroThinkingBudget(body map[string]any, creds map[string]any, modelWantsThinking bool) *int {
	if body != nil {
		if oc, ok := body["output_config"].(map[string]any); ok {
			if effort, ok := oc["effort"].(string); ok {
				if isKiroThinkingDisabled(effort) {
					return nil
				}
				if budget, ok := kiroEffortToBudget(effort); ok {
					return &budget
				}
			}
		}
		if effort, ok := body["reasoning_effort"].(string); ok {
			if isKiroThinkingDisabled(effort) {
				return nil
			}
			if budget, ok := kiroEffortToBudget(effort); ok {
				return &budget
			}
		}
		if r, ok := body["reasoning"].(map[string]any); ok {
			if effort, ok := r["effort"].(string); ok {
				if isKiroThinkingDisabled(effort) {
					return nil
				}
				if budget, ok := kiroEffortToBudget(effort); ok {
					return &budget
				}
			}
		}
		if thinking, ok := body["thinking"].(map[string]any); ok {
			if t, ok := thinking["type"].(string); ok && t == "enabled" {
				if b, ok := asFloat(thinking["budget_tokens"]); ok && b > 0 {
					budget := int(b)
					return &budget
				}
				budget := KiroDefaultThinkingBudget
				return &budget
			}
		}
	}

	if headers := credsToStringMap(creds, "rawHeaders"); headers != nil {
		if beta := headerValueFold(headers, "anthropic-beta"); strings.Contains(strings.ToLower(beta), "interleaved-thinking") {
			budget := KiroDefaultThinkingBudget
			return &budget
		}
	}

	if kiroBodyHasThinkingTag(body) {
		budget := KiroDefaultThinkingBudget
		return &budget
	}

	if modelWantsThinking {
		budget := KiroDefaultThinkingBudget
		return &budget
	}

	return nil
}

func isKiroThinkingDisabled(effort string) bool {
	switch strings.ToLower(effort) {
	case "none", "off", "disabled":
		return true
	}
	return false
}

// kiroEffortToBudget maps an effort tier onto a token budget.
func kiroEffortToBudget(effort string) (int, bool) {
	switch strings.ToLower(effort) {
	case "low":
		return 4000, true
	case "medium":
		return KiroDefaultThinkingBudget, true
	case "high":
		return 24000, true
	case "xhigh", "max":
		return KiroThinkingBudgetMax, true
	}
	return 0, false
}

// kiroBodyHasThinkingTag looks for the tag a previous turn may have injected, so
// a continuation keeps thinking on without the client re-asking.
func kiroBodyHasThinkingTag(body map[string]any) bool {
	if body == nil {
		return false
	}
	if system, ok := body["system"].(string); ok && kiroTextHasThinkingTag(system) {
		return true
	}
	for _, raw := range asAnySlice(body["messages"]) {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		if role != string(RoleSystem) && role != string(RoleUser) && role != string(RoleDeveloper) {
			continue
		}
		switch content := msg["content"].(type) {
		case string:
			if kiroTextHasThinkingTag(content) {
				return true
			}
		case []any:
			for _, rawPart := range content {
				part, ok := rawPart.(map[string]any)
				if !ok {
					continue
				}
				if text, ok := part["text"].(string); ok && kiroTextHasThinkingTag(text) {
					return true
				}
			}
		}
	}
	return false
}

func kiroTextHasThinkingTag(text string) bool {
	if !strings.Contains(text, "<thinking_mode>") {
		return false
	}
	return strings.Contains(text, "<thinking_mode>enabled</thinking_mode>") ||
		strings.Contains(text, "<thinking_mode>interleaved</thinking_mode>")
}

// applyKiroThinkingOverride folds a parsed model(level) suffix into the body
// without mutating the caller's map.
func applyKiroThinkingOverride(body map[string]any, model string) map[string]any {
	level := kiroModelLevelSuffix(model)
	if level == "" {
		return body
	}
	next := map[string]any{}
	for k, v := range body {
		next[k] = v
	}
	if budget, _ := kiroBudgetSuffix(model); budget != 0 {
		delete(next, "output_config")
		delete(next, "reasoning_effort")
		delete(next, "reasoning")
		next["thinking"] = map[string]any{"type": "enabled", "budget_tokens": level}
		return next
	}
	outputConfig, _ := next["output_config"].(map[string]any)
	merged := map[string]any{}
	for k, v := range outputConfig {
		merged[k] = v
	}
	merged["effort"] = level
	next["output_config"] = merged
	return next
}

// kiroModelLevelSuffix reads a `(level)` or `(budget:NNNN)` suffix off a model id.
func kiroModelLevelSuffix(model string) any {
	_, level := kiroBudgetSuffix(model)
	return level
}

// kiroBudgetSuffix parses the parenthesised request override. Returns the numeric
// budget and its `any`-typed level for the override to write.
func kiroBudgetSuffix(model string) (int, any) {
	open := strings.LastIndex(model, "(")
	if open < 0 || !strings.HasSuffix(model, ")") {
		return 0, ""
	}
	inner := model[open+1 : len(model)-1]
	switch {
	case strings.Contains(inner, ":"):
		parts := strings.SplitN(inner, ":", 2)
		if parts[0] == "budget" {
			var n int
			if _, err := fmt.Sscanf(parts[1], "%d", &n); err == nil && n > 0 {
				return n, n
			}
		}
		return 0, ""
	case inner == "none" || inner == "off" || inner == "disabled":
		return 0, inner
	case inner == "low" || inner == "medium" || inner == "high" || inner == "xhigh" || inner == "max":
		return 0, inner
	}
	return 0, ""
}

// ── Kiro model helpers, injected by the providers package ────────────────────
//
// The model-folding logic, the effort-field builder and the agentic prompt all
// live in internal/providers/kiro.go, next to the adapter that consumes them and
// the response path that needs the same model id. The translate package cannot
// import providers — providers imports translate for the format bridge, so the
// edge would be a cycle.
//
// These hooks are the seam. They default to the trivial behaviour (no folding,
// no extra fields) so a test that never wires them still runs, and are replaced
// with the real implementations at startup.

// KiroModelResolution mirrors providers.KiroModelResolution without importing it.
type KiroModelResolution struct {
	Upstream string
	Agentic  bool
	Thinking bool
}

func kiroIdentityResolution(model string) KiroModelResolution {
	return KiroModelResolution{Upstream: model}
}

var (
	kiroModelResolver         = kiroIdentityResolution
	kiroThinkingPrefixFn      = func(budget int) string { return "" }
	kiroAgenticPromptFn       = func() string { return "" }
	kiroProfileARNResolver    = func(authMethod, resolved string) string { return resolved }
	kiroAdditionalFieldsFn    = func(body map[string]any, model string) map[string]any { return nil }
	kiroUsesNativeGptEffortFn = func(body map[string]any, model string) bool { return false }
)

// WireKiroHelpers installs the providers-side implementations. Called once at
// startup by the providers package, which owns both the logic and the store.
func WireKiroHelpers(
	resolver func(model string) KiroModelResolution,
	thinkingPrefix func(budget int) string,
	agenticPrompt func() string,
	profileARN func(authMethod, resolved string) string,
	additionalFields func(body map[string]any, model string) map[string]any,
	usesNativeGptEffort func(body map[string]any, model string) bool,
) {
	if resolver != nil {
		kiroModelResolver = resolver
	}
	if thinkingPrefix != nil {
		kiroThinkingPrefixFn = thinkingPrefix
	}
	if agenticPrompt != nil {
		kiroAgenticPromptFn = agenticPrompt
	}
	if profileARN != nil {
		kiroProfileARNResolver = profileARN
	}
	if additionalFields != nil {
		kiroAdditionalFieldsFn = additionalFields
	}
	if usesNativeGptEffort != nil {
		kiroUsesNativeGptEffortFn = usesNativeGptEffort
	}
}
