package cache

import (
	"strings"
	"testing"
	"time"
)

func testStore() (*Store, *time.Time) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	s := NewStore()
	s.now = func() time.Time { return now }
	return s, &now
}

func TestPinAndKeep(t *testing.T) {
	s, _ := testStore()

	if got := s.Keep("claude", "conv-1"); got != "" {
		t.Errorf("tanpa pin harus kosong, dapat %q", got)
	}

	s.Pin("claude", "conv-1", "conn-a")
	if got := s.Keep("claude", "conv-1"); got != "conn-a" {
		t.Errorf("Keep=%q, harus conn-a", got)
	}
}

// Affinity is per provider: the same conversation routed to a different provider
// must not inherit the pin, since the warm cache lives with the account.
func TestAffinityIsPerProvider(t *testing.T) {
	s, _ := testStore()
	s.Pin("claude", "conv-1", "conn-a")

	if got := s.Keep("openai", "conv-1"); got != "" {
		t.Errorf("provider lain harus kosong, dapat %q", got)
	}
}

// The TTL must be the provider's, because pinning past the provider's cache
// window costs a cache miss AND a stuck conversation.
func TestProviderTTLIsRespected(t *testing.T) {
	s, now := testStore()

	s.Pin("claude", "fast", "conn-a")   // 5 minutes
	s.Pin("deepseek", "slow", "conn-b") // 60 minutes

	// Advance past Claude's window but well inside DeepSeek's.
	*now = now.Add(10 * time.Minute)

	if got := s.Keep("claude", "fast"); got != "" {
		t.Errorf("ikatan Claude harus kedaluwarsa, dapat %q", got)
	}
	if got := s.Keep("deepseek", "slow"); got != "conn-b" {
		t.Errorf("ikatan DeepSeek harus masih hidup, dapat %q", got)
	}
}

func TestExpiredEntryIsRemovedOnRead(t *testing.T) {
	s, now := testStore()
	s.Pin("claude", "conv-1", "conn-a")

	*now = now.Add(6 * time.Minute)
	if got := s.Keep("claude", "conv-1"); got != "" {
		t.Errorf("harus kosong setelah kedaluwarsa, dapat %q", got)
	}
	if s.Len() != 0 {
		t.Errorf("entri kedaluwarsa harus dihapus saat dibaca, sisa %d", s.Len())
	}
}

// Touch keeps an active conversation warm past its original expiry.
func TestTouchExtendsTTL(t *testing.T) {
	s, now := testStore()
	s.Pin("claude", "conv-1", "conn-a")

	*now = now.Add(4 * time.Minute)
	s.Touch("claude", "conv-1", "conn-a")

	// Past the original expiry, inside the refreshed window.
	*now = now.Add(4 * time.Minute)
	if got := s.Keep("claude", "conv-1"); got != "conn-a" {
		t.Errorf("Touch harus memperpanjang ikatan, dapat %q", got)
	}
}

// Touch on a missing key with a connection id creates the binding: the request
// already succeeded there.
func TestTouchCreatesMissingBinding(t *testing.T) {
	s, _ := testStore()
	s.Touch("claude", "conv-new", "conn-z")

	if got := s.Keep("claude", "conv-new"); got != "conn-z" {
		t.Errorf("Touch harus membuat ikatan, dapat %q", got)
	}
}

// Touch without a connection id on a missing key must not invent one.
func TestTouchWithoutConnectionIsNoop(t *testing.T) {
	s, _ := testStore()
	s.Touch("claude", "conv-new", "")

	if s.Len() != 0 {
		t.Errorf("tak boleh ada entri dibuat, ada %d", s.Len())
	}
}

// Drop is the rate-limit path: the dead connection must not be sticky.
func TestDropClearsAffinity(t *testing.T) {
	s, _ := testStore()
	s.Pin("claude", "conv-1", "conn-dead")
	s.Drop("claude", "conv-1")

	if got := s.Keep("claude", "conv-1"); got != "" {
		t.Errorf("Drop harus menghapus ikatan, dapat %q", got)
	}
}

func TestSweepRemovesExpired(t *testing.T) {
	s, now := testStore()
	s.Pin("claude", "a", "conn-1")
	s.Pin("deepseek", "b", "conn-2")

	*now = now.Add(10 * time.Minute) // Claude expired, DeepSeek alive

	if n := s.Sweep(); n != 1 {
		t.Errorf("Sweep menghapus %d, harus 1", n)
	}
	if s.Len() != 1 {
		t.Errorf("sisa %d entri, harus 1", s.Len())
	}
}

// The store is a RAM cache and must stay bounded even under adversarial keys.
func TestStoreStaysBounded(t *testing.T) {
	s, _ := testStore()
	s.maxEntries = 16

	for i := 0; i < 200; i++ {
		s.Pin("claude", "conv-"+string(rune('a'+i%26))+string(rune('a'+i/26)), "conn")
	}
	if s.Len() > 16 {
		t.Errorf("toko melampaui batas: %d entri", s.Len())
	}
}

func TestTTLForUnknownProviderIsDefault(t *testing.T) {
	if got := TTLFor("provider-yang-belum-dikenal"); got != DefaultCacheTTL {
		t.Errorf("TTL=%v, harus %v", got, DefaultCacheTTL)
	}
	// A known provider must not silently fall through to the default.
	if got := TTLFor("claude"); got != 5*time.Minute {
		t.Errorf("TTL claude=%v, harus 5m", got)
	}
	if got := TTLFor("antigravity"); got != 60*time.Minute {
		t.Errorf("TTL antigravity=%v, harus 60m", got)
	}
}

// ── conversation key derivation ──────────────────────────────────────────────

func TestExplicitHeaderWins(t *testing.T) {
	headers := map[string]string{"x-session-id": "sess-42"}
	got := DeriveConversationKey(KeyInput{
		Header: func(n string) string { return headers[n] },
		Body: map[string]any{
			"session_id": "ignored",
			"messages":   []any{map[string]any{"role": "user", "content": "hello there friend"}},
		},
	})
	if got != "hdr:sess-42" {
		t.Errorf("header harus menang, dapat %q", got)
	}
}

func TestBodySessionIDUsed(t *testing.T) {
	got := DeriveConversationKey(KeyInput{
		Body: map[string]any{"session_id": "body-sess"},
	})
	if got != "body:body-sess" {
		t.Errorf("dapat %q, harus body:body-sess", got)
	}
}

func TestMetadataUserIDUsed(t *testing.T) {
	got := DeriveConversationKey(KeyInput{
		Body: map[string]any{
			"metadata": map[string]any{"user_id": "user-7"},
		},
	})
	if got != "meta:user-7" {
		t.Errorf("dapat %q, harus meta:user-7", got)
	}
}

// The prefix hash is the fallback and must be STABLE across the turns of one
// conversation — that stability is the whole mechanism.
func TestPrefixHashIsStableAcrossTurns(t *testing.T) {
	base := func(extra ...any) map[string]any {
		msgs := []any{
			map[string]any{"role": "system", "content": "You are a careful assistant."},
			map[string]any{"role": "user", "content": "Explain goroutine scheduling"},
		}
		return map[string]any{"messages": append(msgs, extra...)}
	}

	turn1 := DeriveConversationKey(KeyInput{Body: base(), APIKey: "sk-test"})
	// Turn 3 carries the whole history, but the opening is unchanged.
	turn3 := DeriveConversationKey(KeyInput{Body: base(
		map[string]any{"role": "assistant", "content": "Sure."},
		map[string]any{"role": "user", "content": "More detail please"},
	), APIKey: "sk-test"})

	if turn1 == "" {
		t.Fatal("hash prefix harus terbentuk")
	}
	if turn1 != turn3 {
		t.Errorf("kunci harus stabil antar-turn:\n  turn1=%q\n  turn3=%q", turn1, turn3)
	}
}

// Different conversations must not collide, or two users would share an account.
func TestPrefixHashDiffersBetweenConversations(t *testing.T) {
	a := DeriveConversationKey(KeyInput{
		Body:   map[string]any{"messages": []any{map[string]any{"role": "user", "content": "conversation alpha topic"}}},
		APIKey: "sk-test",
	})
	b := DeriveConversationKey(KeyInput{
		Body:   map[string]any{"messages": []any{map[string]any{"role": "user", "content": "conversation beta topic"}}},
		APIKey: "sk-test",
	})
	if a == b {
		t.Errorf("dua percakapan berbeda berbagi kunci: %q", a)
	}
}

// Two callers with an IDENTICAL prompt must not share an account; the caller
// identity is part of the key for exactly this reason.
func TestPrefixHashSeparatesCallers(t *testing.T) {
	body := map[string]any{"messages": []any{map[string]any{"role": "user", "content": "identical prompt text"}}}

	a := DeriveConversationKey(KeyInput{Body: body, APIKey: "sk-caller-a"})
	b := DeriveConversationKey(KeyInput{Body: body, APIKey: "sk-caller-b"})
	if a == b {
		t.Errorf("pemanggil berbeda berbagi kunci: %q", a)
	}

	// Without an API key the client IP is the identity.
	c := DeriveConversationKey(KeyInput{Body: body, ClientIP: "203.0.113.5"})
	d := DeriveConversationKey(KeyInput{Body: body, ClientIP: "203.0.113.6"})
	if c == d {
		t.Errorf("IP berbeda berbagi kunci: %q", c)
	}
}

// The API key must be hashed, never embedded. A conversation key can end up in
// logs or diagnostics, and a raw key there is a leaked credential.
func TestAPIKeyIsHashedNotEmbedded(t *testing.T) {
	key := "sk-super-secret-value"
	got := DeriveConversationKey(KeyInput{
		Body:   map[string]any{"messages": []any{map[string]any{"role": "user", "content": "some prompt here"}}},
		APIKey: key,
	})
	if strings.Contains(got, key) || strings.Contains(got, "super-secret") {
		t.Errorf("kunci API bocor ke kunci percakapan: %q", got)
	}
}

// A too-generic opening is refused rather than shared by every conversation.
func TestGenericAnchorRefused(t *testing.T) {
	got := DeriveConversationKey(KeyInput{
		Body:   map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}},
		APIKey: "sk-test",
	})
	if got != "" {
		t.Errorf("anchor terlalu pendek harus ditolak, dapat %q", got)
	}
}

func TestNoMessagesYieldsNoKey(t *testing.T) {
	if got := DeriveConversationKey(KeyInput{Body: map[string]any{"model": "x"}}); got != "" {
		t.Errorf("tanpa pesan harus kosong, dapat %q", got)
	}
	if got := DeriveConversationKey(KeyInput{}); got != "" {
		t.Errorf("tanpa input harus kosong, dapat %q", got)
	}
}

// Content-block arrays must flatten, since a Claude or Codex body sends parts.
func TestBlockContentIsFlattened(t *testing.T) {
	got := DeriveConversationKey(KeyInput{
		Body: map[string]any{"messages": []any{
			map[string]any{"role": "system", "content": []any{
				map[string]any{"type": "text", "text": "You are a careful assistant."},
			}},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": "Explain goroutine scheduling"},
			}},
		}},
		APIKey: "sk-test",
	})
	if !strings.HasPrefix(got, "prefix:key:") {
		t.Errorf("blok konten harus diratakan jadi kunci prefix, dapat %q", got)
	}
}

// The Responses API sends `input` instead of `messages`.
func TestResponsesAPIInputSupported(t *testing.T) {
	got := DeriveConversationKey(KeyInput{
		Body: map[string]any{"input": []any{
			map[string]any{"role": "user", "content": "a sufficiently long opening prompt"},
		}},
		APIKey: "sk-test",
	})
	if !strings.HasPrefix(got, "prefix:key:") {
		t.Errorf("input Responses API harus didukung, dapat %q", got)
	}
}

// A missing provider or key must never panic or produce a bare colon key.
func TestEmptyInputsAreSafe(t *testing.T) {
	s, _ := testStore()
	if got := s.Keep("", "conv"); got != "" {
		t.Errorf("provider kosong harus kosong, dapat %q", got)
	}
	if got := s.Keep("claude", ""); got != "" {
		t.Errorf("kunci kosong harus kosong, dapat %q", got)
	}
	s.Pin("", "", "") // must not panic
	s.Touch("", "", "")
	s.Drop("", "")
	if s.Len() != 0 {
		t.Errorf("input kosong tak boleh menyimpan entri, ada %d", s.Len())
	}
}

// clip must not split a multi-byte rune, or the hash input is corrupt.
func TestClipRespectsRuneBoundaries(t *testing.T) {
	// Each emoji is 4 bytes.
	s := strings.Repeat("🚀", 200)
	got := clip(s, 501)
	if len(got) > 501 {
		t.Errorf("clip melampaui batas: %d", len(got))
	}
	for _, r := range got {
		if r == '\uFFFD' {
			t.Error("clip memotong rune di tengah")
		}
	}
}
