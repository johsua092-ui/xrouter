package providers

// Wave 20: the providers that carry their own auth or body protocol rather than
// a URL difference. Each one below was previously served by the generic
// OpenAI-compatible adapter, which cannot sign an HMAC, cannot mint a Google
// service-account token, and cannot rebuild a CodeBuddy request envelope — so
// every call to these providers failed upstream while the connection looked fine.

import (
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------- helpers

// uuidV4 mints a random RFC-4122 v4 identifier. Providers that fingerprint the
// client require a fresh id per request in the same shape the vendor CLI sends.
func uuidV4() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

// uuidCompact is the same value without dashes, which CodeBuddy uses for the
// request id while the conversation id keeps its dashes.
func uuidCompact() string { return strings.ReplaceAll(uuidV4(), "-", "") }

// ---------------------------------------------------------------- iflow

// iflowAdapter signs every request with HMAC-SHA256 over
// "UserAgent:sessionId:timestamp" keyed by the API key. Without the signature the
// upstream answers 401 regardless of a valid Bearer token.
type iflowAdapter struct{}

const (
	iflowBaseURL = "https://apis.iflow.cn/v1/chat/completions"
	iflowUA      = "iFlow-Cli"
)

func (a *iflowAdapter) Name() string { return "iflow" }

func (a *iflowAdapter) Endpoint(req Request, cred Credential) (string, error) {
	return firstNonEmpty(cred.BaseURL, iflowBaseURL), nil
}

func (a *iflowAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	key := firstNonEmpty(cred.APIKey, cred.AccessToken)
	sessionID := "session-" + uuidV4()
	timestamp := time.Now().UnixMilli()

	headers := map[string]string{
		"Content-Type":      "application/json",
		"User-Agent":        iflowUA,
		"session-id":        sessionID,
		"x-iflow-timestamp": fmt.Sprintf("%d", timestamp),
		"x-iflow-signature": iflowSignature(iflowUA, sessionID, timestamp, key),
	}
	if cred.APIKey != "" {
		headers["Authorization"] = "Bearer " + cred.APIKey
	}
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}
	return headers, nil
}

// RewriteBody asks for usage blocks on streamed responses, which the upstream
// only includes when stream_options is present.
func (a *iflowAdapter) RewriteBody(req Request, cred Credential, body []byte) ([]byte, error) {
	if !req.Stream {
		return nil, nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, nil
	}
	if _, hasMessages := parsed["messages"]; !hasMessages {
		return nil, nil
	}
	if _, hasOptions := parsed["stream_options"]; hasOptions {
		return nil, nil
	}
	parsed["stream_options"] = map[string]any{"include_usage": true}
	return json.Marshal(parsed)
}

func iflowSignature(userAgent, sessionID string, timestamp int64, apiKey string) string {
	if apiKey == "" {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(apiKey))
	fmt.Fprintf(mac, "%s:%s:%d", userAgent, sessionID, timestamp)
	return hex.EncodeToString(mac.Sum(nil))
}

// ---------------------------------------------------------------- xiaomi-mimo

// xiaomiMimoAdapter has two routes. Cloud models use the ordinary OpenAI shim on
// api.xiaomimimo.com. The v2.6 family can instead consume the account's weekly
// quota through the account service, which authenticates with a desktop session
// cookie rather than the sk- key. The cookie is supplied by the connection (the
// SSO handshake that mints it belongs to the login flow, not the request path).
type xiaomiMimoAdapter struct{}

func (a *xiaomiMimoAdapter) Name() string { return "xiaomi-mimo" }

var mimoAccountModels = map[string]bool{
	"mimo-v2.6-pro":            true,
	"mimo-v2.6-flash":          true,
	"mimo-v2.6-pro-ultraspeed": true,
}

const mimoAPIUA = "miNative PC/Normal Windows_NT/10.0.19045 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0"

// mimoAccountRoute reports whether this request uses the account service.
func mimoAccountRoute(model string, cred Credential) bool {
	bare := model
	if index := strings.Index(bare, "/"); index >= 0 {
		bare = bare[index+1:]
	}
	if !mimoAccountModels[bare] {
		return false
	}
	return cred.Cookie != "" || cred.Extra["mimoPassToken"] != ""
}

// mimoServerBase resolves the account cluster host, defaulting to the
// international (SGP) cluster the desktop app uses outside mainland China.
func mimoServerBase(cred Credential) string {
	if base := cred.Extra["accountBase"]; base != "" {
		return strings.TrimSuffix(base, "/")
	}
	region := strings.ToLower(cred.Extra["region"])
	switch region {
	case "cn":
		return "https://mimo-server-cn.xiaomimimo.com"
	case "ams":
		return "https://mimo-server-ams.xiaomimimo.com"
	case "ru":
		return "https://mimo-server-ru.xiaomimimo.com"
	case "in":
		return "https://mimo-server-in.xiaomimimo.com"
	}
	return "https://mimo-server-sgp.xiaomimimo.com"
}

func (a *xiaomiMimoAdapter) Endpoint(req Request, cred Credential) (string, error) {
	if mimoAccountRoute(req.Model, cred) {
		return mimoServerBase(cred) + "/api/route/chat/completions", nil
	}
	return firstNonEmpty(cred.BaseURL, "https://api.xiaomimimo.com/v1/chat/completions"), nil
}

func (a *xiaomiMimoAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	if mimoAccountRoute(req.Model, cred) && cred.Cookie != "" {
		accept := "application/json"
		if req.Stream {
			accept = "text/event-stream"
		}
		return map[string]string{
			"Content-Type": "application/json",
			"Accept":       accept,
			"User-Agent":   mimoAPIUA,
			"Cookie":       cred.Cookie,
		}, nil
	}
	key := firstNonEmpty(cred.APIKey, cred.AccessToken)
	if key == "" {
		return nil, errNoCredential("xiaomi-mimo")
	}
	headers := map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer " + key,
	}
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}
	return headers, nil
}

// RewriteBody bridges reasoning_effort to the desktop app's output_config.effort
// and fills the sampling defaults the account route expects.
func (a *xiaomiMimoAdapter) RewriteBody(req Request, cred Credential, body []byte) ([]byte, error) {
	if !mimoAccountRoute(req.Model, cred) {
		return nil, nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, nil
	}
	effort := firstNonEmpty(str(parsed["reasoning_effort"]),
		str(nestedString(parsed, "output_config", "effort")))
	if effort != "" {
		delete(parsed, "reasoning_effort")
		normalised := strings.ToLower(effort)
		if normalised == "xhigh" {
			normalised = "high"
		}
		outputConfig, _ := parsed["output_config"].(map[string]any)
		if outputConfig == nil {
			outputConfig = map[string]any{}
		}
		outputConfig["effort"] = normalised
		parsed["output_config"] = outputConfig
	}
	if _, has := parsed["temperature"]; !has {
		parsed["temperature"] = 1.0
	}
	if _, has := parsed["top_p"]; !has {
		parsed["top_p"] = 0.95
	}
	return json.Marshal(parsed)
}

// nestedString reads a string from a nested object without panicking on absence.
func nestedString(root map[string]any, key, nested string) any {
	object, ok := root[key].(map[string]any)
	if !ok {
		return nil
	}
	return object[nested]
}

// ---------------------------------------------------------------- codebuddy

// codebuddyAdapter covers both CodeBuddy deployments. Tencent's gateway rejects
// plain OpenAI shapes: it wants the CLI identity headers, a leading system
// message, user content as typed blocks, and stream=true always. It also bans
// accounts whose prompt still carries another agent's identity string, so those
// markers are neutralised before the request leaves.
type codebuddyAdapter struct {
	provider string // codebuddy-cn | codebuddy-intl
}

func (a *codebuddyAdapter) Name() string { return a.provider }

const codebuddySystemPrompt = "You are CodeBuddy Code."

// codebuddyChannelMarkers are the literal strings the upstream flags. They are
// replaced rather than dropped so the prompt keeps its shape.
var codebuddyChannelMarkers = []string{
	"You are Claude Code, Anthropic's official CLI for Claude.",
	"x-anthropic-billing-header",
	"Main branch (you will usually use this for PRs):",
}

func (a *codebuddyAdapter) baseURL(cred Credential) string {
	if cred.BaseURL != "" {
		return cred.BaseURL
	}
	if a.provider == "codebuddy-cn" {
		return "https://copilot.tencent.com/v2/chat/completions"
	}
	return "https://www.codebuddy.ai/v2/chat/completions"
}

func (a *codebuddyAdapter) Endpoint(req Request, cred Credential) (string, error) {
	base := a.baseURL(cred)
	if !strings.Contains(base, "/chat/completions") {
		base = strings.TrimSuffix(base, "/") + "/v2/chat/completions"
	}
	return base, nil
}

func (a *codebuddyAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	key := firstNonEmpty(cred.APIKey, cred.AccessToken)
	if key == "" {
		return nil, errNoCredential(a.provider)
	}
	domain := cred.Extra["domain"]
	if domain == "" {
		if a.provider == "codebuddy-cn" {
			domain = "copilot.tencent.com"
		} else {
			domain = "www.codebuddy.ai"
		}
	}
	requestID := uuidCompact()
	headers := map[string]string{
		"Content-Type":                "application/json; charset=utf-8",
		"Authorization":               "Bearer " + key,
		"User-Agent":                  "CLI/2.108.1 CodeBuddy/2.108.1",
		"X-Product":                   "SaaS",
		"X-App":                       "cli",
		"X-IDE-Type":                  "CLI",
		"X-IDE-Name":                  "CLI",
		"X-IDE-Version":               "2.108.1",
		"X-Private-Data":              "false",
		"X-Requested-With":            "XMLHttpRequest",
		"X-CodeBuddy-Request":         "1",
		"X-Domain":                    domain,
		"X-Stainless-Runtime":         "node",
		"X-Stainless-Runtime-Version": "v24.11.1",
		"X-Stainless-Lang":            "js",
		"X-Stainless-Arch":            "x64",
		"X-Stainless-Os":              "Windows",
		"X-Stainless-Package-Version": "6.25.0",
		"X-Stainless-Helper-Method":   "stream",
		"X-Stainless-Retry-Count":     "0",
		"X-Request-ID":                requestID,
		"X-Conversation-ID":           uuidV4(),
		"X-Conversation-Request-ID":   uuidCompact(),
		"X-Conversation-Message-ID":   requestID,
		"X-Agent-Intent":              "craft",
		"X-Agent-Purpose":             "conversation",
	}
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}
	return headers, nil
}

// RewriteBody rebuilds the request envelope: always stream, reasoning summary on
// when an effort is requested, one leading system message, and user turns as
// typed text blocks.
func (a *codebuddyAdapter) RewriteBody(req Request, cred Credential, body []byte) ([]byte, error) {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, nil
	}
	parsed["stream"] = true

	if effort, ok := parsed["reasoning_effort"].(string); ok {
		if effort == "none" || effort == "off" {
			delete(parsed, "reasoning_effort")
		} else {
			parsed["reasoning_summary"] = "auto"
		}
	}

	systemParts := []string{codebuddySystemPrompt}
	other := make([]any, 0, 8)
	messages, _ := parsed["messages"].([]any)
	for _, raw := range messages {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role := str(message["role"])
		switch role {
		case "system", "developer":
			text := sanitizeCodebuddyMarkers(flattenSystem(message["content"]))
			if text != "" && text != codebuddySystemPrompt {
				systemParts = append(systemParts, text)
			}
		case "user":
			if text, isString := message["content"].(string); isString {
				message["content"] = []any{map[string]any{"type": "text", "text": text}}
			}
			other = append(other, message)
		case "assistant":
			switch content := message["content"].(type) {
			case string:
				message["content"] = sanitizeCodebuddyMarkers(content)
			case []any:
				for _, rawPart := range content {
					if part, ok := rawPart.(map[string]any); ok {
						if text, ok := part["text"].(string); ok {
							part["text"] = sanitizeCodebuddyMarkers(text)
						}
					}
				}
			}
			other = append(other, message)
		default:
			other = append(other, message)
		}
	}

	parsed["messages"] = append([]any{
		map[string]any{"role": "system", "content": strings.Join(systemParts, "\n\n")},
	}, other...)
	return json.Marshal(parsed)
}

// sanitizeCodebuddyMarkers replaces competitor identity strings. The account is
// banned when these reach the upstream, so the substitution is not cosmetic.
func sanitizeCodebuddyMarkers(text string) string {
	if text == "" {
		return text
	}
	for _, marker := range codebuddyChannelMarkers {
		text = strings.ReplaceAll(text, marker, "[external-client-identity]")
	}
	for _, fragment := range []string{
		"You are Claude Code",
		"Anthropic's official CLI",
		"you are claude code",
		"anxthxropic",
		"OhMyOpenCode",
	} {
		text = replaceFold(text, fragment, "[external-client-identity]")
	}
	return text
}

// replaceFold replaces case-insensitively without pulling in a regexp for each
// marker, which keeps the hot path cheap.
func replaceFold(haystack, needle, replacement string) string {
	lowerHay := strings.ToLower(haystack)
	lowerNeedle := strings.ToLower(needle)
	var builder strings.Builder
	position := 0
	for {
		index := strings.Index(lowerHay[position:], lowerNeedle)
		if index < 0 {
			builder.WriteString(haystack[position:])
			return builder.String()
		}
		builder.WriteString(haystack[position : position+index])
		builder.WriteString(replacement)
		position += index + len(needle)
	}
}

// ---------------------------------------------------------------- vertex

// vertexAdapter speaks Vertex AI: Gemini models on a project-scoped path, with a
// choice of three auth shapes — service-account JWT, ADC user refresh token, or a
// raw API key in the query string. The service-account path mints and caches its
// own OAuth token because the gateway's connection stores the JSON, not a token.
type vertexAdapter struct {
	mu     sync.Mutex
	tokens map[string]vertexToken
}

type vertexToken struct {
	token   string
	expires time.Time
}

func (a *vertexAdapter) Name() string { return "vertex" }

// vertexServiceAccount is the subset of a Google service-account JSON we need.
type vertexServiceAccount struct {
	Type        string `json:"type"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
	ProjectID   string `json:"project_id"`
}

// vertexADC is what `gcloud auth application-default login` writes.
type vertexADC struct {
	Type         string `json:"type"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	RefreshToken string `json:"refresh_token"`
	QuotaProject string `json:"quota_project_id"`
}

func parseVertexServiceAccount(raw string) (*vertexServiceAccount, bool) {
	if !strings.Contains(raw, "service_account") {
		return nil, false
	}
	var sa vertexServiceAccount
	if err := json.Unmarshal([]byte(raw), &sa); err != nil || sa.ClientEmail == "" || sa.PrivateKey == "" {
		return nil, false
	}
	return &sa, true
}

func parseVertexADC(raw string) (*vertexADC, bool) {
	if !strings.Contains(raw, "authorized_user") {
		return nil, false
	}
	var adc vertexADC
	if err := json.Unmarshal([]byte(raw), &adc); err != nil || adc.RefreshToken == "" {
		return nil, false
	}
	return &adc, true
}

func (a *vertexAdapter) Endpoint(req Request, cred Credential) (string, error) {
	action := "generateContent"
	if req.Stream {
		action = "streamGenerateContent?alt=sse"
	}

	if strings.HasSuffix(req.Provider, "partner") {
		project := firstNonEmpty(cred.Extra["projectId"], vertexProjectFromKey(cred.APIKey))
		if project == "" {
			return "", fmt.Errorf("vertex-partner: a project id is required")
		}
		endpoint := fmt.Sprintf("https://aiplatform.googleapis.com/v1/projects/%s/locations/global/endpoints/openapi/chat/completions", project)
		if raw := vertexRawKey(cred); raw != "" {
			endpoint += "?key=" + url.QueryEscape(raw)
		}
		return endpoint, nil
	}

	project := firstNonEmpty(cred.Extra["projectId"], vertexProjectFromKey(cred.APIKey))
	usingOAuth := cred.AccessToken != "" || vertexHasOAuthMaterial(cred.APIKey)
	location := firstNonEmpty(cred.Extra["location"])
	if location == "" {
		if usingOAuth {
			location = "us-central1"
		} else {
			location = "global"
		}
	}

	var endpoint string
	if project != "" {
		endpoint = fmt.Sprintf("https://aiplatform.googleapis.com/v1/projects/%s/locations/%s/publishers/google/models/%s:%s",
			project, location, req.Model, action)
	} else {
		endpoint = fmt.Sprintf("https://aiplatform.googleapis.com/v1/publishers/google/models/%s:%s", req.Model, action)
	}
	if raw := vertexRawKey(cred); raw != "" {
		if strings.Contains(endpoint, "?") {
			endpoint += "&key=" + url.QueryEscape(raw)
		} else {
			endpoint += "?key=" + url.QueryEscape(raw)
		}
	}
	return endpoint, nil
}

func (a *vertexAdapter) Headers(req Request, cred Credential) (map[string]string, error) {
	headers := map[string]string{"Content-Type": "application/json"}
	token := cred.AccessToken
	if token == "" {
		token = a.mint(cred.APIKey, cred.Extra["clientId"], cred.Extra["clientSecret"])
	}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	if req.Stream {
		headers["Accept"] = "text/event-stream"
	}
	return headers, nil
}

// vertexRawKey reports the key to put in the query string: only a plain key, not
// a JSON credential blob.
func vertexRawKey(cred Credential) string {
	key := strings.TrimSpace(cred.APIKey)
	if key == "" || strings.HasPrefix(key, "{") {
		return ""
	}
	return key
}

func vertexHasOAuthMaterial(raw string) bool {
	if _, ok := parseVertexServiceAccount(raw); ok {
		return true
	}
	_, ok := parseVertexADC(raw)
	return ok
}

func vertexProjectFromKey(raw string) string {
	if sa, ok := parseVertexServiceAccount(raw); ok {
		return sa.ProjectID
	}
	if adc, ok := parseVertexADC(raw); ok {
		return adc.QuotaProject
	}
	return ""
}

// mint exchanges either a service-account assertion or an ADC refresh token for an
// access token, caching it until two minutes before expiry.
func (a *vertexAdapter) mint(rawKey, clientID, clientSecret string) string {
	if rawKey == "" {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if cached, ok := a.tokens[rawKey]; ok && time.Now().Before(cached.expires) {
		return cached.token
	}

	var form url.Values
	if sa, ok := parseVertexServiceAccount(rawKey); ok {
		assertion, err := signServiceAccountJWT(sa)
		if err != nil {
			return ""
		}
		form = url.Values{
			"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
			"assertion":  {assertion},
		}
	} else if adc, ok := parseVertexADC(rawKey); ok {
		form = url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {adc.RefreshToken},
			"client_id":     {firstNonEmpty(adc.ClientID, clientID)},
			"client_secret": {firstNonEmpty(adc.ClientSecret, clientSecret)},
		}
	} else {
		return ""
	}

	client := &http.Client{Timeout: 12 * time.Second}
	response, err := client.PostForm("https://oauth2.googleapis.com/token", form)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ""
	}
	var payload struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil || payload.AccessToken == "" {
		return ""
	}
	lifetime := time.Duration(payload.ExpiresIn) * time.Second
	if lifetime <= 0 {
		lifetime = 50 * time.Minute
	}
	if a.tokens == nil {
		a.tokens = make(map[string]vertexToken, 2)
	}
	a.tokens[rawKey] = vertexToken{token: payload.AccessToken, expires: time.Now().Add(lifetime - 2*time.Minute)}
	return payload.AccessToken
}

// signServiceAccountJWT builds the RS256 assertion Google's token endpoint takes.
func signServiceAccountJWT(sa *vertexServiceAccount) (string, error) {
	block, _ := pem.Decode([]byte(sa.PrivateKey))
	if block == nil {
		return "", fmt.Errorf("vertex: service account key is not PEM")
	}
	var privateKey *rsa.PrivateKey
	if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		key, ok := parsed.(*rsa.PrivateKey)
		if !ok {
			return "", fmt.Errorf("vertex: service account key is not RSA")
		}
		privateKey = key
	} else if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		privateKey = key
	} else {
		return "", fmt.Errorf("vertex: unreadable service account key")
	}

	tokenURI := sa.TokenURI
	if tokenURI == "" {
		tokenURI = "https://oauth2.googleapis.com/token"
	}
	now := time.Now()
	header := map[string]string{"alg": "RS256", "typ": "JWT"}
	claims := map[string]any{
		"iss":   sa.ClientEmail,
		"scope": "https://www.googleapis.com/auth/cloud-platform",
		"aud":   tokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}
	headerJSON, _ := json.Marshal(header)
	claimsJSON, _ := json.Marshal(claims)
	encodedHeader := base64.RawURLEncoding.EncodeToString(headerJSON)
	encodedClaims := base64.RawURLEncoding.EncodeToString(claimsJSON)
	signingInput := encodedHeader + "." + encodedClaims

	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

// ---------------------------------------------------------------- registration

// RegisterWave20 installs the adapters from wave 20.
func RegisterWave20(r *Registry) {
	r.Register(&iflowAdapter{})
	r.Register(&xiaomiMimoAdapter{})
	r.Register(&codebuddyAdapter{provider: "codebuddy-cn"})
	r.Register(&codebuddyAdapter{provider: "codebuddy-intl"})
	r.Register(&vertexAdapter{tokens: make(map[string]vertexToken, 2)})
}
