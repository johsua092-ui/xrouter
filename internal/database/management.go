package database

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Management repositories: the dashboard's own data (API keys, combos, usage,
// settings, vouchers, notifications) read from and written to the same SQLite
// file the Node service uses.
//
// Every query here is written against the schema the Node migrations already
// created, not a Go-invented one, so a cutover in either direction keeps a single
// source of truth. Rows are returned as the dashboard expects them: JSON columns
// stay strings on the way out because the client parses them itself, and writing
// stores them back as JSON text.

// ErrNotFound is returned by the Get*/Update* helpers when the row is absent.
var ErrNotFound = errors.New("not found")

// nowISO is the timestamp format the Node layer writes.
func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// queryMaps runs a read-only query and returns each row as a column→value map.
// Scanning into `any` keeps the helper usable for tables whose column set differs
// (usageHistory has grown twice), instead of one struct per table.
func (d *DB) queryMaps(query string, args ...any) ([]map[string]any, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	rows, err := d.sqlDB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}

	out := make([]map[string]any, 0, 16)
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(columns))
		for i, name := range columns {
			switch v := values[i].(type) {
			case []byte:
				row[name] = string(v)
			default:
				row[name] = v
			}
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// ExecQueryMaps runs a read query and returns column→value rows. Exported for the
// connection/proxy-pool plane, which addresses the same tables directly.
func (d *DB) ExecQueryMaps(query string, args ...any) ([]map[string]any, error) {
	return d.queryMaps(query, args...)
}

// ExecQueryMap returns the first row, or (nil, nil) when the query matched nothing.
func (d *DB) ExecQueryMap(query string, args ...any) (map[string]any, error) {
	rows, err := d.queryMaps(query, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return rows[0], nil
}

// ExecRaw runs a parameterised write against the shared database. It exists for
// the few management paths that need a delete or update without a typed helper.
func (d *DB) ExecRaw(query string, args ...any) (sql.Result, error) {
	return d.exec(query, args...)
}

// exec runs a write statement.
func (d *DB) exec(query string, args ...any) (sql.Result, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.sqlDB.Exec(query, args...)
}

// FindAPIKeyBySecret looks a key up by its secret value, which is how "sign in
// with an API key" resolves a caller. (nil, nil) means unknown.
func (d *DB) FindAPIKeyBySecret(secret string) (*APIKey, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil, nil
	}
	rows, err := d.queryMaps(`SELECT id,key,name,machineId,isActive,createdAt,tokenLimit,usedTokens,
		resetInterval,lastResetAt,allowedModels,rpmLimit,tpmLimit,ipWhitelist,expiresAt,systemPrompt,
		permissions,createdBy FROM apiKeys WHERE key = ? LIMIT 1`, secret)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	keys := keysFromRows(rows)
	return &keys[0], nil
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

// APIKey is one dashboard credential. The JSON tags mirror the Node repo so the
// dashboard's existing client code reads the Go response unchanged.
type APIKey struct {
	ID            string `json:"id"`
	Key           string `json:"key"`
	Name          string `json:"name"`
	MachineID     string `json:"machineId"`
	IsActive      bool   `json:"isActive"`
	CreatedAt     string `json:"createdAt"`
	TokenLimit    int64  `json:"tokenLimit"`
	UsedTokens    int64  `json:"usedTokens"`
	ResetInterval string `json:"resetInterval"`
	LastResetAt   string `json:"lastResetAt"`
	AllowedModels string `json:"allowedModels"`
	RPMLimit      int    `json:"rpmLimit"`
	TPMLimit      int    `json:"tpmLimit"`
	IPWhitelist   string `json:"ipWhitelist"`
	ExpiresAt     string `json:"expiresAt"`
	SystemPrompt  string `json:"systemPrompt"`
	Permissions   string `json:"permissions"`
	CreatedBy     string `json:"createdBy"`
}

// GenerateAPIKey mints a credential in the Node format: an `sk-` prefix followed
// by 48 hex characters (24 random bytes).
func GenerateAPIKey() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "sk-" + hex.EncodeToString(buf), nil
}

// newID mints a uuid-shaped id without pulling in a dependency.
func newID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	h := hex.EncodeToString(buf)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// ListAPIKeys returns every key, oldest first, which is the order the dashboard
// renders and therefore the order it diffs against.
func (d *DB) ListAPIKeys() ([]APIKey, error) {
	rows, err := d.queryMaps(`SELECT id,key,name,machineId,isActive,createdAt,tokenLimit,usedTokens,
		resetInterval,lastResetAt,allowedModels,rpmLimit,tpmLimit,ipWhitelist,expiresAt,systemPrompt,
		permissions,createdBy FROM apiKeys ORDER BY createdAt ASC`)
	if err != nil {
		return nil, err
	}

	return keysFromRows(rows), nil
}

// keysFromRows maps apiKeys rows onto the APIKey struct.
func keysFromRows(rows []map[string]any) []APIKey {
	keys := make([]APIKey, 0, len(rows))
	for _, row := range rows {
		keys = append(keys, APIKey{
			ID:            asStr(row["id"]),
			Key:           asStr(row["key"]),
			Name:          asStr(row["name"]),
			MachineID:     asStr(row["machineId"]),
			IsActive:      asInt64(row["isActive"]) != 0,
			CreatedAt:     asStr(row["createdAt"]),
			TokenLimit:    asInt64(row["tokenLimit"]),
			UsedTokens:    asInt64(row["usedTokens"]),
			ResetInterval: asStr(row["resetInterval"]),
			LastResetAt:   asStr(row["lastResetAt"]),
			AllowedModels: asStr(row["allowedModels"]),
			RPMLimit:      int(asInt64(row["rpmLimit"])),
			TPMLimit:      int(asInt64(row["tpmLimit"])),
			IPWhitelist:   asStr(row["ipWhitelist"]),
			ExpiresAt:     asStr(row["expiresAt"]),
			SystemPrompt:  asStr(row["systemPrompt"]),
			Permissions:   asStr(row["permissions"]),
			CreatedBy:     asStr(row["createdBy"]),
		})
	}
	return keys
}

// FindAPIKey looks a key up by id or by the secret itself, because the dashboard
// addresses keys by id while authentication only has the secret.
func (d *DB) FindAPIKey(idOrKey string) (*APIKey, error) {
	keys, err := d.ListAPIKeys()
	if err != nil {
		return nil, err
	}
	for i := range keys {
		if keys[i].ID == idOrKey || keys[i].Key == idOrKey {
			return &keys[i], nil
		}
	}
	return nil, ErrNotFound
}

// CreateAPIKey inserts a key. The caller supplies the secret so a bulk import can
// reuse keys that already exist upstream.
func (d *DB) CreateAPIKey(key APIKey) (*APIKey, error) {
	if key.ID == "" {
		key.ID = newID()
	}
	if key.Key == "" {
		generated, err := GenerateAPIKey()
		if err != nil {
			return nil, err
		}
		key.Key = generated
	}
	if key.CreatedAt == "" {
		key.CreatedAt = nowISO()
	}
	if key.ResetInterval == "" {
		key.ResetInterval = "never"
	}
	if key.AllowedModels == "" {
		key.AllowedModels = "*"
	}

	_, err := d.exec(`INSERT INTO apiKeys (id,key,name,machineId,isActive,createdAt,tokenLimit,usedTokens,
		resetInterval,lastResetAt,allowedModels,rpmLimit,tpmLimit,ipWhitelist,expiresAt,systemPrompt,
		permissions,createdBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		key.ID, key.Key, key.Name, key.MachineID, boolToInt(key.IsActive), key.CreatedAt,
		key.TokenLimit, key.UsedTokens, key.ResetInterval, key.LastResetAt, key.AllowedModels,
		key.RPMLimit, key.TPMLimit, key.IPWhitelist, key.ExpiresAt, key.SystemPrompt,
		key.Permissions, key.CreatedBy)
	if err != nil {
		return nil, err
	}
	return &key, nil
}

// UpdateAPIKey writes the mutable fields of an existing key. Nil fields are left
// untouched, so a partial PATCH from the dashboard cannot blank a column it did
// not mention.
func (d *DB) UpdateAPIKey(id string, patch map[string]any) (*APIKey, error) {
	existing, err := d.FindAPIKey(id)
	if err != nil {
		return nil, err
	}

	columnFor := map[string]string{
		"name": "name", "isActive": "isActive", "tokenLimit": "tokenLimit",
		"resetInterval": "resetInterval", "allowedModels": "allowedModels",
		"rpmLimit": "rpmLimit", "tpmLimit": "tpmLimit", "ipWhitelist": "ipWhitelist",
		"expiresAt": "expiresAt", "systemPrompt": "systemPrompt",
		"permissions": "permissions", "usedTokens": "usedTokens",
	}

	sets := make([]string, 0, len(patch))
	args := make([]any, 0, len(patch)+1)
	for field, value := range patch {
		column, ok := columnFor[field]
		if !ok {
			continue
		}
		if field == "isActive" {
			value = boolToInt(asBool(value))
		}
		sets = append(sets, column+" = ?")
		args = append(args, value)
	}
	if len(sets) == 0 {
		return existing, nil
	}
	args = append(args, existing.ID)

	if _, err := d.exec("UPDATE apiKeys SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
		return nil, err
	}
	return d.FindAPIKey(existing.ID)
}

// DeleteAPIKey removes a key and its ACL row.
func (d *DB) DeleteAPIKey(id string) error {
	existing, err := d.FindAPIKey(id)
	if err != nil {
		return err
	}
	if _, err := d.exec("DELETE FROM apiKeyAcls WHERE apiKeyId = ?", existing.ID); err != nil {
		return err
	}
	_, err = d.exec("DELETE FROM apiKeys WHERE id = ?", existing.ID)
	return err
}

// RotateAPIKey replaces the secret and keeps the id, so dashboards and usage rows
// that reference the key stay attached to it.
func (d *DB) RotateAPIKey(id string) (*APIKey, error) {
	existing, err := d.FindAPIKey(id)
	if err != nil {
		return nil, err
	}
	secret, err := GenerateAPIKey()
	if err != nil {
		return nil, err
	}
	if _, err := d.exec("UPDATE apiKeys SET key = ? WHERE id = ?", secret, existing.ID); err != nil {
		return nil, err
	}
	return d.FindAPIKey(existing.ID)
}

// ResetAPIKeyUsage zeroes the token counter, which is what the reset-interval
// sweep does on the Node side.
func (d *DB) ResetAPIKeyUsage(id string) error {
	existing, err := d.FindAPIKey(id)
	if err != nil {
		return err
	}
	_, err = d.exec("UPDATE apiKeys SET usedTokens = 0, lastResetAt = ? WHERE id = ?", nowISO(), existing.ID)
	return err
}

// APIKeyACL is the per-key restriction row.
type APIKeyACL struct {
	APIKeyID         string `json:"apiKeyId"`
	DeniedModels     string `json:"deniedModels"`
	AllowedProviders string `json:"allowedProviders"`
	Notes            string `json:"notes"`
	UpdatedAt        string `json:"updatedAt"`
}

// GetAPIKeyACL returns the ACL row, or an empty one when unset — a key without a
// row is unrestricted, which is different from a key that has been denied
// everything.
func (d *DB) GetAPIKeyACL(apiKeyID string) (*APIKeyACL, error) {
	rows, err := d.queryMaps(`SELECT apiKeyId,deniedModels,allowedProviders,notes,updatedAt
		FROM apiKeyAcls WHERE apiKeyId = ?`, apiKeyID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return &APIKeyACL{APIKeyID: apiKeyID}, nil
	}
	row := rows[0]
	return &APIKeyACL{
		APIKeyID:         asStr(row["apiKeyId"]),
		DeniedModels:     asStr(row["deniedModels"]),
		AllowedProviders: asStr(row["allowedProviders"]),
		Notes:            asStr(row["notes"]),
		UpdatedAt:        asStr(row["updatedAt"]),
	}, nil
}

// UpsertAPIKeyACL writes the restriction row.
func (d *DB) UpsertAPIKeyACL(acl APIKeyACL) error {
	acl.UpdatedAt = nowISO()
	_, err := d.exec(`INSERT INTO apiKeyAcls (apiKeyId,deniedModels,allowedProviders,notes,updatedAt)
		VALUES (?,?,?,?,?)
		ON CONFLICT(apiKeyId) DO UPDATE SET deniedModels=excluded.deniedModels,
		allowedProviders=excluded.allowedProviders, notes=excluded.notes, updatedAt=excluded.updatedAt`,
		acl.APIKeyID, acl.DeniedModels, acl.AllowedProviders, acl.Notes, acl.UpdatedAt)
	return err
}

// ---------------------------------------------------------------------------
// Combos
// ---------------------------------------------------------------------------

// Combo is a named model chain with fallback order.
type Combo struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Kind          string `json:"kind"`
	Models        string `json:"models"`
	ContextWindow int    `json:"contextWindow"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}

// ListCombos returns every combo, name-ordered like the dashboard list.
func (d *DB) ListCombos() ([]Combo, error) {
	rows, err := d.queryMaps(`SELECT id,name,COALESCE(kind,'') AS kind,models,
		COALESCE(contextWindow,0) AS contextWindow,createdAt,updatedAt FROM combos ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	combos := make([]Combo, 0, len(rows))
	for _, row := range rows {
		combos = append(combos, Combo{
			ID:            asStr(row["id"]),
			Name:          asStr(row["name"]),
			Kind:          asStr(row["kind"]),
			Models:        asStr(row["models"]),
			ContextWindow: int(asInt64(row["contextWindow"])),
			CreatedAt:     asStr(row["createdAt"]),
			UpdatedAt:     asStr(row["updatedAt"]),
		})
	}
	return combos, nil
}

// FindCombo resolves a combo by id or by name, since model lookups arrive with the
// name in them.
func (d *DB) FindCombo(idOrName string) (*Combo, error) {
	combos, err := d.ListCombos()
	if err != nil {
		return nil, err
	}
	for i := range combos {
		if combos[i].ID == idOrName || combos[i].Name == idOrName {
			return &combos[i], nil
		}
	}
	return nil, ErrNotFound
}

// CreateCombo inserts a combo. Models is a JSON array string, kept as text so the
// column round-trips exactly what the dashboard wrote.
func (d *DB) CreateCombo(combo Combo) (*Combo, error) {
	if combo.ID == "" {
		combo.ID = newID()
	}
	now := nowISO()
	if combo.CreatedAt == "" {
		combo.CreatedAt = now
	}
	combo.UpdatedAt = now
	if combo.Models == "" {
		combo.Models = "[]"
	}

	_, err := d.exec(`INSERT INTO combos (id,name,kind,models,contextWindow,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?)`,
		combo.ID, combo.Name, combo.Kind, combo.Models, combo.ContextWindow, combo.CreatedAt, combo.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &combo, nil
}

// UpdateCombo patches name, models or context window.
func (d *DB) UpdateCombo(id string, patch map[string]any) (*Combo, error) {
	existing, err := d.FindCombo(id)
	if err != nil {
		return nil, err
	}

	sets := make([]string, 0, 4)
	args := make([]any, 0, 4)
	for field, column := range map[string]string{
		"name": "name", "kind": "kind", "models": "models", "contextWindow": "contextWindow",
	} {
		value, ok := patch[field]
		if !ok {
			continue
		}
		sets = append(sets, column+" = ?")
		args = append(args, value)
	}
	if len(sets) == 0 {
		return existing, nil
	}
	sets = append(sets, "updatedAt = ?")
	args = append(args, nowISO(), existing.ID)

	if _, err := d.exec("UPDATE combos SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
		return nil, err
	}
	return d.FindCombo(existing.ID)
}

// DeleteCombo removes a combo by id or name.
func (d *DB) DeleteCombo(id string) error {
	existing, err := d.FindCombo(id)
	if err != nil {
		return err
	}
	_, err = d.exec("DELETE FROM combos WHERE id = ?", existing.ID)
	return err
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

// usagePeriodStart converts a dashboard period token into a timestamp bound. An
// unknown or empty period means "all time".
func usagePeriodStart(period string) string {
	now := time.Now().UTC()
	var start time.Time
	switch period {
	case "today":
		start = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	case "24h":
		start = now.Add(-24 * time.Hour)
	case "7d":
		start = now.AddDate(0, 0, -7)
	case "30d":
		start = now.AddDate(0, 0, -30)
	case "60d":
		start = now.AddDate(0, 0, -60)
	default:
		return ""
	}
	return start.Format("2006-01-02T15:04:05.000Z")
}

// UsageTotals is the aggregate the overview cards render.
type UsageTotals struct {
	Requests         int64   `json:"requests"`
	PromptTokens     int64   `json:"promptTokens"`
	CompletionTokens int64   `json:"completionTokens"`
	TotalTokens      int64   `json:"totalTokens"`
	Cost             float64 `json:"cost"`
}

// UsageStats aggregates one period, optionally narrowed to a provider or model.
// The WHERE clause is assembled from a fixed column list, never from raw input.
func (d *DB) UsageStats(period, provider, model string) (UsageTotals, error) {
	query := `SELECT COUNT(*) AS requests, COALESCE(SUM(promptTokens),0) AS promptTokens,
		COALESCE(SUM(completionTokens),0) AS completionTokens, COALESCE(SUM(cost),0) AS cost
		FROM usageHistory WHERE 1=1`
	args := make([]any, 0, 3)

	if since := usagePeriodStart(period); since != "" {
		query += " AND timestamp >= ?"
		args = append(args, since)
	}
	if provider != "" {
		query += " AND provider = ?"
		args = append(args, provider)
	}
	if model != "" {
		query += " AND model = ?"
		args = append(args, model)
	}

	rows, err := d.queryMaps(query, args...)
	if err != nil {
		return UsageTotals{}, err
	}
	if len(rows) == 0 {
		return UsageTotals{}, nil
	}
	row := rows[0]
	totals := UsageTotals{
		Requests:         asInt64(row["requests"]),
		PromptTokens:     asInt64(row["promptTokens"]),
		CompletionTokens: asInt64(row["completionTokens"]),
		Cost:             asFloat(row["cost"]),
	}
	totals.TotalTokens = totals.PromptTokens + totals.CompletionTokens
	return totals, nil
}

// UsageHistoryPage returns recent requests, newest first.
func (d *DB) UsageHistoryPage(period, provider, model string, limit int) ([]map[string]any, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	query := `SELECT id,timestamp,provider,model,connectionId,apiKey,endpoint,promptTokens,
		completionTokens,cost,status FROM usageHistory WHERE 1=1`
	args := make([]any, 0, 4)

	if since := usagePeriodStart(period); since != "" {
		query += " AND timestamp >= ?"
		args = append(args, since)
	}
	if provider != "" {
		query += " AND provider = ?"
		args = append(args, provider)
	}
	if model != "" {
		query += " AND model = ?"
		args = append(args, model)
	}
	query += " ORDER BY id DESC LIMIT ?"
	args = append(args, limit)

	return d.queryMaps(query, args...)
}

// UsageGrouped breaks the period down by a whitelisted column. Callers pass a
// logical name, never a column, so this cannot be turned into an injection point.
func (d *DB) UsageGrouped(period, by string) ([]map[string]any, error) {
	columns := map[string]string{"provider": "provider", "model": "model", "apiKey": "apiKey"}
	column, ok := columns[by]
	if !ok {
		return nil, fmt.Errorf("unsupported grouping: %s", by)
	}

	query := `SELECT ` + column + ` AS name, COUNT(*) AS requests,
		COALESCE(SUM(promptTokens),0) AS promptTokens,
		COALESCE(SUM(completionTokens),0) AS completionTokens,
		COALESCE(SUM(cost),0) AS cost
		FROM usageHistory WHERE ` + column + ` != ''`
	args := make([]any, 0, 1)
	if since := usagePeriodStart(period); since != "" {
		query += " AND timestamp >= ?"
		args = append(args, since)
	}
	query += " GROUP BY " + column + " ORDER BY requests DESC"

	rows, err := d.queryMaps(query, args...)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		row["totalTokens"] = asInt64(row["promptTokens"]) + asInt64(row["completionTokens"])
	}
	return rows, nil
}

// UsageDailySeries reads the pre-aggregated day buckets. The Node layer maintains
// this table on every request, so the chart does not have to scan usageHistory.
func (d *DB) UsageDailySeries(days int) ([]map[string]any, error) {
	if days <= 0 || days > 365 {
		days = 30
	}
	rows, err := d.queryMaps("SELECT dateKey,data FROM usageDaily ORDER BY dateKey DESC LIMIT ?", days)
	if err != nil {
		return nil, err
	}

	series := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		var data map[string]any
		if raw := asStr(row["data"]); raw != "" {
			_ = json.Unmarshal([]byte(raw), &data)
		}
		series = append(series, map[string]any{"date": asStr(row["dateKey"]), "data": data})
	}
	return series, nil
}

// UsageErrors lists recent failures, which is what the errors tab renders.
func (d *DB) UsageErrors(limit int) ([]map[string]any, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	return d.queryMaps(`SELECT id,timestamp,provider,model,connectionId,apiKey,endpoint,status
		FROM usageHistory WHERE status IS NOT NULL AND status != 'ok' AND status != ''
		ORDER BY id DESC LIMIT ?`, limit)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// GetSettings returns the settings blob as a decoded object. The table stores one
// row; an empty database answers an empty object rather than an error so the
// dashboard can render defaults.
func (d *DB) GetSettings() (map[string]any, error) {
	rows, err := d.queryMaps("SELECT data FROM settings WHERE id = 1")
	if err != nil {
		return map[string]any{}, err
	}
	if len(rows) == 0 {
		return map[string]any{}, nil
	}
	raw := asStr(rows[0]["data"])
	if raw == "" {
		return map[string]any{}, nil
	}
	out := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return map[string]any{}, err
	}
	return out, nil
}

// SaveSettings deep-merges a patch into the stored blob and pushes the previous
// value onto the history table, so a bad save is always rollback-able.
func (d *DB) SaveSettings(patch map[string]any, actor, reason string) (map[string]any, error) {
	current, err := d.GetSettings()
	if err != nil {
		return nil, err
	}

	previous, err := json.Marshal(current)
	if err != nil {
		return nil, err
	}
	if _, err := d.exec(`INSERT INTO settingsHistory (id,at,actor,reason,snapshot) VALUES (?,?,?,?,?)`,
		newID(), nowISO(), actor, reason, string(previous)); err != nil {
		return nil, err
	}

	merged := deepMerge(current, patch)
	encoded, err := json.Marshal(merged)
	if err != nil {
		return nil, err
	}
	if _, err := d.exec(`INSERT INTO settings (id,data) VALUES (1,?)
		ON CONFLICT(id) DO UPDATE SET data = excluded.data`, string(encoded)); err != nil {
		return nil, err
	}
	return merged, nil
}

// SettingsHistory lists snapshots, newest first.
func (d *DB) SettingsHistory(limit int) ([]map[string]any, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	// rowid breaks timestamp ties: two saves inside the same millisecond would
	// otherwise come back in an arbitrary order and a rollback could pick the
	// wrong snapshot.
	return d.queryMaps(`SELECT rowid AS seq,id,at,actor,reason FROM settingsHistory
		ORDER BY at DESC, rowid DESC LIMIT ?`, limit)
}

// RollbackSettings restores a snapshot by id.
func (d *DB) RollbackSettings(snapshotID string) (map[string]any, error) {
	rows, err := d.queryMaps("SELECT snapshot FROM settingsHistory WHERE id = ?", snapshotID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrNotFound
	}
	raw := asStr(rows[0]["snapshot"])

	restored := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &restored); err != nil {
		return nil, err
	}
	if _, err := d.exec(`INSERT INTO settings (id,data) VALUES (1,?)
		ON CONFLICT(id) DO UPDATE SET data = excluded.data`, raw); err != nil {
		return nil, err
	}
	return restored, nil
}

// deepMerge merges nested objects, which is what a partial settings PATCH means.
// Arrays and scalars replace wholesale — merging them would silently corrupt
// ordered lists such as provider priority.
func deepMerge(base, patch map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(patch))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range patch {
		if childPatch, ok := v.(map[string]any); ok {
			if childBase, ok := out[k].(map[string]any); ok {
				out[k] = deepMerge(childBase, childPatch)
				continue
			}
		}
		out[k] = v
	}
	return out
}

// ---------------------------------------------------------------------------
// Notifications & vouchers
// ---------------------------------------------------------------------------

// ListNotifications returns unread-and-read notifications, newest first.
func (d *DB) ListNotifications(includeCleared bool) ([]map[string]any, error) {
	query := "SELECT id,kind,severity,title,body,link,createdAt,readAt FROM notifications"
	if !includeCleared {
		query += " WHERE clearedAt IS NULL"
	}
	query += " ORDER BY createdAt DESC LIMIT 100"
	return d.queryMaps(query)
}

// MarkNotificationsRead stamps readAt on the listed ids.
func (d *DB) MarkNotificationsRead(ids []string) error {
	if len(ids) == 0 {
		_, err := d.exec("UPDATE notifications SET readAt = ? WHERE readAt IS NULL", nowISO())
		return err
	}
	for _, id := range ids {
		if _, err := d.exec("UPDATE notifications SET readAt = ? WHERE id = ?", nowISO(), id); err != nil {
			return err
		}
	}
	return nil
}

// ClearNotifications hides notifications from the panel without deleting the row.
func (d *DB) ClearNotifications(ids []string) error {
	stamp := nowISO()
	if len(ids) == 0 {
		_, err := d.exec("UPDATE notifications SET clearedAt = ? WHERE clearedAt IS NULL", stamp)
		return err
	}
	for _, id := range ids {
		if _, err := d.exec("UPDATE notifications SET clearedAt = ? WHERE id = ?", stamp, id); err != nil {
			return err
		}
	}
	return nil
}

// ListVouchers returns every voucher, newest first.
func (d *DB) ListVouchers() ([]map[string]any, error) {
	return d.queryMaps(`SELECT id,code,name,description,tokenLimit,allowedModels,rpmLimit,tpmLimit,
		expiresInDays,maxUses,usedCount,isBansos,isActive,createdAt,updatedAt
		FROM vouchers ORDER BY createdAt DESC`)
}

// CreateVoucher inserts a voucher with a short human-readable code.
func (d *DB) CreateVoucher(fields map[string]any) (map[string]any, error) {
	code := asStr(fields["code"])
	if code == "" {
		buf := make([]byte, 5)
		if _, err := rand.Read(buf); err != nil {
			return nil, err
		}
		code = strings.ToUpper(hex.EncodeToString(buf))
	}
	id := newID()
	now := nowISO()

	_, err := d.exec(`INSERT INTO vouchers (id,code,name,description,tokenLimit,allowedModels,rpmLimit,
		tpmLimit,expiresInDays,maxUses,usedCount,isBansos,isActive,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?,?,?,?,0,?,1,?,?)`,
		id, code, asStr(fields["name"]), asStr(fields["description"]),
		intOr(fields["tokenLimit"], 100000), strOr(fields["allowedModels"], "*"),
		intOr(fields["rpmLimit"], 0), intOr(fields["tpmLimit"], 0),
		intOr(fields["expiresInDays"], 30), intOr(fields["maxUses"], 1),
		boolToInt(asBool(fields["isBansos"])), now, now)
	if err != nil {
		return nil, err
	}

	rows, err := d.queryMaps("SELECT * FROM vouchers WHERE id = ?", id)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// DeleteVoucher removes a voucher by id or code.
func (d *DB) DeleteVoucher(idOrCode string) error {
	if _, err := d.exec("DELETE FROM vouchers WHERE id = ? OR code = ?", idOrCode, idOrCode); err != nil {
		return err
	}
	return nil
}

// ---------------------------------------------------------------------------
// kv helpers
// ---------------------------------------------------------------------------

// GetKV reads a namespaced value written by the Node layer (model aliases, custom
// model lists, disabled models).
func (d *DB) GetKV(scope, key string) (string, error) {
	rows, err := d.queryMaps("SELECT value FROM kv WHERE scope = ? AND key = ?", scope, key)
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", ErrNotFound
	}
	return asStr(rows[0]["value"]), nil
}

// PutKV upserts a namespaced value.
func (d *DB) PutKV(scope, key, value string) error {
	_, err := d.exec(`INSERT INTO kv (scope,key,value) VALUES (?,?,?)
		ON CONFLICT(scope,key) DO UPDATE SET value = excluded.value`, scope, key, value)
	return err
}

// ListKVScope returns every key in a scope.
func (d *DB) ListKVScope(scope string) (map[string]string, error) {
	rows, err := d.queryMaps("SELECT key,value FROM kv WHERE scope = ?", scope)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, row := range rows {
		out[asStr(row["key"])] = asStr(row["value"])
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// small coercion helpers
// ---------------------------------------------------------------------------

func asStr(v any) string {
	switch value := v.(type) {
	case nil:
		return ""
	case string:
		return value
	case []byte:
		return string(value)
	default:
		return fmt.Sprintf("%v", value)
	}
}

func asInt64(v any) int64 {
	switch value := v.(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case bool:
		if value {
			return 1
		}
		return 0
	case string:
		var out int64
		_, _ = fmt.Sscanf(value, "%d", &out)
		return out
	default:
		return 0
	}
}

func asFloat(v any) float64 {
	switch value := v.(type) {
	case float64:
		return value
	case int64:
		return float64(value)
	case int:
		return float64(value)
	case string:
		var out float64
		_, _ = fmt.Sscanf(value, "%f", &out)
		return out
	default:
		return 0
	}
}

func asBool(v any) bool {
	switch value := v.(type) {
	case bool:
		return value
	case int64:
		return value != 0
	case float64:
		return value != 0
	case string:
		return value == "true" || value == "1"
	default:
		return false
	}
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func intOr(v any, fallback int) int {
	if v == nil {
		return fallback
	}
	return int(asInt64(v))
}

func strOr(v any, fallback string) string {
	if out := asStr(v); out != "" {
		return out
	}
	return fallback
}
