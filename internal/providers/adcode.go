package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// AdCode / Tagflow — bring-your-own-account.
//
// No API key exists for this provider. The user supplies their own identity
// (log in to the ADCode desktop app, copy the Firebase refreshToken), and this
// adapter mints a short-lived idToken from it. It never creates accounts and
// never registers anything.
//
// The one recoverable failure is an expired idToken, and it is handled by
// refreshing once and replaying — retrying without a new token would just repeat
// the same 401.
//
// This is the port of open-sse/executors/adcode.js. That executor overrides
// execute() rather than only buildUrl/buildHeaders, so it cannot be expressed as
// a URL/header-only adapter: the token lifecycle is part of the request.

// adcodeUnsupportedParams are sampling knobs the upstream gateway refuses with a
// generic 400 ("Send a supported chat request"). Dropped instead of forwarded.
//
// The list is not "parameters we dislike": each of these was observed to produce
// that 400, and the upstream never reads them, so forwarding one only ever costs
// a failed request.
var adcodeUnsupportedParams = []string{
	"temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty",
	"repetition_penalty", "min_p", "seed", "logit_bias", "logprobs", "top_logprobs",
	"response_format", "parallel_tool_calls", "n", "stop",
}

// AdCode is the adapter.
type AdCode struct {
	// tokenCachePath is where the minted idToken is persisted between requests.
	// Derived from DATA_DIR so it follows the same data root as the rest of the
	// gateway rather than guessing a home directory.
	tokenCachePath string

	mu    sync.Mutex
	cache adcodeTokenCache
	// loaded guards the one-time read of the cache file.
	loaded bool

	// httpClient is the shared transport. Set by the registry so connection
	// pooling is process-wide.
	httpClient *http.Client
}

// adcodeTokenCache is the on-disk shape. Matches the Node cache so a token minted
// by either implementation is reused by the other.
type adcodeTokenCache struct {
	IDToken      string `json:"idToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresAt    int64  `json:"expiresAt"`
}

func (a *AdCode) Name() string { return "adcode" }

func (a *AdCode) WireFormat() string { return FormatOpenAI }

// adcodeIdentity is what the user actually supplied, normalised into one of the
// two accepted forms.
type adcodeIdentity struct {
	IDToken      string
	RefreshToken string
}

// parseAdCodeIdentity accepts a refresh token, a raw idToken, or a cookie string,
// from any of the credential slots.
//
// The cookie form is what the dashboard's "paste from devtools" flow produces, so
// it must be handled: rejecting it would make the documented setup path fail.
func parseAdCodeIdentity(cred Credential) (adcodeIdentity, error) {
	if cookie := cred.Cookie; cookie != "" {
		if v := cookieValue(cookie, "refreshToken"); v != "" {
			return adcodeIdentity{RefreshToken: v}, nil
		}
		if v := cookieValue(cookie, "idToken"); v != "" {
			return adcodeIdentity{IDToken: v}, nil
		}
	}

	raw := strings.TrimSpace(cred.APIKey)
	if raw == "" {
		raw = strings.TrimSpace(cred.AccessToken)
	}
	if raw == "" {
		return adcodeIdentity{}, errors.New(
			"adcode needs your own account: set the API key to your Firebase refresh token " +
				"(log in to the ADCode desktop app, then copy refreshToken from localStorage)")
	}

	// A Firebase idToken is a JWT, so it is recognisable by its compact-JSON prefix.
	// Anything else is treated as a refresh token.
	if strings.HasPrefix(raw, "eyJ") {
		return adcodeIdentity{IDToken: raw}, nil
	}
	return adcodeIdentity{RefreshToken: raw}, nil
}

// cookieValue extracts one value from a Cookie-style header string.
func cookieValue(cookie, name string) string {
	for _, part := range strings.Split(cookie, ";") {
		part = strings.TrimSpace(part)
		prefix := name + "="
		if !strings.HasPrefix(part, prefix) {
			continue
		}
		v := strings.TrimPrefix(part, prefix)
		// Percent-decoded because the value came out of a URL-encoded storage
		// dump, which is how the dashboard reports it.
		if dec, err := url.QueryUnescape(v); err == nil {
			return dec
		}
		return v
	}
	return ""
}

// Endpoint is the recipe's chat URL.
func (a *AdCode) Endpoint(req Request, cred Credential) (string, error) {
	recipe, err := loadADCodeRecipe()
	if err != nil {
		return "", fmt.Errorf("adcode: %w", err)
	}
	return recipe.ChatURL, nil
}

// Headers builds the upstream header set, minting an idToken if there is no live
// one cached.
//
// The recipe's client headers and user agent go on the wire here, and the whole
// recipe is never echoed into an error: it describes a private gateway.
func (a *AdCode) Headers(req Request, cred Credential) (map[string]string, error) {
	recipe, err := loadADCodeRecipe()
	if err != nil {
		return nil, fmt.Errorf("adcode: %w", err)
	}

	token, err := a.resolveIDToken(cred)
	if err != nil {
		return nil, err
	}

	h := baseJSONHeaders()
	h["accept"] = "text/event-stream, application/json"
	h["authorization"] = "Bearer " + token
	h["user-agent"] = recipe.UserAgent
	// Recipe headers land last so a provider-defined value (e.g. the platform
	// identifier) is not clobbered by the defaults above.
	for k, v := range recipe.Headers {
		h[k] = v
	}
	return h, nil
}

// resolveIDToken returns a usable idToken, refreshing only when the cached one is
// expired.
//
// Expiry is checked with a 60-second margin: a token that expires while the
// request is in flight is indistinguishable from a bad token, and the retry path
// is expensive enough to avoid when a proactive refresh is cheaper.
func (a *AdCode) resolveIDToken(cred Credential) (string, error) {
	ident, err := parseAdCodeIdentity(cred)
	if err != nil {
		return "", err
	}
	if ident.IDToken != "" {
		return ident.IDToken, nil
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	a.loadCacheLocked()

	if a.cache.RefreshToken == ident.RefreshToken &&
		a.cache.IDToken != "" &&
		time.Now().UnixMilli() < a.cache.ExpiresAt {
		return a.cache.IDToken, nil
	}

	next, err := a.refreshIDToken(ident.RefreshToken)
	if err != nil {
		return "", err
	}
	next.RefreshToken = ident.RefreshToken
	a.cache = next
	a.writeCacheLocked()
	return next.IDToken, nil
}

// RefreshOn401 reports whether an upstream 401 for this response body is worth
// replaying with a freshly minted token. Only an expiry or bad-token complaint
// qualifies; any other 401 is a real authorization failure and retrying it just
// burns a second request.
func (a *AdCode) RefreshOn401(cred Credential, body string) bool {
	if !strings.Contains(strings.ToLower(body), "token") {
		return false
	}
	ident, err := parseAdCodeIdentity(cred)
	if err != nil {
		return false
	}
	return ident.RefreshToken != ""
}

// RefreshAndReplay mints a new token and returns the headers for the retry.
func (a *AdCode) RefreshAndReplay(cred Credential) (map[string]string, error) {
	ident, err := parseAdCodeIdentity(cred)
	if err != nil {
		return nil, err
	}
	if ident.RefreshToken == "" {
		return nil, errors.New("adcode: nothing to refresh (the connection holds an idToken, not a refresh token)")
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	next, err := a.refreshIDToken(ident.RefreshToken)
	if err != nil {
		return nil, err
	}
	next.RefreshToken = ident.RefreshToken
	a.cache = next
	a.writeCacheLocked()

	// Rebuild from scratch so the retry uses the recipe headers too.
	recipe, err := loadADCodeRecipe()
	if err != nil {
		return nil, fmt.Errorf("adcode: %w", err)
	}
	h := baseJSONHeaders()
	h["accept"] = "text/event-stream, application/json"
	h["authorization"] = "Bearer " + next.IDToken
	h["user-agent"] = recipe.UserAgent
	for k, v := range recipe.Headers {
		h[k] = v
	}
	return h, nil
}

// refreshIDToken exchanges a refresh token for a fresh idToken.
func (a *AdCode) refreshIDToken(refreshToken string) (adcodeTokenCache, error) {
	var out adcodeTokenCache

	key := adcodeFirebaseKey()
	if key == "" {
		return out, errors.New("adcode: no Firebase web key (set ADCODE_FB_KEY)")
	}

	endpoint := "https://securetoken.googleapis.com/v1/token?key=" + url.QueryEscape(key)
	form := "grant_type=refresh_token&refresh_token=" + url.QueryEscape(refreshToken)

	client := a.httpClient
	if client == nil {
		client = http.DefaultClient
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form))
	if err != nil {
		return out, err
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")

	res, err := client.Do(req)
	if err != nil {
		return out, err
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	if err != nil {
		return out, err
	}

	var payload struct {
		IDToken      string `json:"id_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    string `json:"expires_in"`
	}
	_ = json.Unmarshal(body, &payload)

	if res.StatusCode != http.StatusOK || payload.IDToken == "" {
		// The body is truncated hard: it can echo back parts of the request, and
		// this message may surface in the dashboard.
		return out, fmt.Errorf("adcode token refresh failed (%d): %s", res.StatusCode, clipForError(string(body), 160))
	}

	secs := 3600
	if payload.ExpiresIn != "" {
		if n, convErr := parseInt(payload.ExpiresIn); convErr == nil && n > 0 {
			secs = n
		}
	}

	return adcodeTokenCache{
		IDToken:      payload.IDToken,
		RefreshToken: payload.RefreshToken,
		// 60s early, so a token does not expire mid-request.
		ExpiresAt: time.Now().UnixMilli() + int64(secs)*1000 - 60_000,
	}, nil
}

// SanitizeBody drops the parameters the upstream refuses. Exported because the
// gateway applies it before handing the body to the transport.
func SanitizeAdCodeBody(body []byte) []byte {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return body
	}
	for _, k := range adcodeUnsupportedParams {
		delete(parsed, k)
	}
	// Internal bookkeeping keys (`_appliedPromptInjections` and friends) are not
	// part of the wire format; forwarding one is what triggered the generic 400.
	for k := range parsed {
		if strings.HasPrefix(k, "_") {
			delete(parsed, k)
		}
	}
	// An empty tools array is also refused upstream.
	if tools, ok := parsed["tools"].([]any); ok && len(tools) == 0 {
		delete(parsed, "tools")
	}
	out, err := json.Marshal(parsed)
	if err != nil {
		return body
	}
	return out
}

// ── token cache file ─────────────────────────────────────────────────────────

// dataDir resolves the data root the same way the rest of the process does.
func adcodeTokenCachePath() string {
	dir := strings.TrimSpace(os.Getenv("DATA_DIR"))
	if dir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, ".xrouter")
		} else {
			dir = "."
		}
	}
	return filepath.Join(dir, "adcode-token.json")
}

func (a *AdCode) loadCacheLocked() {
	if a.loaded {
		return
	}
	a.loaded = true

	path := a.tokenCachePath
	if path == "" {
		path = adcodeTokenCachePath()
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var c adcodeTokenCache
	if err := json.Unmarshal(raw, &c); err != nil {
		return
	}
	a.cache = c
}

func (a *AdCode) writeCacheLocked() {
	path := a.tokenCachePath
	if path == "" {
		path = adcodeTokenCachePath()
	}
	raw, err := json.MarshalIndent(a.cache, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	// 0600: the file holds a bearer token that authorises upstream spend.
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return
	}
}

// clipForError truncates a body for an error message.
func clipForError(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// parseInt parses a decimal string, rejecting trailing garbage.
func parseInt(s string) (int, error) {
	n := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("not a number: %q", s)
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}
