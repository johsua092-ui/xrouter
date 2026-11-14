// Package cache is the Go port of the cache-aware conversation affinity store.
//
// Node source: src/sse/services/conversationAffinity.js
//
// Upstream providers keep prompt KV tensors warm per account with a short TTL
// (Claude ~5 min, Gemini/DeepSeek ~60 min). Plain round-robin rotates accounts
// on every request, so the next turn of a conversation lands on a cold account
// and the provider re-prefills the whole prompt — 50k-100k tokens of wasted
// prefill per turn, billed as input.
//
// Affinity fixes that by pinning the later turns of one conversation to the
// account that served the earlier ones, for as long as that provider's cache
// survives. It is an optimisation, never a correctness requirement: any cache
// miss, expiry, or failure simply means the caller falls back to normal
// selection.
package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

// ProviderCacheTTL is how long an upstream keeps a prompt cache warm, per
// provider. Values are the published/observed windows, not guesses: the entry
// must not outlive the provider's cache or affinity pins traffic to an account
// that is no longer warm, which costs a cache miss AND a stuck conversation.
var ProviderCacheTTL = map[string]time.Duration{
	"claude":       5 * time.Minute,
	"claude-web":   5 * time.Minute,
	"codex":        5 * time.Minute,
	"openai":       5 * time.Minute,
	"azure":        5 * time.Minute,
	"kimi":         5 * time.Minute,
	"kimi-web":     5 * time.Minute,
	"qwen":         5 * time.Minute,
	"dashscope":    5 * time.Minute,
	"gemini":       60 * time.Minute,
	"gemini-cli":   60 * time.Minute,
	"antigravity":  60 * time.Minute,
	"vertex":       60 * time.Minute,
	"deepseek":     60 * time.Minute,
	"deepseek-web": 60 * time.Minute,
	"river":        60 * time.Minute,
	"dahl":         60 * time.Minute,
	"zhipu":        60 * time.Minute,
	"glm":          60 * time.Minute,
}

// DefaultCacheTTL applies to providers not listed above. Five minutes is the
// conservative choice: too long pins to a cold account, too short loses the
// benefit. Unknown providers are assumed to behave like the fast-expiry group.
const DefaultCacheTTL = 5 * time.Minute

// MaxAffinityEntries bounds the store. It is a RAM cache, so an unbounded map is
// a slow leak on a busy gateway: every distinct conversation key that arrives is
// one more entry, and bot traffic can mint keys arbitrarily.
const MaxAffinityEntries = 5000

// AnchorSampleLength is how much of the system and first-user message feed the
// conversation hash. Long enough to be specific to a conversation, short enough
// that a long system prompt does not dominate the cost of hashing.
const AnchorSampleLength = 500

// MinAnchorLength is the shortest combined anchor that is trusted as a
// conversation key. Below this the sample is too generic — a thousand
// conversations opening with "hi" would otherwise share one affinity and all pin
// to the same account.
const MinAnchorLength = 5

// entry is one affinity binding.
type entry struct {
	connectionID string
	lastUsedAt   time.Time
	expiresAt    time.Time
	ttl          time.Duration
}

// Store is a cache-aware affinity map.
//
// Concurrency is a plain mutex rather than a sharded map: reads are a single map
// lookup and writes are rare relative to request volume, so the lock is not the
// bottleneck and shard complexity would not pay for itself.
type Store struct {
	mu      sync.Mutex
	entries map[string]entry
	// now is injectable so the TTL behaviour is testable without sleeping.
	now func() time.Time
	// maxEntries is the eviction ceiling; 0 means MaxAffinityEntries.
	maxEntries int
}

// NewStore builds an empty affinity store.
func NewStore() *Store {
	return &Store{
		entries: make(map[string]entry),
		now:     time.Now,
	}
}

// Keep returns the connection pinned to this provider + conversation, or "" when
// there is no live affinity.
func (s *Store) Keep(provider, convKey string) string {
	if provider == "" || convKey == "" {
		return ""
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	key := provider + ":" + convKey
	e, ok := s.entries[key]
	if !ok {
		return ""
	}
	if !s.now().Before(e.expiresAt) {
		// Expired: drop it now rather than leaving it for the sweep, so a stale
		// binding cannot be observed at all.
		delete(s.entries, key)
		return ""
	}
	return e.connectionID
}

// Pin records affinity to a connection, refreshing to the provider's full TTL.
func (s *Store) Pin(provider, convKey, connectionID string) {
	if provider == "" || convKey == "" || connectionID == "" {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	s.evictIfFullLocked()

	ttl := TTLFor(provider)
	now := s.now()
	s.entries[provider+":"+convKey] = entry{
		connectionID: connectionID,
		lastUsedAt:   now,
		expiresAt:    now.Add(ttl),
		ttl:          ttl,
	}
}

// Touch extends a live binding after a successful turn, so an active
// conversation stays warm for as long as it keeps producing turns.
//
// A missing binding with a connection id creates one: the request already
// succeeded on that connection, so the binding is known-good.
func (s *Store) Touch(provider, convKey, connectionID string) {
	if provider == "" || convKey == "" {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	key := provider + ":" + convKey
	e, ok := s.entries[key]
	if !ok {
		if connectionID == "" {
			return
		}
		s.evictIfFullLocked()
		ttl := TTLFor(provider)
		now := s.now()
		s.entries[key] = entry{
			connectionID: connectionID,
			lastUsedAt:   now,
			expiresAt:    now.Add(ttl),
			ttl:          ttl,
		}
		return
	}

	ttl := e.ttl
	if ttl <= 0 {
		ttl = TTLFor(provider)
	}
	now := s.now()
	e.lastUsedAt = now
	e.expiresAt = now.Add(ttl)
	if connectionID != "" {
		e.connectionID = connectionID
	}
	s.entries[key] = e
}

// Drop clears affinity, called when a connection fails or rate-limits so the
// next turn is free to pick a healthy account instead of retrying a dead one.
func (s *Store) Drop(provider, convKey string) {
	if provider == "" || convKey == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, provider+":"+convKey)
}

// Sweep removes every expired binding and reports how many were dropped.
func (s *Store) Sweep() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	dropped := 0
	for k, e := range s.entries {
		if !now.Before(e.expiresAt) {
			delete(s.entries, k)
			dropped++
		}
	}
	return dropped
}

// Len reports the current entry count, bounded by the eviction ceiling.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

// evictIfFullLocked drops the oldest-inserted entry when the store is at
// capacity. Callers must hold the mutex.
//
// Go map iteration is randomised, so "oldest" cannot be found by walking the
// map. Instead this drops an arbitrary entry that has already expired, and only
// when none has expired falls back to dropping one arbitrary entry. That keeps
// the operation O(1) and correct — an eviction can only cost a cache miss.
func (s *Store) evictIfFullLocked() {
	limit := s.maxEntries
	if limit <= 0 {
		limit = MaxAffinityEntries
	}
	if len(s.entries) < limit {
		return
	}

	now := s.now()
	for k, e := range s.entries {
		if !now.Before(e.expiresAt) {
			delete(s.entries, k)
			return
		}
	}
	for k := range s.entries {
		delete(s.entries, k)
		return
	}
}

// TTLFor reports the prompt-cache TTL for a provider.
func TTLFor(provider string) time.Duration {
	if ttl, ok := ProviderCacheTTL[provider]; ok {
		return ttl
	}
	return DefaultCacheTTL
}

// ── conversation key derivation ──────────────────────────────────────────────

// KeyInput is everything deriveConversationKey draws on.
type KeyInput struct {
	// Headers is a lookup for the explicit session headers. Passing the accessor
	// rather than http.Header keeps this package free of a net/http dependency.
	Header func(name string) string
	// Body is the parsed request body.
	Body map[string]any
	// APIKey identifies the caller when no session header exists. Hashed into the
	// key so two callers with identical prompts do not share an account.
	APIKey string
	// ClientIP is the fallback caller identity when no API key is present.
	ClientIP string
}

// Explicit session headers, in priority order. A client that sets any of these is
// telling us exactly what "the same conversation" means and should be believed
// over any inference from message content.
var sessionHeaders = []string{
	"x-session-id",
	"x-conversation-id",
	"x-claude-session-id",
	"session-id",
	"conversation-id",
}

// DeriveConversationKey produces a stable conversation identity, or "" when none
// can be established — in which case the caller simply does not use affinity.
//
// Resolution order: explicit header, explicit body field, then a hash of the
// conversation's opening (system prompt + first user turn). The order is by
// reliability, and stopping at the first hit is what makes the key stable across
// the turns of one conversation while differing between conversations.
func DeriveConversationKey(in KeyInput) string {
	if in.Header != nil {
		for _, h := range sessionHeaders {
			if v := strings.TrimSpace(in.Header(h)); v != "" {
				return "hdr:" + v
			}
		}
	}

	if in.Body != nil {
		for _, field := range []string{"session_id", "conversation_id", "prompt_cache_key"} {
			if v, ok := in.Body[field].(string); ok {
				if v = strings.TrimSpace(v); v != "" {
					return "body:" + v
				}
			}
		}
		if meta, ok := in.Body["metadata"].(map[string]any); ok {
			for _, field := range []string{"user_id", "session_id"} {
				if v, ok := meta[field].(string); ok {
					if v = strings.TrimSpace(v); v != "" {
						return "meta:" + v
					}
				}
			}
		}
	}

	anchor := messageAnchor(in.Body)
	if len(anchor) <= MinAnchorLength {
		return ""
	}

	sum := sha256.Sum256([]byte(anchor))
	hash := hex.EncodeToString(sum[:])[:20]

	caller := "ip:" + in.ClientIP
	if caller == "ip:" {
		caller = "ip:anon"
	}
	if in.APIKey != "" {
		keySum := sha256.Sum256([]byte(in.APIKey))
		caller = "key:" + hex.EncodeToString(keySum[:])[:10]
	}
	return "prefix:" + caller + ":" + hash
}

// messageAnchor builds "{system}\x00{firstUser}" from the opening of the
// conversation.
//
// Only the first user turn is used, deliberately: later turns grow with every
// exchange, so hashing the whole transcript would produce a different key per
// turn and defeat the mechanism entirely.
func messageAnchor(body map[string]any) string {
	if body == nil {
		return ""
	}

	msgs, ok := body["messages"].([]any)
	if !ok {
		if msgs, ok = body["input"].([]any); !ok {
			return ""
		}
	}
	if len(msgs) == 0 {
		return ""
	}

	var system, firstUser string
	for _, raw := range msgs {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role, _ := m["role"].(string)
		text := messageText(m["content"])

		if role == "system" && system == "" && text != "" {
			system = clip(text, AnchorSampleLength)
		} else if role == "user" && firstUser == "" && text != "" {
			firstUser = clip(text, AnchorSampleLength)
		}
		if system != "" && firstUser != "" {
			break
		}
	}
	return system + "\x00" + firstUser
}

// messageText flattens a message content field, which may be a bare string or a
// list of typed parts.
func messageText(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	parts, ok := content.([]any)
	if !ok {
		return ""
	}

	var b strings.Builder
	for i, p := range parts {
		if s, ok := p.(string); ok {
			if i > 0 {
				b.WriteByte(' ')
			}
			b.WriteString(s)
			continue
		}
		pm, ok := p.(map[string]any)
		if !ok {
			continue
		}
		for _, field := range []string{"text", "input_text"} {
			if s, ok := pm[field].(string); ok && s != "" {
				if i > 0 {
					b.WriteByte(' ')
				}
				b.WriteString(s)
				break
			}
		}
	}
	return b.String()
}

// clip truncates to at most n bytes without splitting a UTF-8 rune.
//
// The continuation-byte walk must go FORWARD from the cut, not backward from n:
// a 4-byte rune straddling the boundary leaves a lead byte at n-1 and three
// continuation bytes after it, so trimming trailing continuation bytes alone
// would still leave a dangling lead byte and corrupt the hash input.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && s[cut]&0xC0 == 0x80 {
		cut--
	}
	return s[:cut]
}
