package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/johsua092-ui/xrouter/internal/auth"
	"github.com/johsua092-ui/xrouter/internal/database"
)

// --- session -----------------------------------------------------------------

// seedPassword stores a bcrypt password in settings, as a configured install has.
func seedPassword(t *testing.T, g *Gateway, password string) {
	t.Helper()
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if _, err := g.db.SaveSettings(map[string]any{"password": hash, "requireLogin": true}, "test", "seed"); err != nil {
		t.Fatalf("save settings: %v", err)
	}
}

func TestLoginPasswordIssuesWorkingSession(t *testing.T) {
	g := newManagementGateway(t)
	seedPassword(t, g, "s3cret-pass")

	rec := httptest.NewRecorder()
	g.handleAuthLogin(rec, jsonRequest(http.MethodPost, "/api/auth/login", map[string]any{
		"password": "s3cret-pass",
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d (%s)", rec.Code, rec.Body.String())
	}

	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatalf("no session cookie set")
	}
	session := cookies[0]
	if session.Name != "auth_token" {
		t.Fatalf("cookie name = %q", session.Name)
	}
	if !session.HttpOnly {
		t.Fatalf("session cookie must be HttpOnly")
	}
	if _, err := g.authManager().Verify(session.Value); err != nil {
		t.Fatalf("issued cookie does not verify: %v", err)
	}

	// The cookie alone must open a management route.
	keysReq := httptest.NewRequest(http.MethodGet, "/api/keys", nil)
	keysReq.AddCookie(session)
	keysRec := httptest.NewRecorder()
	g.requireAdmin(g.handleKeysList)(keysRec, keysReq)
	if keysRec.Code != http.StatusOK {
		t.Fatalf("session cookie rejected on /api/keys: %d (%s)", keysRec.Code, keysRec.Body.String())
	}

	// Status reflects the session.
	statusReq := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	statusReq.AddCookie(session)
	statusRec := httptest.NewRecorder()
	g.handleAuthStatus(statusRec, statusReq)
	status := decode(t, statusRec)
	if status["authenticated"] != true {
		t.Fatalf("status authenticated = %v", status["authenticated"])
	}
	if status["role"] != "admin" {
		t.Fatalf("status role = %v", status["role"])
	}
}

func TestLoginRejectsWrongPassword(t *testing.T) {
	g := newManagementGateway(t)
	seedPassword(t, g, "right-pass")

	rec := httptest.NewRecorder()
	g.handleAuthLogin(rec, jsonRequest(http.MethodPost, "/api/auth/login", map[string]any{
		"password": "wrong-pass",
	}))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatalf("failed login must not set a cookie")
	}
}

func TestLoginWithAPIKeyClaimsTheKey(t *testing.T) {
	g := newManagementGateway(t)
	created, err := g.db.CreateAPIKey(database.APIKey{
		Name:     "ci-key",
		Key:      "sk-test-login-key",
		IsActive: true,
	})
	if err != nil {
		t.Fatalf("create key: %v", err)
	}

	rec := httptest.NewRecorder()
	g.handleAuthLogin(rec, jsonRequest(http.MethodPost, "/api/auth/login", map[string]any{
		"apiKey": created.Key,
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d (%s)", rec.Code, rec.Body.String())
	}
	cookie := rec.Result().Cookies()[0]
	claims, err := g.authManager().Verify(cookie.Value)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims["role"] != "apikey" {
		t.Fatalf("role = %v, want apikey", claims["role"])
	}
	if claims["keyId"] != created.ID {
		t.Fatalf("keyId = %v, want %v", claims["keyId"], created.ID)
	}
}

func TestLogoutRevokesSession(t *testing.T) {
	g := newManagementGateway(t)
	seedPassword(t, g, "pass-for-logout")

	loginRec := httptest.NewRecorder()
	g.handleAuthLogin(loginRec, jsonRequest(http.MethodPost, "/api/auth/login", map[string]any{
		"password": "pass-for-logout",
	}))
	cookie := loginRec.Result().Cookies()[0]

	logoutReq := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	logoutReq.AddCookie(cookie)
	logoutRec := httptest.NewRecorder()
	g.handleAuthLogout(logoutRec, logoutReq)
	if logoutRec.Code != http.StatusOK {
		t.Fatalf("logout status = %d", logoutRec.Code)
	}

	// The token is revoked server-side, not merely unset in the browser.
	if _, err := g.authManager().Verify(cookie.Value); err != auth.ErrRevoked {
		t.Fatalf("expected ErrRevoked after logout, got %v", err)
	}

	keysReq := httptest.NewRequest(http.MethodGet, "/api/keys", nil)
	keysReq.AddCookie(cookie)
	keysRec := httptest.NewRecorder()
	g.requireAdmin(g.handleKeysList)(keysRec, keysReq)
	if keysRec.Code != http.StatusUnauthorized && keysRec.Code != http.StatusForbidden {
		t.Fatalf("revoked cookie still allowed: %d", keysRec.Code)
	}
}

// withChiParam injects a chi URL parameter so handlers can be called directly.
func withChiParam(req *http.Request, key, value string) *http.Request {
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add(key, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

// --- providers ---------------------------------------------------------------

func TestProvidersCRUDMasksSecrets(t *testing.T) {
	g := newManagementGateway(t)

	createRec := httptest.NewRecorder()
	g.handleProviders(createRec, jsonRequest(http.MethodPost, "/api/providers", map[string]any{
		"provider": "openai",
		"authType": "apikey",
		"name":     "primary",
		"data": map[string]any{
			"apiKey": "sk-live-abcdefghijklmnop",
		},
	}))
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create status = %d (%s)", createRec.Code, createRec.Body.String())
	}
	created := decode(t, createRec)
	connection := created["connection"].(map[string]any)
	id := connection["id"].(string)
	data := connection["data"].(map[string]any)
	if masked := asString(data["apiKey"]); masked == "sk-live-abcdefghijklmnop" {
		t.Fatalf("apiKey echoed in clear: %q", masked)
	} else if masked != "***" && !strings.Contains(masked, "...") {
		t.Fatalf("expected masked value, got %q", masked)
	}

	// A PUT that echoes the mask must not clobber the stored secret.
	putRec := httptest.NewRecorder()
	g.handleProviderByID(putRec, withChiParam(jsonRequest(http.MethodPut, "/api/providers/"+id, map[string]any{
		"name": "renamed",
		"data": map[string]any{"apiKey": asString(data["apiKey"])},
	}), "id", id))
	if putRec.Code != http.StatusOK {
		t.Fatalf("update status = %d (%s)", putRec.Code, putRec.Body.String())
	}

	stored, err := g.db.ExecQueryMap(`SELECT data FROM providerConnections WHERE id = ?`, id)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	storedData := map[string]any{}
	if err := json.Unmarshal([]byte(asString(stored["data"])), &storedData); err != nil {
		t.Fatalf("decode stored data: %v", err)
	}
	// The stored value is sealed at rest like the dashboard writes it, and still
	// opens to the original secret.
	storedSecret := asString(storedData["apiKey"])
	if storedSecret == "sk-live-abcdefghijklmnop" {
		t.Fatalf("secret stored in clear")
	}
	plain, unsealErr := database.Unseal(storedSecret)
	if unsealErr != nil {
		t.Fatalf("stored secret is not a readable envelope: %v", unsealErr)
	}
	if plain != "sk-live-abcdefghijklmnop" {
		t.Fatalf("stored secret was overwritten by a mask: %q", plain)
	}

	// List masks too.
	listRec := httptest.NewRecorder()
	g.handleProviders(listRec, httptest.NewRequest(http.MethodGet, "/api/providers", nil))
	listed := decode(t, listRec)
	entries := listed["connections"].([]any)
	if len(entries) != 1 {
		t.Fatalf("connections = %d", len(entries))
	}
	if listed["byProvider"].(map[string]any)["openai"] != float64(1) {
		t.Fatalf("byProvider grouping wrong: %#v", listed["byProvider"])
	}

	// Delete.
	delRec := httptest.NewRecorder()
	g.handleProviderByID(delRec, withChiParam(httptest.NewRequest(http.MethodDelete, "/api/providers/"+id, nil), "id", id))
	if delRec.Code != http.StatusOK {
		t.Fatalf("delete status = %d", delRec.Code)
	}
	if row, _ := g.db.ExecQueryMap(`SELECT id FROM providerConnections WHERE id = ?`, id); row != nil {
		t.Fatalf("row survived delete")
	}
}

func TestProviderModelsComeFromCatalogue(t *testing.T) {
	g := newManagementGateway(t)
	created, err := g.createConnection(map[string]any{"provider": "openai", "authType": "apikey"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	id := created["id"].(string)

	rec := httptest.NewRecorder()
	g.handleProviderModels(rec, withChiParam(httptest.NewRequest(http.MethodGet, "/api/providers/"+id+"/models", nil), "id", id))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	models := body["models"].([]any)
	if len(models) == 0 {
		t.Fatalf("catalogue returned no models for openai")
	}
}

func TestProvidersBulkReportsPerRowFailures(t *testing.T) {
	g := newManagementGateway(t)
	rec := httptest.NewRecorder()
	g.handleProvidersBulk(rec, jsonRequest(http.MethodPost, "/api/providers/bulk", map[string]any{
		"connections": []any{
			map[string]any{"provider": "openai", "authType": "apikey", "name": "one"},
			map[string]any{"name": "missing-provider"},
			map[string]any{"provider": "anthropic", "authType": "apikey", "name": "two"},
		},
	}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if body["created"] != float64(2) {
		t.Fatalf("created = %v", body["created"])
	}
	if len(body["failed"].([]any)) != 1 {
		t.Fatalf("failed = %v", body["failed"])
	}
}

// --- proxy pools -------------------------------------------------------------

func TestProxyPoolLifecycle(t *testing.T) {
	g := newManagementGateway(t)

	createRec := httptest.NewRecorder()
	g.handleProxyPools(createRec, jsonRequest(http.MethodPost, "/api/proxy-pools", map[string]any{
		"name":     "residential",
		"proxyUrl": "http://user:pass@10.0.0.1:8080",
	}))
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create status = %d (%s)", createRec.Code, createRec.Body.String())
	}
	pool := decode(t, createRec)["pool"].(map[string]any)
	id := pool["id"].(string)
	if masked := asString(pool["proxyUrl"]); strings.Contains(masked, "pass") {
		t.Fatalf("proxy credentials leaked: %q", masked)
	}

	// Missing proxyUrl is a 400, not a silent empty pool.
	badRec := httptest.NewRecorder()
	g.handleProxyPools(badRec, jsonRequest(http.MethodPost, "/api/proxy-pools", map[string]any{"name": "nope"}))
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("missing url status = %d", badRec.Code)
	}

	putRec := httptest.NewRecorder()
	g.handleProxyPoolByID(putRec, withChiParam(jsonRequest(http.MethodPut, "/api/proxy-pools/"+id, map[string]any{
		"name":        "residential-2",
		"isActive":    false,
		"strictProxy": true,
	}), "id", id))
	if putRec.Code != http.StatusOK {
		t.Fatalf("update status = %d (%s)", putRec.Code, putRec.Body.String())
	}
	updated := decode(t, putRec)["pool"].(map[string]any)
	if updated["name"] != "residential-2" || updated["isActive"] != false || updated["strictProxy"] != true {
		t.Fatalf("update not applied: %#v", updated)
	}

	delRec := httptest.NewRecorder()
	g.handleProxyPoolByID(delRec, withChiParam(httptest.NewRequest(http.MethodDelete, "/api/proxy-pools/"+id, nil), "id", id))
	if delRec.Code != http.StatusOK {
		t.Fatalf("delete status = %d", delRec.Code)
	}
}
