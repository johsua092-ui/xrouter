// Package providers — codex.go ports open-sse/executors/codex.js.
//
// Codex is not an OpenAI chat/completions provider. Its backend speaks the
// Responses API at /backend-api/codex/responses and it accepts a narrow
// allowlist of fields, so a chat body cannot be forwarded raw. The Go side keeps
// that division: the translator converts the client body into Responses shape
// (Dialect = FormatResponses, same as grok-cli) and this file supplies the URL,
// the client-identity headers and the body repairs the Codex backend demands.
//
// The repairs are the interesting part. Each one exists because the backend
// rejects a shape that every other OpenAI-compatible upstream tolerates:
//
//   - store=false is mandatory, which makes server-generated item ids
//     (rs_/fc_/resp_/msg_) unresolvable — they must be stripped or the backend
//     404s on history replay.
//   - role=system is rejected in favor of role=developer, which also keeps the
//     system prompt inside the cacheable prefix.
//   - temperature/top_p/max_output_tokens/seed and friends 400 rather than
//     being ignored, so they are deleted instead of forwarded.
//   - an unknown top-level field trips "routing_unsupported", hence the final
//     allowlist sweep.
//
// All of it is pure body reshaping with no I/O, so the whole transform is
// testable without a network round trip.
package providers

import (
	"encoding/json"
	"strings"
)

// Codex CLI identity. The backend fingerprints the client from these, so they
// are not decorative: a request without them is treated as an unknown caller.
const (
	CodexCLIVersion = "0.167.1"
	CodexBaseURL    = "https://chatgpt.com/backend-api/codex/responses"
	// CodexCompactPath is appended when the caller asks for a compacted
	// conversation (_compact in the body).
	CodexCompactPath = "/compact"
	// CodexDefaultEffort is applied when the model name carries no -<level>
	// suffix and the caller sent no reasoning config.
	CodexDefaultEffort = "low"
	// CodexDefaultEffortLite is the floor for responses-lite models, which
	// reject "none"/"minimal" outright.
	CodexDefaultEffortLite = "medium"
)

// serverIDPrefixes are the item id prefixes Codex cannot resolve when
// store=false. Matching on the prefix rather than a full id keeps this stable
// when OpenAI changes the random half.
var serverIDPrefixes = []string{"rs_", "fc_", "resp_", "msg_"}

// codexHostedToolTypes execute server-side inside the Responses API. They pass
// through untouched because the backend owns their semantics.
var codexHostedToolTypes = map[string]bool{
	"image_generation": true, "web_search": true, "web_search_preview": true,
	"file_search": true, "computer": true, "computer_use_preview": true,
	"code_interpreter": true, "mcp": true, "local_shell": true, "tool_search": true,
}

// codexPassthroughToolTypes are Responses-native tools that carry their own
// payload shape (name + format) and must not be flattened into a function tool.
var codexPassthroughToolTypes = map[string]bool{"custom": true}

// responsesAPIAllowlist is the set of top-level fields the Codex backend
// accepts. Anything else is deleted before the request leaves, because an
// unknown key produces "routing_unsupported" instead of being ignored.
var responsesAPIAllowlist = map[string]bool{
	"model": true, "input": true, "instructions": true, "tools": true,
	"tool_choice": true, "stream": true, "store": true, "reasoning": true,
	"service_tier": true, "include": true, "prompt_cache_key": true,
	"client_metadata": true, "text": true, "parallel_tool_calls": true,
}

// codexUnsupportedParams are accepted by other OpenAI-compatible upstreams and
// rejected outright by Codex. Deleting them is what keeps a generic client's
// body usable here.
var codexUnsupportedParams = []string{
	"temperature", "top_p", "frequency_penalty", "presence_penalty",
	"logprobs", "top_logprobs", "n", "seed",
	"max_tokens", "max_completion_tokens", "max_output_tokens",
	"user", "prompt_cache_retention", "metadata", "stream_options",
	"safety_identifier", "previous_response_id", "reasoning_effort", "_compact",
}

// codexEffortLevels is the suffix vocabulary, longest first so "-xhigh" is not
// consumed by a shorter prefix match.
var codexEffortLevels = []string{"minimal", "medium", "xhigh", "high", "none", "low"}

// Codex is the adapter for provider id "codex" (alias "cx").
type Codex struct{}

// NewCodex returns the Codex adapter.
func NewCodex() *Codex { return &Codex{} }

func (c *Codex) Name() string { return "codex" }

// WireFormat declares the Responses API, exactly as grok-cli does. The gateway
// converts the client's chat body into this shape before Endpoint is consulted.
func (c *Codex) WireFormat() string { return FormatResponses }

// Endpoint returns the Codex Responses URL, with /compact appended when the
// caller asked for a compacted conversation.
func (c *Codex) Endpoint(req Request, cred Credential) (string, error) {
	base := cred.BaseURL
	if base == "" {
		base = CodexBaseURL
	}
	base = strings.TrimSuffix(base, "/")
	if codexWantsCompact(req.Body) {
		return base + CodexCompactPath, nil
	}
	return base, nil
}

// Headers builds the CLI fingerprint plus auth. Every header here is load
// bearing: originator/version identify the client, session_id ties the turn to a
// conversation for prompt caching, and ChatGPT-Account-ID stops a request from
// binding to the wrong account when several are configured.
func (c *Codex) Headers(req Request, cred Credential) (map[string]string, error) {
	headers := map[string]string{
		"Content-Type": "application/json",
		"originator":   "codex_cli_rs",
		"User-Agent":   "codex_cli_rs/" + CodexCLIVersion,
		"version":      CodexCLIVersion,
		"Accept":       "text/event-stream",
	}

	token := cred.AccessToken
	if token == "" {
		token = cred.APIKey
	}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}

	// Session identity: the Node executor prefers a conversation-stable id and
	// falls back to the connection, then to a literal "default".
	sessionID := cred.Extra["sessionId"]
	if sessionID == "" {
		sessionID = cred.Extra["connectionId"]
	}
	if sessionID == "" {
		sessionID = "default"
	}
	headers["session_id"] = sessionID

	// Account binding. Prefer an explicit workspace, then the ChatGPT account id
	// captured at OAuth import, then a legacy accountId.
	for _, key := range []string{"workspaceId", "chatgptAccountId", "accountId"} {
		if v := cred.Extra[key]; v != "" {
			headers["ChatGPT-Account-ID"] = v
			break
		}
	}

	// Responses-lite models need an explicit opt-in flag.
	if codexIsResponsesLite(req.Model) {
		headers["x-openai-internal-codex-responses-lite"] = "true"
	}

	return headers, nil
}

// codexWantsCompact reports whether the body carried the _compact marker. The
// marker is read before TransformBody deletes it, so this tolerates either
// order.
func codexWantsCompact(body []byte) bool {
	if len(body) == 0 {
		return false
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return false
	}
	v, ok := raw["_compact"].(bool)
	return ok && v
}

// codexIsResponsesLite reports whether a model id belongs to the responses-lite
// family, which carries tools and instructions as input prefix items instead of
// top-level fields. The trailing "(...)" annotation some ids carry is stripped
// first, matching the Node base-id extraction.
func codexIsResponsesLite(model string) bool {
	base := model
	if idx := strings.LastIndex(base, "("); idx > 0 && strings.HasSuffix(base, ")") {
		base = strings.TrimSpace(base[:idx])
	}
	for _, lite := range codexResponsesLiteModels {
		if lite == base {
			return true
		}
	}
	return false
}

// codexResponsesLiteModels is the responses-lite roster. It is a list rather
// than a pattern because the backend decides membership server-side; a name
// belongs here only when the provider model table marks responsesLite.
var codexResponsesLiteModels = []string{
	"gpt-5.1-codex-mini",
	"gpt-5-codex-mini",
}

// CodexDefaultInstructions is the system prompt injected when the caller sends
// none. Codex behaves as a coding agent, so an empty instructions field produces
// a markedly worse result than the CLI's own prelude. Kept as a compressed form
// of open-sse/config/codexInstructions.js — the behavioural rules that matter,
// without the reference material the model can look up itself.
const CodexDefaultInstructions = `You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.

## General

- When searching for text or files, prefer using ` + "`rg`" + ` or ` + "`rg --files`" + ` because ` + "`rg`" + ` is much faster than alternatives like ` + "`grep`" + `.
- Default to ASCII when editing files. Introduce Unicode only when the file already uses it.

## Editing constraints

- Add succinct comments only where code is not self-explanatory.
- Prefer ` + "`apply_patch`" + ` for edits when available; otherwise use precise, minimal diffs.
- Never revert or discard the user's work without being explicitly asked.

## Planning

- For multi-step tasks, keep a short plan and update it as you go.
- State assumptions explicitly rather than silently guessing.

## Verification

- After changing code, run the relevant tests or build so failures surface immediately.
- Report failures honestly, including the command and its output.`

// TransformBody applies the Codex body repairs in place and returns the new
// payload. A non-JSON body is passed through untouched so a malformed request
// fails upstream with the backend's own error rather than a rewrite error here.
//
// Ordering matters and mirrors transformRequest in the Node executor: system
// roles are converted before the id sweep (so a converted system item is not
// mistaken for a stored reference), tools are normalized before the allowlist
// sweep (so a tool schema is repaired rather than dropped), and the allowlist
// sweep runs last (so every earlier step can still see the fields it needs).
func (c *Codex) TransformBody(model string, body []byte) ([]byte, error) {
	if len(body) == 0 {
		return body, nil
	}
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return body, nil
	}

	// Multi-modal prefetch: the Codex backend does not fetch remote images, so a
	// remote image_url would silently produce a text-only turn. Left as the
	// caller's responsibility (the gateway inlines images before dispatch); the
	// transform only marks the accepted field name.
	upstreamModel := codexUpstreamModel(model, doc)
	lite := codexIsResponsesLite(upstreamModel)

	// normalizeResponsesInput: a bare string input becomes a one-item array.
	if s, ok := doc["input"].(string); ok {
		doc["input"] = []any{map[string]any{
			"type": "message", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": s}},
		}}
	}

	// The backend rejects an empty input array.
	if arr, ok := doc["input"].([]any); ok && len(arr) == 0 {
		doc["input"] = []any{map[string]any{
			"type": "message", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "..."}},
		}}
	}

	codexConvertSystemToDeveloper(doc)
	codexStripStoredItemReferences(doc, lite)
	codexNormalizeTools(doc)

	// The backend requires streaming regardless of what the client asked for.
	doc["stream"] = true
	doc["store"] = false

	if !lite {
		if s, _ := doc["instructions"].(string); strings.TrimSpace(s) == "" {
			doc["instructions"] = CodexDefaultInstructions
		}
	}

	// Model selection and reasoning effort both come from the model id suffix.
	doc["model"], doc["reasoning"] = codexResolveModelAndReasoning(upstreamModel, doc, lite)

	if lite {
		codexApplyLiteShape(doc)
	} else {
		delete(doc, "parallel_tool_calls")
	}

	// Reasoning models require the encrypted reasoning payload to be echoed back
	// across turns; asking for it is how the backend keeps a chain intact.
	if r, ok := doc["reasoning"].(map[string]any); ok {
		if effort, _ := r["effort"].(string); effort != "" && effort != "none" {
			doc["include"] = []any{"reasoning.encrypted_content"}
		}
	}

	codexDropAlienReasoningItems(doc)

	// service_tier is an enum on this backend: "fast" is an alias for
	// "priority", and anything else is rejected rather than downgraded.
	if tier, ok := doc["service_tier"].(string); ok {
		if tier == "fast" {
			doc["service_tier"] = "priority"
		} else if tier != "priority" {
			delete(doc, "service_tier")
		}
	}

	for _, k := range codexUnsupportedParams {
		delete(doc, k)
	}

	// Final sweep: anything the backend does not list would 400 the request.
	for k := range doc {
		if !responsesAPIAllowlist[k] {
			delete(doc, k)
		}
	}

	return json.Marshal(doc)
}

// codexUpstreamModel resolves the model the backend should see. A virtual review
// model (the "<model>-review" family) maps to its upstream id before suffix
// parsing so the effort suffix is read off the real model name.
func codexUpstreamModel(reqModel string, doc map[string]any) string {
	if m, ok := doc["model"].(string); ok && m != "" {
		reqModel = m
	}
	if strings.HasSuffix(reqModel, "-review") {
		reqModel = strings.TrimSuffix(reqModel, "-review")
	}
	return reqModel
}

// codexResolveModelAndReasoning strips a trailing effort suffix from the model
// id and builds the reasoning block. Explicit reasoning in the body wins over
// the suffix, which wins over the family default.
func codexResolveModelAndReasoning(model string, doc map[string]any, lite bool) (string, map[string]any) {
	suffixEffort := ""
	for _, level := range codexEffortLevels {
		if strings.HasSuffix(model, "-"+level) {
			suffixEffort = level
			model = strings.TrimSuffix(model, "-"+level)
			break
		}
	}

	defaultEffort := CodexDefaultEffort
	if lite {
		defaultEffort = CodexDefaultEffortLite
	}
	fallback := defaultEffort
	if suffixEffort != "" {
		fallback = suffixEffort
	}

	existing, hasExisting := doc["reasoning"].(map[string]any)
	if hasExisting {
		effort, _ := existing["effort"].(string)
		existing["effort"] = codexNormalizeEffort(model, effort, lite)
		if !lite {
			if s, _ := existing["summary"].(string); s == "" {
				existing["summary"] = "auto"
			}
		}
		if lite {
			existing["context"] = "all_turns"
		}
		return model, existing
	}

	block := map[string]any{"effort": codexNormalizeEffort(model, fallback, lite)}
	if lite {
		block["context"] = "all_turns"
	} else {
		block["summary"] = "auto"
	}
	return model, block
}

// codexNormalizeEffort maps a requested effort onto what the backend accepts for
// this model. Unsupported levels are not rejected client-side — they are
// rewritten, because the Node executor's whole purpose here is to keep a request
// alive across clients with different vocabularies.
func codexNormalizeEffort(model, value string, lite bool) string {
	if value == "" {
		if lite {
			return CodexDefaultEffortLite
		}
		return CodexDefaultEffort
	}
	if lite && (value == "none" || value == "minimal") {
		return "low"
	}
	// "ultra"/"max" are UI vocabulary that the backend spells "xhigh".
	if value == "max" || value == "ultra" {
		return "xhigh"
	}
	_ = model
	return value
}

// codexConvertSystemToDeveloper rewrites role=system to role=developer. The
// backend rejects system, and developer items stay inside the cacheable prefix.
func codexConvertSystemToDeveloper(doc map[string]any) {
	arr, ok := doc["input"].([]any)
	if !ok {
		return
	}
	for _, item := range arr {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if m["role"] == "system" {
			if t, hasType := m["type"]; !hasType || t == "message" {
				m["role"] = "developer"
			}
		}
	}
}

// codexStripStoredItemReferences removes server-generated ids and
// item_reference entries. With store=false the backend has no memory of those
// items, so replaying them produces a 404 on the whole conversation. A
// responses-lite prefix item keeps its msg_ id, which is the exception the Node
// original carves out.
func codexStripStoredItemReferences(doc map[string]any, preserveLitePrefix bool) {
	arr, ok := doc["input"].([]any)
	if !ok {
		return
	}
	out := make([]any, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			if codexHasServerIDPrefix(s) {
				continue
			}
			out = append(out, item)
			continue
		}
		m, ok := item.(map[string]any)
		if !ok {
			out = append(out, item)
			continue
		}
		if m["type"] == "item_reference" {
			continue
		}
		if id, ok := m["id"].(string); ok && codexHasServerIDPrefix(id) {
			keep := preserveLitePrefix && m["role"] == "developer" && strings.HasPrefix(id, "msg_")
			if !keep {
				delete(m, "id")
			}
		}
		out = append(out, m)
	}
	doc["input"] = out
}

// codexHasServerIDPrefix reports whether an id was minted by the server.
func codexHasServerIDPrefix(id string) bool {
	for _, p := range serverIDPrefixes {
		if strings.HasPrefix(id, p) {
			return true
		}
	}
	return false
}

// codexNormalizeTools flattens the chat-completions tool wrapper into the flat
// Responses shape and drops tool types the backend cannot execute. A chat client
// sends {"type":"function","function":{...}}; Responses wants the function's
// fields hoisted to the top level.
func codexNormalizeTools(doc map[string]any) {
	arr, ok := doc["tools"].([]any)
	if !ok {
		return
	}
	validNames := map[string]bool{}
	out := make([]any, 0, len(arr))

	for _, item := range arr {
		tool, ok := item.(map[string]any)
		if !ok {
			continue
		}
		typ, _ := tool["type"].(string)

		// A namespace tool is a container; its children are the real tools.
		if typ == "namespace" {
			children, _ := tool["tools"].([]any)
			for _, child := range children {
				cm, ok := child.(map[string]any)
				if !ok {
					continue
				}
				if n, _ := cm["name"].(string); strings.TrimSpace(n) != "" {
					validNames[strings.TrimSpace(n)] = true
				}
				if params, ok := cm["parameters"].(map[string]any); ok {
					cm["parameters"] = stripCodexUnsupportedPatterns(params)
				}
			}
			out = append(out, tool)
			continue
		}

		if typ != "function" {
			if codexPassthroughToolTypes[typ] {
				out = append(out, tool)
				continue
			}
			// A bare {name, description, parameters} with no type is a function
			// tool written in the flat Responses shape already.
			if typ == "" && (tool["function"] != nil || tool["name"] != nil) {
				continue
			}
			if codexHostedToolTypes[typ] {
				out = append(out, tool)
			}
			continue
		}

		// Hoist the nested function object.
		fn, _ := tool["function"].(map[string]any)
		name := codexToolName(tool, fn)
		if name == "" {
			continue
		}

		flat := map[string]any{
			"type":       "function",
			"name":       truncateCodexName(name),
			"parameters": codexToolParameters(tool, fn),
		}
		if desc, _ := tool["description"].(string); desc != "" {
			flat["description"] = desc
		} else if fn != nil {
			if desc, _ := fn["description"].(string); desc != "" {
				flat["description"] = desc
			}
		}
		validNames[name] = true
		out = append(out, flat)
	}

	doc["tools"] = out

	// A tool_choice pointing at a name that did not survive normalization would
	// 400 the request, so it is dropped instead.
	if choice, ok := doc["tool_choice"].(map[string]any); ok {
		if choice["type"] == "function" {
			n, _ := choice["name"].(string)
			n = strings.TrimSpace(n)
			if n == "" || !validNames[n] {
				delete(doc, "tool_choice")
			}
		}
	}
}

// codexToolName reads a tool name from either the flat or nested position.
func codexToolName(tool, fn map[string]any) string {
	if n, ok := tool["name"].(string); ok && strings.TrimSpace(n) != "" {
		return strings.TrimSpace(n)
	}
	if fn != nil {
		if n, ok := fn["name"].(string); ok {
			return strings.TrimSpace(n)
		}
	}
	return ""
}

// codexToolParameters reads parameters from either position, defaulting to an
// empty object schema — the backend rejects a function tool with no parameters.
func codexToolParameters(tool, fn map[string]any) map[string]any {
	if p, ok := tool["parameters"].(map[string]any); ok {
		return stripCodexUnsupportedPatterns(p)
	}
	if fn != nil {
		if p, ok := fn["parameters"].(map[string]any); ok {
			return stripCodexUnsupportedPatterns(p)
		}
	}
	return map[string]any{"type": "object", "properties": map[string]any{}}
}

// truncateCodexName enforces the backend's 128-character tool name cap.
func truncateCodexName(name string) string {
	if len(name) <= 128 {
		return name
	}
	return name[:128]
}

// stripCodexUnsupportedPatterns removes JSON-schema `pattern` values that use
// `\p{...}` Unicode property escapes. The Codex schema validator compiles
// patterns with a regex engine that has no property-escape support, so a single
// such pattern 400s the entire request rather than just failing that tool.
// Dropping the pattern keeps the tool usable.
func stripCodexUnsupportedPatterns(schema map[string]any) map[string]any {
	if schema == nil {
		return schema
	}
	if p, ok := schema["pattern"].(string); ok && strings.Contains(p, `\p{`) {
		delete(schema, "pattern")
	}
	if props, ok := schema["properties"].(map[string]any); ok {
		for _, v := range props {
			if sub, ok := v.(map[string]any); ok {
				stripCodexUnsupportedPatterns(sub)
			}
		}
	}
	if items, ok := schema["items"].(map[string]any); ok {
		stripCodexUnsupportedPatterns(items)
	}
	for _, key := range []string{"anyOf", "oneOf", "allOf"} {
		if arr, ok := schema[key].([]any); ok {
			for _, v := range arr {
				if sub, ok := v.(map[string]any); ok {
					stripCodexUnsupportedPatterns(sub)
				}
			}
		}
	}
	return schema
}

// codexApplyLiteShape restructures the body for responses-lite models. Instead
// of carrying instructions and tools as top-level fields, lite models read them
// as a prefix on the input array: an additional_tools item followed by a
// developer message. The top-level fields are then blanked so the backend does
// not see them twice.
func codexApplyLiteShape(doc map[string]any) {
	input, _ := doc["input"].([]any)

	hasPrefix := false
	for _, item := range input {
		if m, ok := item.(map[string]any); ok && m["type"] == "additional_tools" {
			hasPrefix = true
			break
		}
	}

	if !hasPrefix {
		instructions, _ := doc["instructions"].(string)
		if strings.TrimSpace(instructions) == "" {
			instructions = CodexDefaultInstructions
		}
		tools, _ := doc["tools"].([]any)

		prefix := []any{map[string]any{
			"type": "additional_tools", "role": "developer", "tools": tools,
		}}
		if instructions != "" {
			prefix = append(prefix, map[string]any{
				"type": "message", "role": "developer",
				"content": []any{map[string]any{"type": "input_text", "text": instructions}},
			})
		}
		input = append(prefix, input...)
	}

	doc["input"] = input
	doc["instructions"] = ""
	doc["tools"] = nil
	if _, ok := doc["tool_choice"]; !ok {
		doc["tool_choice"] = "auto"
	}
	doc["parallel_tool_calls"] = false
}

// codexDropAlienReasoningItems removes encrypted reasoning content produced by a
// different provider (Grok, for example). The Codex backend cannot decrypt a
// foreign blob and fails the turn; only content it minted itself carries the
// codex_ marker.
//
// The Node original walks body.messages, which is dead code for a Responses
// request — this backend reads body.input. Both are swept because a caller can
// send either shape: a chat-completions client reaches this adapter through the
// translator, and translated history can still carry a foreign blob. Walking
// only one of the two would leave the other leaking into the turn.
func codexDropAlienReasoningItems(doc map[string]any) {
	for _, key := range []string{"input", "messages"} {
		items, ok := doc[key].([]any)
		if !ok {
			continue
		}
		for _, raw := range items {
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			content, ok := item["content"].([]any)
			if !ok {
				continue
			}
			kept := make([]any, 0, len(content))
			for _, rawPart := range content {
				part, ok := rawPart.(map[string]any)
				if ok && part["type"] == "reasoning" {
					if enc, ok := part["encrypted_content"].(string); ok && !strings.HasPrefix(enc, "codex_") {
						continue
					}
				}
				kept = append(kept, rawPart)
			}
			item["content"] = kept
		}
	}
}
