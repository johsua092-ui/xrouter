package gateway

// compat_ops.go ports the operator-facing side channels: proxy pool harvesting
// and scanning, credential import for every OAuth/CLI provider the dashboard
// offers, and the CLI-tools page.
//
// Import endpoints write real providerConnections rows (the same shape the Node
// importer writes), so a token pasted here is immediately routable. Harvest
// endpoints hit the public proxy lists and store what they return; nothing is
// invented when a source fails.

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/johsua092-ui/xrouter/internal/clitools"
	"github.com/johsua092-ui/xrouter/internal/oauthflow"
)

// ------------------------------------------------------------- proxy pools

func (g *Gateway) handleProxyPoolsExtras(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/proxy-pools"), "/")

	switch rest {
	case "harvest":
		g.proxyHarvest(w, r)
	case "auto-scan":
		g.proxyAutoScan(w, r)
	case "bulk":
		g.proxyBulk(w, r)
	case "prune-dead":
		removed, err := g.db.PruneDeadProxyPools()
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to prune pools", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "removed": removed})
	case "import-jobs":
		if r.Method == http.MethodPost {
			body, _ := decodeJSONBody(w, r)
			sources := asStringSlice(body["sources"])
			job := &dashboardJob{
				ID:        newCompatID(),
				Kind:      "proxy-import",
				Status:    "queued",
				CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
				UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
			}
			dashboardJobsMu.Lock()
			dashboardJobs[job.ID] = job
			dashboardJobsMu.Unlock()
			go g.runProxyImport(job.ID, sources, asInt(body["limit"]))
			jsonResponse(w, http.StatusOK, map[string]any{"jobId": job.ID, "pollMs": dashboardJobPollMs})
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"jobs": g.proxyImportJobs(), "pollMs": dashboardJobPollMs})
	case "v2ray":
		g.handleV2Ray(w, r)
	case "cloudflare-deploy", "vercel-deploy", "netlify-deploy", "deno-deploy":
		g.handlePoolDeploy(w, r, strings.TrimSuffix(rest, "-deploy"))
	default:
		if strings.HasSuffix(rest, "/test") {
			g.handleProxyPoolTest(w, r, strings.TrimSuffix(rest, "/test"))
			return
		}
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

func (g *Gateway) proxyImportJobs() []*dashboardJob {
	dashboardJobsMu.Lock()
	defer dashboardJobsMu.Unlock()
	jobs := make([]*dashboardJob, 0, len(dashboardJobs))
	for _, job := range dashboardJobs {
		if job.Kind == "proxy-import" {
			jobs = append(jobs, job)
		}
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].CreatedAt > jobs[j].CreatedAt })
	return jobs
}

var defaultProxySources = []string{
	"https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
	"https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
}

// runProxyImport performs the harvest in the background so the dashboard can
// poll instead of holding a request open.
func (g *Gateway) runProxyImport(jobID string, sources []string, limit int) {
	setJob := func(status string, result any, errText string) {
		dashboardJobsMu.Lock()
		if job, ok := dashboardJobs[jobID]; ok {
			job.Status = status
			job.Result = result
			job.Error = errText
			job.Progress = 100
			job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		dashboardJobsMu.Unlock()
	}

	dashboardJobsMu.Lock()
	if job, ok := dashboardJobs[jobID]; ok {
		job.Status = "running"
		job.Progress = 20
	}
	dashboardJobsMu.Unlock()

	added, skipped, fetchErrors := g.harvestProxies(sources, limit)
	if len(fetchErrors) > 0 && added == 0 {
		setJob("failed", map[string]any{"added": 0, "errors": fetchErrors}, strings.Join(fetchErrors, "; "))
		return
	}
	setJob("completed", map[string]any{"added": added, "skipped": skipped, "errors": fetchErrors}, "")
}

func (g *Gateway) proxyHarvest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	body, _ := decodeJSONBody(w, r)
	sources := asStringSlice(body["sources"])
	limit := asInt(body["limit"])
	if limit <= 0 {
		limit = 50
	}
	added, skipped, fetchErrors := g.harvestProxies(sources, limit)
	jsonResponse(w, http.StatusOK, map[string]any{
		"success": added > 0 || len(fetchErrors) == 0,
		"added":   added,
		"skipped": skipped,
		"errors":  fetchErrors,
	})
}

// harvestProxies pulls plain ip:port lists and inserts them as pools.
func (g *Gateway) harvestProxies(sources []string, limit int) (int, int, []string) {
	if len(sources) == 0 {
		sources = defaultProxySources
	}
	client := &http.Client{Timeout: 12 * time.Second}
	added, skipped := 0, 0
	fetchErrors := []string{}

	existing := map[string]bool{}
	if rows, err := g.db.ExecQueryMaps("SELECT data FROM proxyPools"); err == nil {
		for _, row := range rows {
			var data map[string]any
			if json.Unmarshal([]byte(asString(row["data"])), &data) == nil {
				existing[asString(data["proxyUrl"])] = true
			}
		}
	}

	for _, source := range sources {
		resp, err := client.Get(source)
		if err != nil {
			fetchErrors = append(fetchErrors, source+": "+err.Error())
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			fetchErrors = append(fetchErrors, source+": HTTP "+resp.Status)
			continue
		}
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			if added >= limit {
				break
			}
			line := strings.TrimSpace(scanner.Text())
			if line == "" || !strings.Contains(line, ":") {
				continue
			}
			proxyURL := "http://" + strings.TrimPrefix(strings.TrimPrefix(line, "http://"), "https://")
			if existing[proxyURL] {
				skipped++
				continue
			}
			if _, err := g.createProxyPool(map[string]any{
				"name":     "harvest-" + strings.ReplaceAll(line, ":", "-"),
				"proxyUrl": proxyURL,
				"source":   "harvest",
			}); err != nil {
				skipped++
				continue
			}
			existing[proxyURL] = true
			added++
		}
		scanErr := scanner.Err()
		resp.Body.Close()
		if scanErr != nil {
			fetchErrors = append(fetchErrors, source+": "+scanErr.Error())
		}
		if added >= limit {
			break
		}
	}
	return added, skipped, fetchErrors
}

func (g *Gateway) proxyBulk(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	lines := asStringSlice(body["proxies"])
	if len(lines) == 0 {
		lines = asStringSlice(body["urls"])
	}
	if len(lines) == 0 {
		for _, field := range []string{"text", "content"} {
			if blob := asString(body[field]); blob != "" {
				for _, line := range strings.Split(blob, "\n") {
					if trimmed := strings.TrimSpace(line); trimmed != "" {
						lines = append(lines, trimmed)
					}
				}
			}
		}
	}
	if len(lines) == 0 {
		jsonError(w, http.StatusBadRequest, "No proxies provided", nil)
		return
	}

	created, failed := 0, []string{}
	for _, line := range lines {
		proxyURL := line
		if !strings.Contains(proxyURL, "://") {
			proxyURL = "http://" + proxyURL
		}
		if _, err := g.createProxyPool(map[string]any{
			"name":     "bulk-" + strings.ReplaceAll(line, ":", "-"),
			"proxyUrl": proxyURL,
			"source":   "bulk",
		}); err != nil {
			failed = append(failed, line)
			continue
		}
		created++
	}
	jsonResponse(w, http.StatusOK, map[string]any{
		"success": true,
		"created": created,
		"failed":  failed,
		"total":   len(lines),
	})
}

// proxyAutoScan dials every pool and records the outcome on the row.
func (g *Gateway) proxyAutoScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	rows, err := g.db.ExecQueryMaps("SELECT id,data FROM proxyPools")
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to load pools", err)
		return
	}

	alive, dead := 0, 0
	for _, row := range rows {
		var data map[string]any
		if json.Unmarshal([]byte(asString(row["data"])), &data) != nil {
			continue
		}
		proxyURL := asString(data["proxyUrl"])
		hostport := proxyHostPort(proxyURL)
		if hostport == "" {
			dead++
			continue
		}
		start := time.Now()
		conn, dialErr := net.DialTimeout("tcp", hostport, 3*time.Second)
		latency := int(time.Since(start).Milliseconds())
		status := "dead"
		if dialErr == nil {
			conn.Close()
			status = "alive"
			alive++
		} else {
			dead++
		}
		_, _ = g.db.ExecRaw("UPDATE proxyPools SET testStatus = ?, updatedAt = ? WHERE id = ?",
			status, nowISOString(), asString(row["id"]))
		data["latencyMs"] = latency
		if encoded, err := json.Marshal(data); err == nil {
			_, _ = g.db.ExecRaw("UPDATE proxyPools SET data = ? WHERE id = ?", string(encoded), asString(row["id"]))
		}
	}
	jsonResponse(w, http.StatusOK, map[string]any{"success": true, "tested": len(rows), "alive": alive, "dead": dead})
}

// handleProxyPoolTest is the per-pool button: one dial, one row update.
func (g *Gateway) handleProxyPoolTest(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	row, err := g.db.ExecQueryMap("SELECT data FROM proxyPools WHERE id = ?", id)
	if err != nil || row == nil {
		jsonError(w, http.StatusNotFound, "proxy pool not found", nil)
		return
	}
	var data map[string]any
	_ = json.Unmarshal([]byte(asString(row["data"])), &data)
	hostport := proxyHostPort(asString(data["proxyUrl"]))
	if hostport == "" {
		jsonError(w, http.StatusBadRequest, "pool has no usable proxyUrl", nil)
		return
	}
	start := time.Now()
	conn, dialErr := net.DialTimeout("tcp", hostport, 5*time.Second)
	latency := int(time.Since(start).Milliseconds())
	status := "dead"
	message := ""
	if dialErr == nil {
		conn.Close()
		status = "alive"
	} else {
		message = dialErr.Error()
	}
	_, _ = g.db.ExecRaw("UPDATE proxyPools SET testStatus = ?, updatedAt = ? WHERE id = ?",
		status, nowISOString(), id)
	jsonResponse(w, http.StatusOK, map[string]any{
		"success":   dialErr == nil,
		"status":    status,
		"latencyMs": latency,
		"error":     message,
	})
}

func proxyHostPort(proxyURL string) string {
	trimmed := proxyURL
	if index := strings.Index(trimmed, "://"); index >= 0 {
		trimmed = trimmed[index+3:]
	}
	trimmed = strings.Split(trimmed, "/")[0]
	if at := strings.LastIndex(trimmed, "@"); at >= 0 {
		trimmed = trimmed[at+1:]
	}
	if !strings.Contains(trimmed, ":") {
		return ""
	}
	return trimmed
}

// handleV2Ray stores the generated v2ray/xray outbound config.
func (g *Gateway) handleV2Ray(w http.ResponseWriter, r *http.Request) {
	config := g.kvObject("settings", "v2rayConfig")
	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, http.StatusOK, map[string]any{"config": config, "v2ray": config})
	case http.MethodPost, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		for key, value := range body {
			config[key] = value
		}
		if err := g.kvPutObject("settings", "v2rayConfig", config); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save v2ray config", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "config": config})
	case http.MethodDelete:
		if err := g.db.PutKV("settings", "v2rayConfig", ""); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to reset v2ray config", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// handlePoolDeploy deploys a relay pool. Cloudflare is implemented against the
// real Workers API; the other targets record the token and report that the Go
// engine cannot deploy them yet rather than faking a URL.
func (g *Gateway) handlePoolDeploy(w http.ResponseWriter, r *http.Request, target string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	token := strings.TrimSpace(asString(body["token"]))
	if token == "" {
		jsonError(w, http.StatusBadRequest, "token is required", nil)
		return
	}
	if target != "cloudflare" {
		jsonError(w, http.StatusNotImplemented, target+" deployment is not implemented in the Go engine", nil)
		return
	}
	accountID := strings.TrimSpace(asString(body["accountId"]))
	workerName := firstNonEmpty(asString(body["name"]), "xrouter-relay")
	if accountID == "" {
		jsonError(w, http.StatusBadRequest, "accountId is required", nil)
		return
	}

	script := "export default {async fetch(request){const url=new URL(request.url);" +
		"const target=url.searchParams.get('url');if(!target)return new Response('missing url',{status:400});" +
		"const res=await fetch(target,{method:request.method,headers:request.headers,body:request.body});" +
		"return new Response(res.body,{status:res.status,headers:res.headers});}}"

	endpoint := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/workers/scripts/%s", accountID, workerName)
	req, err := http.NewRequest(http.MethodPut, endpoint, strings.NewReader(script))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to build request", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/javascript")

	client := &http.Client{Timeout: 25 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		jsonError(w, http.StatusBadGateway, "Cloudflare request failed: "+err.Error(), nil)
		return
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		jsonError(w, http.StatusBadGateway, "Cloudflare rejected the deploy: "+strings.TrimSpace(string(payload)), nil)
		return
	}
	subdomain := strings.TrimSpace(asString(body["subdomain"]))
	deployURL := ""
	if subdomain != "" {
		deployURL = "https://" + workerName + "." + subdomain + ".workers.dev"
	}
	jsonResponse(w, http.StatusOK, map[string]any{
		"success":   true,
		"provider":  "cloudflare",
		"worker":    workerName,
		"deployUrl": deployURL,
	})
}

// ------------------------------------------------------------------ OAuth

// oauthImportTargets maps the dashboard's import endpoints to the provider id
// and auth type they should create.
var oauthImportTargets = map[string]struct {
	provider string
	authType string
}{
	"codex/import-token":      {"codex", "oauth"},
	"codex/bulk-import":       {"codex", "oauth"},
	"grok-cli/bulk-import":    {"grok-cli", "oauth"},
	"cursor/import":           {"cursor", "oauth"},
	"cursor/auto-import":      {"cursor", "oauth"},
	"kiro/api-key":            {"kiro", "apikey"},
	"kiro/import":             {"kiro", "oauth"},
	"kiro/import-cli-proxy":   {"kiro", "oauth"},
	"kiro/auto-import":        {"kiro", "oauth"},
	"kiro/social-exchange":    {"kiro", "oauth"},
	"gitlab/pat":              {"gitlab", "apikey"},
	"iflow/cookie":            {"iflow", "cookie"},
	"zed/import":              {"zed", "oauth"},
	"zed/auto-import":         {"zed", "oauth"},
	"xiaomi-mimo/api-key":     {"xiaomi-mimo", "apikey"},
	"xiaomi-mimo/auto-import": {"xiaomi-mimo", "oauth"},
	"adcode":                  {"adcode", "oauth"},
}

func (g *Gateway) handleOAuth(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/oauth"), "/")

	if target, ok := oauthImportTargets[rest]; ok {
		g.oauthImport(w, r, target.provider, target.authType)
		return
	}

	if rest == "xiaomi-mimo/login/status" {
		jsonResponse(w, http.StatusOK, map[string]any{"status": "unsupported", "note": "headless login is not implemented in the Go engine"})
		return
	}

	// Generic /api/oauth/{provider}/{action}
	if strings.HasSuffix(rest, "/import") {
		provider := strings.TrimSuffix(rest, "/import")
		g.oauthImport(w, r, strings.Trim(provider, "/"), "oauth")
		return
	}

	// Interactive flows: authorize → callback, or device → poll.
	if index := strings.Index(rest, "/"); index > 0 {
		providerID := rest[:index]
		action := rest[index+1:]
		registry := oauthflow.Registry(g.oauthOverrides())
		provider, known := registry[providerID]

		switch action {
		case "authorize", "start":
			if !known {
				jsonError(w, http.StatusNotFound, "unknown OAuth provider: "+providerID, nil)
				return
			}
			redirect := r.URL.Query().Get("redirectUri")
			if redirect == "" {
				redirect = g.oauthRedirectURI(r, providerID)
			}
			session, authorizeURL, err := oauthflow.StartPKCE(provider, redirect)
			if err != nil {
				jsonError(w, http.StatusBadRequest, err.Error(), nil)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{
				"success": true, "provider": providerID, "sessionId": session.ID,
				"authUrl": authorizeURL, "authorizeUrl": authorizeURL,
				"state": session.State, "redirectUri": redirect,
			})
			return

		case "callback", "exchange":
			if !known {
				jsonError(w, http.StatusNotFound, "unknown OAuth provider: "+providerID, nil)
				return
			}
			body, ok := decodeJSONBody(w, r)
			if !ok {
				return
			}
			sessionID := firstNonEmpty(asString(body["sessionId"]), r.URL.Query().Get("sessionId"))
			session := oauthflow.SessionByID(sessionID)
			if session == nil {
				jsonError(w, http.StatusBadRequest, "unknown or expired session", nil)
				return
			}
			if state := asString(body["state"]); state != "" && state != session.State {
				jsonError(w, http.StatusBadRequest, "state mismatch", nil)
				return
			}
			token, err := oauthflow.Exchange(provider, session, asString(body["code"]))
			if err != nil {
				jsonError(w, http.StatusBadGateway, err.Error(), nil)
				return
			}
			if token.AccessToken == "" {
				jsonResponse(w, http.StatusBadGateway, map[string]any{
					"success": false, "provider": providerID, "raw": token.Extra,
					"error": firstNonEmpty(asString(token.Extra["error_description"]), asString(token.Extra["error"]), "no access_token returned"),
				})
				return
			}
			g.persistOAuthToken(providerID, token)
			jsonResponse(w, http.StatusOK, map[string]any{
				"success": true, "provider": providerID,
				"accessToken": token.AccessToken, "refreshToken": token.RefreshToken,
				"expiresIn": token.ExpiresIn, "scope": token.Scope,
			})
			return

		case "device":
			if !known {
				jsonError(w, http.StatusNotFound, "unknown OAuth provider: "+providerID, nil)
				return
			}
			session, payload, err := oauthflow.StartDevice(provider)
			if err != nil {
				jsonError(w, http.StatusBadRequest, err.Error(), nil)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{
				"success": true, "provider": providerID, "sessionId": session.ID,
				"userCode":  payload["user_code"],
				"verifyUrl": firstNonEmpty(asString(payload["verification_uri"]), asString(payload["verification_url"])),
				"interval":  session.Interval,
				"expiresIn": payload["expires_in"],
			})
			return

		case "device/poll", "poll":
			if !known {
				jsonError(w, http.StatusNotFound, "unknown OAuth provider: "+providerID, nil)
				return
			}
			body, _ := decodeJSONBody(w, r)
			session := oauthflow.SessionByID(firstNonEmpty(asString(body["sessionId"]), r.URL.Query().Get("sessionId")))
			if session == nil {
				jsonError(w, http.StatusBadRequest, "unknown or expired device session", nil)
				return
			}
			token, pending, err := oauthflow.PollDevice(provider, session)
			if err != nil {
				jsonError(w, http.StatusBadGateway, err.Error(), nil)
				return
			}
			if token == nil || token.AccessToken == "" {
				jsonResponse(w, http.StatusOK, map[string]any{
					"success": false, "status": "pending", "error": pending,
				})
				return
			}
			g.persistOAuthToken(providerID, token)
			jsonResponse(w, http.StatusOK, map[string]any{
				"success": true, "provider": providerID, "status": "complete",
				"accessToken": token.AccessToken, "refreshToken": token.RefreshToken,
				"expiresIn": token.ExpiresIn,
			})
			return
		}
	}

	jsonError(w, http.StatusNotImplemented, "OAuth action not implemented in the Go engine: "+rest, nil)
}

// oauthOverrides reads the deployment's own OAuth client definitions.
func (g *Gateway) oauthOverrides() []oauthflow.Provider {
	state := g.kvObject("settings", "oauth_providers")
	if state == nil {
		return nil
	}
	var providers []oauthflow.Provider
	if raw, ok := state["providers"]; ok {
		blob, err := json.Marshal(raw)
		if err == nil {
			_ = json.Unmarshal(blob, &providers)
		}
	}
	if len(providers) == 0 {
		// The setting may itself be the array.
		blob, err := json.Marshal(state)
		if err == nil {
			_ = json.Unmarshal(blob, &providers)
		}
	}
	return providers
}

// oauthRedirectURI picks the callback the provider should send the browser back
// to: an explicit public base if configured, else this request's origin.
func (g *Gateway) oauthRedirectURI(r *http.Request, provider string) string {
	state := g.kvObject("settings", "oauth_providers")
	if base := asString(state["publicBaseUrl"]); base != "" {
		return strings.TrimSuffix(base, "/") + "/api/oauth/" + provider + "/callback"
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	host := r.Host
	if forwarded := r.Header.Get("X-Forwarded-Host"); forwarded != "" {
		host = forwarded
	}
	return scheme + "://" + host + "/api/oauth/" + provider + "/callback"
}

// persistOAuthToken stores a freshly minted token as a provider connection so
// the router can use it immediately after login.
func (g *Gateway) persistOAuthToken(provider string, token *oauthflow.Token) {
	data := map[string]any{
		"authType":    "oauth",
		"accessToken": token.AccessToken,
	}
	if token.RefreshToken != "" {
		data["refreshToken"] = token.RefreshToken
	}
	if token.ExpiresIn > 0 {
		data["expiresAt"] = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second).UTC().Format(time.RFC3339)
	}
	name := provider + "-oauth-" + strconv.FormatInt(time.Now().Unix(), 36)
	data["provider"] = provider
	data["name"] = name
	data["data"] = map[string]any{
		"authType":    "oauth",
		"accessToken": token.AccessToken,
		"refreshToken": token.RefreshToken,
		"expiresAt":   data["expiresAt"],
	}
	_, _ = g.createConnection(data)
}

// oauthImport normalises whatever credential shape the dashboard posts and
// creates the connection row the router reads.
func (g *Gateway) oauthImport(w http.ResponseWriter, r *http.Request, provider, authType string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}

	// Bulk import: {"connections":[{...},{...}]} or a raw array under "items".
	batch := []any{}
	if list, present := body["connections"].([]any); present {
		batch = list
	} else if list, present := body["items"].([]any); present {
		batch = list
	}

	if len(batch) > 0 {
		created := []map[string]any{}
		failed := []string{}
		for _, item := range batch {
			entry, _ := item.(map[string]any)
			if entry == nil {
				failed = append(failed, "invalid entry")
				continue
			}
			if asString(entry["provider"]) == "" {
				entry["provider"] = provider
			}
			if asString(entry["authType"]) == "" {
				entry["authType"] = authType
			}
			conn, err := g.createConnection(entry)
			if err != nil {
				failed = append(failed, err.Error())
				continue
			}
			created = append(created, conn)
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"success":     len(created) > 0,
			"created":     len(created),
			"failed":      failed,
			"connections": created,
		})
		return
	}

	data := map[string]any{}
	for key, value := range body {
		switch key {
		case "provider", "authType", "name", "email", "priority", "isActive":
			continue
		default:
			data[key] = value
		}
	}
	if len(data) == 0 {
		jsonError(w, http.StatusBadRequest, "No credential fields provided", nil)
		return
	}

	conn, err := g.createConnection(map[string]any{
		"provider": provider,
		"authType": authType,
		"name":     firstNonEmpty(asString(body["name"]), provider+" import"),
		"email":    asString(body["email"]),
		"data":     data,
	})
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error(), nil)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"success": true, "connection": conn})
}

// federationCallbackURL builds the absolute URL an identity provider should
// redirect back to, honouring an explicit public base when one is configured.
func (g *Gateway) federationCallbackURL(r *http.Request, path string) string {
	state := g.kvObject("settings", "auth_oidc")
	if base := asString(state["publicBaseUrl"]); base != "" {
		return strings.TrimSuffix(base, "/") + path
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	host := r.Host
	if forwarded := r.Header.Get("X-Forwarded-Host"); forwarded != "" {
		host = forwarded
	}
	return scheme + "://" + host + path
}

// fetchOIDCDiscovery reads the issuer's well-known configuration.
func fetchOIDCDiscovery(issuer string) (map[string]any, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Get(strings.TrimRight(issuer, "/") + "/.well-known/openid-configuration")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("discovery returned %s", response.Status)
	}
	var doc map[string]any
	if err := json.NewDecoder(response.Body).Decode(&doc); err != nil {
		return nil, err
	}
	if asString(doc["authorization_endpoint"]) == "" || asString(doc["token_endpoint"]) == "" {
		return nil, fmt.Errorf("discovery document is missing the authorization or token endpoint")
	}
	return doc, nil
}

// claimsFromIDToken decodes the JWT payload without verifying it. The token was
// just received over TLS directly from the token endpoint, which is the trust
// anchor; the payload only labels the session.
func claimsFromIDToken(idToken string) map[string]any {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return map[string]any{}
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return map[string]any{}
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return map[string]any{}
	}
	return claims
}

// -------------------------------------------------------------- CLI tools

// cliToolPaths is the config file each CLI reads on this platform. Only the
// existence probe and the read path are used: the Go engine deliberately does
// not rewrite another tool's config until its schema is ported, so a half-right
// write cannot break a working CLI install.
var cliToolPaths = map[string][]string{
	"claude":       {".claude/settings.json", ".claude.json"},
	"codex":        {".codex/config.toml", ".codex/auth.json"},
	"opencode":     {".config/opencode/opencode.json"},
	"gemini-cli":   {".gemini/settings.json", ".gemini/.env"},
	"cursor":       {".cursor/mcp.json"},
	"cline":        {".cline/settings.json"},
	"kilo":         {".kilo/settings.json"},
	"roo":          {".roo/settings.json"},
	"continue":     {".continue/config.json"},
	"qwen":         {".qwen/settings.json"},
	"droid":        {".factory/config.json"},
	"hermes":       {".hermes/config.yaml"},
	"crush":        {".config/crush/crush.json"},
	"forge":        {".forge/config.json"},
	"smelt":        {".smelt/config.json"},
	"omp":          {".omp/config.json"},
	"pi":           {".pi/config.json"},
	"jcode":        {".jcode/config.json"},
	"grok-build":   {".grok/config.json"},
	"grok":         {".grok/config.json"},
	"devin":        {".devin/config.json"},
	"opendesign":   {".opendesign/config.json"},
	"codewhale":    {".codewhale/config.json"},
	"deepseek-tui": {".deepseek/config.json"},
	"openclaw":     {".openclaw/config.json"},
	"copilot":      {".config/Code/User/chatLanguageModels.json"},
	"cowork":       {".cowork/settings.json"},
	"antigravity":  {".antigravity/config.json"},
	"kiro":         {".kiro/config.json"},
}

func cliHome() string {
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return "/root"
}

func (g *Gateway) handleCLITools(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/cli-tools"), "/")

	if rest == "all-statuses" {
		statuses := clitools.AllStatuses(clitools.Params{})
		payload := map[string]any{}
		for id, status := range statuses {
			payload[id] = map[string]any{
				"configured": status.Configured,
				"path":       status.Path,
				"name":       status.Name,
				"error":      status.Error,
			}
		}
		jsonResponse(w, http.StatusOK, map[string]any{"statuses": payload, "tools": payload})
		return
	}

	// Endpoints that are not per-agent config files.
	switch rest {
	case "cowork-mcp-registry":
		state := g.kvObject("settings", "cowork_mcp_registry")
		servers, _ := state["servers"].([]any)
		if servers == nil {
			servers = []any{}
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "servers": servers, "registry": servers})
		return
	case "cowork-mcp-tools":
		state := g.kvObject("settings", "cowork_mcp_registry")
		tools, _ := state["tools"].([]any)
		if tools == nil {
			tools = []any{}
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "tools": tools})
		return
	case "antigravity-mitm", "antigravity-mitm/alias":
		if r.Method != http.MethodGet {
			jsonResponse(w, http.StatusOK, map[string]any{
				"success":   false,
				"supported": false,
				"error":     "The Antigravity MITM proxy is configured by the Node runtime; the Go engine does not rewrite its CA or host map.",
			})
			return
		}
		state := g.kvObject("settings", "antigravity_mitm")
		configured := asString(state["caPath"]) != ""
		jsonResponse(w, http.StatusOK, map[string]any{
			"success": true, "configured": configured, "settings": state,
		})
		return
	}

	tool := rest
	if index := strings.Index(rest, "/"); index >= 0 {
		tool = rest[:index]
	}
	tool = normaliseCLITool(tool)

	switch r.Method {
	case http.MethodGet:
		status, err := clitools.StatusOf(tool, clitools.Params{})
		if err != nil {
			jsonError(w, http.StatusNotFound, err.Error(), nil)
			return
		}
		payload := map[string]any{
			"tool":       status.Tool,
			"name":       status.Name,
			"path":       status.Path,
			"configured": status.Configured,
		}
		if status.Config != nil {
			payload["config"] = status.Config
		}
		if status.Raw != "" {
			payload["raw"] = status.Raw
		}
		jsonResponse(w, http.StatusOK, payload)
	case http.MethodPost, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		result, err := clitools.Install(tool, clitools.Params{
			BaseURL: asString(body["baseUrl"]),
			APIKey:  asString(body["apiKey"]),
			Model:   firstNonEmpty(asString(body["model"]), asString(body["defaultModel"])),
			Profile: firstNonEmpty(asString(body["profile"]), asString(body["name"])),
			Home:    asString(body["home"]),
		})
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error(), nil)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"success": true, "tool": result.Tool, "name": result.Name,
			"path": result.Path, "backup": result.Backup,
		})
	case http.MethodDelete:
		result, err := clitools.Reset(tool, clitools.Params{})
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error(), nil)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"success": true, "tool": result.Tool, "path": result.Path,
			"message": result.Message, "backup": result.Backup,
		})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

func cliToolConfigPath(tool string) (string, bool) {
	home := cliHome()
	for _, relative := range cliToolPaths[tool] {
		full := filepath.Join(home, relative)
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			return full, true
		}
	}
	if len(cliToolPaths[tool]) > 0 {
		return filepath.Join(home, cliToolPaths[tool][0]), false
	}
	return "", false
}

var errUnsupported = errors.New("unsupported")

// normaliseCLITool maps the dashboard's endpoint names ("claude-settings",
// "cowork-mcp-tools", "antigravity-mitm") onto the config table.
func normaliseCLITool(name string) string {
	name = strings.Trim(name, "/")
	for _, suffix := range []string{"-settings", "-profiles", "-mcp-registry", "-mcp-tools", "-mitm", "-build-settings"} {
		if strings.HasSuffix(name, suffix) {
			name = strings.TrimSuffix(name, suffix)
			break
		}
	}
	aliases := map[string]string{
		"antigravity": "antigravity",
		"grok":        "grok-build",
		"deepseek":    "deepseek-tui",
	}
	if mapped, ok := aliases[name]; ok {
		return mapped
	}
	return name
}
