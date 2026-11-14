package translate

// Port of the pipeline in open-sse/translator/index.js.
//
// The control flow is the contract, not an implementation detail:
//
//   - A direct translator for `source:target` wins over pivoting through OpenAI.
//     claude→kiro registered directly is lossless; going claude→openai→kiro is
//     not, because the OpenAI leg drops Claude-specific request fields.
//   - When there is no direct pair, the request pivots: source→OpenAI, then
//     OpenAI→target. Each leg is skipped when that side is already OpenAI.
//   - The response pivots in the opposite direction, target→OpenAI→source.
//   - Tool-call ids are ensured and missing tool responses filled before
//     translation, except when the target is Kiro. Kiro reconciles tool results
//     itself after session replay, and the generic fixer inserts OpenAI `role:
//     tool` messages that Kiro's direct Claude translator cannot consume.

// PipelineOptions carries the per-request inputs the translators read.
type PipelineOptions struct {
	// Source is the dialect the client sent.
	Source Format
	// Target is the dialect the upstream provider expects.
	Target Format
	// Model is passed through to the translator, which may rewrite it.
	Model string
	// Stream is forwarded and decides whether streaming-only fields are set.
	Stream bool
	// Provider is the registry name, used for provider-specific quirks.
	Provider string
	// Credentials are exposed to translators that need provider identity.
	Credentials map[string]any
	// Strip lists content kinds to delete before translation (image, audio).
	// Opt-in per provider via the model table.
	Strip []string
}

// TranslateRequest converts a client body into the target dialect.
//
// The input map is copied before mutation: the caller still holds the raw client
// body for logging, and the Node original relies on JS object identity that does
// not survive the trip through encoding/json here.
func TranslateRequest(r *Registry, body map[string]any, opts PipelineOptions) (map[string]any, error) {
	if r == nil {
		r = Default
	}
	result := deepCopyMap(body)

	stripContentTypes(result, opts.Strip)
	ensureToolCallIDs(result)

	// Kiro reconciles tool results after session replay, so the generic fixer is
	// deliberately not applied for that target.
	if opts.Target != FormatKiro {
		fixMissingToolResponses(result)
	}

	if opts.Source != opts.Target {
		if direct, ok := r.RequestFor(opts.Source, opts.Target); ok {
			// Direct pair: lossless for claude↔kiro, which would otherwise lose
			// Claude-specific fields on the OpenAI leg.
			converted, err := direct(opts.Model, result, opts.Stream, opts.Credentials)
			if err != nil {
				return nil, err
			}
			result = converted
		} else {
			if opts.Source != FormatOpenAI {
				if toOpenAI, ok := r.RequestFor(opts.Source, FormatOpenAI); ok {
					converted, err := toOpenAI(opts.Model, result, opts.Stream, opts.Credentials)
					if err != nil {
						return nil, err
					}
					result = converted
				}
			}
			if opts.Target != FormatOpenAI {
				if fromOpenAI, ok := r.RequestFor(FormatOpenAI, opts.Target); ok {
					converted, err := fromOpenAI(opts.Model, result, opts.Stream, opts.Credentials)
					if err != nil {
						return nil, err
					}
					result = converted
				}
			}
		}
	}

	return result, nil
}

// TranslateResponse converts one upstream frame back to the client dialect.
//
// Returns nil when the frame produced no client-visible output — a suppressed
// server-tool delta, or an event the converter deliberately swallows.
func TranslateResponse(r *Registry, chunk map[string]any, state *StreamState, opts PipelineOptions) ([]map[string]any, error) {
	if r == nil {
		r = Default
	}
	if chunk == nil {
		return nil, nil
	}

	// Same dialect: pass through unchanged. The one exception is a cloaked tool
	// name, which restores on the way out so the client never sees the suffix.
	if opts.Source == opts.Target {
		return decloakChunk(chunk, state), nil
	}

	// Direct response pair wins, mirroring the request side.
	if direct, ok := r.ResponseFor(opts.Target, opts.Source); ok {
		converted, err := direct(chunk, state)
		if err != nil {
			return nil, err
		}
		return restoreToolNames(converted, state), nil
	}

	results := []map[string]any{chunk}

	if opts.Target != FormatOpenAI {
		if toOpenAI, ok := r.ResponseFor(opts.Target, FormatOpenAI); ok {
			converted, err := toOpenAI(chunk, state)
			if err != nil {
				return nil, err
			}
			results = converted
		}
	}

	if opts.Source != FormatOpenAI {
		if fromOpenAI, ok := r.ResponseFor(FormatOpenAI, opts.Source); ok {
			var out []map[string]any
			for _, item := range results {
				converted, err := fromOpenAI(item, state)
				if err != nil {
					return nil, err
				}
				out = append(out, converted...)
			}
			results = out
		}
	}

	return restoreToolNames(results, state), nil
}

// stripContentTypes removes content parts the provider's model entry opted out of.
// An image sent to a text-only model is a hard upstream error, so the strip list
// is applied before the body leaves.
func stripContentTypes(body map[string]any, stripList []string) {
	if len(stripList) == 0 {
		return
	}
	messages := asSlice(body["messages"])
	if messages == nil {
		return
	}

	stripImage := containsString(stripList, "image")
	stripAudio := containsString(stripList, "audio")

	for _, raw := range messages {
		msg := asMap(raw)
		if msg == nil {
			continue
		}
		parts := asSlice(msg["content"])
		if parts == nil {
			continue
		}
		kept := make([]any, 0, len(parts))
		for _, p := range parts {
			part := asMap(p)
			if part == nil {
				kept = append(kept, p)
				continue
			}
			switch asString(part["type"]) {
			case OpenAIImageURL, OpenAIImage:
				if stripImage {
					continue
				}
			case OpenAIInputAudio, OpenAIAudioURL:
				if stripAudio {
					continue
				}
			}
			kept = append(kept, p)
		}
		// An emptied content array becomes "" so the message still has a body
		// some providers accept, rather than an empty array they reject.
		if len(kept) == 0 {
			msg["content"] = ""
		} else {
			msg["content"] = kept
		}
	}
}

// ensureToolCallIDs gives every tool_call an id. Some providers require one even
// when the client omitted it, and the id is what a later tool_result references.
func ensureToolCallIDs(body map[string]any) {
	messages := asSlice(body["messages"])
	for _, raw := range messages {
		msg := asMap(raw)
		if msg == nil {
			continue
		}
		calls := asSlice(msg["tool_calls"])
		for i, rawCall := range calls {
			call := asMap(rawCall)
			if call == nil {
				continue
			}
			if asString(call["id"]) == "" {
				call["id"] = "call_" + itoa(CreatedNow()) + "_" + itoa(int64(i))
			}
		}
	}
}

// fixMissingToolResponses is the global version of the tool-response repair: for
// every assistant tool_call, if the immediately following message is not a tool
// message answering it, an empty response is inserted.
//
// Distinct from the OpenAI-leg variant in the Claude converter, which scans a
// contiguous run of tool replies. The global one only checks the immediate next
// message, which is what an OpenAI-shaped body requires.
func fixMissingToolResponses(body map[string]any) {
	messages := asSlice(body["messages"])
	if messages == nil {
		return
	}

	var out []any
	for i, raw := range messages {
		msg := asMap(raw)
		out = append(out, msg)

		if msg == nil || asString(msg["role"]) != string(RoleAssistant) {
			continue
		}
		calls := asSlice(msg["tool_calls"])
		if len(calls) == 0 {
			continue
		}

		// Collect the ids answered by the immediately following tool messages.
		answered := map[string]bool{}
		for j := i + 1; j < len(messages); j++ {
			next := asMap(messages[j])
			if next == nil || asString(next["role"]) != string(RoleTool) {
				break
			}
			answered[asString(next["tool_call_id"])] = true
		}

		for _, rawCall := range calls {
			call := asMap(rawCall)
			if call == nil {
				continue
			}
			id := asString(call["id"])
			if id == "" || answered[id] {
				continue
			}
			out = append(out, map[string]any{
				"role":         string(RoleTool),
				"tool_call_id": id,
				"content":      "",
			})
		}
	}
	body["messages"] = out
}

// decloakChunk restores cloaked tool names when no conversion happens. The
// request side suffixes client tools for OAuth-cloaked providers, so a streamed
// tool_use block would otherwise reach the client under an unknown name.
func decloakChunk(chunk map[string]any, state *StreamState) []map[string]any {
	return restoreToolNames([]map[string]any{chunk}, state)
}

// restoreToolNames maps cloaked names back through the state's tool name map.
//
// It walks the shapes a tool name can appear in: a top-level tool_calls array and
// an Anthropic content_block. Anything else is returned untouched rather than
// recursed into, because a blanket walk would also rewrite user data that happens
// to sit at the same key.
func restoreToolNames(chunks []map[string]any, state *StreamState) []map[string]any {
	if state == nil || len(state.ToolNameMap) == 0 {
		return chunks
	}
	for _, chunk := range chunks {
		if calls := asSlice(chunk["tool_calls"]); calls != nil {
			for _, raw := range calls {
				call := asMap(raw)
				if call == nil {
					continue
				}
				fn := asMap(call["function"])
				if fn == nil {
					continue
				}
				if original, ok := state.ToolNameMap[asString(fn["name"])]; ok {
					fn["name"] = original
				}
			}
		}
		if block := asMap(chunk["content_block"]); block != nil {
			if original, ok := state.ToolNameMap[asString(block["name"])]; ok {
				block["name"] = original
			}
		}
	}
	return chunks
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// DetectFormatByEndpoint infers the client dialect from the request path.
//
// /v1/responses is always the Responses API. /v1/messages is always Claude.
// /v1/chat/completions carrying an `input` array is the Responses-shaped body
// that Cursor's CLI sends to the chat endpoint — treated as OpenAI so the
// translator does not see a shape mismatch. Returning "" means "fall back to
// detecting from the body".
func DetectFormatByEndpoint(pathname string, body map[string]any) Format {
	switch {
	case contains(pathname, "/v1/responses"):
		return FormatOpenAIResponses
	case contains(pathname, "/v1/messages"):
		return FormatClaude
	case contains(pathname, "/v1/chat/completions"):
		if _, ok := body["input"].([]any); ok {
			return FormatOpenAI
		}
	}
	return ""
}

func contains(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	if len(needle) > len(haystack) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
