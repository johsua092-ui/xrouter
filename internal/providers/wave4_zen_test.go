package providers

import (
	"strings"
	"testing"
	"time"
)

// ── opencode-zen session shape ───────────────────────────────────────────────
//
// Regression guard for a bug found by reading the adapter against the upstream
// contract: OpenCodeZen derived its session as `"ses_" + sha256(scope|...)[:30]`
// — 34 characters, all hex after the prefix. Upstream decodes the 12 characters
// after `ses_` as a DESCENDING millisecond timestamp and requires the remainder
// be base62, so a digest was refused twice over: wrong length AND wrong
// composition, and the digest prefix almost never lands inside the freshness
// window. Every zen request therefore failed the session gate.
//
// These tests assert the produced value against the upstream SHAPE, not merely
// that a value was produced — a test that only checked "non-empty" would have
// passed on the broken code and caught nothing.

// TestOpenCodeZenSessionMatchesUpstreamShape is the core regression guard.
func TestOpenCodeZenSessionMatchesUpstreamShape(t *testing.T) {
	a := &OpenCodeZen{}
	got := a.Session(Request{Model: "muse-spark-1.3-contributor-free"}, cred(map[string]string{"apiKey": "k"}))

	if !strings.HasPrefix(got, opencodeSessionPrefix) {
		t.Fatalf("session %q does not start with %q", got, opencodeSessionPrefix)
	}
	want := len(opencodeSessionPrefix) + opencodeSessionHexLen + opencodeSessionAlnumLen
	if len(got) != want {
		t.Fatalf("session %q has len %d, want %d (ses_ + %d hex + %d base62)",
			got, len(got), want, opencodeSessionHexLen, opencodeSessionAlnumLen)
	}
	if !validOpenCodeSession(got) {
		t.Fatalf("session %q fails validOpenCodeSession — upstream would refuse it", got)
	}
}

// TestOpenCodeZenSessionSurvivesShapeGateOnRealHeaderPath drives the value
// through Headers, which is where the broken derivation used to live. The bug
// was reachable only via the header path, so the guard has to exercise it.
func TestOpenCodeZenSessionSurvivesShapeGateOnRealHeaderPath(t *testing.T) {
	a := &OpenCodeZen{}
	h, err := a.Headers(
		Request{Model: "muse-spark-1.3-contributor-free", Stream: true},
		cred(map[string]string{"apiKey": "k"}),
	)
	if err != nil {
		t.Fatalf("Headers: %v", err)
	}

	canonical := h[opencodeSessionHeader]
	if !validOpenCodeSession(canonical) {
		t.Fatalf("x-opencode-session %q fails the shape gate", canonical)
	}
	// All four aliases must agree, or upstream reads whichever it finds first
	// and lands on a different session depending on header order.
	for _, name := range []string{"x-opencode-session-id", "x-session-affinity", "x-session-id"} {
		if h[name] != canonical {
			t.Errorf("%s=%q disagrees with x-opencode-session=%q", name, h[name], canonical)
		}
	}
}

// TestOpenCodeZenSessionPrefixMatchesNodeArithmetic pins the encoder against the
// Node/CLI expression it must reproduce: `~(timeMs * 0x1000 + counter) & 0xFFFFFFFFFFFF`
// evaluated on a BigInt.
//
// This is not a "does it look like a timestamp" test — the CLI's own field does
// not survive that reading (x = ms*4096 exceeds 48 bits, so the CLI's fixture
// prefix decodes to 1970 too). What matters for interoperability is that Go
// mints the SAME value the CLI would for the same clock, because both talk to
// one upstream. The Go port originally wrote `^x & mask` on a uint64, which is
// full-width two's complement and therefore a different value than the BigInt
// form for every real timestamp.
func TestOpenCodeZenSessionPrefixMatchesNodeArithmetic(t *testing.T) {
	cases := []struct {
		ms      int64
		counter uint64
		want    string
	}{
		// Reference values computed with the Node expression on a BigInt.
		{0, 0, "ffffffffffff"},
		{1, 0, "ffffffffefff"},
		{2897347863, 0, "f534dfae8fff"}, // matches the Node fixture's prefix family
		{1_700_000_000_000, 0, "4301a97fffff"},
		{1_795_000_000_000, 0, "e11a9a1fffff"},
		{1_795_000_000_000, 1, "e11a9a1ffffe"},
		{1_795_000_000_000, 0x0F, "e11a9a1ffff0"},
	}

	for _, c := range cases {
		got := descendingTimeHex(time.UnixMilli(c.ms), c.counter)
		if got != c.want {
			t.Errorf("descendingTimeHex(%d, %d) = %q, want %q (Node/CLI value)",
				c.ms, c.counter, got, c.want)
		}
		if len(got) != 12 {
			t.Errorf("descendingTimeHex(%d, %d) = %q, len %d, want 12", c.ms, c.counter, got, len(got))
		}
	}
}

// TestOpenCodeZenSessionIsStablePerConversation guards the second half of the
// bug: a session is per-conversation state, not a request nonce. Recomputing it
// per call would drop the upstream session mid-conversation on every turn.
func TestOpenCodeZenSessionIsStablePerConversation(t *testing.T) {
	a := &OpenCodeZen{}
	c := cred(map[string]string{"apiKey": "same-key"})
	req := Request{Model: "muse-spark-1.3-contributor-free"}

	first := a.Session(req, c)
	second := a.Session(req, c)
	if first != second {
		t.Fatalf("session changed between calls in one conversation: %q then %q", first, second)
	}
}

// TestOpenCodeZenHonoursNativeSession checks the precedence rule: a caller that
// already presents a well-formed session keeps it, so a native client's own
// conversation is never reassigned.
func TestOpenCodeZenHonoursNativeSession(t *testing.T) {
	native := "ses_" + strings.Repeat("0", opencodeSessionHexLen) + strings.Repeat("a", opencodeSessionAlnumLen)
	if len(native) != len(opencodeSessionPrefix)+opencodeSessionHexLen+opencodeSessionAlnumLen {
		t.Fatalf("test fixture %q is not the right length", native)
	}

	a := &OpenCodeZen{}
	got := a.Session(Request{Model: "muse-spark-1.3-contributor-free"}, cred(map[string]string{
		"apiKey":                 "k",
		"raw:x-opencode-session": native,
	}))
	if got != native {
		t.Fatalf("native session was overwritten: got %q, want %q", got, native)
	}
}

// TestOpenCodeZenDistinctConnectionsGetDistinctSessions guards against a
// single shared session across unrelated callers, which would make one caller's
// quota exhaustion fail every other caller.
func TestOpenCodeZenDistinctConnectionsGetDistinctSessions(t *testing.T) {
	a := &OpenCodeZen{}
	req := Request{Model: "muse-spark-1.3-contributor-free"}

	one := a.Session(req, cred(map[string]string{"apiKey": "key-one"}))
	two := a.Session(req, cred(map[string]string{"apiKey": "key-two"}))
	if one == two {
		t.Fatalf("two connections share session %q", one)
	}
}
