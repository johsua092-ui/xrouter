package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/johsua092-ui/xrouter/internal/database"
)

func TestMediaURLJoinsDescriptorBase(t *testing.T) {
	target := &mediaTarget{config: map[string]any{
		"baseUrl": "https://api.elevenlabs.io/v1/text-to-speech/",
	}}
	got := mediaURL(target, "/abc123")
	want := "https://api.elevenlabs.io/v1/text-to-speech/abc123"
	if got != want {
		t.Fatalf("mediaURL = %q, want %q", got, want)
	}
}

func TestMediaURLLeavesFullEndpointAlone(t *testing.T) {
	target := &mediaTarget{config: map[string]any{
		"baseUrl": "https://api.openai.com/v1/audio/speech",
	}}
	if got := mediaURL(target, ""); got != "https://api.openai.com/v1/audio/speech" {
		t.Fatalf("full endpoint was rewritten: %q", got)
	}
}

func TestApplyMediaAuthBearerHeader(t *testing.T) {
	target := &mediaTarget{config: map[string]any{
		"authType":   "apikey",
		"authHeader": "bearer",
	}}
	req := httptest.NewRequest(http.MethodPost, "https://example.test/v1", nil)
	applyMediaAuth(req, target, "sk-test")
	if got := req.Header.Get("Authorization"); got != "Bearer sk-test" {
		t.Fatalf("Authorization = %q", got)
	}
}

func TestApplyMediaAuthNamedHeader(t *testing.T) {
	target := &mediaTarget{config: map[string]any{
		"authType":   "apikey",
		"authHeader": "xi-api-key",
	}}
	req := httptest.NewRequest(http.MethodPost, "https://example.test/v1", nil)
	applyMediaAuth(req, target, "key-123")
	if got := req.Header.Get("xi-api-key"); got != "key-123" {
		t.Fatalf("xi-api-key = %q", got)
	}
}

func TestApplyMediaAuthQueryKey(t *testing.T) {
	target := &mediaTarget{config: map[string]any{
		"authType":   "apikey",
		"authHeader": "key",
	}}
	req := httptest.NewRequest(http.MethodPost, "https://example.test/v1/models/x:generateContent", nil)
	applyMediaAuth(req, target, "g-key")
	if got := req.URL.Query().Get("key"); got != "g-key" {
		t.Fatalf("key query param = %q", got)
	}
	if got := req.Header.Get("Authorization"); got != "" {
		t.Fatalf("query-auth request also carried a header: %q", got)
	}
}

func TestApplyMediaAuthSkipsEmptyKey(t *testing.T) {
	target := &mediaTarget{config: map[string]any{"authType": "apikey", "authHeader": "bearer"}}
	req := httptest.NewRequest(http.MethodPost, "https://example.test/v1", nil)
	applyMediaAuth(req, target, "")
	if got := req.Header.Get("Authorization"); got != "" {
		t.Fatalf("empty key produced header %q", got)
	}
}

func TestCallMediaRelaysUpstreamBodyAndAuth(t *testing.T) {
	var seenAuth, seenPath, seenBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		seenPath = r.URL.Path
		buf := make([]byte, 256)
		n, _ := r.Body.Read(buf)
		seenBody = string(buf[:n])
		w.Header().Set("Content-Type", "audio/mpeg")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ID3fakeaudio"))
	}))
	defer upstream.Close()

	g := newTestGateway()
	target := &mediaTarget{
		config: map[string]any{
			"baseUrl":    upstream.URL + "/v1/text-to-speech",
			"authType":   "apikey",
			"authHeader": "bearer",
		},
		connection: &database.ProviderCredential{APIKey: "sk-live"},
		name:       "openai",
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/audio/speech", strings.NewReader(`{"input":"hi"}`))
	rec := httptest.NewRecorder()
	g.callMedia(rec, req, target, http.MethodPost, mediaURL(target, "/voice1"), []byte(`{"input":"hi"}`), "application/json", nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if seenAuth != "Bearer sk-live" {
		t.Fatalf("upstream saw Authorization %q", seenAuth)
	}
	if seenPath != "/v1/text-to-speech/voice1" {
		t.Fatalf("upstream saw path %q", seenPath)
	}
	if seenBody != `{"input":"hi"}` {
		t.Fatalf("upstream saw body %q", seenBody)
	}
	if got := rec.Header().Get("Content-Type"); got != "audio/mpeg" {
		t.Fatalf("content type was not relayed: %q", got)
	}
	if rec.Body.String() != "ID3fakeaudio" {
		t.Fatalf("binary body was rewritten: %q", rec.Body.String())
	}
}

func TestMediaEndpointsRejectMissingModel(t *testing.T) {
	g := newTestGateway()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/embeddings", nil)
	g.handleEmbeddings(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}
