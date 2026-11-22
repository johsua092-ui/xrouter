package providers

// Internal tests for wave 20/21: signature helpers, JWT assertion, and the body
// envelopes those providers refuse to accept anything else for. Package-internal
// on purpose — the signing and sanitising helpers are not exported, and the point
// is to prove the exact bytes we send, not the public surface.

import (
	"crypto"
	"crypto/hmac"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"
	"time"

	"crypto/rand"
)

func TestIflowSignatureIsHmacOverUAAndSession(t *testing.T) {
	const key = "iflow-secret"
	got := iflowSignature("iFlow-Cli", "session-abc", 1700000000000, key)

	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("iFlow-Cli:session-abc:1700000000000"))
	want := hex.EncodeToString(mac.Sum(nil))
	if got != want {
		t.Fatalf("signature = %s, want %s", got, want)
	}
	if iflowSignature("iFlow-Cli", "session-abc", 1700000000000, "") != "" {
		t.Fatal("no api key must produce no signature, not an HMAC over an empty key")
	}
}

func TestIflowHeadersCarrySignatureAndSession(t *testing.T) {
	adapter := &iflowAdapter{}
	headers, err := adapter.Headers(Request{Stream: true}, Credential{APIKey: "k"})
	if err != nil {
		t.Fatalf("headers: %v", err)
	}
	for _, required := range []string{"session-id", "x-iflow-timestamp", "x-iflow-signature"} {
		if headers[required] == "" {
			t.Fatalf("%s missing from headers: %v", required, headers)
		}
	}
	if !strings.HasPrefix(headers["session-id"], "session-") {
		t.Fatalf("session id shape = %q", headers["session-id"])
	}
	if headers["Authorization"] != "Bearer k" {
		t.Fatalf("authorization = %q", headers["Authorization"])
	}
}

func TestIflowRequestsUsageOnStreamOnly(t *testing.T) {
	adapter := &iflowAdapter{}
	body := []byte(`{"model":"glm-4","messages":[{"role":"user","content":"hi"}]}`)
	streamed, err := adapter.RewriteBody(Request{Stream: true}, Credential{}, body)
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	var parsed map[string]any
	json.Unmarshal(streamed, &parsed)
	if _, ok := parsed["stream_options"]; !ok {
		t.Fatal("streaming request must ask for usage")
	}
	if out, _ := adapter.RewriteBody(Request{Stream: false}, Credential{}, body); out != nil {
		t.Fatal("non-streaming request must be left untouched")
	}
}

func TestXiaomiMimoDualRoute(t *testing.T) {
	adapter := &xiaomiMimoAdapter{}

	cloud, _ := adapter.Endpoint(Request{Model: "mimo-v2-flash"}, Credential{APIKey: "sk"})
	if cloud != "https://api.xiaomimimo.com/v1/chat/completions" {
		t.Fatalf("cloud route = %q", cloud)
	}

	account, _ := adapter.Endpoint(Request{Model: "mimo-v2.6-pro"}, Credential{Cookie: "sess=1"})
	if account != "https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions" {
		t.Fatalf("account route = %q", account)
	}

	regional, _ := adapter.Endpoint(Request{Model: "mimo-v2.6-pro"},
		Credential{Cookie: "sess=1", Extra: map[string]string{"region": "cn"}})
	if regional != "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions" {
		t.Fatalf("regional route = %q", regional)
	}

	headers, _ := adapter.Headers(Request{Model: "mimo-v2.6-pro", Stream: true}, Credential{Cookie: "sess=1"})
	if headers["Cookie"] != "sess=1" {
		t.Fatalf("account route must authenticate by cookie: %v", headers)
	}
	if headers["Authorization"] != "" {
		t.Fatal("account route must not send a bearer token")
	}
}

func TestXiaomiMimoBridgesReasoningEffort(t *testing.T) {
	adapter := &xiaomiMimoAdapter{}
	body := []byte(`{"model":"mimo-v2.6-pro","reasoning_effort":"xhigh","messages":[]}`)
	out, err := adapter.RewriteBody(Request{Model: "mimo-v2.6-pro"},
		Credential{Cookie: "sess=1"}, body)
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	var parsed map[string]any
	json.Unmarshal(out, &parsed)
	if _, still := parsed["reasoning_effort"]; still {
		t.Fatal("reasoning_effort must be replaced by output_config.effort")
	}
	config, _ := parsed["output_config"].(map[string]any)
	if config["effort"] != "high" {
		t.Fatalf("xhigh must normalise to high, got %v", config["effort"])
	}
	if parsed["temperature"] != 1.0 || parsed["top_p"] != 0.95 {
		t.Fatalf("sampling defaults missing: %v / %v", parsed["temperature"], parsed["top_p"])
	}
}

func TestCodebuddyEnvelopeAndMarkerSanitising(t *testing.T) {
	for _, provider := range []string{"codebuddy-cn", "codebuddy-intl"} {
		adapter := &codebuddyAdapter{provider: provider}
		headers, err := adapter.Headers(Request{Stream: true}, Credential{APIKey: "k"})
		if err != nil {
			t.Fatalf("%s headers: %v", provider, err)
		}
		if headers["X-Agent-Intent"] != "craft" || headers["X-Product"] != "SaaS" {
			t.Fatalf("%s is missing the CLI identity headers: %v", provider, headers)
		}
		if headers["X-Request-ID"] == "" || strings.Contains(headers["X-Request-ID"], "-") {
			t.Fatalf("%s request id must be a dashed UUID-free id: %q", provider, headers["X-Request-ID"])
		}

		body := []byte(`{
			"model":"claude-sonnet-4",
			"reasoning_effort":"high",
			"messages":[
				{"role":"system","content":"You are Claude Code, Anthropic's official CLI for Claude."},
				{"role":"user","content":"hello"},
				{"role":"assistant","content":"hi"}
			]
		}`)
		out, err := adapter.RewriteBody(Request{}, Credential{APIKey: "k"}, body)
		if err != nil {
			t.Fatalf("%s rewrite: %v", provider, err)
		}
		var parsed map[string]any
		json.Unmarshal(out, &parsed)
		if parsed["stream"] != true {
			t.Fatalf("%s must force stream", provider)
		}
		if parsed["reasoning_summary"] != "auto" {
			t.Fatalf("%s must request a reasoning summary", provider)
		}
		messages, _ := parsed["messages"].([]any)
		first, _ := messages[0].(map[string]any)
		if first["role"] != "system" {
			t.Fatalf("%s must lead with a system message", provider)
		}
		systemText, _ := first["content"].(string)
		if !strings.Contains(systemText, "CodeBuddy Code") {
			t.Fatalf("%s system prompt must be the CodeBuddy one: %q", provider, systemText)
		}
		if strings.Contains(strings.ToLower(systemText), "claude code") {
			t.Fatalf("%s leaked a competitor identity string: %q", provider, systemText)
		}
		second, _ := messages[1].(map[string]any)
		if _, ok := second["content"].([]any); !ok {
			t.Fatalf("%s must convert user content to typed blocks: %v", provider, second["content"])
		}
	}
}

func TestVertexRawKeyGoesInQuery(t *testing.T) {
	adapter := &vertexAdapter{}
	endpoint, err := adapter.Endpoint(Request{Model: "gemini-2.5-pro", Stream: true},
		Credential{APIKey: "AIza-plain", Extra: map[string]string{"projectId": "proj-1"}})
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	want := "https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=AIza-plain"
	if endpoint != want {
		t.Fatalf("endpoint = %q\nwant %q", endpoint, want)
	}
	headers, err := adapter.Headers(Request{Stream: true}, Credential{APIKey: "AIza-plain"})
	if err != nil {
		t.Fatalf("headers: %v", err)
	}
	if _, hasAuth := headers["Authorization"]; hasAuth {
		t.Fatal("a raw API key must not also send a bearer token")
	}
}

func TestVertexServiceAccountJWTVerifies(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})

	sa := &vertexServiceAccount{
		Type:        "service_account",
		ClientEmail: "svc@proj.iam.gserviceaccount.com",
		PrivateKey:  string(pemBytes),
		TokenURI:    "https://oauth2.googleapis.com/token",
		ProjectID:   "proj-1",
	}
	assertion, err := signServiceAccountJWT(sa)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 {
		t.Fatalf("assertion is not a JWT: %d segments", len(parts))
	}

	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("header decode: %v", err)
	}
	var header map[string]string
	json.Unmarshal(headerJSON, &header)
	if header["alg"] != "RS256" {
		t.Fatalf("alg = %q", header["alg"])
	}

	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("claims decode: %v", err)
	}
	var claims map[string]any
	json.Unmarshal(claimsJSON, &claims)
	if claims["iss"] != sa.ClientEmail {
		t.Fatalf("iss = %v", claims["iss"])
	}
	if claims["aud"] != sa.TokenURI {
		t.Fatalf("aud = %v", claims["aud"])
	}
	if claims["scope"] != "https://www.googleapis.com/auth/cloud-platform" {
		t.Fatalf("scope = %v", claims["scope"])
	}
	exp, _ := claims["exp"].(float64)
	if time.Unix(int64(exp), 0).Before(time.Now()) {
		t.Fatal("assertion is already expired")
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("signature decode: %v", err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&privateKey.PublicKey, crypto.SHA256, digest[:], signature); err != nil {
		t.Fatalf("assertion signature does not verify: %v", err)
	}
}

func TestCommandcodeForcesStreamAndSession(t *testing.T) {
	adapter := &commandcodeAdapter{}
	headers, err := adapter.Headers(Request{}, Credential{APIKey: "user_x"})
	if err != nil {
		t.Fatalf("headers: %v", err)
	}
	if headers["x-session-id"] == "" {
		t.Fatal("commandcode requires a per-request session id")
	}
	out, err := adapter.RewriteBody(Request{}, Credential{APIKey: "user_x"},
		[]byte(`{"model":"cc-1","stream":false}`))
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	var parsed map[string]any
	json.Unmarshal(out, &parsed)
	if parsed["stream"] != true {
		t.Fatal("the generate route has no non-streaming mode")
	}
}

func TestMinimaxQuotaBecomesRateLimit(t *testing.T) {
	adapter := &minimaxCodeAdapter{}

	status, body := adapter.NormalizeError(Request{},
		402, nil, []byte(`{"error":{"message":"insufficient balance 余额不足"}}`))
	if status != 429 {
		t.Fatalf("spent balance must map to 429, got %d", status)
	}
	var parsed map[string]any
	json.Unmarshal(body, &parsed)
	errObj, _ := parsed["error"].(map[string]any)
	if errObj["type"] != "rate_limit_error" {
		t.Fatalf("error type = %v", errObj["type"])
	}

	// A 403 that is a real auth refusal must survive untouched so the refresh
	// path still sees it.
	original := []byte(`{"error":{"message":"invalid api key"}}`)
	status, body = adapter.NormalizeError(Request{}, 403, nil, original)
	if status != 403 || string(body) != string(original) {
		t.Fatalf("auth refusal was rewritten: %d %s", status, body)
	}

	// 429 is already the right signal.
	status, _ = adapter.NormalizeError(Request{}, 429, nil, []byte(`{"message":"slow down"}`))
	if status != 429 {
		t.Fatalf("429 must pass through, got %d", status)
	}
}
