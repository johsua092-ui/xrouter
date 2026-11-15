package translate

// Port of open-sse/translator/concerns/kiroConversation.js.
//
// Kiro's GenerateAssistantResponse is stricter than any other upstream in this
// engine. It requires strictly alternating user/assistant turns, a non-empty
// current user turn, one-to-one adjacency between assistant toolUses and the tool
// results in the following user turn, unique tool-call ids, and tool specs that
// reference only names declared on the current turn. Violating any of those is
// 400 REQUEST_BODY_INVALID — a terminal status that burns a per-account cooldown.
//
// So this file is the reconciler. It normalises whatever the client sent into a
// shape Kiro accepts, repairing (not rejecting) the repairable cases and
// reporting a taxonomy when a body cannot be made shippable:
//
//	role:N    turn N is not the role its position requires
//	pair:N    assistant turn N's toolUses do not match the next user turn's results
//	id:N      a tool-call id is missing or duplicated
//	spec:N    a tool call names a tool that is not in the declared specs
//	orphan:0  the conversation opens with tool results and no preceding call
//	current   the current user turn has no content
//
// Failing locally on that taxonomy costs nothing. Sending the body and getting a
// 400 costs an upstream call and a cooldown.

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Kiro tool-spec limits. Kiro truncates rather than rejects on name/description
// length, which produces a silently wrong tool surface, so the limits are applied
// here where the truncation is visible.
const (
	kiroToolNameMaxLength        = 64
	kiroToolDescriptionMaxLength = 10237
	kiroToolIDMaxLength          = 64
)

// Tool-result placeholders. Kiro rejects a user turn with empty content, so a
// turn that carries only tool results needs text. The wording matters: with
// "continue" the model answers the word itself ("Nothing in progress to
// continue") and drops the task it was mid-way through.
const (
	kiroToolResultsPlaceholder = "Tool results provided."
	kiroEmptyUserPlaceholder   = "continue"
)

// kiroToolNamePattern is the character class Kiro accepts in a tool name.
var kiroToolNamePattern = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// kiroToolIDPattern is the character class Kiro accepts in a tool-call id.
var kiroToolIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func kiroEmptyUserContent(hasToolResults bool) string {
	if hasToolResults {
		return kiroToolResultsPlaceholder
	}
	return kiroEmptyUserPlaceholder
}

// ── small helpers ────────────────────────────────────────────────────────────

func kiroClone(v any) any {
	if v == nil {
		return nil
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

// kiroText stringifies a value the way the reconciler needs it. A non-string
// becomes its JSON encoding, because the alternative — fmt's %v — produces
// `map[a:b]` for a map and silently corrupts flattened tool results.
func kiroText(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(raw)
}

func kiroAppendText(target map[string]any, extra string) {
	if extra == "" {
		return
	}
	cur, _ := target["content"].(string)
	if cur != "" {
		target["content"] = cur + "\n\n" + extra
		return
	}
	target["content"] = extra
}

// kiroTrimCodePoints truncates on a rune boundary, not a byte boundary. Kiro
// counts code points, so a byte-truncated multi-byte character would leave an
// invalid tail.
func kiroTrimCodePoints(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// kiroUniqueName sanitises a tool name and de-duplicates it, since two tools may
// arrive with names that collapse to the same Kiro-legal string.
func kiroUniqueName(rawName string, index int, used map[string]bool) string {
	cleaned := strings.TrimSpace(rawName)
	cleaned = kiroToolNamePattern.ReplaceAllString(cleaned, "_")
	cleaned = strings.Trim(cleaned, "_")
	base := kiroTrimCodePoints(cleaned, kiroToolNameMaxLength)
	if base == "" {
		base = kiroTrimCodePoints(sprintfTool("tool_%d", index+1), kiroToolNameMaxLength)
	}
	candidate := base
	suffix := 2
	for used[candidate] {
		tail := sprintfTool("_%d", suffix)
		suffix++
		keep := kiroToolNameMaxLength - len([]rune(tail))
		if keep < 0 {
			keep = 0
		}
		candidate = kiroTrimCodePoints(base, keep) + tail
	}
	used[candidate] = true
	return candidate
}

func sprintfTool(format string, args ...any) string {
	out := format
	for _, a := range args {
		out = strings.Replace(out, "%d", itoaInt(a), 1)
	}
	return out
}

func itoaInt(v any) string {
	n, ok := v.(int)
	if !ok {
		return "0"
	}
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		return "-" + string(digits)
	}
	return string(digits)
}

// ── schema normalisation ─────────────────────────────────────────────────────

// kiroCleanSchemaValue strips schema keywords Kiro's validator rejects.
//
// `additionalProperties` is rejected outright, and an empty `required` array is
// too. Both are legal JSON Schema that other providers accept, so a tool
// definition written for Claude or OpenAI can 400 the whole request here.
func kiroCleanSchemaValue(value any) any {
	switch t := value.(type) {
	case []any:
		out := make([]any, 0, len(t))
		for _, child := range t {
			out = append(out, kiroCleanSchemaValue(child))
		}
		return out
	case map[string]any:
		cleaned := map[string]any{}
		for key, child := range t {
			if key == "additionalProperties" {
				continue
			}
			if key == "required" {
				if arr, ok := child.([]any); ok && len(arr) == 0 {
					continue
				}
			}
			cleaned[key] = kiroCleanSchemaValue(child)
		}
		return cleaned
	}
	return value
}

// kiroNormalizeRootSchema forces the root schema into the shape Kiro expects: an
// object with a properties map, and a `required` list containing only names that
// actually exist in `properties`.
func kiroNormalizeRootSchema(schema any) map[string]any {
	input := map[string]any{}
	if m, ok := schema.(map[string]any); ok {
		if cloned, ok := kiroClone(m).(map[string]any); ok {
			input = cloned
		}
	}
	cleaned, _ := kiroCleanSchemaValue(input).(map[string]any)
	if cleaned == nil {
		cleaned = map[string]any{}
	}
	cleaned["type"] = "object"

	props, ok := cleaned["properties"].(map[string]any)
	if !ok || props == nil {
		cleaned["properties"] = map[string]any{}
		props = map[string]any{}
	}

	if required, ok := cleaned["required"].([]any); ok {
		kept := make([]any, 0, len(required))
		seen := map[string]bool{}
		for _, name := range required {
			s, isStr := name.(string)
			if !isStr || seen[s] {
				continue
			}
			if _, exists := props[s]; !exists {
				continue
			}
			seen[s] = true
			kept = append(kept, s)
		}
		if len(kept) == 0 {
			delete(cleaned, "required")
		} else {
			cleaned["required"] = kept
		}
	}
	return cleaned
}

// KiroToolSpec is one entry in the Kiro tool surface.
type KiroToolSpec struct {
	ToolSpecification struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		InputSchema map[string]any `json:"inputSchema"`
	} `json:"toolSpecification"`
}

// NormalizeKiroToolSpecs folds OpenAI- and Claude-shaped tool definitions into
// Kiro tool specs.
//
// The returned name map is the sanitisation map (original → Kiro-legal). It has
// to survive to the response path, because Kiro streams tool calls back under the
// sanitised name and the client must see its own name.
func NormalizeKiroToolSpecs(tools []any) ([]any, map[string]string) {
	specs := []any{}
	nameMap := map[string]string{}
	usedNames := map[string]bool{}

	for index, raw := range tools {
		tool, ok := raw.(map[string]any)
		if !ok || tool == nil {
			continue
		}

		var rawName string
		var description string
		var schema any
		if fn, ok := tool["function"].(map[string]any); ok {
			rawName, _ = fn["name"].(string)
			description, _ = fn["description"].(string)
			schema = fn["parameters"]
		} else {
			rawName, _ = tool["name"].(string)
			description, _ = tool["description"].(string)
			if s, ok := tool["parameters"]; ok {
				schema = s
			} else {
				schema = tool["input_schema"]
			}
		}

		if strings.TrimSpace(rawName) == "" {
			continue
		}
		// A repeated definition with the same source name describes the same
		// tool; the first one wins.
		if _, dup := nameMap[rawName]; dup {
			continue
		}

		name := kiroUniqueName(rawName, index, usedNames)
		nameMap[rawName] = name

		if description == "" {
			description = "Tool: " + rawName
		}
		description = kiroTrimCodePoints(description, kiroToolDescriptionMaxLength)

		if schema == nil {
			schema = map[string]any{}
		}

		spec := KiroToolSpec{}
		spec.ToolSpecification.Name = name
		spec.ToolSpecification.Description = description
		spec.ToolSpecification.InputSchema = map[string]any{
			"json": kiroNormalizeRootSchema(schema),
		}
		specs = append(specs, spec)
	}

	return specs, nameMap
}

// ── turn normalisation ───────────────────────────────────────────────────────

func kiroToolCallText(name string, input any) string {
	if name == "" {
		name = "unknown"
	}
	return "[Tool call: " + name + "(" + kiroText(input) + ")]"
}

func kiroToolResultText(result map[string]any) string {
	var content string
	if arr, ok := result["content"].([]any); ok {
		parts := make([]string, 0, len(arr))
		for _, rawPart := range arr {
			if part, ok := rawPart.(map[string]any); ok {
				if text, ok := part["text"]; ok {
					parts = append(parts, kiroText(text))
					continue
				}
			}
			parts = append(parts, kiroText(rawPart))
		}
		filtered := parts[:0]
		for _, p := range parts {
			if p != "" {
				filtered = append(filtered, p)
			}
		}
		content = strings.Join(filtered, "\n")
	} else {
		content = kiroText(result["content"])
	}
	suffix := ""
	if status, _ := result["status"].(string); status == "error" {
		suffix = " (error)"
	}
	return "[Tool result" + suffix + ": " + content + "]"
}

func kiroMergeUser(target, source map[string]any) {
	kiroAppendText(target, kiroStringOr(source["content"]))

	if images, ok := source["images"].([]any); ok && len(images) > 0 {
		existing, _ := target["images"].([]any)
		target["images"] = append(append([]any{}, existing...), images...)
	}

	sourceCtx, _ := source["userInputMessageContext"].(map[string]any)
	if sourceCtx == nil {
		return
	}
	sourceResults, _ := sourceCtx["toolResults"].([]any)
	if len(sourceResults) == 0 {
		return
	}
	targetCtx, _ := target["userInputMessageContext"].(map[string]any)
	if targetCtx == nil {
		targetCtx = map[string]any{}
		target["userInputMessageContext"] = targetCtx
	}
	existing, _ := targetCtx["toolResults"].([]any)
	targetCtx["toolResults"] = append(append([]any{}, existing...), sourceResults...)
}

func kiroMergeAssistant(target, source map[string]any) {
	kiroAppendText(target, kiroStringOr(source["content"]))
	if toolUses, ok := source["toolUses"].([]any); ok && len(toolUses) > 0 {
		existing, _ := target["toolUses"].([]any)
		target["toolUses"] = append(append([]any{}, existing...), toolUses...)
	}
}

func kiroStringOr(v any) string {
	s, _ := v.(string)
	return s
}

// kiroNormalizeTurns flattens a raw history + currentMessage into a turn list
// with alternating roles, merging consecutive same-role turns.
//
// A leading assistant turn and a trailing assistant turn both break the
// alternation Kiro requires, so a synthetic "continue" user turn is inserted at
// either end. An empty user turn is given placeholder content, because empty
// content is a rejection.
func kiroNormalizeTurns(history []any, currentMessage map[string]any, modelID string) []map[string]any {
	rawTurns := append([]any{}, history...)
	if currentMessage != nil {
		rawTurns = append(rawTurns, currentMessage)
	}

	turns := []map[string]any{}
	for _, raw := range rawTurns {
		m, ok := raw.(map[string]any)
		if !ok || m == nil {
			continue
		}
		userMsg, hasUser := m["userInputMessage"]
		assistantMsg, hasAssistant := m["assistantResponseMessage"]
		// Exactly one side must be present; a turn claiming both (or neither)
		// cannot be classified and is dropped rather than guessed at.
		if hasUser == hasAssistant {
			continue
		}

		var turn map[string]any
		if hasUser {
			cloned, _ := kiroClone(userMsg).(map[string]any)
			turn = map[string]any{"userInputMessage": cloned}
			if prev := lastTurn(turns); prev != nil {
				if prevUser, ok := prev["userInputMessage"].(map[string]any); ok {
					kiroMergeUser(prevUser, cloned)
					continue
				}
			}
		} else {
			cloned, _ := kiroClone(assistantMsg).(map[string]any)
			turn = map[string]any{"assistantResponseMessage": cloned}
			if prev := lastTurn(turns); prev != nil {
				if prevAssistant, ok := prev["assistantResponseMessage"].(map[string]any); ok {
					kiroMergeAssistant(prevAssistant, cloned)
					continue
				}
			}
		}
		turns = append(turns, turn)
	}

	if len(turns) > 0 {
		if _, ok := turns[0]["assistantResponseMessage"]; ok {
			turns = append([]map[string]any{{
				"userInputMessage": map[string]any{"content": "continue", "modelId": modelID},
			}}, turns...)
		}
	}
	if len(turns) == 0 {
		turns = append(turns, map[string]any{
			"userInputMessage": map[string]any{"content": "continue", "modelId": modelID},
		})
	} else if _, ok := turns[len(turns)-1]["assistantResponseMessage"]; ok {
		turns = append(turns, map[string]any{
			"userInputMessage": map[string]any{"content": "continue", "modelId": modelID},
		})
	}

	for _, turn := range turns {
		if user, ok := turn["userInputMessage"].(map[string]any); ok {
			content := strings.TrimSpace(kiroText(user["content"]))
			if content == "" {
				hasResults := false
				if ctx, ok := user["userInputMessageContext"].(map[string]any); ok {
					if results, ok := ctx["toolResults"].([]any); ok {
						hasResults = len(results) > 0
					}
				}
				content = kiroEmptyUserContent(hasResults)
			}
			user["content"] = content
			if _, has := user["modelId"]; !has {
				user["modelId"] = modelID
			}
			// Tool specs are only legal on the current turn. An earlier turn
			// carrying them is a rejection, so they are stripped here and added
			// back on the final turn by the canonicalizer.
			if ctx, ok := user["userInputMessageContext"].(map[string]any); ok {
				delete(ctx, "tools")
			}
			continue
		}
		if assistant, ok := turn["assistantResponseMessage"].(map[string]any); ok {
			content := strings.TrimSpace(kiroText(assistant["content"]))
			if content == "" {
				content = "..."
			}
			assistant["content"] = content
		}
	}

	return turns
}

func lastTurn(turns []map[string]any) map[string]any {
	if len(turns) == 0 {
		return nil
	}
	return turns[len(turns)-1]
}

// ── tool pairing ─────────────────────────────────────────────────────────────

func kiroRawID(v any) string {
	s, _ := v.(string)
	return s
}

// kiroReserveToolID picks a unique, Kiro-legal tool-call id.
//
// Ids must match ^[a-zA-Z0-9_-]+$ and be unique across the conversation. A
// client-supplied id that fails either test is replaced by a deterministic
// generated one rather than dropped, so the call/result pairing survives.
func kiroReserveToolID(value any, turnIndex, callIndex int, name string, usedIDs map[string]bool) string {
	sanitized := kiroToolNamePattern.ReplaceAllString(kiroRawID(value), "")
	generated := sprintfTool("call_msg%d_tc%d_", turnIndex, callIndex) + name
	if name == "" {
		generated = sprintfTool("call_msg%d_tc%d_", turnIndex, callIndex) + "tool"
	}

	base := generated
	if sanitized != "" && kiroToolIDPattern.MatchString(sanitized) {
		base = sanitized
	}
	base = kiroTrimCodePoints(base, kiroToolIDMaxLength)

	candidate := base
	suffix := 2
	for usedIDs[candidate] {
		tail := sprintfTool("_%d", suffix)
		suffix++
		keep := kiroToolIDMaxLength - len([]rune(tail))
		if keep < 0 {
			keep = 0
		}
		candidate = kiroTrimCodePoints(base, keep) + tail
	}
	usedIDs[candidate] = true
	return candidate
}

// kiroNormalizeToolInput returns the call's input as a map, or nil when it cannot
// be one. nil is the "unusable" signal: a tool call whose arguments are not an
// object cannot be represented in Kiro's schema and has to be flattened to text.
func kiroNormalizeToolInput(input any) map[string]any {
	switch t := input.(type) {
	case nil:
		return map[string]any{}
	case map[string]any:
		cloned, _ := kiroClone(t).(map[string]any)
		return cloned
	case string:
		var parsed map[string]any
		if err := json.Unmarshal([]byte(t), &parsed); err != nil {
			return nil
		}
		if parsed == nil {
			return nil
		}
		return parsed
	}
	return nil
}

func kiroNormalizeToolResult(result map[string]any) map[string]any {
	content := []any{}
	if arr, ok := result["content"].([]any); ok {
		for _, rawPart := range arr {
			if part, ok := rawPart.(map[string]any); ok {
				if text, has := part["text"]; has {
					content = append(content, map[string]any{"text": kiroText(text)})
					continue
				}
			}
			content = append(content, map[string]any{"text": kiroText(rawPart)})
		}
	} else {
		content = append(content, map[string]any{"text": kiroText(result["content"])})
	}
	if len(content) == 0 {
		content = append(content, map[string]any{"text": ""})
	}

	status := "success"
	if s, _ := result["status"].(string); s == "error" {
		status = "error"
	}
	return map[string]any{
		"toolUseId": kiroRawID(result["toolUseId"]),
		"status":    status,
		"content":   content,
	}
}

func kiroFlattenResults(userMessage map[string]any, results []map[string]any) {
	for _, result := range results {
		kiroAppendText(userMessage, kiroToolResultText(result))
	}
}

// kiroCleanUserContext deletes context keys that Kiro rejects when empty. An
// empty toolResults array and an empty tools array are both rejections, so the
// key is removed rather than sent empty.
func kiroCleanUserContext(userMessage map[string]any) {
	ctx, ok := userMessage["userInputMessageContext"].(map[string]any)
	if !ok || ctx == nil {
		return
	}
	if results, ok := ctx["toolResults"].([]any); !ok || len(results) == 0 {
		delete(ctx, "toolResults")
	}
	if tools, ok := ctx["tools"].([]any); !ok || len(tools) == 0 {
		delete(ctx, "tools")
	}
	if len(ctx) == 0 {
		delete(userMessage, "userInputMessageContext")
	}
}

// kiroReconcileToolPair enforces one-to-one adjacency between an assistant turn's
// toolUses and the following user turn's toolResults.
//
// Anything that cannot be paired is flattened into text rather than dropped: the
// model still needs to see that a call was made or a result came back, even when
// the structured form is not representable. Dropping it would silently remove
// part of the conversation.
func kiroReconcileToolPair(assistant, user map[string]any, turnIndex int, nameMap map[string]string, specNames map[string]bool, usedIDs map[string]bool, repairs *kiroRepairs) {
	calls, _ := assistant["toolUses"].([]any)
	rawResults, _ := kiroResultList(user)

	results := make([]map[string]any, 0, len(rawResults))
	for _, raw := range rawResults {
		if m, ok := raw.(map[string]any); ok {
			results = append(results, kiroNormalizeToolResult(m))
		}
	}

	if len(calls) == 0 {
		if len(results) > 0 {
			kiroFlattenResults(user, results)
			repairs.orphanResults += len(results)
		}
		if ctx, ok := user["userInputMessageContext"].(map[string]any); ok {
			delete(ctx, "toolResults")
		}
		kiroCleanUserContext(user)
		return
	}

	type callRecord struct {
		call      map[string]any
		callIndex int
		key       string
		mapped    string
		input     map[string]any
		// inputValid distinguishes "the arguments were an empty object" from
		// "the arguments could not be parsed as an object at all".
		inputValid bool
		result     map[string]any
	}

	callQueues := map[string][]*callRecord{}
	records := make([]*callRecord, 0, len(calls))

	for callIndex, raw := range calls {
		call, ok := raw.(map[string]any)
		if !ok {
			call = map[string]any{}
		}
		key := kiroRawID(call["toolUseId"])
		callName, _ := call["name"].(string)
		mapped := callName
		if mappedName, has := nameMap[callName]; has {
			mapped = mappedName
		}

		input := kiroNormalizeToolInput(call["input"])
		record := &callRecord{
			call:       call,
			callIndex:  callIndex,
			key:        key,
			mapped:     mapped,
			input:      input,
			inputValid: input != nil,
		}
		if input == nil {
			record.input = map[string]any{}
		}
		callQueues[key] = append(callQueues[key], record)
		records = append(records, record)
	}

	orphanResults := []map[string]any{}
	for _, result := range results {
		queue := callQueues[result["toolUseId"].(string)]
		var matched *callRecord
		for _, candidate := range queue {
			if candidate.result == nil {
				matched = candidate
				break
			}
		}
		if matched != nil {
			matched.result = result
			continue
		}
		orphanResults = append(orphanResults, result)
	}

	keptCalls := []any{}
	keptResults := []any{}

	for _, record := range records {
		_, hasSpec := specNames[record.mapped]
		valid := record.result != nil && hasSpec && record.inputValid
		if !valid {
			kiroAppendText(assistant, kiroToolCallText(record.mapped, record.call["input"]))
			if record.result == nil {
				repairs.missingResults++
			}
			if !hasSpec || !record.inputValid {
				repairs.invalidToolUses++
			}
			if record.result != nil {
				kiroFlattenResults(user, []map[string]any{record.result})
				repairs.orphanResults++
			}
			continue
		}

		toolUseID := kiroReserveToolID(record.key, turnIndex, record.callIndex, record.mapped, usedIDs)
		keptCalls = append(keptCalls, map[string]any{
			"toolUseId": toolUseID,
			"name":      record.mapped,
			"input":     record.input,
		})
		finalised := map[string]any{}
		for k, v := range record.result {
			finalised[k] = v
		}
		finalised["toolUseId"] = toolUseID
		keptResults = append(keptResults, finalised)
	}

	if len(orphanResults) > 0 {
		kiroFlattenResults(user, orphanResults)
		repairs.orphanResults += len(orphanResults)
	}

	if len(keptCalls) > 0 {
		assistant["toolUses"] = keptCalls
	} else {
		delete(assistant, "toolUses")
	}

	ctx, _ := user["userInputMessageContext"].(map[string]any)
	if ctx == nil {
		ctx = map[string]any{}
		user["userInputMessageContext"] = ctx
	}
	if len(keptResults) > 0 {
		ctx["toolResults"] = keptResults
	} else {
		delete(ctx, "toolResults")
	}
	kiroCleanUserContext(user)
}

func kiroResultList(user map[string]any) ([]any, bool) {
	ctx, ok := user["userInputMessageContext"].(map[string]any)
	if !ok || ctx == nil {
		return nil, false
	}
	results, ok := ctx["toolResults"].([]any)
	return results, ok
}

// ── canonicalization ─────────────────────────────────────────────────────────

type kiroRepairs struct {
	missingResults  int
	orphanResults   int
	invalidToolUses int
}

// KiroConversation is the reconciled result handed to the payload builder.
type KiroConversation struct {
	History        []any
	CurrentMessage map[string]any
	Repairs        map[string]int
	Valid          bool
	Errors         []string
}

// CanonicalizeKiroConversation produces a strict Kiro conversation: alternating
// turns, a populated current user turn, adjacent one-to-one tool pairs, and tool
// specs only on the current turn.
//
// When the first pass still fails validation, a second pass flattens every
// structured tool turn to text and re-validates. That is the last repair
// available; a body that still fails cannot be made shippable, and Invalid is
// returned so the caller can 400 locally instead of spending an upstream call.
func CanonicalizeKiroConversation(history []any, currentMessage map[string]any, modelID string, toolSpecs []any, nameMap map[string]string) KiroConversation {
	turns := kiroNormalizeTurns(history, currentMessage, modelID)
	repairs := kiroRepairs{}

	specNames := map[string]bool{}
	for _, rawSpec := range toolSpecs {
		spec, ok := rawSpec.(KiroToolSpec)
		if !ok {
			if m, isMap := rawSpec.(map[string]any); isMap {
				if ts, ok := m["toolSpecification"].(map[string]any); ok {
					if name, ok := ts["name"].(string); ok && name != "" {
						specNames[name] = true
					}
				}
			}
			continue
		}
		if spec.ToolSpecification.Name != "" {
			specNames[spec.ToolSpecification.Name] = true
		}
	}

	usedIDs := map[string]bool{}

	for index := 0; index < len(turns); index += 2 {
		user, ok := turns[index]["userInputMessage"].(map[string]any)
		if !ok {
			continue
		}
		// A conversation may not open with tool results: there is no call for
		// them to answer, and Kiro rejects the orphan.
		if index == 0 {
			if leading, ok := kiroResultList(user); ok && len(leading) > 0 {
				normalised := make([]map[string]any, 0, len(leading))
				for _, raw := range leading {
					if m, ok := raw.(map[string]any); ok {
						normalised = append(normalised, kiroNormalizeToolResult(m))
					}
				}
				kiroFlattenResults(user, normalised)
				repairs.orphanResults += len(leading)
				if ctx, ok := user["userInputMessageContext"].(map[string]any); ok {
					delete(ctx, "toolResults")
				}
				kiroCleanUserContext(user)
			}
		}

		var assistant map[string]any
		if index+1 < len(turns) {
			assistant, _ = turns[index+1]["assistantResponseMessage"].(map[string]any)
		}
		var nextUser map[string]any
		if index+2 < len(turns) {
			nextUser, _ = turns[index+2]["userInputMessage"].(map[string]any)
		}
		if assistant != nil && nextUser != nil {
			kiroReconcileToolPair(assistant, nextUser, index+1, nameMap, specNames, usedIDs, &repairs)
		}
	}

	finalCurrent := turns[len(turns)-1]
	finalUser, _ := finalCurrent["userInputMessage"].(map[string]any)
	if finalUser == nil {
		finalUser = map[string]any{"content": "continue"}
		finalCurrent["userInputMessage"] = finalUser
	}
	ctx, _ := finalUser["userInputMessageContext"].(map[string]any)
	if ctx == nil {
		ctx = map[string]any{}
		finalUser["userInputMessageContext"] = ctx
	}
	// Tool specs belong only here. Sending them on any earlier turn is a
	// rejection, which is why kiroNormalizeTurns strips them everywhere else.
	if len(toolSpecs) > 0 {
		ctx["tools"] = specListToAny(toolSpecs)
	}
	kiroCleanUserContext(finalUser)

	finalHistory := anySliceFromTurns(turns[:len(turns)-1])
	validation := validateKiroConversation(finalHistory, finalCurrent, specNames)

	if !validation.Valid {
		kiroFlattenAllStructuredTools(turns, &repairs)
		finalHistory = anySliceFromTurns(turns[:len(turns)-1])
		finalCurrent = turns[len(turns)-1]
		finalUser, _ = finalCurrent["userInputMessage"].(map[string]any)
		if finalUser != nil {
			ctx, _ := finalUser["userInputMessageContext"].(map[string]any)
			if ctx == nil {
				ctx = map[string]any{}
				finalUser["userInputMessageContext"] = ctx
			}
			if len(toolSpecs) > 0 {
				ctx["tools"] = specListToAny(toolSpecs)
			}
			kiroCleanUserContext(finalUser)
		}
		validation = validateKiroConversation(finalHistory, finalCurrent, specNames)
	}

	return KiroConversation{
		History:        finalHistory,
		CurrentMessage: finalCurrent,
		Repairs: map[string]int{
			"missingResults":  repairs.missingResults,
			"orphanResults":   repairs.orphanResults,
			"invalidToolUses": repairs.invalidToolUses,
		},
		Valid:  validation.Valid,
		Errors: validation.Errors,
	}
}

func specListToAny(specs []any) []any {
	out := make([]any, 0, len(specs))
	for _, spec := range specs {
		switch t := spec.(type) {
		case KiroToolSpec:
			out = append(out, t)
		default:
			out = append(out, spec)
		}
	}
	return out
}

func anySliceFromTurns(turns []map[string]any) []any {
	out := make([]any, 0, len(turns))
	for _, turn := range turns {
		out = append(out, turn)
	}
	return out
}

// kiroValidation is the outcome of the structural check.
type kiroValidation struct {
	Valid  bool
	Errors []string
}

// validateKiroConversation checks the wire conversation without mutating it.
//
// This is a structural check, not a semantic one: it verifies the invariants Kiro
// enforces (alternation, pairing, id uniqueness, spec membership) and names the
// failing turn so a rejection can be diagnosed from the log alone.
func validateKiroConversation(history []any, currentMessage map[string]any, specNames map[string]bool) kiroValidation {
	errors := []string{}
	turns := append([]any{}, history...)
	if currentMessage != nil {
		turns = append(turns, currentMessage)
	}
	usedIDs := map[string]bool{}

	for index := 0; index < len(turns); index++ {
		turn, _ := turns[index].(map[string]any)
		if turn == nil {
			continue
		}
		expectedUser := index%2 == 0
		user, isUser := turn["userInputMessage"].(map[string]any)
		if isUser != expectedUser {
			errors = append(errors, sprintfTool("role:%d", index))
		}
		if isUser {
			if index == 0 {
				if results, ok := kiroResultList(user); ok && len(results) > 0 {
					errors = append(errors, "orphan:0")
				}
			}
			continue
		}

		assistant, _ := turn["assistantResponseMessage"].(map[string]any)
		calls, _ := assistant["toolUses"].([]any)

		var results []any
		if index+1 < len(turns) {
			if nextTurn, ok := turns[index+1].(map[string]any); ok {
				if nextUser, ok := nextTurn["userInputMessage"].(map[string]any); ok {
					results, _ = kiroResultList(nextUser)
				}
			}
		}

		callIDs := make([]string, 0, len(calls))
		for _, raw := range calls {
			call, _ := raw.(map[string]any)
			callIDs = append(callIDs, kiroRawID(call["toolUseId"]))
		}
		resultIDs := map[string]bool{}
		for _, raw := range results {
			result, _ := raw.(map[string]any)
			resultIDs[kiroRawID(result["toolUseId"])] = true
		}

		if len(calls) != len(results) {
			errors = append(errors, sprintfTool("pair:%d", index))
		} else {
			for _, id := range callIDs {
				if !resultIDs[id] {
					errors = append(errors, sprintfTool("pair:%d", index))
					break
				}
			}
		}

		for _, raw := range calls {
			call, _ := raw.(map[string]any)
			id := kiroRawID(call["toolUseId"])
			if id == "" || usedIDs[id] {
				errors = append(errors, sprintfTool("id:%d", index))
			}
			usedIDs[id] = true
			name, _ := call["name"].(string)
			if !specNames[name] {
				errors = append(errors, sprintfTool("spec:%d", index))
			}
		}
	}

	if currentMessage == nil {
		errors = append(errors, "current")
	} else if user, ok := currentMessage["userInputMessage"].(map[string]any); !ok || kiroStringOr(user["content"]) == "" {
		errors = append(errors, "current")
	}

	return kiroValidation{Valid: len(errors) == 0, Errors: errors}
}

// kiroFlattenAllStructuredTools is the second-chance repair: convert every
// structured tool turn to plain text and drop the structure entirely.
//
// This loses tool-call fidelity, which is why it runs only after the structural
// check has already failed. The alternative is a guaranteed 400.
func kiroFlattenAllStructuredTools(turns []map[string]any, repairs *kiroRepairs) {
	for _, turn := range turns {
		if assistant, ok := turn["assistantResponseMessage"].(map[string]any); ok {
			if toolUses, ok := assistant["toolUses"].([]any); ok && len(toolUses) > 0 {
				for _, raw := range toolUses {
					call, _ := raw.(map[string]any)
					name, _ := call["name"].(string)
					kiroAppendText(assistant, kiroToolCallText(name, call["input"]))
				}
				repairs.invalidToolUses += len(toolUses)
				delete(assistant, "toolUses")
			}
		}
		user, ok := turn["userInputMessage"].(map[string]any)
		if !ok {
			continue
		}
		if results, ok := kiroResultList(user); ok && len(results) > 0 {
			normalised := make([]map[string]any, 0, len(results))
			for _, raw := range results {
				if m, ok := raw.(map[string]any); ok {
					normalised = append(normalised, kiroNormalizeToolResult(m))
				}
			}
			kiroFlattenResults(user, normalised)
			repairs.orphanResults += len(results)
			if ctx, ok := user["userInputMessageContext"].(map[string]any); ok {
				delete(ctx, "toolResults")
			}
			kiroCleanUserContext(user)
		}
	}
}
