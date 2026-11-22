package gateway

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/johsua092-ui/xrouter/internal/database"
)

// Providers + proxy pools plane: the dashboard's connection inventory.
//
// Connections live in `providerConnections` as (id, provider, authType, name,
// email, priority, isActive, data JSON). Credentials inside `data` are never
// echoed back: the Node dashboard masks them and the client only ever sends a new
// value when it wants to replace one, so masking here keeps Go responses
// equivalent and stops secrets leaving over HTTP.

// sensitiveDataKeys are the fields that must never appear in a response body.
var sensitiveDataKeys = map[string]bool{
	"apiKey":         true,
	"accessToken":    true,
	"refreshToken":   true,
	"idToken":        true,
	"cookie":         true,
	"cookies":        true,
	"password":       true,
	"secret":         true,
	"clientSecret":   true,
	"sessionToken":   true,
	"bearerToken":    true,
	"privateKey":     true,
	"serviceAccount": true,
	"webCookie":      true,
	"xsrfToken":      true,
	"deviceCode":     true,
}

// maskSecret keeps a recognisable prefix/suffix so an operator can tell two keys
// apart without either one being usable.
func maskSecret(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if database.IsEncrypted(value) {
		return "***"
	}
	if len(value) <= 10 {
		return "***"
	}
	return value[:4] + "..." + value[len(value)-4:]
}

// publicConnection turns a stored row into the dashboard's shape with secrets
// masked and the data JSON parsed.
func publicConnection(row map[string]any) map[string]any {
	out := map[string]any{
		"id":        asString(row["id"]),
		"provider":  asString(row["provider"]),
		"authType":  asString(row["authType"]),
		"name":      asString(row["name"]),
		"email":     asString(row["email"]),
		"priority":  asInt64Default(row["priority"], 0),
		"isActive":  asInt64Default(row["isActive"], 1) != 0,
		"createdAt": asString(row["createdAt"]),
		"updatedAt": asString(row["updatedAt"]),
	}

	data := map[string]any{}
	if raw := asString(row["data"]); raw != "" {
		_ = json.Unmarshal([]byte(raw), &data)
	}
	for key := range data {
		if sensitiveDataKeys[key] {
			data[key] = maskSecret(asString(data[key]))
		}
	}
	out["data"] = data
	if providerSpecific, ok := data["providerSpecificData"].(map[string]any); ok {
		out["providerSpecificData"] = providerSpecific
	}
	return out
}

// handleProviders serves GET (list) and POST (create) on /api/providers.
func (g *Gateway) handleProviders(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, err := g.db.ExecQueryMaps(`SELECT id,provider,authType,name,email,priority,isActive,
			data,createdAt,updatedAt FROM providerConnections ORDER BY provider ASC, priority ASC`)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		connections := make([]map[string]any, 0, len(rows))
		byProvider := map[string]int{}
		for _, row := range rows {
			connections = append(connections, publicConnection(row))
			byProvider[asString(row["provider"])]++
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"connections": connections,
			"count":       len(connections),
			"byProvider":  byProvider,
		})

	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		created, err := g.createConnection(body)
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error(), nil)
			return
		}
		jsonResponse(w, http.StatusCreated, map[string]any{"connection": created})

	default:
		w.Header().Set("Allow", "GET, POST")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// handleProviderByID serves GET/PUT/DELETE on /api/providers/{id}.
func (g *Gateway) handleProviderByID(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		jsonError(w, http.StatusBadRequest, "missing id", nil)
		return
	}

	switch r.Method {
	case http.MethodGet:
		row, err := g.db.ExecQueryMap(`SELECT id,provider,authType,name,email,priority,isActive,
			data,createdAt,updatedAt FROM providerConnections WHERE id = ?`, id)
		if err != nil || row == nil {
			jsonError(w, http.StatusNotFound, "connection not found", nil)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"connection": publicConnection(row)})

	case http.MethodPut, http.MethodPatch:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		updated, err := g.updateConnection(id, body)
		if err != nil {
			status := http.StatusBadRequest
			if err == database.ErrNotFound {
				status = http.StatusNotFound
			}
			jsonError(w, status, err.Error(), nil)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"connection": updated})

	case http.MethodDelete:
		if _, err := g.db.ExecRaw(`DELETE FROM providerConnections WHERE id = ?`, id); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})

	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// createConnection inserts a provider connection, keeping masked placeholders out
// of storage so an unchanged credential never gets overwritten with "***".
func (g *Gateway) createConnection(body map[string]any) (map[string]any, error) {
	provider := strings.TrimSpace(asString(body["provider"]))
	if provider == "" {
		return nil, fmt.Errorf("provider is required")
	}
	authType := strings.TrimSpace(asString(body["authType"]))
	if authType == "" {
		authType = "apikey"
	}

	data := map[string]any{}
	// The dashboard posts credentials at the top level (apiKey, accessToken,
	// baseUrl, ...) while stored rows keep them under data. Fold the documented
	// top-level fields in so a create from either shape behaves the same.
	for _, key := range []string{
		"apiKey", "accessToken", "refreshToken", "idToken", "cookie", "sessionToken",
		"accountId", "email", "baseUrl", "baseURL", "endpoint", "defaultModel",
		"model", "projectId", "region", "organization", "machineId", "expiresAt",
	} {
		value, present := body[key]
		if !present {
			continue
		}
		if _, exists := data[key]; exists {
			continue
		}
		data[key] = value
	}
	if incoming, ok := body["data"].(map[string]any); ok {
		for key, value := range incoming {
			data[key] = value
		}
	}
	if specific, ok := body["providerSpecificData"].(map[string]any); ok {
		data["providerSpecificData"] = specific
	}
	for key := range data {
		if sensitiveDataKeys[key] && looksMasked(asString(data[key])) {
			delete(data, key)
			continue
		}
		// Seal credentials at rest exactly like the dashboard does.
		if sensitiveDataKeys[key] {
			if plain := asString(data[key]); plain != "" {
				sealed, serr := database.Seal(plain)
				if serr != nil {
					return nil, serr
				}
				data[key] = sealed
			}
		}
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}

	id := strings.TrimSpace(asString(body["id"]))
	if id == "" {
		id = newUUID()
	}
	priority := int64(1)
	if raw, ok := body["priority"]; ok {
		priority = asInt64Default(raw, 1)
	}
	active := int64(1)
	if raw, ok := body["isActive"].(bool); ok && !raw {
		active = 0
	}

	now := nowISOString()
	if _, err := g.db.ExecRaw(`INSERT INTO providerConnections
		(id,provider,authType,name,email,priority,isActive,data,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?,?,?,?)`,
		id, provider, authType, asString(body["name"]), asString(body["email"]),
		priority, active, string(encoded), now, now); err != nil {
		return nil, err
	}

	row, err := g.db.ExecQueryMap(`SELECT id,provider,authType,name,email,priority,isActive,
		data,createdAt,updatedAt FROM providerConnections WHERE id = ?`, id)
	if err != nil || row == nil {
		return nil, fmt.Errorf("connection created but could not be read back")
	}
	return publicConnection(row), nil
}

// updateConnection merges a partial update, preserving existing credentials when
// the client echoes a masked value back.
func (g *Gateway) updateConnection(id string, body map[string]any) (map[string]any, error) {
	row, err := g.db.ExecQueryMap(`SELECT data FROM providerConnections WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, database.ErrNotFound
	}

	existing := map[string]any{}
	if raw := asString(row["data"]); raw != "" {
		_ = json.Unmarshal([]byte(raw), &existing)
	}
	if incoming, ok := body["data"].(map[string]any); ok {
		for key, value := range incoming {
			if sensitiveDataKeys[key] && looksMasked(asString(value)) {
				continue
			}
			existing[key] = value
		}
	}
	if specific, ok := body["providerSpecificData"].(map[string]any); ok {
		existing["providerSpecificData"] = mergeMaps(existing["providerSpecificData"], specific)
	}
	encoded, err := json.Marshal(existing)
	if err != nil {
		return nil, err
	}

	sets := []string{"data = ?", "updatedAt = ?"}
	args := []any{string(encoded), nowISOString()}
	for column, key := range map[string]string{
		"name": "name", "email": "email", "authType": "authType", "provider": "provider",
	} {
		if raw, present := body[key]; present {
			sets = append(sets, column+" = ?")
			args = append(args, asString(raw))
		}
	}
	if raw, present := body["priority"]; present {
		sets = append(sets, "priority = ?")
		args = append(args, asInt64Default(raw, 1))
	}
	if raw, present := body["isActive"].(bool); present {
		active := int64(0)
		if raw {
			active = 1
		}
		sets = append(sets, "isActive = ?")
		args = append(args, active)
	}
	args = append(args, id)
	if _, err := g.db.ExecRaw("UPDATE providerConnections SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
		return nil, err
	}

	updated, err := g.db.ExecQueryMap(`SELECT id,provider,authType,name,email,priority,isActive,
		data,createdAt,updatedAt FROM providerConnections WHERE id = ?`, id)
	if err != nil || updated == nil {
		return nil, database.ErrNotFound
	}
	return publicConnection(updated), nil
}

// handleProviderModels serves GET /api/providers/{id}/models from the generated
// catalogue, not a hardcoded list.
func (g *Gateway) handleProviderModels(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	row, err := g.db.ExecQueryMap(`SELECT provider FROM providerConnections WHERE id = ?`, id)
	if err != nil || row == nil {
		jsonError(w, http.StatusNotFound, "connection not found", nil)
		return
	}
	models := g.catalog.Models(asString(row["provider"]))
	ids := make([]string, 0, len(models))
	for _, model := range models {
		id := model.ID
		if id == "" {
			id = model.Name
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	jsonResponse(w, http.StatusOK, map[string]any{
		"provider": asString(row["provider"]),
		"models":   ids,
		"count":    len(ids),
	})
}

// handleProvidersBulk serves POST /api/providers/bulk: import many connections in
// one call, reporting per-row failures instead of aborting the batch.
func (g *Gateway) handleProvidersBulk(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	raw, _ := body["connections"].([]any)
	created := make([]map[string]any, 0, len(raw))
	failed := make([]map[string]any, 0)
	for index, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			failed = append(failed, map[string]any{"index": index, "error": "invalid entry"})
			continue
		}
		connection, err := g.createConnection(entry)
		if err != nil {
			failed = append(failed, map[string]any{"index": index, "error": err.Error()})
			continue
		}
		created = append(created, connection)
	}
	status := http.StatusCreated
	if len(created) == 0 && len(failed) > 0 {
		status = http.StatusBadRequest
	}
	jsonResponse(w, status, map[string]any{
		"created":     len(created),
		"failed":      failed,
		"connections": created,
	})
}

// handleProxyPools serves /api/proxy-pools (list + create).
func (g *Gateway) handleProxyPools(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, err := g.db.ExecQueryMaps(`SELECT id,isActive,testStatus,data,createdAt,updatedAt
			FROM proxyPools ORDER BY createdAt ASC`)
		if err != nil {
			dbErrorToStatus(w, err)
			return
		}
		pools := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			pools = append(pools, publicProxyPool(row))
		}
		jsonResponse(w, http.StatusOK, map[string]any{"pools": pools, "count": len(pools)})

	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		pool, err := g.createProxyPool(body)
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error(), nil)
			return
		}
		jsonResponse(w, http.StatusCreated, map[string]any{"pool": pool})

	default:
		w.Header().Set("Allow", "GET, POST")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// handleProxyPoolByID serves GET/PUT/DELETE on /api/proxy-pools/{id}.
func (g *Gateway) handleProxyPoolByID(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	switch r.Method {
	case http.MethodGet:
		row, err := g.db.ExecQueryMap(`SELECT id,isActive,testStatus,data,createdAt,updatedAt
			FROM proxyPools WHERE id = ?`, id)
		if err != nil || row == nil {
			jsonError(w, http.StatusNotFound, "proxy pool not found", nil)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"pool": publicProxyPool(row)})

	case http.MethodPut, http.MethodPatch:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		row, err := g.db.ExecQueryMap(`SELECT data FROM proxyPools WHERE id = ?`, id)
		if err != nil || row == nil {
			jsonError(w, http.StatusNotFound, "proxy pool not found", nil)
			return
		}
		data := map[string]any{}
		if raw := asString(row["data"]); raw != "" {
			_ = json.Unmarshal([]byte(raw), &data)
		}
		for key, value := range body {
			if key == "id" || key == "isActive" {
				continue
			}
			data[key] = value
		}
		encoded, err := json.Marshal(data)
		if err != nil {
			jsonError(w, http.StatusBadRequest, "could not encode pool", err)
			return
		}
		active := int64(1)
		if raw, present := body["isActive"].(bool); present && !raw {
			active = 0
		}
		if _, err := g.db.ExecRaw(`UPDATE proxyPools SET data = ?, isActive = ?, updatedAt = ? WHERE id = ?`,
			string(encoded), active, nowISOString(), id); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		updated, _ := g.db.ExecQueryMap(`SELECT id,isActive,testStatus,data,createdAt,updatedAt
			FROM proxyPools WHERE id = ?`, id)
		jsonResponse(w, http.StatusOK, map[string]any{"pool": publicProxyPool(updated)})

	case http.MethodDelete:
		if _, err := g.db.ExecRaw(`DELETE FROM proxyPools WHERE id = ?`, id); err != nil {
			dbErrorToStatus(w, err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})

	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// createProxyPool stores a pool; the URL lives inside the data blob like the Node
// repo writes it.
func (g *Gateway) createProxyPool(body map[string]any) (map[string]any, error) {
	name := strings.TrimSpace(asString(body["name"]))
	if name == "" {
		return nil, fmt.Errorf("name is required")
	}
	proxyURL := strings.TrimSpace(asString(body["proxyUrl"]))
	if proxyURL == "" {
		return nil, fmt.Errorf("proxyUrl is required")
	}

	data := map[string]any{
		"name":        name,
		"proxyUrl":    proxyURL,
		"noProxy":     asString(body["noProxy"]),
		"strictProxy": body["strictProxy"] == true,
		"type":        defaultString(asString(body["type"]), "http"),
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	id := newUUID()
	now := nowISOString()
	active := int64(1)
	if raw, present := body["isActive"].(bool); present && !raw {
		active = 0
	}
	if _, err := g.db.ExecRaw(`INSERT INTO proxyPools (id,isActive,data,createdAt,updatedAt)
		VALUES (?,?,?,?,?)`, id, active, string(encoded), now, now); err != nil {
		return nil, err
	}
	row, err := g.db.ExecQueryMap(`SELECT id,isActive,testStatus,data,createdAt,updatedAt
		FROM proxyPools WHERE id = ?`, id)
	if err != nil || row == nil {
		return nil, fmt.Errorf("pool created but could not be read back")
	}
	return publicProxyPool(row), nil
}

// newUUID returns a v4 UUID string for ids the dashboard expects in that shape.
func newUUID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(buf)
	return hexed[0:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:32]
}

// publicProxyPool flattens the data blob for the dashboard while masking proxy
// credentials embedded in the URL.
func publicProxyPool(row map[string]any) map[string]any {
	if row == nil {
		return nil
	}
	data := map[string]any{}
	if raw := asString(row["data"]); raw != "" {
		_ = json.Unmarshal([]byte(raw), &data)
	}
	out := map[string]any{
		"id":         asString(row["id"]),
		"isActive":   asInt64Default(row["isActive"], 1) != 0,
		"testStatus": asString(row["testStatus"]),
		"createdAt":  asString(row["createdAt"]),
		"updatedAt":  asString(row["updatedAt"]),
	}
	for key, value := range data {
		if key == "proxyUrl" {
			out[key] = maskProxyURL(asString(value))
			continue
		}
		out[key] = value
	}
	return out
}

// maskProxyURL hides user:pass inside a proxy URL.
func maskProxyURL(raw string) string {
	at := strings.LastIndex(raw, "@")
	if at < 0 {
		return raw
	}
	schemeEnd := strings.Index(raw, "://")
	if schemeEnd < 0 || schemeEnd+3 >= at {
		return raw
	}
	return raw[:schemeEnd+3] + "***@" + raw[at+1:]
}

// looksMasked reports whether a value is one of our masked placeholders, so a
// round-trip PUT cannot overwrite a live credential with asterisks.
func looksMasked(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	if value == "***" {
		return true
	}
	return strings.Contains(value, "...") && len(value) < 40
}

func mergeMaps(existing any, incoming map[string]any) map[string]any {
	out := map[string]any{}
	if current, ok := existing.(map[string]any); ok {
		for key, value := range current {
			out[key] = value
		}
	}
	for key, value := range incoming {
		out[key] = value
	}
	return out
}

func nowISOString() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func asInt64Default(value any, fallback int64) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	case bool:
		if typed {
			return 1
		}
		return 0
	default:
		return fallback
	}
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
