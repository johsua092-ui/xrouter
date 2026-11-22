// Package auth holds dashboard session primitives: JWT signing/verification and
// password checks.
//
// The token format is deliberately byte-compatible with the Node dashboard
// (HS256, `auth_token` cookie, claims `authenticated` / `jti` / `iat` / `exp` /
// `sv`), sharing the same secret source (JWT_SECRET or <DATA_DIR>/jwt-secret) and
// the same revocation file. A session minted by either runtime validates in the
// other, so cutting over does not log everyone out — and logging out in one place
// kills the token in both.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Session lifetime matches the Node dashboard's hard 24h cap.
const SessionMaxAge = 24 * time.Hour

// DefaultPassword is what a fresh install starts with, mirroring the Node side.
const DefaultPassword = "xrouter123"

var (
	ErrBadToken    = errors.New("auth: invalid token")
	ErrExpired     = errors.New("auth: token expired")
	ErrRevoked     = errors.New("auth: token revoked")
	ErrBadPassword = errors.New("auth: invalid password")
)

// Manager owns the secret, the revocation list and password checks.
type Manager struct {
	dataDir string

	mu       sync.Mutex
	secret   []byte
	revoked  map[string]int64
	revPath  string
	loadedAt time.Time
}

// NewManager wires a manager to DATA_DIR. The secret is loaded lazily so a read
// failure surfaces on first use rather than at startup.
func NewManager(dataDir string) *Manager {
	return &Manager{
		dataDir: dataDir,
		revPath: filepath.Join(dataDir, "revoked-sessions.json"),
		revoked: map[string]int64{},
	}
}

// Secret returns the HMAC key, generating and persisting one on first use.
func (m *Manager) Secret() ([]byte, error) {
	if env := strings.TrimSpace(os.Getenv("JWT_SECRET")); env != "" {
		return []byte(env), nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.secret != nil {
		return m.secret, nil
	}

	path := filepath.Join(m.dataDir, "jwt-secret")
	if raw, err := os.ReadFile(path); err == nil {
		m.secret = []byte(strings.TrimSpace(string(raw)))
		return m.secret, nil
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return nil, fmt.Errorf("auth: generate secret: %w", err)
	}
	encoded := hex.EncodeToString(buf)
	if err := os.MkdirAll(m.dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("auth: create data dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		return nil, fmt.Errorf("auth: persist secret: %w", err)
	}
	m.secret = []byte(encoded)
	return m.secret, nil
}

// Claims is the dashboard session payload.
type Claims map[string]any

// Sign mints an HS256 token with the dashboard's claim set.
func (m *Manager) Sign(claims Claims) (string, error) {
	secret, err := m.Secret()
	if err != nil {
		return "", err
	}

	now := time.Now()
	payload := Claims{"authenticated": true}
	for key, value := range claims {
		payload[key] = value
	}
	if _, ok := payload["jti"]; !ok {
		payload["jti"] = randomID()
	}
	payload["iat"] = now.Unix()
	payload["exp"] = now.Add(SessionMaxAge).Unix()

	header := map[string]string{"alg": "HS256", "typ": "JWT"}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." +
		base64.RawURLEncoding.EncodeToString(payloadJSON)

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signingInput))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return signingInput + "." + signature, nil
}

// Verify checks the signature, the expiry and the revocation list.
func (m *Manager) Verify(token string) (Claims, error) {
	secret, err := m.Secret()
	if err != nil {
		return nil, err
	}

	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return nil, ErrBadToken
	}

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(expected), []byte(parts[2])) != 1 {
		return nil, ErrBadToken
	}

	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrBadToken
	}
	claims := Claims{}
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil, ErrBadToken
	}

	if exp, ok := numericClaim(claims["exp"]); ok && time.Now().Unix() >= exp {
		return nil, ErrExpired
	}
	if m.IsRevoked(asString(claims["jti"])) {
		return nil, ErrRevoked
	}
	return claims, nil
}

// Revoke records a jti until its natural expiry, so logout actually kills the
// token instead of only clearing the cookie.
func (m *Manager) Revoke(claims Claims) error {
	jti := asString(claims["jti"])
	if jti == "" {
		return nil
	}
	exp, ok := numericClaim(claims["exp"])
	if !ok {
		exp = time.Now().Add(SessionMaxAge).Unix()
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.loadRevokedLocked()
	m.revoked[jti] = exp
	return m.saveRevokedLocked()
}

// IsRevoked consults the shared revocation file, pruning entries that have
// already expired.
func (m *Manager) IsRevoked(jti string) bool {
	if jti == "" {
		return false
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.loadRevokedLocked()

	exp, ok := m.revoked[jti]
	if !ok {
		return false
	}
	if exp <= time.Now().Unix() {
		delete(m.revoked, jti)
		_ = m.saveRevokedLocked()
		return false
	}
	return true
}

// loadRevokedLocked re-reads the file; the Node process writes the same file, so
// the in-memory copy cannot be trusted for long.
func (m *Manager) loadRevokedLocked() {
	raw, err := os.ReadFile(m.revPath)
	if err != nil {
		return
	}
	fresh := map[string]int64{}
	if err := json.Unmarshal(raw, &fresh); err != nil {
		return
	}
	m.revoked = fresh
}

func (m *Manager) saveRevokedLocked() error {
	if err := os.MkdirAll(m.dataDir, 0o755); err != nil {
		return err
	}
	now := time.Now().Unix()
	for key, exp := range m.revoked {
		if exp <= now {
			delete(m.revoked, key)
		}
	}
	encoded, err := json.Marshal(m.revoked)
	if err != nil {
		return err
	}
	return os.WriteFile(m.revPath, encoded, 0o600)
}

// CheckPassword verifies a dashboard password against the stored bcrypt hash,
// falling back to INITIAL_PASSWORD (or the default) on an unconfigured install —
// exactly the Node behaviour.
func (m *Manager) CheckPassword(storedHash, password string) error {
	if password == "" {
		return ErrBadPassword
	}
	if storedHash != "" {
		if err := bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(password)); err != nil {
			return ErrBadPassword
		}
		return nil
	}
	initial := os.Getenv("INITIAL_PASSWORD")
	if initial == "" {
		initial = DefaultPassword
	}
	if subtle.ConstantTimeCompare([]byte(initial), []byte(password)) != 1 {
		return ErrBadPassword
	}
	return nil
}

// HashPassword produces a bcrypt hash the Node dashboard can verify.
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func randomID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	// UUID-shaped, matching the Node jti format.
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(buf)
	return hexed[0:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" +
		hexed[16:20] + "-" + hexed[20:32]
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func numericClaim(v any) (int64, bool) {
	switch value := v.(type) {
	case float64:
		return int64(value), true
	case int64:
		return value, true
	case json.Number:
		out, err := value.Int64()
		return out, err == nil
	default:
		return 0, false
	}
}
