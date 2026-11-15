// Package providers — kiro.go ports open-sse/executors/kiro.js and the Kiro
// half of open-sse/translator/ (request/{openai,claude}-to-kiro.js,
// response/kiro-to-openai.js, concerns/kiroConversation.js, utils/kiroSessionReplay.js,
// config/kiroConstants.js).
//
// Kiro is the least HTTP-shaped provider in the set, and the port keeps the same
// division of labour the Node engine uses:
//
//   - The *request translator* builds an AWS CodeWhisperer
//     GenerateAssistantResponse payload (conversationState + currentMessage +
//     history + inferenceConfig). That is a body, not a URL trick, so it lives
//     in internal/translate as the FormatKiro request pair.
//   - The *executor* (this file) supplies the endpoint family, the CLI identity
//     headers, the auth-surface ordering, and — the part that has no analogue
//     anywhere else — the AWS EventStream decoder.
//
// EventStream is why this is not an OpenAI-compatible adapter. The upstream
// answers with `application/vnd.amazon.eventstream`, a length-prefixed binary
// framing with CRC32-checksummed preludes and typed headers, NOT SSE. Feed that
// to an SSE scanner and every byte is garbage. So the decoder here turns frames
// into OpenAI chat.completion.chunk SSE, which is the same shape the Node
// executor emits and the same shape the rest of the Go gateway already knows how
// to translate onward.
//
// Three surfaces exist for one regional service, and which one can authenticate
// a token depends on how the account signed in. Kiro deprecated the legacy
// path-style GenerateAssistantResponse on runtime.*.kiro.dev — that gateway now
// answers valid modern payloads with 400 REQUEST_BODY_INVALID, and 400 is
// terminal. So the Amazon surfaces go first for every auth method: they reject a
// foreign token with 401/403, which DO fall through.
package providers

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ── constants ────────────────────────────────────────────────────────────────

const (
	// KiroCodeWhispererTarget is the X-Amz-Target value. The CodeWhisperer host
	// keys routing off it; the amazonaws.com hosts carry it, kiro.dev does not.
	KiroCodeWhispererTarget = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"

	// KiroEventStreamMaxMessage is the protocol ceiling on one frame.
	KiroEventStreamMaxMessage = 24 * 1024 * 1024
	// KiroEventStreamMaxHeaders bounds the header block of one frame.
	KiroEventStreamMaxHeaders = 128 * 1024

	// KiroToolCallBufferMax is the integrity-repair buffer ceiling. The Node
	// original reads KIRO_TOOL_CALL_REPAIR_BUFFER_MAX_BYTES with this default.
	KiroToolCallBufferMax = 8 * 1024 * 1024

	// KiroDefaultContextWindow is the fallback when a model has no advertised
	// capability, used by the /4 token estimator.
	KiroDefaultContextWindow = 200000

	// KiroUserAgent is the SDK identity the upstream fingerprints. Presenting as
	// the Kiro IDE is what gets the CLI auth surface rather than the browser one.
	KiroUserAgent = "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0"

	// KiroDefaultRegion is where the shared profile ARNs live. A connection may
	// override it, and the amazonaws.com hosts are re-regionalised to match.
	KiroDefaultRegion = "us-east-1"

	// KIRO thinking budget floor in the emitted system prefix.
	KiroThinkingBudgetDefault = 16000
	KiroThinkingBudgetMax     = 32000
)

// KiroBaseURLs are the three surfaces of one regional CodeWhisperer service, in
// the order they are tried when no auth-specific reordering applies.
var KiroBaseURLs = []string{
	"https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
	"https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
	"https://q.us-east-1.amazonaws.com/generateAssistantResponse",
}

// kiroDefaultProfileARNs are the shared CodeWhisperer profiles. Builder ID and
// social sign-ins map to different accounts, so sending the wrong one is a 403
// "bearer token invalid" rather than a permissions error.
var kiroDefaultProfileARNs = map[string]string{
	"builder-id": "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX",
	"social":     "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
}

// kiroFallbackStatuses are the endpoint-failure statuses worth trying another
// surface for. A 400 is deliberately absent: a malformed payload cannot be
// repaired by resending it to a different host, so 400 is terminal.
var kiroFallbackStatuses = map[int]bool{401: true, 403: true, 404: true}

// KiroAccountingAuths are the auth methods whose token is bound to a specific
// account or profile. Their resolved profileArn must be sent as-is, or an empty
// string must be sent so CodeWhisperer uses the token's own default — never the
// shared placeholder, which belongs to somebody else's account.
var KiroAccountingAuths = map[string]bool{
	"api_key": true, "idc": true, "external_idp": true,
}

// KiroDefaultProfileARN resolves the shared placeholder ARN for an auth method.
func KiroDefaultProfileARN(authMethod string) string {
	if authMethod == "google" || authMethod == "github" {
		return kiroDefaultProfileARNs["social"]
	}
	return kiroDefaultProfileARNs["builder-id"]
}

// ── model resolution (config/kiroConstants.js) ───────────────────────────────

const (
	KiroAgenticSuffix  = "-agentic"
	KiroThinkingSuffix = "-thinking"

	KiroToolNameMaxLength        = 64
	KiroToolDescriptionMaxLength = 10237
	KiroToolIDMaxLength          = 64
)

// KiroAgenticSystemPrompt is the chunked-write directive injected for synthetic
// `-agentic` variants. Kiro's server times out on multi-hundred-line writes, so
// this is a reliability instruction, not a stylistic one.
const KiroAgenticSystemPrompt = `
# CRITICAL: CHUNKED WRITE PROTOCOL (MANDATORY)

You MUST follow these rules for ALL file operations. Violation causes server timeouts and task failure.

## ABSOLUTE LIMITS
- **MAXIMUM 350 LINES** per single write/edit operation - NO EXCEPTIONS
- **RECOMMENDED 300 LINES** or less for optimal performance
- **NEVER** write entire files in one operation if >300 lines

## MANDATORY CHUNKED WRITE STRATEGY

### For NEW FILES (>300 lines total):
1. FIRST: Write initial chunk (first 250-300 lines) using write_to_file/fsWrite
2. THEN: Append remaining content in 250-300 line chunks using file append operations
3. REPEAT: Continue appending until complete

### For EDITING EXISTING FILES:
1. Use surgical edits (apply_diff/targeted edits) - change ONLY what's needed
2. NEVER rewrite entire files - use incremental modifications
3. Split large refactors into multiple small, focused edits

### For LARGE CODE GENERATION:
1. Generate in logical sections (imports, types, functions separately)
2. Write each section as a separate operation
3. Use append operations for subsequent sections

## EXAMPLES OF CORRECT BEHAVIOR

CORRECT: Writing a 600-line file
- Operation 1: Write lines 1-300 (initial file creation)
- Operation 2: Append lines 301-600

CORRECT: Editing multiple functions
- Operation 1: Edit function A
- Operation 2: Edit function B
- Operation 3: Edit function C

WRONG: Writing 500 lines in single operation -> TIMEOUT
WRONG: Rewriting entire file to change 5 lines -> TIMEOUT
WRONG: Generating massive code blocks without chunking -> TIMEOUT

## WHY THIS MATTERS
- Server has 2-3 minute timeout for operations
- Large writes exceed timeout and FAIL completely
- Chunked writes are FASTER and more RELIABLE
- Failed writes waste time and require retry

REMEMBER: When in doubt, write LESS per operation. Multiple small operations > one large operation.`

// Kiro regexes. Compiling at package scope rather than per request: the model
// fold runs on every Kiro request and these patterns never change.
var (
	kiroAnthropicSnapshotSuffix = regexp.MustCompile(`-\d{8}$`)
	kiroClaudeVersionRe         = regexp.MustCompile(`(?:^|[/.])claude(?:[/.][a-z]+)*[/.](\d+)(?:[/.](\d+))?(?:[/.]|$)`)
	kiroGpt56Re                 = regexp.MustCompile(`(?:^|[/.])gpt[/.]5[/.]6(?:[/.]|$)`)
)

// NormalizeKiroUpstreamModelID folds an Anthropic model id onto the Kiro alias.
//
// Anthropic ships `claude-sonnet-4-5-20250929`; Kiro's
// GenerateAssistantResponse accepts only `claude-sonnet-4.5` and answers
// anything else with 400 INVALID_MODEL_ID. Matching is keyword-based rather than
// an exact-id table so a new snapshot or minor revision does not 400 upstream.
// An unrecognised id passes through so models Kiro adds first still work.
func NormalizeKiroUpstreamModelID(model string) string {
	if model == "" {
		return model
	}
	id := strings.ToLower(kiroAnthropicSnapshotSuffix.ReplaceAllString(model, ""))

	switch {
	case strings.Contains(id, "sonnet"):
		switch {
		case strings.Contains(id, "5.5") || strings.Contains(id, "5-5"):
			return "claude-sonnet-5.5"
		case strings.Contains(id, "4.6") || strings.Contains(id, "4-6"):
			return "claude-sonnet-4.6"
		case strings.Contains(id, "sonnet-5") || strings.Contains(id, "sonnet.5"):
			return "claude-sonnet-5"
		case strings.Contains(id, "4.5") || strings.Contains(id, "4-5"):
			return "claude-sonnet-4.5"
		case strings.Contains(id, "sonnet-4") || strings.Contains(id, "sonnet.4"):
			return "claude-sonnet-4"
		default:
			return "claude-sonnet-4.5"
		}
	case strings.Contains(id, "fable"):
		return "claude-fable-5"
	case strings.Contains(id, "opus"):
		switch {
		case strings.Contains(id, "5.5") || strings.Contains(id, "5-5"):
			return "claude-opus-5.5"
		case strings.Contains(id, "opus-5") || strings.Contains(id, "opus.5") || strings.Contains(id, "opus 5"):
			return "claude-opus-5"
		case strings.Contains(id, "4.8") || strings.Contains(id, "4-8"):
			return "claude-opus-4.8"
		case strings.Contains(id, "4.7") || strings.Contains(id, "4-7"):
			return "claude-opus-4.7"
		case strings.Contains(id, "4.5") || strings.Contains(id, "4-5"):
			return "claude-opus-4.5"
		default:
			return "claude-opus-4.6"
		}
	case strings.Contains(id, "haiku"):
		if strings.Contains(id, "5.5") || strings.Contains(id, "5-5") {
			return "claude-haiku-5.5"
		}
		return "claude-haiku-4.5"
	case id == "auto":
		return "auto"
	case strings.Contains(id, "deepseek"):
		return "deepseek-3.2"
	case strings.Contains(id, "glm"):
		return "glm-5"
	case strings.Contains(id, "minimax"):
		if strings.Contains(id, "2.5") || strings.Contains(id, "2-5") {
			return "minimax-m2.5"
		}
		return "minimax-m2.1"
	case strings.Contains(id, "qwen"):
		return "qwen3-coder-next"
	case strings.Contains(id, "kimi"):
		return "kimi-k3"
	case strings.Contains(id, "gpt"):
		switch {
		case strings.Contains(id, "terra"):
			return "gpt-5.6-terra"
		case strings.Contains(id, "luna"):
			return "gpt-5.6-luna"
		case strings.Contains(id, "sol") || strings.Contains(id, "5.6") || strings.Contains(id, "5-6"):
			return "gpt-5.6-sol"
		}
		return model
	}
	return model
}

// KiroModelResolution is the result of folding a 9router model id down to the
// upstream id plus the behaviours its suffixes implied.
type KiroModelResolution struct {
	// Upstream is the real Kiro model id, suffix-free.
	Upstream string
	// Agentic means the chunked-write system prompt is injected.
	Agentic bool
	// Thinking means the <thinking_mode> prefix is injected when no native
	// effort field is available.
	Thinking bool
}

// ResolveKiroModel strips the synthetic `-agentic` / `-thinking` suffixes and
// folds the remainder onto the upstream alias.
//
// The suffixes are a 9router fiction — Kiro upstream does not advertise those
// model ids — so they must never reach the wire. They may appear in either order
// ("…-agentic-thinking" and "…-thinking-agentic" are the same request), so the
// strip loops until neither remains rather than testing each once. A single pass
// each left the second-order form with a hyphenated id Kiro rejects.
func ResolveKiroModel(model string) KiroModelResolution {
	out := KiroModelResolution{Upstream: model}
	for {
		changed := false
		if strings.HasSuffix(out.Upstream, KiroAgenticSuffix) {
			out.Agentic = true
			out.Upstream = strings.TrimSuffix(out.Upstream, KiroAgenticSuffix)
			changed = true
		}
		if strings.HasSuffix(out.Upstream, KiroThinkingSuffix) {
			out.Thinking = true
			out.Upstream = strings.TrimSuffix(out.Upstream, KiroThinkingSuffix)
			changed = true
		}
		if !changed {
			break
		}
	}
	out.Upstream = NormalizeKiroUpstreamModelID(out.Upstream)
	return out
}

// BuildKiroThinkingSystemPrefix emits the magic tag pair that turns Kiro
// reasoning on for models without a native effort field. The budget is clamped
// to Kiro's accepted range rather than rejected.
func BuildKiroThinkingSystemPrefix(budget int) string {
	if budget <= 0 {
		budget = KiroThinkingBudgetDefault
	}
	if budget > KiroThinkingBudgetMax {
		budget = KiroThinkingBudgetMax
	}
	return fmt.Sprintf("<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>%d</max_thinking_length>", budget)
}

// parseKiroClaudeVersion pulls (major, minor) out of a Claude model id. A
// date-suffixed snapshot reports its minor with four digits, which callers treat
// separately from a semantic minor.
func parseKiroClaudeVersion(model string) (major int, minor int, ok bool) {
	normalized := strings.ReplaceAll(strings.ToLower(model), "-", ".")
	groups := kiroClaudeVersionRe.FindStringSubmatch(normalized)
	if groups == nil {
		return 0, 0, false
	}
	fmt.Sscanf(groups[1], "%d", &major)
	if groups[2] == "" {
		return major, 0, true
	}
	fmt.Sscanf(groups[2], "%d", &minor)
	return major, minor, true
}

// KiroEffortPath reports where a model wants its effort field.
//
// "reasoning" is the GPT-5.6 family (reasoning.effort); "output_config" is
// Claude 4.6 and later (thinking + output_config.effort). Empty means the model
// does not accept additionalModelRequestFields at all — the legacy 4.5 models
// rejected them in live smoke.
func KiroEffortPath(model string) string {
	normalized := strings.ReplaceAll(strings.ToLower(model), "-", ".")
	if kiroGpt56Re.MatchString(normalized) {
		return "reasoning"
	}
	if !strings.Contains(normalized, "claude") {
		return ""
	}
	major, minor, ok := parseKiroClaudeVersion(model)
	if !ok {
		return ""
	}
	dateSuffix := minor >= 1000
	if major < 4 || (major == 4 && (minor <= 5 || dateSuffix)) {
		return ""
	}
	return "output_config"
}

// extractKiroEffortLevel reads a Claude-family effort, normalising the values
// Kiro does not accept. `xhigh` is downgraded to `high` on models whose schema
// caps at 4.6-and-earlier.
func extractKiroEffortLevel(body map[string]any) string {
	effort := kiroEffortFromBody(body)
	if effort == "" {
		return ""
	}
	normalized := strings.ToLower(effort)
	switch normalized {
	case "none", "off", "disabled":
		return ""
	case "xhigh", "max":
		return "max"
	case "low", "medium", "high":
		return normalized
	}
	return ""
}

// extractKiroGptEffortLevel reads the GPT-family effort. `max` maps to xhigh and
// `none` is omitted entirely because Kiro CLI has no wire value for it.
func extractKiroGptEffortLevel(body map[string]any) string {
	effort := kiroEffortFromBody(body)
	if effort == "" {
		return ""
	}
	normalized := strings.ToLower(effort)
	switch normalized {
	case "max":
		return "xhigh"
	case "low", "medium", "high", "xhigh":
		return normalized
	}
	return ""
}

// kiroEffortFromBody reads the effort out of any of the three shapes clients use.
func kiroEffortFromBody(body map[string]any) string {
	if body == nil {
		return ""
	}
	if oc, ok := body["output_config"].(map[string]any); ok {
		if s, ok := oc["effort"].(string); ok && s != "" {
			return s
		}
	}
	if s, ok := body["reasoning_effort"].(string); ok && s != "" {
		return s
	}
	if r, ok := body["reasoning"].(map[string]any); ok {
		if s, ok := r["effort"].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// BuildKiroAdditionalModelRequestFieldsForModel returns the effort-carrying
// field block for a model, or nil when the model does not accept one.
func BuildKiroAdditionalModelRequestFieldsForModel(body map[string]any, model string) map[string]any {
	switch KiroEffortPath(model) {
	case "reasoning":
		effort := extractKiroGptEffortLevel(body)
		if effort == "" {
			return nil
		}
		return map[string]any{"reasoning": map[string]any{"effort": effort}}
	case "output_config":
		effort := extractKiroEffortLevel(body)
		if effort == "" {
			return nil
		}
		return map[string]any{
			"thinking":      map[string]any{"type": "adaptive", "display": "summarized"},
			"output_config": map[string]any{"effort": effort},
		}
	}
	return nil
}

// UsesKiroNativeGptEffort reports whether the request used the GPT-native
// reasoning.effort path, which suppresses the <thinking_mode> prefix (the two
// would otherwise contradict each other upstream).
func UsesKiroNativeGptEffort(body map[string]any, model string) bool {
	return KiroEffortPath(model) == "reasoning" && extractKiroGptEffortLevel(body) != ""
}

// ── adapter ──────────────────────────────────────────────────────────────────

// Kiro is the adapter for provider id "kiro" (alias "kr").
//
// It carries the session-replay store because the store's whole purpose is to
// survive across requests: the first user turn of a conversation is frozen and
// replayed verbatim on every later turn so Kiro's prompt cache stays valid.
type Kiro struct {
	replay *KiroReplayStore
}

// NewKiro builds the adapter.
func NewKiro() *Kiro {
	return &Kiro{replay: NewKiroReplayStore()}
}

// Name is the registry key matching the Node provider id.
func (k *Kiro) Name() string { return "kiro" }

// WireFormat declares the EventStream dialect. The gateway must never pivot a
// request through the OpenAI leg on the way here: the OpenAI bridge is lossy for
// tool-result ids and is_error flags, and Kiro's own reconciler needs both.
func (k *Kiro) WireFormat() string { return FormatKiro }

// Replay exposes the session store so a caller can prime or clear it.
func (k *Kiro) Replay() *KiroReplayStore { return k.replay }

// Endpoint picks the upstream surface for this request.
//
// Ordering rule: the Amazon hosts come first for every auth method. The kiro.dev
// path gateway deprecated the path-style GenerateAssistantResponse and now
// answers valid modern payloads with 400 — terminal, so it must never be tried
// first. Amazon rejects a foreign token with 401/403, which fall through and let
// the next surface try.
func (k *Kiro) Endpoint(req Request, cred Credential) (string, error) {
	base := strings.TrimSuffix(cred.BaseURL, "/")
	if base != "" {
		return base, nil
	}
	region := strings.TrimSpace(cred.Extra["region"])
	if region == "" {
		region = KiroDefaultRegion
	}
	return KiroOrderedBaseURLs(region)[0], nil
}

// KiroOrderedBaseURLs returns the surfaces in retry order for a region.
//
// The q.* host leads because api_key connections are the ones that most need it
// (the legacy CodeWhisperer host authenticates the key but 400s the payload),
// and the remaining Amazon surfaces follow before kiro.dev.
func KiroOrderedBaseURLs(region string) []string {
	regionalize := func(u string) string {
		if region == "" || region == KiroDefaultRegion || !strings.Contains(u, "amazonaws.com") {
			return u
		}
		prefix := ""
		switch {
		case strings.Contains(u, "://codewhisperer."):
			prefix = "codewhisperer."
		case strings.Contains(u, "://q."):
			prefix = "q."
		}
		if prefix == "" {
			return u
		}
		return "https://" + prefix + region + ".amazonaws.com/generateAssistantResponse"
	}

	var q, amazonOther, others []string
	for _, u := range KiroBaseURLs {
		if !strings.Contains(u, "amazonaws.com") {
			others = append(others, u)
			continue
		}
		regional := regionalize(u)
		if strings.Contains(regional, "://q.") {
			q = append(q, regional)
			continue
		}
		amazonOther = append(amazonOther, regional)
	}
	if len(q) > 0 {
		return append(append(append([]string{}, q...), amazonOther...), others...)
	}
	return append(append([]string{}, amazonOther...), others...)
}

// KiroRetryWorthy reports whether a status justifies trying another surface.
func KiroRetryWorthy(status int) bool { return kiroFallbackStatuses[status] }

// Headers builds the Kiro CLI identity plus the auth headers.
//
// Three distinct auth shapes exist and they are not interchangeable:
//   - api_key sends the key as a bearer token plus TokenType: API_KEY, which is
//     what makes CodeWhisperer treat it as long-lived rather than an OIDC token.
//   - external_idp sends an OAuth access token plus TokenType: EXTERNAL_IDP so
//     the token binds to an enterprise profile.
//   - everything else sends the access token raw, and also mirrors it into
//     x-amz-sso-bearer because the Kiro runtime accepts either and rejects
//     modern payloads when neither is present.
func (k *Kiro) Headers(req Request, cred Credential) (map[string]string, error) {
	authMethod := cred.Extra["authMethod"]

	headers := map[string]string{
		"Content-Type":                    "application/json",
		"Accept":                          "application/vnd.amazon.eventstream",
		"User-Agent":                      KiroUserAgent,
		"X-Amz-User-Agent":                KiroUserAgent,
		"Amz-Sdk-Request":                 "attempt=1; max=3",
		"Amz-Sdk-Invocation-Id":           NewRequestID(),
		"x-amzn-kiro-agent-mode":          "spec",
		"x-amzn-codewhisperer-machine-id": "kiro-desktop",
	}

	endpoint, _ := k.Endpoint(req, cred)
	if strings.Contains(endpoint, "://codewhisperer.") {
		headers["X-Amz-Target"] = KiroCodeWhispererTarget
	}

	apiKey := cred.APIKey
	if apiKey == "" && authMethod == "api_key" {
		apiKey = cred.AccessToken
	}

	switch {
	case authMethod == "api_key" && apiKey != "":
		headers["Authorization"] = "Bearer " + apiKey
		headers["TokenType"] = "API_KEY"
	case cred.AccessToken != "":
		headers["Authorization"] = "Bearer " + cred.AccessToken
		if authMethod == "external_idp" {
			headers["TokenType"] = "EXTERNAL_IDP"
		}
	}

	if cred.AccessToken != "" {
		headers["x-amz-sso-bearer"] = cred.AccessToken
	}

	// The profile ARN has to be the one this connection resolved. Only
	// OAuth/social accounts may fall back to the shared placeholder.
	if profileARN := cred.Extra["profileArn"]; profileARN != "" {
		headers["x-amzn-codewhisperer-profile-arn"] = profileARN
	}

	return headers, nil
}

// KiroProfileARN resolves the profileArn a payload should carry.
//
// Account-bound auth (api_key / idc / external_idp) must never receive the
// shared placeholder: it belongs to a different account and CodeWhisperer
// answers 403 "bearer token invalid". Sending an empty string is correct — it
// tells CodeWhisperer to use the token's own default profile.
func KiroProfileARN(authMethod, resolved string) string {
	if resolved != "" {
		return resolved
	}
	if KiroAccountingAuths[authMethod] {
		return ""
	}
	return KiroDefaultProfileARN(authMethod)
}

// ── session replay (utils/kiroSessionReplay.js) ──────────────────────────────

// KiroReplayStore freezes the first user turn of a conversation and replays it
// as the opening history turn on later requests.
//
// This exists purely for prompt caching. Kiro caches on the leading content of
// the conversation, so if the opening turn is rewritten on every request — which
// it would be, because the current-time context changes — the cache misses every
// time. Freezing msg0 and injecting volatile context only into the current turn
// keeps the cacheable prefix byte-identical across a session.
type KiroReplayStore struct {
	mu      sync.Mutex
	entries map[string]kiroReplayEntry
	now     func() time.Time
	maxSize int
	ttl     time.Duration
}

type kiroReplayEntry struct {
	sessionStart map[string]any
	modelID      string
	systemPrompt string
	lastUsed     time.Time
}

// NewKiroReplayStore builds a store with the Node engine's bounds.
func NewKiroReplayStore() *KiroReplayStore {
	return &KiroReplayStore{
		entries: make(map[string]kiroReplayEntry),
		now:     time.Now,
		maxSize: 5000,
		ttl:     30 * time.Minute,
	}
}

// KiroReplayResult is what the replay step hands to the canonicalizer.
type KiroReplayResult struct {
	History        []any
	CurrentMessage map[string]any
	Replayed       bool
}

// ApplyKiroSessionReplay performs the freeze-or-replay decision for one request.
//
// On a fresh session the first history user turn becomes the frozen session
// start and receives the system prefix. On a replay the stored start replaces
// whatever the client sent as the opening turn, so the cacheable prefix is
// byte-identical, and only the current turn carries the volatile time context.
func (s *KiroReplayStore) ApplyKiroSessionReplay(conversationID, connectionID, modelID, systemPrompt, contentPrefix, currentContentPrefix string, history []any, currentMessage map[string]any) KiroReplayResult {
	key := connectionID + ":" + conversationID

	s.mu.Lock()
	existing, found := s.entries[key]
	if found && s.now().Sub(existing.lastUsed) > s.ttl {
		delete(s.entries, key)
		found = false
	}
	s.mu.Unlock()

	baseHistory := cloneKiroSlice(history)
	baseCurrent := cloneKiroMap(currentMessage)
	if baseCurrent == nil {
		baseCurrent = map[string]any{"userInputMessage": map[string]any{"content": ""}}
	}

	if found && existing.modelID == modelID && existing.systemPrompt == systemPrompt {
		s.mu.Lock()
		entry := s.entries[key]
		entry.lastUsed = s.now()
		s.entries[key] = entry
		sessionStart := kiroEnsureUserModelID(cloneKiroMap(existing.sessionStart), modelID)
		s.mu.Unlock()

		firstUser := kiroFirstUserIndex(baseHistory)
		if kiroCanReplaceSessionStart(baseHistory, firstUser) {
			baseHistory[firstUser] = sessionStart
		} else {
			baseHistory = append([]any{sessionStart}, baseHistory...)
			if len(baseHistory) == 1 {
				baseHistory = append(baseHistory, map[string]any{
					"assistantResponseMessage": map[string]any{"content": "..."},
				})
			}
		}
		return KiroReplayResult{
			History:        kiroEnsureHistoryModelIDs(baseHistory, modelID),
			CurrentMessage: kiroPrefixUserMessage(baseCurrent, currentContentPrefix, modelID),
			Replayed:       true,
		}
	}

	firstUser := kiroFirstUserIndex(baseHistory)
	var sessionStart map[string]any
	nextCurrent := kiroEnsureUserModelID(baseCurrent, modelID)

	switch {
	case kiroCanReplaceSessionStart(baseHistory, firstUser):
		existingTurn, _ := baseHistory[firstUser].(map[string]any)
		sessionStart = kiroPrefixUserMessage(existingTurn, contentPrefix, modelID)
		baseHistory[firstUser] = cloneKiroJSON(sessionStart)
		nextCurrent = kiroPrefixUserMessage(baseCurrent, currentContentPrefix, modelID)
	case firstUser >= 0:
		sessionStart = kiroPrefixUserMessage(
			map[string]any{"userInputMessage": map[string]any{"content": "", "modelId": modelID}},
			contentPrefix, modelID)
		baseHistory = append([]any{cloneKiroJSON(sessionStart)}, baseHistory...)
		nextCurrent = kiroPrefixUserMessage(baseCurrent, currentContentPrefix, modelID)
	default:
		sessionStart = kiroPrefixUserMessage(baseCurrent, contentPrefix, modelID)
		nextCurrent = cloneKiroMap(sessionStart)
	}

	if conversationID != "" {
		s.mu.Lock()
		if len(s.entries) >= s.maxSize {
			// Evict an arbitrary entry: the store is a cache, so losing one
			// session-start costs a cache miss, never correctness.
			for k := range s.entries {
				delete(s.entries, k)
				break
			}
		}
		s.entries[key] = kiroReplayEntry{
			sessionStart: cloneKiroMap(sessionStart),
			modelID:      modelID,
			systemPrompt: systemPrompt,
			lastUsed:     s.now(),
		}
		s.mu.Unlock()
	}

	return KiroReplayResult{
		History:        kiroEnsureHistoryModelIDs(baseHistory, modelID),
		CurrentMessage: nextCurrent,
		Replayed:       false,
	}
}

// Clear drops every frozen session start.
func (s *KiroReplayStore) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = make(map[string]kiroReplayEntry)
}

// Size reports how many session starts are currently frozen.
func (s *KiroReplayStore) Size() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

func kiroEnsureUserModelID(message map[string]any, modelID string) map[string]any {
	if message == nil {
		return message
	}
	uim, ok := message["userInputMessage"].(map[string]any)
	if !ok || uim == nil {
		return message
	}
	if _, has := uim["modelId"]; !has && modelID != "" {
		uim["modelId"] = modelID
	}
	return message
}

func kiroEnsureHistoryModelIDs(history []any, modelID string) []any {
	for _, item := range history {
		if m, ok := item.(map[string]any); ok {
			kiroEnsureUserModelID(m, modelID)
		}
	}
	return history
}

func kiroPrefixUserMessage(message map[string]any, contentPrefix, modelID string) map[string]any {
	out := cloneKiroJSON(message)
	m, ok := out.(map[string]any)
	if !ok || m == nil {
		m = map[string]any{"userInputMessage": map[string]any{"content": ""}}
	}
	uim, ok := m["userInputMessage"].(map[string]any)
	if !ok || uim == nil {
		uim = map[string]any{"content": ""}
		m["userInputMessage"] = uim
	}
	kiroEnsureUserModelID(m, modelID)
	if contentPrefix != "" {
		content, _ := uim["content"].(string)
		if content != "" {
			uim["content"] = contentPrefix + "\n\n" + content
		} else {
			uim["content"] = contentPrefix
		}
	}
	return m
}

func kiroFirstUserIndex(history []any) int {
	for i, item := range history {
		if m, ok := item.(map[string]any); ok {
			if _, has := m["userInputMessage"]; has {
				return i
			}
		}
	}
	return -1
}

func kiroHasToolResults(message any) bool {
	m, ok := message.(map[string]any)
	if !ok {
		return false
	}
	uim, ok := m["userInputMessage"].(map[string]any)
	if !ok {
		return false
	}
	ctx, ok := uim["userInputMessageContext"].(map[string]any)
	if !ok {
		return false
	}
	results, ok := ctx["toolResults"].([]any)
	return ok && len(results) > 0
}

func kiroCanReplaceSessionStart(history []any, firstUserIndex int) bool {
	if firstUserIndex != 0 {
		return false
	}
	return !kiroHasToolResults(history[firstUserIndex])
}

// cloneKiroJSON is a deep copy via the wire format. The Kiro pipeline mutates
// turn maps in place (merging user turns, splicing the current message out), and
// the caller still holds the original request body for logging.
func cloneKiroJSON(v any) any {
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

// cloneKiroMap deep-copies a turn map. Nil in, nil out — callers substitute their
// own placeholder rather than inheriting an empty map they cannot distinguish
// from a real one.
func cloneKiroMap(v map[string]any) map[string]any {
	if v == nil {
		return nil
	}
	out, _ := cloneKiroJSON(v).(map[string]any)
	return out
}

// cloneKiroSlice deep-copies a turn list, normalising nil to an empty slice so
// append never needs a nil check.
func cloneKiroSlice(v []any) []any {
	if v == nil {
		return []any{}
	}
	out, ok := cloneKiroJSON(v).([]any)
	if !ok {
		return []any{}
	}
	return out
}

// ── AWS EventStream decoder (executors/kiro.js event path) ───────────────────

// KiroEvent is one decoded EventStream frame.
type KiroEvent struct {
	// Headers carries every frame header. ":message-type" and ":event-type" are
	// the two that drive behaviour; the rest are diagnostics.
	Headers map[string]any
	// Payload is the JSON-decoded body, or nil for a frame that carried none.
	Payload map[string]any
}

// KiroEventStreamDecoder is a streaming AWS EventStream parser.
//
// EventStream framing is: [total length u32][header length u32][prelude CRC u32]
// [headers][payload][message CRC u32], all big-endian. A frame can arrive split
// across reads and several frames can arrive in one read, so the decoder keeps a
// buffer and yields only complete frames. Both CRCs are verified: a mismatch
// means the stream is corrupt and continuing would emit garbage as model output.
type KiroEventStreamDecoder struct {
	buf []byte
}

// NewKiroEventStreamDecoder builds an empty decoder.
func NewKiroEventStreamDecoder() *KiroEventStreamDecoder {
	return &KiroEventStreamDecoder{}
}

// Buffered reports how many bytes are held pending a complete frame.
func (d *KiroEventStreamDecoder) Buffered() int { return len(d.buf) }

// Push appends a read and returns every frame that is now complete.
//
// A partial trailing frame stays buffered. An error means a frame was complete
// but malformed, which is unrecoverable: the boundary is lost, so nothing after
// it can be trusted.
func (d *KiroEventStreamDecoder) Push(chunk []byte) ([]KiroEvent, error) {
	d.buf = append(d.buf, chunk...)
	if len(d.buf) > KiroEventStreamMaxMessage {
		return nil, fmt.Errorf("kiro: EventStream buffered bytes exceed %d", KiroEventStreamMaxMessage)
	}

	var events []KiroEvent

	for len(d.buf) >= 12 {
		totalLength := int(binary.BigEndian.Uint32(d.buf[0:4]))
		headersLength := int(binary.BigEndian.Uint32(d.buf[4:8]))
		preludeCRC := binary.BigEndian.Uint32(d.buf[8:12])

		if totalLength < 16 || totalLength > KiroEventStreamMaxMessage ||
			headersLength > KiroEventStreamMaxHeaders || headersLength > totalLength-16 {
			return nil, fmt.Errorf("kiro: EventStream frame bounds are invalid (total=%d headers=%d)", totalLength, headersLength)
		}
		if preludeCRC != crc32.ChecksumIEEE(d.buf[0:8]) {
			return nil, fmt.Errorf("kiro: EventStream prelude CRC mismatch")
		}
		if len(d.buf) < totalLength {
			break
		}

		frame := d.buf[:totalLength]
		d.buf = d.buf[totalLength:]

		messageCRC := binary.BigEndian.Uint32(frame[totalLength-4 : totalLength])
		if messageCRC != crc32.ChecksumIEEE(frame[:totalLength-4]) {
			return nil, fmt.Errorf("kiro: EventStream message CRC mismatch")
		}

		event, err := parseKiroEventFrame(frame, headersLength)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}

	return events, nil
}

// HeaderValue reads a header as a string. EventStream headers are typed, and the
// two names this decoder cares about (":message-type", ":event-type") are always
// the string type, but a missing header and a non-string one are both "absent"
// here rather than an error.
func (e KiroEvent) HeaderValue(name string) string {
	if e.Headers == nil {
		return ""
	}
	s, _ := e.Headers[name].(string)
	return s
}

// parseKiroEventFrame decodes one complete frame body.
//
// All EventStream header types are handled, not just the string type, because the
// decoder has to advance past each header to reach the payload. A type it does
// not understand is an error rather than a skip: guessing a width would silently
// desynchronise every following field.
func parseKiroEventFrame(frame []byte, headersLength int) (KiroEvent, error) {
	if len(frame) < 16 {
		return KiroEvent{}, fmt.Errorf("kiro: EventStream frame is shorter than 16 bytes")
	}

	headers := make(map[string]any)
	offset := 12
	headerEnd := offset + headersLength

	for offset < headerEnd {
		if offset+1 > len(frame) {
			return KiroEvent{}, fmt.Errorf("kiro: EventStream header exceeds its declared bounds")
		}
		nameLength := int(frame[offset])
		offset++
		if offset+nameLength+1 > len(frame) {
			return KiroEvent{}, fmt.Errorf("kiro: EventStream header name exceeds its declared bounds")
		}
		name := string(frame[offset : offset+nameLength])
		offset += nameLength
		if _, dup := headers[name]; dup {
			return KiroEvent{}, fmt.Errorf("kiro: EventStream contains duplicate header: %s", name)
		}
		headerType := frame[offset]
		offset++

		switch headerType {
		case 0: // bool true
			headers[name] = true
		case 1: // bool false
			headers[name] = false
		case 2: // int8
			if offset+1 > len(frame) {
				return KiroEvent{}, fmt.Errorf("kiro: EventStream int8 header is truncated")
			}
			headers[name] = int8(frame[offset])
			offset++
		case 3: // int16
			if offset+2 > len(frame) {
				return KiroEvent{}, fmt.Errorf("kiro: EventStream int16 header is truncated")
			}
			headers[name] = int16(binary.BigEndian.Uint16(frame[offset : offset+2]))
			offset += 2
		case 4: // int32
			if offset+4 > len(frame) {
				return KiroEvent{}, fmt.Errorf("kiro: EventStream int32 header is truncated")
			}
			headers[name] = int32(binary.BigEndian.Uint32(frame[offset : offset+4]))
			offset += 4
		case 5, 8: // int64, timestamp — skipped, not used by Kiro
			if offset+8 > len(frame) {
				return KiroEvent{}, fmt.Errorf("kiro: EventStream int64 header is truncated")
			}
			offset += 8
		case 6: // byte array
			if offset+2 > len(frame) {
				return KiroEvent{}, fmt.Errorf("kiro: EventStream byte-array header is truncated")
			}
			valueLength := int(binary.BigEndian.Uint16(frame[offset : offset+2]))
			offset += 2
			if offset+valueLength > len(frame) {
				return KiroEvent{}, fmt.Errorf("kiro: EventStream byte-array value is truncated")
			}
			headers[name] = append([]byte(nil), frame[offset:offset+valueLength]...)
			offset += valueLength
		case 7: // string
			if offset+2 > len(frame) {
				return KiroEvent{}, fmt.Errorf("kiro: EventStream string header is truncated")
			}
			valueLength := int(binary.BigEndian.Uint16(frame[offset : offset+2]))
			offset += 2
			if offset+valueLength > len(frame) {
				return KiroEvent{}, fmt.Errorf("kiro: EventStream string value is truncated")
			}
			headers[name] = string(frame[offset : offset+valueLength])
			offset += valueLength
		case 9: // uuid
			if offset+16 > len(frame) {
				return KiroEvent{}, fmt.Errorf("kiro: EventStream uuid header is truncated")
			}
			offset += 16
		default:
			return KiroEvent{}, fmt.Errorf("kiro: EventStream header %s has unknown type %d", name, headerType)
		}
	}

	payloadBytes := frame[headerEnd : len(frame)-4]
	if len(payloadBytes) == 0 {
		return KiroEvent{Headers: headers}, nil
	}
	trimmed := bytes.TrimSpace(payloadBytes)
	if len(trimmed) == 0 {
		return KiroEvent{Headers: headers}, nil
	}

	var payload map[string]any
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return KiroEvent{}, fmt.Errorf("kiro: EventStream payload is not valid JSON (%v)", err)
	}
	return KiroEvent{Headers: headers, Payload: payload}, nil
}

// DecodeKiroEventStream reads an entire EventStream body and returns every frame.
//
// Used for the non-streaming path and for tests. The streaming path goes through
// KiroEventStreamDecoder directly so frames reach the client as they arrive.
func DecodeKiroEventStream(r io.Reader) ([]KiroEvent, error) {
	decoder := NewKiroEventStreamDecoder()
	var events []KiroEvent
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk, pushErr := decoder.Push(buf[:n])
			if pushErr != nil {
				return events, pushErr
			}
			events = append(events, chunk...)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return events, err
		}
	}
	if decoder.Buffered() > 0 {
		return events, fmt.Errorf("kiro: EventStream ended with a truncated frame (%d bytes)", decoder.Buffered())
	}
	return events, nil
}
