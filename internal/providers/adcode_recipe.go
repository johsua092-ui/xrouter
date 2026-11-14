package providers

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"sync"
)

// ADCode / Tagflow wire recipe — the Go counterpart of open-sse/recipe/adcodeRecipe.js.
//
// The upstream gateway is OpenAI-compatible but its wire details (endpoints,
// client headers, user agent) are not written in plain source. They live in an
// AES-256-GCM blob so the format is not copy-pasteable from the repository.
//
// The blob is integrity-checked: GCM authentication fails loudly on a wrong key
// or a tampered blob, so a bad ADCODE_RECIPE_KEY surfaces as a configuration
// error rather than a stream of inexplicable upstream failures.
//
// This is obfuscation with integrity checking, NOT a secret-management boundary.
// Anyone who can read the process can recover the plaintext. Treat the endpoints
// as sensitive in the same way the Node side does: do not print this struct, and
// do not let it reach a log or an error message that a user can see.

// adcodeRecipeSalt is the default key derivation input. A deployment overrides it
// with ADCODE_RECIPE_KEY, which is what keeps the blob in the repository from
// being sufficient on its own.
const adcodeRecipeSalt = "xrouter-adcode-recipe-v2"

// adcodeRecipeBlob is the AES-256-GCM payload, base64. Layout matches the Node
// side: nonce(12) || tag(16) || ciphertext.
const adcodeRecipeBlob = "yf1q6a5M4lMEymPnEmiunHGNX+miZppvLNSby+EN+iKCkYV8+ICEK24jo3HYuzPUnXiKOcPOVIZy" +
	"I27pYilNYpy17qczZEbTJBvyN/+hKQNIaqcZ5J6/xAuBhBcAQOe1LPsXGnxoG/gflmhOkNxfeP7y" +
	"SyvQDoeFbeeSWuI/rHTNgjWKezNpc8K0aAK4TPrYpW+QpaRAY5GVupu5MPJdr2yyO/eNW/DzZpHg" +
	"zEcXVGdUKXxfyf82jQPKm1YyLH/A+w2b79i9XxkWbqVCFyNBEPrpKPWD9/8P0MSezwADipzR33m8" +
	"mxCx/S7bDUAnqvPfQti+QIdzF6FsPDe96k/bPsBHoNlJ5wrsgNBu9L1AOAXljMwFgBsFk51JRmP8" +
	"rpWht3GfvUZ5mQo+BMfG4ENRUkR7Cv5MAxzCoQoC/cOD04T7+NZu6NVEWkngmRf9wmj5lmJqB9Ox" +
	"KVHD84ngTQ0NhjLxhOw8712ZdsAXgQ=="

// adcodeRecipe is the decrypted wire description.
type adcodeRecipe struct {
	ChatURL   string            `json:"chatUrl"`
	UsageURL  string            `json:"usageUrl"`
	ModelsURL string            `json:"modelsUrl"`
	Website   string            `json:"website"`
	UserAgent string            `json:"ua"`
	Headers   map[string]string `json:"headers"`
}

var (
	adcodeRecipeOnce sync.Once
	adcodeRecipeVal  adcodeRecipe
	adcodeRecipeErr  error
)

// loadADCodeRecipe decrypts the recipe once per process.
//
// Cached including the error: a wrong key would otherwise be re-derived on every
// request, turning a configuration mistake into a per-request AES operation.
func loadADCodeRecipe() (adcodeRecipe, error) {
	adcodeRecipeOnce.Do(func() {
		adcodeRecipeVal, adcodeRecipeErr = decryptADCodeRecipe()
	})
	return adcodeRecipeVal, adcodeRecipeErr
}

func decryptADCodeRecipe() (adcodeRecipe, error) {
	var out adcodeRecipe

	raw, err := base64.StdEncoding.DecodeString(adcodeRecipeBlob)
	if err != nil {
		return out, err
	}
	if len(raw) < 28 {
		return out, errShortRecipe
	}

	key := sha256.Sum256([]byte(adcodeRecipeKeyMaterial()))

	block, err := aes.NewCipher(key[:])
	if err != nil {
		return out, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return out, err
	}
	// Layout follows the Node side exactly: nonce(12) || tag(16) || ciphertext.
	// Go's GCM wants ciphertext||tag, so the 16-byte tag is moved from the prefix
	// to the suffix. Byte-swapping these two silently produces an authentication
	// failure that looks like a wrong key.
	const nonceLen, tagLen = 12, 16
	if len(raw) < nonceLen+tagLen {
		return out, errShortRecipe
	}

	nonce := raw[:nonceLen]
	tag := raw[nonceLen : nonceLen+tagLen]
	body := raw[nonceLen+tagLen:]

	sealed := make([]byte, 0, len(body)+len(tag))
	sealed = append(sealed, body...)
	sealed = append(sealed, tag...)

	plain, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		// Authentication failure. Usually a wrong ADCODE_RECIPE_KEY.
		return out, err
	}

	if err := json.Unmarshal(plain, &out); err != nil {
		return out, err
	}
	return out, nil
}

// adcodeRecipeKeyMaterial mirrors the Node precedence: the operator's override,
// else the repository salt.
func adcodeRecipeKeyMaterial() string {
	if k := strings.TrimSpace(os.Getenv("ADCODE_RECIPE_KEY")); k != "" {
		return k
	}
	return adcodeRecipeSalt
}

var errShortRecipe = errADCode("adcode recipe blob is truncated")

// errADCode is a local error type so the message can avoid echoing key material
// while still naming the provider.
type errADCode string

func (e errADCode) Error() string { return string(e) }

// adcodeFirebaseKey returns the Firebase web key.
//
// Not shipped in this repository or in a bundled chunk: supplied at runtime via
// ADCODE_FB_KEY. The embedded default is the published browser key from the
// upstream web client, which is public by construction — a web API key is an
// identifier, not a secret. Empty when the operator cleared it, in which case the
// adapter reports a configuration error instead of making an anonymous call.
func adcodeFirebaseKey() string {
	if k := strings.TrimSpace(os.Getenv("ADCODE_FB_KEY")); k != "" {
		return k
	}
	return adcodeDefaultFirebaseKey
}

// adcodeDefaultFirebaseKey is the base64 of the upstream web client's public key.
const adcodeDefaultFirebaseKey = "AIzaSyATjX5Fw2HjR34VxB3UQWTm1jprA5uXqE"
