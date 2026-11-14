package providers

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// Web-cookie tool bridge.
//
// Port of open-sse/translator/webTools.js plus utils/dsmlToolCalls.js.
//
// A web-cookie provider is a browser-session chat endpoint: it takes a plain text
// prompt and answers with text. There is no protocol-level function calling, so an
// agent sending `tools` gets either prose it cannot execute or a hard 400. This
// bridges the gap at the application level — the OpenAI `tools` array is encoded
// into the prompt and the model's reply is parsed back into standard `tool_calls`,
// so the client sees ordinary OpenAI output and its handlers run unchanged.
//
// Two properties of the encoding are load-bearing and were measured upstream:
//
//   - A TRAILING anchor is required, not just a leading instruction. A 40KB agent
//     system prompt with its own "emit function calls" wording drowns a leading
//     rule alone, and the model answers "I have no tools" or writes a shell block
//     for the user to run itself.
//   - The nonce binding is what lets a parser trust a block. Without it any text
//     that happens to contain the fence shape — a document being summarised, a
//     tool result echoing markup — would be executed as a call.

// The fence shapes the model may emit. Parsers accept both regardless of which
// style was requested, because a model that mixes them should still have its call
// recovered.
const (
	webToolCallMarker   = "<<TOOL_CALL>>"
	webToolResultMarker = "<<TOOL_RESULT>>"
)

// webToolPromptHeading opens the tool contract. Kept verbatim: upstream compares
// the wording's effect, and a reworded instruction measurably stops the model
// emitting the fence.
const webToolPromptHeading = "The client application provides tools beyond your built-in ones. They are NOT in your native " +
	"tool registry; they are invoked via a plain-text protocol: the client parses " +
	"your reply and executes the tool on the user machine. Treat these client tools as " +
	"fully available to you; never claim they are unavailable. To invoke one, reply with " +
	"a single line containing a <tool> block"

// toolNonce generates the secret binding echoed in the contract.
//
// Keyed on the tools slice identity so one request's nonce cannot be replayed by a
// reply that echoes a different request's contract. A WeakMap in Node, a keyed map
// here — the lifetime difference does not matter because the entry is only read
// within the same request.
var (
	toolNonceMu    sync.Mutex
	toolNonceByKey = map[string]string{}
)

// webToolNonce returns a stable nonce for a request's tool set.
func webToolNonce(key string) string {
	toolNonceMu.Lock()
	defer toolNonceMu.Unlock()

	if n, ok := toolNonceByKey[key]; ok {
		return n
	}
	n := randomAlnum(8)
	toolNonceByKey[key] = n
	// The map is keyed per request and never cleared by a caller, so it is bounded
	// here. An unbounded map keyed by request content is a leak on a busy gateway.
	if len(toolNonceByKey) > 4096 {
		for k := range toolNonceByKey {
			delete(toolNonceByKey, k)
			break
		}
	}
	return n
}

// ForgerNonce is the key a caller passes to get a stable nonce for one request.
var ForgerNonce = func(seed string) string { return webToolNonce(seed) }

func randomAlnum(n int) string {
	buf := make([]byte, n)
	if _, err := randomBytes(buf); err != nil {
		panic(fmt.Sprintf("webtools: crypto/rand unavailable: %v", err))
	}
	out := make([]byte, n)
	for i, b := range buf {
		out[i] = opencodeBase62[int(b)%len(opencodeBase62)]
	}
	return string(out)
}

// hasWebTools reports whether a request declares tools, in either the `tools` or
// the legacy `functions` shape.
func hasWebTools(body map[string]any) bool {
	if t, ok := body["tools"].([]any); ok && len(t) > 0 {
		return true
	}
	if f, ok := body["functions"].([]any); ok && len(f) > 0 {
		return true
	}
	return false
}

// webToolsOf returns the tool declarations from whichever field carries them.
func webToolsOf(body map[string]any) []any {
	if t, ok := body["tools"].([]any); ok && len(t) > 0 {
		return t
	}
	if f, ok := body["functions"].([]any); ok && len(f) > 0 {
		return f
	}
	return nil
}

// functionOf unwraps a tool to its function definition.
func functionOf(tool any) map[string]any {
	m, ok := tool.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	if fn, ok := m["function"].(map[string]any); ok {
		return fn
	}
	return m
}

// SerializeToolsToPrompt renders the tool contract.
//
// Returns "" when there is nothing to declare, so a caller can treat the empty
// result as "no bridge needed" rather than injecting an empty contract that would
// tell the model it has tools it cannot see.
func SerializeToolsToPrompt(tools []any, nonce string) string {
	if len(tools) == 0 || nonce == "" {
		return ""
	}

	var lines []string
	for _, tool := range tools {
		fn := functionOf(tool)
		name, _ := fn["name"].(string)
		if name == "" {
			continue
		}
		line := "- " + name
		if desc, ok := fn["description"].(string); ok && desc != "" {
			line += ": " + desc
		}
		if params, ok := fn["parameters"]; ok && params != nil {
			if raw, err := json.Marshal(params); err == nil {
				line += "\n  parameters: " + string(raw)
			}
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return ""
	}

	head := []string{
		webToolPromptHeading,
		fmt.Sprintf("with JSON that includes the secret binding \"_nonce\": \"%s\":", nonce),
		fmt.Sprintf("<tool>{\"name\": \"<tool_name>\", \"arguments\": { ... }, \"_nonce\": \"%s\"}</tool>", nonce),
		"These client tools ARE available to you in this conversation. Only emit the <tool> " +
			"block when you actually want to call a tool; otherwise answer normally.",
		"",
		"Available tools:",
	}
	return strings.Join(append(head, lines...), "\n")
}

// BuildToolReminder is the TRAILING anchor.
//
// Without it a long agent system prompt wins the model's attention and the fence
// never appears. The names are repeated so the anchor also refreshes which tools
// exist, not merely that a protocol exists.
func BuildToolReminder(toolPrompt string) string {
	names := toolNameList(toolPrompt)
	if names != "" {
		names = ": " + names
	}
	return "\n\n[Client protocol reminder: the client-tool contract in the system instructions " +
		"is active in this conversation. These client tools ARE available via the <tool> " +
		"block protocol" + names + ".]"
}

// toolNameList extracts the declared names from a rendered contract.
func toolNameList(toolPrompt string) string {
	var names []string
	for _, line := range strings.Split(toolPrompt, "\n") {
		if !strings.HasPrefix(line, "- ") {
			continue
		}
		rest := strings.TrimPrefix(line, "- ")
		if i := strings.Index(rest, ":"); i >= 0 {
			rest = rest[:i]
		}
		rest = strings.TrimSpace(rest)
		if rest != "" {
			names = append(names, rest)
		}
	}
	return strings.Join(names, ", ")
}

// ── parsing a reply back into tool calls ─────────────────────────────────────

// WebToolCall is one parsed call in the OpenAI shape.
type WebToolCall struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Function WebToolFunction `json:"function"`
}

// WebToolFunction is the called function and its serialised arguments.
type WebToolFunction struct {
	Name string `json:"name"`
	// Arguments is a JSON string, not an object: that is what the OpenAI wire
	// format carries and what a client's handlers expect.
	Arguments string `json:"arguments"`
}

// WebToolParse is the outcome of parsing a reply.
type WebToolParse struct {
	// Content is the reply with every accepted call block removed, so the client
	// does not also see the raw fence as assistant text.
	Content string
	// ToolCalls is nil when no call was found.
	ToolCalls []WebToolCall
}

var (
	toolOpenRE     = regexp.MustCompile(`(?s)<tool>`)
	toolCloseRE    = regexp.MustCompile(`(?s)</tool>`)
	toolCallOpenRE = regexp.MustCompile(`(?s)<tool_call[^>]*>`)
	toolCallClose  = "</tool_call>"
)

// ParseToolCallsFromText recovers tool calls from a model reply.
//
// requestedTools supplies the nonce and the set of names that may be called. A
// block whose nonce does not match is skipped: that is the guard against executing
// fence-shaped text the model merely echoed rather than emitted.
func ParseToolCallsFromText(text string, idSeed string, requestedTools []any, nonce string) WebToolParse {
	if text == "" {
		return WebToolParse{Content: text}
	}

	// DeepSeek and some Chinese web models emit DSML instead of the documented
	// fence. Tried first because a DSML reply contains no `<tool>` tag at all and
	// would otherwise be returned as plain text.
	if calls, rest, ok := ParseDSMLToolCalls(text); ok && len(calls) > 0 {
		return WebToolParse{Content: rest, ToolCalls: calls}
	}

	if !strings.Contains(text, "<tool>") && !strings.Contains(text, "<tool_call") {
		return WebToolParse{Content: text}
	}

	requested := requestedWebToolNames(requestedTools)

	var blocks []webToolBlock
	for _, pair := range [][2]*regexp.Regexp{{toolOpenRE, toolCloseRE}} {
		blocks = append(blocks, findTagBlocks(text, pair[0], pair[1])...)
	}
	// <tool_call ...> ... </tool_call>
	blocks = append(blocks, findTagBlocks(text, toolCallOpenRE, regexp.MustCompile(regexp.QuoteMeta(toolCallClose)))...)

	// Sorted by position so the emitted order is the model's order, which matters
	// when a reply contains several calls that depend on each other.
	for i := 1; i < len(blocks); i++ {
		for j := i; j > 0 && blocks[j].start < blocks[j-1].start; j-- {
			blocks[j], blocks[j-1] = blocks[j-1], blocks[j]
		}
	}

	var calls []WebToolCall
	var accepted [][2]int

	for _, b := range blocks {
		parsed := parseLooseJSONObject(strings.TrimSpace(b.inner))
		if parsed == nil {
			continue
		}

		emitted, _ := parsed["name"].(string)
		if emitted == "" {
			emitted, _ = parsed["command"].(string)
		}
		if emitted == "" {
			continue
		}

		// Only enforce the nonce when the model actually supplied one. A model that
		// omits the binding entirely is complying badly, not attacking, and the
		// `requested` name check below still bounds what it may call.
		if nonce != "" {
			if v, present := parsed["_nonce"]; present {
				asString, _ := v.(string)
				if asString != nonce {
					continue
				}
			}
		}

		name := resolveRequestedWebToolName(emitted, requested)
		if name == "" {
			// Not a declared tool. Skipped rather than passed through: a hallucinated
			// name would otherwise reach the client as an executable call.
			continue
		}

		calls = append(calls, WebToolCall{
			ID:       fmt.Sprintf("%s_%d", idSeed, len(calls)),
			Type:     "function",
			Function: WebToolFunction{Name: name, Arguments: argumentsString(parsed["arguments"])},
		})
		accepted = append(accepted, [2]int{b.start, b.end})
	}

	if len(calls) == 0 {
		return WebToolParse{Content: text}
	}
	return WebToolParse{Content: stripRanges(text, accepted), ToolCalls: calls}
}

// webToolBlock is one located fence in the reply.
type webToolBlock struct {
	inner string
	start int
	end   int
}

// findTagBlocks locates every open/close tag pair.
func findTagBlocks(text string, open, close *regexp.Regexp) []webToolBlock {
	var out []webToolBlock
	cursor := 0
	for {
		openLoc := open.FindStringIndex(text[cursor:])
		if openLoc == nil {
			return out
		}
		innerStart := cursor + openLoc[1]
		closeLoc := close.FindStringIndex(text[innerStart:])
		if closeLoc == nil {
			return out
		}
		end := innerStart + closeLoc[1]
		out = append(out, webToolBlock{
			inner: text[innerStart : innerStart+closeLoc[0]],
			start: cursor + openLoc[0],
			end:   end,
		})
		cursor = end
	}
}

// stripRanges removes accepted blocks, collapsing the whitespace they leave.
func stripRanges(text string, ranges [][2]int) string {
	if len(ranges) == 0 {
		return text
	}
	var b strings.Builder
	prev := 0
	for _, r := range ranges {
		if r[0] < prev {
			continue
		}
		b.WriteString(text[prev:r[0]])
		prev = r[1]
	}
	if prev < len(text) {
		b.WriteString(text[prev:])
	}
	// Collapse runs of blank lines created where a block was removed, so the
	// remaining content reads as prose rather than a gap.
	lines := strings.Split(b.String(), "\n")
	var kept []string
	blank := 0
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		kept = append(kept, l)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// parseLooseJSONObject parses a possibly-imperfect JSON object.
//
// Models emit trailing commas, single quotes, and unquoted keys. A strict parse
// would drop a real call, so the common repairs are attempted before giving up.
func parseLooseJSONObject(raw string) map[string]any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}

	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err == nil {
		return out
	}

	repaired := raw
	// Single quotes to double, only where they are not already escaped.
	repaired = strings.ReplaceAll(repaired, "'", "\"")
	// Trailing commas before a closing brace or bracket.
	repaired = regexp.MustCompile(`,\s*([}\]])`).ReplaceAllString(repaired, "$1")
	// Unquoted keys: {name: -> {"name":
	repaired = regexp.MustCompile(`([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)`).ReplaceAllString(repaired, `$1"$2"$3`)

	if err := json.Unmarshal([]byte(repaired), &out); err == nil {
		return out
	}
	return nil
}

// argumentsString normalises a parsed arguments value into a JSON string.
//
// The wire format carries arguments as a STRING even though it holds an object. A
// client that receives an object either double-decodes or rejects it, so the
// conversion happens here.
func argumentsString(value any) string {
	switch v := value.(type) {
	case nil:
		return "{}"
	case string:
		if strings.TrimSpace(v) == "" {
			return "{}"
		}
		return v
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return "{}"
		}
		return string(raw)
	}
}

// requestedWebToolNames lists the declared tool names.
func requestedWebToolNames(tools []any) []string {
	var names []string
	seen := map[string]bool{}
	for _, tool := range tools {
		name, _ := functionOf(tool)["name"].(string)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}

// resolveRequestedWebToolName matches an emitted name against the declared set.
//
// Matching is exact first, then case-insensitive, then by a normalised form that
// strips separators — models routinely emit `read_file` for a declared `readFile`.
// A name that still does not resolve is refused rather than passed through, since
// the client would try to execute a tool it never declared.
func resolveRequestedWebToolName(emitted string, requested []string) string {
	emitted = strings.TrimSpace(emitted)
	if emitted == "" {
		return ""
	}
	for _, n := range requested {
		if n == emitted {
			return n
		}
	}
	for _, n := range requested {
		if strings.EqualFold(n, emitted) {
			return n
		}
	}

	norm := func(s string) string {
		s = strings.ToLower(s)
		for _, sep := range []string{"_", "-", ".", " "} {
			s = strings.ReplaceAll(s, sep, "")
		}
		return s
	}
	target := norm(emitted)
	for _, n := range requested {
		if norm(n) == target {
			return n
		}
	}
	return ""
}

// ── DSML ─────────────────────────────────────────────────────────────────────

// dsmlBlockRE matches the DeepSeek markup-language tool call.
var dsmlBlockRE = regexp.MustCompile(`(?s)<[｜|]DSML[｜|]tool_calls?>(.*?)</[｜|]DSML[｜|]tool_calls?>`)
var dsmlInvokeRE = regexp.MustCompile(`(?s)<[｜|]DSML[｜|]invoke\s+name="([^"]+)"[^>]*>(.*?)</[｜|]DSML[｜|]invoke>`)
var dsmlParamRE = regexp.MustCompile(`(?s)<[｜|]DSML[｜|]parameter\s+name="([^"]+)"[^>]*>(.*?)</[｜|]DSML[｜|]parameter>`)

// HasDSMLToolCalls reports whether the text contains a DSML tool call.
func HasDSMLToolCalls(text string) bool {
	return strings.Contains(text, "DSML") && (strings.Contains(text, "tool_calls") || strings.Contains(text, "invoke"))
}

// ParseDSMLToolCalls converts DSML markup into standard tool calls.
//
// Parameters arrive as individual named tags rather than one JSON object, so they
// are collected and marshalled back into the arguments object the wire format
// expects.
func ParseDSMLToolCalls(text string) ([]WebToolCall, string, bool) {
	if !HasDSMLToolCalls(text) {
		return nil, text, false
	}

	var calls []WebToolCall
	accepted := [][2]int{}

	for _, block := range dsmlBlockRE.FindAllStringSubmatchIndex(text, -1) {
		inner := text[block[2]:block[3]]
		for _, inv := range dsmlInvokeRE.FindAllStringSubmatch(inner, -1) {
			name := inv[1]
			if strings.TrimSpace(name) == "" {
				continue
			}
			args := map[string]any{}
			for _, p := range dsmlParamRE.FindAllStringSubmatch(inv[2], -1) {
				args[p[1]] = coerceDSMLValue(strings.TrimSpace(p[2]))
			}
			raw, _ := json.Marshal(args)
			calls = append(calls, WebToolCall{
				ID:       fmt.Sprintf("call_%d", len(calls)),
				Type:     "function",
				Function: WebToolFunction{Name: name, Arguments: string(raw)},
			})
		}
		accepted = append(accepted, [2]int{block[0], block[1]})
	}

	if len(calls) == 0 {
		return nil, text, false
	}
	// The DSML envelope is not prose, so it is removed entirely rather than left
	// for the client to display.
	return calls, stripRanges(text, accepted), true
}

// coerceDSMLValue turns a DSML parameter's text into a typed value.
//
// DSML carries everything as text, so a number or boolean parameter would reach
// the client as a string and fail its own type check. JSON-shaped text is decoded;
// a bare literal is converted; anything else stays a string.
func coerceDSMLValue(raw string) any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if raw == "true" {
		return true
	}
	if raw == "false" {
		return false
	}
	if raw == "null" {
		return nil
	}
	if n, err := parseFloatStrict(raw); err == nil {
		return n
	}
	// A JSON object or array arrives as text and must be decoded so the client
	// sees a structure, not a string containing one.
	if (strings.HasPrefix(raw, "{") && strings.HasSuffix(raw, "}")) ||
		(strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]")) {
		var v any
		if err := json.Unmarshal([]byte(raw), &v); err == nil {
			return v
		}
	}
	return raw
}

// parseFloatStrict parses a decimal number, rejecting surrounding garbage.
func parseFloatStrict(s string) (float64, error) {
	var v float64
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return 0, err
	}
	// A quoted number would decode into a string, not here, so a successful decode
	// means the whole token was numeric.
	return v, nil
}
