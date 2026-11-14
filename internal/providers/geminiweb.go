package providers

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Gemini Web — port of open-sse/executors/gemini-web.js.
//
// The consumer web endpoint, driven by a pasted cookie. Three parts carry all the
// behaviour, and each is here for a reason:
//
//  1. Model resolution. The endpoint identifies a model by a hex id AND a numeric
//     mode slot. The mode is not derivable from the hex (Argon's hex alone returns
//     Flash), so both are carried in a table and an alias chain resolves legacy ids.
//  2. A fixedsize 97-slot request array. The upstream reads positional fields, so
//     this has to be built to spec — a shorter array silently changes meaning.
//  3. A session token scraped from the app HTML, cached with a TTL and refreshed
//     once on rejection. The page is ~800KB and can take a minute to render, so
//     fetching it per request is the difference between usable and not.
const (
	geminiWebAppURL    = "https://gemini.google.com/app"
	geminiWebStreamURL = "https://gemini.google.com/_/BardChatUi/data/" +
		"assistant.lamda.BardFrontendService/StreamGenerate"
	geminiWebUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
	geminiWebSecCHUA = `"Chromium";v="146", "Google Chrome";v="146", "Not?A_Brand";v="24"`

	// geminiWebDefaultBL is the build label used when the page does not publish one.
	geminiWebDefaultBL = "boq_assistant-bard-web-server_20260315.08_p0"

	geminiWebInnerSlots = 97
	geminiWebSessionTTL = 10 * time.Minute

	geminiWebThinkingNormal   = 1
	geminiWebThinkingExtended = 2
)

// geminiWebHexIDs are the per-model hex identifiers.
var geminiWebHexIDs = map[string]string{
	"flashLite": "8c46e95b1a07cecc",
	"flash":     "56fdd199312815e2",
	"pro":       "e6fa609c3fa255c0",
	"argon":     "95a4c0abcba24364",
}

// geminiWebLegacyHex maps superseded hex ids onto their replacements.
var geminiWebLegacyHex = map[string]string{
	"fbb127bbb056c959": "gemini-3.8-flash",
	"cf41b0e0dd7d53e5": "gemini-3.5-flash-lite",
	"9d8ca3786ebdfbea": "gemini-3.1-pro",
}

// geminiWebModel is one servable model.
//
// Mode is the upstream's numeric selector. It is stored rather than derived
// because the same hex serves more than one mode and the server reads the mode,
// not the hex, when they disagree.
type geminiWebModel struct {
	HexID       string
	Mode        int
	Thinking    bool
	NeedsCookie bool
	AliasOf     string
}

// geminiWebModels is the servable set.
var geminiWebModels = map[string]geminiWebModel{
	"gemini-3.5-flash-lite":          {HexID: geminiWebHexIDs["flashLite"], Mode: 6},
	"gemini-3.8-flash":               {HexID: geminiWebHexIDs["flash"], Mode: 1, NeedsCookie: true},
	"gemini-3.7-flash":               {HexID: geminiWebHexIDs["flash"], Mode: 1, NeedsCookie: true, AliasOf: "gemini-3.8-flash"},
	"gemini-3.6-flash":               {HexID: geminiWebHexIDs["flash"], Mode: 1, NeedsCookie: true, AliasOf: "gemini-3.8-flash"},
	"gemini-3.1-pro":                 {HexID: geminiWebHexIDs["pro"], Mode: 3, NeedsCookie: true},
	"gemini-4-argon":                 {HexID: geminiWebHexIDs["argon"], Mode: 8, NeedsCookie: true},
	"gemini-3.5-flash-lite-thinking": {HexID: geminiWebHexIDs["flashLite"], Mode: 6, Thinking: true, NeedsCookie: true},
	"gemini-3.8-flash-thinking":      {HexID: geminiWebHexIDs["flash"], Mode: 1, Thinking: true, NeedsCookie: true},
	"gemini-3.7-flash-thinking":      {HexID: geminiWebHexIDs["flash"], Mode: 1, Thinking: true, NeedsCookie: true, AliasOf: "gemini-3.8-flash-thinking"},
	"gemini-3.6-flash-thinking":      {HexID: geminiWebHexIDs["flash"], Mode: 1, Thinking: true, NeedsCookie: true, AliasOf: "gemini-3.8-flash-thinking"},
	"gemini-3.1-pro-thinking":        {HexID: geminiWebHexIDs["pro"], Mode: 3, Thinking: true, NeedsCookie: true},
	"gemini-4-argon-thinking":        {HexID: geminiWebHexIDs["argon"], Mode: 8, Thinking: true, NeedsCookie: true},
}

// geminiWebAliases resolves user-facing names onto servable ids.
var geminiWebAliases = map[string]string{
	"gemini-3.8-flash": "gemini-3.8-flash",
	"gemini-3.7-flash": "gemini-3.8-flash",
	"gemini-3.6-flash": "gemini-3.8-flash",
	"gemini-3.5-flash": "gemini-3.8-flash",
	"gemini-3-flash":   "gemini-3.8-flash",
	"gemini-3.0-flash": "gemini-3.8-flash",
	"gemini-2.5-flash": "gemini-3.8-flash",
	"gemini-2.0-flash": "gemini-3.8-flash",
	"gemini-1.5-flash": "gemini-3.8-flash",
	"gemini-flash":     "gemini-3.8-flash",
	"flash":            "gemini-3.8-flash",
	"default":          "gemini-3.8-flash",
	"auto":             "gemini-3.8-flash",

	"gemini-3.5-flash-lite": "gemini-3.5-flash-lite",
	"gemini-3.1-flash-lite": "gemini-3.5-flash-lite",
	"gemini-3-flash-lite":   "gemini-3.5-flash-lite",
	"gemini-3.0-flash-lite": "gemini-3.5-flash-lite",
	"gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
	"gemini-2.0-flash-lite": "gemini-3.5-flash-lite",
	"gemini-flash-lite":     "gemini-3.5-flash-lite",
	"flash-lite":            "gemini-3.5-flash-lite",

	"gemini-3.1-pro": "gemini-3.1-pro",
	"gemini-3.5-pro": "gemini-3.1-pro",
	"gemini-3-pro":   "gemini-3.1-pro",
	"gemini-3.0-pro": "gemini-3.1-pro",
	"gemini-2.5-pro": "gemini-3.1-pro",
	"gemini-2.0-pro": "gemini-3.1-pro",
	"gemini-1.5-pro": "gemini-3.1-pro",
	"gemini-pro":     "gemini-3.1-pro",
	"pro":            "gemini-3.1-pro",

	"gemini-4-argon": "gemini-4-argon",
	"gemini-argon":   "gemini-4-argon",
	"argon":          "gemini-4-argon",
}

// geminiWebDefaultModel is the fallback when the caller names nothing servable.
const geminiWebDefaultModel = "gemini-3.8-flash"

// ResolveGeminiWebModel maps a caller-supplied model name onto a servable model.
//
// Order matters. A `-thinking` suffix is stripped and re-applied so that
// `gemini-3.6-flash-thinking` resolves through the flash alias and comes back as a
// thinking model rather than a base one. The exact table is consulted before the
// alias table so an explicit servable id is never rewritten.
func ResolveGeminiWebModel(model string) (string, geminiWebModel, bool) {
	lower := strings.ToLower(strings.TrimSpace(model))

	thinking := strings.HasSuffix(lower, "-thinking") ||
		strings.HasSuffix(lower, ":thinking") ||
		strings.HasSuffix(lower, "-think") ||
		strings.HasSuffix(lower, ":think")
	base := lower
	if thinking {
		base = regexp.MustCompile(`[-:](?:thinking|think)$`).ReplaceAllString(lower, "")
	}

	// Exact match on the servable table, thinking form preferred.
	if thinking {
		if m, ok := geminiWebModels[base+"-thinking"]; ok {
			return base + "-thinking", m, true
		}
	}
	if m, ok := geminiWebModels[base]; ok {
		return base, m, true
	}

	// Alias chain.
	target, ok := geminiWebAliases[base]
	if !ok {
		if thinking {
			if t, ok := geminiWebAliases[base+"-thinking"]; ok {
				target = t
				ok = true
			}
		}
		if !ok {
			return geminiWebDefaultModel, geminiWebModels[geminiWebDefaultModel], false
		}
	}
	if thinking && !strings.HasSuffix(target, "-thinking") {
		target += "-thinking"
	}
	if m, ok := geminiWebModels[target]; ok {
		return target, m, true
	}
	return geminiWebDefaultModel, geminiWebModels[geminiWebDefaultModel], false
}

// BuildGeminiWebInner builds the 97-slot request array.
//
// INNER_SLOTS is fixed at 97. The upstream reads positional fields, so the array
// must be exactly this length and the unset slots must be present as null — a
// shorter array does not mean "use defaults", it means the later slots shift and
// the request changes meaning.
func BuildGeminiWebInner(prompt string, mode int, thinking bool, uuid string) (string, error) {
	inner := make([]any, geminiWebInnerSlots)

	inner[0] = []any{prompt, 0, nil, nil, nil, nil, 0}
	inner[1] = []any{"en"}
	inner[2] = []any{"", "", "", nil, nil, nil, nil, nil, nil, ""}
	inner[6] = []any{0}
	inner[7] = 1
	inner[10] = 1
	inner[11] = 0
	// Turn index within the web conversation. A new session is opened per request,
	// so this is always 0.
	inner[17] = []any{[]any{0}}
	inner[18] = 0
	inner[27] = 1
	inner[30] = []any{4}
	// Observed as [1] in every browser scenario: signed in, anonymous, thinking.
	inner[41] = []any{1}
	inner[53] = 0
	inner[59] = uuid
	inner[61] = []any{}
	inner[68] = 1
	inner[79] = mode
	if thinking {
		inner[80] = geminiWebThinkingExtended
	} else {
		inner[80] = geminiWebThinkingNormal
	}
	inner[91] = 0
	if thinking {
		inner[96] = 1
	} else {
		inner[96] = 0
	}

	encoded, err := json.Marshal(inner)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// BuildGeminiWebPrompt folds a message list into one prompt string.
//
// The endpoint takes a single prompt, so history has to be rendered into it.
// System turns are hoisted to the front under a label rather than merged into
// each turn, because the endpoint has no system role and dropping them would
// silently discard the caller's instructions.
func BuildGeminiWebPrompt(messages []any) string {
	type turn struct {
		role    string
		content string
	}

	var turns []turn
	for _, raw := range messages {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role := "user"
		if r, ok := m["role"].(string); ok && r != "" {
			role = r
		}
		content := geminiWebTextFromContent(m["content"])
		if strings.TrimSpace(content) == "" {
			continue
		}
		turns = append(turns, turn{role: role, content: content})
	}

	lastUserIdx := -1
	for i := len(turns) - 1; i >= 0; i-- {
		if turns[i].role == "user" {
			lastUserIdx = i
			break
		}
	}
	lastUser := ""
	if lastUserIdx >= 0 {
		lastUser = turns[lastUserIdx].content
	}

	var history []string
	for i := 0; i < lastUserIdx; i++ {
		if turns[i].role == "user" || turns[i].role == "assistant" {
			label := "User"
			if turns[i].role == "assistant" {
				label = "Assistant"
			}
			history = append(history, label+": "+turns[i].content)
		}
	}

	var systemParts []string
	for _, t := range turns {
		if t.role == "system" {
			systemParts = append(systemParts, t.content)
		}
	}
	systemText := strings.Join(systemParts, "\n\n")

	if len(history) == 0 && systemText == "" {
		return lastUser
	}
	if len(history) == 0 {
		return "System:\n" + systemText + "\n\n" + lastUser
	}

	var parts []string
	if systemText != "" {
		parts = append(parts, "System:\n"+systemText)
	}
	parts = append(parts, "Previous conversation:\n"+strings.Join(history, "\n\n"))
	parts = append(parts, "Current user message:\n"+lastUser)
	return strings.Join(parts, "\n\n")
}

// geminiWebTextFromContent flattens a content field that may be a string or a
// list of typed parts.
func geminiWebTextFromContent(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var out []string
		for _, part := range v {
			if p, ok := part.(map[string]any); ok {
				if txt, ok := p["text"].(string); ok {
					out = append(out, txt)
					continue
				}
			}
			if s, ok := part.(string); ok {
				out = append(out, s)
			}
		}
		return strings.Join(out, "")
	case nil:
		return ""
	default:
		encoded, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}

// geminiWebCodeArtifactRE matches the code-execution fences the model emits.
var (
	geminiWebCodeArtifactRE = regexp.MustCompile(
		"(?s)```(?:python|javascript|text)\\?code_(?:reference|stdout)&code_event_index=\\d+\n.*?```\n?")
	geminiWebCodeMarkerRE = regexp.MustCompile(
		"```(python|javascript|text)\\?code_(?:reference|stdout)&code_event_index=\\d+")
)

// CleanGeminiWebText strips code-execution artifacts.
//
// If stripping empties the reply, the whole answer WAS a code execution, so the
// marker is degraded to an ordinary fence instead. Returning an empty string there
// reads downstream as an upstream failure rather than as a result.
func CleanGeminiWebText(text string) string {
	cleaned := strings.TrimSpace(geminiWebCodeArtifactRE.ReplaceAllString(text, ""))
	if cleaned == "" && strings.TrimSpace(text) != "" {
		return strings.TrimSpace(geminiWebCodeMarkerRE.ReplaceAllString(text, "```$1"))
	}
	return cleaned
}

// ParseGeminiWebStream pulls the reply text out of a stream body.
//
// The body is a series of JSON lines, each an array whose first element is
// `["wrb.fr", ...]`; the assistant text lives at inner[4][0][1] as a list of
// string chunks. Lines that are not that shape are skipped rather than fatal —
// the stream carries keepalives and length markers interleaved.
func ParseGeminiWebStream(raw string) string {
	last := ""
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == ")]}'" || isAllDigits(line) {
			continue
		}
		if !strings.Contains(line, "wrb.fr") {
			continue
		}
		var arr []any
		if err := json.Unmarshal([]byte(line), &arr); err != nil {
			continue
		}
		if len(arr) == 0 {
			continue
		}
		first, ok := arr[0].([]any)
		if !ok || len(first) < 3 || first[0] != "wrb.fr" {
			continue
		}
		payload, ok := first[2].(string)
		if !ok {
			continue
		}
		var inner []any
		if err := json.Unmarshal([]byte(payload), &inner); err != nil {
			continue
		}
		text := geminiWebNestedText(inner, 4, 0, 1)
		if text != "" {
			last = text
		}
	}
	return last
}

// ParseGeminiWebReasoning pulls the thinking chain out of a stream body.
//
// The slot is inner[4][0][37][0][0]. The LONGEST chain wins rather than the last
// one seen: once the chain freezes, later frames omit or truncate that slot, so
// taking the last frame loses text.
func ParseGeminiWebReasoning(raw string) string {
	best := ""
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == ")]}'" || isAllDigits(line) {
			continue
		}
		// A short line cannot carry the nested payload.
		if !strings.Contains(line, "wrb.fr") || len(line) < 200 {
			continue
		}
		var arr []any
		if err := json.Unmarshal([]byte(line), &arr); err != nil {
			continue
		}
		if len(arr) == 0 {
			continue
		}
		first, ok := arr[0].([]any)
		if !ok || len(first) < 3 || first[0] != "wrb.fr" {
			continue
		}
		payload, ok := first[2].(string)
		if !ok || len(payload) < 50 {
			continue
		}
		var inner []any
		if err := json.Unmarshal([]byte(payload), &inner); err != nil {
			continue
		}
		text := geminiWebNestedText(inner, 4, 0, 37, 0, 0)
		if len(text) > len(best) {
			best = text
		}
	}
	return CleanGeminiWebText(best)
}

// geminiWebNestedText walks a path and joins the string chunks found there.
func geminiWebNestedText(node any, path ...int) string {
	cur := node
	for _, idx := range path {
		arr, ok := cur.([]any)
		if !ok || idx >= len(arr) {
			return ""
		}
		cur = arr[idx]
	}
	switch v := cur.(type) {
	case string:
		return v
	case []any:
		var parts []string
		for _, item := range v {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// ── session parameters ───────────────────────────────────────────────────────

// geminiWebSession holds the scraped per-session values.
type geminiWebSession struct {
	At        string
	Bl        string
	ExpiresAt time.Time
}

// GeminiWebSessionCache caches scraped session parameters per cookie.
//
// The app page is large and can take a minute to render, so this cache is what
// makes a burst of requests viable. The `at` value is a per-session token that
// survives until the server rejects it, so refresh is driven by rejection, not
// only by the TTL.
type GeminiWebSessionCache struct {
	mu      sync.Mutex
	entries map[string]geminiWebSession
	now     func() time.Time
}

// NewGeminiWebSessionCache builds an empty cache.
func NewGeminiWebSessionCache() *GeminiWebSessionCache {
	return &GeminiWebSessionCache{
		entries: make(map[string]geminiWebSession),
		now:     time.Now,
	}
}

// Get returns a live session for the cookie.
func (c *GeminiWebSessionCache) Get(cookie string) (geminiWebSession, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.entries[cookie]
	if !ok || c.now().After(s.ExpiresAt) {
		return geminiWebSession{}, false
	}
	return s, true
}

// Put stores a session with the standard TTL.
func (c *GeminiWebSessionCache) Put(cookie string, s geminiWebSession) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s.ExpiresAt = c.now().Add(geminiWebSessionTTL)
	c.entries[cookie] = s
}

// Invalidate drops a session so the next call re-scrapes.
func (c *GeminiWebSessionCache) Invalidate(cookie string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, cookie)
}

// Size reports the number of cached sessions, for observability.
func (c *GeminiWebSessionCache) Size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

var (
	geminiWebAtRE = regexp.MustCompile(`"SNlM0e":"([^"]+)"`)
	geminiWebBlRE = regexp.MustCompile(`"cfb2h":"([^"]+)"`)
)

// ParseGeminiWebSessionParams scrapes the session token and build label from the
// app HTML. The build label falls back to the constant the browser sends.
func ParseGeminiWebSessionParams(html string) (geminiWebSession, bool) {
	at := geminiWebAtRE.FindStringSubmatch(html)
	if at == nil {
		// The escaped form appears when the value is embedded in a JS string.
		alt := regexp.MustCompile(`SNlM0e\\?":\\?"([^"\\]+)`).FindStringSubmatch(html)
		if alt == nil {
			return geminiWebSession{}, false
		}
		at = alt
	}
	bl := geminiWebDefaultBL
	if m := geminiWebBlRE.FindStringSubmatch(html); m != nil {
		bl = m[1]
	}
	return geminiWebSession{At: at[1], Bl: bl}, true
}

// GeminiWebHeaders is the browser header set for the stream call.
func GeminiWebHeaders(cookie string) map[string]string {
	return map[string]string{
		"Accept":                   "*/*",
		"Accept-Language":          "en-US,en;q=0.9",
		"User-Agent":               geminiWebUA,
		"Sec-CH-UA":                geminiWebSecCHUA,
		"Sec-CH-UA-Mobile":         "?0",
		"Sec-CH-UA-Platform":       `"Windows"`,
		"Sec-Fetch-Dest":           "empty",
		"Sec-Fetch-Mode":           "cors",
		"Sec-Fetch-Site":           "same-origin",
		"Origin":                   "https://gemini.google.com",
		"Referer":                  geminiWebAppURL,
		"X-Same-Domain":            "1",
		"X-Goog-AuthUser":          "0",
		"x-goog-ext-73010989-jspb": "[0]",
		"x-goog-ext-73010990-jspb": "[0,0,0]",
		"Cookie":                   cookie,
	}
}

// GeminiWebStreamQuery assembles the query string for the stream call.
//
// The build label and session token are part of the query, not the body, which is
// why the session scrape has to happen before the call can even be formed.
func GeminiWebStreamQuery(session geminiWebSession, requestID string) string {
	params := map[string]string{
		"bl":     session.Bl,
		"f.sid":  requestID,
		"hl":     "en",
		"_reqid": requestID,
		"rt":     "c",
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+params[k])
	}
	return strings.Join(parts, "&")
}

// ── adapter ──────────────────────────────────────────────────────────────────

// GeminiWeb is the adapter. It carries the session cache because the scrape is
// expensive and spans requests.
type GeminiWeb struct {
	sessions *GeminiWebSessionCache
}

// NewGeminiWeb builds the adapter.
func NewGeminiWeb() *GeminiWeb {
	return &GeminiWeb{sessions: NewGeminiWebSessionCache()}
}

func (a *GeminiWeb) Name() string       { return "gemini-web" }
func (a *GeminiWeb) WireFormat() string { return FormatGemini }

// Endpoint is the StreamGenerate path. The query carries the session values.
func (a *GeminiWeb) Endpoint(req Request, cred Credential) (string, error) {
	session, ok := a.sessions.Get(cred.Cookie)
	if !ok {
		return "", fmt.Errorf("gemini-web: no live session for this cookie; the app page could not be read")
	}
	return geminiWebStreamURL + "?" + GeminiWebStreamQuery(session, req.RequestID), nil
}

// Headers is the browser header set.
func (a *GeminiWeb) Headers(req Request, cred Credential) (map[string]string, error) {
	if cred.Cookie == "" {
		return nil, fmt.Errorf("gemini-web: no cookie on the connection")
	}
	return GeminiWebHeaders(cred.Cookie), nil
}

// Sessions exposes the cache so a caller can prime or invalidate it.
func (a *GeminiWeb) Sessions() *GeminiWebSessionCache { return a.sessions }
