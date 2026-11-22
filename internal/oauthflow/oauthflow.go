// Package oauthflow runs the interactive half of the OAuth providers: PKCE
// authorization-code sessions and device-code polling.
//
// The dashboard already knows how to *import* a token that was obtained
// elsewhere. This package covers the case where the operator has no token yet:
// it builds the authorization URL, holds the PKCE verifier and state per
// session, and exchanges the returned code for a token.
//
// Provider endpoints and client ids are not hard-coded guesses. They come from
// the built-in table below (the providers whose public client id is stable) and
// can be overridden per deployment through the `oauth_providers` setting, which
// is where forks put their own credentials.
package oauthflow

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Provider is one OAuth client definition.
type Provider struct {
	ID           string   `json:"id"`
	ClientID     string   `json:"clientId"`
	ClientSecret string   `json:"clientSecret,omitempty"`
	AuthURL      string   `json:"authUrl,omitempty"`
	TokenURL     string   `json:"tokenUrl,omitempty"`
	DeviceURL    string   `json:"deviceUrl,omitempty"`
	Scopes       []string `json:"scopes,omitempty"`
	UsePKCE      bool     `json:"usePkce"`
	Device       bool     `json:"device"`
	ExtraAuth    map[string]string `json:"extraAuth,omitempty"`
	ExtraToken   map[string]string `json:"extraToken,omitempty"`
}

// Session is one in-flight authorization.
type Session struct {
	ID          string
	Provider    string
	State       string
	Verifier    string
	RedirectURI string
	DeviceCode  string
	Interval    int
	ExpiresAt   time.Time
}

// Token is the normalised result of a successful exchange.
type Token struct {
	AccessToken  string         `json:"access_token"`
	RefreshToken string         `json:"refresh_token,omitempty"`
	IDToken      string         `json:"id_token,omitempty"`
	TokenType    string         `json:"token_type,omitempty"`
	Scope        string         `json:"scope,omitempty"`
	ExpiresIn    int            `json:"expires_in,omitempty"`
	Extra        map[string]any `json:"-"`
}

var (
	mu       sync.Mutex
	sessions = map[string]*Session{}
	client   = &http.Client{Timeout: 45 * time.Second}
)

// builtins are the providers with a stable public client id.
func builtins() map[string]Provider {
	return map[string]Provider{
		"github": {
			ID:        "github",
			ClientID:  firstNonEmpty(os.Getenv("GITHUB_OAUTH_CLIENT_ID"), "Iv1.b507a08c87ecfe98"),
			DeviceURL: "https://github.com/login/device/code",
			TokenURL:  "https://github.com/login/oauth/access_token",
			Scopes:    []string{"read:user", "user:email"},
			Device:    true,
		},
		"gitlab": {
			ID:       "gitlab",
			ClientID: firstNonEmpty(os.Getenv("GITLAB_OAUTH_CLIENT_ID"), ""),
			AuthURL:  "https://gitlab.com/oauth/authorize",
			TokenURL: "https://gitlab.com/oauth/token",
			Scopes:   []string{"read_user", "api"},
			UsePKCE:  true,
		},
		"xai": {
			ID:       "xai",
			ClientID: firstNonEmpty(os.Getenv("XAI_OAUTH_CLIENT_ID"), ""),
			AuthURL:  "https://accounts.x.ai/oauth2/authorize",
			TokenURL: "https://accounts.x.ai/oauth2/token",
			Scopes:   []string{"openid", "profile", "email", "offline_access"},
			UsePKCE:  true,
		},
	}
}

// Registry resolves a provider from the built-ins plus the deployment overrides
// (a JSON array of Provider objects stored under the `oauth_providers` setting).
func Registry(overrides []Provider) map[string]Provider {
	out := builtins()
	for _, provider := range overrides {
		if provider.ID == "" {
			continue
		}
		out[provider.ID] = provider
	}
	return out
}

// StartPKCE creates an authorization-code session and returns the URL to open.
func StartPKCE(provider Provider, redirectURI string) (*Session, string, error) {
	if provider.AuthURL == "" || provider.ClientID == "" {
		return nil, "", fmt.Errorf("%s has no OAuth client configured (set clientId/authUrl in oauth_providers)", provider.ID)
	}
	verifier, err := randomToken(48)
	if err != nil {
		return nil, "", err
	}
	state, err := randomToken(18)
	if err != nil {
		return nil, "", err
	}
	session := &Session{
		ID:          "oa" + mustRandom(8),
		Provider:    provider.ID,
		State:       state,
		Verifier:    verifier,
		RedirectURI: redirectURI,
		ExpiresAt:   time.Now().Add(15 * time.Minute),
	}
	mu.Lock()
	sessions[session.ID] = session
	mu.Unlock()

	challenge := sha256.Sum256([]byte(verifier))
	query := url.Values{}
	query.Set("client_id", provider.ClientID)
	query.Set("response_type", "code")
	query.Set("redirect_uri", redirectURI)
	query.Set("state", state)
	if len(provider.Scopes) > 0 {
		query.Set("scope", strings.Join(provider.Scopes, " "))
	}
	if provider.UsePKCE {
		query.Set("code_challenge", base64.RawURLEncoding.EncodeToString(challenge[:]))
		query.Set("code_challenge_method", "S256")
	}
	for key, value := range provider.ExtraAuth {
		query.Set(key, value)
	}
	separator := "?"
	if strings.Contains(provider.AuthURL, "?") {
		separator = "&"
	}
	return session, provider.AuthURL + separator + query.Encode(), nil
}

// Exchange turns an authorization code into a token.
func Exchange(provider Provider, session *Session, code string) (*Token, error) {
	if session == nil {
		return nil, fmt.Errorf("unknown or expired session")
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("client_id", provider.ClientID)
	form.Set("redirect_uri", session.RedirectURI)
	if provider.UsePKCE {
		form.Set("code_verifier", session.Verifier)
	}
	if provider.ClientSecret != "" {
		form.Set("client_secret", provider.ClientSecret)
	}
	for key, value := range provider.ExtraToken {
		form.Set(key, value)
	}
	return postForm(provider.TokenURL, form, "application/x-www-form-urlencoded")
}

// StartDevice begins a device-code flow.
func StartDevice(provider Provider) (*Session, map[string]any, error) {
	if provider.DeviceURL == "" || provider.ClientID == "" {
		return nil, nil, fmt.Errorf("%s does not support the device flow", provider.ID)
	}
	form := url.Values{}
	form.Set("client_id", provider.ClientID)
	if len(provider.Scopes) > 0 {
		form.Set("scope", strings.Join(provider.Scopes, " "))
	}
	payload, err := postForm(provider.DeviceURL, form, "application/x-www-form-urlencoded")
	if err != nil {
		return nil, nil, err
	}
	deviceCode := asString(payload.Extra["device_code"])
	if deviceCode == "" {
		return nil, nil, fmt.Errorf("%s did not return a device_code", provider.ID)
	}
	interval := 5
	if raw, ok := payload.Extra["interval"]; ok {
		if parsed, err := strconv.Atoi(fmt.Sprint(raw)); err == nil && parsed > 0 {
			interval = parsed
		}
	}
	session := &Session{
		ID:         "oa" + mustRandom(8),
		Provider:   provider.ID,
		DeviceCode: deviceCode,
		Interval:   interval,
		ExpiresAt:  time.Now().Add(15 * time.Minute),
	}
	mu.Lock()
	sessions[session.ID] = session
	mu.Unlock()
	return session, payload.Extra, nil
}

// PollDevice asks the token endpoint once, as the device flow requires.
func PollDevice(provider Provider, session *Session) (*Token, string, error) {
	if session == nil || session.DeviceCode == "" {
		return nil, "", fmt.Errorf("unknown or expired device session")
	}
	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
	form.Set("device_code", session.DeviceCode)
	form.Set("client_id", provider.ClientID)
	if provider.ClientSecret != "" {
		form.Set("client_secret", provider.ClientSecret)
	}
	token, err := postForm(provider.TokenURL, form, "application/x-www-form-urlencoded")
	if err != nil {
		return nil, "", err
	}
	if token.AccessToken == "" {
		pending := asString(token.Extra["error"])
		if pending == "" {
			pending = "authorization_pending"
		}
		return nil, pending, nil
	}
	return token, "", nil
}

// Session fetches a live session by id.
func SessionByID(id string) *Session {
	mu.Lock()
	defer mu.Unlock()
	session := sessions[id]
	if session == nil {
		return nil
	}
	if time.Now().After(session.ExpiresAt) {
		delete(sessions, id)
		return nil
	}
	return session
}

// For provider endpoints that answer in form encoding.
func postForm(address string, form url.Values, contentType string) (*Token, error) {
	if address == "" {
		return nil, fmt.Errorf("token endpoint is not configured")
	}
	request, err := http.NewRequest(http.MethodPost, address, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	blob, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var raw map[string]any
	if err := json.Unmarshal(blob, &raw); err != nil {
		// GitHub's classic device endpoint answers form-encoded unless asked
		// for JSON; decode that instead of failing.
		values, parseErr := url.ParseQuery(string(blob))
		if parseErr != nil {
			return nil, fmt.Errorf("token endpoint returned an unreadable body")
		}
		raw = map[string]any{}
		for key := range values {
			raw[key] = values.Get(key)
		}
	}
	token := &Token{
		AccessToken:  asString(raw["access_token"]),
		RefreshToken: asString(raw["refresh_token"]),
		IDToken:      asString(raw["id_token"]),
		TokenType:    asString(raw["token_type"]),
		Scope:        asString(raw["scope"]),
		Extra:        raw,
	}
	if raw["expires_in"] != nil {
		if parsed, err := strconv.Atoi(fmt.Sprint(raw["expires_in"])); err == nil {
			token.ExpiresIn = parsed
		}
	}
	if token.AccessToken == "" && raw["error"] == nil {
		return token, nil
	}
	return token, nil
}

func randomToken(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func mustRandom(size int) string {
	value, err := randomToken(size)
	if err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return value
}

func asString(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
