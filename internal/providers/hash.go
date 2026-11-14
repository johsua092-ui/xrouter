package providers

import (
	"crypto/sha256"
	"encoding/hex"
)

// sha256Hex is the lowercase hex SHA-256 digest, used where the Node engine hashes
// a value into an opaque identifier before it reaches upstream. Kept local to this
// package because every caller wants exactly this shape and an encoding/hex pairing
// repeated per call site is where a casing bug hides.
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
