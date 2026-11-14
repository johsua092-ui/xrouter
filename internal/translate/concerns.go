package translate

import "time"

// Port of concerns/chunk.js, concerns/usage.js, concerns/reasoning.js and
// concerns/finishReason.js. These four are the shared vocabulary the response
// translators speak: how a chunk is shaped, how tokens are counted, how reasoning
// travels, and how stop reasons map between dialects.

// BuildChunk assembles an OpenAI chat.completion.chunk.
//
// The caller supplies id/created/model rather than this function generating them,
// because each translator in the original keeps its own id and timestamp
// semantics — the Claude converter derives the id from the upstream message id
// while others mint one. Centralising here would quietly change them all.
func BuildChunk(id string, created int64, model string, delta map[string]any, finishReason any) map[string]any {
	return map[string]any{
		"id":      id,
		"object":  "chat.completion.chunk",
		"created": created,
		"model":   model,
		"choices": []any{
			map[string]any{
				"index":         0,
				"delta":         delta,
				"finish_reason": finishReason,
			},
		},
	}
}

// CreatedNow is the unix-seconds timestamp chunks carry.
func CreatedNow() int64 { return time.Now().Unix() }

// UsageArgs are the inputs buildUsage takes. Every provider's extractor produces
// one of these; the shape keeps provider-specific folding explicit.
type UsageArgs struct {
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
	CachedTokens     int
	CacheCreation    int
	ReasoningTokens  int
}

// BuildUsage renders the OpenAI usage object. The optional detail blocks appear
// only when their token count is positive, matching the original: emitting
// prompt_tokens_details with a zero cached_tokens makes some clients display
// "cache: 0" as though caching were configured.
func BuildUsage(a UsageArgs) map[string]any {
	usage := map[string]any{
		"prompt_tokens":     a.PromptTokens,
		"completion_tokens": a.CompletionTokens,
		"total_tokens":      a.TotalTokens,
	}
	if a.CachedTokens > 0 || a.CacheCreation > 0 {
		details := map[string]any{}
		if a.CachedTokens > 0 {
			details["cached_tokens"] = a.CachedTokens
		}
		if a.CacheCreation > 0 {
			details["cache_creation_tokens"] = a.CacheCreation
		}
		usage["prompt_tokens_details"] = details
	}
	if a.ReasoningTokens > 0 {
		usage["completion_tokens_details"] = map[string]any{
			"reasoning_tokens": a.ReasoningTokens,
		}
	}
	return usage
}

// numOf reads a numeric field, treating a non-number as zero the way the
// original's `n()` helper does.
func numOf(v any) int {
	n, _ := asInt(v)
	return n
}

// ToOpenAIUsage converts a provider-native usage object to OpenAI's shape.
//
// Claude and Gemini fold cache and reasoning tokens into the prompt/completion
// counts; the other providers do not. That difference is visible in billing, so
// it is kept per-provider rather than normalised away.
func ToOpenAIUsage(raw map[string]any, kind string) map[string]any {
	if raw == nil {
		return nil
	}
	switch kind {
	case "claude":
		input := numOf(raw["input_tokens"])
		output := numOf(raw["output_tokens"])
		cacheRead := numOf(raw["cache_read_input_tokens"])
		cacheCreate := numOf(raw["cache_creation_input_tokens"])
		prompt := input + cacheRead + cacheCreate
		return BuildUsage(UsageArgs{
			PromptTokens:     prompt,
			CompletionTokens: output,
			TotalTokens:      prompt + output,
			CachedTokens:     cacheRead,
			CacheCreation:    cacheCreate,
		})

	case "gemini":
		cached := numOf(raw["cachedContentTokenCount"])
		prompt := numOf(raw["promptTokenCount"])
		thoughts := numOf(raw["thoughtsTokenCount"])
		total := numOf(raw["totalTokenCount"])
		candidates := numOf(raw["candidatesTokenCount"])
		// Derive candidates from the total when upstream omits it, clamping at
		// zero so a partial upstream report cannot produce negative tokens.
		if candidates == 0 && total > 0 {
			candidates = total - prompt - thoughts
			if candidates < 0 {
				candidates = 0
			}
		}
		return BuildUsage(UsageArgs{
			PromptTokens:     prompt,
			CompletionTokens: candidates + thoughts,
			TotalTokens:      total,
			CachedTokens:     cached,
			ReasoningTokens:  thoughts,
		})

	case "kiro":
		input := numOf(raw["inputTokens"])
		output := numOf(raw["outputTokens"])
		// Amazon Q does not expose cache fields today. Pass through any that a
		// future event shape adds so cost tracking keeps working unchanged.
		cached := firstNonZero(numOf(raw["cache_read_input_tokens"]), numOf(raw["cachedTokens"]), numOf(raw["cached_tokens"]))
		cacheCreation := numOf(raw["cache_creation_input_tokens"])
		args := UsageArgs{
			PromptTokens:     input,
			CompletionTokens: output,
			TotalTokens:      input + output,
			CachedTokens:     cached,
			CacheCreation:    cacheCreation,
		}
		return BuildUsage(args)

	case "ollama":
		input := numOf(raw["prompt_eval_count"])
		output := numOf(raw["eval_count"])
		return BuildUsage(UsageArgs{
			PromptTokens:     input,
			CompletionTokens: output,
			TotalTokens:      input + output,
		})

	case "commandcode":
		input := numOf(raw["inputTokens"])
		output := numOf(raw["outputTokens"])
		total := input + output
		if v, ok := asInt(raw["totalTokens"]); ok {
			total = v
		}
		return BuildUsage(UsageArgs{
			PromptTokens:     input,
			CompletionTokens: output,
			TotalTokens:      total,
		})
	}
	return nil
}

func firstNonZero(vals ...int) int {
	for _, v := range vals {
		if v != 0 {
			return v
		}
	}
	return 0
}

// ReasoningDelta builds an OpenAI delta carrying reasoning_content.
//
// Reasoning never travels inside `content` with  thinking markers: an
// OpenAI-format client renders those as literal text in the answer.
func ReasoningDelta(text string, withRole bool) map[string]any {
	if withRole {
		return map[string]any{
			"role":              string(RoleAssistant),
			"reasoning_content": text,
		}
	}
	return map[string]any{"reasoning_content": text}
}

// ExtractReasoningText pulls reasoning out of a streamed delta across the vendor
// shapes: reasoning_content (GLM, Qwen, DeepSeek, Kimi, Step, Hunyuan),
// reasoning (some compat layers), and reasoning_details (MiniMax with
// reasoning_split).
func ExtractReasoningText(delta map[string]any) string {
	if delta == nil {
		return ""
	}
	if s := asString(delta["reasoning_content"]); s != "" {
		return s
	}
	if s := asString(delta["reasoning"]); s != "" {
		return s
	}
	if details, ok := delta["reasoning_details"].([]any); ok {
		var out string
		for _, d := range details {
			if s, ok := d.(string); ok {
				out += s
				continue
			}
			m := asMap(d)
			if m == nil {
				continue
			}
			if s := asString(m["text"]); s != "" {
				out += s
			} else if s := asString(m["content"]); s != "" {
				out += s
			}
		}
		return out
	}
	return ""
}

// ToOpenAIFinish maps an upstream stop reason to OpenAI's finish_reason.
//
// ClaudeStopRefusal maps to content_filter rather than stop. A refusal is a
// blocked turn, not a clean one: with the default mapping an OpenAI client saw
// finish_reason "stop" and an empty message, and could not tell it apart from a
// real answer.
func ToOpenAIFinish(reason, format string) string {
	switch format {
	case "claude":
		switch reason {
		case ClaudeStopEndTurn:
			return FinishStop
		case ClaudeStopMaxTokens:
			return FinishLength
		case ClaudeStopToolUse:
			return FinishToolCalls
		case ClaudeStopStopSequence:
			return FinishStop
		case ClaudeStopRefusal:
			return FinishContentFilter
		default:
			return FinishStop
		}
	case "commandcode":
		switch reason {
		case "stop":
			return FinishStop
		case "length":
			return FinishLength
		case "tool-calls", "tool_use":
			return FinishToolCalls
		case "content-filter":
			return FinishContentFilter
		case "error":
			return FinishStop
		default:
			if reason == "" {
				return FinishStop
			}
			return reason
		}
	case "gemini":
		switch upper(reason) {
		case GeminiFinishStop:
			return FinishStop
		case GeminiFinishMaxTokens:
			return FinishLength
		case GeminiFinishSafety, GeminiFinishRecitation, GeminiFinishBlocklist, GeminiFinishProhibitedContent:
			return FinishContentFilter
		default:
			return FinishStop
		}
	case "kiro", "ollama":
		switch reason {
		case "tool_calls", "tool_use":
			return FinishToolCalls
		case "length", "max_tokens":
			return FinishLength
		default:
			return FinishStop
		}
	default:
		if reason == "" {
			return FinishStop
		}
		return reason
	}
}

// FromOpenAIFinish maps an OpenAI finish_reason back to the upstream dialect.
func FromOpenAIFinish(reason, format string) string {
	switch format {
	case "claude":
		switch reason {
		case FinishStop:
			return ClaudeStopEndTurn
		case FinishLength:
			return ClaudeStopMaxTokens
		case FinishToolCalls:
			return ClaudeStopToolUse
		case FinishContentFilter:
			return ClaudeStopRefusal
		default:
			return ClaudeStopEndTurn
		}
	default:
		return reason
	}
}

func upper(s string) string {
	b := []byte(s)
	for i := range b {
		if 'a' <= b[i] && b[i] <= 'z' {
			b[i] -= 'a' - 'A'
		}
	}
	return string(b)
}
