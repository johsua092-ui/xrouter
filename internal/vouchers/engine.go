// Package vouchers is the Go port of the bansos claim engine.
//
// Node source: src/lib/db/repos/vouchersRepo.js (claimVoucher) plus the claim
// route's IP normalization and the API-key derivation in shared/utils/apiKey.js.
//
// The claim path is a chain of independent uniqueness checks, and the order
// matters: the cheapest rejections run first so a botnet cannot force a database
// write before being refused. Every check is listed here with the reason it
// exists, because a reader who drops one silently reopens an abuse vector.
package vouchers

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ── claim outcomes ────────────────────────────────────────────────────────────

// Claim errors, named after the Node error codes so an operator can grep either
// implementation for the same string.
var (
	ErrVoucherNotFound        = errors.New("VOUCHER_NOT_FOUND")
	ErrVoucherInactive        = errors.New("VOUCHER_INACTIVE")
	ErrVoucherPaced           = errors.New("VOUCHER_PACED")
	ErrVoucherExhausted       = errors.New("VOUCHER_EXHAUSTED")
	ErrAlreadyClaimedDevice   = errors.New("ALREADY_CLAIMED_DEVICE")
	ErrAlreadyClaimedHardware = errors.New("ALREADY_CLAIMED_HARDWARE")
	ErrAlreadyClaimedIP       = errors.New("ALREADY_CLAIMED_IP")
	ErrAlreadyClaimedCarrier  = errors.New("ALREADY_CLAIMED_CARRIER")
	ErrAlreadyClaimedIPv6     = errors.New("ALREADY_CLAIMED_IPV6_CARRIER")
	ErrDailyLimitIP           = errors.New("DAILY_LIMIT_EXCEEDED")
	ErrDailyLimitDevice       = errors.New("DAILY_DEVICE_LIMIT_EXCEEDED")
	ErrDailyLimitHardware     = errors.New("DAILY_HARDWARE_LIMIT_EXCEEDED")
)

// Voucher is one row of the vouchers table.
type Voucher struct {
	ID            string
	Code          string
	Name          string
	Description   string
	TokenLimit    int
	AllowedModels string
	RPMLimit      int
	TPMLimit      int
	ExpiresInDays int
	MaxUses       int
	UsedCount     int
	IsBansos      bool
	IsActive      bool
	CreatedAt     string
	UpdatedAt     string
}

// Claim is one row of voucherClaims — the immutable audit trail.
type Claim struct {
	ID         string
	VoucherID  string
	Code       string
	APIKeyID   string
	APIKey     string
	ClientIP   string
	DeviceFP   string
	HardwareFP string
	ClaimedAt  string
}

// Receipt is the cookie the client holds after a successful claim.
//
// It is the ONLY thing that authorises handing an existing key back. A
// self-reported hardware fingerprint must never be sufficient: an attacker who
// copies a victim's fingerprint string would otherwise be able to read the
// victim's API key from a repeat claim.
type Receipt struct {
	KeyID  string `json:"keyId"`
	APIKey string `json:"apiKey"`
}

// Result is the outcome of a successful claim.
type Result struct {
	VoucherID     string
	VoucherName   string
	Code          string
	APIKeyID      string
	APIKey        string
	TokenLimit    int
	AllowedModels string
	ExpiresAt     string
	// Reclaimed reports that an existing claim was returned rather than a new
	// key minted. The caller must have presented a matching receipt.
	Reclaimed bool
}

// ── storage contract ──────────────────────────────────────────────────────────

// Store is the database surface the engine needs. Declared as an interface so the
// claim chain can be tested against an in-memory fake without a live database —
// the checks are the thing worth testing, not the SQL.
type Store interface {
	VoucherByCode(code string) (*Voucher, error)
	// ClaimsForVoucher returns every claim against one voucher, newest first.
	ClaimsForVoucher(voucherID string) ([]Claim, error)
	// ClaimsByClientIP returns claims from one IP at or after since.
	ClaimsByClientIP(clientIP, since string) ([]Claim, error)
	// ClaimsByDeviceFP and ClaimsByHardwareFP count claims at or after since.
	ClaimsByDeviceFP(deviceFP, since string) ([]Claim, error)
	ClaimsByHardwareFP(hardwareFP, since string) ([]Claim, error)
	// ClaimsByIPPrefix returns claims whose clientIp starts with prefix, used for
	// the carrier /16 and IPv6 /48 subnet locks.
	ClaimsByIPPrefix(voucherID, prefix string) ([]Claim, error)
	// InsertClaimAndIncrement writes the claim and bumps usedCount atomically.
	// A store that does these as two statements can double-issue a voucher when
	// two claims race, so the contract requires one transaction.
	InsertClaimAndIncrement(claim Claim) error
	// MintAPIKey derives and persists the key record for a claim.
	MintAPIKey(name string, opts MintOptions) (keyID, key string, err error)
}

// MintOptions are the key attributes a voucher claim carries.
type MintOptions struct {
	Slug          string
	TokenLimit    int
	AllowedModels string
	RPMLimit      int
	TPMLimit      int
	ExpiresAt     string
	CreatedBy     string
}

// ── key derivation ────────────────────────────────────────────────────────────

// KeyDerivation derives the sk-…-crc8 suffix exactly as the Node implementation
// does, so a key minted here validates against a database written by either
// process. Both read the same API_KEY_SECRET and the same machine-id file.
type KeyDerivation struct {
	// secret backs the CRC HMAC. Never a literal fallback: the repo is public, so
	// a hardcoded value would be a published secret.
	secret []byte
	// machineID is the 16-char hex id folded into the CRC input.
	machineID string
}

// NewKeyDerivation builds a derivation from the resolved secret and machine id.
func NewKeyDerivation(secret, machineID string) *KeyDerivation {
	return &KeyDerivation{secret: []byte(secret), machineID: machineID}
}

// These lengths are the published key format, not tunables. Changing either
// breaks validation of every key already in the database.
const (
	// StandardAPIKeyLength is the total key length: 35 characters.
	StandardAPIKeyLength = 35
	// MaxKeySlugLength is the longest custom slug when a secret is appended:
	// 19, so that slug(19) + "-" + keyId(6) + "-" + crc(8) = 35.
	MaxKeySlugLength = 19
)

// SanitizeSlug lowercases nothing, replaces anything outside [a-zA-Z0-9-] with a
// dash, collapses repeated dashes, trims dashes, and clamps to maxLength.
func SanitizeSlug(raw string, maxLength int) string {
	if maxLength <= 0 {
		maxLength = MaxKeySlugLength
	}
	var b strings.Builder
	lastDash := false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
			b.WriteByte(c)
			lastDash = false
		default:
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")[:min(len(strings.Trim(b.String(), "-")), maxLength)]
}

// GenerateSecretForSlug builds "{keyId}-{crc}" sized so the whole key reaches
// targetTotalLength.
//
// keyIdLen is clamped to a floor of 6 rather than computed freely: a long slug
// would otherwise drive the random portion shorter than the entropy floor the
// Node implementation enforces.
func (d *KeyDerivation) GenerateSecretForSlug(slug string, targetTotalLength int) string {
	if targetTotalLength <= 0 {
		targetTotalLength = StandardAPIKeyLength
	}
	keyIDLen := targetTotalLength - len(slug) - 10
	if keyIDLen < 6 {
		keyIDLen = 6
	}
	keyID := randomFromAlphabet(keyIDLen, "abcdefghijklmnopqrstuvwxyz0123456789")
	return keyID + "-" + d.crc(slug, keyID)
}

// BuildVoucherKey composes the final key: "{slug}-{keyId}-{crc}".
func (d *KeyDerivation) BuildVoucherKey(code string) (slug, fullKey string) {
	slug = SanitizeSlug(code, MaxKeySlugLength)
	if slug == "" {
		return "", ""
	}
	return slug, slug + "-" + d.GenerateSecretForSlug(slug, StandardAPIKeyLength)
}

// crc is the first 8 hex chars of HMAC-SHA256(secret, machineID + keyID). The
// machine id is in the HMAC input so a key minted on one host does not verify on
// another — that is the intended behaviour, not an accident.
func (d *KeyDerivation) crc(machineIDInput, keyID string) string {
	mac := hmac.New(sha256.New, d.secret)
	mac.Write([]byte(d.machineID + keyID))
	return hex.EncodeToString(mac.Sum(nil))[:8]
}

func randomFromAlphabet(n int, alphabet string) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		// A crypto/rand failure is not recoverable and silently returning a
		// predictable key would be worse than failing the claim.
		panic(fmt.Sprintf("vouchers: crypto/rand unavailable: %v", err))
	}
	out := make([]byte, n)
	for i, b := range buf {
		out[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(out)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ── claim pacing ──────────────────────────────────────────────────────────────

// pacer enforces the global per-voucher cooldown.
//
// Without it a botnet drains a voucher in the second between the capacity check
// and the increment. In-process and deliberately not persisted: it is a
// rate-limiter for one gateway instance, and a restart clearing it costs at most
// one extra claim.
type pacer struct {
	mu       sync.Mutex
	lastSeen map[string]time.Time
}

func newPacer() *pacer {
	return &pacer{lastSeen: map[string]time.Time{}}
}

// allow reports whether a claim may proceed now, and how long to wait otherwise.
func (p *pacer) allow(voucherID string, window time.Duration) (bool, int) {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()
	if last, ok := p.lastSeen[voucherID]; ok {
		if elapsed := now.Sub(last); elapsed < window {
			wait := int((window - elapsed + time.Second - 1) / time.Second)
			if wait < 1 {
				wait = 1
			}
			return false, wait
		}
	}
	p.lastSeen[voucherID] = now
	return true, 0
}

// ── the engine ────────────────────────────────────────────────────────────────

// ClaimPacingWindow is the minimum gap between two claims of the same voucher.
//
// Ten seconds is what the Node implementation uses. Shorter and a botnet can
// drain a 1-use voucher before a human sees the page; longer and a legitimate
// burst of users reads as an outage.
const ClaimPacingWindow = 10 * time.Second

// DailyLimitWindow is the rolling window for the per-IP, per-device and
// per-hardware daily caps.
const DailyLimitWindow = 24 * time.Hour

// FingerprintFloor is the shortest device or hardware fingerprint accepted.
//
// Below this the value is treated as absent rather than trusted: a one-character
// fingerprint is trivially spoofed, and honouring it would let an attacker
// sidestep the uniqueness checks by presenting garbage.
const FingerprintFloor = 8

// Engine runs the claim chain.
type Engine struct {
	store Store
	keys  *KeyDerivation
	pace  *pacer
	now   func() time.Time
}

// NewEngine builds an engine over a store and key derivation.
func NewEngine(store Store, keys *KeyDerivation) *Engine {
	return &Engine{
		store: store,
		keys:  keys,
		pace:  newPacer(),
		now:   time.Now,
	}
}

// Claim runs the full uniqueness chain and, on success, mints and records a key.
//
// The order is load-bearing and mirrors the Node implementation:
//
//  1. existence and active status   — cheapest possible rejection
//  2. global pacing                 — stops a botnet before any query
//  3. total capacity                — maxUses is a hard ceiling
//  4. prior claim on this device    — returns the existing key, receipt-gated
//  5. per-IP exact, then carrier /16, then IPv6 /48
//  6. global 24h per-IP cap
//  7. per-device duplicate, then 24h device cap
//  8. per-hardware duplicate, then 24h hardware cap
//  9. mint key, write claim + increment in one transaction
func (e *Engine) Claim(code, clientIP, deviceFP, hardwareFP string, receipt *Receipt) (*Result, error) {
	voucher, err := e.store.VoucherByCode(code)
	if err != nil {
		return nil, err
	}
	if voucher == nil {
		return nil, ErrVoucherNotFound
	}
	if !voucher.IsActive {
		return nil, ErrVoucherInactive
	}

	if ok, _ := e.pace.allow(voucher.ID, ClaimPacingWindow); !ok {
		return nil, ErrVoucherPaced
	}

	if voucher.MaxUses > 0 && voucher.UsedCount >= voucher.MaxUses {
		return nil, ErrVoucherExhausted
	}

	// A repeat claim from a known device returns the original key, but only with
	// the issued receipt. This is the single place a key is ever disclosed.
	if existing, err := e.priorClaim(voucher.ID, deviceFP, hardwareFP); err != nil {
		return nil, err
	} else if existing != nil {
		if receipt == nil || receipt.KeyID != existing.APIKeyID || receipt.APIKey != existing.APIKey {
			return nil, ErrAlreadyClaimedDevice
		}
		return e.reclaimedResult(voucher, existing), nil
	}

	if err := e.checkNetwork(voucher, clientIP); err != nil {
		return nil, err
	}
	if err := e.checkDevice(voucher, deviceFP); err != nil {
		return nil, err
	}
	if err := e.checkHardware(voucher, hardwareFP); err != nil {
		return nil, err
	}

	return e.issue(voucher, clientIP, deviceFP, hardwareFP)
}

// priorClaim finds an earlier claim from the same hardware or device fingerprint.
// Hardware is checked first because it survives a browser change.
func (e *Engine) priorClaim(voucherID, deviceFP, hardwareFP string) (*Claim, error) {
	claims, err := e.store.ClaimsForVoucher(voucherID)
	if err != nil {
		return nil, err
	}
	if hardwareFP != "" && len(hardwareFP) >= FingerprintFloor {
		for i := range claims {
			if claims[i].HardwareFP == hardwareFP {
				return &claims[i], nil
			}
		}
	}
	if deviceFP != "" && len(deviceFP) >= FingerprintFloor {
		for i := range claims {
			if claims[i].DeviceFP == deviceFP {
				return &claims[i], nil
			}
		}
	}
	return nil, nil
}

// reclaimedResult recomputes the expiry from the ORIGINAL claim time. Deriving it
// from now would grant a fresh window on every repeat claim, turning a 30-day
// voucher into an unbounded one.
func (e *Engine) reclaimedResult(voucher *Voucher, prior *Claim) *Result {
	expiresAt := ""
	if voucher.ExpiresInDays > 0 {
		claimed, err := time.Parse(time.RFC3339, prior.ClaimedAt)
		if err == nil {
			expiresAt = claimed.Add(time.Duration(voucher.ExpiresInDays) * 24 * time.Hour).Format(time.RFC3339)
		}
	}
	return &Result{
		VoucherID:     voucher.ID,
		VoucherName:   voucher.Name,
		Code:          voucher.Code,
		APIKeyID:      prior.APIKeyID,
		APIKey:        prior.APIKey,
		TokenLimit:    voucher.TokenLimit,
		AllowedModels: voucher.AllowedModels,
		ExpiresAt:     expiresAt,
		Reclaimed:     true,
	}
}

// checkNetwork applies the three network-scoped locks.
//
// The carrier /16 exists because mobile carriers hand out a fresh IP within the
// same block on every airplane-mode toggle; an exact-match check alone is
// defeated by pressing a button. The /16 is what makes the lock binding, and it
// is deliberately skipped for 127.x so local development is not blocked.
func (e *Engine) checkNetwork(voucher *Voucher, clientIP string) error {
	if clientIP == "" {
		return nil
	}

	claims, err := e.store.ClaimsForVoucher(voucher.ID)
	if err != nil {
		return err
	}
	for i := range claims {
		if claims[i].ClientIP == clientIP {
			return ErrAlreadyClaimedIP
		}
	}

	ip := strings.TrimSpace(strings.Split(clientIP, "/")[0])

	if strings.Contains(ip, ":") {
		// IPv6: lock the /48. A single subscriber typically holds a /48 or wider,
		// so locking the full address would be trivially bypassed by a new suffix.
		parts := strings.Split(ip, ":")
		if len(parts) >= 3 {
			prefix := strings.Join(parts[:3], ":") + ":"
			matches, err := e.store.ClaimsByIPPrefix(voucher.ID, prefix)
			if err != nil {
				return err
			}
			if len(matches) > 0 {
				return ErrAlreadyClaimedIPv6
			}
		}
	} else {
		parts := strings.Split(ip, ".")
		if len(parts) == 4 && parts[0] != "127" {
			prefix := parts[0] + "." + parts[1] + "."
			matches, err := e.store.ClaimsByIPPrefix(voucher.ID, prefix)
			if err != nil {
				return err
			}
			if len(matches) > 0 {
				return ErrAlreadyClaimedCarrier
			}
		}
	}

	since := e.now().Add(-DailyLimitWindow).UTC().Format(time.RFC3339)
	recent, err := e.store.ClaimsByClientIP(clientIP, since)
	if err != nil {
		return err
	}
	if len(recent) >= 1 {
		return ErrDailyLimitIP
	}
	return nil
}

// checkDevice applies the per-device duplicate and daily locks.
func (e *Engine) checkDevice(voucher *Voucher, deviceFP string) error {
	if deviceFP == "" || len(deviceFP) < FingerprintFloor {
		return nil
	}

	claims, err := e.store.ClaimsForVoucher(voucher.ID)
	if err != nil {
		return err
	}
	for i := range claims {
		if claims[i].DeviceFP == deviceFP {
			return ErrAlreadyClaimedDevice
		}
	}

	since := e.now().Add(-DailyLimitWindow).UTC().Format(time.RFC3339)
	recent, err := e.store.ClaimsByDeviceFP(deviceFP, since)
	if err != nil {
		return err
	}
	if len(recent) >= 1 {
		return ErrDailyLimitDevice
	}
	return nil
}

// checkHardware applies the per-hardware duplicate and daily locks, and is the
// strictest of the three scopes: it is what actually binds a claim to one
// physical machine.
func (e *Engine) checkHardware(voucher *Voucher, hardwareFP string) error {
	if hardwareFP == "" || len(hardwareFP) < FingerprintFloor {
		return nil
	}

	claims, err := e.store.ClaimsForVoucher(voucher.ID)
	if err != nil {
		return err
	}
	for i := range claims {
		if claims[i].HardwareFP == hardwareFP {
			return ErrAlreadyClaimedHardware
		}
	}

	since := e.now().Add(-DailyLimitWindow).UTC().Format(time.RFC3339)
	recent, err := e.store.ClaimsByHardwareFP(hardwareFP, since)
	if err != nil {
		return err
	}
	if len(recent) >= 1 {
		return ErrDailyLimitHardware
	}
	return nil
}

// issue mints the key and records the claim.
//
// The claim row and the usedCount increment go through one store call so they
// cannot diverge. Two separate statements leave a window where the voucher is
// issued but its counter is unchanged, which is exactly the race a parallel
// claimant exploits.
func (e *Engine) issue(voucher *Voucher, clientIP, deviceFP, hardwareFP string) (*Result, error) {
	expiresAt := ""
	if voucher.ExpiresInDays > 0 {
		expiresAt = e.now().Add(time.Duration(voucher.ExpiresInDays) * 24 * time.Hour).
			UTC().Format(time.RFC3339)
	}

	slug, fullKey := e.keys.BuildVoucherKey(voucher.Code)
	if slug == "" {
		return nil, errors.New("voucher code yields an empty key slug")
	}

	keyID, key, err := e.store.MintAPIKey("Voucher: "+voucher.Code, MintOptions{
		Slug:          slug,
		TokenLimit:    voucher.TokenLimit,
		AllowedModels: voucher.AllowedModels,
		RPMLimit:      voucher.RPMLimit,
		TPMLimit:      voucher.TPMLimit,
		ExpiresAt:     expiresAt,
		CreatedBy:     "voucher:" + voucher.ID,
	})
	if err != nil {
		return nil, err
	}
	if key == "" {
		key = fullKey
	}

	now := e.now().UTC().Format(time.RFC3339)
	if err := e.store.InsertClaimAndIncrement(Claim{
		ID:         newID(),
		VoucherID:  voucher.ID,
		Code:       voucher.Code,
		APIKeyID:   keyID,
		APIKey:     key,
		ClientIP:   clientIP,
		DeviceFP:   deviceFP,
		HardwareFP: hardwareFP,
		ClaimedAt:  now,
	}); err != nil {
		return nil, err
	}

	return &Result{
		VoucherID:     voucher.ID,
		VoucherName:   voucher.Name,
		Code:          voucher.Code,
		APIKeyID:      keyID,
		APIKey:        key,
		TokenLimit:    voucher.TokenLimit,
		AllowedModels: voucher.AllowedModels,
		ExpiresAt:     expiresAt,
	}, nil
}

// newID is a random hex id, matching the uuid shape the Node side writes.
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("vouchers: crypto/rand unavailable: %v", err))
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// NormalizeClientIP strips an optional port and bracketing from a client address.
//
// The claim route normalizes before every check, because Cloudflare and a direct
// connection present the same client in different forms; an unnormalized value
// makes the exact-match IP lock miss and lets one network claim twice.
func NormalizeClientIP(raw string) string {
	ip := strings.TrimSpace(raw)
	if ip == "" {
		return ""
	}
	// [::1]:41234 -> ::1
	if strings.HasPrefix(ip, "[") {
		if end := strings.Index(ip, "]"); end > 0 {
			return ip[1:end]
		}
	}
	// 1.2.3.4:5678 -> 1.2.3.4. Only when there is exactly one colon, so an IPv6
	// address without brackets is not truncated at its first group.
	if strings.Count(ip, ":") == 1 {
		return ip[:strings.Index(ip, ":")]
	}
	return ip
}

// ClientIPFromHeaders picks the client address from a request's headers.
//
// cf-connecting-ip is preferred because Cloudflare sets it at the edge and a
// client cannot forge it through Cloudflare. x-forwarded-for is a fallback and
// only its left-most entry is trusted.
func ClientIPFromHeaders(cfConnectingIP, xForwardedFor, remoteAddr string) string {
	if cf := NormalizeClientIP(cfConnectingIP); cf != "" {
		return cf
	}
	if xff := NormalizeClientIP(strings.Split(xForwardedFor, ",")[0]); xff != "" {
		return xff
	}
	return NormalizeClientIP(remoteAddr)
}
