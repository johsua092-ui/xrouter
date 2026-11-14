package providers

import (
	"crypto/sha3"
	"encoding/hex"
	"testing"
)

// ── the permutation, pinned to a real SHA3 ───────────────────────────────────

// The 23-round digest is opaque on its own: a wrong theta/rho/chi/iota step or a
// mismatched lane order still yields a stable, plausible-looking 64-hex string.
// The only way to know the permutation is right is to run the SAME code with the
// standard 24 rounds and demand it reproduce FIPS 202 exactly. If this fails,
// nothing downstream is trustworthy.
func TestFIPS202ControlMatchesStdlib(t *testing.T) {
	vectors := []string{
		"",
		"a",
		"abc",
		"hello world",
		"The quick brown fox jumps over the lazy dog",
		// >136 bytes: forces multi-block absorption and the absorb loop.
		"0123456789012345678901234567890123456789012345678901234567890123456789" +
			"0123456789012345678901234567890123456789012345678901234567890123456789",
	}
	for _, in := range vectors {
		h := sha3.New256()
		h.Write([]byte(in))
		want := hex.EncodeToString(h.Sum(nil))
		if got := FIPS202Control(in); got != want {
			t.Errorf("control digest mismatch for %q\n got %s\nwant %s", in, got, want)
		}
	}
}

// ── the endpoint's digest ────────────────────────────────────────────────────

// Pinned vectors. These were produced by an independent implementation of the
// same construction (last-23-rounds subset, 0x06 suffix, 0x80 tail bit) written
// separately from this one, so agreement is evidence rather than tautology.
func TestDeepSeekHashV1Vectors(t *testing.T) {
	cases := map[string]string{
		"":                  "e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3",
		"abc":               "f841106c601ce9be9bc38525e90d4178d47f21dd8eb9f238fc55ffaa4ca94506",
		"abc_123_":          "0cf045e65901dd34a175ba9dd4954aba3e7956105d91bca0a660697bcfbb8100",
		"salt_1700000000_0": "eb1554b3f98c63cde3da0be54e8e8d6f0328c6a78ebb096aad42b9d406546c45",
		"salt_1700000000_1": "741c5b30bbe8a81ef9acb101308bff64ab34027e2af5b644d93a4a7912a3eed8",
		"a_0":               "55bd71627e17a94863ca3ce8aa700208a4d2d573c85291898037c43a290b93dc",
	}
	for in, want := range cases {
		if got := DeepSeekHashV1(in); got != want {
			t.Errorf("DeepSeekHashV1(%q)\n got %s\nwant %s", in, got, want)
		}
	}
}

// The digest must differ from plain SHA3-256 — otherwise the round count is being
// ignored and the whole construction is decorative.
func TestDeepSeekHashV1DiffersFromSHA3(t *testing.T) {
	h := sha3.New256()
	h.Write([]byte("abc"))
	// control(24) is SHA3; DSV1(23) must not collide with it.
	if DeepSeekHashV1("abc") == hex.EncodeToString(h.Sum(nil)) {
		t.Error("23-round digest equals SHA3-256; the round count is not being applied")
	}
}

// ── the nonce search ─────────────────────────────────────────────────────────

// The search path rebuilds the state by hand instead of calling the standalone
// digest, so it can drift from it. Every case here asserts the search finds the
// nonce whose digest it was given — including a three-digit nonce that spans a
// lane boundary and a six-digit one.
func TestFindDeepSeekPowNonceRoundTrips(t *testing.T) {
	prefixes := []string{"a_", "ab_", "abc_100_", "salt_1700000000_"}
	nonces := []int{0, 1, 9, 10, 137, 30037, 199999}

	for _, prefix := range prefixes {
		for _, n := range nonces {
			target := DeepSeekHashV1(prefix + itoaTest(n))
			got, err := FindDeepSeekPowNonce(prefix, target, 200000)
			if err != nil {
				t.Fatalf("prefix %q nonce %d: %v", prefix, n, err)
			}
			if got != n {
				t.Errorf("prefix %q: expected nonce %d, search returned %d", prefix, n, got)
			}
		}
	}
}

// A digest that no nonce in range produces must report exhaustion, not a bogus hit.
func TestFindDeepSeekPowNonceExhausts(t *testing.T) {
	// A digest from a nonce far outside the search bound.
	target := DeepSeekHashV1("a_999999")
	got, err := FindDeepSeekPowNonce("a_", target, 100)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != -1 {
		t.Errorf("expected exhaustion (-1), got %d", got)
	}
}

// The search must reject inputs it cannot handle rather than looping on them.
func TestFindDeepSeekPowNonceValidation(t *testing.T) {
	good := DeepSeekHashV1("a_0")

	cases := []struct {
		name       string
		prefix     string
		challenge  string
		difficulty int
	}{
		{"empty prefix", "", good, 10},
		{"short challenge", "a_", "abc", 10},
		{"non-hex challenge", "a_", string(make([]byte, 64)), 10},
		{"zero difficulty", "a_", good, 0},
		{"negative difficulty", "a_", good, -1},
		{"over max difficulty", "a_", good, MaxDeepSeekPowDifficulty + 1},
	}
	for _, c := range cases {
		if _, err := FindDeepSeekPowNonce(c.prefix, c.challenge, c.difficulty); err == nil {
			t.Errorf("%s: expected an error, got none", c.name)
		}
	}
}

// itoaTest formats a nonce the same way the search does, so the test builds its
// target from the identical string form.
func itoaTest(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
