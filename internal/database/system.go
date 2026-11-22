package database

// system.go covers the operational tables the dashboard reads: notifications
// created by the Go engine, IP bans, security events, runtime provider nodes and
// the voucher claim path. All of them are the same rows the Node handlers use,
// so a ban set from either engine is enforced by both.

import (
	"encoding/json"
	"errors"
	"time"
)

// CreateNotification writes one dashboard notification. Empty kind falls back to
// "system" so the panel always has a bucket to render.
func (d *DB) CreateNotification(kind, severity, title, body, link string) (string, error) {
	if kind == "" {
		kind = "system"
	}
	if severity == "" {
		severity = "info"
	}
	id := newID()
	_, err := d.exec(`INSERT INTO notifications (id,kind,severity,title,body,link,createdAt)
		VALUES (?,?,?,?,?,?,?)`, id, kind, severity, title, body, link, nowISO())
	if err != nil {
		return "", err
	}
	return id, nil
}

// ClearNotificationByKind drops older rows of one kind, which is how the scanner
// avoids stacking the same "update available" card every run.
func (d *DB) ClearNotificationByKind(kind string) error {
	_, err := d.exec("DELETE FROM notifications WHERE kind = ?", kind)
	return err
}

// ------------------------------------------------------------------- ip bans

// ListIPBans returns active and historical bans, newest first.
func (d *DB) ListIPBans(limit int) ([]map[string]any, error) {
	if limit <= 0 {
		limit = 200
	}
	return d.queryMaps(`SELECT ip,reason,failedAttempts,banStartedAt,COALESCE(banExpiresAt,'') AS banExpiresAt,
		COALESCE(notes,'') AS notes,createdAt FROM ipBans ORDER BY createdAt DESC LIMIT ?`, limit)
}

// BanIP upserts a ban. hours <= 0 means permanent.
func (d *DB) BanIP(ip, reason, notes string, hours int) error {
	if ip == "" {
		return errors.New("ip is required")
	}
	if reason == "" {
		reason = "manual"
	}
	expires := ""
	if hours > 0 {
		expires = time.Now().UTC().Add(time.Duration(hours) * time.Hour).Format(time.RFC3339)
	}
	stamp := nowISO()
	_, err := d.exec(`INSERT INTO ipBans (ip,reason,failedAttempts,banStartedAt,banExpiresAt,notes,createdAt)
		VALUES (?,?,1,?,?,?,?)
		ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, banStartedAt = excluded.banStartedAt,
			banExpiresAt = excluded.banExpiresAt, notes = excluded.notes`,
		ip, reason, stamp, expires, notes, stamp)
	return err
}

// UnbanIP removes a ban row.
func (d *DB) UnbanIP(ip string) (bool, error) {
	res, err := d.exec("DELETE FROM ipBans WHERE ip = ?", ip)
	if err != nil {
		return false, err
	}
	affected, _ := res.RowsAffected()
	return affected > 0, nil
}

// IsIPBanned reports whether a non-expired ban covers the address.
func (d *DB) IsIPBanned(ip string) (bool, error) {
	rows, err := d.queryMaps("SELECT COALESCE(banExpiresAt,'') AS banExpiresAt FROM ipBans WHERE ip = ?", ip)
	if err != nil || len(rows) == 0 {
		return false, err
	}
	expires := asStr(rows[0]["banExpiresAt"])
	if expires == "" {
		return true, nil
	}
	deadline, parseErr := time.Parse(time.RFC3339, expires)
	if parseErr != nil {
		return true, nil
	}
	return time.Now().UTC().Before(deadline), nil
}

// ------------------------------------------------------------ security events

// RecordSecurityEvent appends one audit row.
func (d *DB) RecordSecurityEvent(kind, severity, ip, actor, method, path, detail, userAgent string, status int) error {
	if severity == "" {
		severity = "info"
	}
	if kind == "" {
		kind = "event"
	}
	_, err := d.exec(`INSERT INTO securityEvents (at,type,severity,ip,actor,method,path,status,detail,userAgent)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, nowISO(), kind, severity, ip, actor, method, path, status, detail, userAgent)
	return err
}

// ListSecurityEvents returns recent audit rows, newest first.
func (d *DB) ListSecurityEvents(limit int) ([]map[string]any, error) {
	if limit <= 0 {
		limit = 100
	}
	return d.queryMaps(`SELECT id,at,type,severity,ip,COALESCE(actor,'') AS actor,COALESCE(method,'') AS method,
		COALESCE(path,'') AS path,COALESCE(status,0) AS status,COALESCE(detail,'') AS detail,
		COALESCE(userAgent,'') AS userAgent FROM securityEvents ORDER BY at DESC LIMIT ?`, limit)
}

// ------------------------------------------------------------ provider nodes

// ProviderNode is a runtime OpenAI-compatible endpoint added from the dashboard.
type ProviderNode struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	Name      string         `json:"name"`
	Data      map[string]any `json:"data"`
	CreatedAt string         `json:"createdAt"`
	UpdatedAt string         `json:"updatedAt"`
}

// ListProviderNodes returns every node with its data blob decoded.
func (d *DB) ListProviderNodes() ([]ProviderNode, error) {
	rows, err := d.queryMaps(`SELECT id,COALESCE(type,'') AS type,COALESCE(name,'') AS name,data,createdAt,updatedAt
		FROM providerNodes ORDER BY createdAt ASC`)
	if err != nil {
		return nil, err
	}
	out := make([]ProviderNode, 0, len(rows))
	for _, row := range rows {
		node := ProviderNode{
			ID:        asStr(row["id"]),
			Type:      asStr(row["type"]),
			Name:      asStr(row["name"]),
			CreatedAt: asStr(row["createdAt"]),
			UpdatedAt: asStr(row["updatedAt"]),
		}
		if raw := asStr(row["data"]); raw != "" {
			_ = json.Unmarshal([]byte(raw), &node.Data)
		}
		if node.Data == nil {
			node.Data = map[string]any{}
		}
		out = append(out, node)
	}
	return out, nil
}

// UpsertProviderNode writes one node row.
func (d *DB) UpsertProviderNode(node ProviderNode) (*ProviderNode, error) {
	if node.ID == "" {
		node.ID = newID()
	}
	if node.CreatedAt == "" {
		node.CreatedAt = nowISO()
	}
	node.UpdatedAt = nowISO()
	blob, err := json.Marshal(node.Data)
	if err != nil {
		return nil, err
	}
	if _, err := d.exec(`INSERT INTO providerNodes (id,type,name,data,createdAt,updatedAt) VALUES (?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, data = excluded.data,
			updatedAt = excluded.updatedAt`,
		node.ID, node.Type, node.Name, string(blob), node.CreatedAt, node.UpdatedAt); err != nil {
		return nil, err
	}
	return &node, nil
}

// DeleteProviderNode removes a node by id.
func (d *DB) DeleteProviderNode(id string) (bool, error) {
	res, err := d.exec("DELETE FROM providerNodes WHERE id = ?", id)
	if err != nil {
		return false, err
	}
	affected, _ := res.RowsAffected()
	return affected > 0, nil
}

// ------------------------------------------------------------------ vouchers

// GetVoucher resolves a voucher by id or code.
func (d *DB) GetVoucher(idOrCode string) (map[string]any, error) {
	rows, err := d.queryMaps(`SELECT id,code,name,COALESCE(description,'') AS description,tokenLimit,
		allowedModels,rpmLimit,tpmLimit,expiresInDays,maxUses,usedCount,isBansos,isActive,createdAt,updatedAt
		FROM vouchers WHERE id = ? OR code = ?`, idOrCode, idOrCode)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// UpdateVoucher patches the mutable voucher columns.
func (d *DB) UpdateVoucher(id string, fields map[string]any) error {
	allowed := map[string]bool{
		"name": true, "description": true, "tokenLimit": true, "allowedModels": true,
		"rpmLimit": true, "tpmLimit": true, "expiresInDays": true, "maxUses": true,
		"isBansos": true, "isActive": true,
	}
	for column, value := range fields {
		if !allowed[column] {
			continue
		}
		if _, err := d.exec("UPDATE vouchers SET "+column+" = ?, updatedAt = ? WHERE id = ?", value, nowISO(), id); err != nil {
			return err
		}
	}
	return nil
}

// ClaimVoucher redeems a code once: it enforces expiry, max uses and the
// per-device fingerprint, then mints the key the claim hands back.
func (d *DB) ClaimVoucher(code, clientIP, deviceFp, hardwareFp string) (map[string]any, error) {
	voucher, err := d.GetVoucher(code)
	if err != nil {
		return nil, err
	}
	if voucher == nil {
		return nil, errors.New("Voucher not found")
	}
	if !asBool(voucher["isActive"]) {
		return nil, errors.New("Voucher is inactive")
	}
	maxUses := int(asInt64(voucher["maxUses"]))
	used := int(asInt64(voucher["usedCount"]))
	if maxUses > 0 && used >= maxUses {
		return nil, errors.New("Voucher has reached its usage limit")
	}

	if deviceFp != "" || hardwareFp != "" {
		rows, _ := d.queryMaps(`SELECT id FROM voucherClaims WHERE voucherId = ? AND
			(? != '' AND deviceFp = ? OR ? != '' AND hardwareFp = ?)`,
			asStr(voucher["id"]), deviceFp, deviceFp, hardwareFp, hardwareFp)
		if len(rows) > 0 {
			return nil, errors.New("Voucher already claimed on this device")
		}
	}

	key, err := d.CreateAPIKey(APIKey{
		Name:          "voucher:" + asStr(voucher["code"]),
		TokenLimit:    asInt64(voucher["tokenLimit"]),
		AllowedModels: firstNonBlank(asStr(voucher["allowedModels"]), "*"),
		RPMLimit:      int(asInt64(voucher["rpmLimit"])),
		TPMLimit:      int(asInt64(voucher["tpmLimit"])),
		IsActive:      true,
		CreatedBy:     "voucher",
	})
	if err != nil {
		return nil, err
	}

	claimID := newID()
	if _, err := d.exec(`INSERT INTO voucherClaims (id,voucherId,voucherCode,apiKeyId,apiKey,clientIp,deviceFp,hardwareFp,claimedAt)
		VALUES (?,?,?,?,?,?,?,?,?)`, claimID, asStr(voucher["id"]), asStr(voucher["code"]), key.ID, key.Key,
		clientIP, deviceFp, hardwareFp, nowISO()); err != nil {
		return nil, err
	}
	if _, err := d.exec("UPDATE vouchers SET usedCount = COALESCE(usedCount,0)+1, updatedAt = ? WHERE id = ?",
		nowISO(), asStr(voucher["id"])); err != nil {
		return nil, err
	}

	return map[string]any{
		"success": true,
		"id":      claimID,
		"key":     key.Key,
		"apiKey":  key.Key,
		"name":    key.Name,
		"voucher": map[string]any{"code": asStr(voucher["code"]), "tokenLimit": voucher["tokenLimit"]},
	}, nil
}

// CountVoucherClaims reports how many times a voucher has been claimed.
func (d *DB) CountVoucherClaims(voucherID string) int {
	rows, err := d.queryMaps("SELECT COUNT(*) AS n FROM voucherClaims WHERE voucherId = ?", voucherID)
	if err != nil || len(rows) == 0 {
		return 0
	}
	return int(asInt64(rows[0]["n"]))
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// CountRows returns the row count for one of the dashboard tables. The table
// name is whitelisted because it is interpolated into the statement.
func (d *DB) CountRows(table string) (int64, error) {
	allowed := map[string]bool{
		"apiKeys": true, "providerConnections": true, "proxyPools": true, "combos": true,
		"vouchers": true, "usageHistory": true, "requestDetails": true, "notifications": true,
		"securityEvents": true, "ipBans": true, "shareTokens": true, "providerNodes": true,
	}
	if !allowed[table] {
		return 0, errors.New("table not allowed")
	}
	rows, err := d.queryMaps("SELECT COUNT(*) AS n FROM " + table)
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	return asInt64(rows[0]["n"]), nil
}

// VacuumInto writes a consistent snapshot of the live database to target. This
// is the only backup path that is safe while the gateway is serving traffic.
func (d *DB) VacuumInto(target string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.sqlDB.Exec("VACUUM INTO ?", target)
	return err
}

// QueryMaps exposes parameterised row reads to the gateway package without
// leaking the unexported helper into a wider API.
func (d *DB) QueryMaps(query string, args ...any) ([]map[string]any, error) {
	return d.queryMaps(query, args...)
}
