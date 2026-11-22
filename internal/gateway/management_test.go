package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/johsua092-ui/xrouter/internal/catalog"
	"github.com/johsua092-ui/xrouter/internal/config"
	"github.com/johsua092-ui/xrouter/internal/database"
)

// newManagementGateway builds a gateway over a throwaway SQLite file. The schema
// is created by database.Open, so these tests exercise the same DDL a fresh
// install would get.
func newManagementGateway(t *testing.T) *Gateway {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "data.sqlite"))
	if err != nil {
		t.Fatalf("open temp db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	return &Gateway{
		catalog: catalog.MustLoad(),
		db:      db,
		// DataDir holds the generated JWT secret; a fresh one per test keeps
		// sessions isolated.
		cfg: &config.Config{Version: "test", Port: "0", DataDir: t.TempDir()},
	}
}

// jsonRequest builds a request with a JSON body.
func jsonRequest(method, target string, body any) *http.Request {
	encoded, _ := json.Marshal(body)
	req := httptest.NewRequest(method, target, strings.NewReader(string(encoded)))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestAPIKeyLifecycle(t *testing.T) {
	g := newManagementGateway(t)

	// Create
	rec := httptest.NewRecorder()
	g.handleKeysList(rec, jsonRequest(http.MethodPost, "/api/keys", map[string]any{
		"name":       "dashboard",
		"tokenLimit": 1000,
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d (%s)", rec.Code, rec.Body.String())
	}
	created := decode(t, rec)
	id, _ := created["id"].(string)
	secret, _ := created["key"].(string)
	if id == "" || !strings.HasPrefix(secret, "sk-") {
		t.Fatalf("created key is malformed: %v", created)
	}
	if created["tokenLimit"].(float64) != 1000 {
		t.Fatalf("tokenLimit not stored: %v", created["tokenLimit"])
	}

	// Duplicate name is rejected, not silently allowed.
	rec = httptest.NewRecorder()
	g.handleKeysList(rec, jsonRequest(http.MethodPost, "/api/keys", map[string]any{"name": "dashboard"}))
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate name status = %d, want 409", rec.Code)
	}

	// List
	rec = httptest.NewRecorder()
	g.handleKeysList(rec, httptest.NewRequest(http.MethodGet, "/api/keys", nil))
	listed, _ := decode(t, rec)["keys"].([]any)
	if len(listed) != 1 {
		t.Fatalf("list returned %d keys", len(listed))
	}

	// Patch
	rec = httptest.NewRecorder()
	g.handleKeyByID(rec, jsonRequest(http.MethodPatch, "/api/keys/"+id, map[string]any{"name": "renamed"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("patch status = %d", rec.Code)
	}
	if decode(t, rec)["name"] != "renamed" {
		t.Fatalf("patch did not apply: %s", rec.Body.String())
	}

	// Rotate keeps the id but changes the secret.
	rec = httptest.NewRecorder()
	g.handleKeyByID(rec, jsonRequest(http.MethodPost, "/api/keys/"+id+"/rotate", nil))
	rotated := decode(t, rec)
	if rotated["id"] != id {
		t.Fatalf("rotate changed the id: %v", rotated["id"])
	}
	if rotated["key"] == secret {
		t.Fatal("rotate returned the same secret")
	}

	// ACL round-trip
	rec = httptest.NewRecorder()
	g.handleKeyByID(rec, jsonRequest(http.MethodPut, "/api/keys/"+id+"/acl", map[string]any{
		"deniedModels":     "openai/gpt-5",
		"allowedProviders": "anthropic",
		"notes":            "scoped key",
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("acl put status = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	g.handleKeyByID(rec, httptest.NewRequest(http.MethodGet, "/api/keys/"+id+"/acl", nil))
	acl := decode(t, rec)
	if acl["deniedModels"] != "openai/gpt-5" || acl["notes"] != "scoped key" {
		t.Fatalf("acl did not round-trip: %v", acl)
	}

	// Delete
	rec = httptest.NewRecorder()
	g.handleKeyByID(rec, jsonRequest(http.MethodDelete, "/api/keys/"+id, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	g.handleKeysList(rec, httptest.NewRequest(http.MethodGet, "/api/keys", nil))
	if listed, _ := decode(t, rec)["keys"].([]any); len(listed) != 0 {
		t.Fatalf("key survived delete: %d remaining", len(listed))
	}
}

func TestComboLifecycle(t *testing.T) {
	g := newManagementGateway(t)

	rec := httptest.NewRecorder()
	g.handleCombos(rec, jsonRequest(http.MethodPost, "/api/combos", map[string]any{
		"name":          "fast-chain",
		"models":        []any{"anthropic/claude", "openai/gpt-5"},
		"contextWindow": 200000,
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d (%s)", rec.Code, rec.Body.String())
	}
	combo := decode(t, rec)
	id, _ := combo["id"].(string)
	if !strings.Contains(combo["models"].(string), "anthropic/claude") {
		t.Fatalf("models not stored as JSON: %v", combo["models"])
	}

	rec = httptest.NewRecorder()
	g.handleComboByID(rec, jsonRequest(http.MethodPatch, "/api/combos/"+id, map[string]any{
		"models": []any{"openai/gpt-5"},
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("patch status = %d", rec.Code)
	}
	if strings.Contains(decode(t, rec)["models"].(string), "anthropic") {
		t.Fatalf("patch did not replace models: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	g.handleComboByID(rec, jsonRequest(http.MethodDelete, "/api/combos/"+id, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d", rec.Code)
	}
}

func TestSettingsMergeAndRollback(t *testing.T) {
	g := newManagementGateway(t)

	rec := httptest.NewRecorder()
	g.handleSettings(rec, jsonRequest(http.MethodPatch, "/api/settings", map[string]any{
		"requireApiKey": true,
		"providerStrategies": map[string]any{
			"codex": map[string]any{"fallbackStrategy": "round-robin"},
		},
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("first save status = %d (%s)", rec.Code, rec.Body.String())
	}

	// A nested PATCH must merge, not replace the sibling branch.
	rec = httptest.NewRecorder()
	g.handleSettings(rec, jsonRequest(http.MethodPatch, "/api/settings", map[string]any{
		"providerStrategies": map[string]any{
			"antigravity": map[string]any{"fallbackStrategy": "sticky"},
		},
	}))
	merged := decode(t, rec)
	strategies, _ := merged["providerStrategies"].(map[string]any)
	if _, ok := strategies["codex"]; !ok {
		t.Fatalf("nested merge dropped an existing provider: %v", strategies)
	}
	if _, ok := strategies["antigravity"]; !ok {
		t.Fatalf("nested merge did not add the new provider: %v", strategies)
	}

	// Rollback to the first snapshot restores the original shape.
	rec = httptest.NewRecorder()
	g.handleSettings(rec, httptest.NewRequest(http.MethodGet, "/api/settings/history", nil))
	history, _ := decode(t, rec)["history"].([]any)
	if len(history) < 2 {
		t.Fatalf("expected at least two snapshots, got %d", len(history))
	}
	// Pick the oldest snapshot by insertion order; the two saves land in the same
	// millisecond, so the timestamp alone cannot decide.
	oldestEntry := history[0].(map[string]any)
	for _, raw := range history {
		entry := raw.(map[string]any)
		if entry["seq"].(float64) < oldestEntry["seq"].(float64) {
			oldestEntry = entry
		}
	}
	oldest := oldestEntry["id"].(string)

	rec = httptest.NewRecorder()
	g.handleSettings(rec, jsonRequest(http.MethodPost, "/api/settings/rollback", map[string]any{"id": oldest}))
	if rec.Code != http.StatusOK {
		t.Fatalf("rollback status = %d (%s)", rec.Code, rec.Body.String())
	}
	restored := decode(t, rec)
	if _, ok := restored["providerStrategies"]; ok {
		t.Fatalf("rollback kept the newer branch: %v", restored)
	}
}

func TestUsageViews(t *testing.T) {
	g := newManagementGateway(t)

	rows := []struct {
		provider, model, status string
		prompt, completion      int
	}{
		{"anthropic", "claude", "ok", 100, 200},
		{"anthropic", "claude", "ok", 50, 50},
		{"openai", "gpt-5", "error", 10, 0},
	}
	for _, row := range rows {
		if _, err := g.db.ExecRaw(`INSERT INTO usageHistory
			(timestamp,provider,model,connectionId,apiKey,endpoint,promptTokens,completionTokens,cost,status,tokens,meta)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			"2026-11-22T10:00:00.000Z", row.provider, row.model, "conn-1", "sk-x",
			"/v1/chat/completions", row.prompt, row.completion, 0.01, row.status, "{}", "{}"); err != nil {
			t.Fatalf("seed usage row: %v", err)
		}
	}

	rec := httptest.NewRecorder()
	g.handleUsage(rec, httptest.NewRequest(http.MethodGet, "/api/usage/stats?period=all", nil))
	stats := decode(t, rec)
	if stats["requests"].(float64) != 3 {
		t.Fatalf("requests = %v, want 3", stats["requests"])
	}
	if stats["totalTokens"].(float64) != 410 {
		t.Fatalf("totalTokens = %v, want 410", stats["totalTokens"])
	}

	rec = httptest.NewRecorder()
	g.handleUsage(rec, httptest.NewRequest(http.MethodGet, "/api/usage/providers?period=all", nil))
	grouped, _ := decode(t, rec)["providers"].([]any)
	if len(grouped) != 2 {
		t.Fatalf("provider grouping returned %d rows", len(grouped))
	}
	top := grouped[0].(map[string]any)
	if top["name"] != "anthropic" || top["requests"].(float64) != 2 {
		t.Fatalf("grouping is wrong: %v", top)
	}

	rec = httptest.NewRecorder()
	g.handleUsage(rec, httptest.NewRequest(http.MethodGet, "/api/usage/errors?limit=10", nil))
	if errs, _ := decode(t, rec)["errors"].([]any); len(errs) != 1 {
		t.Fatalf("errors view returned %d rows", len(errs))
	}

	// An invalid period must not be treated as SQL: unknown tokens mean "all".
	rec = httptest.NewRecorder()
	g.handleUsage(rec, httptest.NewRequest(http.MethodGet, "/api/usage/stats?period=DROP%20TABLE", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("invalid period status = %d", rec.Code)
	}
}

func TestDisabledModelsMerge(t *testing.T) {
	g := newManagementGateway(t)

	rec := httptest.NewRecorder()
	g.handleDisabledModels(rec, jsonRequest(http.MethodPost, "/api/models/disabled", map[string]any{
		"providerAlias": "openai",
		"ids":           []any{"gpt-4", "gpt-5"},
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("disable status = %d (%s)", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	g.handleDisabledModels(rec, jsonRequest(http.MethodPost, "/api/models/disabled", map[string]any{
		"providerAlias": "openai",
		"ids":           []any{"gpt-4o"},
	}))
	ids := decode(t, rec)["ids"].([]any)
	if len(ids) != 3 {
		t.Fatalf("merge lost ids: %v", ids)
	}

	rec = httptest.NewRecorder()
	g.handleDisabledModels(rec, jsonRequest(http.MethodDelete, "/api/models/disabled", map[string]any{
		"providerAlias": "openai",
		"ids":           []any{"gpt-4"},
	}))
	ids = decode(t, rec)["ids"].([]any)
	if len(ids) != 2 {
		t.Fatalf("remove did not drop one id: %v", ids)
	}

	rec = httptest.NewRecorder()
	g.handleDisabledModels(rec, httptest.NewRequest(http.MethodGet, "/api/models/disabled?providerAlias=openai", nil))
	if got := decode(t, rec)["ids"].([]any); len(got) != 2 {
		t.Fatalf("query by providerAlias returned %v", got)
	}
}

func TestManagementGateRequiresToken(t *testing.T) {
	g := newManagementGateway(t)
	g.cfg.AdminToken = "s3cret"

	handler := g.requireAdmin(g.handleKeysList)

	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodGet, "/api/keys", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing token status = %d, want 401", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/keys", nil)
	req.Header.Set("X-Admin-Token", "s3cret")
	rec = httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("valid token status = %d, want 200", rec.Code)
	}
}

func TestManagementGateFallsBackToLoopback(t *testing.T) {
	g := newManagementGateway(t)
	handler := g.requireAdmin(g.handleVersion)

	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	req.RemoteAddr = "127.0.0.1:5555"
	rec := httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("loopback status = %d, want 200", rec.Code)
	}

	remote := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	remote.RemoteAddr = "203.0.113.9:5555"
	rec = httptest.NewRecorder()
	handler(rec, remote)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("public status = %d, want 403", rec.Code)
	}
}
