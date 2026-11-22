package gateway

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/johsua092-ui/xrouter/internal/database"
)

// Management plane: the dashboard's own API (keys, combos, usage, settings,
// vouchers, notifications, model overrides).
//
// These routes expose credentials and mutate shared state, so they are gated by
// requireAdmin. The Node dashboard gates the same routes behind a JWT session
// cookie; the Go core has no session store yet, so it accepts a bearer token
// instead. With no token configured the gate falls back to loopback-only, which
// keeps a fresh install usable without shipping an unauthenticated key endpoint
// on a public interface.

// requireAdmin wraps a management handler with the credential check.
//
// Accepted callers, in order: a verified dashboard session cookie (what the
// browser sends after /api/auth/login), the operator token from
// XROUTER_ADMIN_TOKEN, or an unconfigured install reached over loopback.
func (g *Gateway) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if g.adminAuthorised(r) {
			next(w, r)
			return
		}
		if g.cfg.AdminToken != "" && g.sessionFromRequest(r) == nil {
			jsonResponse(w, http.StatusUnauthorized, map[string]any{"error": "invalid admin token"})
			return
		}
		jsonResponse(w, http.StatusForbidden, map[string]any{
			"error": "management API is loopback-only until an admin token is configured",
		})
	}
}

// decodeJSONBody reads a JSON object body.
func decodeJSONBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "could not read request body", err)
		return nil, false
	}
	if len(body) == 0 {
		return map[string]any{}, true
	}
	out := map[string]any{}
	if err := json.Unmarshal(body, &out); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON body", err)
		return nil, false
	}
	return out, true
}

// dbErrorToStatus maps repository errors onto HTTP codes so handlers stay short.
func dbErrorToStatus(w http.ResponseWriter, err error) {
	if errors.Is(err, database.ErrNotFound) {
		jsonResponse(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	jsonError(w, http.StatusInternalServerError, "database error", err)
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

// handleKeysList serves GET/POST /api/keys.
func (g *Gateway) handleKeysList(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		keys, err := g.db.ListAPIKeys()
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"keys": keys})

	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		name := strings.TrimSpace(asString(body["name"]))
		if name == "" {
			jsonError(w, http.StatusBadRequest, "Name is required", nil)
			return
		}

		existing, err := g.db.ListAPIKeys()
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		for _, key := range existing {
			if key.Name == name {
				jsonResponse(w, http.StatusConflict, map[string]any{
					"error": `A key named "` + name + `" already exists. Use a different name.`,
				})
				return
			}
		}

		created, err := g.db.CreateAPIKey(database.APIKey{
			Name:          name,
			Key:           asString(body["customKey"]),
			IsActive:      true,
			TokenLimit:    int64(asInt(body["tokenLimit"])),
			ResetInterval: firstNonEmpty(asString(body["resetInterval"]), "never"),
			AllowedModels: firstNonEmpty(asString(body["allowedModels"]), "*"),
			RPMLimit:      asInt(body["rpmLimit"]),
			TPMLimit:      asInt(body["tpmLimit"]),
			IPWhitelist:   asString(body["ipWhitelist"]),
			ExpiresAt:     asString(body["expiresAt"]),
			SystemPrompt:  asString(body["systemPrompt"]),
			Permissions:   marshalOr(asMapValue(body["permissions"]), ""),
		})
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, created)

	default:
		w.Header().Set("Allow", "GET, POST")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// handleKeysBulk serves POST /api/keys/bulk: create many keys in one call, which
// is what the dashboard's provisioning view does.
func (g *Gateway) handleKeysBulk(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	rawKeys, ok := body["keys"].([]any)
	if !ok || len(rawKeys) == 0 {
		jsonError(w, http.StatusBadRequest, "keys[] is required", nil)
		return
	}

	created := make([]database.APIKey, 0, len(rawKeys))
	failed := make([]map[string]any, 0)

	for index, raw := range rawKeys {
		entry := asMapValue(raw)
		if entry == nil {
			failed = append(failed, map[string]any{"index": index, "error": "not an object"})
			continue
		}
		name := strings.TrimSpace(asString(entry["name"]))
		if name == "" {
			failed = append(failed, map[string]any{"index": index, "error": "name is required"})
			continue
		}
		key, err := g.db.CreateAPIKey(database.APIKey{
			Name:          name,
			IsActive:      true,
			TokenLimit:    int64(asInt(entry["tokenLimit"])),
			ResetInterval: firstNonEmpty(asString(entry["resetInterval"]), "never"),
			AllowedModels: firstNonEmpty(asString(entry["allowedModels"]), "*"),
			RPMLimit:      asInt(entry["rpmLimit"]),
			TPMLimit:      asInt(entry["tpmLimit"]),
		})
		if err != nil {
			failed = append(failed, map[string]any{"index": index, "name": name, "error": err.Error()})
			continue
		}
		created = append(created, *key)
	}

	jsonResponse(w, http.StatusOK, map[string]any{"created": created, "failed": failed})
}

// keyIDFromPath reads the trailing id from /api/keys/{id}[/action].
func keyIDFromPath(path, suffix string) (id string, action string) {
	rest := strings.TrimPrefix(path, "/api/keys/")
	if suffix != "" {
		rest = strings.TrimSuffix(rest, suffix)
	}
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 0 {
		return "", ""
	}
	id = parts[0]
	if len(parts) > 1 {
		action = parts[1]
	}
	return id, action
}

// handleKeyByID serves /api/keys/{id} and its sub-actions.
func (g *Gateway) handleKeyByID(w http.ResponseWriter, r *http.Request) {
	id, action := keyIDFromPath(r.URL.Path, "")
	if id == "" {
		jsonError(w, http.StatusBadRequest, "Missing key id", nil)
		return
	}

	switch action {
	case "":
		switch r.Method {
		case http.MethodGet:
			key, err := g.db.FindAPIKey(id)
			if err != nil {
				dbErrorToStatus(w, err)
				return
			}
			jsonResponse(w, http.StatusOK, key)

		case http.MethodPatch, http.MethodPut:
			body, ok := decodeJSONBody(w, r)
			if !ok {
				return
			}
			key, err := g.db.UpdateAPIKey(id, body)
			if err != nil {
				dbErrorToStatus(w, err)
				return
			}
			jsonResponse(w, http.StatusOK, key)

		case http.MethodDelete:
			if err := g.db.DeleteAPIKey(id); err != nil {
				dbErrorToStatus(w, err)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"ok": true})

		default:
			w.Header().Set("Allow", "GET, PATCH, DELETE")
			jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		}

	case "rotate":
		key, err := g.db.RotateAPIKey(id)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, key)

	case "reset":
		if err := g.db.ResetAPIKeyUsage(id); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})

	case "acl":
		switch r.Method {
		case http.MethodGet:
			acl, err := g.db.GetAPIKeyACL(id)
			if err != nil {
				dbErrorToStatus(w, err)
				return
			}
			jsonResponse(w, http.StatusOK, acl)

		case http.MethodPut, http.MethodPost:
			body, ok := decodeJSONBody(w, r)
			if !ok {
				return
			}
			acl := database.APIKeyACL{
				APIKeyID:         id,
				DeniedModels:     asString(body["deniedModels"]),
				AllowedProviders: asString(body["allowedProviders"]),
				Notes:            asString(body["notes"]),
			}
			if err := g.db.UpsertAPIKeyACL(acl); err != nil {
				dbErrorToStatus(w, err)
				return
			}
			jsonResponse(w, http.StatusOK, acl)

		default:
			w.Header().Set("Allow", "GET, PUT")
			jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		}

	default:
		jsonError(w, http.StatusNotFound, "unknown key action: "+action, nil)
	}
}

// ---------------------------------------------------------------------------
// Combos
// ---------------------------------------------------------------------------

// handleCombos serves GET/POST /api/combos.
func (g *Gateway) handleCombos(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		combos, err := g.db.ListCombos()
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"combos": combos})

	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		name := strings.TrimSpace(asString(body["name"]))
		models := asSlice(body["models"])
		if name == "" {
			jsonError(w, http.StatusBadRequest, "Name is required", nil)
			return
		}
		if len(models) == 0 {
			jsonError(w, http.StatusBadRequest, "models[] is required", nil)
			return
		}

		encoded, err := json.Marshal(models)
		if err != nil {
			jsonError(w, http.StatusBadRequest, "models must be JSON-serialisable", err)
			return
		}
		combo, err := g.db.CreateCombo(database.Combo{
			Name:          name,
			Kind:          asString(body["kind"]),
			Models:        string(encoded),
			ContextWindow: asInt(body["contextWindow"]),
		})
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, combo)

	default:
		w.Header().Set("Allow", "GET, POST")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// handleComboByID serves /api/combos/{id}.
func (g *Gateway) handleComboByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/combos/"), "/")
	if id == "" {
		jsonError(w, http.StatusBadRequest, "Missing combo id", nil)
		return
	}

	switch r.Method {
	case http.MethodGet:
		combo, err := g.db.FindCombo(id)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, combo)

	case http.MethodPatch, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		if models, present := body["models"]; present {
			encoded, err := json.Marshal(asSlice(models))
			if err != nil {
				jsonError(w, http.StatusBadRequest, "models must be JSON-serialisable", err)
				return
			}
			body["models"] = string(encoded)
		}
		combo, err := g.db.UpdateCombo(id, body)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, combo)

	case http.MethodDelete:
		if err := g.db.DeleteCombo(id); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})

	default:
		w.Header().Set("Allow", "GET, PATCH, DELETE")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

// handleUsage serves /api/usage/{view}.
func (g *Gateway) handleUsage(w http.ResponseWriter, r *http.Request) {
	view := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/usage/"), "/")
	query := r.URL.Query()
	period := query.Get("period")
	if period == "" {
		period = "7d"
	}
	provider := query.Get("provider")
	model := query.Get("model")

	switch view {
	case "stats":
		totals, err := g.db.UsageStats(period, provider, model)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"period":           period,
			"requests":         totals.Requests,
			"promptTokens":     totals.PromptTokens,
			"completionTokens": totals.CompletionTokens,
			"totalTokens":      totals.TotalTokens,
			"cost":             totals.Cost,
		})

	case "history":
		rows, err := g.db.UsageHistoryPage(period, provider, model, asIntDefault(query.Get("limit"), 100))
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"history": rows, "period": period})

	case "providers":
		rows, err := g.db.UsageGrouped(period, "provider")
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"providers": rows})

	case "models":
		rows, err := g.db.UsageGrouped(period, "model")
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"models": rows})

	case "api-keys":
		rows, err := g.db.UsageGrouped(period, "apiKey")
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"apiKeys": rows})

	case "chart":
		series, err := g.db.UsageDailySeries(asIntDefault(query.Get("days"), 30))
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"series": series})

	case "errors":
		rows, err := g.db.UsageErrors(asIntDefault(query.Get("limit"), 50))
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"errors": rows})

	default:
		jsonError(w, http.StatusNotFound, "unknown usage view: "+view, nil)
	}
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// handleSettings serves GET/PATCH /api/settings and the history/rollback views.
func (g *Gateway) handleSettings(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/settings"), "/")

	switch rest {
	case "history":
		rows, err := g.db.SettingsHistory(20)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"history": rows})
		return

	case "rollback":
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		snapshotID := asString(body["id"])
		if snapshotID == "" {
			jsonError(w, http.StatusBadRequest, "Missing snapshot id", nil)
			return
		}
		restored, err := g.db.RollbackSettings(snapshotID)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, restored)
		return
	}

	switch r.Method {
	case http.MethodGet:
		settings, err := g.db.GetSettings()
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, settings)

	case http.MethodPatch, http.MethodPut, http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		merged, err := g.db.SaveSettings(body, "go-core", asString(body["_reason"]))
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, merged)

	default:
		w.Header().Set("Allow", "GET, PATCH")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// ---------------------------------------------------------------------------
// Vouchers & notifications
// ---------------------------------------------------------------------------

// handleVouchers serves GET/POST /api/vouchers and DELETE /api/vouchers/{id}.
func (g *Gateway) handleVouchers(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/vouchers"), "/")

	if rest != "" && r.Method == http.MethodDelete {
		if err := g.db.DeleteVoucher(rest); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})
		return
	}

	switch r.Method {
	case http.MethodGet:
		vouchers, err := g.db.ListVouchers()
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"vouchers": vouchers})

	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		if asString(body["name"]) == "" {
			jsonError(w, http.StatusBadRequest, "Name is required", nil)
			return
		}
		voucher, err := g.db.CreateVoucher(body)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, voucher)

	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// handleNotifications serves GET/POST/DELETE /api/notifications.
func (g *Gateway) handleNotifications(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		includeCleared := r.URL.Query().Get("cleared") == "1"
		rows, err := g.db.ListNotifications(includeCleared)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"notifications": rows})

	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		if err := g.db.MarkNotificationsRead(asStringSlice(body["ids"])); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})

	case http.MethodDelete:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		if err := g.db.ClearNotifications(asStringSlice(body["ids"])); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})

	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// ---------------------------------------------------------------------------
// Model overrides (aliases, custom models, disabled models)
// ---------------------------------------------------------------------------

// kvScope names must match the Node repositories exactly, or the dashboard writes
// under one scope and the router reads another.
const (
	scopeModelAliases  = "modelAliases"
	scopeCustomModels  = "customModels"
	scopeDisabledModel = "disabledModels"
)

// handleModelAliases serves GET/PUT/DELETE /api/models/alias.
func (g *Gateway) handleModelAliases(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		aliases, err := g.db.ListKVScope(scopeModelAliases)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"aliases": aliases})

	case http.MethodPut, http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		alias := asString(body["alias"])
		model := asString(body["model"])
		if alias == "" || model == "" {
			jsonError(w, http.StatusBadRequest, "Model and alias required", nil)
			return
		}
		if err := g.db.PutKV(scopeModelAliases, alias, model); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"alias": alias, "model": model})

	case http.MethodDelete:
		alias := r.URL.Query().Get("alias")
		if alias == "" {
			body, ok := decodeJSONBody(w, r)
			if !ok {
				return
			}
			alias = asString(body["alias"])
		}
		if alias == "" {
			jsonError(w, http.StatusBadRequest, "Missing alias", nil)
			return
		}
		if _, err := g.db.ExecRaw("DELETE FROM kv WHERE scope = ? AND key = ?", scopeModelAliases, alias); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})

	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// handleCustomModels serves GET/POST/DELETE /api/models/custom. The Node repo keys
// each entry as `providerAlias|id|type` and stores the full model object.
func (g *Gateway) handleCustomModels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		raw, err := g.db.ListKVScope(scopeCustomModels)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		models := make([]any, 0, len(raw))
		for _, value := range raw {
			var decoded any
			if err := json.Unmarshal([]byte(value), &decoded); err == nil {
				models = append(models, decoded)
			}
		}
		jsonResponse(w, http.StatusOK, map[string]any{"models": models})

	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		providerAlias := asString(body["providerAlias"])
		id := asString(body["id"])
		kind := firstNonEmpty(asString(body["type"]), "llm")
		if providerAlias == "" || id == "" {
			jsonError(w, http.StatusBadRequest, "providerAlias and id are required", nil)
			return
		}
		encoded, err := json.Marshal(body)
		if err != nil {
			jsonError(w, http.StatusBadRequest, "model must be JSON-serialisable", err)
			return
		}
		if err := g.db.PutKV(scopeCustomModels, providerAlias+"|"+id+"|"+kind, string(encoded)); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, body)

	case http.MethodDelete:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		providerAlias := asString(body["providerAlias"])
		id := asString(body["id"])
		kind := firstNonEmpty(asString(body["type"]), "llm")
		if providerAlias == "" || id == "" {
			jsonError(w, http.StatusBadRequest, "providerAlias and id are required", nil)
			return
		}
		if _, err := g.db.ExecRaw("DELETE FROM kv WHERE scope = ? AND key = ?",
			scopeCustomModels, providerAlias+"|"+id+"|"+kind); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})

	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// handleDisabledModels serves GET/POST/DELETE /api/models/disabled. Each row is a
// provider alias mapped to the list of disabled model ids, merged on write so two
// dashboard tabs cannot clobber each other.
func (g *Gateway) handleDisabledModels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		raw, err := g.db.ListKVScope(scopeDisabledModel)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		disabled := make(map[string]any, len(raw))
		for providerAlias, value := range raw {
			var ids []any
			if err := json.Unmarshal([]byte(value), &ids); err == nil {
				disabled[providerAlias] = ids
			}
		}
		if alias := r.URL.Query().Get("providerAlias"); alias != "" {
			if ids, ok := disabled[alias]; ok {
				jsonResponse(w, http.StatusOK, map[string]any{"ids": ids})
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"ids": []any{}})
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"disabled": disabled})

	case http.MethodPost, http.MethodDelete:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		providerAlias := asString(body["providerAlias"])
		ids := asStringSlice(body["ids"])
		if providerAlias == "" {
			jsonError(w, http.StatusBadRequest, "providerAlias is required", nil)
			return
		}

		current, err := g.db.GetKV(scopeDisabledModel, providerAlias)
		if err != nil && !errors.Is(err, database.ErrNotFound) {
			dbErrorToStatus(w, err)
			return
		}
		var existing []string
		if current != "" {
			_ = json.Unmarshal([]byte(current), &existing)
		}

		next := mergeIDs(existing, ids, r.Method == http.MethodDelete)
		encoded, err := json.Marshal(next)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "could not serialise disabled ids", err)
			return
		}
		if err := g.db.PutKV(scopeDisabledModel, providerAlias, string(encoded)); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"providerAlias": providerAlias, "ids": next})

	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// mergeIDs adds or removes ids from the stored list, preserving order.
func mergeIDs(existing, delta []string, remove bool) []string {
	seen := make(map[string]bool, len(existing)+len(delta))
	out := make([]string, 0, len(existing)+len(delta))

	for _, id := range existing {
		if seen[id] {
			continue
		}
		if remove {
			skip := false
			for _, drop := range delta {
				if drop == id {
					skip = true
					break
				}
			}
			if skip {
				continue
			}
		}
		seen[id] = true
		out = append(out, id)
	}
	if !remove {
		for _, id := range delta {
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// handleVersion serves GET /api/version, which the dashboard footer reads.
func (g *Gateway) handleVersion(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, http.StatusOK, map[string]any{
		"version": g.cfg.Version,
		"engine":  "golang",
	})
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func asMapValue(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asStringSlice(v any) []string {
	raw, ok := v.([]any)
	if !ok {
		if single, ok := v.(string); ok && single != "" {
			return []string{single}
		}
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

func asInt(v any) int {
	switch value := v.(type) {
	case float64:
		return int(value)
	case int:
		return value
	case int64:
		return int(value)
	case string:
		out, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil {
			return 0
		}
		return out
	default:
		return 0
	}
}

// asIntDefault parses a query-string integer.
func asIntDefault(raw string, fallback int) int {
	if raw == "" {
		return fallback
	}
	value := 0
	for _, ch := range raw {
		if ch < '0' || ch > '9' {
			return fallback
		}
		value = value*10 + int(ch-'0')
		if value > 100000 {
			return fallback
		}
	}
	if value == 0 {
		return fallback
	}
	return value
}

func marshalOr(v any, fallback string) string {
	if v == nil {
		return fallback
	}
	encoded, err := json.Marshal(v)
	if err != nil {
		return fallback
	}
	return string(encoded)
}
