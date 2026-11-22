package oauthflow

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// The token endpoint is a local stub: these tests check the protocol we speak,
// not any provider's live behaviour.
func TestPKCEAuthorizeAndExchange(t *testing.T) {
	var seenVerifier string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		seenVerifier = r.PostFormValue("code_verifier")
		if r.PostFormValue("code") != "auth-code" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
			return
		}
		if r.PostFormValue("client_secret") != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid_client"}`))
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"tok-123","refresh_token":"ref-456","expires_in":3600,"scope":"api"}`))
	}))
	defer server.Close()

	provider := Provider{
		ID: "test", ClientID: "client-1", ClientSecret: "secret",
		AuthURL: "https://example.test/authorize", TokenURL: server.URL,
		Scopes: []string{"api", "read_user"}, UsePKCE: true,
	}

	session, authorizeURL, err := StartPKCE(provider, "http://localhost:20128/api/oauth/test/callback")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	parsed, err := url.Parse(authorizeURL)
	if err != nil {
		t.Fatalf("authorize url: %v", err)
	}
	query := parsed.Query()
	if query.Get("code_challenge_method") != "S256" {
		t.Fatalf("missing PKCE challenge method: %s", authorizeURL)
	}
	if query.Get("scope") != "api read_user" {
		t.Fatalf("scope = %q", query.Get("scope"))
	}
	if query.Get("state") != session.State || session.State == "" {
		t.Fatalf("state not carried: %q vs %q", query.Get("state"), session.State)
	}
	if SessionByID(session.ID) == nil {
		t.Fatalf("session not registered")
	}

	token, err := Exchange(provider, session, "auth-code")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if token.AccessToken != "tok-123" || token.RefreshToken != "ref-456" || token.ExpiresIn != 3600 {
		t.Fatalf("token = %+v", token)
	}
	if seenVerifier == "" || seenVerifier != session.Verifier {
		t.Fatalf("verifier not sent correctly")
	}
}

func TestExchangeReportsProviderError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"code expired"}`))
	}))
	defer server.Close()

	provider := Provider{ID: "test", ClientID: "c", TokenURL: server.URL, UsePKCE: true}
	session, _, err := StartPKCE(Provider{ID: "test", ClientID: "c", AuthURL: "https://x/authorize", TokenURL: server.URL, UsePKCE: true}, "http://localhost/cb")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	token, err := Exchange(provider, session, "stale")
	if err != nil {
		t.Fatalf("exchange should surface the body, not an error: %v", err)
	}
	if token.AccessToken != "" {
		t.Fatalf("unexpected token: %+v", token)
	}
	if asString(token.Extra["error_description"]) != "code expired" {
		t.Fatalf("provider error not preserved: %v", token.Extra)
	}
}

func TestDeviceFlowPendingThenToken(t *testing.T) {
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if strings.HasSuffix(r.URL.Path, "/device") {
			_, _ = w.Write([]byte(`{"device_code":"dev-1","user_code":"ABCD-1234","verification_uri":"https://example.test/device","interval":1,"expires_in":900}`))
			return
		}
		polls++
		if polls < 2 {
			_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"dev-token","token_type":"bearer"}`))
	}))
	defer server.Close()

	provider := Provider{
		ID: "device-test", ClientID: "cid",
		DeviceURL: server.URL + "/device", TokenURL: server.URL + "/token",
		Scopes: []string{"read:user"}, Device: true,
	}

	session, payload, err := StartDevice(provider)
	if err != nil {
		t.Fatalf("start device: %v", err)
	}
	if payload["user_code"] != "ABCD-1234" || session.Interval != 1 {
		t.Fatalf("device payload = %v interval=%d", payload, session.Interval)
	}

	token, pending, err := PollDevice(provider, session)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if token != nil || pending != "authorization_pending" {
		t.Fatalf("first poll should be pending, got token=%v pending=%q", token, pending)
	}

	token, pending, err = PollDevice(provider, session)
	if err != nil {
		t.Fatalf("poll 2: %v", err)
	}
	if token == nil || token.AccessToken != "dev-token" || pending != "" {
		t.Fatalf("second poll = %+v pending=%q", token, pending)
	}
}

func TestRegistryOverridesBuiltins(t *testing.T) {
	registry := Registry([]Provider{{ID: "gitlab", ClientID: "deployment-client", AuthURL: "https://gl.test/authorize"}})
	if registry["gitlab"].ClientID != "deployment-client" {
		t.Fatalf("override ignored: %+v", registry["gitlab"])
	}
	if registry["github"].DeviceURL == "" {
		t.Fatalf("builtin github lost")
	}

	session, _, err := StartPKCE(Provider{ID: "noclient"}, "http://x/cb")
	if err == nil || session != nil {
		t.Fatalf("expected a clear error for a provider with no client id")
	}
}

func TestSessionExpiry(t *testing.T) {
	unique := Provider{ID: "exp", ClientID: "c", AuthURL: "https://x/a", TokenURL: "https://x/t", UsePKCE: true}
	session, _, err := StartPKCE(unique, "http://x/cb")
	if err != nil {
		t.Fatal(err)
	}
	session.ExpiresAt = session.ExpiresAt.Add(-1 * 60 * 60 * 1e9)
	if SessionByID(session.ID) != nil {
		t.Fatalf("expired session still resolvable")
	}
}

func TestTokenJSONShape(t *testing.T) {
	blob, err := json.Marshal(Token{AccessToken: "a", RefreshToken: "r", ExpiresIn: 10})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(blob), `"access_token":"a"`) {
		t.Fatalf("token json = %s", blob)
	}
}
