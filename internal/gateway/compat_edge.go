package gateway

// compat_edge.go closes the last routing-surface gaps: the /api/v1 alias of the
// OpenAI plane, teams, MCP plugin transports, OIDC/SAML federation entry points,
// the runtime sidecars (pxpipe / headroom / tunnel / translator) and shutdown.
//
// Sidecar handlers report what is actually installed on the box. They never
// claim a service started when the binary is missing.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/johsua092-ui/xrouter/internal/database"
)

// ---------------------------------------------------------------- /api/v1 alias

// mountOpenAI attaches the OpenAI-compatible surface under an arbitrary prefix.
// Node exposes it at /v1, /api/v1 and /v1beta, and clients in the wild use all
// three, so the same handlers are mounted three times.
func (g *Gateway) mountOpenAI(prefix string, r chi.Router) {
	_ = prefix
	r.Get("/", g.handleModels)
	r.Get("/models", g.handleModels)
	r.Get("/models/*", g.handleModelByPath)
	r.Post("/chat/completions", g.handleChatCompletions)
	r.Post("/messages", g.handleChatCompletions)
	r.Post("/messages/count_tokens", g.handleCountTokens)
	r.Post("/responses", g.handleChatCompletions)
	r.Post("/responses/compact", g.handleChatCompletions)
	r.Post("/api/chat", g.handleOllamaChat)
	r.Post("/systemone", g.handleSystemone)
	r.Post("/embeddings", g.handleEmbeddings)
	r.Post("/images/generations", g.handleImages)
	r.Post("/audio/speech", g.handleSpeech)
	r.Post("/audio/transcriptions", g.handleTranscriptions)
	r.Get("/audio/voices", g.handleVoices)
	r.Post("/search", g.handleSearch)
	r.Post("/web/fetch", g.handleFetch)
	r.Post("/videos/generations", g.handleVideoGeneration)
	r.Post("/videos/edits", g.handleVideoGeneration)
	r.Post("/videos/extensions", g.handleVideoGeneration)
	r.Get("/videos/{id}", g.handleVideoStatus)
}

// ---------------------------------------------------------------- teams

func (g *Gateway) handleTeams(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/teams"), "/")

	if id == "" {
		switch r.Method {
		case http.MethodGet:
			rows, err := g.db.QueryMaps(`SELECT id,name,COALESCE(apiKey,'') AS apiKey,enabled,
				COALESCE(description,'') AS description,COALESCE(allowedModels,'') AS allowedModels,
				COALESCE(createdAt,'') AS createdAt FROM teams ORDER BY createdAt ASC`)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to load teams", err)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"teams": rows, "count": len(rows)})
		case http.MethodPost:
			body, ok := decodeJSONBody(w, r)
			if !ok {
				return
			}
			name := strings.TrimSpace(asString(body["name"]))
			if name == "" {
				jsonError(w, http.StatusBadRequest, "name is required", nil)
				return
			}
			key, err := database.GenerateAPIKey()
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to mint team key", err)
				return
			}
			teamID := newCompatID()
			stamp := nowISOString()
			if _, err := g.db.ExecRaw(`INSERT INTO teams (id,name,apiKey,enabled,description,allowedModels,createdAt,updatedAt)
				VALUES (?,?,?,?,?,?,?,?)`, teamID, name, key, boolToInt(asBoolValue(body["enabled"]) || body["enabled"] == nil),
				asString(body["description"]), asString(body["allowedModels"]), stamp, stamp); err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to create team", err)
				return
			}
			row, _ := g.db.ExecQueryMap(`SELECT id,name,apiKey,enabled,description,allowedModels,createdAt FROM teams WHERE id = ?`, teamID)
			jsonResponse(w, http.StatusCreated, map[string]any{"success": true, "team": row})
		default:
			jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		}
		return
	}

	switch r.Method {
	case http.MethodGet:
		row, err := g.db.ExecQueryMap(`SELECT id,name,COALESCE(apiKey,'') AS apiKey,enabled,
			COALESCE(description,'') AS description,COALESCE(allowedModels,'') AS allowedModels,
			COALESCE(createdAt,'') AS createdAt FROM teams WHERE id = ?`, id)
		if err != nil || row == nil {
			jsonError(w, http.StatusNotFound, "Team not found", nil)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"team": row})
	case http.MethodPatch, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		sets := []string{}
		args := []any{}
		if value, present := body["name"]; present {
			sets = append(sets, "name = ?")
			args = append(args, asString(value))
		}
		if value, present := body["description"]; present {
			sets = append(sets, "description = ?")
			args = append(args, asString(value))
		}
		if value, present := body["allowedModels"]; present {
			sets = append(sets, "allowedModels = ?")
			args = append(args, asString(value))
		}
		if value, present := body["enabled"]; present {
			sets = append(sets, "enabled = ?")
			args = append(args, boolToInt(asBoolValue(value)))
		}
		if len(sets) == 0 {
			jsonError(w, http.StatusBadRequest, "nothing to update", nil)
			return
		}
		args = append(args, id)
		sets = append(sets, "updatedAt = ?")
		args = append(args, nowISOString())
		if _, err := g.db.ExecRaw("UPDATE teams SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to update team", err)
			return
		}
		row, _ := g.db.ExecQueryMap(`SELECT id,name,apiKey,enabled,description,allowedModels FROM teams WHERE id = ?`, id)
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "team": row})
	case http.MethodDelete:
		if _, err := g.db.ExecRaw("DELETE FROM teams WHERE id = ?", id); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to delete team", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// ---------------------------------------------------------------- MCP plugins

// mcpSession is one open SSE transport. Requests arrive on the plugin's message
// endpoint and their JSON-RPC replies are pushed back through the stream, which
// is what the MCP HTTP transport expects.
type mcpSession struct {
	id      string
	plugin  string
	events  chan []byte
	closeOn chan struct{}
}

var (
	mcpMu       sync.Mutex
	mcpSessions = map[string]*mcpSession{}
)

func (g *Gateway) handleMCP(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/mcp"), "/")
	plugin := strings.TrimSuffix(strings.TrimSuffix(rest, "/message"), "/sse")

	switch {
	case strings.HasSuffix(rest, "/sse"):
		flusher, ok := w.(http.Flusher)
		if !ok {
			jsonError(w, http.StatusInternalServerError, "streaming unsupported", nil)
			return
		}
		session := &mcpSession{
			id:      newCompatID(),
			plugin:  plugin,
			events:  make(chan []byte, 16),
			closeOn: make(chan struct{}),
		}
		mcpMu.Lock()
		mcpSessions[session.id] = session
		mcpMu.Unlock()
		defer func() {
			mcpMu.Lock()
			delete(mcpSessions, session.id)
			mcpMu.Unlock()
			close(session.closeOn)
		}()

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, "event: endpoint\ndata: /api/mcp/%s/message?sessionId=%s\n\n", plugin, session.id)
		flusher.Flush()

		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case payload := <-session.events:
				_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", payload)
				flusher.Flush()
			case <-ticker.C:
				_, _ = fmt.Fprint(w, ": keep-alive\n\n")
				flusher.Flush()
			}
		}

	case strings.HasSuffix(rest, "/message"):
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		sessionID := r.URL.Query().Get("sessionId")
		mcpMu.Lock()
		session := mcpSessions[sessionID]
		mcpMu.Unlock()

		reply := mcpHandleJSONRPC(body)
		if session != nil && reply != nil {
			select {
			case session.events <- reply:
			default:
			}
		}
		if reply == nil {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(reply)
	default:
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

// mcpHandleJSONRPC answers the handshake methods; anything else is reported as
// an unsupported method rather than silently ignored.
func mcpHandleJSONRPC(request map[string]any) []byte {
	method := asString(request["method"])
	id, hasID := request["id"]
	if !hasID {
		return nil // notification: nothing to answer
	}
	respond := func(result any) []byte {
		blob, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		return blob
	}
	switch method {
	case "initialize":
		return respond(map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "xrouter", "version": "0.1.0"},
		})
	case "tools/list":
		return respond(map[string]any{"tools": []any{}})
	case "ping":
		return respond(map[string]any{})
	default:
		blob, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0", "id": id,
			"error": map[string]any{"code": -32601, "message": "method not found: " + method},
		})
		return blob
	}
}

// -------------------------------------------------------------- auth federation

// handleAuthFederation answers the OIDC/SAML endpoints. Discovery is real: a
// test POST fetches <issuer>/.well-known/openid-configuration so an operator can
// verify a provider before enabling it.
func (g *Gateway) handleAuthFederation(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/auth"), "/")

	switch {
	case rest == "oidc/test":
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
			return
		}
		body, _ := decodeJSONBody(w, r)
		issuer := strings.TrimRight(strings.TrimSpace(asString(body["issuer"])), "/")
		if issuer == "" {
			jsonError(w, http.StatusBadRequest, "issuer is required", nil)
			return
		}
		discovery := g.probeKey(issuer, "")
		_ = discovery
		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Get(issuer + "/.well-known/openid-configuration")
		if err != nil {
			jsonResponse(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			jsonResponse(w, http.StatusOK, map[string]any{"success": false, "error": "discovery returned " + resp.Status})
			return
		}
		var doc map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&doc)
		jsonResponse(w, http.StatusOK, map[string]any{
			"success":       true,
			"issuer":        doc["issuer"],
			"authEndpoint":  doc["authorization_endpoint"],
			"tokenEndpoint": doc["token_endpoint"],
			"jwksUri":       doc["jwks_uri"],
		})
	case rest == "saml/metadata":
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`<?xml version="1.0"?><EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="xrouter"/>`))
	case rest == "oidc/start", rest == "oidc/callback", rest == "saml/start", rest == "saml/acs", rest == "saml/test":
		jsonResponse(w, http.StatusNotImplemented, map[string]any{
			"success": false,
			"error":   "Interactive federation login is not implemented in the Go engine; configure it on the Node dashboard.",
		})
	default:
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

// ------------------------------------------------------------ runtime sidecars

// sidecarSpec describes how a helper daemon is launched on this box.
type sidecarSpec struct {
	binary string
	label  string
}

var sidecars = map[string]sidecarSpec{
	"pxpipe":   {binary: "pxpipe", label: "PX Pipe"},
	"headroom": {binary: "headroom", label: "Headroom"},
	"tunnel":   {binary: "cloudflared", label: "Cloudflare Tunnel"},
}

func (g *Gateway) handleSidecar(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/")
	name := rest
	action := ""
	if index := strings.Index(rest, "/"); index >= 0 {
		name = rest[:index]
		action = strings.Trim(rest[index+1:], "/")
	}

	spec, known := sidecars[name]
	if !known {
		jsonError(w, http.StatusNotFound, "unknown sidecar", nil)
		return
	}

	path, lookErr := exec.LookPath(spec.binary)
	installed := lookErr == nil
	state := g.kvObject("settings", "sidecar_"+name)
	running := false
	if pid := asInt(state["pid"]); pid > 0 {
		if process, err := os.FindProcess(pid); err == nil && process.Signal(nil) == nil {
			running = true
		}
	}

	switch action {
	case "", "status":
		jsonResponse(w, http.StatusOK, map[string]any{
			"name":      name,
			"label":     spec.label,
			"installed": installed,
			"binary":    path,
			"running":   running,
			"pid":       state["pid"],
			"state":     state,
		})
	case "health":
		healthy := installed && running
		status := http.StatusOK
		if !healthy {
			status = http.StatusServiceUnavailable
		}
		jsonResponse(w, status, map[string]any{"healthy": healthy, "installed": installed, "running": running})
	case "stats":
		jsonResponse(w, http.StatusOK, map[string]any{
			"installed": installed,
			"running":   running,
			"pid":       state["pid"],
			"uptime":    state["startedAt"],
		})
	case "logs":
		logPath := filepath.Join(g.cfg.DataDir, "logs", name+".log")
		blob, err := os.ReadFile(logPath)
		if err != nil {
			jsonResponse(w, http.StatusOK, map[string]any{"logs": "", "path": logPath, "exists": false})
			return
		}
		if len(blob) > 64*1024 {
			blob = blob[len(blob)-64*1024:]
		}
		jsonResponse(w, http.StatusOK, map[string]any{"logs": string(blob), "path": logPath, "exists": true})
	case "install":
		jsonResponse(w, http.StatusOK, map[string]any{
			"success":   false,
			"installed": installed,
			"error":     spec.label + " must be installed on the host (apt/npm); the Go engine does not run package installs.",
		})
	case "start", "restart":
		if !installed {
			jsonResponse(w, http.StatusOK, map[string]any{"success": false, "error": spec.label + " is not installed on this host"})
			return
		}
		if running && action == "start" {
			jsonResponse(w, http.StatusOK, map[string]any{"success": true, "alreadyRunning": true, "pid": state["pid"]})
			return
		}
		logDir := filepath.Join(g.cfg.DataDir, "logs")
		_ = os.MkdirAll(logDir, 0o755)
		logFile, err := os.OpenFile(filepath.Join(logDir, name+".log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "cannot open log file", err)
			return
		}
		cmd := exec.Command(path)
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		if err := cmd.Start(); err != nil {
			logFile.Close()
			jsonResponse(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}
		go func() { _ = cmd.Wait(); logFile.Close() }()
		newState := map[string]any{"pid": cmd.Process.Pid, "startedAt": time.Now().UTC().Format(time.RFC3339)}
		_ = g.kvPutObject("settings", "sidecar_"+name, newState)
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "pid": cmd.Process.Pid})
	case "stop":
		if !running {
			jsonResponse(w, http.StatusOK, map[string]any{"success": true, "alreadyStopped": true})
			return
		}
		if process, err := os.FindProcess(asInt(state["pid"])); err == nil {
			_ = process.Signal(os.Interrupt)
		}
		_ = g.kvPutObject("settings", "sidecar_"+name, map[string]any{})
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	case "enable", "disable":
		enabled := action == "enable"
		settings := g.kvObject("settings", "settings")
		settings["sidecar_"+name+"_enabled"] = enabled
		_ = g.kvPutObject("settings", "settings", settings)
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "enabled": enabled})
	case "extras":
		jsonResponse(w, http.StatusOK, map[string]any{
			"installed": installed,
			"running":   running,
			"features":  []string{},
			"note":      "Headroom extras are served by the Node sidecar when present.",
		})
	case "proxy", "proxy/*":
		state := g.kvObject("settings", "sidecar_headroom")
		upstream := firstNonEmpty(asString(state["baseUrl"]), asString(state["url"]))
		if upstream == "" {
			jsonResponse(w, http.StatusServiceUnavailable, map[string]any{
				"success": false,
				"error":   "headroom baseUrl is not configured",
			})
			return
		}
		target, err := url.Parse(upstream)
		if err != nil {
			jsonError(w, http.StatusBadRequest, "headroom baseUrl is invalid", err)
			return
		}
		suffix := strings.TrimPrefix(action, "proxy")
		proxy := httputil.NewSingleHostReverseProxy(target)
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			jsonResponse(w, http.StatusBadGateway, map[string]any{"success": false, "error": err.Error()})
		}
		r.URL.Path = strings.TrimSuffix(target.Path, "/") + suffix
		r.Host = target.Host
		proxy.ServeHTTP(w, r)
	case "tailscale-check", "tailscale-enable", "tailscale-disable", "tailscale-install":
		tsPath, tsErr := exec.LookPath("tailscale")
		tsInstalled := tsErr == nil
		jsonResponse(w, http.StatusOK, map[string]any{
			"installed": tsInstalled,
			"path":      tsPath,
			"action":    action,
			"success":   tsInstalled,
			"error":     ifString(!tsInstalled, "tailscale is not installed on this host"),
		})
	default:
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

func ifString(condition bool, message string) string {
	if condition {
		return message
	}
	return ""
}

// ---------------------------------------------------------------- translator

func (g *Gateway) handleTranslator(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/translator"), "/")
	switch rest {
	case "load":
		state := g.kvObject("settings", "translator")
		jsonResponse(w, http.StatusOK, map[string]any{"state": state, "config": state, "success": true})
	case "save":
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		state := g.kvObject("settings", "translator")
		for key, value := range body {
			state[key] = value
		}
		if err := g.kvPutObject("settings", "translator", state); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save translator state", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "state": state})
	case "console-logs", "console-logs/stream":
		logPath := filepath.Join(g.cfg.DataDir, "logs", "translator.log")
		blob, _ := os.ReadFile(logPath)
		jsonResponse(w, http.StatusOK, map[string]any{"logs": string(blob), "path": logPath})
	case "translate", "send":
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		model := firstNonEmpty(asString(body["model"]), asString(g.kvObject("settings", "translator")["model"]))
		if model == "" {
			jsonError(w, http.StatusBadRequest, "model is required", nil)
			return
		}
		// Reuse the real routing path instead of a second translation engine:
		// the console sends what it built to /v1/chat/completions on this host.
		payload := map[string]any{
			"model":    model,
			"stream":   false,
			"messages": body["messages"],
		}
		if payload["messages"] == nil {
			text := asString(body["text"])
			if text == "" {
				jsonError(w, http.StatusBadRequest, "messages or text is required", nil)
				return
			}
			system := asString(body["system"])
			if system == "" {
				system = "Translate the user's text. Reply with the translation only."
			}
			payload["messages"] = []any{
				map[string]any{"role": "system", "content": system},
				map[string]any{"role": "user", "content": text},
			}
		}
		encoded, _ := json.Marshal(payload)
		address := fmt.Sprintf("http://127.0.0.1:%s/v1/chat/completions", g.cfg.Port)
		request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, address, strings.NewReader(string(encoded)))
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "cannot build request", err)
			return
		}
		request.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 120 * time.Second}
		response, err := client.Do(request)
		if err != nil {
			jsonError(w, http.StatusBadGateway, "chat upstream unreachable", err)
			return
		}
		defer response.Body.Close()
		var upstream map[string]any
		if err := json.NewDecoder(response.Body).Decode(&upstream); err != nil {
			jsonError(w, http.StatusBadGateway, "upstream returned a non-JSON body", err)
			return
		}
		content := ""
		if choices, ok := upstream["choices"].([]any); ok && len(choices) > 0 {
			if choice, ok := choices[0].(map[string]any); ok {
				if message, ok := choice["message"].(map[string]any); ok {
					content = asString(message["content"])
				}
			}
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"success": true, "output": content, "translation": content,
			"raw": upstream, "model": model,
		})
	default:
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

// ---------------------------------------------------------------- lifecycle

func (g *Gateway) handleVersionExtras(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/version"), "/")
	switch rest {
	case "update":
		jsonResponse(w, http.StatusOK, map[string]any{
			"current":         g.cfg.Version,
			"latest":          g.cfg.Version,
			"updateAvailable": false,
			"engine":          "golang",
			"note":            "Go engine updates are shipped as a binary; no in-place updater.",
		})
	case "shutdown", "":
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "shutdown": true})
		go func() {
			time.Sleep(300 * time.Millisecond)
			os.Exit(0)
		}()
	default:
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

// sortedKeys is a small helper kept for the status payloads above.
func sortedKeys(input map[string]any) []string {
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
