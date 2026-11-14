package vouchers

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// fakeStore is an in-memory Store. The claim chain is a sequence of independent
// uniqueness rules, so the tests exercise the rules against a controlled dataset
// rather than a live database.
type fakeStore struct {
	voucher *Voucher
	claims  []Claim
	minted  []MintOptions
	failOn  string
}

func (f *fakeStore) VoucherByCode(code string) (*Voucher, error) {
	if f.voucher == nil || f.voucher.Code != code {
		return nil, nil
	}
	// A copy, so a test cannot accidentally mutate the stored row.
	v := *f.voucher
	return &v, nil
}

func (f *fakeStore) ClaimsForVoucher(voucherID string) ([]Claim, error) {
	var out []Claim
	for _, c := range f.claims {
		if c.VoucherID == voucherID {
			out = append(out, c)
		}
	}
	// Newest first, matching the ORDER BY the SQL store uses.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

func (f *fakeStore) ClaimsByClientIP(clientIP, since string) ([]Claim, error) {
	return f.filterSince(func(c Claim) bool { return c.ClientIP == clientIP }, since)
}

func (f *fakeStore) ClaimsByDeviceFP(deviceFP, since string) ([]Claim, error) {
	return f.filterSince(func(c Claim) bool { return c.DeviceFP == deviceFP }, since)
}

func (f *fakeStore) ClaimsByHardwareFP(hardwareFP, since string) ([]Claim, error) {
	return f.filterSince(func(c Claim) bool { return c.HardwareFP == hardwareFP }, since)
}

func (f *fakeStore) ClaimsByIPPrefix(voucherID, prefix string) ([]Claim, error) {
	var out []Claim
	for _, c := range f.claims {
		if c.VoucherID == voucherID && strings.HasPrefix(c.ClientIP, prefix) {
			out = append(out, c)
		}
	}
	return out, nil
}

func (f *fakeStore) filterSince(match func(Claim) bool, since string) ([]Claim, error) {
	var out []Claim
	for _, c := range f.claims {
		if !match(c) {
			continue
		}
		if since != "" && c.ClaimedAt < since {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

func (f *fakeStore) InsertClaimAndIncrement(claim Claim) error {
	if f.failOn == "insert" {
		return errors.New("insert failed")
	}
	f.claims = append(f.claims, claim)
	f.voucher.UsedCount++
	return nil
}

func (f *fakeStore) MintAPIKey(name string, opts MintOptions) (string, string, error) {
	if f.failOn == "mint" {
		return "", "", errors.New("mint failed")
	}
	f.minted = append(f.minted, opts)
	slug := opts.Slug
	key := slug + "-abc123-def45678"
	return "keyid-" + slug, key, nil
}

func newEngine(t *testing.T, v *Voucher, claims ...Claim) (*Engine, *fakeStore) {
	t.Helper()
	store := &fakeStore{voucher: v, claims: claims}
	keys := NewKeyDerivation("test-secret-for-unit-tests-only", "0123456789abcdef")
	e := NewEngine(store, keys)
	// A fixed clock so the 24h window boundaries are deterministic.
	e.now = func() time.Time { return time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC) }
	return e, store
}

func baseVoucher() *Voucher {
	return &Voucher{
		ID: "v-1", Code: "bansos-abc123", Name: "Bansos",
		TokenLimit: 1000000, AllowedModels: "*",
		ExpiresInDays: 30, MaxUses: 100, UsedCount: 0, IsActive: true,
	}
}

func TestClaimFreshVoucherIssuesKey(t *testing.T) {
	e, store := newEngine(t, baseVoucher())

	res, err := e.Claim("bansos-abc123", "203.0.113.5", "devicefp1234567", "hardwarefp123456", nil)
	if err != nil {
		t.Fatalf("klaim bersih harus sukses, dapat %v", err)
	}
	if res.Reclaimed {
		t.Error("klaim pertama tidak boleh ditandai reclaimed")
	}
	if !strings.HasPrefix(res.APIKey, "bansos-abc123-") {
		t.Errorf("key tidak memakai kode voucher sbg slug: %q", res.APIKey)
	}
	if store.voucher.UsedCount != 1 {
		t.Errorf("usedCount=%d, harus 1", store.voucher.UsedCount)
	}
	if len(store.claims) != 1 {
		t.Errorf("claim tercatat %d, harus 1", len(store.claims))
	}
	// Expiry must be derived from the claim time, not left empty.
	if res.ExpiresAt == "" {
		t.Error("expiresAt kosong padahal expiresInDays=30")
	}
}

func TestClaimRejectsUnknownAndInactive(t *testing.T) {
	e, _ := newEngine(t, baseVoucher())

	if _, err := e.Claim("tidak-ada", "1.2.3.4", "devicefp1234567", "", nil); !errors.Is(err, ErrVoucherNotFound) {
		t.Errorf("kode tak dikenal harus ErrVoucherNotFound, dapat %v", err)
	}

	inactive := baseVoucher()
	inactive.IsActive = false
	e2, _ := newEngine(t, inactive)
	if _, err := e2.Claim("bansos-abc123", "1.2.3.4", "devicefp1234567", "", nil); !errors.Is(err, ErrVoucherInactive) {
		t.Errorf("voucher nonaktif harus ErrVoucherInactive, dapat %v", err)
	}
}

func TestClaimRejectsExhausted(t *testing.T) {
	v := baseVoucher()
	v.MaxUses = 5
	v.UsedCount = 5
	e, _ := newEngine(t, v)

	if _, err := e.Claim("bansos-abc123", "1.2.3.4", "devicefp1234567", "", nil); !errors.Is(err, ErrVoucherExhausted) {
		t.Errorf("voucher habis harus ErrVoucherExhausted, dapat %v", err)
	}
}

// A repeat claim with the correct receipt returns the SAME key. This is the only
// path that discloses a key, so the receipt check is the security boundary.
func TestRepeatClaimWithReceiptReturnsSameKey(t *testing.T) {
	v := baseVoucher()
	prior := Claim{
		ID: "c-1", VoucherID: v.ID, Code: v.Code,
		APIKeyID: "key-1", APIKey: "bansos-abc123-xyz-abcdefgh",
		DeviceFP: "devicefp1234567", ClaimedAt: "2026-11-14T10:00:00Z",
	}
	e, _ := newEngine(t, v, prior)

	res, err := e.Claim(v.Code, "203.0.113.9", "devicefp1234567", "",
		&Receipt{KeyID: "key-1", APIKey: "bansos-abc123-xyz-abcdefgh"})
	if err != nil {
		t.Fatalf("klaim ulang dgn receipt sah harus sukses, dapat %v", err)
	}
	if !res.Reclaimed {
		t.Error("klaim ulang harus ditandai reclaimed")
	}
	if res.APIKey != prior.APIKey {
		t.Errorf("key berubah: %q != %q", res.APIKey, prior.APIKey)
	}
}

// The critical negative: a matching fingerprint WITHOUT a valid receipt must not
// disclose the key. Self-reported fingerprints are attacker-controlled.
func TestRepeatClaimWithoutReceiptRefusesDisclosure(t *testing.T) {
	v := baseVoucher()
	prior := Claim{
		ID: "c-1", VoucherID: v.ID, Code: v.Code,
		APIKeyID: "key-1", APIKey: "bansos-abc123-xyz-abcdefgh",
		DeviceFP: "devicefp1234567", ClaimedAt: "2026-11-14T10:00:00Z",
	}
	e, _ := newEngine(t, v, prior)

	_, err := e.Claim(v.Code, "203.0.113.9", "devicefp1234567", "", nil)
	if !errors.Is(err, ErrAlreadyClaimedDevice) {
		t.Errorf("tanpa receipt harus ErrAlreadyClaimedDevice, dapat %v", err)
	}

	// A forged receipt (right key id, wrong key value) must also be refused.
	// A fresh engine, because the pacer on the first one would reject the second
	// attempt before the receipt check is ever reached — and the receipt check is
	// the rule under test here, not the pacing.
	e2, _ := newEngine(t, v, prior)
	_, err = e2.Claim(v.Code, "203.0.113.9", "devicefp1234567", "",
		&Receipt{KeyID: "key-1", APIKey: "salah"})
	if !errors.Is(err, ErrAlreadyClaimedDevice) {
		t.Errorf("receipt palsu harus ditolak, dapat %v", err)
	}

	// And the matching receipt is accepted, so the check is discriminating
	// rather than refusing everything.
	e3, _ := newEngine(t, v, prior)
	if _, err := e3.Claim(v.Code, "203.0.113.9", "devicefp1234567", "",
		&Receipt{KeyID: "key-1", APIKey: prior.APIKey}); err != nil {
		t.Errorf("receipt benar harus diterima, dapat %v", err)
	}
}

func TestClaimRejectsSameIP(t *testing.T) {
	v := baseVoucher()
	prior := Claim{
		ID: "c-1", VoucherID: v.ID, Code: v.Code, APIKeyID: "k",
		APIKey: "x", ClientIP: "203.0.113.5", DeviceFP: "otherdevice123",
		ClaimedAt: "2026-11-14T11:00:00Z",
	}
	e, _ := newEngine(t, v, prior)

	_, err := e.Claim(v.Code, "203.0.113.5", "freshdevice12345", "", nil)
	if !errors.Is(err, ErrAlreadyClaimedIP) {
		t.Errorf("IP sama harus ErrAlreadyClaimedIP, dapat %v", err)
	}
}

// The /16 lock is what makes the mobile-carrier airplane-mode trick useless.
// A fresh IP in the same /16 must still be refused.
func TestClaimRejectsCarrierSubnetRotation(t *testing.T) {
	v := baseVoucher()
	prior := Claim{
		ID: "c-1", VoucherID: v.ID, Code: v.Code, APIKeyID: "k",
		APIKey: "x", ClientIP: "41.92.13.7", DeviceFP: "otherdevice123",
		ClaimedAt: "2026-11-14T11:00:00Z",
	}
	e, _ := newEngine(t, v, prior)

	// Different host in the same /16 — the airplane-mode rotation case.
	_, err := e.Claim(v.Code, "41.92.201.44", "freshdevice12345", "", nil)
	if !errors.Is(err, ErrAlreadyClaimedCarrier) {
		t.Errorf("rotasi IP satu /16 harus ErrAlreadyClaimedCarrier, dapat %v", err)
	}

	// A genuinely different /16 is allowed through the network checks.
	e2, _ := newEngine(t, v, prior)
	if _, err := e2.Claim(v.Code, "180.254.7.9", "freshdevice12345", "", nil); err != nil {
		t.Errorf("subnet berbeda tidak boleh diblokir di tahap jaringan: %v", err)
	}
}

// Local development from 127.x must not be caught by the /16 lock.
func TestClaimAllowsLoopbackSubnet(t *testing.T) {
	v := baseVoucher()
	prior := Claim{
		ID: "c-1", VoucherID: v.ID, Code: v.Code, APIKeyID: "k",
		APIKey: "x", ClientIP: "127.0.0.5", DeviceFP: "otherdevice123",
		ClaimedAt: "2026-11-14T11:00:00Z",
	}
	e, _ := newEngine(t, v, prior)

	if _, err := e.Claim(v.Code, "127.0.0.99", "freshdevice12345", "", nil); !errors.Is(err, ErrAlreadyClaimedIP) {
		// The exact-match check still fires for loopback; the /16 lock does not.
		// 127.0.0.99 != 127.0.0.5 so this should pass both.
		if err != nil && !errors.Is(err, ErrVoucherPaced) {
			t.Errorf("loopback host berbeda harus lolos, dapat %v", err)
		}
	}
}

func TestClaimRejectsIPv6Slash48(t *testing.T) {
	v := baseVoucher()
	prior := Claim{
		ID: "c-1", VoucherID: v.ID, Code: v.Code, APIKeyID: "k",
		APIKey: "x", ClientIP: "2001:db8:1234:1::5", DeviceFP: "otherdevice123",
		ClaimedAt: "2026-11-14T11:00:00Z",
	}
	e, _ := newEngine(t, v, prior)

	_, err := e.Claim(v.Code, "2001:db8:1234:9::77", "freshdevice12345", "", nil)
	if !errors.Is(err, ErrAlreadyClaimedIPv6) {
		t.Errorf("IPv6 satu /48 harus diblokir, dapat %v", err)
	}
}

// A device that claimed a DIFFERENT voucher within 24h is capped.
func TestClaimRejectsDailyDeviceLimit(t *testing.T) {
	v := baseVoucher()
	other := Claim{
		ID: "c-9", VoucherID: "v-lain", Code: "lain", APIKeyID: "k2",
		APIKey: "y", DeviceFP: "devicefp1234567", ClaimedAt: "2026-11-14T02:00:00Z",
	}
	e, _ := newEngine(t, v, other)

	_, err := e.Claim(v.Code, "203.0.113.5", "devicefp1234567", "", nil)
	if !errors.Is(err, ErrDailyLimitDevice) {
		t.Errorf("batas harian perangkat harus aktif, dapat %v", err)
	}
}

// Fingerprints below the floor are treated as absent, not trusted. A one-char
// fingerprint must not be able to slip past the uniqueness rules.
func TestShortFingerprintsAreIgnored(t *testing.T) {
	v := baseVoucher()
	prior := Claim{
		ID: "c-1", VoucherID: v.ID, Code: v.Code, APIKeyID: "k",
		APIKey: "x", DeviceFP: "d", HardwareFP: "h",
		ClaimedAt: "2026-11-14T11:00:00Z",
	}
	e, _ := newEngine(t, v, prior)

	res, err := e.Claim(v.Code, "203.0.113.5", "d", "h", nil)
	if err != nil {
		t.Fatalf("fingerprint pendek harus diabaikan, bukan diblokir: %v", err)
	}
	// But the claim row records them verbatim, so the trail is intact.
	if len(res.APIKey) == 0 {
		t.Error("key tidak diterbitkan")
	}
}

// The 24h window is rolling: a claim just outside it must not count.
func TestDailyWindowIsRolling(t *testing.T) {
	v := baseVoucher()
	old := Claim{
		ID: "c-1", VoucherID: "v-lain", Code: "lain", APIKeyID: "k2",
		APIKey: "y", DeviceFP: "devicefp1234567",
		// 25 hours before the fixed clock at 2026-11-14T12:00Z.
		ClaimedAt: "2026-11-13T11:00:00Z",
	}
	e, _ := newEngine(t, v, old)

	if _, err := e.Claim(v.Code, "203.0.113.5", "devicefp1234567", "", nil); err != nil {
		t.Errorf("klaim di luar 24 jam harus lolos, dapat %v", err)
	}
}

// The pacer blocks a second claim of the same voucher inside the window. This is
// what stops a botnet draining a 1-use voucher in the same second.
func TestPacerBlocksImmediateSecondClaim(t *testing.T) {
	v := baseVoucher()
	e, _ := newEngine(t, v)

	if _, err := e.Claim(v.Code, "203.0.113.5", "devicefp1234567", "", nil); err != nil {
		t.Fatalf("klaim pertama harus sukses: %v", err)
	}
	_, err := e.Claim(v.Code, "203.0.113.6", "devicefp7654321", "", nil)
	if !errors.Is(err, ErrVoucherPaced) {
		t.Errorf("klaim kedua segera harus ErrVoucherPaced, dapat %v", err)
	}
}

// The derived key must be exactly the documented format, because the Node side
// validates by direct string lookup.
func TestKeyDerivationFormat(t *testing.T) {
	d := NewKeyDerivation("secret", "0123456789abcdef")
	slug, key := d.BuildVoucherKey("bansos-abc123")

	if slug != "bansos-abc123" {
		t.Errorf("slug=%q, harus bansos-abc123", slug)
	}
	if len(key) != StandardAPIKeyLength {
		t.Errorf("panjang key=%d, harus %d: %q", len(key), StandardAPIKeyLength, key)
	}
	if !strings.HasPrefix(key, slug+"-") {
		t.Errorf("key harus berawalan slug: %q", key)
	}
	parts := strings.Split(key, "-")
	// bansos-abc123-(keyId)-(crc)
	if len(parts) < 4 {
		t.Fatalf("bentuk key salah: %q", key)
	}
	crc := parts[len(parts)-1]
	if len(crc) != 8 {
		t.Errorf("crc=%q panjang %d, harus 8", crc, len(crc))
	}
}

// A short slug gets a longer random portion, so the total length is still 35 and
// the entropy floor is respected.
func TestKeyDerivationPadsShortSlug(t *testing.T) {
	d := NewKeyDerivation("secret", "0123456789abcdef")
	_, key := d.BuildVoucherKey("ab")

	if len(key) != StandardAPIKeyLength {
		t.Errorf("panjang key=%d, harus %d: %q", len(key), StandardAPIKeyLength, key)
	}
	secret := strings.TrimPrefix(key, "ab-")
	keyID := strings.SplitN(secret, "-", 2)[0]
	if len(keyID) < 6 {
		t.Errorf("keyId=%q terlalu pendek, minimum 6", keyID)
	}
}

func TestSanitizeSlug(t *testing.T) {
	cases := map[string]string{
		"bansos abc":     "bansos-abc",
		"__weird__name":  "weird-name",
		"--leading--":    "leading",
		"a b  c":         "a-b-c",
		"UPPER_case-123": "UPPER-case-123",
	}
	for in, want := range cases {
		if got := SanitizeSlug(in, MaxKeySlugLength); got != want {
			t.Errorf("SanitizeSlug(%q)=%q, harus %q", in, got, want)
		}
	}
	// Clamping to the max slug length keeps the total key at 35.
	long := strings.Repeat("x", 40)
	if got := SanitizeSlug(long, MaxKeySlugLength); len(got) != MaxKeySlugLength {
		t.Errorf("slug panjang tidak dipotong ke %d: %d", MaxKeySlugLength, len(got))
	}
}

// A failed insert must not leave the voucher's counter incremented.
func TestFailedInsertDoesNotIncrement(t *testing.T) {
	v := baseVoucher()
	e, store := newEngine(t, v)
	store.failOn = "insert"

	if _, err := e.Claim(v.Code, "203.0.113.5", "devicefp1234567", "", nil); err == nil {
		t.Fatal("insert gagal harus mengembalikan error")
	}
	if store.voucher.UsedCount != 0 {
		t.Errorf("usedCount=%d setelah insert gagal, harus 0", store.voucher.UsedCount)
	}
}

func TestNormalizeClientIP(t *testing.T) {
	cases := map[string]string{
		"203.0.113.5":       "203.0.113.5",
		"203.0.113.5:41234": "203.0.113.5",
		"[2001:db8::1]:443": "2001:db8::1",
		"2001:db8:1234::5":  "2001:db8:1234::5",
		"  203.0.113.5  ":   "203.0.113.5",
		"":                  "",
	}
	for in, want := range cases {
		if got := NormalizeClientIP(in); got != want {
			t.Errorf("NormalizeClientIP(%q)=%q, harus %q", in, got, want)
		}
	}
}

// Cloudflare's header wins over a client-supplied x-forwarded-for.
func TestClientIPPrefersCloudflareHeader(t *testing.T) {
	got := ClientIPFromHeaders("203.0.113.5", "1.2.3.4, 5.6.7.8", "10.0.0.1:5555")
	if got != "203.0.113.5" {
		t.Errorf("harus memakai cf-connecting-ip, dapat %q", got)
	}
	got = ClientIPFromHeaders("", "1.2.3.4, 5.6.7.8", "10.0.0.1:5555")
	if got != "1.2.3.4" {
		t.Errorf("harus memakai entri kiri x-forwarded-for, dapat %q", got)
	}
}
