package database

import (
	"strings"
	"testing"
)

// nodeVector is an envelope produced by the Node dashboard's credentialVault with
// VAULT_MASTER_KEY=test-master-key over the plaintext "sk-cross-runtime-vector".
// Hardcoding it keeps the test honest: it pins the byte layout (iv:tag:ciphertext)
// and the key derivation, so a change that breaks cross-runtime compatibility
// fails here instead of in production.
const (
	nodeVector          = "enc:v1:000102030405060708090a0b:096e67be54853ff88f0c1287785ad373:201524e0c8756366f420776ec1a21bfbf4ccb27ef00051"
	nodeVectorPlain     = "sk-cross-runtime-vector"
	nodeVectorMasterKey = "test-master-key"
)

// withMasterKey sets the vault key and clears the memoised derivation, so each
// test starts from a known key instead of inheriting the previous one.
func withMasterKey(t *testing.T, key string) {
	t.Helper()
	t.Setenv("VAULT_MASTER_KEY", key)
	resetVaultCache()
	t.Cleanup(resetVaultCache)
}

func TestUnsealOpensNodeEnvelope(t *testing.T) {
	withMasterKey(t, nodeVectorMasterKey)

	plain, err := Unseal(nodeVector)
	if err != nil {
		t.Fatalf("unseal: %v", err)
	}
	if plain != nodeVectorPlain {
		t.Fatalf("plaintext = %q, want %q", plain, nodeVectorPlain)
	}
}

func TestSealRoundTrip(t *testing.T) {
	withMasterKey(t, "round-trip-key")

	sealed, err := Seal("sk-round-trip")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if !strings.HasPrefix(sealed, "enc:v1:") {
		t.Fatalf("envelope prefix missing: %q", sealed)
	}
	if strings.Count(sealed, ":") != 4 {
		t.Fatalf("expected five colon-separated parts, got %q", sealed)
	}

	plain, err := Unseal(sealed)
	if err != nil {
		t.Fatalf("unseal: %v", err)
	}
	if plain != "sk-round-trip" {
		t.Fatalf("round trip = %q", plain)
	}
}

func TestUnsealPassesThroughPlaintext(t *testing.T) {
	plain, err := Unseal("legacy-plaintext-key")
	if err != nil {
		t.Fatalf("unseal: %v", err)
	}
	if plain != "legacy-plaintext-key" {
		t.Fatalf("plaintext altered: %q", plain)
	}
}

func TestUnsealRejectsWrongKey(t *testing.T) {
	withMasterKey(t, "the-wrong-key")
	if _, err := Unseal(nodeVector); err == nil {
		t.Fatalf("envelope opened with the wrong key")
	}
}

func TestSealIsIdempotent(t *testing.T) {
	withMasterKey(t, "idempotent-key")
	sealed, err := Seal("sk-once")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	again, err := Seal(sealed)
	if err != nil {
		t.Fatalf("seal twice: %v", err)
	}
	if again != sealed {
		t.Fatalf("re-sealing changed the envelope")
	}
}

// TestFlattenConnectionUnseals is the end-to-end path: a connection row written by
// the dashboard (sealed apiKey) must produce a usable credential.
func TestFlattenConnectionUnseals(t *testing.T) {
	withMasterKey(t, nodeVectorMasterKey)

	conn := &ProviderConnection{
		ID:       "conn_1",
		Provider: "openai",
		AuthType: "apikey",
		Data:     []byte(`{"apiKey":"` + nodeVector + `"}`),
	}
	cred, err := flattenConnection(conn)
	if err != nil {
		t.Fatalf("flatten: %v", err)
	}
	if cred.APIKey != nodeVectorPlain {
		t.Fatalf("apiKey = %q, want unsealed plaintext", cred.APIKey)
	}
}
