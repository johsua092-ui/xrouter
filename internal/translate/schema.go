// Package translate is the Go port of open-sse/translator.
//
// The Node translator is a hub: every request is normalised to OpenAI's chat
// shape, converted to the target provider's dialect, sent, and the response is
// converted back. Translation is registered per `from:to` pair, and a direct
// pair wins when one exists (claude→kiro avoids the claude→openai→kiro hop).
//
// This package reproduces that structure. The enums below are copied verbatim
// from open-sse/translator/schema because they are wire identifiers: a typo in
// "input_json_delta" is not a compile error in JavaScript, it is a client that
// silently stops rendering tool arguments. Keeping them as named constants means
// the same typo here fails the build instead.
package translate

// Format identifies a wire dialect. Values are the exact strings the Node side
// uses for FORMATS, so a registry key computed here matches one computed there.
type Format string

// The dialects the gateway translates between.
const (
	FormatOpenAI          Format = "openai"
	FormatOpenAIResponses Format = "openai-responses"
	FormatOpenAIResponse  Format = "openai-response"
	FormatClaude          Format = "claude"
	FormatGemini          Format = "gemini"
	FormatGeminiCLI       Format = "gemini-cli"
	FormatVertex          Format = "vertex"
	FormatCodex           Format = "codex"
	FormatAntigravity     Format = "antigravity"
	FormatKiro            Format = "kiro"
	FormatCursor          Format = "cursor"
	FormatOllama          Format = "ollama"
	FormatCommandCode     Format = "commandcode"
)

// Role is the message author. OpenAI chat and Claude share these values; the
// mapping between them lives in the translators.
type Role string

// Message roles.
const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
	RoleSystem    Role = "system"
	RoleDeveloper Role = "developer"
)

// GeminiRole is the subset Gemini and Antigravity accept. Gemini says "model"
// where everyone else says "assistant".
type GeminiRole string

// Gemini message roles.
const (
	GeminiUser  GeminiRole = "user"
	GeminiModel GeminiRole = "model"
)

// OpenAI content-block type discriminators, plus the tool_call wrapper.
const (
	OpenAIText       = "text"
	OpenAIImageURL   = "image_url"
	OpenAIImage      = "image"
	OpenAIInputAudio = "input_audio"
	OpenAIAudioURL   = "audio_url"
	OpenAIFile       = "file"
	OpenAIFunction   = "function"
)

// Claude content-block type discriminators.
const (
	ClaudeText                = "text"
	ClaudeImage               = "image"
	ClaudeDocument            = "document"
	ClaudeToolUse             = "tool_use"
	ClaudeToolResult          = "tool_result"
	ClaudeThinking            = "thinking"
	ClaudeRedactedThinking    = "redacted_thinking"
	ClaudeServerToolUse       = "server_tool_use"
	ClaudeWebSearchToolResult = "web_search_tool_result"
)

// OpenAI Responses API item types.
const (
	ResponsesMessage            = "message"
	ResponsesFunctionCall       = "function_call"
	ResponsesFunctionCallOutput = "function_call_output"
	ResponsesCustomToolCall     = "custom_tool_call"
	ResponsesCustomToolCallOut  = "custom_tool_call_output"
	ResponsesAdditionalTools    = "additional_tools"
	ResponsesReasoning          = "reasoning"
	ResponsesOutputText         = "output_text"
	ResponsesInputText          = "input_text"
	ResponsesInputImage         = "input_image"
	ResponsesSummaryText        = "summary_text"
)

// Claude streaming event names — the `type` field of each SSE frame.
const (
	ClaudeEventMessageStart      = "message_start"
	ClaudeEventMessageDelta      = "message_delta"
	ClaudeEventMessageStop       = "message_stop"
	ClaudeEventContentBlockStart = "content_block_start"
	ClaudeEventContentBlockDelta = "content_block_delta"
	ClaudeEventContentBlockStop  = "content_block_stop"
	ClaudeEventPing              = "ping"
	ClaudeEventError             = "error"
)

// Claude content_block_delta discriminators.
const (
	ClaudeDeltaText      = "text_delta"
	ClaudeDeltaThinking  = "thinking_delta"
	ClaudeDeltaInputJSON = "input_json_delta"
	ClaudeDeltaSignature = "signature_delta"
)

// OpenAI Responses API streaming event names.
const (
	ResponsesEventCreated                   = "response.created"
	ResponsesEventOutputItemAdded           = "response.output_item.added"
	ResponsesEventOutputTextDelta           = "response.output_text.delta"
	ResponsesEventReasoningSummaryTextDelta = "response.reasoning_summary_text.delta"
	ResponsesEventReasoningTextDelta        = "response.reasoning_text.delta"
	ResponsesEventFunctionCallArgsDelta     = "response.function_call_arguments.delta"
	ResponsesEventOutputItemDone            = "response.output_item.done"
	ResponsesEventCompleted                 = "response.completed"
	ResponsesEventFailed                    = "response.failed"
	ResponsesEventDone                      = "response.done"
)

// OpenAI finish_reason values — the hub format.
const (
	FinishStop          = "stop"
	FinishLength        = "length"
	FinishToolCalls     = "tool_calls"
	FinishContentFilter = "content_filter"
)

// Claude stop_reason values.
const (
	ClaudeStopEndTurn      = "end_turn"
	ClaudeStopMaxTokens    = "max_tokens"
	ClaudeStopToolUse      = "tool_use"
	ClaudeStopStopSequence = "stop_sequence"
	// ClaudeStopRefusal is Anthropic's API-level refusal — it arrives in
	// message_delta with zero output tokens and stop_details carrying the reason.
	ClaudeStopRefusal = "refusal"
)

// Gemini finishReason values.
const (
	GeminiFinishStop              = "STOP"
	GeminiFinishMaxTokens         = "MAX_TOKENS"
	GeminiFinishSafety            = "SAFETY"
	GeminiFinishRecitation        = "RECITATION"
	GeminiFinishBlocklist         = "BLOCKLIST"
	GeminiFinishProhibitedContent = "PROHIBITED_CONTENT"
)

// Shared translator defaults.
const (
	// ModelFallback is the model id used when an upstream chunk omits one.
	ModelFallback = "unknown"
	// DefaultImageMIME covers base64 blobs sent without a declared type.
	DefaultImageMIME = "image/png"
)

// validOpenAIContentTypes is the allow-list filterToOpenAIFormat keeps.
var validOpenAIContentTypes = map[string]bool{
	OpenAIText:       true,
	OpenAIImageURL:   true,
	OpenAIImage:      true,
	OpenAIInputAudio: true,
	OpenAIAudioURL:   true,
	OpenAIFile:       true,
}
