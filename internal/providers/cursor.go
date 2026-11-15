package providers

// Cursor is the adapter for provider id "cursor" (alias "cu").
//
// Two upstreams, chosen per request:
//
//   - AgentService (agent.api5.cursor.sh/agent.v1.AgentService/Run) is a
//     bidirectional HTTP/2 duplex stream. It carries plain text turns and MCP
//     tool calls, and it requires answering server-initiated exec/kv messages on
//     the same stream.
//   - ChatService (api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools)
//     is an ordinary request/response carrying the whole conversation as one
//     protobuf body. It is the path for image turns, which AgentService cannot
//     represent.
//
// Both speak ConnectRPC framing over protobuf, which is why this provider has no
// analogue elsewhere in the gateway: the body is binary, not JSON.

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"
)

// Cursor endpoint constants. The registry descriptor carries the same values;
// they are duplicated here because the adapter builds its own URLs.
const (
	CursorChatBaseURL    = "https://api2.cursor.sh"
	CursorChatPath       = "/aiserver.v1.ChatService/StreamUnifiedChatWithTools"
	CursorAgentBaseURL   = "https://agent.api5.cursor.sh"
	CursorAgentRunPath   = "/agent.v1.AgentService/Run"
	CursorModelsPath     = "/agent.v1.AgentService/GetUsableModels"
	CursorClientVersion  = "3.12.17"
	CursorClientCommit   = "0fb762053c34788bb7760d5673f8a6d4c8589d50"
	CursorConnectVersion = "1"
)

// Cursor is the adapter type.
type Cursor struct{}

// NewCursor builds the adapter.
func NewCursor() *Cursor { return &Cursor{} }

// Name is the registry key.
func (c *Cursor) Name() string { return "cursor" }

// Aliases are the extra registry keys this adapter answers to.
func (c *Cursor) Aliases() []string { return []string{"cu"} }

// cursorAgentEndpoint returns the AgentService origin, honouring an override so
// a test or a self-hosted relay can point elsewhere.
func cursorAgentEndpoint() string {
	if override := strings.TrimSpace(os.Getenv("CURSOR_AGENT_ENDPOINT")); override != "" {
		return strings.TrimRight(override, "/")
	}
	return CursorAgentBaseURL
}

// cursorChatEndpoint returns the ChatService origin.
func cursorChatEndpoint(cred Credential) string {
	if base := strings.TrimSpace(cred.Extra["baseUrl"]); base != "" {
		return strings.TrimRight(base, "/")
	}
	return CursorChatBaseURL
}

// agentCapable reports whether a request can travel the AgentService path.
//
// AgentService answers text turns (including declared tool schemas) and tool-call
// history. Image parts still need the legacy protobuf path: AgentService's
// history shape carries text only, so an image turn there would arrive as an
// answer to a question the model never saw.
func agentCapable(body map[string]any) bool {
	messages, _ := body["messages"].([]any)
	if len(messages) == 0 {
		return false
	}
	for _, raw := range messages {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		content, has := message["content"]
		if !has || content == nil {
			continue
		}
		switch value := content.(type) {
		case string:
			continue
		case []any:
			for _, part := range value {
				partMap, ok := part.(map[string]any)
				if !ok {
					continue
				}
				partType, _ := partMap["type"].(string)
				if partType == "" || partType == "text" || partType == "input_text" {
					continue
				}
				return false
			}
		default:
			return false
		}
	}
	return true
}

// Endpoint builds the upstream URL.
//
// The agent path is the default for a capable request; the chat path is the
// fallback. Which one is used is decided in Do, not here, because the choice
// depends on the body — so this returns the chat URL and Do overrides it.
func (c *Cursor) Endpoint(req Request, cred Credential) (string, error) {
	return cursorChatEndpoint(cred) + CursorChatPath, nil
}

// Headers builds the Cursor header set, checksum included.
//
// x-cursor-checksum is the interesting one: a 6-byte big-endian timestamp run
// through the Jyh cipher and URL-safe base64'd, with the machine id appended
// verbatim. The upstream validates it, so it cannot be a constant.
func (c *Cursor) Headers(req Request, cred Credential) (map[string]string, error) {
	token := cursorAccessToken(cred)
	if token == "" {
		return nil, fmt.Errorf("cursor: access token is missing")
	}
	machineID := strings.TrimSpace(cred.Extra["machineId"])
	if machineID == "" {
		machineID = curMachineID(token)
	}
	ghostMode := true
	if raw, has := cred.Extra["ghostMode"]; has && strings.EqualFold(raw, "false") {
		ghostMode = false
	}

	osName := "linux"
	switch runtime.GOOS {
	case "windows":
		osName = "windows"
	case "darwin":
		osName = "macos"
	}
	arch := "x64"
	if runtime.GOARCH == "arm64" {
		arch = "aarch64"
	}

	sessionID := curUUIDv5DNS(token)

	return map[string]string{
		"authorization":               "Bearer " + token,
		"connect-accept-encoding":     "gzip",
		"connect-protocol-version":    CursorConnectVersion,
		"content-type":                "application/connect+proto",
		"user-agent":                  "connect-es/1.6.1",
		"x-amzn-trace-id":             "Root=" + curUUID(),
		"x-client-key":                curHashedHex(token, ""),
		"x-cursor-checksum":           cursorChecksum(machineID),
		"x-cursor-client-version":     CursorClientVersion,
		"x-cursor-client-commit":      CursorClientCommit,
		"x-cursor-client-type":        "ide",
		"x-cursor-client-os":          osName,
		"x-cursor-client-arch":        arch,
		"x-cursor-client-device-type": "desktop",
		"x-cursor-config-version":     curUUID(),
		"x-cursor-timezone":           cursorTimezone(),
		"x-ghost-mode":                boolString(ghostMode),
		"x-request-id":                curUUID(),
		"x-session-id":                sessionID,
	}, nil
}

// UpstreamContentType reports what the Cursor upstream answers with.
func (c *Cursor) UpstreamContentType() string { return CursorUpstreamContentType }

func boolString(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

// cursorAccessToken reads the bearer token, tolerating the "<id>::<token>" form
// the dashboard sometimes stores.
func cursorAccessToken(cred Credential) string {
	token := strings.TrimSpace(cred.Extra["accessToken"])
	if token == "" {
		token = strings.TrimSpace(cred.APIKey)
	}
	if token == "" {
		return ""
	}
	if idx := strings.Index(token, "::"); idx >= 0 {
		token = token[idx+2:]
	}
	return strings.TrimSpace(token)
}

// cursorChecksum implements the Jyh cipher: XOR each timestamp byte with a
// rolling key starting at 165, add the byte index, then URL-safe base64 without
// padding, with the machine id appended.
func cursorChecksum(machineID string) string {
	timestamp := time.Now().UnixNano() / 1e6

	raw := []byte{
		byte(timestamp >> 40),
		byte(timestamp >> 32),
		byte(timestamp >> 24),
		byte(timestamp >> 16),
		byte(timestamp >> 8),
		byte(timestamp),
	}

	key := byte(165)
	for i := range raw {
		raw[i] = (raw[i] ^ key) + byte(i%256)
		key = raw[i]
	}

	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	var out strings.Builder
	for i := 0; i < len(raw); i += 3 {
		a := raw[i]
		var b, c byte
		if i+1 < len(raw) {
			b = raw[i+1]
		}
		if i+2 < len(raw) {
			c = raw[i+2]
		}
		out.WriteByte(alphabet[a>>2])
		out.WriteByte(alphabet[((a&3)<<4)|(b>>4)])
		if i+1 < len(raw) {
			out.WriteByte(alphabet[((b&15)<<2)|(c>>6)])
		}
		if i+2 < len(raw) {
			out.WriteByte(alphabet[c&63])
		}
	}
	return out.String() + machineID
}

// curUUIDv5DNS is a UUID v5 over the DNS namespace.
//
// The DNS namespace constant and the SHA-1 hashing rule are fixed by RFC 4122;
// this is a small local implementation rather than a dependency, since it is the
// only v5 use in the tree.
func curUUIDv5DNS(name string) string {
	// 6ba7b810-9dad-11d1-80b4-00c04fd430c8
	namespace := []byte{
		0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1,
		0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
	}
	h := sha1.New()
	h.Write(namespace)
	h.Write([]byte(name))
	sum := h.Sum(nil)

	var id [16]byte
	copy(id[:], sum[:16])
	id[6] = (id[6] & 0x0f) | 0x50 // version 5
	id[8] = (id[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

func cursorTimezone() string {
	if tz := strings.TrimSpace(os.Getenv("TZ")); tz != "" {
		return tz
	}
	return "UTC"
}

// hexToBase64 is used by the usage path and by tests.
func hexToBase64(value string) string {
	raw, err := hex.DecodeString(value)
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// cursorChatMessages converts the translated body's messages into the legacy
// encoder's shape.
//
// Mixed assistant turns are split here: Cursor's encoder rejects a message that
// carries tool calls and tool results together, and the guard exists upstream for
// the same reason.
func cursorChatMessages(body map[string]any, model string) []curChatMessage {
	rawMessages, _ := body["messages"].([]any)
	type pending struct {
		content     string
		role        string
		toolResults []curToolResult
	}

	normalised := []pending{}
	for _, raw := range rawMessages {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		content := cursorTextFromContent(message["content"])
		toolResults := cursorToolResultsOf(message)

		if role == "assistant" && len(toolResults) > 0 {
			hasCalls := false
			if calls, ok := message["tool_calls"].([]any); ok && len(calls) > 0 {
				hasCalls = true
			}
			if hasCalls {
				normalised = append(normalised, pending{content: content, role: role})
				normalised = append(normalised, pending{content: "", role: "assistant", toolResults: toolResults})
				continue
			}
		}
		normalised = append(normalised, pending{content: content, role: role, toolResults: toolResults})
	}

	// The tools key is absent on a plain chat request. A bare type assertion here
	// panics the whole gateway on any request that carries no tools, so the
	// presence check is load-bearing, not defensive padding.
	_, hasTools := body["tools"].([]any)

	out := make([]curChatMessage, 0, len(normalised))
	for i, entry := range normalised {
		role := curRoleAssistant
		if entry.role == "user" || entry.role == "tool" {
			role = curRoleUser
		}
		out = append(out, curChatMessage{
			Content:     entry.content,
			Role:        role,
			MessageID:   curUUID(),
			IsLast:      i == len(normalised)-1,
			HasTools:    hasTools,
			ToolResults: entry.toolResults,
		})
	}
	return out
}

// cursorTextFromContent flattens a message content value to text.
func cursorTextFromContent(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		parts := []string{}
		for _, raw := range value {
			part, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			partType, _ := part["type"].(string)
			if partType != "" && partType != "text" && partType != "input_text" {
				continue
			}
			if text, _ := part["text"].(string); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// cursorToolResultsOf extracts tool results attached to a message.
func cursorToolResultsOf(message map[string]any) []curToolResult {
	raw, has := message["tool_results"]
	if !has {
		return nil
	}
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]curToolResult, 0, len(list))
	for _, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		result := curToolResult{}
		result.ToolCallID, _ = entry["tool_call_id"].(string)
		if result.ToolCallID == "" {
			result.ToolCallID, _ = entry["id"].(string)
		}
		result.ToolName, _ = entry["tool_name"].(string)
		if result.ToolName == "" {
			result.ToolName, _ = entry["name"].(string)
		}
		result.RawArgs, _ = entry["raw_args"].(string)
		if result.RawArgs == "" {
			result.RawArgs, _ = entry["arguments"].(string)
		}
		result.Result, _ = entry["result_content"].(string)
		if result.Result == "" {
			result.Result = cursorTextFromContent(entry["content"])
		}
		if result.Result == "" {
			result.Result, _ = entry["result"].(string)
		}
		result.ToolIndex = intLoose(entry["tool_index"])
		result.ModelCallID, _ = entry["model_call_id"].(string)
		out = append(out, result)
	}
	return out
}

// cursorToolsOf reads the declared tool list.
func cursorToolsOf(body map[string]any) []map[string]any {
	raw, ok := body["tools"].([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if tool, ok := item.(map[string]any); ok {
			out = append(out, tool)
		}
	}
	return out
}

// cursorReasoningEffort reads the client's effort hint.
func cursorReasoningEffort(body map[string]any) string {
	if effort, _ := body["reasoning_effort"].(string); effort != "" {
		return effort
	}
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		if effort, _ := reasoning["effort"].(string); effort != "" {
			return effort
		}
	}
	if oc, ok := body["output_config"].(map[string]any); ok {
		if effort, _ := oc["effort"].(string); effort != "" {
			return effort
		}
	}
	return ""
}

// buildCursorChatBody assembles the framed legacy ChatService request.
func buildCursorChatBody(body map[string]any, model string, cred Credential) ([]byte, error) {
	messages := cursorChatMessages(body, model)
	if len(messages) == 0 {
		return nil, fmt.Errorf("cursor: no messages to send")
	}
	tools := cursorToolsOf(body)
	effort := cursorReasoningEffort(body)

	forceAgent := false
	if ua := strings.ToLower(cred.Extra["userAgent"]); ua != "" {
		forceAgent = strings.Contains(ua, "claude-cli") || strings.Contains(ua, "claude-code") || strings.Contains(ua, "claude code")
	}

	protobuf := encodeCursorChatRequest(messages, model, tools, effort, forceAgent)
	return connectFrame(protobuf), nil
}

// buildCursorAgentFrame assembles the opening AgentService Run frame.
func buildCursorAgentFrame(body map[string]any, model string) ([]byte, error) {
	rawMessages, _ := body["messages"].([]any)
	messages := make([]curAgentMessage, 0, len(rawMessages))
	for _, raw := range rawMessages {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		messages = append(messages, curAgentMessage{
			Role:    role,
			Content: cursorTextFromContent(message["content"]),
		})
	}
	if len(messages) == 0 {
		return nil, fmt.Errorf("cursor: no messages to send")
	}
	return buildAgentRunFrame(messages, model, cursorToolsOf(body), cursorReasoningEffort(body)), nil
}

// ── transport ────────────────────────────────────────────────────────────────

// cursorAgentTimeout bounds one AgentService stream. The duplex exchange can
// stall waiting on an ack, and an unbounded wait would hold the client's request
// open indefinitely.
const cursorAgentTimeout = 60 * time.Second

// DoStream converts a Cursor response body into SSE.
//
// The gateway sees a Cursor response as a buffered protobuf body, so this reader
// drains it, decodes every frame, and re-renders as SSE. It is lazy in the sense
// that decoding happens on first read rather than at the handoff, which keeps a
// slow client from holding decoded bytes it never asked for.
func (c *Cursor) DecodeStream(model string, body io.Reader) (io.Reader, error) {
	raw, err := io.ReadAll(body)
	if err != nil {
		return nil, fmt.Errorf("cursor: reading upstream body: %w", err)
	}
	decoded, err := decodeCursorBufferedBody(raw, model)
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(decoded), nil
}

// isJSONBody reports whether a response body looks like a JSON error rather than
// framed protobuf. Cursor answers auth failures with a JSON body and a 200.
func cursorIsJSONErrorBody(raw []byte) (map[string]any, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	var parsed map[string]any
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		return nil, false
	}
	if _, has := parsed["error"]; has {
		return parsed, true
	}
	return nil, false
}

// cursorHTTPStatusFromError maps an upstream error body to a status code.
func cursorHTTPStatusFromError(body map[string]any) int {
	if cursorIsRateLimited(body) {
		return http.StatusTooManyRequests
	}
	return http.StatusBadRequest
}

// URL helpers used by the transport selection.

func cursorAgentRunURL() string {
	return cursorAgentEndpoint() + CursorAgentRunPath
}

func cursorParseHost(rawURL string) (host string, path string, err error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", "", err
	}
	return parsed.Host, parsed.Path, nil
}

// cursorHeaderMapToHTTP converts the adapter's header map for the h2 transport.
func cursorHeaderMapToHTTP(headers map[string]string) ([]textproto.MIMEHeader, error) {
	converted := textproto.MIMEHeader{}
	for key, value := range headers {
		converted.Set(key, value)
	}
	return []textproto.MIMEHeader{converted}, nil
}

// curLittleEndian32 reads a 4-byte big-endian length. Named for symmetry with
// the frame writers; the wire order is big-endian.
func curBigEndian32(raw []byte) uint32 {
	if len(raw) < 4 {
		return 0
	}
	return binary.BigEndian.Uint32(raw)
}

// contextWithCursorTimeout applies the AgentService deadline.
func contextWithCursorTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, cursorAgentTimeout)
}

// jsonMarshalCursorError renders a JSON error body.
func jsonMarshalCursorError(message, kind string) []byte {
	raw, err := json.Marshal(map[string]any{
		"error": map[string]any{"message": message, "type": kind},
	})
	if err != nil {
		return []byte(`{"error":{"message":"cursor error"}}`)
	}
	return raw
}
