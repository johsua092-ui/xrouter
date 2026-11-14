package providers

import "crypto/rand"

// randomBytes fills a buffer from crypto/rand.
//
// Wrapped rather than called inline so every caller in this package shares one
// error path: a crypto/rand failure is not recoverable, and silently proceeding
// with a predictable value would be worse than failing the request.
func randomBytes(buf []byte) (int, error) {
	return rand.Read(buf)
}
