package database

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
)

// Credential vault. Sealed values are AES-256-GCM envelopes in the Node format:
//
//	enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
//
// The key is sha256(machineId + salt) — the same derivation the dashboard uses —
// so a database written by the Node service is readable here and a value sealed
// here is readable there. Without this, every connection the dashboard stored is
// unusable by the Go core, which is most of a real install.
const (
	vaultPrefix = "enc:v1:"
	vaultSalt   = "xrouter-credential-vault-salt-2026"
)

// ErrSealedCredential reports an envelope that could not be opened, usually
// because the database was moved to a different machine.
var ErrSealedCredential = errors.New("credential is sealed and cannot be unsealed on this host")

var (
	vaultMu   sync.Mutex
	vaultKey  []byte
	vaultErr  error
	vaultOnce bool
)

// deriveVaultKey resolves the AES key. A caller-supplied master key wins (the
// dashboard's setVaultMasterKey path), otherwise the machine id plus salt is used.
func deriveVaultKey() ([]byte, error) {
	vaultMu.Lock()
	defer vaultMu.Unlock()
	if vaultOnce {
		return vaultKey, vaultErr
	}
	vaultOnce = true

	if master := strings.TrimSpace(os.Getenv("VAULT_MASTER_KEY")); master != "" {
		sum := sha256.Sum256([]byte(master))
		vaultKey = sum[:]
		return vaultKey, nil
	}

	machineID, err := readMachineID()
	if err != nil {
		// Matches the Node fallback: salt alone still derives a usable key.
		sum := sha256.Sum256([]byte(vaultSalt))
		vaultKey = sum[:]
		return vaultKey, nil
	}
	sum := sha256.Sum256([]byte(machineID + vaultSalt))
	vaultKey = sum[:]
	return vaultKey, nil
}

// resetVaultCache clears the memoised key. Tests need it because the key is
// derived once per process; production never calls it.
func resetVaultCache() {
	vaultMu.Lock()
	defer vaultMu.Unlock()
	vaultKey = nil
	vaultErr = nil
	vaultOnce = false
}

// readMachineID mirrors node-machine-id on Linux.
func readMachineID() (string, error) {
	for _, path := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if id := strings.TrimSpace(string(raw)); id != "" {
			return id, nil
		}
	}
	return "", errors.New("no machine id available")
}

// Unseal opens a sealed credential. Plaintext values pass through unchanged, which
// is what legacy rows look like.
func Unseal(stored string) (string, error) {
	if !IsEncrypted(stored) {
		return stored, nil
	}
	parts := strings.Split(stored, ":")
	if len(parts) != 5 {
		return "", fmt.Errorf("%w: malformed envelope", ErrSealedCredential)
	}
	iv, err := hex.DecodeString(parts[2])
	if err != nil {
		return "", fmt.Errorf("%w: bad iv", ErrSealedCredential)
	}
	tag, err := hex.DecodeString(parts[3])
	if err != nil {
		return "", fmt.Errorf("%w: bad tag", ErrSealedCredential)
	}
	ciphertext, err := hex.DecodeString(parts[4])
	if err != nil {
		return "", fmt.Errorf("%w: bad ciphertext", ErrSealedCredential)
	}

	key, err := deriveVaultKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	// Node stores the tag separately; Go's GCM expects ciphertext||tag.
	sealed := make([]byte, 0, len(ciphertext)+len(tag))
	sealed = append(sealed, ciphertext...)
	sealed = append(sealed, tag...)

	plain, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrSealedCredential, err)
	}
	return string(plain), nil
}

// Seal encrypts a credential for storage, matching the Node envelope byte layout.
func Seal(plaintext string) (string, error) {
	if plaintext == "" || IsEncrypted(plaintext) {
		return plaintext, nil
	}
	key, err := deriveVaultKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)

	// Split Go's ciphertext||tag back into the Node layout.
	tagStart := len(sealed) - gcm.Overhead()
	return vaultPrefix +
		hex.EncodeToString(iv) + ":" +
		hex.EncodeToString(sealed[tagStart:]) + ":" +
		hex.EncodeToString(sealed[:tagStart]), nil
}

// MustUnseal is the read-path helper: it returns the plaintext when it can, and the
// original value otherwise so a single unreadable row never breaks a listing.
func MustUnseal(stored string) string {
	plain, err := Unseal(stored)
	if err != nil {
		return stored
	}
	return plain
}
