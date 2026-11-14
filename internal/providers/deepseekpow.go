package providers

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math/bits"
	"strconv"
	"strings"
)

// DeepSeekHashV1 — proof-of-work for the DeepSeek web chat endpoint.
//
// Port of open-sse/lib/deepseek-pow-hash.js (the clean-room reference), which was
// itself derived from NIST FIPS 202 and confirmed by differential testing against
// the endpoint's black-box vectors.
//
// The digest is SHA3-256's sponge construction with one parameter changed: the
// permutation runs KECCAK-p[1600, 23] — the last 23 rounds (round indices 1..23) —
// rather than the standard 24. Because `crypto/sha3` has no way to select a round
// count, the permutation is implemented here.
//
// The search is the part that matters for cost: a plain implementation hashes
// `prefix + nonce` from scratch for every candidate, which re-absorbs the prefix
// and allocates a digest each time. Absorbing the prefix once and cloning the
// state per candidate removes both costs, which is what makes a difficulty in the
// hundreds of thousands tractable on a small instance.

const (
	deepSeekHashRounds = 23
	keccakRounds       = 24
	sha3RateBytes      = 136
	sha3DomainSuffix   = 0x06
	sha3OutputBytes    = 32
	// MaxDeepSeekPowDifficulty bounds the search. An unbounded difficulty read from
	// an upstream challenge is a hang: the search is O(difficulty) and the value
	// arrives over the network.
	MaxDeepSeekPowDifficulty = 250000
)

// deepSeekRotationOffsets is indexed as x + 5*y, matching FIPS 202 state
// coordinates.
var deepSeekRotationOffsets = [25]uint{0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14}

// deepSeekRoundConstants are the KECCAK-p[1600, 24] iota constants.
var deepSeekRoundConstants = [24]uint64{
	0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000,
	0x000000000000808b, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
	0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
	0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003,
	0x8000000000008002, 0x8000000000000080, 0x000000000000800a, 0x800000008000000a,
	0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
}

// ── Keccak-f[1600] permutation ───────────────────────────────────────────────

// keccakP1600 applies the permutation in place.
//
// The lane layout is little-endian: state[x+5y] holds the FIPS 202 lane at
// coordinates (x, y), and a byte at index i lands in lane i/8 at shift (i%8)*8.
// The absorb path relies on that same convention, so both are stated here rather
// than left implicit.
//
// `rounds` selects the LAST `rounds` iota constants, not the first: calling the
// permutation with 24 is not the same as calling it with 23 once and then once
// more. See FIPS202Control for why the distinction is testable.
func keccakP1600(state *[25]uint64, rounds int) {
	var columnParity [5]uint64
	var thetaMix [5]uint64
	var rhoPiState [25]uint64

	firstRound := keccakRounds - rounds

	for round := firstRound; round < keccakRounds; round++ {
		// Theta
		for x := 0; x < 5; x++ {
			columnParity[x] = state[x] ^ state[x+5] ^ state[x+10] ^ state[x+15] ^ state[x+20]
		}
		for x := 0; x < 5; x++ {
			thetaMix[x] = columnParity[(x+4)%5] ^ bits.RotateLeft64(columnParity[(x+1)%5], 1)
		}
		for y := 0; y < 5; y++ {
			for x := 0; x < 5; x++ {
				state[x+5*y] ^= thetaMix[x]
			}
		}

		// Rho and pi
		for y := 0; y < 5; y++ {
			for x := 0; x < 5; x++ {
				destinationX := y
				destinationY := (2*x + 3*y) % 5
				lane := x + 5*y
				rhoPiState[destinationX+5*destinationY] = bits.RotateLeft64(state[lane], int(deepSeekRotationOffsets[lane]))
			}
		}

		// Chi
		for y := 0; y < 5; y++ {
			row := 5 * y
			for x := 0; x < 5; x++ {
				state[x+row] = rhoPiState[x+row] ^ (^rhoPiState[((x+1)%5)+row] & rhoPiState[((x+2)%5)+row])
			}
		}

		// Iota
		state[0] ^= deepSeekRoundConstants[round]
	}
}

// digestSHA3Style computes a digest through the shared permutation, in the shape
// of SHA3-256: 136-byte absorb rate, 0x06 domain suffix, output read back
// little-endian per lane.
//
// The round count is a parameter rather than a constant, and it is the ROUNDS of
// the permutation, not a number of repetitions. Passing 24 is the standard SHA3
// permutation and must reproduce crypto/sha3 byte for byte; that equality is the
// only thing that makes the 23-round variant trustworthy rather than merely
// self-consistent. Exported for exactly that comparison.
func digestSHA3Style(input string, rounds int) string {
	bytes := []byte(input)
	var state [25]uint64

	offset := 0
	for offset+sha3RateBytes <= len(bytes) {
		absorbDeepSeekBlockWithRounds(&state, bytes[offset:offset+sha3RateBytes], rounds)
		offset += sha3RateBytes
	}

	var finalBlock [sha3RateBytes]byte
	copy(finalBlock[:], bytes[offset:])
	finalBlock[len(bytes)-offset] ^= sha3DomainSuffix
	finalBlock[sha3RateBytes-1] ^= 0x80
	absorbDeepSeekBlockWithRounds(&state, finalBlock[:], rounds)

	out := make([]byte, sha3OutputBytes)
	for i := 0; i < sha3OutputBytes; i++ {
		out[i] = byte(state[i/8] >> ((i % 8) * 8))
	}
	return fmt.Sprintf("%x", out)
}

// absorbDeepSeekBlockWithRounds absorbs a block and permutes it `rounds` times.
func absorbDeepSeekBlockWithRounds(state *[25]uint64, block []byte, rounds int) {
	for i := 0; i < sha3RateBytes; i++ {
		state[i/8] ^= uint64(block[i]) << ((i % 8) * 8)
	}
	keccakP1600(state, rounds)
}

// absorbDeepSeekBlock is the DeepSeekHashV1-rate absorb.
func absorbDeepSeekBlock(state *[25]uint64, block []byte) {
	absorbDeepSeekBlockWithRounds(state, block, deepSeekHashRounds)
}

// DeepSeekHashV1 is the endpoint's digest: SHA3-256 with 23 permutation rounds.
func DeepSeekHashV1(input string) string {
	return digestSHA3Style(input, deepSeekHashRounds)
}

// FIPS202Control is SHA3-256 through this implementation's own permutation.
//
// It exists to be compared against crypto/sha3, and the comparison is the point:
// the 23-round digest is otherwise an opaque constant. A wrong rotation offset or
// a misplaced padding byte would still yield a plausible hex string, and the
// mistake would only surface as an unexplained upstream rejection that looks like
// a credential or quota problem. Matching the standard digest with the same
// permutation, byte order and padding is what makes the 23-round variant
// trustworthy.
//
// The 24 here is a round COUNT, so it selects all 24 iota constants. That is the
// standard permutation; running 23 and then 24 is a different thing entirely.
func FIPS202Control(input string) string {
	return digestSHA3Style(input, keccakRounds)
}

// ── nonce search ─────────────────────────────────────────────────────────────

// FindDeepSeekPowNonce searches for the nonce whose digest equals the challenge.
//
// Returns -1 when the search is exhausted. The comparison is against the full
// digest, not a leading-zero predicate: the challenge IS the target digest, which
// is why the caller's difficulty is a bound on the search space rather than a
// work factor.
//
// The prefix is absorbed once into a base state and cloned per candidate. Doing it
// per candidate would re-absorb the prefix and re-run the first permutation for
// every guess, which is the difference between a few hundred microseconds and a
// few seconds at realistic difficulties.
//
// Everything below works in BYTE offsets within one 136-byte rate block, and the
// lane arithmetic is derived from the byte offset rather than tracked separately.
// That is deliberate: mixing a byte counter with a lane counter is how the offset
// drifts by a few bytes and the search then silently never matches.
func FindDeepSeekPowNonce(prefix, challenge string, difficulty int) (int, error) {
	if err := validateDeepSeekPow(prefix, challenge, difficulty); err != nil {
		return 0, err
	}

	prefixBytes := []byte(prefix)

	var baseState [25]uint64
	prefixOffset := 0
	for prefixOffset+sha3RateBytes <= len(prefixBytes) {
		absorbDeepSeekBlock(&baseState, prefixBytes[prefixOffset:prefixOffset+sha3RateBytes])
		prefixOffset += sha3RateBytes
	}
	// Bytes of the prefix still unabsorbed; the candidate message continues from
	// here, at byte offset prefixTail within the next block.
	prefixTail := prefixBytes[prefixOffset:]

	target, err := parseDigestWords(challenge)
	if err != nil {
		return 0, err
	}

	var state [25]uint64

	for nonce := 0; nonce < difficulty; nonce++ {
		state = baseState

		// Absorb the prefix tail into the fresh block, byte by byte, on the same
		// convention the standalone digest uses.
		position := 0
		for _, b := range prefixTail {
			state[position/8] ^= uint64(b) << ((position % 8) * 8)
			position++
		}

		nonceText := strconv.Itoa(nonce)
		for i := 0; i < len(nonceText); i++ {
			state[position/8] ^= uint64(nonceText[i]) << ((position % 8) * 8)
			position++
			if position == sha3RateBytes {
				keccakP1600(&state, deepSeekHashRounds)
				position = 0
			}
		}

		// Pad and finalise exactly as the standalone digest does at its tail.
		//
		// The 0x80 bit goes in the LAST byte of the rate block: byte 135, which is
		// lane 16 at shift 56. Writing `0x80 << 24` lands it in lane 16's byte 3
		// (offset 131) instead — one nibble's worth of drift that produces a
		// perfectly plausible digest and never matches anything.
		state[position/8] ^= uint64(sha3DomainSuffix) << ((position % 8) * 8)
		state[(sha3RateBytes-1)/8] ^= 0x80 << (((sha3RateBytes - 1) % 8) * 8)
		keccakP1600(&state, deepSeekHashRounds)

		matched := true
		for w := 0; w < len(target); w++ {
			if state[w] != target[w] {
				matched = false
				break
			}
		}
		if matched {
			return nonce, nil
		}
	}
	return -1, nil
}

// validateDeepSeekPow rejects inputs the search cannot handle.
func validateDeepSeekPow(prefix, challenge string, difficulty int) error {
	if prefix == "" {
		return errors.New("deepseek pow: prefix is required")
	}
	if len(challenge) != 64 {
		return fmt.Errorf("deepseek pow: challenge must be a 64-character hex digest, got %d", len(challenge))
	}
	if _, err := parseDigestWords(challenge); err != nil {
		return err
	}
	if difficulty < 1 || difficulty > MaxDeepSeekPowDifficulty {
		return fmt.Errorf("deepseek pow: difficulty must be an integer from 1 to %d, got %d", MaxDeepSeekPowDifficulty, difficulty)
	}
	return nil
}

// parseDigestWords splits a hex digest into little-endian uint64 words.
//
// The width is 64, not 32, and that is load-bearing: the digest is READ back out
// of the state as `byte(state[i/8] >> ((i%8)*8))`, so byte i of the digest lives
// in lane i/8. Comparing against a 32-bit packing of the same bytes would pair
// digest byte 0 with lane 0's LOW half and digest byte 4 with lane 0's HIGH half
// only if the packing is also 64-bit — with a 32-bit packing, byte 4 lands in
// word 1 and every comparison past the first four bytes is off. The two
// conventions have to match, so this mirrors the output reader exactly.
func parseDigestWords(challenge string) ([]uint64, error) {
	lower := strings.ToLower(challenge)
	words := make([]uint64, sha3OutputBytes/8)
	for i := 0; i < sha3OutputBytes; i++ {
		hi := hexNibble(lower[i*2])
		lo := hexNibble(lower[i*2+1])
		if hi < 0 || lo < 0 {
			return nil, errors.New("deepseek pow: challenge contains a non-hex character")
		}
		words[i/8] |= uint64(hi*16+lo) << ((i % 8) * 8)
	}
	return words, nil
}

// hexNibble returns the value of a hex digit, or -1.
func hexNibble(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	}
	return -1
}

// ── challenge answer ─────────────────────────────────────────────────────────

// DeepSeekPowChallenge is the challenge the endpoint issues.
type DeepSeekPowChallenge struct {
	Algorithm  string
	Challenge  string
	Salt       string
	Difficulty int
	ExpireAt   int64
	Signature  string
	TargetPath string
}

// SolveDeepSeekPowChallenge solves the challenge and returns the base64 answer the
// endpoint expects.
//
// The prefix is `salt_expireAt_` and the challenge is lowercased before the
// search, both as the endpoint's own client does. The answer is a base64-encoded
// JSON object carrying the original fields back — the endpoint re-validates the
// signature and target path, so they must be echoed unchanged.
func SolveDeepSeekPowChallenge(ch DeepSeekPowChallenge) (string, error) {
	if ch.Algorithm != "DeepSeekHashV1" {
		return "", fmt.Errorf("deepseek pow: unsupported algorithm %q", ch.Algorithm)
	}

	prefix := fmt.Sprintf("%s_%d_", ch.Salt, ch.ExpireAt)
	nonce, err := FindDeepSeekPowNonce(prefix, strings.ToLower(ch.Challenge), ch.Difficulty)
	if err != nil {
		return "", err
	}
	if nonce < 0 {
		return "", errors.New("deepseek pow: solver failed")
	}

	payload := map[string]any{
		"algorithm":   ch.Algorithm,
		"challenge":   ch.Challenge,
		"salt":        ch.Salt,
		"answer":      nonce,
		"signature":   ch.Signature,
		"target_path": ch.TargetPath,
	}
	return base64Std(encodeJSON(payload)), nil
}

// encodeJSON marshals deterministically enough for this payload (fixed key set,
// scalar values) and is kept separate so a caller can test the wire bytes.
func encodeJSON(v any) []byte {
	// A hand-rolled encoder is used rather than encoding/json because the payload
	// key order must be stable for a signature-checking upstream in the general
	// case, and because every value here is a string or an int.
	m, ok := v.(map[string]any)
	if !ok {
		return []byte("{}")
	}
	// Fixed order, matching the endpoint's client.
	keys := []string{"algorithm", "challenge", "salt", "answer", "signature", "target_path"}
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.Quote(k))
		b.WriteByte(':')
		switch val := m[k].(type) {
		case string:
			b.WriteString(strconv.Quote(val))
		case int:
			b.WriteString(strconv.Itoa(val))
		default:
			b.WriteString(strconv.Quote(fmt.Sprint(val)))
		}
	}
	b.WriteByte('}')
	return []byte(b.String())
}

// ── small stdlib shims ───────────────────────────────────────────────────────

// base64Std encodes with the standard alphabet, matching the endpoint's client.
func base64Std(data []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var b strings.Builder
	for i := 0; i < len(data); i += 3 {
		var chunk [3]byte
		n := copy(chunk[:], data[i:])
		b.WriteByte(alphabet[chunk[0]>>2])
		b.WriteByte(alphabet[(chunk[0]&0x03)<<4|chunk[1]>>4])
		if n > 1 {
			b.WriteByte(alphabet[(chunk[1]&0x0f)<<2|chunk[2]>>6])
		} else {
			b.WriteByte('=')
		}
		if n > 2 {
			b.WriteByte(alphabet[chunk[2]&0x3f])
		} else {
			b.WriteByte('=')
		}
	}
	return b.String()
}

// binaryWriteUint32BE is kept for callers that frame a length field.
func binaryWriteUint32BE(dst []byte, v uint32) {
	binary.BigEndian.PutUint32(dst, v)
}

// decodeBase64Std is the inverse of base64Std.
func decodeBase64Std(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }
