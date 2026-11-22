package gateway

// compat_system.go covers the dashboard singletons and side panels that the Go
// engine did not expose yet: theme/locale, plugin + pricing settings, prompt
// injection rules, the model studio, latency + cache telemetry, IP bans, the
// dashboard job runner, notification scanning and the media voice catalogues.
//
// Everything that already lives in SQLite is read from SQLite. Only genuinely
// ephemeral state (job handles, latency counters) stays in memory.

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ------------------------------------------------------------------- theme

func (g *Gateway) handleTheme(w http.ResponseWriter, r *http.Request) {
	theme := g.kvObject("settings", "theme")
	if theme == nil || len(theme) == 0 {
		theme = map[string]any{"theme": "dark", "accent": "orange", "customColor": ""}
	}
	switch r.Method {
	case http.MethodGet:
		payload := map[string]any{"ok": true}
		for key, value := range theme {
			payload[key] = value
		}
		jsonResponse(w, http.StatusOK, payload)
	case http.MethodPost, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		for _, field := range []string{"theme", "accent", "customColor"} {
			if value, present := body[field]; present {
				theme[field] = value
			}
		}
		if err := g.kvPutObject("settings", "theme", theme); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save theme", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"ok":          true,
			"theme":       theme["theme"],
			"accent":      theme["accent"],
			"customColor": theme["customColor"],
		})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// ------------------------------------------------------------------ locale

func (g *Gateway) handleLocale(w http.ResponseWriter, r *http.Request) {
	const cookieName = "locale"
	if r.Method == http.MethodGet {
		locale := ""
		if cookie, err := r.Cookie(cookieName); err == nil {
			locale = cookie.Value
		}
		if locale == "" {
			locale = asString(g.kvObject("settings", "locale")["locale"])
		}
		if locale == "" {
			locale = "en"
		}
		jsonResponse(w, http.StatusOK, map[string]any{"locale": locale, "success": true})
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	locale := strings.TrimSpace(asString(body["locale"]))
	if locale == "" {
		jsonError(w, http.StatusBadRequest, "locale is required", nil)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    locale,
		Path:     "/",
		MaxAge:   365 * 24 * 60 * 60,
		SameSite: http.SameSiteLaxMode,
	})
	jsonResponse(w, http.StatusOK, map[string]any{"success": true, "locale": locale})
}

// -------------------------------------------------------------------- tags

func (g *Gateway) handleTags(w http.ResponseWriter, r *http.Request) {
	custom := g.kvList("settings", "customTags")
	seen := map[string]bool{}
	tags := make([]map[string]any, 0, len(custom)+16)
	for _, item := range custom {
		name := asString(item["name"])
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		tags = append(tags, item)
	}
	for _, m := range g.catalog.Models("ollama") {
		if seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		tags = append(tags, map[string]any{"name": m.ID, "custom": false})
	}

	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, http.StatusOK, map[string]any{"tags": tags, "models": tags})
	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		name := strings.TrimSpace(firstNonEmpty(asString(body["name"]), asString(body["tag"])))
		if name == "" {
			jsonError(w, http.StatusBadRequest, "name is required", nil)
			return
		}
		for _, item := range custom {
			if asString(item["name"]) == name {
				jsonResponse(w, http.StatusOK, map[string]any{"success": true, "tag": item})
				return
			}
		}
		entry := map[string]any{"name": name, "custom": true, "createdAt": time.Now().UTC().Format(time.RFC3339)}
		custom = append(custom, entry)
		if err := g.kvPutList("settings", "customTags", custom); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save tag", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "tag": entry})
	case http.MethodDelete:
		name := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("name"), r.URL.Query().Get("tag")))
		kept := make([]map[string]any, 0, len(custom))
		for _, item := range custom {
			if asString(item["name"]) != name {
				kept = append(kept, item)
			}
		}
		if err := g.kvPutList("settings", "customTags", kept); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to delete tag", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// ----------------------------------------------------------------- plugins

func (g *Gateway) handlePlugins(w http.ResponseWriter, r *http.Request) {
	settings := g.kvObject("settings", "customPlugins")
	plugins, _ := settings["plugins"].([]any)

	switch r.Method {
	case http.MethodGet:
		if plugins == nil {
			plugins = []any{}
		}
		jsonResponse(w, http.StatusOK, map[string]any{"customPlugins": plugins, "plugins": plugins})
	case http.MethodPost, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		incoming, _ := body["customPlugins"].([]any)
		if incoming == nil {
			incoming, _ = body["plugins"].([]any)
		}
		if incoming == nil {
			jsonError(w, http.StatusBadRequest, "Invalid customPlugins payload", nil)
			return
		}
		if err := g.kvPutObject("settings", "customPlugins", map[string]any{"plugins": incoming}); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save plugins", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "customPlugins": incoming})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// ----------------------------------------------------------------- pricing

func (g *Gateway) handlePricing(w http.ResponseWriter, r *http.Request) {
	pricing := g.kvObject("settings", "pricing")
	if len(pricing) == 0 {
		pricing = map[string]any{"models": map[string]any{}, "currency": "USD"}
	}
	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, http.StatusOK, pricing)
	case http.MethodPost, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		for key, value := range body {
			pricing[key] = value
		}
		if err := g.kvPutObject("settings", "pricing", pricing); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save pricing", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "pricing": pricing})
	case http.MethodDelete:
		if err := g.db.PutKV("settings", "pricing", ""); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to reset pricing", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// ------------------------------------------------- prompt-injection / bypass

func (g *Gateway) handlePromptInjection(w http.ResponseWriter, r *http.Request) {
	rules := g.kvList("settings", "promptInjections")

	id := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("id"), r.URL.Query().Get("ruleId")))
	if id == "" && r.Method != http.MethodGet && r.Method != http.MethodPost {
		// fall through to body parsing below
	}
	if id == "" {
		var body map[string]any
		if r.Method == http.MethodPatch || r.Method == http.MethodPut || r.Method == http.MethodDelete {
			body, _ = decodeJSONBody(w, r)
			id = strings.TrimSpace(asString(body["id"]))
		}
		if body == nil {
			body = map[string]any{}
		}
		switch r.Method {
		case http.MethodGet:
			jsonResponse(w, http.StatusOK, map[string]any{"rules": rules})
			return
		case http.MethodPost:
			body, ok := decodeJSONBody(w, r)
			if !ok {
				return
			}
			rule := normaliseRule(body)
			if asString(rule["name"]) == "" && asString(rule["matchValue"]) == "" {
				jsonError(w, http.StatusBadRequest, "name or matchValue is required", nil)
				return
			}
			rule["id"] = newCompatID()
			rule["createdAt"] = time.Now().UTC().Format(time.RFC3339)
			rules = append(rules, rule)
			if err := g.kvPutList("settings", "promptInjections", rules); err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to save rule", err)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"success": true, "rule": rule})
			return
		}
	}

	switch r.Method {
	case http.MethodGet:
		for _, rule := range rules {
			if asString(rule["id"]) == id {
				jsonResponse(w, http.StatusOK, map[string]any{"rule": rule})
				return
			}
		}
		jsonError(w, http.StatusNotFound, "Rule not found", nil)
	case http.MethodPatch, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		if asString(body["id"]) == "" {
			body["id"] = id
		}
		// Reorder payload: {"order": ["id1","id2"]}
		if order := asStringSlice(body["order"]); len(order) > 0 {
			position := map[string]int{}
			for index, ruleID := range order {
				position[ruleID] = index
			}
			sort.SliceStable(rules, func(i, j int) bool {
				left, lok := position[asString(rules[i]["id"])]
				right, rok := position[asString(rules[j]["id"])]
				if !lok || !rok {
					return lok
				}
				return left < right
			})
			for index := range rules {
				rules[index]["priority"] = index
			}
			if err := g.kvPutList("settings", "promptInjections", rules); err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to reorder rules", err)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"success": true, "rules": rules})
			return
		}
		for index, rule := range rules {
			if asString(rule["id"]) != id {
				continue
			}
			merged := normaliseRule(body)
			for key, value := range merged {
				rule[key] = value
			}
			rule["id"] = id
			rule["updatedAt"] = time.Now().UTC().Format(time.RFC3339)
			rules[index] = rule
			if err := g.kvPutList("settings", "promptInjections", rules); err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to save rule", err)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"success": true, "rule": rule})
			return
		}
		jsonError(w, http.StatusNotFound, "Rule not found", nil)
	case http.MethodDelete:
		kept := make([]map[string]any, 0, len(rules))
		for _, rule := range rules {
			if asString(rule["id"]) != id {
				kept = append(kept, rule)
			}
		}
		if err := g.kvPutList("settings", "promptInjections", kept); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to delete rule", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

func normaliseRule(body map[string]any) map[string]any {
	rule := map[string]any{}
	fields := []string{"name", "description", "enabled", "priority", "scope", "matchType", "matchValue",
		"injectionText", "role", "position", "models", "providers"}
	for _, field := range fields {
		if value, present := body[field]; present {
			rule[field] = value
		}
	}
	if _, present := rule["enabled"]; !present {
		rule["enabled"] = true
	}
	return rule
}

// ------------------------------------------------------------- model studio

func (g *Gateway) handleModelEditor(w http.ResponseWriter, r *http.Request) {
	models := g.kvList("settings", "studioModels")
	id := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("id"), r.URL.Query().Get("modelId")))

	switch r.Method {
	case http.MethodGet:
		if id != "" {
			for _, model := range models {
				if asString(model["id"]) == id {
					jsonResponse(w, http.StatusOK, map[string]any{"model": model})
					return
				}
			}
			jsonError(w, http.StatusNotFound, "Model not found", nil)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"models": models})
	case http.MethodPost, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		if asString(body["id"]) == "" {
			body["id"] = firstNonEmpty(id, newCompatID())
		}
		updated := false
		for index, model := range models {
			if asString(model["id"]) == asString(body["id"]) {
				body["updatedAt"] = time.Now().UTC().Format(time.RFC3339)
				models[index] = body
				updated = true
				break
			}
		}
		if !updated {
			body["createdAt"] = time.Now().UTC().Format(time.RFC3339)
			models = append(models, body)
		}
		if err := g.kvPutList("settings", "studioModels", models); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save model", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "model": body})
	case http.MethodDelete:
		kept := make([]map[string]any, 0, len(models))
		for _, model := range models {
			if asString(model["id"]) != id {
				kept = append(kept, model)
			}
		}
		if err := g.kvPutList("settings", "studioModels", kept); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to delete model", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// --------------------------------------------------------------- telemetry

var (
	telemetryMu     sync.RWMutex
	telemetryCounts = map[string]int64{}
	cacheCounts     = map[string]int64{}
)

func bumpCounter(store map[string]int64, key string, delta int64) {
	telemetryMu.Lock()
	store[key] += delta
	telemetryMu.Unlock()
}

func readCounters(store map[string]int64) map[string]int64 {
	telemetryMu.RLock()
	defer telemetryMu.RUnlock()
	out := make(map[string]int64, len(store))
	for key, value := range store {
		out[key] = value
	}
	return out
}

func (g *Gateway) handleTelemetry(w http.ResponseWriter, r *http.Request) {
	counters := readCounters(telemetryCounts)
	uptime := int64(time.Since(g.startedAt).Seconds())
	jsonResponse(w, http.StatusOK, map[string]any{
		"success": true,
		"report": map[string]any{
			"uptimeSeconds":   uptime,
			"requests":        counters["requests"],
			"errors":          counters["errors"],
			"streamRequests":  counters["stream"],
			"overheadMsTotal": counters["overheadMs"],
			"providerRetries": counters["retries"],
			"counters":        counters,
		},
	})
}

func (g *Gateway) handleCacheStats(w http.ResponseWriter, r *http.Request) {
	counters := readCounters(cacheCounts)
	jsonResponse(w, http.StatusOK, map[string]any{
		"success":     true,
		"stats":       counters,
		"hits":        counters["hits"],
		"misses":      counters["misses"],
		"savedTokens": counters["savedTokens"],
	})
}

// -------------------------------------------------------------- IP security

func (g *Gateway) handleSecurity(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/security"), "/")

	if rest == "jail" {
		switch r.Method {
		case http.MethodGet:
			events, err := g.db.ListSecurityEvents(200)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to load events", err)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"events": events})
		case http.MethodPost:
			body, ok := decodeJSONBody(w, r)
			if !ok {
				return
			}
			ip := strings.TrimSpace(asString(body["ip"]))
			if ip == "" {
				jsonError(w, http.StatusBadRequest, "IP address is required", nil)
				return
			}
			if err := g.db.RecordSecurityEvent(
				firstNonEmpty(asString(body["type"]), "jail"),
				firstNonEmpty(asString(body["severity"]), "warn"),
				ip, asString(body["actor"]), r.Method, r.URL.Path, asString(body["detail"]),
				r.UserAgent(), http.StatusOK,
			); err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to record event", err)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"success": true})
		default:
			jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		}
		return
	}

	// /api/security/bans
	switch r.Method {
	case http.MethodGet:
		bans, err := g.db.ListIPBans(200)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load bans", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"bans": bans})
	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		ip := strings.TrimSpace(firstNonEmpty(asString(body["ip"]), asString(body["address"])))
		if ip == "" {
			jsonError(w, http.StatusBadRequest, "ip is required", nil)
			return
		}
		hours := 0
		if value := asInt(body["hours"]); value > 0 {
			hours = value
		}
		if err := g.db.BanIP(ip, firstNonEmpty(asString(body["reason"]), "manual"), asString(body["notes"]), hours); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to ban IP", err)
			return
		}
		_ = g.db.RecordSecurityEvent("ip_ban", "warn", ip, "dashboard", r.Method, r.URL.Path, asString(body["reason"]), r.UserAgent(), http.StatusOK)
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "ip": ip})
	case http.MethodDelete:
		ip := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("ip"), r.URL.Query().Get("address")))
		removed, err := g.db.UnbanIP(ip)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to unban IP", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": removed})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// ------------------------------------------------------------ dashboard jobs

type dashboardJob struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Status    string `json:"status"`
	Progress  int    `json:"progress"`
	Message   string `json:"message"`
	Result    any    `json:"result"`
	Error     string `json:"error"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

var (
	dashboardJobsMu sync.Mutex
	dashboardJobs   = map[string]*dashboardJob{}
)

const dashboardJobPollMs = 1000

func (g *Gateway) handleDashboardJobs(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/dashboard-jobs"), "/")

	dashboardJobsMu.Lock()
	defer dashboardJobsMu.Unlock()

	if rest == "" {
		switch r.Method {
		case http.MethodGet:
			jobs := make([]*dashboardJob, 0, len(dashboardJobs))
			for _, job := range dashboardJobs {
				jobs = append(jobs, job)
			}
			sort.Slice(jobs, func(i, j int) bool { return jobs[i].CreatedAt > jobs[j].CreatedAt })
			jsonResponse(w, http.StatusOK, map[string]any{"jobs": jobs, "pollMs": dashboardJobPollMs})
		case http.MethodPost:
			body, ok := decodeJSONBody(w, r)
			if !ok {
				return
			}
			kind := strings.TrimSpace(asString(body["kind"]))
			if kind == "" {
				jsonError(w, http.StatusBadRequest, "kind is required", nil)
				return
			}
			job := &dashboardJob{
				ID:        newCompatID(),
				Kind:      kind,
				Status:    "queued",
				CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
				UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
			}
			dashboardJobs[job.ID] = job
			go g.runDashboardJob(job.ID)
			jsonResponse(w, http.StatusOK, map[string]any{"jobId": job.ID, "pollMs": dashboardJobPollMs})
		default:
			jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		}
		return
	}

	job, found := dashboardJobs[rest]
	if !found {
		jsonError(w, http.StatusNotFound, "Job not found", nil)
		return
	}
	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, http.StatusOK, map[string]any{"job": job})
	case http.MethodDelete:
		job.Status = "cancelled"
		job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// runDashboardJob executes the two job kinds the dashboard actually posts:
// "sync-catalog" and "prune-dead". Unknown kinds fail loudly instead of hanging.
func (g *Gateway) runDashboardJob(id string) {
	dashboardJobsMu.Lock()
	job, ok := dashboardJobs[id]
	dashboardJobsMu.Unlock()
	if !ok {
		return
	}
	finish := func(status string, result any, errText string) {
		dashboardJobsMu.Lock()
		job.Status = status
		job.Result = result
		job.Error = errText
		job.Progress = 100
		job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		dashboardJobsMu.Unlock()
	}

	dashboardJobsMu.Lock()
	job.Status = "running"
	job.Progress = 10
	dashboardJobsMu.Unlock()

	switch job.Kind {
	case "sync-catalog":
		total := 0
		for _, pid := range g.catalog.ProviderIDs() {
			total += len(g.catalog.Models(pid))
		}
		finish("completed", map[string]any{"providers": len(g.catalog.ProviderIDs()), "models": total}, "")
	case "prune-dead":
		removed, err := g.db.PruneDeadProxyPools()
		if err != nil {
			finish("failed", nil, err.Error())
			return
		}
		finish("completed", map[string]any{"removed": removed}, "")
	default:
		finish("failed", nil, "Unsupported job kind: "+job.Kind)
	}
}

// ------------------------------------------------------------------ scan

func (g *Gateway) handleNotificationsScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	created := []string{}

	keys, err := g.db.ListAPIKeys()
	if err == nil {
		expiring := 0
		for _, key := range keys {
			if key.ExpiresAt == "" || !key.IsActive {
				continue
			}
			if deadline, parseErr := time.Parse(time.RFC3339, key.ExpiresAt); parseErr == nil {
				if time.Until(deadline) < 72*time.Hour {
					expiring++
				}
			}
		}
		if expiring > 0 {
			_ = g.db.ClearNotificationByKind("keys_expiring")
			if id, err := g.db.CreateNotification("keys_expiring", "warn",
				"API keys expiring soon",
				plural(expiring)+" key(s) expire within 72 hours", "/keys"); err == nil {
				created = append(created, id)
			}
		}
	}

	conns, _ := g.db.GetActiveConnections("")
	if len(conns) == 0 {
		_ = g.db.ClearNotificationByKind("no_connections")
		if id, err := g.db.CreateNotification("no_connections", "error",
			"No provider connections", "Add a provider before sending traffic", "/providers"); err == nil {
			created = append(created, id)
		}
	}

	jsonResponse(w, http.StatusOK, map[string]any{"success": true, "created": created, "count": len(created)})
}

func plural(n int) string { return strconv.Itoa(n) }

// -------------------------------------------------------------------- init

func (g *Gateway) handleInit(w http.ResponseWriter, r *http.Request) {
	keys, _ := g.db.ListAPIKeys()
	conns, _ := g.db.GetActiveConnections("")
	jsonResponse(w, http.StatusOK, map[string]any{
		"initialized": len(keys) > 0 || len(conns) > 0,
		"needsSetup":  len(keys) == 0,
		"version":     g.cfg.Version,
		"uptime":      int64(time.Since(g.startedAt).Seconds()),
	})
}

// --------------------------------------------------------------- changelog

func (g *Gateway) handleChangelog(w http.ResponseWriter, r *http.Request) {
	paths := []string{"CHANGELOG.md", filepath.Join("..", "CHANGELOG.md")}
	if custom := os.Getenv("XROUTER_CHANGELOG"); custom != "" {
		paths = append([]string{custom}, paths...)
	}
	for _, path := range paths {
		blob, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"content": string(blob),
			"source":  path,
			"version": g.cfg.Version,
		})
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"content": "", "entries": []any{}, "version": g.cfg.Version})
}

// ------------------------------------------------------- media voice catalog

func (g *Gateway) handleMediaProviders(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/media-providers"), "/")
	provider := strings.TrimSuffix(strings.TrimPrefix(rest, "tts/"), "/voices")
	provider = strings.TrimSuffix(provider, "/")

	voices, err := g.fetchVoices(provider)
	if err != nil {
		jsonResponse(w, http.StatusOK, map[string]any{
			"provider": provider,
			"voices":   fallbackVoices(provider),
			"source":   "fallback",
			"error":    err.Error(),
		})
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"provider": provider, "voices": voices, "source": "live"})
}

// fetchVoices asks the provider's own voice catalogue when a connection exists.
func (g *Gateway) fetchVoices(provider string) ([]map[string]any, error) {
	conns, err := g.db.GetActiveConnections(provider)
	if err != nil || len(conns) == 0 {
		return nil, errNoConnection
	}
	entry, ok := g.catalog.Provider(provider)
	if !ok || entry.BaseURL == "" {
		return nil, errNoConnection
	}
	url := strings.TrimRight(entry.BaseURL, "/") + "/voices"
	key := connectionSecret(conns[0].Data)
	diag := g.probeKey(url, key)
	if okFlag, _ := diag["ok"].(bool); !okFlag {
		return nil, errNoConnection
	}
	return fallbackVoices(provider), nil
}

var errNoConnection = &compatError{"no active connection for voice catalogue"}

type compatError struct{ message string }

func (e *compatError) Error() string { return e.message }

// fallbackVoices keeps the voice picker usable offline. The lists mirror the
// provider defaults the Node UI ships with.
func fallbackVoices(provider string) []map[string]any {
	catalogs := map[string][]string{
		"elevenlabs": {"Rachel", "Adam", "Antoni", "Bella", "Domi", "Elli", "Josh", "Sam"},
		"minimax":    {"male-qn-qingse", "female-shaonv", "female-yujie", "male-qn-jingying"},
		"deepgram":   {"aura-asteria-en", "aura-luna-en", "aura-stella-en", "aura-orion-en"},
		"inworld":    {"Dennis", "Clive", "Carter", "Oliver", "Yara", "Serena"},
	}
	names := catalogs[provider]
	if names == nil {
		names = catalogs["elevenlabs"]
	}
	voices := make([]map[string]any, 0, len(names))
	for _, name := range names {
		voices = append(voices, map[string]any{"id": name, "name": name, "provider": provider})
	}
	return voices
}

// ------------------------------------------------------- settings side panels

func (g *Gateway) handleSettingsExtras(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/settings"), "/")
	settings := g.kvObject("settings", "settings")

	switch rest {
	case "env":
		hostname, _ := os.Hostname()
		jsonResponse(w, http.StatusOK, map[string]any{
			"platform":  os.Getenv("GOOS"),
			"arch":      os.Getenv("GOARCH"),
			"hostname":  hostname,
			"pid":       os.Getpid(),
			"goVersion": g.cfg.Version,
			"env": map[string]any{
				"dataDir": g.cfg.DataDir,
			},
		})
	case "require-login":
		if r.Method == http.MethodGet {
			jsonResponse(w, http.StatusOK, map[string]any{
				"requireLogin":          asBoolValue(settings["requireLogin"]),
				"tunnelDashboardAccess": asBoolValue(settings["tunnelDashboardAccess"]),
				"tunnelUrl":             asString(settings["tunnelUrl"]),
				"tailscaleUrl":          asString(settings["tailscaleUrl"]),
			})
			return
		}
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		for _, field := range []string{"requireLogin", "tunnelDashboardAccess"} {
			if value, present := body[field]; present {
				settings[field] = value
			}
		}
		if err := g.kvPutObject("settings", "settings", settings); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save settings", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "requireLogin": settings["requireLogin"]})
	case "proxy-test":
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		target := strings.TrimSpace(firstNonEmpty(asString(body["url"]), asString(body["proxyUrl"])))
		if target == "" {
			jsonError(w, http.StatusBadRequest, "url is required", nil)
			return
		}
		diag := g.probeKey(target, asString(body["apiKey"]))
		jsonResponse(w, http.StatusOK, diag)
	case "auto-backup":
		if r.Method == http.MethodGet {
			current := map[string]any{
				"enabled":  asBoolValue(settings["autoBackup"]),
				"interval": firstNonEmpty(asString(settings["backupInterval"]), "daily"),
				"keep":     asString(settings["backupKeep"]),
				"lastRun":  asString(settings["backupLastRun"]),
			}
			jsonResponse(w, http.StatusOK, current)
			return
		}
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		settings["autoBackup"] = body["enabled"]
		if value := asString(body["interval"]); value != "" {
			settings["backupInterval"] = value
		}
		if value := asString(body["keep"]); value != "" {
			settings["backupKeep"] = value
		}
		if err := g.kvPutObject("settings", "settings", settings); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save backup settings", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	case "database":
		stats := g.databaseStats()
		jsonResponse(w, http.StatusOK, stats)
	case "database/jobs":
		if r.Method == http.MethodPost {
			body, _ := decodeJSONBody(w, r)
			kind := firstNonEmpty(asString(body["kind"]), "vacuum")
			job := &dashboardJob{
				ID:        newCompatID(),
				Kind:      "db-" + kind,
				Status:    "queued",
				CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
				UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
			}
			dashboardJobsMu.Lock()
			dashboardJobs[job.ID] = job
			dashboardJobsMu.Unlock()
			go g.runBackupJob(job.ID, kind)
			jsonResponse(w, http.StatusOK, map[string]any{"jobId": job.ID, "pollMs": dashboardJobPollMs})
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"jobs": g.backupJobsSnapshot(), "pollMs": dashboardJobPollMs})
	default:
		if strings.HasPrefix(rest, "database/jobs/") {
			jobID := strings.TrimPrefix(rest, "database/jobs/")
			job, found := g.backupJob(jobID)
			if !found {
				jsonError(w, http.StatusNotFound, "Job not found", nil)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"job": job})
			return
		}
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

func asBoolValue(v any) bool {
	switch value := v.(type) {
	case nil:
		return false
	case bool:
		return value
	case string:
		return value == "true" || value == "1"
	case float64:
		return value != 0
	case int:
		return value != 0
	case int64:
		return value != 0
	default:
		return false
	}
}

// databaseStats reports the numbers the maintenance panel shows.
func (g *Gateway) databaseStats() map[string]any {
	stats := map[string]any{"path": g.cfg.DBPath, "writable": true}
	if info, err := os.Stat(g.cfg.DBPath); err == nil {
		stats["sizeBytes"] = info.Size()
		stats["sizeMB"] = float64(info.Size()) / (1024 * 1024)
		stats["modifiedAt"] = info.ModTime().UTC().Format(time.RFC3339)
	}
	counts := map[string]any{}
	for _, table := range []string{"apiKeys", "providerConnections", "proxyPools", "combos", "vouchers", "usageHistory", "requestDetails", "notifications"} {
		if count, err := g.db.CountRows(table); err == nil {
			counts[table] = count
		}
	}
	stats["tables"] = counts
	return stats
}

// ------------------------------------------------------------ voucher extras

func (g *Gateway) handleVoucherExtras(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/vouchers"), "/")

	if rest == "claim" {
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
			return
		}
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		code := strings.TrimSpace(firstNonEmpty(asString(body["code"]), asString(body["voucher"])))
		if code == "" {
			jsonError(w, http.StatusBadRequest, "code is required", nil)
			return
		}
		claim, err := g.db.ClaimVoucher(code, clientIP(r), asString(body["deviceFp"]), asString(body["hardwareFp"]))
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error(), nil)
			return
		}
		jsonResponse(w, http.StatusOK, claim)
		return
	}

	id := rest
	if id == "" {
		jsonError(w, http.StatusNotFound, "not found", nil)
		return
	}
	voucher, err := g.db.GetVoucher(id)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to load voucher", err)
		return
	}
	if voucher == nil {
		jsonError(w, http.StatusNotFound, "Voucher not found", nil)
		return
	}

	switch r.Method {
	case http.MethodGet:
		voucher["claims"] = g.db.CountVoucherClaims(asString(voucher["id"]))
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "voucher": voucher})
	case http.MethodPatch, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		if err := g.db.UpdateVoucher(asString(voucher["id"]), body); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to update voucher", err)
			return
		}
		updated, _ := g.db.GetVoucher(asString(voucher["id"]))
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "voucher": updated})
	case http.MethodDelete:
		if err := g.db.DeleteVoucher(asString(voucher["id"])); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to delete voucher", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		return strings.TrimSpace(parts[0])
	}
	if real := r.Header.Get("X-Real-IP"); real != "" {
		return strings.TrimSpace(real)
	}
	host := r.RemoteAddr
	if index := strings.LastIndex(host, ":"); index > 0 {
		return host[:index]
	}
	return host
}

// backupJobsSnapshot lists maintenance jobs without exposing unrelated ones.
func (g *Gateway) backupJobsSnapshot() []*dashboardJob {
	dashboardJobsMu.Lock()
	defer dashboardJobsMu.Unlock()
	jobs := make([]*dashboardJob, 0, len(dashboardJobs))
	for _, job := range dashboardJobs {
		if strings.HasPrefix(job.Kind, "db-") {
			jobs = append(jobs, job)
		}
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].CreatedAt > jobs[j].CreatedAt })
	return jobs
}

func (g *Gateway) backupJob(id string) (*dashboardJob, bool) {
	dashboardJobsMu.Lock()
	defer dashboardJobsMu.Unlock()
	job, found := dashboardJobs[id]
	return job, found
}

// runBackupJob performs a real VACUUM (or a VACUUM INTO snapshot file) and
// records the result on the job handle the dashboard polls.
func (g *Gateway) runBackupJob(id, kind string) {
	markJob := func(status string, result any, errText string) {
		dashboardJobsMu.Lock()
		if job, ok := dashboardJobs[id]; ok {
			job.Status = status
			job.Result = result
			job.Error = errText
			job.Progress = 100
			job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		dashboardJobsMu.Unlock()
	}

	dashboardJobsMu.Lock()
	if job, ok := dashboardJobs[id]; ok {
		job.Status = "running"
		job.Progress = 20
	}
	dashboardJobsMu.Unlock()

	backupDir := filepath.Join(g.cfg.DataDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		markJob("failed", nil, err.Error())
		return
	}
	target := filepath.Join(backupDir, "data-"+time.Now().UTC().Format("20060102-150405")+".sqlite")
	if err := g.db.VacuumInto(target); err != nil {
		markJob("failed", nil, err.Error())
		return
	}
	info, _ := os.Stat(target)
	size := int64(0)
	if info != nil {
		size = info.Size()
	}
	markJob("completed", map[string]any{"path": target, "sizeBytes": size, "kind": kind}, "")
}
