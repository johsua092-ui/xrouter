package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/johsua092-ui/xrouter/internal/database"
)

// The compat layer is the route surface the Node dashboard still calls. These
// tests pin the behaviours that would silently 404 or lie if a handler regressed.

func TestCompatModelsViews(t *testing.T) {
	g := newManagementGateway(t)

	for _, path := range []string{"/api/models", "/api/models/catalog", "/api/models/availability"} {
		rec := httptest.NewRecorder()
		g.handleModelsCompat(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200 (%s)", path, rec.Code, rec.Body.String())
		}
	}

	rec := httptest.NewRecorder()
	g.handleModelsCompat(rec, jsonRequest(http.MethodPost, "/api/models/catalog-sync", map[string]any{}))
	body := decode(t, rec)
	if body["success"] != true {
		t.Fatalf("catalog-sync did not report success: %v", body)
	}
	if numericField(body, "models") == 0 {
		t.Fatalf("catalog-sync reported zero models")
	}
}

func TestCompatAliasAndDisabledRoundTrip(t *testing.T) {
	g := newManagementGateway(t)

	// Pick a provider the catalogue actually ships models for, and address the
	// model the way the dashboard does: <provider alias>/<model id>.
	var modelID string
	for _, pid := range g.catalog.ProviderIDs() {
		provider, ok := g.catalog.Provider(pid)
		if !ok {
			continue
		}
		models := g.catalog.Models(pid)
		if len(models) == 0 {
			continue
		}
		prefix := pid
		if provider.Alias != "" {
			prefix = provider.Alias
		}
		modelID = prefix + "/" + models[0].ID
		break
	}
	if modelID == "" {
		t.Skip("catalogue ships no models in this build")
	}

	rec := httptest.NewRecorder()
	g.handleModelsCompat(rec, jsonRequest(http.MethodPut, "/api/models", map[string]any{
		"model": modelID,
		"alias": "sonnet",
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("alias set status = %d (%s)", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	g.handleModelsCompat(rec, jsonRequest(http.MethodPost, "/api/models/disabled", map[string]any{"model": modelID}))
	if rec.Code != http.StatusOK {
		t.Fatalf("disable status = %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	g.handleModelsCompat(rec, httptest.NewRequest(http.MethodGet, "/api/models", nil))
	body := decode(t, rec)
	models, _ := body["models"].([]any)
	var sawAlias, sawDisabled bool
	for _, entry := range models {
		row, _ := entry.(map[string]any)
		if row["id"] != modelID {
			continue
		}
		if row["alias"] == "sonnet" {
			sawAlias = true
		}
		if row["disabled"] == true {
			sawDisabled = true
		}
	}
	if !sawAlias {
		t.Fatalf("alias missing from /api/models for %s", modelID)
	}
	if !sawDisabled {
		t.Fatalf("disabled flag missing from /api/models for %s", modelID)
	}
}

func TestCompatThemeAndPromptRules(t *testing.T) {
	g := newManagementGateway(t)

	rec := httptest.NewRecorder()
	g.handleTheme(rec, jsonRequest(http.MethodPost, "/api/theme", map[string]any{"theme": "light", "accent": "blue"}))
	if body := decode(t, rec); body["theme"] != "light" {
		t.Fatalf("theme not persisted: %v", body)
	}

	rec = httptest.NewRecorder()
	g.handlePromptInjection(rec, jsonRequest(http.MethodPost, "/api/prompt-injection", map[string]any{
		"name": "rule-one", "matchValue": "foo", "injectionText": "bar",
	}))
	body := decode(t, rec)
	rule, _ := body["rule"].(map[string]any)
	id, _ := rule["id"].(string)
	if id == "" {
		t.Fatalf("rule id missing: %v", body)
	}

	rec = httptest.NewRecorder()
	g.handlePromptInjection(rec, jsonRequest(http.MethodGet, "/api/prompt-injection", map[string]any{}))
	rules, _ := decode(t, rec)["rules"].([]any)
	if len(rules) != 1 {
		t.Fatalf("rules = %d, want 1", len(rules))
	}

	rec = httptest.NewRecorder()
	g.handlePromptInjection(rec, jsonRequest(http.MethodDelete, "/api/prompt-injection?id="+id, map[string]any{}))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	g.handlePromptInjection(rec, jsonRequest(http.MethodGet, "/api/prompt-injection", map[string]any{}))
	if rules, _ := decode(t, rec)["rules"].([]any); len(rules) != 0 {
		t.Fatalf("rule survived delete")
	}
}

func TestCompatComboPresetsCreateCombos(t *testing.T) {
	g := newManagementGateway(t)

	rec := httptest.NewRecorder()
	g.handleComboPresets(rec, httptest.NewRequest(http.MethodGet, "/api/combos/presets?source=claude", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("preset preview status = %d", rec.Code)
	}
	preview, _ := decode(t, rec)["items"].([]any)
	if len(preview) == 0 {
		t.Skip("catalogue ships no claude models in this build")
	}

	rec = httptest.NewRecorder()
	g.handleComboPresets(rec, jsonRequest(http.MethodPost, "/api/combos/presets", map[string]any{"source": "claude"}))
	body := decode(t, rec)
	created, _ := body["created"].([]any)
	if len(created) == 0 {
		t.Fatalf("no combos created: %v", body)
	}
	combos, err := g.db.ListCombos()
	if err != nil {
		t.Fatalf("list combos: %v", err)
	}
	if len(combos) != len(created) {
		t.Fatalf("combos in db = %d, created = %d", len(combos), len(created))
	}
}

func TestCompatVoucherClaimIsSingleUsePerDevice(t *testing.T) {
	g := newManagementGateway(t)

	voucher, err := g.db.CreateVoucher(map[string]any{
		"name": "smoke", "tokenLimit": 100, "maxUses": 5, "isActive": true,
	})
	if err != nil {
		t.Fatalf("create voucher: %v", err)
	}
	code := asString(voucher["code"])

	rec := httptest.NewRecorder()
	g.handleVoucherExtras(rec, jsonRequest(http.MethodPost, "/api/vouchers/claim", map[string]any{
		"code": code, "deviceFp": "device-a",
	}))
	body := decode(t, rec)
	if body["success"] != true {
		t.Fatalf("first claim failed: %v", body)
	}
	if key, _ := body["key"].(string); !strings.HasPrefix(key, "sk-") {
		t.Fatalf("claim returned no api key: %v", body)
	}

	rec = httptest.NewRecorder()
	g.handleVoucherExtras(rec, jsonRequest(http.MethodPost, "/api/vouchers/claim", map[string]any{
		"code": code, "deviceFp": "device-a",
	}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("duplicate claim status = %d, want 400", rec.Code)
	}
}

func TestCompatTeamLifecycle(t *testing.T) {
	g := newManagementGateway(t)

	rec := httptest.NewRecorder()
	g.handleTeams(rec, jsonRequest(http.MethodPost, "/api/teams", map[string]any{"name": "alpha"}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d (%s)", rec.Code, rec.Body.String())
	}
	team, _ := decode(t, rec)["team"].(map[string]any)
	id, _ := team["id"].(string)
	if id == "" {
		t.Fatalf("team id missing: %v", team)
	}

	rec = httptest.NewRecorder()
	g.handleTeams(rec, jsonRequest(http.MethodPatch, "/api/teams/"+id, map[string]any{"description": "updated"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("patch status = %d (%s)", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	g.handleTeams(rec, httptest.NewRequest(http.MethodGet, "/api/teams", nil))
	if teams, _ := decode(t, rec)["teams"].([]any); len(teams) != 1 {
		t.Fatalf("teams = %d, want 1", len(teams))
	}

	rec = httptest.NewRecorder()
	g.handleTeams(rec, httptest.NewRequest(http.MethodDelete, "/api/teams/"+id, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d", rec.Code)
	}
}

func TestCompatProxyPoolBulkAndTest(t *testing.T) {
	g := newManagementGateway(t)

	rec := httptest.NewRecorder()
	g.handleProxyPoolsExtras(rec, jsonRequest(http.MethodPost, "/api/proxy-pools/bulk", map[string]any{
		"proxies": []string{"127.0.0.1:9"},
	}))
	body := decode(t, rec)
	if numericField(body, "created") != 1 {
		t.Fatalf("bulk created = %v, want 1", body["created"])
	}

	rows, err := g.db.ExecQueryMaps("SELECT id FROM proxyPools")
	if err != nil || len(rows) != 1 {
		t.Fatalf("proxyPools rows = %d (%v)", len(rows), err)
	}
	id := asString(rows[0]["id"])

	rec = httptest.NewRecorder()
	g.handleProxyPoolsExtras(rec, jsonRequest(http.MethodPost, "/api/proxy-pools/"+id+"/test", map[string]any{}))
	if rec.Code != http.StatusOK {
		t.Fatalf("pool test status = %d (%s)", rec.Code, rec.Body.String())
	}
	if status := asString(decode(t, rec)["status"]); status != "dead" {
		t.Fatalf("closed port reported as %q, want dead", status)
	}
}

func TestCompatDebugJobCompletes(t *testing.T) {
	g := newManagementGateway(t)

	rec := httptest.NewRecorder()
	g.handleDashboardJobs(rec, jsonRequest(http.MethodPost, "/api/dashboard-jobs", map[string]any{"kind": "sync-catalog"}))
	jobID := asString(decode(t, rec)["jobId"])
	if jobID == "" {
		t.Fatalf("no job id returned")
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		dashboardJobsMu.Lock()
		job := dashboardJobs[jobID]
		status := ""
		if job != nil {
			status = job.Status
		}
		dashboardJobsMu.Unlock()
		if status == "completed" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("sync-catalog job did not complete")
}

func TestCompatShareTokenLifecycle(t *testing.T) {
	g := newManagementGateway(t)

	key, err := g.db.CreateAPIKey(database.APIKey{Name: "share-test"})
	if err != nil {
		t.Fatalf("create key: %v", err)
	}

	rec := httptest.NewRecorder()
	g.handleKeysExtras(rec, jsonRequest(http.MethodPost, "/api/keys/"+key.ID+"/share", map[string]any{"label": "x", "ttlDays": 1}))
	body := decode(t, rec)
	token := asString(body["token"])
	if token == "" {
		t.Fatalf("no share token: %v", body)
	}

	rec = httptest.NewRecorder()
	g.handleKeysExtras(rec, httptest.NewRequest(http.MethodGet, "/api/keys/"+key.ID+"/share", nil))
	shares, _ := decode(t, rec)["shares"].([]any)
	if len(shares) != 1 {
		t.Fatalf("shares = %d, want 1", len(shares))
	}

	rec = httptest.NewRecorder()
	g.handleKeysExtras(rec, httptest.NewRequest(http.MethodDelete, "/api/keys/"+key.ID+"/share?token="+token, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke status = %d", rec.Code)
	}
}

func TestCompatSidecarReportsNotInstalled(t *testing.T) {
	g := newManagementGateway(t)

	rec := httptest.NewRecorder()
	g.handleSidecar(rec, httptest.NewRequest(http.MethodGet, "/api/pxpipe/status", nil))
	body := decode(t, rec)
	if _, present := body["installed"]; !present {
		t.Fatalf("status payload missing installed flag: %v", body)
	}

	rec = httptest.NewRecorder()
	g.handleSidecar(rec, jsonRequest(http.MethodPost, "/api/pxpipe/start", map[string]any{}))
	if rec.Code != http.StatusOK {
		t.Fatalf("start status = %d", rec.Code)
	}
	if success, _ := decode(t, rec)["success"].(bool); success {
		t.Skip("pxpipe is installed on this host")
	}
}
