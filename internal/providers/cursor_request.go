package providers

// Cursor request encoding: two wire formats, both protobuf-in-ConnectRPC frames.
//
//  1. Legacy ChatService (aiserver.v1.ChatService/StreamUnifiedChatWithTools) —
//     the whole conversation in one request, framed once. Used for image turns,
//     which AgentService cannot carry.
//  2. AgentService (agent.v1.AgentService/Run) — a bidirectional h2 duplex
//     stream. The initial frame is AgentClientMessage.run_request; the server
//     then sends exec/kv requests that must be answered on the same stream, so
//     the request is not "sent" so much as "opened".
//
// Both live here because they share the primitive writers in cursor_pb.go.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"
)

func sortStrings(values []string) { sort.Strings(values) }

// jsonMarshalCompact marshals a decoded-JSON value without HTML escaping, so a
// schema containing "<" or "&" survives the round trip intact.
func jsonMarshalCompact(value any) (string, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

// jsonUnmarshalLoose decodes into a Go value with numbers kept as float64, which
// is what the protobuf Value encoder expects.
func jsonUnmarshalLoose(raw []byte, out *any) error {
	return json.Unmarshal(raw, out)
}

// encodeVarintBytes renders a bare varint as bytes. Several Cursor fields carry
// a varint inside a length-delimited wrapper, which is what this produces.
func encodeVarintBytes(value uint64) []byte {
	var w pbWriter
	w.varint(value)
	return w.bytes()
}

// ── legacy ChatService field numbers (open-sse/utils/cursorProtobuf.js) ───────

const (
	curFieldRequest          = 1
	curFieldMessages         = 1
	curFieldUnknown2         = 2
	curFieldInstruction      = 3
	curFieldUnknown4         = 4
	curFieldModel            = 5
	curFieldWebTool          = 8
	curFieldUnknown13        = 13
	curFieldCursorSetting    = 15
	curFieldUnknown19        = 19
	curFieldConversationID   = 23
	curFieldMetadata         = 26
	curFieldIsAgentic        = 27
	curFieldSupportedTools   = 29
	curFieldMessageIDs       = 30
	curFieldMcpTools         = 34
	curFieldLargeContext     = 35
	curFieldUnknown38        = 38
	curFieldUnifiedMode      = 46
	curFieldUnknown47        = 47
	curFieldDisableTools     = 48
	curFieldThinkingLevel    = 49
	curFieldUnknown51        = 51
	curFieldUnknown53        = 53
	curFieldUnifiedModeName  = 54
	curFieldMsgContent       = 1
	curFieldMsgRole          = 2
	curFieldMsgID            = 13
	curFieldMsgToolResults   = 18
	curFieldMsgIsAgentic     = 29
	curFieldMsgMode          = 47
	curFieldMsgSupportedTool = 51
)

const (
	curRoleUser      = 1
	curRoleAssistant = 2

	curModeChat  = 1
	curModeAgent = 2

	curThinkingUnspecified = 0
	curThinkingMedium      = 1
	curThinkingHigh        = 2
)

// curToolResultField numbers, nested inside ConversationMessage.
const (
	curToolResultCallID    = 1
	curToolResultName      = 2
	curToolResultIndex     = 3
	curToolResultRawArgs   = 5
	curToolResultResult    = 8
	curToolResultToolCall  = 11
	curToolResultModelID   = 12
	curClientResultTool    = 1
	curClientResultMcp     = 28
	curClientResultCallID  = 35
	curClientResultModelID = 48
	curClientResultToolIdx = 49
	curMcpResultTool       = 1
	curMcpResultBody       = 2
	curClientCallTool      = 1
	curClientCallMcpParams = 27
	curClientCallID        = 3
	curClientCallName      = 9
	curClientCallRawArgs   = 10
	curClientCallToolIndex = 48
	curClientCallModelID   = 49
	curMcpParamsTools      = 1
	curMcpToolName         = 1
	curMcpToolDesc         = 2
	curMcpToolParams       = 3
	curMcpToolServer       = 4
	curModelName           = 1
	curModelEmpty          = 4
	curSettingPath         = 1
	curSettingUnknown3     = 3
	curSettingUnknown6     = 6
	curSettingUnknown8     = 8
	curSettingUnknown9     = 9
	curSetting6Field1      = 1
	curSetting6Field2      = 2
	curMetaPlatform        = 1
	curMetaArch            = 2
	curMetaVersion         = 3
	curMetaCwd             = 4
	curMetaTimestamp       = 5
	curMsgIDID             = 1
	curMsgIDSummary        = 2
	curMsgIDRole           = 3
	curClientSideToolMCP   = 19
)

// curToolNamePrefix is Cursor's own MCP naming scheme: a bare tool name becomes
// mcp_custom_<name>. Getting this wrong makes the upstream reject the tool spec.
const curToolNamePrefix = "mcp_custom_"

// curFormatToolName applies Cursor's MCP naming scheme.
//
// "mcp__server__tool" becomes "mcp_server_tool", an existing "mcp_…" name passes
// through, and anything else is prefixed. The server segment is preserved so the
// upstream can route to the right MCP server.
func curFormatToolName(name string) string {
	base := strings.TrimSpace(name)
	if base == "" {
		base = "tool"
	}
	if strings.HasPrefix(base, "mcp__") {
		rest := strings.TrimPrefix(base, "mcp__")
		if idx := strings.Index(rest, "__"); idx >= 0 {
			server := rest[:idx]
			tool := rest[idx+2:]
			if server == "" {
				server = "custom"
			}
			if tool == "" {
				tool = "tool"
			}
			return "mcp_" + server + "_" + tool
		}
		if rest == "" {
			rest = "tool"
		}
		return "mcp_custom_" + rest
	}
	if strings.HasPrefix(base, "mcp_") {
		return base
	}
	return curToolNamePrefix + base
}

// curParseToolName splits a formatted name back into (server, tool).
func curParseToolName(formatted string) (server string, tool string) {
	if !strings.HasPrefix(formatted, "mcp_") {
		if formatted == "" {
			return "custom", "tool"
		}
		return "custom", formatted
	}
	tail := strings.TrimPrefix(formatted, "mcp_")
	idx := strings.Index(tail, "_")
	if idx < 0 {
		if tail == "" {
			return "custom", "tool"
		}
		return "custom", tail
	}
	server = tail[:idx]
	tool = tail[idx+1:]
	if server == "" {
		server = "custom"
	}
	if tool == "" {
		tool = "tool"
	}
	return server, tool
}

// curParseToolID splits a Cursor tool-call id into its tool id and model id.
// Cursor joins them with a literal "\nmc_" delimiter.
func curParseToolID(id string) (toolCallID, modelCallID string) {
	const delimiter = "\nmc_"
	if idx := strings.Index(id, delimiter); idx >= 0 {
		return id[:idx], id[idx+len(delimiter):]
	}
	return id, ""
}

// ── agent.v1 field numbers (open-sse/executors/cursor.js) ────────────────────

const (
	agentFieldRunRequest     = 1
	agentFieldExecResult     = 2
	agentFieldKvResult       = 3
	agentRunFieldState       = 1
	agentRunFieldAction      = 2
	agentRunFieldModelDetail = 3
	agentRunFieldMcpTools    = 4
	agentRunFieldRequested   = 9

	agentUserActionFieldUser    = 1
	agentUserActionFieldHistory = 7

	agentUserMsgFieldText    = 1
	agentUserMsgFieldUUID    = 2
	agentUserMsgFieldContext = 3
	agentUserMsgFieldMode    = 4
	agentHistoryFieldEntry   = 1
	agentHistoryMsgFieldText = 1
	agentHistoryMsgFieldRole = 2

	agentRequestedModelFieldName  = 1
	agentRequestedModelFieldParam = 3
	agentRequestedModelFieldFlags = 7
	agentParamFieldKey            = 1
	agentParamFieldValue          = 2

	agentModelDetailFieldName    = 1
	agentModelDetailFieldVariant = 3
	agentModelDetailFieldAlt     = 4

	agentExecMsgFieldID      = 1
	agentExecMsgFieldExecID  = 15
	agentExecRequestCtxField = 10
	agentExecMcpArgsField    = 11
	agentRequestCtxSuccess   = 1

	agentKvMsgFieldID     = 1
	agentKvMsgFieldGet    = 2
	agentKvMsgFieldSet    = 3
	agentKvMsgFieldMeta   = 4
	agentKvResultFieldOK  = 1
	agentKvResultFieldVal = 2
	agentKvResultFieldAck = 3

	agentMcpToolDefFieldName   = 1
	agentMcpToolDefFieldDesc   = 2
	agentMcpToolDefFieldSchema = 3
	agentMcpToolDefFieldProv   = 4
	agentMcpToolDefFieldTool   = 5
	agentMcpToolListFieldTool  = 1

	agentMcpArgsFieldName     = 1
	agentMcpArgsFieldEntry    = 2
	agentMcpArgsFieldCallID   = 3
	agentMcpArgsFieldToolName = 5

	agentToolMsgFieldCall        = 1
	agentToolMsgFieldResponse    = 2
	agentToolMsgFieldResponseTxt = 1
	agentToolMsgFieldThinking    = 25
	agentToolMsgFieldThinkingTxt = 1
	agentToolCallFieldID         = 3
	agentToolCallFieldName       = 9
	agentToolCallFieldArgs       = 10
	agentToolCallFieldIsLast     = 11
	agentToolCallFieldMcp        = 27

	agentUpdateFieldTextDelta     = 1
	agentUpdateFieldThinkingDelta = 4
	agentUpdateFieldTurnDone      = 14
	agentDeltaFieldText           = 1

	agentExecVariantRequestCtx  = 10
	agentExecVariantMcpArgs     = 11
	agentExecVariantDiagnostics = 9
	agentExecVariantRejected    = 2

	agentMcpResultFieldSuccess      = 1
	agentMcpResultFieldError        = 2
	agentMcpResultFieldToolNotFound = 5
	agentMcpSuccessFieldContent     = 1
	agentMcpSuccessFieldIsError     = 2
	agentMcpContentFieldText        = 1
	agentMcpContentFieldImage       = 2
	agentMcpTextFieldText           = 1
	agentMcpImageFieldData          = 1
	agentMcpImageFieldMime          = 2
	agentMcpErrorFieldMessage       = 1
	agentMcpNotFoundFieldName       = 1

	agentServerFieldUpdate = 1
	agentServerFieldExec   = 2
	agentServerFieldKv     = 4

	agentProviderLabel = "9router"
)

// curHex32 is a 32-character lowercase hex token, used for message ids and the
// machine id fallback.
func curHex32() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// A crypto failure must not produce a predictable id; fall back to a
		// time-derived value rather than an all-zero one.
		now := time.Now().UnixNano()
		for i := range raw {
			raw[i] = byte(now >> (8 * (i % 8)))
		}
	}
	return hex.EncodeToString(raw[:])
}

// curUUID returns an RFC-4122 v4 identifier.
func curUUID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		now := time.Now().UnixNano()
		for i := range raw {
			raw[i] = byte(now >> (8 * (i % 8)))
		}
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

// curMachineID derives the machine id from the token when the credential does
// not carry one. Cursor stores this per install; the derived value keeps the
// checksum stable across requests from the same account.
func curMachineID(token string) string {
	sum := sha256.Sum256([]byte(token + "machineId"))
	return hex.EncodeToString(sum[:])
}

// curHashedHex is SHA-256 hex of input+salt, matching the Node helper.
func curHashedHex(input, salt string) string {
	sum := sha256.Sum256([]byte(input + salt))
	return hex.EncodeToString(sum[:])
}

// ── legacy ChatService request ───────────────────────────────────────────────

// curChatMessage is one turn after normalisation.
type curChatMessage struct {
	Content     string
	Role        int
	MessageID   string
	IsLast      bool
	HasTools    bool
	ToolResults []curToolResult
}

// curToolResult is a tool outcome attached to an assistant turn.
type curToolResult struct {
	ToolCallID  string
	ToolName    string
	RawArgs     string
	Result      string
	ToolIndex   int
	ModelCallID string
	ServerName  string
	Selected    string
}

// encodeCursorChatRequest builds the legacy StreamUnifiedChatWithTools body.
//
// The conversation arrives already normalised by translate: mixed assistant
// turns (tool calls and results in one message) are split before this point,
// because Cursor's encoder rejects a message carrying both.
func encodeCursorChatRequest(messages []curChatMessage, modelName string, tools []map[string]any, reasoningEffort string, forceAgentMode bool) []byte {
	hasTools := len(tools) > 0
	isAgentic := hasTools || forceAgentMode

	var body pbWriter

	for _, msg := range messages {
		var m pbWriter
		m.fieldString(curFieldMsgContent, msg.Content)
		m.fieldVarint(curFieldMsgRole, uint64(msg.Role))
		m.fieldString(curFieldMsgID, msg.MessageID)
		for _, tr := range msg.ToolResults {
			m.fieldBytes(curFieldMsgToolResults, encodeCursorToolResult(tr))
		}
		if msg.HasTools {
			m.fieldVarint(curFieldMsgIsAgentic, 1)
			m.fieldVarint(curFieldMsgMode, curModeAgent)
		} else {
			m.fieldVarint(curFieldMsgIsAgentic, 0)
			m.fieldVarint(curFieldMsgMode, curModeChat)
		}
		if msg.IsLast && msg.HasTools {
			m.fieldBytes(curFieldMsgSupportedTool, encodeVarintBytes(1))
		}
		body.fieldMessage(curFieldMessages, &m)
	}

	body.fieldVarint(curFieldUnknown2, 1)

	var instr pbWriter
	if false {
		instr.fieldString(1, "")
	}
	body.fieldBytes(curFieldInstruction, instr.bytes())

	body.fieldVarint(curFieldUnknown4, 1)

	var model pbWriter
	model.fieldString(curModelName, modelName)
	model.fieldBytes(curModelEmpty, nil)
	body.fieldMessage(curFieldModel, &model)

	body.fieldString(curFieldWebTool, "")
	body.fieldVarint(curFieldUnknown13, 1)
	body.fieldBytes(curFieldCursorSetting, encodeCursorSetting())
	body.fieldVarint(curFieldUnknown19, 1)
	body.fieldString(curFieldConversationID, curUUID())
	body.fieldBytes(curFieldMetadata, encodeCursorMetadata())

	if isAgentic {
		body.fieldVarint(curFieldIsAgentic, 1)
		body.fieldBytes(curFieldSupportedTools, encodeVarintBytes(1))
	} else {
		body.fieldVarint(curFieldIsAgentic, 0)
	}

	for _, msg := range messages {
		var mid pbWriter
		mid.fieldString(curMsgIDID, msg.MessageID)
		mid.fieldVarint(curMsgIDRole, uint64(msg.Role))
		body.fieldMessage(curFieldMessageIDs, &mid)
	}

	for _, tool := range tools {
		body.fieldBytes(curFieldMcpTools, encodeCursorMcpTool(tool))
	}

	body.fieldVarint(curFieldLargeContext, 0)
	body.fieldVarint(curFieldUnknown38, 0)
	if isAgentic {
		body.fieldVarint(curFieldUnifiedMode, curModeAgent)
	} else {
		body.fieldVarint(curFieldUnifiedMode, curModeChat)
	}
	body.fieldString(curFieldUnknown47, "")
	if isAgentic {
		body.fieldVarint(curFieldDisableTools, 0)
	} else {
		body.fieldVarint(curFieldDisableTools, 1)
	}
	body.fieldVarint(curFieldThinkingLevel, uint64(cursorThinkingLevel(reasoningEffort)))
	body.fieldVarint(curFieldUnknown51, 0)
	body.fieldVarint(curFieldUnknown53, 1)
	if isAgentic {
		body.fieldString(curFieldUnifiedModeName, "Agent")
	} else {
		body.fieldString(curFieldUnifiedModeName, "Ask")
	}

	// StreamUnifiedChatRequestWithTools.request = 1
	var outer pbWriter
	outer.fieldBytes(curFieldRequest, body.bytes())
	return outer.bytes()
}

func cursorThinkingLevel(effort string) int {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case "medium":
		return curThinkingMedium
	case "high":
		return curThinkingHigh
	}
	return curThinkingUnspecified
}

func encodeCursorSetting() []byte {
	var u6 pbWriter
	u6.fieldBytes(curSetting6Field1, nil)
	u6.fieldBytes(curSetting6Field2, nil)

	var s pbWriter
	s.fieldString(curSettingPath, `cursor\aisettings`)
	s.fieldBytes(curSettingUnknown3, nil)
	s.fieldBytes(curSettingUnknown6, u6.bytes())
	s.fieldVarint(curSettingUnknown8, 1)
	s.fieldVarint(curSettingUnknown9, 1)
	return s.bytes()
}

func encodeCursorMetadata() []byte {
	platform := runtime.GOOS
	switch platform {
	case "windows", "darwin", "linux":
	default:
		platform = "linux"
	}
	arch := runtime.GOARCH
	if arch == "arm64" {
		arch = "aarch64"
	} else if arch == "amd64" {
		arch = "x64"
	}

	var m pbWriter
	m.fieldString(curMetaPlatform, platform)
	m.fieldString(curMetaArch, arch)
	m.fieldString(curMetaVersion, "v20.0.0")
	wd, err := os.Getwd()
	if err != nil {
		wd = "/"
	}
	m.fieldString(curMetaCwd, wd)
	m.fieldString(curMetaTimestamp, time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	return m.bytes()
}

func encodeCursorMcpTool(tool map[string]any) []byte {
	name, description, schema := cursorToolShape(tool)

	var t pbWriter
	if name != "" {
		t.fieldString(curMcpToolName, name)
	}
	if description != "" {
		t.fieldString(curMcpToolDesc, description)
	}
	if len(schema) > 0 {
		t.fieldString(curMcpToolParams, string(schema))
	}
	t.fieldString(curMcpToolServer, "custom")
	return t.bytes()
}

// cursorToolShape normalises an OpenAI- or Claude-shaped tool definition.
func cursorToolShape(tool map[string]any) (name, description string, schema []byte) {
	fn := tool
	if nested, ok := tool["function"].(map[string]any); ok {
		fn = nested
	}
	name, _ = fn["name"].(string)
	if name == "" {
		name, _ = tool["name"].(string)
	}
	description, _ = fn["description"].(string)
	if description == "" {
		description, _ = tool["description"].(string)
	}
	for _, key := range []string{"parameters", "inputSchema", "input_schema"} {
		raw, has := fn[key]
		if !has {
			raw, has = tool[key]
		}
		if !has {
			continue
		}
		if encoded, err := jsonMarshalCompact(raw); err == nil && encoded != "" && encoded != "{}" && encoded != "null" {
			schema = []byte(encoded)
			break
		}
	}
	return name, description, schema
}

func encodeCursorToolResult(tr curToolResult) []byte {
	toolName := curFormatToolName(tr.ToolName)
	toolCallID, modelCallID := curParseToolID(tr.ToolCallID)
	if tr.ModelCallID != "" {
		modelCallID = tr.ModelCallID
	}
	index := tr.ToolIndex
	if index <= 0 {
		index = 1
	}
	rawArgs := tr.RawArgs
	if rawArgs == "" {
		rawArgs = "{}"
	}
	server, selected := curParseToolName(toolName)
	if tr.ServerName != "" {
		server = tr.ServerName
	}
	if tr.Selected != "" {
		selected = tr.Selected
	}

	var out pbWriter
	out.fieldString(curToolResultCallID, toolCallID)
	out.fieldString(curToolResultName, toolName)
	out.fieldVarint(curToolResultIndex, uint64(index))
	if modelCallID != "" {
		out.fieldString(curToolResultModelID, modelCallID)
	}
	out.fieldString(curToolResultRawArgs, rawArgs)

	// result = ClientSideToolV2Result { tool, mcp_result, call_id, model_call_id, tool_index }
	var cv2r pbWriter
	cv2r.fieldVarint(curClientResultTool, curClientSideToolMCP)

	var mcpResult pbWriter
	mcpResult.fieldString(curMcpResultTool, selected)
	mcpResult.fieldString(curMcpResultBody, tr.Result)
	cv2r.fieldMessage(curClientResultMcp, &mcpResult)

	cv2r.fieldString(curClientResultCallID, toolCallID)
	if modelCallID != "" {
		cv2r.fieldString(curClientResultModelID, modelCallID)
	}
	cv2r.fieldVarint(curClientResultToolIdx, uint64(index))
	out.fieldMessage(curToolResultResult, &cv2r)

	// tool_call = ClientSideToolV2Call { tool, mcp_params, call_id, name, raw_args, tool_index }
	var call pbWriter
	call.fieldVarint(curClientCallTool, curClientSideToolMCP)
	call.fieldBytes(curClientCallMcpParams, encodeCursorMcpParamsForCall(selected, rawArgs, server))
	call.fieldString(curClientCallID, toolCallID)
	call.fieldString(curClientCallName, toolName)
	call.fieldString(curClientCallRawArgs, rawArgs)
	call.fieldVarint(curClientCallToolIndex, uint64(index))
	if modelCallID != "" {
		call.fieldString(curClientCallModelID, modelCallID)
	}
	out.fieldMessage(curToolResultToolCall, &call)

	return out.bytes()
}

func encodeCursorMcpParamsForCall(toolName, rawArgs, serverName string) []byte {
	var tool pbWriter
	tool.fieldString(curMcpToolName, toolName)
	tool.fieldString(curMcpToolParams, rawArgs)
	tool.fieldString(curMcpToolServer, serverName)

	var list pbWriter
	list.fieldMessage(curMcpParamsTools, &tool)
	return list.bytes()
}

// encodeCursorToolResultFrame builds the standalone client_side_tool_v2_result
// frame (StreamUnifiedChatRequestWithTools field 2), which is sent as its own
// request rather than folded into the conversation.
//
// tool_index is deliberately absent here: the Rust reference client omits it on
// this path, and sending it produces a schema mismatch.
func encodeCursorToolResultFrame(toolCallID, toolName, resultContent string) []byte {
	toolID, modelID := curParseToolID(toolCallID)
	selected := toolName
	if strings.HasPrefix(selected, curToolNamePrefix) {
		selected = strings.TrimPrefix(selected, curToolNamePrefix)
	} else if strings.HasPrefix(selected, "mcp_") {
		selected = strings.TrimPrefix(selected, "mcp_")
	}

	var cv2 pbWriter
	cv2.fieldVarint(curClientResultTool, curClientSideToolMCP)

	var mcp pbWriter
	mcp.fieldString(curMcpResultTool, selected)
	mcp.fieldString(curMcpResultBody, resultContent)
	cv2.fieldMessage(curClientResultMcp, &mcp)

	cv2.fieldString(curClientResultCallID, toolID)
	if modelID != "" {
		cv2.fieldString(curClientResultModelID, modelID)
	}

	var outer pbWriter
	outer.fieldMessage(2, &cv2)
	return outer.bytes()
}

// ── AgentService request ─────────────────────────────────────────────────────
//
// AgentService is a duplex stream: the client opens a Run and then answers
// server-initiated exec and kv messages on the same stream. These builders cover
// both directions.

// curAgentMessage is a normalised turn for the AgentService history.
type curAgentMessage struct {
	Role    string
	Content string
}

// buildAgentRunFrame builds the opening AgentClientMessage.run_request frame.
//
// The system prompt is folded into the current user message rather than sent as
// custom_system_prompt (RunRequest field 8): setting that field makes
// AgentService return an empty turn.
func buildAgentRunFrame(messages []curAgentMessage, model string, tools []map[string]any, reasoningEffort string) []byte {
	systemParts := []string{}
	chat := []curAgentMessage{}
	for _, msg := range messages {
		if msg.Role == "system" {
			if text := strings.TrimSpace(msg.Content); text != "" {
				systemParts = append(systemParts, text)
			}
			continue
		}
		chat = append(chat, msg)
	}

	currentIndex := -1
	for i := len(chat) - 1; i >= 0; i-- {
		if chat[i].Role == "user" {
			currentIndex = i
			break
		}
	}
	var current curAgentMessage
	var historySource []curAgentMessage
	if currentIndex >= 0 {
		current = chat[currentIndex]
		historySource = chat[:currentIndex]
	} else if len(chat) > 0 {
		current = chat[len(chat)-1]
		historySource = chat[:len(chat)-1]
	} else {
		current = curAgentMessage{Role: "user", Content: "Continue."}
	}

	rawUser := strings.TrimSpace(current.Content)
	if rawUser == "" {
		rawUser = "Continue."
	}
	userText := rawUser
	if len(systemParts) > 0 {
		userText = strings.Join(systemParts, "\n\n") + "\n\n" + rawUser
	}

	// UserMessageAction.user_message { text, uuid, selected_context, mode }
	var userMessage pbWriter
	userMessage.fieldString(agentUserMsgFieldText, userText)
	userMessage.fieldString(agentUserMsgFieldUUID, curUUID())
	userMessage.fieldBytes(agentUserMsgFieldContext, nil)
	userMessage.fieldVarint(agentUserMsgFieldMode, 1)

	var userAction pbWriter
	userAction.fieldMessage(agentUserActionFieldUser, &userMessage)

	if len(historySource) > 0 {
		var history pbWriter
		for _, msg := range historySource {
			entry, ok := encodeAgentHistoryMessage(msg)
			if !ok {
				continue
			}
			history.fieldBytes(agentHistoryFieldEntry, entry)
		}
		userAction.fieldMessage(agentUserActionFieldHistory, &history)
	}

	var conversationAction pbWriter
	conversationAction.fieldMessage(1, &userAction)

	// RequestedModel { name, flags(7)=true, parameter{key, value} }
	var requestedModel pbWriter
	requestedModel.fieldString(agentRequestedModelFieldName, model)
	requestedModel.fieldVarint(agentRequestedModelFieldFlags, 1)

	effort := strings.ToLower(strings.TrimSpace(reasoningEffort))
	switch effort {
	case "ultra":
		effort = "max"
	case "minimal":
		effort = "low"
	}
	if effort != "" && effort != "none" {
		key := "effort"
		if strings.Contains(strings.ToLower(model), "gpt-") {
			key = "reasoning"
		}
		var parameter pbWriter
		parameter.fieldString(agentParamFieldKey, key)
		parameter.fieldString(agentParamFieldValue, effort)
		requestedModel.fieldMessage(agentRequestedModelFieldParam, &parameter)
	}

	// ModelDetails — thinking variants return an empty turn with only field 9.
	var modelDetails pbWriter
	modelDetails.fieldString(agentModelDetailFieldName, model)
	modelDetails.fieldString(agentModelDetailFieldVariant, model)
	modelDetails.fieldString(agentModelDetailFieldAlt, model)

	// RunRequest: an empty field 1 opens a fresh local agent session.
	var runRequest pbWriter
	runRequest.fieldBytes(agentRunFieldState, nil)
	runRequest.fieldMessage(agentRunFieldAction, &conversationAction)
	runRequest.fieldMessage(agentRunFieldModelDetail, &modelDetails)
	if mcpTools := encodeAgentMcpTools(tools); len(mcpTools) > 0 {
		runRequest.fieldBytes(agentRunFieldMcpTools, mcpTools)
	}
	runRequest.fieldMessage(agentRunFieldRequested, &requestedModel)

	var client pbWriter
	client.fieldBytes(agentFieldRunRequest, runRequest.bytes())
	return connectFrame(client.bytes())
}

// encodeAgentHistoryMessage encodes one prior turn.
//
// Tool call and tool result text is inlined as bracketed markers because the
// AgentService history shape carries only text; the structured tool path is the
// MCP exec stream.
func encodeAgentHistoryMessage(msg curAgentMessage) ([]byte, bool) {
	textBody := strings.TrimSpace(msg.Content)
	if textBody == "" {
		return nil, false
	}
	var text pbWriter
	text.fieldString(agentHistoryMsgFieldText, textBody)

	var inner pbWriter
	inner.fieldMessage(agentHistoryMsgFieldText, &text)

	var roleWrapper pbWriter
	if msg.Role == "assistant" {
		roleWrapper.fieldMessage(agentHistoryMsgFieldRole, &inner)
	} else {
		roleWrapper.fieldMessage(agentHistoryMsgFieldRole, &inner)
	}
	return roleWrapper.bytes(), true
}

// encodeAgentMcpTools encodes AgentRunRequest.mcp_tools: repeated
// McpToolDefinition under field 1.
func encodeAgentMcpTools(tools []map[string]any) []byte {
	if len(tools) == 0 {
		return nil
	}
	var list pbWriter
	for _, tool := range tools {
		name, description, schema := cursorToolShape(tool)
		var def pbWriter
		def.fieldString(agentMcpToolDefFieldName, name)
		def.fieldString(agentMcpToolDefFieldDesc, description)
		var schemaValue any = map[string]any{}
		if schema != nil {
			var decoded any
			if err := jsonUnmarshalLoose(schema, &decoded); err == nil && decoded != nil {
				schemaValue = decoded
			}
		}
		def.fieldBytes(agentMcpToolDefFieldSchema, encodeProtoValue(schemaValue))
		def.fieldString(agentMcpToolDefFieldProv, agentProviderLabel)
		def.fieldString(agentMcpToolDefFieldTool, name)
		list.fieldMessage(agentMcpToolListFieldTool, &def)
	}
	return list.bytes()
}

// encodeAgentExecMessage wraps an ExecClientMessage result.
func encodeAgentExecMessage(execMsgID uint64, execID string, resultField int, payload []byte) []byte {
	parts := []byte{}
	if execMsgID != 0 {
		var idWriter pbWriter
		idWriter.fieldVarint(agentExecMsgFieldID, execMsgID)
		parts = append(parts, idWriter.bytes()...)
	}
	var execWriter pbWriter
	execWriter.fieldString(agentExecMsgFieldExecID, execID)
	parts = append(parts, execWriter.bytes()...)

	var resultWriter pbWriter
	resultWriter.fieldBytes(resultField, payload)
	parts = append(parts, resultWriter.bytes()...)

	var client pbWriter
	client.fieldBytes(agentFieldExecResult, parts)
	return connectFrame(client.bytes())
}

// encodeAgentKvMessage wraps a KvClientMessage result.
func encodeAgentKvMessage(kvID uint64, resultField int, payload []byte, metadata []byte) []byte {
	parts := []byte{}
	if kvID != 0 {
		var idWriter pbWriter
		idWriter.fieldVarint(agentKvMsgFieldID, kvID)
		parts = append(parts, idWriter.bytes()...)
	}
	var resultWriter pbWriter
	resultWriter.fieldBytes(resultField, payload)
	parts = append(parts, resultWriter.bytes()...)
	if len(metadata) > 0 {
		var metaWriter pbWriter
		metaWriter.fieldBytes(agentKvMsgFieldMeta, metadata)
		parts = append(parts, metaWriter.bytes()...)
	}

	var client pbWriter
	client.fieldBytes(agentFieldKvResult, parts)
	return connectFrame(client.bytes())
}

// curAgentExecIDs reads the exec id pair from an ExecServerMessage.
func curAgentExecIDs(execFields map[int][]pbField) (id uint64, execID string) {
	id = pbFirstVarint(execFields, agentExecMsgFieldID)
	execID = pbFirstString(execFields, agentExecMsgFieldExecID)
	return id, execID
}

// agentExecResultField maps an ExecServerMessage variant to the matching result
// field. The numbering is shared between the two messages.
var agentExecResultField = map[int]int{
	2: 2, 3: 3, 4: 4, 5: 5, 7: 7, 8: 8, 9: 9, 16: 16, 20: 20, 23: 23,
}

// encodeAgentRequestContextAck answers the IDE-context probe.
//
// Tools already travel on AgentRunRequest.mcp_tools. Echoing them here makes
// AgentService stall silently — zero bytes until the client aborts — so the ack
// is an empty success and nothing more.
func encodeAgentRequestContextAck(execFields map[int][]pbField) []byte {
	id, execID := curAgentExecIDs(execFields)

	var success pbWriter
	success.fieldBytes(agentRequestCtxSuccess, nil)

	var result pbWriter
	result.fieldMessage(agentRequestCtxSuccess, &success)

	return encodeAgentExecMessage(id, execID, agentExecVariantRequestCtx, result.bytes())
}

// encodeAgentExecRejection refuses an IDE builtin so the model can continue with
// MCP tools or a plain text answer instead of stalling the stream.
func encodeAgentExecRejection(execFields map[int][]pbField) []byte {
	id, execID := curAgentExecIDs(execFields)

	variant := 0
	for field := range execFields {
		if field == agentExecMsgFieldID || field == agentExecMsgFieldExecID {
			continue
		}
		variant = field
		break
	}
	resultField, known := agentExecResultField[variant]
	if !known {
		return nil
	}
	// Diagnostics has no rejected variant; an empty success unblocks the stream.
	if variant == agentExecVariantDiagnostics {
		return encodeAgentExecMessage(id, execID, agentExecVariantDiagnostics, nil)
	}

	var rejected pbWriter
	rejected.fieldString(agentExecVariantRejected, "Tool not available in this environment. Use the MCP tools provided instead.")
	return encodeAgentExecMessage(id, execID, resultField, rejected.bytes())
}

// decodeAgentMcpArgs decodes agent.v1.McpArgs.
func decodeAgentMcpArgs(b []byte) (name, toolCallID, toolName string, args map[string]any, err error) {
	fields, err := pbMessage(b)
	if err != nil {
		return "", "", "", nil, err
	}
	args = map[string]any{}
	for _, entry := range fields[agentMcpArgsFieldEntry] {
		pair, pairErr := pbMessage(entry.Bytes)
		if pairErr != nil {
			return "", "", "", nil, pairErr
		}
		key := pbFirstString(pair, pbMapKey)
		if key == "" {
			continue
		}
		value, valueErr := decodeProtoValue(pbFirstBytes(pair, pbMapValue))
		if valueErr != nil {
			return "", "", "", nil, valueErr
		}
		args[key] = value
	}
	return pbFirstString(fields, agentMcpArgsFieldName),
		pbFirstString(fields, agentMcpArgsFieldCallID),
		pbFirstString(fields, agentMcpArgsFieldToolName),
		args, nil
}

// encodeAgentToolCallResponse unwraps the legacy ClientSideToolV2Call variant
// into the fields the gateway needs.
func decodeAgentToolCall(b []byte) (id, name, rawArgs string) {
	fields, err := pbMessage(b)
	if err != nil {
		return "", "", ""
	}
	fullID := pbFirstString(fields, agentToolCallFieldID)
	if idx := strings.Index(fullID, "\n"); idx >= 0 {
		fullID = fullID[:idx]
	}
	name = pbFirstString(fields, agentToolCallFieldName)
	rawArgs = pbFirstString(fields, agentToolCallFieldArgs)

	if mcpParams := pbFirstBytes(fields, agentToolCallFieldMcp); mcpParams != nil {
		if list, err := pbMessage(mcpParams); err == nil {
			if toolBytes := pbFirstBytes(list, curMcpParamsTools); toolBytes != nil {
				if tool, err := pbMessage(toolBytes); err == nil {
					if nested := pbFirstString(tool, curMcpToolName); nested != "" {
						name = nested
					}
					if params := pbFirstString(tool, curMcpToolParams); params != "" {
						rawArgs = params
					}
				}
			}
		}
	}
	return fullID, name, rawArgs
}

// encodeAgentToolText / encodeAgentToolImage build MCP result content items.
func encodeAgentToolText(text string) []byte {
	var leaf pbWriter
	leaf.fieldString(agentMcpTextFieldText, text)

	var item pbWriter
	item.fieldMessage(agentMcpContentFieldText, &leaf)

	var content pbWriter
	content.fieldMessage(agentMcpSuccessFieldContent, &item)
	return content.bytes()
}
