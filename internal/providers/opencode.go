package providers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// OpenCode — the free-lane client fingerprint.
//
// Port of open-sse/executors/opencode.js plus utils/opencodeFingerprint.js.
//
// This provider's free tier gates on three independent ClientHello/body signals,
// and passing only some of them yields a 403 FreeTierError or a 429
// FreeUsageLimitError that looks like ordinary rate limiting:
//
//  1. TLS fingerprint (the upstream gate keys on the ClientHello). The Go
//     transport uses the standard library, which does NOT impersonate Node; the
//     Node executor routes through a wreq-js client for exactly this reason. That
//     gate is therefore the one piece NOT reproduced here, and it is called out
//     rather than papered over.
//  2. Tool declarations (read/shell/edit/glob/grep with exact descriptions) and a
//     `<env>` marker in the system prompt. Both are reproduced faithfully below —
//     a stubbed description or a reworded schema is refused.
//  3. The session id shape and its embedded timestamp.
//
// The session id is the subtle part. Upstream decodes the 12-hex prefix as a
// DESCENDING millisecond timestamp and refuses a session whose time is in the
// future or older than the free-tier window. A uniformly random prefix almost
// always decodes to an out-of-range time, so a digest-derived session is refused
// even though its shape matches. Sessions must be minted from the current clock
// and then memoised per conversation.

// OpenCode adapter.
type OpenCode struct {
	sessions *openCodeSessions
	// pace serialises request starts; the upstream's rate limiter treats a burst
	// as abuse well before it treats it as load.
	pace *openCodePacer
}

// NewOpenCode builds the adapter with its own session and pacing state.
func NewOpenCode() *OpenCode {
	return &OpenCode{
		sessions: newOpenCodeSessions(),
		pace:     newOpenCodePacer(),
	}
}

func (a *OpenCode) Name() string       { return "opencode" }
func (a *OpenCode) WireFormat() string { return FormatOpenAI }

const (
	opencodeBaseURL = "https://opencode.ai"
	// opencodeSessionMax bounds a session value. The upstream rejects anything
	// longer, so an over-long client value is treated as absent rather than sent.
	opencodeSessionMax = 256
	// opencodeToolBudget is the tool-surface ceiling. The free tier's WAF rejects
	// a declaration set larger than this, and the rejection reads as a WAF block
	// rather than an error.
	opencodeToolBudget = 38000
)

// opencodeSessionRE is the accepted session shape: `ses_` + 12 hex + 14 alnum.
const (
	opencodeSessionPrefix   = "ses_"
	opencodeSessionHexLen   = 12
	opencodeSessionAlnumLen = 14
)

// validOpenCodeSession checks a candidate value against the required shape.
//
// Shape matters, not just length: upstream decodes the hex run as a timestamp, so
// a value of the right length with the wrong character classes is refused.
func validOpenCodeSession(s string) bool {
	if len(s) != len(opencodeSessionPrefix)+opencodeSessionHexLen+opencodeSessionAlnumLen {
		return false
	}
	if !strings.HasPrefix(s, opencodeSessionPrefix) {
		return false
	}
	rest := s[len(opencodeSessionPrefix):]
	for i := 0; i < opencodeSessionHexLen; i++ {
		c := rest[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	for i := opencodeSessionHexLen; i < len(rest); i++ {
		c := rest[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return false
		}
	}
	return true
}

// ── session minting ──────────────────────────────────────────────────────────

const opencodeBase62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// sessionPrefixMask is 2^48-1: the prefix is 12 hex digits, so only the low 48
// bits of the inverted value are kept.
const sessionPrefixMask = uint64(1)<<48 - 1

// openCodeSessions memoises sessions per downstream identity.
//
// Two stores, matching the Node implementation: `stable` is one canonical session
// per connection (what the real CLI does — a fresh session per request burns the
// per-session quota and surfaces as a growing 429 reset delay), and `translated`
// maps a caller-supplied session onto a minted one so the caller's conversation
// keeps the same upstream session.
type openCodeSessions struct {
	mu         sync.Mutex
	stable     map[string]openCodeSessionEntry
	translated map[string]openCodeSessionEntry
	// lastTimestamp and counter mirror the Node generator: the counter increments
	// within the same millisecond and resets when the clock moves, so two sessions
	// minted in one tick do not collide.
	lastTimestamp int64
	counter       uint64
	now           func() time.Time
}

type openCodeSessionEntry struct {
	sessionID string
	lastUsed  time.Time
}

// MaxStableSessions / MaxTranslatedSessions bound the maps. Unbounded session
// stores are a slow leak on a gateway that sees many distinct callers.
const (
	MaxStableSessions     = 1000
	MaxTranslatedSessions = 5000
	// OpenCodeSessionTTL is how long a memoised session survives without use.
	OpenCodeSessionTTL = 30 * time.Minute
)

func newOpenCodeSessions() *openCodeSessions {
	return &openCodeSessions{
		stable:     map[string]openCodeSessionEntry{},
		translated: map[string]openCodeSessionEntry{},
		now:        time.Now,
	}
}

// descendingTimeHex encodes time and a counter as a DESCENDING 12-hex value.
//
// The inversion is what makes the field descending, and upstream depends on it:
// a session minted now must sort before an older one. Emitting an ascending
// encoding produces ids that decode to a future timestamp and are refused.
func descendingTimeHex(t time.Time, counter uint64) string {
	v := uint64(t.UnixMilli())*0x1000 + counter
	v = ^v & sessionPrefixMask
	return fmt.Sprintf("%012x", v)
}

// mint generates one session id from the current clock.
func (s *openCodeSessions) mint() string {
	now := s.now()
	ms := now.UnixMilli()
	if ms != s.lastTimestamp {
		s.lastTimestamp = ms
		s.counter = 0
	}
	s.counter = (s.counter + 1) & 0x0F
	return "ses_" + descendingTimeHex(now, s.counter) + unstableRandom()
}

// unstableRandom returns 14 base62 characters from crypto/rand.
func unstableRandom() string {
	buf := make([]byte, 14)
	if _, err := rand.Read(buf); err != nil {
		// A crypto/rand failure is not recoverable, and a predictable session id
		// would be worse than a failed request.
		panic(fmt.Sprintf("opencode: crypto/rand unavailable: %v", err))
	}
	out := make([]byte, 14)
	for i, b := range buf {
		out[i] = opencodeBase62[int(b)%len(opencodeBase62)]
	}
	return string(out)
}

// translateSession maps a caller session onto a minted one, memoised per
// (clientTool, session) so the same conversation keeps one upstream session.
func (s *openCodeSessions) translate(sessionID, clientTool string) string {
	if validOpenCodeSession(strings.TrimSpace(sessionID)) {
		return strings.TrimSpace(sessionID)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	key := clientTool + "\x00" + sessionID
	if e, ok := s.translated[key]; ok {
		e.lastUsed = s.now()
		s.translated[key] = e
		return e.sessionID
	}

	s.evictTranslatedLocked()
	id := s.mint()
	s.translated[key] = openCodeSessionEntry{sessionID: id, lastUsed: s.now()}
	return id
}

// stable returns one canonical session per downstream identity.
func (s *openCodeSessions) stable_(identityKey string) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	if e, ok := s.stable[identityKey]; ok {
		e.lastUsed = s.now()
		s.stable[identityKey] = e
		return e.sessionID
	}

	s.evictStableLocked()
	id := s.mint()
	s.stable[identityKey] = openCodeSessionEntry{sessionID: id, lastUsed: s.now()}
	return id
}

// Forget drops a session id so the next request mints a fresh one.
//
// Called when upstream rejects a session: the memoised id is never revisited on
// failure, so without this every later request reuses a spent session and fails
// identically until the process restarts. Matching is by VALUE, not by key — a
// concurrent request may already have minted a replacement, and that one must
// survive.
func (s *openCodeSessions) Forget(sessionID string) bool {
	if sessionID == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	removed := false
	for _, store := range []map[string]openCodeSessionEntry{s.stable, s.translated} {
		for k, e := range store {
			if e.sessionID == sessionID {
				delete(store, k)
				removed = true
			}
		}
	}
	return removed
}

// Sweep drops sessions unused for longer than the TTL.
func (s *openCodeSessions) Sweep() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	cutoff := s.now().Add(-OpenCodeSessionTTL)
	dropped := 0
	for _, store := range []map[string]openCodeSessionEntry{s.stable, s.translated} {
		for k, e := range store {
			if e.lastUsed.Before(cutoff) {
				delete(store, k)
				dropped++
			}
		}
	}
	return dropped
}

func (s *openCodeSessions) evictStableLocked() {
	if len(s.stable) < MaxStableSessions {
		return
	}
	s.evictOldestLocked(s.stable)
}

func (s *openCodeSessions) evictTranslatedLocked() {
	if len(s.translated) < MaxTranslatedSessions {
		return
	}
	s.evictOldestLocked(s.translated)
}

// evictOldestLocked drops the least-recently-used entry. Callers hold the mutex.
func (s *openCodeSessions) evictOldestLocked(store map[string]openCodeSessionEntry) {
	var oldestKey string
	var oldest time.Time
	first := true
	for k, e := range store {
		if first || e.lastUsed.Before(oldest) {
			oldestKey, oldest, first = k, e.lastUsed, false
		}
	}
	if oldestKey != "" {
		delete(store, oldestKey)
	}
}

// ── request pacing ───────────────────────────────────────────────────────────

// openCodePacer spaces request starts so a burst is not read as abuse.
//
// The gap is deliberately on the REQUEST START, not between retries: the upstream
// limiter fires on the arrival pattern, so pacing retries alone would still let a
// burst through.
type openCodePacer struct {
	mu     sync.Mutex
	lastAt time.Time
	minGap time.Duration
	now    func() time.Time
	sleep  func(time.Duration)
}

// OpenCodeMinStartGap is the minimum spacing between request starts.
const OpenCodeMinStartGap = 400 * time.Millisecond

func newOpenCodePacer() *openCodePacer {
	return &openCodePacer{
		minGap: OpenCodeMinStartGap,
		now:    time.Now,
		sleep:  time.Sleep,
	}
}

// Wait blocks until the next start is allowed.
func (p *openCodePacer) Wait() {
	p.mu.Lock()
	now := p.now()
	wait := p.lastAt.Add(p.minGap).Sub(now)
	if wait > 0 && wait <= time.Second {
		p.mu.Unlock()
		p.sleep(wait)
		p.mu.Lock()
		now = p.now()
	}
	p.lastAt = now
	p.mu.Unlock()
}

// ── retry classification ─────────────────────────────────────────────────────

// OpenCodeOverloadAttempts is the total number of tries for a transient overload.
// A live burst lasts roughly 20 s, so the backoff schedule below covers it.
const (
	OpenCodeOverloadAttempts = 8
	OpenCodeOverloadBase     = 800 * time.Millisecond
	OpenCodeOverloadMax      = 4 * time.Second
)

// classifyOpenCodeRejection distinguishes a transient overload from a spent
// session.
//
// The distinction matters because the two need opposite responses: an overload is
// worth retrying with the same session, while a spent session requires minting a
// new one. Treating the second as the first burns the retry budget against a
// session that will never work.
func classifyOpenCodeRejection(status int, body string) string {
	if status != 429 && status != 403 {
		return ""
	}
	if status == 403 {
		return "session"
	}
	if strings.Contains(strings.ToLower(body), "overloaded") {
		return "overload"
	}
	return "session"
}

// openCodeOverloadBackoff returns the delay before the next attempt.
func openCodeOverloadBackoff(attempt int) time.Duration {
	d := time.Duration(attempt) * OpenCodeOverloadBase
	if d > OpenCodeOverloadMax {
		d = OpenCodeOverloadMax
	}
	return d
}

// ── fingerprint: tools ───────────────────────────────────────────────────────

// OpenCodeFingerprintTools are the names the free-tier gate requires.
var OpenCodeFingerprintTools = []string{"edit", "glob", "grep", "read", "shell"}

// opencodeToolDef is one required declaration.
type opencodeToolDef struct {
	Description string
	Parameters  map[string]any
}

// The descriptions and schemas are copied verbatim from the OpenCode CLI
// specification. Upstream compares them, so rewording or reformatting any of this
// is a 403 — this is data that must not be "improved".
var openCodeFingerprintDefinitions = map[string]opencodeToolDef{
	"edit": {
		Description: "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":       map[string]any{"type": "string", "description": "File to edit"},
				"oldString":  map[string]any{"type": "string", "description": "Exact text to find and replace"},
				"newString":  map[string]any{"type": "string", "description": "Text to replace oldString with (must differ from oldString)"},
				"replaceAll": map[string]any{"type": "boolean", "description": "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."},
			},
			"required":             []any{"path", "oldString", "newString"},
			"additionalProperties": false,
		},
	},
	"glob": {
		Description: "Find files matching a glob pattern relative to a directory. Output is a list of file paths. Always use forward slashes (/) as path separators even on Windows. The pattern supports standard glob features: * matches characters within a directory, ** matches across directories, ? matches a single character, and [abc] matches a character set. Prefer specific patterns over broad ones.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{"type": "string", "description": "Glob pattern to match files against"},
				"path":    map[string]any{"type": "string", "description": "Directory to search. Defaults to the current working directory."},
				"hidden":  map[string]any{"type": "boolean", "description": "Include hidden files and directories (default: false)."},
				"limit":   map[string]any{"type": "integer", "exclusiveMinimum": 0, "description": "Maximum number of matching files to return (default: 100)"},
			},
			"required":             []any{"pattern"},
			"additionalProperties": false,
		},
	},
	"grep": {
		Description: "Search for a regular expression pattern within files. Lines are returned with 1-based line numbers. By default, searches recursively from the working directory. Output is sorted by file path and line number.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern":       map[string]any{"type": "string", "minLength": 1, "description": "Regular expression or literal text to match in file contents."},
				"path":          map[string]any{"type": "string", "description": "File or directory to search. Defaults to the current working directory."},
				"include":       map[string]any{"type": "string", "description": "Glob pattern to filter files (for example, \"*.js\" or \"*.{ts,tsx}\")"},
				"literal":       map[string]any{"type": "boolean", "description": "Treat pattern as exact text instead of a regular expression (default: false)."},
				"caseSensitive": map[string]any{"type": "boolean", "description": "Use case-sensitive matching (default: true)."},
				"limit":         map[string]any{"type": "integer", "exclusiveMinimum": 0, "description": "Maximum number of matching lines to return (default: 100)"},
			},
			"required":             []any{"pattern"},
			"additionalProperties": false,
		},
	},
	"read": {
		Description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":   map[string]any{"type": "string", "description": "File or directory to read"},
				"offset": map[string]any{"type": "integer", "minimum": 0, "description": "The line or directory entry to start reading from (1-based)"},
				"limit":  map[string]any{"type": "integer", "minimum": 0, "description": "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"},
			},
			"required":             []any{"path"},
			"additionalProperties": false,
		},
	},
	"shell": {
		Description: "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command":    map[string]any{"type": "string", "description": "Shell command string to execute"},
				"workdir":    map[string]any{"type": "string", "description": "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."},
				"timeout":    map[string]any{"type": "integer", "minimum": 0, "description": "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."},
				"background": map[string]any{"type": "boolean", "description": "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."},
			},
			"required":             []any{"command"},
			"additionalProperties": false,
		},
	},
}

// ── fingerprint: env marker ──────────────────────────────────────────────────

// openCodeEnvTag is the marker the gate looks for. Its presence is the signal; the
// body of the marker is informational.
const openCodeEnvTag = "<env>"

// openCodeEnvPrompt builds the environment marker.
func openCodeEnvPrompt() string {
	wd, err := os.Getwd()
	if err != nil {
		wd = "."
	}
	tmp := filepath.Join(os.TempDir(), "opencode")
	return strings.Join([]string{
		"Here is some useful information about the environment you are running in:",
		openCodeEnvTag,
		"  Working directory: " + wd,
		"  Workspace root folder: " + wd,
		"  Is directory a git repo: no",
		"  Platform: " + runtime.GOOS,
		"  Prefer " + tmp + " over generic system temporary directories such as /tmp; it is pre-created and approved for external access.",
		"</env>",
	}, "\n")
}

// systemCarriesEnv reports whether a system prompt already has the marker.
//
// A genuine OpenCode client already sends it, and appending a second copy would
// change a request the gate would otherwise pass.
func systemCarriesEnv(system any) bool {
	switch v := system.(type) {
	case string:
		return strings.Contains(v, openCodeEnvTag)
	case []any:
		for _, raw := range v {
			if b, ok := raw.(map[string]any); ok {
				if t, ok := b["text"].(string); ok && strings.Contains(t, openCodeEnvTag) {
					return true
				}
			}
		}
	}
	return false
}

// appendSystemText appends text to a system prompt held as a string, as text
// blocks, or unset.
func appendSystemText(system any, text string) any {
	if s, ok := system.(string); ok {
		if strings.TrimSpace(s) != "" {
			return s + "\n\n" + text
		}
		return text
	}

	blocks, _ := system.([]any)
	out := append([]any{}, blocks...)
	// Trailing text block first: appending mid-list would separate the marker from
	// the prompt it belongs to.
	for i := len(out) - 1; i >= 0; i-- {
		b, ok := out[i].(map[string]any)
		if !ok {
			continue
		}
		if t, ok := b["text"].(string); ok {
			next := map[string]any{}
			for k, v := range b {
				next[k] = v
			}
			if strings.TrimSpace(t) != "" {
				next["text"] = t + "\n\n" + text
			} else {
				next["text"] = text
			}
			out[i] = next
			return out
		}
	}
	return append(out, map[string]any{"type": "text", "text": text})
}

// ApplyEnvFingerprint adds the environment marker to whichever request shape the
// body uses: Responses `instructions`, chat `messages[]` system, or the
// claude-shaped top-level `system`.
//
// Fail-open by design: a shape this does not recognise is left untouched, because
// the marker is an enhancement and mangling an unusual body would break a request
// that might otherwise have passed.
func ApplyEnvFingerprint(body map[string]any, flat bool, claude bool) bool {
	if body == nil {
		return false
	}

	if flat {
		if v, ok := body["instructions"]; ok {
			if _, isString := v.(string); !isString {
				return false
			}
		}
		if systemCarriesEnv(body["instructions"]) {
			return false
		}
		if s, isString := body["instructions"].(string); isString && strings.TrimSpace(s) != "" {
			body["instructions"] = s + "\n\n" + openCodeEnvPrompt()
		} else {
			body["instructions"] = openCodeEnvPrompt()
		}
		return true
	}

	if claude || body["system"] != nil {
		if systemCarriesEnv(body["system"]) {
			return false
		}
		body["system"] = appendSystemText(body["system"], openCodeEnvPrompt())
		return true
	}

	msgs, ok := body["messages"].([]any)
	if !ok {
		return false
	}
	for i, raw := range msgs {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if m["role"] != "system" {
			continue
		}
		if systemCarriesEnv(m["content"]) {
			return false
		}
		updated := map[string]any{}
		for k, v := range m {
			updated[k] = v
		}
		updated["content"] = appendSystemText(m["content"], openCodeEnvPrompt())
		next := append([]any{}, msgs...)
		next[i] = updated
		body["messages"] = next
		return true
	}

	body["messages"] = append([]any{map[string]any{
		"role":    "system",
		"content": openCodeEnvPrompt(),
	}}, msgs...)
	return true
}

// ── fingerprint: tool application ────────────────────────────────────────────

// toolNameOf reads a tool name from either the flat ({name}) or chat
// ({function:{name}}) shape.
func toolNameOf(tool any) string {
	m, ok := tool.(map[string]any)
	if !ok {
		return ""
	}
	if n, ok := m["name"].(string); ok && strings.TrimSpace(n) != "" {
		return strings.TrimSpace(n)
	}
	if fn, ok := m["function"].(map[string]any); ok {
		if n, ok := fn["name"].(string); ok {
			return strings.TrimSpace(n)
		}
	}
	return ""
}

// fingerprintToolKey returns the canonical name when the tool uses exactly one,
// else "".
func fingerprintToolKey(name string) string {
	for _, n := range OpenCodeFingerprintTools {
		if name == n {
			return n
		}
	}
	return ""
}

// AppendMissingFingerprintTools injects every required declaration the caller did
// not already send, and returns the names it added.
//
// This runs even when the caller supplied tools. An agent client's request almost
// always has a non-empty tool array, and skipping the injection because of that is
// what triggers a 403: the gate wants OpenCode's own five declarations present,
// not merely a non-empty list.
func AppendMissingFingerprintTools(tools []any, flat bool) ([]any, []string) {
	if tools == nil {
		tools = []any{}
	}

	present := map[string]bool{}
	for _, t := range tools {
		if k := fingerprintToolKey(toolNameOf(t)); k != "" {
			present[k] = true
		}
	}

	var appended []string
	for _, name := range OpenCodeFingerprintTools {
		if present[name] {
			continue
		}
		def := openCodeFingerprintDefinitions[name]
		var tool map[string]any
		if flat {
			tool = map[string]any{
				"type": "function", "name": name,
				"description": def.Description, "parameters": def.Parameters,
				"strict": false,
			}
		} else {
			tool = map[string]any{
				"type": "function",
				"function": map[string]any{
					"name": name, "description": def.Description, "parameters": def.Parameters,
				},
			}
		}
		tools = append(tools, tool)
		appended = append(appended, name)
	}
	return tools, appended
}

// enforceToolBudget trims the tool surface to the WAF ceiling.
//
// The canonical five are kept intact and the remainder are dropped in order until
// the budget fits: truncating a canonical definition would fail the fingerprint
// check, which is a worse outcome than losing an optional caller tool.
func enforceToolBudget(tools []any) []any {
	raw, err := json.Marshal(tools)
	if err != nil || len(raw) <= opencodeToolBudget {
		return tools
	}

	canonicalSet := map[string]bool{}
	for _, n := range OpenCodeFingerprintTools {
		canonicalSet[n] = true
	}

	var canonical, extras []any
	for _, t := range tools {
		if canonicalSet[toolNameOf(t)] {
			canonical = append(canonical, t)
		} else {
			extras = append(extras, t)
		}
	}

	canonicalRaw, _ := json.Marshal(canonical)
	budget := opencodeToolBudget - len(canonicalRaw)

	kept := canonical
	for _, ex := range extras {
		exRaw, err := json.Marshal(ex)
		if err != nil {
			continue
		}
		if budget-len(exRaw) > 0 {
			kept = append(kept, ex)
			budget -= len(exRaw)
		}
	}
	return kept
}

// ApplyFingerprintTools applies the whole body-side gate.
//
// Order matters: names are concealed, missing declarations appended, tool_choice
// retargeted, the env marker applied, and the budget trimmed last so the trim
// accounts for everything above.
func ApplyFingerprintTools(body map[string]any, flat bool, claude bool) {
	if body == nil {
		return
	}

	tools, _ := body["tools"].([]any)
	tools, _ = AppendMissingFingerprintTools(tools, flat)
	body["tools"] = tools

	// The `<env>` marker is required on every free-lane request, with or without
	// tools, so it is applied unconditionally.
	ApplyEnvFingerprint(body, flat, claude)

	// tool_choice "none" is refused across every lane, so it is removed rather
	// than translated. A caller that explicitly asked for no tools still gets the
	// canonical declarations, which is the gate's requirement.
	if tc, ok := body["tool_choice"].(string); ok && tc == "none" {
		delete(body, "tool_choice")
	} else if tc, ok := body["tool_choice"].(map[string]any); ok && tc["type"] == "none" {
		delete(body, "tool_choice")
	}

	// Legacy retention field is replaced by the options object the current API
	// reads.
	if body["prompt_cache_retention"] != nil {
		delete(body, "prompt_cache_retention")
		if body["prompt_cache_options"] == nil {
			body["prompt_cache_options"] = map[string]any{"mode": "implicit"}
		}
	}

	body["tools"] = enforceToolBudget(body["tools"].([]any))

	// Responses keeps an explicit auto default. Defaulting to "none" is refused
	// upstream, so it is never chosen here.
	if body["tool_choice"] == nil && flat {
		body["tool_choice"] = "auto"
	}
}

// ── URL routing ──────────────────────────────────────────────────────────────

// openCodeResponsesModels are the exact ids served over the Responses API.
var openCodeResponsesModels = map[string]bool{
	"muse-spark-1.2-contributor-free": true,
	"muse-spark-1.3-contributor-free": true,
}

// openCodeMessagesModels are the ids served over the Messages API.
var openCodeMessagesModels = map[string]bool{
	"union-alpha": true,
}

// isOpenCodeResponsesModel reports whether a model uses the Responses API.
func isOpenCodeResponsesModel(model string) bool {
	base := stripThinkingSuffix(model)
	return openCodeResponsesModels[base] || isResponsesModelName(base)
}

// isOpenCodeMessagesModel reports whether a model uses the Messages API.
func isOpenCodeMessagesModel(model string) bool {
	return openCodeMessagesModels[stripThinkingSuffix(model)]
}

// Endpoint routes per model family.
//
// The free lane moved from /zen/v1 to /inference/v1; the old prefix now answers
// every free request with a 403, so the moved path is not a preference.
func (a *OpenCode) Endpoint(req Request, cred Credential) (string, error) {
	base := strings.TrimSuffix(cred.BaseURL, "/")
	if base == "" {
		base = opencodeBaseURL
	}
	switch {
	case isOpenCodeResponsesModel(req.Model):
		return base + "/inference/openai/v1/responses", nil
	case isOpenCodeMessagesModel(req.Model):
		return base + "/inference/openai/v1/messages", nil
	default:
		return base + "/inference/openai/v1/chat/completions", nil
	}
}

// Headers builds the upstream header set including the session.
//
// The Authorization value is the literal "public" and that is the provider's
// published free-lane convention, not a placeholder: the lane meters quota per
// session and project rather than per account.
func (a *OpenCode) Headers(req Request, cred Credential) (map[string]string, error) {
	h := baseJSONHeaders()

	session, err := a.SessionFor(req, cred)
	if err != nil {
		return nil, err
	}
	url, _ := a.Endpoint(req, cred)

	traceID := randomHex(16)
	spanID := randomHex(8)
	parentSpanID := randomHex(8)

	h["Authorization"] = "Bearer public"
	h["User-Agent"] = openCodeUserAgent(cred)
	// b3 and traceparent are sent as a pair; the upstream reads either, and a
	// request carrying only one is treated as a probe.
	h["b3"] = traceID + "-" + spanID + "-1-" + parentSpanID
	h["traceparent"] = "00-" + traceID + "-" + spanID + "-01"
	h["x-opencode-client"] = headerFallback(cred, "x-opencode-client", "cli")
	h["x-opencode-project"] = headerFallback(cred, "x-opencode-project", randomProjectID())
	h["x-opencode-session"] = session
	h["x-opencode-session-id"] = session
	h["x-session-affinity"] = session
	h["x-session-id"] = session
	if strings.HasSuffix(url, "/messages") {
		h["anthropic-version"] = AnthropicAPIVersion
	}
	if req.Stream {
		h["Accept"] = "text/event-stream"
	} else {
		h["Accept"] = "*/*"
	}
	return h, nil
}

// SessionFor resolves the session for a request.
//
// Precedence: a native OpenCode client's own session is honoured outright, then a
// caller's session value is translated, then a hint is resolved through the
// session manager, and finally a canonical per-connection session is minted. The
// order is by how much the value is trusted, and stopping at the first hit is what
// keeps a conversation on one upstream session.
func (a *OpenCode) SessionFor(req Request, cred Credential) (string, error) {
	raw := headerFrom(cred, opencodeSessionHeader)
	if native := strings.TrimSpace(raw); native != "" && validOpenCodeSession(native) {
		return native, nil
	}

	clientTool := headerFrom(cred, "x-opencode-client")

	if hinted := strings.TrimSpace(raw); hinted != "" {
		return a.sessions.translate(hinted, clientTool), nil
	}
	if pid := strings.TrimSpace(cred.Extra["providerSessionId"]); pid != "" {
		return a.sessions.translate(pid, clientTool), nil
	}

	return a.sessions.stable_(openCodeIdentityKey(cred)), nil
}

// Forget rejects a session so the next request mints a fresh one.
func (a *OpenCode) Forget(sessionID string) bool { return a.sessions.Forget(sessionID) }

// openCodeIdentityKey derives the per-connection key for the canonical session.
//
// The connection id is preferred over the credential because a credential can be
// rotated onto the same connection, and re-minting on rotation would drop the
// upstream session mid-conversation.
func openCodeIdentityKey(cred Credential) string {
	if id := cred.Extra["connectionId"]; id != "" {
		return "opencode:conn:" + clipForError(id, 128)
	}
	for _, name := range []string{"authorization", "x-api-key"} {
		if v := headerFrom(cred, name); v != "" {
			return "opencode:auth:" + sha256Hex(v)[:32]
		}
	}
	if cred.APIKey != "" {
		return "opencode:auth:" + sha256Hex(cred.APIKey)[:32]
	}
	return "opencode:default"
}

// randomProjectID mints a 40-hex, commit-shaped project id.
//
// The free tier meters quota per project id, so rotating it prevents every request
// from the same install sharing one static quota bucket.
func randomProjectID() string { return randomHex(20) }

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("opencode: crypto/rand unavailable: %v", err))
	}
	return hex.EncodeToString(buf)
}

// ── user agent ───────────────────────────────────────────────────────────────

// openCodeVersionFloor is the last version known to satisfy the gate. Used on a
// cold start and whenever the updater cannot be read.
const openCodeVersionFloor = "2.2.5"

// openCodeUserAgent returns the v2 UA shape `opencode/latest/<version>/<client>`.
//
// The v1 shape `opencode/1.18.x` has been refused with a 403 since 2026-10-14, so
// the version cannot be a literal that ages out. A caller that already reports a
// valid OpenCode version keeps its own string — rewriting it would make a genuine
// client look impersonated.
func openCodeUserAgent(cred Credential) string {
	if downstream := headerFrom(cred, "user-agent"); hasValidOpenCodeVersion(downstream) {
		return downstream
	}
	return "opencode/latest/" + openCodeVersion() + "/cli"
}

// openCodeVersion returns the version to report, honouring OPENCODE_VERSION.
func openCodeVersion() string {
	if v := strings.TrimSpace(os.Getenv("OPENCODE_VERSION")); isReleaseVersion(v) {
		return v
	}
	return openCodeVersionFloor
}

// isReleaseVersion matches a dotted numeric release.
func isReleaseVersion(v string) bool {
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if p == "" || len(p) > 6 {
			return false
		}
		for i := 0; i < len(p); i++ {
			if p[i] < '0' || p[i] > '9' {
				return false
			}
		}
	}
	return true
}

// hasValidOpenCodeVersion reports whether a User-Agent names an acceptable
// OpenCode v2. The v1 form is deliberately rejected.
func hasValidOpenCodeVersion(ua string) bool {
	if ua == "" || !strings.HasPrefix(ua, "opencode/") {
		return false
	}
	fields := strings.Split(ua, "/")
	// opencode/<channel>/<version>/<client>
	if len(fields) != 4 {
		return false
	}
	return isReleaseVersion(fields[2])
}

// RegisterWave6 adds the OpenCode free-lane adapter.
func RegisterWave6(r *Registry) {
	r.Register(NewOpenCode())
}
