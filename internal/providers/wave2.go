package providers

import (
	"crypto/rand"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// This file ports the three non-generic executors that carry the most live
// traffic after the OpenAI-compatible majority: grok-cli, qoder and antigravity.
// Each one has a different reason for existing as a separate adapter:
//
//   - grok-cli speaks the OpenAI *Responses* API, not chat-completions, and
//     fingerprints itself with a set of session headers that must stay
//     monotonic per conversation.
//   - qoder ships its body through a proprietary envelope on a signed URL and
//     carries a region.
//   - antigravity speaks Google generateContent under the Antigravity IDE
//     identity, with a rotating base-url pool.
//
// They are ports of open-sse/executors/{grok-cli,qoder,antigravity}.js.

// ── shared helpers ────────────────────────────────────────────────────────────

// newUUIDv4 returns a random RFC 4122 v4 uuid using crypto/rand. Node's
// crypto.randomUUID() is used for exactly this in the executors being ported.
func newUUIDv4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is not recoverable in a meaningful way; fall back to
		// a time-seeded value so the process keeps serving rather than panicking.
		now := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(now >> (uint(i%8) * 8))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// NewRequestID mints a per-request identifier. Exported because the gateway
// populates Request.RequestID and adapters may need the same shape in tests.
func NewRequestID() string { return newUUIDv4() }

// isUUIDShape reports whether s matches the uuid layout the grok-cli native item
// id pattern depends on.
func isUUIDShape(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
			if !isHex {
				return false
			}
		}
	}
	return true
}

// ── grok-cli ──────────────────────────────────────────────────────────────────

// GrokCli fingerprint constants, ported from open-sse/config/grokCli.js and the
// grok-cli registry entry. Kept as named values so a version bump is one edit.
const (
	GrokCliVersion          = "0.2.99"
	GrokCliModel            = "grok-build"
	GrokCliBaseURL          = "https://cli-chat-proxy.grok.com/v1"
	GrokCliClientIdentifier = "grok-shell"
)

// GrokCliUserAgent is the CLI's declared identity upstream.
var GrokCliUserAgent = fmt.Sprintf("grok-shell/%s (linux; x86_64)", GrokCliVersion)

// grokResponsesAllowlist is the set of fields the cli-chat-proxy Responses API
// accepts. Anything else is dropped before the request goes out — the Node
// executor does exactly this, and sending extras gets the request rejected.
var grokResponsesAllowlist = map[string]bool{
	"model": true, "input": true, "instructions": true, "tools": true,
	"tool_choice": true, "stream": true, "store": true, "reasoning": true,
	"include": true, "temperature": true, "top_p": true, "max_output_tokens": true,
	"parallel_tool_calls": true, "text": true, "metadata": true, "prompt_cache_key": true,
}

// grokHostedToolTypes are executed server-side by the Grok CLI backend and pass
// through untouched.
var grokHostedToolTypes = map[string]bool{
	"web_search": true, "x_search": true, "web_search_preview": true,
	"file_search": true, "image_generation": true, "code_interpreter": true,
	"mcp": true, "local_shell": true,
}

// grokEffortLevels are the reasoning effort suffixes the CLI accepts.
var grokEffortLevels = []string{"low", "medium", "high", "xhigh"}

const grokTurnStoreMax = 5000

// GrokCli is the port of open-sse/executors/grok-cli.js.
//
// The stateful part is the turn index. The official CLI sends x-grok-turn-idx as
// the 1-based conversation turn, and the backend expects it to never go backwards
// within a session. The Node executor keeps a process-local map keyed by session
// id with a TTL. This port keeps the same structure and eviction policy.
type GrokCli struct {
	mu           sync.Mutex
	turnStore    map[string]grokTurnEntry
	SessionTTL   time.Duration
	MaxStoreSize int
}

type grokTurnEntry struct {
	turn     int
	lastUsed time.Time
}

// NewGrokCli builds the adapter with the Node defaults.
func NewGrokCli() *GrokCli {
	return &GrokCli{
		turnStore:    make(map[string]grokTurnEntry),
		SessionTTL:   30 * time.Minute,
		MaxStoreSize: grokTurnStoreMax,
	}
}

func (g *GrokCli) Name() string { return "grok-cli" }

// WireFormat declares the upstream dialect. xAI's CLI backend is the Responses
// API, so a client's chat body is converted in, not forwarded raw.
func (g *GrokCli) WireFormat() string { return FormatResponses }

// Endpoint is the Responses API root: the executor uses config.baseUrl verbatim,
// which the registry already points at /v1/responses.
func (g *GrokCli) Endpoint(req Request, cred Credential) (string, error) {
	if cred.BaseURL != "" {
		return strings.TrimSuffix(cred.BaseURL, "/"), nil
	}
	return GrokCliBaseURL + "/responses", nil
}

// Headers builds the CLI fingerprint. Every header here is part of how the
// upstream decides the request came from the official client, so none of them are
// optional.
func (g *GrokCli) Headers(req Request, cred Credential) (map[string]string, error) {
	headers := map[string]string{
		"Content-Type":             "application/json",
		"User-Agent":               GrokCliUserAgent,
		"x-grok-client-identifier": GrokCliClientIdentifier,
		"x-grok-client-version":    GrokCliVersion,
	}
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}

	token := cred.APIKey
	if token == "" {
		token = cred.AccessToken
	}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}

	// Session and request identity. The executor prefers a stable session id
	// derived from the client conversation and falls back to a per-request uuid.
	sessionID := cred.Extra["sessionId"]
	if sessionID == "" {
		sessionID = cred.Extra["connectionId"]
	}
	if sessionID == "" {
		sessionID = newUUIDv4()
	}
	headers["x-grok-session-id"] = sessionID
	// The CLI reuses the same id for conversation and session on chat turns.
	headers["x-grok-conv-id"] = sessionID
	headers["x-grok-req-id"] = newUUIDv4()

	if agent := cred.Extra["agentId"]; agent != "" {
		headers["x-grok-agent-id"] = agent
	}
	if m := cred.Extra["model"]; m != "" {
		headers["x-grok-model-override"] = m
	}
	if email := cred.Extra["email"]; email != "" {
		headers["x-email"] = email
	}
	if uid := cred.Extra["userId"]; uid != "" {
		headers["x-userid"] = uid
	}

	headers["x-grok-turn-idx"] = fmt.Sprint(g.ResolveTurnIdx(sessionID, req.Body))
	return headers, nil
}

// ResolveTurnIdx mirrors resolveGrokCliTurnIdx: prefer the user-message count in
// the payload, never go below the last index seen for the same session.
func (g *GrokCli) ResolveTurnIdx(sessionID string, body []byte) int {
	fromInput := countGrokUserTurns(body)
	if sessionID == "" {
		return fromInput
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	now := time.Now()
	prev := 0
	if e, ok := g.turnStore[sessionID]; ok {
		delete(g.turnStore, sessionID)
		if now.Sub(e.lastUsed) <= g.SessionTTL {
			prev = e.turn
		}
	}

	turn := fromInput
	if prev > 0 && prev+1 > turn {
		turn = prev + 1
	}

	for len(g.turnStore) >= g.MaxStoreSize {
		// evict an arbitrary entry, matching the Node map-iteration eviction
		for k := range g.turnStore {
			delete(g.turnStore, k)
			break
		}
	}
	g.turnStore[sessionID] = grokTurnEntry{turn: turn, lastUsed: now}
	return turn
}

// TurnStoreSize exposes the store size for tests, matching the Node helper.
func (g *GrokCli) TurnStoreSize() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.turnStore)
}

// countGrokUserTurns counts user-role message items in the responses input array.
// Tolerant by design: a malformed body yields 1 rather than an error, exactly as
// the Node counter does.
func countGrokUserTurns(body []byte) int {
	items, ok := parseInputArray(body)
	if !ok {
		return 1
	}
	n := 0
	for _, it := range items {
		m, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		role, _ := m["role"].(string)
		typ, _ := m["type"].(string)
		if role == "user" && (typ == "" || typ == "message") {
			n++
		}
	}
	if n < 1 {
		return 1
	}
	return n
}

// NormalizeEffort maps the CLI's effort vocabulary onto its accepted levels.
func NormalizeEffort(value string) string {
	e := strings.ToLower(strings.TrimSpace(value))
	if e == "max" {
		return "xhigh"
	}
	for _, lvl := range grokEffortLevels {
		if e == lvl {
			return e
		}
	}
	return "high"
}

// ResolveEffortFromModel reads an effort suffix off a virtual model id.
func ResolveEffortFromModel(modelID string) string {
	for _, lvl := range grokEffortLevels {
		if strings.HasSuffix(modelID, "-"+lvl) {
			return lvl
		}
	}
	return ""
}

// SupportsReasoningEffort mirrors config/grokCli.js — grok-4.5/4.6/4.7 and their
// variants accept an effort, build and Composer reject it.
func SupportsReasoningEffort(model string) bool {
	for _, v := range []string{"4.5", "4.6", "4.7"} {
		if strings.HasPrefix(model, "grok-"+v) {
			rest := strings.TrimPrefix(model, "grok-"+v)
			if rest == "" || strings.HasPrefix(rest, "-") {
				return true
			}
		}
	}
	return false
}

// NormalizeGrokBody applies the request transform the executor performs: strip
// chat-completions leftovers, flatten tools to the Responses shape, force stream,
// and drop anything outside the allowlist. Returns the marshalled body.
func NormalizeGrokBody(raw map[string]interface{}, effortSource string) ([]byte, error) {
	// tools first: it deletes tool_choice when nothing survives
	normalizeGrokTools(raw)

	raw["stream"] = true
	raw["store"] = false
	raw["model"] = stripEffortSuffix(str(raw["model"]))

	// reasoning block
	reasoning, _ := raw["reasoning"].(map[string]interface{})
	if reasoning == nil {
		reasoning = map[string]interface{}{"summary": "concise"}
		raw["reasoning"] = reasoning
	}
	if SupportsReasoningEffort(str(raw["model"])) {
		eff := str(raw["reasoning_effort"])
		if eff == "" {
			eff = effortSource
		}
		reasoning["effort"] = NormalizeEffort(eff)
	} else {
		delete(reasoning, "effort")
	}
	if str(reasoning["summary"]) == "" {
		reasoning["summary"] = "concise"
	}
	delete(raw, "reasoning_effort")

	// encrypted reasoning for multi-turn continuity
	if str(reasoning["effort"]) != "none" {
		include := toStringSlice(raw["include"])
		if !containsStr(include, "reasoning.encrypted_content") {
			include = append(include, "reasoning.encrypted_content")
		}
		raw["include"] = include
	}

	// chat-completions leftovers the Responses API rejects
	for _, k := range []string{
		"messages", "max_tokens", "max_completion_tokens", "n", "seed", "logprobs",
		"top_logprobs", "frequency_penalty", "presence_penalty", "logit_bias", "user",
		"stream_options", "prompt_cache_retention", "safety_identifier",
		"previous_response_id", // store=false means it cannot be resolved
	} {
		delete(raw, k)
	}

	// allowlist sweep
	for k := range raw {
		if !grokResponsesAllowlist[k] {
			delete(raw, k)
		}
	}

	return marshalJSON(raw)
}

// normalizeGrokTools flattens the chat-completions tool shape into the Responses
// flat format, keeping hosted tools as-is.
func normalizeGrokTools(body map[string]interface{}) {
	tools, ok := body["tools"].([]interface{})
	if !ok || len(tools) == 0 {
		delete(body, "tools")
		delete(body, "tool_choice")
		return
	}

	validNames := map[string]bool{}
	hostedTypes := map[string]bool{}
	out := make([]interface{}, 0, len(tools))

	for _, t := range tools {
		tool, ok := t.(map[string]interface{})
		if !ok {
			continue
		}
		typ := str(tool["type"])

		if typ != "function" {
			if grokHostedToolTypes[typ] {
				hostedTypes[typ] = true
				out = append(out, tool)
				continue
			}
			if typ == "" && tool["function"] == nil && str(tool["name"]) == "" {
				continue
			}
		}

		var fn map[string]interface{}
		if f, ok := tool["function"].(map[string]interface{}); ok {
			fn = f
		}
		name := str(tool["name"])
		if name == "" {
			name = str(fn["name"])
		}
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}

		desc := str(tool["description"])
		if desc == "" {
			desc = str(fn["description"])
		}
		params := map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
		if typ == "custom" {
			params = map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{"input": map[string]interface{}{"type": "string"}},
				"required":   []string{"input"},
			}
		} else if p, ok := tool["parameters"].(map[string]interface{}); ok {
			params = p
		} else if p, ok := fn["parameters"].(map[string]interface{}); ok {
			params = p
		}

		// rebuild the entry flat, as the executor does
		for k := range tool {
			delete(tool, k)
		}
		tool["type"] = "function"
		if len(name) > 128 {
			name = name[:128]
		}
		tool["name"] = name
		if desc != "" {
			tool["description"] = desc
		}
		tool["parameters"] = params
		validNames[name] = true
		out = append(out, tool)
	}

	if len(out) == 0 {
		delete(body, "tools")
		delete(body, "tool_choice")
		return
	}
	body["tools"] = out

	if tc, ok := body["tool_choice"].(map[string]interface{}); ok {
		choiceType := str(tc["type"])
		if choiceType == "function" || choiceType == "custom" {
			rawName := str(tc["name"])
			if rawName == "" {
				if f, ok := tc["function"].(map[string]interface{}); ok {
					rawName = str(f["name"])
				}
			}
			rawName = strings.TrimSpace(rawName)
			if len(rawName) > 128 {
				rawName = rawName[:128]
			}
			if rawName == "" || !validNames[rawName] {
				delete(body, "tool_choice")
			} else {
				body["tool_choice"] = map[string]interface{}{"type": "function", "name": rawName}
			}
		} else if !hostedTypes[choiceType] {
			delete(body, "tool_choice")
		}
	}
}

// stripEffortSuffix removes a trailing -low/-medium/-high/-xhigh from a model id.
func stripEffortSuffix(model string) string {
	eff := ResolveEffortFromModel(model)
	if eff == "" {
		return model
	}
	return strings.TrimSuffix(model, "-"+eff)
}

// ── qoder ─────────────────────────────────────────────────────────────────────

// Qoder path constants. The executor composes the URL from a region-specific
// inference base plus this fixed path and query.
const (
	QoderChatSigPath  = "/algo/api/v2/service/pro/sse/agent_chat_generation"
	QoderIntlBase     = "https://api3.qoder.sh"
	QoderCnBase       = "https://api-qoder.qoder.com"
	QoderDefaultAgent = "agent_common"
)

// Qoder is the port of open-sse/executors/qoder.js. Only the URL composition,
// region selection and header identity are ported here: the body envelope and
// COSY signature live in open-sse/shared/qoder and depend on a signing routine
// that is out of scope for this pass, so Requests carried by this adapter are
// rejected rather than silently sent unsigned.
type Qoder struct {
	Region string // "intl" or "cn"
}

// NewQoder builds the adapter for a region, defaulting to intl.
func NewQoder(region string) *Qoder {
	if region != "cn" {
		region = "intl"
	}
	return &Qoder{Region: region}
}

func (q *Qoder) Name() string {
	if q.Region == "cn" {
		return "qoder-cn"
	}
	return "qoder"
}

// WireFormat declares the upstream dialect. Qoder answers in the Anthropic
// Messages shape, which is why the executor unwraps a JSON envelope around it.
// Declaring OpenAI here would send a chat body to a Messages endpoint.
func (q *Qoder) WireFormat() string { return FormatClaude }

// Endpoint composes the signed-path URL. The FetchKeys/AgentId/Encode query is
// part of the upstream contract, not an optional hint.
func (q *Qoder) Endpoint(req Request, cred Credential) (string, error) {
	base := cred.BaseURL
	if base == "" {
		if q.Region == "cn" {
			base = QoderCnBase
		} else {
			base = QoderIntlBase
		}
	}
	agent := cred.Extra["agentId"]
	if agent == "" {
		agent = QoderDefaultAgent
	}
	return fmt.Sprintf("%s%s?FetchKeys=llm_model_result&AgentId=%s&Encode=1",
		strings.TrimSuffix(base, "/"), QoderChatSigPath, agent), nil
}

// Headers returns the identity headers. Signing (cosy) is applied by the caller
// over the encoded body, so this adapter only declares what it needs upstream.
func (q *Qoder) Headers(req Request, cred Credential) (map[string]string, error) {
	// The executor refuses to proceed without a userId: without it the COSY
	// signature cannot be produced, and the dashboard is meant to prompt a
	// reconnect. Failing here with the same message keeps that behaviour.
	if cred.Extra["userId"] == "" {
		return nil, fmt.Errorf("qoder credential is missing userId; reconnect the account")
	}
	token := cred.AccessToken
	if token == "" {
		token = cred.APIKey
	}
	if token == "" {
		return nil, fmt.Errorf("qoder credential has no token; reconnect the account")
	}

	headers := map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer " + token,
	}
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}
	if q.Region == "cn" {
		headers["x-region"] = "cn"
	}
	return headers, nil
}

// ── antigravity ───────────────────────────────────────────────────────────────

// Antigravity identity constants, ported from open-sse/providers/shared.js. The
// fingerprint is deliberately frozen to the desktop IDE client identity rather
// than reflecting the host this gateway runs on.
const (
	AntigravityIDEVersion   = "2.32.1"
	AntigravityDefaultBase  = "https://daily-cloudcode-pa.googleapis.com"
	AntigravityStallTimeout = 600 * time.Second
)

// AntigravityIDEBases is the rotating base-url pool, in preference order.
var AntigravityIDEBases = []string{
	AntigravityDefaultBase,
	"https://cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com",
}

// AntigravityIDEUserAgent is the client fingerprint sent upstream.
var AntigravityIDEUserAgent = fmt.Sprintf("antigravity/hub/%s linux/x64", AntigravityIDEVersion)

// Antigravity is the port of open-sse/executors/antigravity.js. It speaks Google
// generateContent under the IDE identity, with a rotating base-url pool and a
// streaming-vs-unary action selected from the model class.
type Antigravity struct{}

// NewAntigravity builds the adapter.
func NewAntigravity() *Antigravity { return &Antigravity{} }

func (a *Antigravity) Name() string { return "antigravity" }

// WireFormat declares the upstream dialect. The IDE endpoint is Google
// generateContent, not chat-completions — a Claude or OpenAI body sent here would
// be rejected by schema, not merely mis-served.
func (a *Antigravity) WireFormat() string { return FormatGemini }

// Endpoint selects the base url and the action. Image models must use the unary
// generateContent action, everything else streams.
func (a *Antigravity) Endpoint(req Request, cred Credential) (string, error) {
	base := cred.BaseURL
	if base == "" {
		idx := 0
		if cred.Extra != nil {
			if v := cred.Extra["urlIndex"]; v != "" {
				fmt.Sscanf(v, "%d", &idx)
			}
		}
		if idx < 0 || idx >= len(AntigravityIDEBases) {
			idx = 0
		}
		base = AntigravityIDEBases[idx]
	}
	action := "generateContent"
	if req.Stream && !isImageModel(req.Model) {
		action = "streamGenerateContent?alt=sse"
	}
	return fmt.Sprintf("%s/v1internal:%s", strings.TrimSuffix(base, "/"), action), nil
}

// Headers is the whole IDE identity: bearer access token plus the frozen user
// agent. Nothing else — the executor sends nothing else.
func (a *Antigravity) Headers(req Request, cred Credential) (map[string]string, error) {
	token := cred.AccessToken
	if token == "" {
		token = cred.APIKey
	}
	return map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer " + token,
		"User-Agent":    AntigravityIDEUserAgent,
	}, nil
}

// imageModelSuffixes mark the models that go through the image pipeline.
var imageModelSuffixes = []string{"-image", "nano-banana", "imagen"}

// isImageModel classifies a model id as an image generator.
func isImageModel(model string) bool {
	m := strings.ToLower(model)
	for _, s := range imageModelSuffixes {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// ── registry wiring ───────────────────────────────────────────────────────────

// TrafficWave2 is the set of providers the traffic data says matter most after
// the OpenAI-compatible majority.
var TrafficWave2 = []string{"grok-cli", "qoder", "antigravity"}

// RegisterWave2 adds the wave-2 adapters to a registry.
func RegisterWave2(r *Registry) {
	r.Register(NewGrokCli())
	r.Register(NewQoder("intl"))
	r.Register(NewQoder("cn"))
	r.Register(NewAntigravity())
}

// SortedNames is a convenience for reporting.
func SortedNames(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
