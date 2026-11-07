package gateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/johsua092-ui/xrouter/internal/config"
	"github.com/johsua092-ui/xrouter/internal/connection"
	"github.com/johsua092-ui/xrouter/internal/database"
)

type Gateway struct {
	cfg *config.Config
	db  *database.DB
	mux *chi.Mux
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

	g := &Gateway{
		cfg: cfg,
		db:  db,
		mux: mux,
	}

	g.registerRoutes()
	return g
}

func (g *Gateway) registerRoutes() {
	// Health & System
	g.mux.Get("/api/health", g.handleHealth)
	g.mux.Get("/api/auth/status", g.handleAuthStatus)

	// AI Gateway V1 Endpoints
	g.mux.Route("/v1", func(r chi.Router) {
		r.Get("/models", g.handleModels)
		r.Post("/chat/completions", g.handleChatCompletions)
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
}

func (g *Gateway) handleHealth(w http.ResponseWriter, r *http.Request) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	allocMb := float64(mem.Alloc) / (1024 * 1024)

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"ok":        true,
		"engine":    "golang",
		"version":   g.cfg.Version,
		"port":      g.cfg.Port,
		"memory_mb": fmt.Sprintf("%.2f MB", allocMb),
	})
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

func (g *Gateway) handleModels(w http.ResponseWriter, r *http.Request) {
	models := []map[string]interface{}{
		{"id": "oc/glm-5.3-flash-free", "object": "model", "owned_by": "opencode"},
		{"id": "oc/deepseek-v4.1-flash-free", "object": "model", "owned_by": "opencode"},
		{"id": "ag/gemini-3.8-flash-high", "object": "model", "owned_by": "antigravity"},
		{"id": "cbai/deepseek-v4.1-flash", "object": "model", "owned_by": "codebuddy"},
		{"id": "cbcn/hy4", "object": "model", "owned_by": "codebuddy"},
		{"id": "cbcn/hy4-preview", "object": "model", "owned_by": "codebuddy"},
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"object": "list",
		"data":   models,
	})
}

func (g *Gateway) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	// Standard response placeholder for non-streaming or simple proxy
	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"id":      "chatcmpl-" + fmt.Sprintf("%d", time.Now().UnixNano()),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   "xrouter-go",
		"choices": []map[string]interface{}{
			{
				"index": 0,
				"message": map[string]interface{}{
					"role":    "assistant",
					"content": "X Router Golang Engine ready.",
				},
				"finish_reason": "stop",
			},
		},
	})
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
