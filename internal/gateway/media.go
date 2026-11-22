package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"

	"github.com/johsua092-ui/xrouter/internal/catalog"
	"github.com/johsua092-ui/xrouter/internal/database"
)

// Media plane: embeddings, images, speech, transcription, voices, search, fetch
// and video.
//
// These endpoints are config-driven, mirroring the Node design: each provider
// ships a descriptor (`embeddingConfig`, `imageConfig`, `ttsConfig`,
// `sttConfig`, `searchConfig`, `fetchConfig`, `videoConfig`) that names the
// endpoint, the auth style and the request dialect. The Go dispatcher reads that
// descriptor instead of hardcoding a switch per provider, so a provider added on
// the Node side becomes callable here without a Go change — the only thing Go
// owns is the wire mechanics shared by every JSON API.

// mediaConfigName maps an endpoint to the catalogue descriptor it reads.
type mediaConfigName string

const (
	cfgEmbedding mediaConfigName = "embeddingConfig"
	cfgImage     mediaConfigName = "imageConfig"
	cfgTTS       mediaConfigName = "ttsConfig"
	cfgSTT       mediaConfigName = "sttConfig"
	cfgSearch    mediaConfigName = "searchConfig"
	cfgFetch     mediaConfigName = "fetchConfig"
	cfgVideo     mediaConfigName = "videoConfig"
	cfgVoices    mediaConfigName = "ttsVoicesConfig"
)

// mediaTarget is a resolved call: the provider, its descriptor and the connection
// whose credentials authorise it.
type mediaTarget struct {
	providers  catalog.Provider
	config     map[string]any
	connection *database.ProviderCredential
	name       string
	// model is the bare upstream model id, with the routing prefix stripped.
	model string
}

// resolveMedia finds the provider, descriptor and live connection for a media
// request. The first error return is a client error (400/404); the second says
// whether a connection was found at all, so the caller can answer 503 instead of
// pretending the request was malformed.
func (g *Gateway) resolveMedia(model string, cfgName mediaConfigName) (*mediaTarget, error, bool) {
	providerName, modelID, ok := splitProviderModel(model)
	if !ok {
		return nil, errors.New("Invalid model format. Expected \"provider/model\""), true
	}
	providerName = g.catalog.ResolveID(providerName)

	provider, found := g.catalog.Provider(providerName)
	if !found {
		return nil, errors.New("Unknown provider: " + providerName), true
	}

	cfg := provider.Media[string(cfgName)]
	if cfg == nil {
		return nil, errors.New("Provider '" + providerName + "' does not support this endpoint"), true
	}

	conn, connErr := g.db.FindActiveConnection(providerName)
	if connErr != nil || conn == nil {
		return &mediaTarget{providers: provider, config: cfg, name: providerName}, nil, false
	}

	return &mediaTarget{
		providers:  provider,
		config:     cfg,
		connection: conn,
		name:       providerName,
		model:      modelID,
	}, nil, true
}

// modelID is the bare upstream model id, kept on the target because every
// dialect places it differently.
func (t *mediaTarget) modelID() string { return t.model }

// mediaURL builds the upstream URL. A descriptor's baseUrl is used verbatim when
// it already names the endpoint; the provider-specific suffixes below cover the
// APIs that expect the model or voice in the path.
func mediaURL(t *mediaTarget, suffix string) string {
	base := asString(t.config["baseUrl"])
	if base == "" && t.connection != nil {
		base = t.connection.BaseURL
	}
	if suffix == "" {
		return base
	}
	return strings.TrimRight(base, "/") + suffix
}

// applyMediaAuth sets the credential on the request according to the descriptor's
// auth style. Providers disagree on all three axes: header name, prefix, and
// whether the key is a query parameter.
func applyMediaAuth(req *http.Request, t *mediaTarget, key string) {
	authType := asString(t.config["authType"])
	header := asString(t.config["authHeader"])

	switch {
	case key == "":
		return
	case authType == "query" || header == "key":
		q := req.URL.Query()
		q.Set("key", key)
		req.URL.RawQuery = q.Encode()
	case header == "bearer" || header == "":
		req.Header.Set("Authorization", "Bearer "+key)
	case authType == "apikey":
		req.Header.Set(header, key)
	default:
		req.Header.Set(header, key)
	}
}

// connectionKey reads the credential off the connection, preferring the API key
// and falling back to an OAuth token.
func connectionKey(conn *database.ProviderCredential) string {
	if conn == nil {
		return ""
	}
	if conn.APIKey != "" {
		return conn.APIKey
	}
	return conn.Token
}

// callMedia performs the upstream call and streams the body back with the
// upstream content type. Binary responses (audio, images) must not be decoded,
// which is why this writes the body through instead of returning a value.
func (g *Gateway) callMedia(w http.ResponseWriter, r *http.Request, t *mediaTarget, method, target string, payload []byte, contentType string, query url.Values) {
	if query != nil {
		sep := "?"
		if strings.Contains(target, "?") {
			sep = "&"
		}
		target += sep + query.Encode()
	}

	req, err := http.NewRequestWithContext(r.Context(), method, target, bytes.NewReader(payload))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not build upstream request", err)
		return
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	applyMediaAuth(req, t, connectionKey(t.connection))

	for name, value := range asStringMap(t.config["headers"]) {
		req.Header.Set(name, value)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		jsonError(w, http.StatusBadGateway, "upstream call failed for "+t.name, err)
		return
	}
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if ct := resp.Header.Get("Content-Disposition"); ct != "" {
		w.Header().Set("Content-Disposition", ct)
	}
	w.WriteHeader(resp.StatusCode)

	// Relay in chunks so a large audio or image body is not buffered whole.
	buf := make([]byte, 32<<10)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr != nil {
			return
		}
	}
}

// asStringMap reads a string map from a decoded descriptor.
func asStringMap(v any) map[string]string {
	raw, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]string, len(raw))
	for k, value := range raw {
		if s, ok := value.(string); ok {
			out[k] = s
		}
	}
	return out
}

// noConnection answers a request whose provider has no stored credential.
func (g *Gateway) noConnection(w http.ResponseWriter, provider string) {
	jsonResponse(w, http.StatusServiceUnavailable, map[string]any{
		"error":    "no active connection for provider",
		"provider": provider,
		"detail":   "no active connection",
	})
}

// handleEmbeddings serves POST /v1/embeddings.
//
// The body is forwarded with the provider-qualified model stripped to its bare
// id: an upstream expects the model it issues, not the gateway's routing prefix.
func (g *Gateway) handleEmbeddings(w http.ResponseWriter, r *http.Request) {
	body, err := readBodyPeek(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "could not read request body", err)
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON body", err)
		return
	}
	model := asString(parsed["model"])
	if model == "" {
		jsonError(w, http.StatusBadRequest, "Missing model", nil)
		return
	}
	if parsed["input"] == nil {
		jsonError(w, http.StatusBadRequest, "Missing required field: input", nil)
		return
	}

	target, clientErr, hasConn := g.resolveMedia(model, cfgEmbedding)
	if clientErr != nil {
		jsonError(w, http.StatusBadRequest, clientErr.Error(), nil)
		return
	}
	if !hasConn {
		g.noConnection(w, target.name)
		return
	}

	parsed["model"] = target.modelID()
	payload, err := json.Marshal(parsed)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not serialise request", err)
		return
	}

	suffix := ""
	if format := asString(target.config["format"]); strings.HasPrefix(format, "gemini") {
		// Gemini's embedding endpoint is model-scoped: /{model}:embedContent.
		suffix = "/" + target.modelID() + ":embedContent"
	}
	g.callMedia(w, r, target, http.MethodPost, mediaURL(target, suffix), payload, "application/json", nil)
}

// handleImages serves POST /v1/images/generations.
func (g *Gateway) handleImages(w http.ResponseWriter, r *http.Request) {
	body, err := readBodyPeek(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "could not read request body", err)
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON body", err)
		return
	}
	model := asString(parsed["model"])
	if model == "" {
		jsonError(w, http.StatusBadRequest, "Missing model", nil)
		return
	}
	if asString(parsed["prompt"]) == "" {
		jsonError(w, http.StatusBadRequest, "Missing required field: prompt", nil)
		return
	}

	target, clientErr, hasConn := g.resolveMedia(model, cfgImage)
	if clientErr != nil {
		jsonError(w, http.StatusBadRequest, clientErr.Error(), nil)
		return
	}
	if !hasConn {
		g.noConnection(w, target.name)
		return
	}

	parsed["model"] = target.modelID()
	payload, err := json.Marshal(parsed)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not serialise request", err)
		return
	}

	// Providers whose base URL stops before the model segment.
	suffix := ""
	switch target.name {
	case "fal-ai", "black-forest-labs":
		suffix = "/" + target.modelID()
	}
	g.callMedia(w, r, target, http.MethodPost, mediaURL(target, suffix), payload, "application/json", nil)
}

// handleSpeech serves POST /v1/audio/speech.
func (g *Gateway) handleSpeech(w http.ResponseWriter, r *http.Request) {
	body, err := readBodyPeek(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "could not read request body", err)
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON body", err)
		return
	}
	model := asString(parsed["model"])
	if model == "" {
		jsonError(w, http.StatusBadRequest, "Missing model", nil)
		return
	}
	if asString(parsed["input"]) == "" && asString(parsed["text"]) == "" {
		jsonError(w, http.StatusBadRequest, "Missing required field: input", nil)
		return
	}

	target, clientErr, hasConn := g.resolveMedia(model, cfgTTS)
	if clientErr != nil {
		jsonError(w, http.StatusBadRequest, clientErr.Error(), nil)
		return
	}
	if !hasConn {
		g.noConnection(w, target.name)
		return
	}

	modelID := target.modelID()
	parsed["model"] = modelID
	payload, err := json.Marshal(parsed)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not serialise request", err)
		return
	}

	format := asString(target.config["format"])
	suffix := ""
	if format == "elevenlabs" {
		// ElevenLabs scopes synthesis to a voice id in the path.
		voice := asString(parsed["voice"])
		if voice == "" {
			voice = "21m00Tcm4TlvDq8ikWAM"
		}
		suffix = "/" + voice
	}
	g.callMedia(w, r, target, http.MethodPost, mediaURL(target, suffix), payload, "application/json", nil)
}

// handleTranscriptions serves POST /v1/audio/transcriptions.
//
// The client sends multipart audio; it is forwarded as multipart, because
// re-encoding it into JSON would change what the upstream sees. Only the model
// field is rewritten.
func (g *Gateway) handleTranscriptions(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		jsonError(w, http.StatusBadRequest, "expected multipart/form-data with an audio file", err)
		return
	}

	model := r.FormValue("model")
	if model == "" {
		jsonError(w, http.StatusBadRequest, "Missing model", nil)
		return
	}

	target, clientErr, hasConn := g.resolveMedia(model, cfgSTT)
	if clientErr != nil {
		jsonError(w, http.StatusBadRequest, clientErr.Error(), nil)
		return
	}
	if !hasConn {
		g.noConnection(w, target.name)
		return
	}

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	file, header, err := r.FormFile("file")
	if err == nil {
		defer file.Close()
		part, createErr := writer.CreateFormFile("file", header.Filename)
		if createErr != nil {
			jsonError(w, http.StatusInternalServerError, "could not build upstream form", createErr)
			return
		}
		if _, copyErr := io.Copy(part, file); copyErr != nil {
			jsonError(w, http.StatusBadRequest, "could not read uploaded audio", copyErr)
			return
		}
	}

	for key, values := range r.MultipartForm.Value {
		if key == "model" {
			continue
		}
		for _, value := range values {
			_ = writer.WriteField(key, value)
		}
	}
	_ = writer.WriteField("model", target.modelID())
	if err := writer.Close(); err != nil {
		jsonError(w, http.StatusInternalServerError, "could not finish upstream form", err)
		return
	}

	format := asString(target.config["format"])
	suffix := ""
	if strings.HasPrefix(format, "gemini") {
		suffix = "/" + target.modelID() + ":generateContent"
	}
	g.callMedia(w, r, target, http.MethodPost, mediaURL(target, suffix), buf.Bytes(), writer.FormDataContentType(), nil)
}

// voiceList is the shape the voices endpoint answers with, kept independent of
// any provider so a client sees one schema.
type voiceList struct {
	Object string     `json:"object"`
	Voices []voiceOut `json:"voices"`
}

type voiceOut struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider,omitempty"`
}

// builtinVoices covers the providers whose voice list is fixed and published in
// their descriptor rather than fetched live.
var builtinVoices = map[string][]voiceOut{
	"elevenlabs": {
		{ID: "21m00Tcm4TlvDq8ikWAM", Name: "Rachel"},
		{ID: "AZnzlk1XvdvUeBnXmlld", Name: "Domi"},
		{ID: "EXAVITQu4vr4xnSDxMaL", Name: "Bella"},
		{ID: "ErXwobaYiN019PkySvjV", Name: "Antoni"},
		{ID: "MF3mGyEYCl7XYWbV9V6O", Name: "Elli"},
		{ID: "TxGEqnHWrfWFTfGW9XjX", Name: "Josh"},
		{ID: "VR6AewLTigWG4xSOukaG", Name: "Arnold"},
		{ID: "pNInz6obpgDQGcFmaJgB", Name: "Adam"},
		{ID: "yoZ06aMxZJJ28mfd3POQ", Name: "Sam"},
	},
	"openai": {
		{ID: "alloy", Name: "Alloy"},
		{ID: "echo", Name: "Echo"},
		{ID: "fable", Name: "Fable"},
		{ID: "onyx", Name: "Onyx"},
		{ID: "nova", Name: "Nova"},
		{ID: "shimmer", Name: "Shimmer"},
	},
}

// handleVoices serves GET /v1/audio/voices.
//
// A provider with a live voice endpoint is queried; a provider with a fixed,
// published set answers from the table above. The distinction matters because
// the live list is per-account — a cloned voice only exists for its owner.
func (g *Gateway) handleVoices(w http.ResponseWriter, r *http.Request) {
	providerName := r.URL.Query().Get("provider")
	if providerName == "" {
		providerName = r.URL.Query().Get("model")
	}
	if providerName == "" {
		jsonError(w, http.StatusBadRequest, "Missing provider", nil)
		return
	}
	if idx := strings.Index(providerName, "/"); idx > 0 {
		providerName = providerName[:idx]
	}
	providerName = g.catalog.ResolveID(providerName)

	conn, err := g.db.FindActiveConnection(providerName)
	if err != nil || conn == nil {
		g.noConnection(w, providerName)
		return
	}

	if voices, ok := builtinVoices[providerName]; ok {
		jsonResponse(w, http.StatusOK, voiceList{Object: "list", Voices: voices})
		return
	}

	provider, found := g.catalog.Provider(providerName)
	if !found {
		jsonError(w, http.StatusBadRequest, "Unknown provider: "+providerName, nil)
		return
	}
	cfg := provider.Media[string(cfgVoices)]
	if cfg == nil {
		jsonError(w, http.StatusBadRequest, "Provider '"+providerName+"' does not expose a voice list", nil)
		return
	}

	target := &mediaTarget{providers: provider, config: cfg, connection: conn, name: providerName}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, mediaURL(target, ""), nil)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not build upstream request", err)
		return
	}
	applyMediaAuth(req, target, connectionKey(conn))
	for name, value := range asStringMap(cfg["headers"]) {
		req.Header.Set(name, value)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		jsonError(w, http.StatusBadGateway, "voice list request failed for "+providerName, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusBadRequest {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		jsonResponse(w, resp.StatusCode, map[string]any{
			"error":    "upstream rejected the voice list request",
			"provider": providerName,
			"upstream": strings.TrimSpace(string(detail)),
		})
		return
	}

	var upstream map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&upstream); err != nil {
		jsonError(w, http.StatusBadGateway, "Invalid JSON response from "+providerName, err)
		return
	}

	voices := make([]voiceOut, 0, 8)
	for _, raw := range asSlice(upstream["voices"]) {
		voice := asObject(raw)
		if voice == nil {
			continue
		}
		voices = append(voices, voiceOut{
			ID:       firstNonEmpty(asString(voice["voice_id"]), asString(voice["id"])),
			Name:     firstNonEmpty(asString(voice["name"]), asString(voice["voice_id"])),
			Provider: providerName,
		})
	}
	jsonResponse(w, http.StatusOK, voiceList{Object: "list", Voices: voices})
}

// handleSearch serves POST /v1/search.
//
// The request is normalised to the shape the descriptor declares: providers
// differ on whether the query is a `q`, `query` or `search_query` field, and
// whether results come back as `results`, `web.results` or `data`.
func (g *Gateway) handleSearch(w http.ResponseWriter, r *http.Request) {
	body, err := readBodyPeek(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "could not read request body", err)
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON body", err)
		return
	}

	modelStr := asString(parsed["model"])
	query := firstNonEmpty(asString(parsed["query"]), asString(parsed["q"]), asString(parsed["search_query"]))
	if modelStr == "" {
		jsonError(w, http.StatusBadRequest, "Missing model", nil)
		return
	}
	if query == "" {
		jsonError(w, http.StatusBadRequest, "Missing required field: query", nil)
		return
	}

	target, clientErr, hasConn := g.resolveMedia(modelStr, cfgSearch)
	if clientErr != nil {
		jsonError(w, http.StatusBadRequest, clientErr.Error(), nil)
		return
	}
	if !hasConn {
		g.noConnection(w, target.name)
		return
	}

	requestBody := map[string]any{"query": query}
	if n, ok := parsed["max_results"]; ok {
		requestBody["max_results"] = n
	}
	if types, ok := parsed["search_type"]; ok {
		requestBody["search_type"] = types
	}

	payload, err := json.Marshal(requestBody)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not serialise request", err)
		return
	}

	method := strings.ToUpper(asString(target.config["method"]))
	if method == "" {
		method = http.MethodPost
	}

	var queryParams url.Values
	if method == http.MethodGet {
		queryParams = url.Values{}
		queryParams.Set("q", query)
		if v := asString(parsed["search_type"]); v != "" {
			queryParams.Set("type", v)
		}
		payload = nil
	}

	g.callMedia(w, r, target, method, mediaURL(target, ""), payload, "application/json", queryParams)
}

// handleFetch serves POST /v1/web/fetch.
func (g *Gateway) handleFetch(w http.ResponseWriter, r *http.Request) {
	body, err := readBodyPeek(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "could not read request body", err)
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON body", err)
		return
	}

	modelStr := asString(parsed["model"])
	targetURL := firstNonEmpty(asString(parsed["url"]), asString(parsed["uri"]))
	if modelStr == "" {
		jsonError(w, http.StatusBadRequest, "Missing model", nil)
		return
	}
	if targetURL == "" {
		jsonError(w, http.StatusBadRequest, "Missing required field: url", nil)
		return
	}

	target, clientErr, hasConn := g.resolveMedia(modelStr, cfgFetch)
	if clientErr != nil {
		jsonError(w, http.StatusBadRequest, clientErr.Error(), nil)
		return
	}
	if !hasConn {
		g.noConnection(w, target.name)
		return
	}

	method := strings.ToUpper(asString(target.config["method"]))
	if method == "" {
		method = http.MethodPost
	}

	endpoint := mediaURL(target, "")
	contentType := "application/json"
	var payload []byte
	var queryParams url.Values

	if method == http.MethodGet {
		// Reader-style fetchers take the target as the path.
		endpoint = strings.TrimRight(endpoint, "/") + "/" + strings.TrimPrefix(targetURL, "https://")
	} else {
		payload, err = json.Marshal(map[string]any{"url": targetURL, "urls": []any{targetURL}})
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "could not serialise request", err)
			return
		}
	}

	g.callMedia(w, r, target, method, endpoint, payload, contentType, queryParams)
}

// handleVideoGeneration serves the three video creation paths: generations,
// edits and extensions.
func (g *Gateway) handleVideoGeneration(w http.ResponseWriter, r *http.Request) {
	body, err := readBodyPeek(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "could not read request body", err)
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON body", err)
		return
	}

	model := asString(parsed["model"])
	if model == "" {
		jsonError(w, http.StatusBadRequest, "Missing model", nil)
		return
	}
	if asString(parsed["prompt"]) == "" {
		jsonError(w, http.StatusBadRequest, "Missing required field: prompt", nil)
		return
	}

	target, clientErr, hasConn := g.resolveMedia(model, cfgVideo)
	if clientErr != nil {
		jsonError(w, http.StatusBadRequest, clientErr.Error(), nil)
		return
	}
	if !hasConn {
		g.noConnection(w, target.name)
		return
	}

	parsed["model"] = target.modelID()
	payload, err := json.Marshal(parsed)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not serialise request", err)
		return
	}

	// The sub-path distinguishes create / edit / extend on providers that expose
	// them separately.
	suffix := ""
	switch {
	case strings.HasSuffix(r.URL.Path, "/edits"):
		suffix = "/edits"
	case strings.HasSuffix(r.URL.Path, "/extensions"):
		suffix = "/extensions"
	}
	g.callMedia(w, r, target, http.MethodPost, mediaURL(target, suffix), payload, "application/json", nil)
}

// handleVideoStatus serves GET /v1/videos/{id}.
func (g *Gateway) handleVideoStatus(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/v1/videos/")
	if id == "" {
		jsonError(w, http.StatusBadRequest, "Missing video id", nil)
		return
	}

	providerName := r.URL.Query().Get("provider")
	if providerName == "" {
		jsonError(w, http.StatusBadRequest, "Missing provider query parameter", nil)
		return
	}
	providerName = g.catalog.ResolveID(providerName)

	provider, found := g.catalog.Provider(providerName)
	if !found {
		jsonError(w, http.StatusBadRequest, "Unknown provider: "+providerName, nil)
		return
	}
	cfg := provider.Media[string(cfgVideo)]
	if cfg == nil {
		jsonError(w, http.StatusBadRequest, "Provider '"+providerName+"' does not support video", nil)
		return
	}

	conn, err := g.db.FindActiveConnection(providerName)
	if err != nil || conn == nil {
		g.noConnection(w, providerName)
		return
	}

	target := &mediaTarget{providers: provider, config: cfg, connection: conn, name: providerName}
	g.callMedia(w, r, target, http.MethodGet, mediaURL(target, "/"+id), nil, "", nil)
}
