package gateway

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/johsua092-ui/xrouter/internal/config"
	"github.com/johsua092-ui/xrouter/internal/connection"
	"github.com/johsua092-ui/xrouter/internal/database"
	"github.com/johsua092-ui/xrouter/internal/providers"
	"github.com/johsua092-ui/xrouter/internal/translate"
)

type Gateway struct {
	cfg         *config.Config
	db          *database.DB
	mux         *chi.Mux
	registry    *providers.Registry
	translators *translate.Registry
	upstream    *providers.Transport
}

func New(cfg *config.Config, db *database.DB) *Gateway {
	mux := chi.NewRouter()

	// Middlewares
	mux.Use(middleware.RequestID)
	mux.Use(middleware.RealIP)
	mux.Use(middleware.Logger)
	mux.Use(middleware.Recoverer)
	mux.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Provider adapter registry: the ported adapters from internal/providers.
	// Wave 1 is every OpenAI-compatible provider, wave 2 the three high-traffic
	// specials (grok-cli, qoder, antigravity), wave 3 the identity quirks.
	// Unported providers fall through to the generic adapter so routing never
	// dead-ends.
	registry := providers.NewRegistry()
	providers.RegisterDefaults(registry)
	providers.RegisterWave2(registry)
	providers.RegisterWave3(registry)

	// Translator registry. Every request and response converter self-registers
	// from its own file's init(), so this only needs to hand out the shared set.
	translators := translate.NewRegistry()
	translate.RegisterDefaults(translators)

	g := &Gateway{
		cfg:         cfg,
		db:          db,
		mux:         mux,
		registry:    registry,
		translators: translators,
		upstream:    providers.NewTransport(nil),
	}

	g.registerRoutes()
	return g
}

func (g *Gateway) registerRoutes() {
	// Health & System
	g.mux.Get("/api/health", g.handleHealth)
	g.mux.Get("/api/auth/status", g.handleAuthStatus)

	// Adapter coverage: how many providers have a real Go port vs the fallback.
	// Makes Phase 2 progress observable instead of assumed.
	g.mux.Get("/api/system/adapters", g.handleAdapterCoverage)

	// AI Gateway V1 Endpoints
	g.mux.Route("/v1", func(r chi.Router) {
		r.Get("/models", g.handleModels)
		r.Post("/chat/completions", g.handleChatCompletions)
		// The Claude Messages endpoint. A Claude Code client posts here, so the
		// path must exist for the translate-in path to be reachable at all —
		// without it a Claude client 404s before translation is ever considered.
		r.Post("/messages", g.handleChatCompletions)
	})

	// Diagnostic & Proxy Test Utility
	g.mux.Get("/api/test-proxy", g.handleTestProxy)

	// Connection & Telegram Bot Controller
	g.mux.Route("/api/connection", func(r chi.Router) {
		r.Get("/", g.handleGetConnection)
		r.Post("/", g.handlePostConnection)
		r.Post("/telegram/command", g.handleTelegramCommand)
		r.Post("/telegram/webhook", g.handleTelegramWebhook)
	})

	// Multi-Tenant Teams & Quota Governance
	g.mux.Route("/admin/v1/teams", func(r chi.Router) {
		r.Get("/", g.handleGetTeams)
		r.Post("/", g.handleCreateTeam)
		r.Route("/{id}", func(sr chi.Router) {
			r.Patch("/{id}", g.handleUpdateTeam)
			r.Delete("/{id}", g.handleDeleteTeam)
		})
	})
}

func (g *Gateway) handleHealth(w http.ResponseWriter, r *http.Request) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	allocMb := float64(mem.Alloc) / (1024 * 1024)

	out := map[string]interface{}{
		"ok":        true,
		"engine":    "golang",
		"version":   g.cfg.Version,
		"port":      g.cfg.Port,
		"memory_mb": fmt.Sprintf("%.2f MB", allocMb),
	}

	// Credential readability. Without this the sealed/plaintext split is only
	// discoverable by watching requests fail one provider at a time.
	readable, sealed, cerr := g.db.CountReadableConnections()
	if cerr != nil {
		out["connections"] = map[string]interface{}{"error": cerr.Error()}
	} else {
		out["connections"] = map[string]interface{}{
			"readable": readable,
			"sealed":   sealed,
			"total":    readable + sealed,
		}
	}

	jsonResponse(w, http.StatusOK, out)
}

func (g *Gateway) handleTestProxy(w http.ResponseWriter, r *http.Request) {
	proxyRaw := r.URL.Query().Get("proxy")
	target := r.URL.Query().Get("target")
	if target == "" {
		target = "https://opencode.ai/inference/openai/v1/models"
	}

	transport := &http.Transport{
		DisableKeepAlives: true,
	}

	if proxyRaw != "" {
		proxyURL, err := url.Parse(proxyRaw)
		if err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]interface{}{
				"ok":    false,
				"error": fmt.Sprintf("invalid proxy url: %v", err),
			})
			return
		}
		transport.Proxy = http.ProxyURL(proxyURL)
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   6 * time.Second,
	}

	req, err := http.NewRequestWithContext(r.Context(), "GET", target, nil)
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"error": err.Error()})
		return
	}
	req.Header.Set("User-Agent", "opencode/latest/2.0.26/cli")
	req.Header.Set("Authorization", "Bearer public")

	t0 := time.Now()
	resp, err := client.Do(req)
	duration := time.Since(t0).Milliseconds()

	if err != nil {
		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"ok":          false,
			"target":      target,
			"proxy":       proxyRaw,
			"duration_ms": duration,
			"error":       err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"ok":          resp.StatusCode >= 200 && resp.StatusCode < 400,
		"status":      resp.StatusCode,
		"target":      target,
		"proxy":       proxyRaw,
		"duration_ms": duration,
		"body":        string(bodyBytes),
	})
}

func (g *Gateway) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"authenticated": true,
		"role":          "admin",
		"requireLogin":  false,
		"displayName":   "Admin (Go Core)",
		"homePath":      "/dashboard",
	})
}

func (g *Gateway) handleAdapterCoverage(w http.ResponseWriter, r *http.Request) {
	cov := providers.BuildCoverage(g.registry)
	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"engine":              "golang",
		"ported":              cov.Ported,
		"ported_count":        len(cov.Ported),
		"generic":             cov.Generic,
		"generic_count":       len(cov.Generic),
		"node_executor_total": cov.NodeExecutorTotal,
		"fallback":            cov.Fallback,
		"note":                "unported providers still route through the fallback adapter",
	})
}

func (g *Gateway) handleModels(w http.ResponseWriter, r *http.Request) {
	models := []map[string]interface{}{
		{"id": "oc/glm-5.3-flash-free", "object": "model", "owned_by": "opencode"},
		{"id": "oc/deepseek-v4.1-flash-free", "object": "model", "owned_by": "opencode"},
		{"id": "ag/gemini-3.8-flash-high", "object": "model", "owned_by": "antigravity"},
		{"id": "gemini-web/gemini-2.5-flash", "object": "model", "owned_by": "gemini-web"},
		{"id": "gemini-web/gemini-2.5-pro", "object": "model", "owned_by": "gemini-web"},
		{"id": "ovh/Qwen3.6-27B", "object": "model", "owned_by": "ovh"},
		{"id": "ovh/gpt-oss-120b", "object": "model", "owned_by": "ovh"},
		{"id": "cbai/deepseek-v4.1-flash", "object": "model", "owned_by": "codebuddy"},
		{"id": "cbcn/hy4", "object": "model", "owned_by": "codebuddy"},
		{"id": "cbcn/hy4-preview", "object": "model", "owned_by": "codebuddy"},
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"object": "list",
		"data":   models,
	})
}

// handleChatCompletions is the real routing path.
//
// It parses "provider/model", resolves the credential for that provider from the
// live database, asks the registry for the adapter, and streams the upstream
// response back verbatim. Before this existed the handler returned a canned JSON
// document, which is why the registry could be wired up and still do nothing.
//
// Failure modes are explicit on purpose: an unknown model, a provider with no
// active connection, and an upstream error all produce a diagnostic body rather
// than a fabricated success.
func (g *Gateway) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "could not read request body", err)
		return
	}

	req, parseErr := parseChatRequest(body)
	if parseErr != nil {
		jsonError(w, http.StatusBadRequest, "invalid chat request", parseErr)
		return
	}

	providerName, modelID, ok := splitProviderModel(req.Model)
	if !ok {
		jsonError(w, http.StatusBadRequest,
			fmt.Sprintf("model %q is not in provider/model form", req.Model), nil)
		return
	}
	req.Provider = providerName
	req.Model = modelID

	adapter, explicit := g.registry.Resolve(providerName)

	// Which connection serves this provider? Read-only; the Go core does not
	// write to the shared database.
	conn, connErr := g.db.FindActiveConnection(providerName)
	if connErr != nil || conn == nil {
		jsonResponse(w, http.StatusServiceUnavailable, map[string]interface{}{
			"error":    "no active connection for provider",
			"provider": providerName,
			"adapter":  adapter.Name(),
			"ported":   explicit,
			"detail":   errString(connErr),
		})
		return
	}

	cred := providers.CredentialFromConnection(providers.CredentialFromDB{
		ProviderID: conn.Provider,
		APIKey:     conn.APIKey,
		Token:      conn.Token,
		BaseURL:    conn.BaseURL,
		AccountID:  conn.AccountID,
		UserID:     conn.UserID,
		Email:      conn.Email,
		AgentID:    conn.AgentID,
		SessionID:  conn.ConnectionID,
		Region:     conn.Region,
		Extra:      conn.Extra,
	}, r.Header)

	// Translate the request into the provider's dialect before it goes upstream.
	//
	// The client's dialect is detected from the message shape, the provider's from
	// its registry format. When they match, the body passes through untouched —
	// the translator is not allowed to reshape a body that is already correct.
	sourceFormat, targetFormat := g.detectFormats(r, req.Body, providerName)
	translateOpts := translate.PipelineOptions{
		Source:   sourceFormat,
		Target:   targetFormat,
		Model:    req.Model,
		Stream:   req.Stream,
		Provider: providerName,
	}

	var upstreamBody []byte = req.Body
	if sourceFormat != targetFormat {
		var parsed map[string]any
		if err := json.Unmarshal(req.Body, &parsed); err != nil {
			jsonError(w, http.StatusBadRequest, "request body is not a JSON object", err)
			return
		}
		translated, tErr := translate.TranslateRequest(g.translators, parsed, translateOpts)
		if tErr != nil {
			jsonError(w, http.StatusBadRequest,
				fmt.Sprintf("could not translate %s request to %s", sourceFormat, targetFormat), tErr)
			return
		}
		upstreamBody, err = json.Marshal(translated)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "could not serialise translated request", err)
			return
		}
	}
	req.Body = upstreamBody

	proxied, err := g.upstream.Do(r.Context(), adapter, req, cred)
	if err != nil {
		jsonError(w, http.StatusBadGateway,
			fmt.Sprintf("upstream call failed via %s adapter", adapter.Name()), err)
		return
	}
	defer proxied.Body.Close()

	// Stream the upstream response through. When dialects differ the frames are
	// converted on the way out; when they match the stream is a straight conduit.
	copyUpstreamHeaders(w.Header(), proxied.Header)

	if sourceFormat == targetFormat || !req.Stream {
		w.WriteHeader(proxied.StatusCode)
		io.Copy(w, proxied.Body)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(proxied.StatusCode)
	streamTranslated(w, proxied.Body, translateOpts)
}

// detectFormats picks the client and provider dialects for a request.
//
// The client side prefers the endpoint (a Claude client always posts to
// /v1/messages) and falls back to sniffing the body shape. The provider side reads
// the registry's declared format. An unported provider defaults to the OpenAI
// dialect, which is what the generic fallback adapter speaks.
func (g *Gateway) detectFormats(r *http.Request, body []byte, providerName string) (translate.Format, translate.Format) {
	target := translate.FormatOpenAI
	if adapter, ok := g.registry.Resolve(providerName); ok {
		target = providers.RegistryFormat(adapter)
	}

	var parsed map[string]any
	json.Unmarshal(body, &parsed)

	source := translate.DetectFormatByEndpoint(r.URL.Path, parsed)
	if source == "" {
		source = sniffRequestBody(parsed)
	}
	return source, target
}

// sniffRequestBody infers the client dialect from field shape.
//
// A `system` array and block-shaped `content` is the Claude Messages API. An
// `input` array is the Responses API. Everything else is chat completions.
func sniffRequestBody(body map[string]any) translate.Format {
	if body == nil {
		return translate.FormatOpenAI
	}
	if _, ok := body["input"].([]any); ok {
		return translate.FormatOpenAIResponses
	}
	if _, ok := body["system"].([]any); ok {
		return translate.FormatClaude
	}
	for _, raw := range asSlice(body["messages"]) {
		msg, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if _, isSlice := msg["content"].([]any); isSlice {
			return translate.FormatClaude
		}
	}
	return translate.FormatOpenAI
}

// streamTranslated reads the upstream SSE stream and writes converted frames.
//
// A frame that converts to nothing is dropped rather than forwarded as an empty
// event, because a bare `event:` line desynchronises strict SSE clients. The
// converter state lives for the whole stream so per-turn state (message id,
// accumulated usage, open blocks) survives across frames.
func streamTranslated(w http.ResponseWriter, body io.Reader, opts translate.PipelineOptions) {
	flusher, _ := w.(http.Flusher)
	state := translate.NewStreamState()
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)

	var eventLines []string

	for scanner.Scan() {
		line := scanner.Text()

		// A blank line terminates one SSE frame.
		if line == "" {
			if len(eventLines) == 0 {
				continue
			}
			emitTranslatedFrame(w, flusher, eventLines, state, opts)
			eventLines = eventLines[:0]
			continue
		}
		eventLines = append(eventLines, line)
	}

	if len(eventLines) > 0 {
		emitTranslatedFrame(w, flusher, eventLines, state, opts)
	}
}

// emitTranslatedFrame converts the data payload of one SSE frame and writes it out.
func emitTranslatedFrame(w http.ResponseWriter, flusher http.Flusher, lines []string, state *translate.StreamState, opts translate.PipelineOptions) {
	var dataParts []string
	eventName := ""

	for _, line := range lines {
		if strings.HasPrefix(line, "data:") {
			dataParts = append(dataParts, strings.TrimSpace(line[len("data:"):]))
		} else if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(line[len("event:"):])
		}
	}

	if len(dataParts) == 0 {
		// A frame with no data carries nothing translatable; forward only its
		// event name so a bare comment or keepalive is not silently swallowed.
		if eventName != "" {
			fmt.Fprintf(w, "event: %s\n\n", eventName)
			if flusher != nil {
				flusher.Flush()
			}
		}
		return
	}

	payload := strings.Join(dataParts, "\n")
	if payload == "[DONE]" {
		fmt.Fprint(w, "data: [DONE]\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		return
	}

	var chunk map[string]any
	if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
		// Not JSON: relay the frame untouched rather than dropping provider data.
		writeRawFrame(w, flusher, eventName, payload)
		return
	}

	converted, err := translate.TranslateResponse(nil, chunk, state, opts)
	if err != nil || len(converted) == 0 {
		// A converted-to-nothing frame is intentionally dropped: emitting an
		// empty event desynchronises strict SSE clients.
		return
	}

	for _, frame := range converted {
		out, mErr := json.Marshal(frame)
		if mErr != nil {
			continue
		}
		// The converted frame names its own event; the upstream event name would
		// be wrong for the client dialect and is not forwarded.
		if name, ok := frame["type"].(string); ok && name != "" {
			fmt.Fprintf(w, "event: %s\n", name)
		}
		fmt.Fprintf(w, "data: %s\n\n", out)
	}
	if flusher != nil {
		flusher.Flush()
	}
}

func writeRawFrame(w http.ResponseWriter, flusher http.Flusher, eventName, payload string) {
	if eventName != "" {
		fmt.Fprintf(w, "event: %s\n", eventName)
	}
	fmt.Fprintf(w, "data: %s\n\n", payload)
	if flusher != nil {
		flusher.Flush()
	}
}

// asSlice is a local type assertion helper for the sniffing path.
func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

// maxRequestBody bounds how much of a chat request is read into memory.
const maxRequestBody = 32 << 20 // 32 MB

// parseChatRequest reads the fields the router needs without losing the body.
func parseChatRequest(body []byte) (providers.Request, error) {
	var raw map[string]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return providers.Request{}, err
	}
	stream, _ := raw["stream"].(bool)
	model, _ := raw["model"].(string)
	return providers.Request{
		Model:  model,
		Stream: stream,
		Body:   body,
	}, nil
}

// splitProviderModel splits "oc/gemini-3.8-flash" into its provider and model
// halves. A model id may itself contain slashes, so only the first separator
// counts.
func splitProviderModel(full string) (provider, model string, ok bool) {
	idx := strings.Index(full, "/")
	if idx <= 0 || idx == len(full)-1 {
		return "", "", false
	}
	return full[:idx], full[idx+1:], true
}

// copyUpstreamHeaders forwards the response headers, dropping hop-by-hop entries
// that must not be relayed.
func copyUpstreamHeaders(dst, src http.Header) {
	for k, vs := range src {
		if hopByHopHeader[k] {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

// hopByHopHeader lists the connection-scoped headers RFC 7230 says a proxy must
// not forward.
var hopByHopHeader = map[string]bool{
	"Connection":          true,
	"Proxy-Connection":    true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
}

// jsonError writes a diagnostic document. err may be nil when the cause is a
// malformed client value rather than a failure.
func jsonError(w http.ResponseWriter, status int, msg string, err error) {
	jsonResponse(w, status, map[string]interface{}{
		"error":  msg,
		"detail": errString(err),
	})
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (g *Gateway) handleGetConnection(w http.ResponseWriter, r *http.Request) {
	cfg, err := g.db.GetTelegramConfig()
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"error": err.Error()})
		return
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"telegram": cfg,
			"system": map[string]interface{}{
				"version":       g.cfg.Version,
				"engine":        "golang",
				"publicBaseUrl": g.cfg.PublicBaseUrl,
			},
		},
	})
}

func (g *Gateway) handlePostConnection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action   string `json:"action"`
		BotToken string `json:"botToken"`
		UserID   string `json:"userId"`
		Enabled  bool   `json:"enabled"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"error": "invalid payload"})
		return
	}

	if body.Action == "test" {
		info, err := connection.TestBotToken(body.BotToken)
		if err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]interface{}{
				"success": false,
				"error":   err.Error(),
			})
			return
		}

		jsonResponse(w, http.StatusOK, map[string]interface{}{
			"success": true,
			"botInfo": info,
		})
		return
	}

	cfg := &database.TelegramConfig{
		Enabled:  body.Enabled,
		BotToken: body.BotToken,
		UserID:   body.UserID,
		Status:   "connected",
	}

	if err := g.db.SetTelegramConfig(cfg); err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"error": err.Error()})
		return
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"data":    cfg,
	})
}

func (g *Gateway) handleTelegramCommand(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Command string `json:"command"`
		UserId  string `json:"userId"`
		Token   string `json:"token"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	text, err := connection.HandleCommand(body.Command, body.UserId, body.Token, g.db)
	if err != nil {
		jsonResponse(w, http.StatusUnauthorized, map[string]interface{}{"error": err.Error()})
		return
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"text":    text,
	})
}

func (g *Gateway) handleTelegramWebhook(w http.ResponseWriter, r *http.Request) {
	connection.HandleWebhook(w, r, g.db)
}

func (g *Gateway) handleGetTeams(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, http.StatusOK, []map[string]interface{}{})
}

func (g *Gateway) handleCreateTeam(w http.ResponseWriter, r *http.Request) {
	var body map[string]interface{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body == nil {
		body = make(map[string]interface{})
	}
	body["id"] = fmt.Sprintf("team_%d", time.Now().Unix())
	body["enabled"] = true
	body["createdAt"] = time.Now().Format(time.RFC3339)
	body["updatedAt"] = time.Now().Format(time.RFC3339)
	jsonResponse(w, http.StatusOK, body)
}

func (g *Gateway) handleUpdateTeam(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	jsonResponse(w, http.StatusOK, map[string]interface{}{"id": id, "updated": true})
}

func (g *Gateway) handleDeleteTeam(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	jsonResponse(w, http.StatusOK, map[string]interface{}{"id": id, "deleted": true})
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mux.ServeHTTP(w, r)
}

func (g *Gateway) Start() error {
	addr := ":" + g.cfg.Port
	return http.ListenAndServe(addr, g.mux)
}

func jsonResponse(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
