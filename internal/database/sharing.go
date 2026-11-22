package database

// sharing.go owns the public usage-share links. The Node side keeps these in
// `shareTokens`; the Go port reads and writes the same rows so a link minted by
// either engine works in the other.

import (
	"crypto/rand"
	"encoding/base64"
	"time"
)

// ShareToken is one public link for one API key.
type ShareToken struct {
	Token        string `json:"token"`
	APIKeyID     string `json:"apiKeyId"`
	Label        string `json:"label"`
	ExpiresAt    string `json:"expiresAt"`
	ViewCount    int    `json:"viewCount"`
	LastViewedAt string `json:"lastViewedAt"`
	CreatedAt    string `json:"createdAt"`
}

// CreateShareToken mints a 24-byte base64url token, optionally expiring after
// ttlDays. A ttl of zero or less means no expiry, matching the Node default.
func (d *DB) CreateShareToken(apiKeyID, label string, ttlDays int) (*ShareToken, error) {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	expires := ""
	if ttlDays > 0 {
		expires = time.Now().UTC().Add(time.Duration(ttlDays) * 24 * time.Hour).Format(time.RFC3339)
	}
	token := &ShareToken{
		Token:     base64.RawURLEncoding.EncodeToString(buf),
		APIKeyID:  apiKeyID,
		Label:     label,
		ExpiresAt: expires,
		CreatedAt: nowISO(),
	}
	if _, err := d.exec(`INSERT INTO shareTokens (token,apiKeyId,label,expiresAt,viewCount,createdAt)
		VALUES (?,?,?,?,0,?)`, token.Token, token.APIKeyID, token.Label, token.ExpiresAt, token.CreatedAt); err != nil {
		return nil, err
	}
	return token, nil
}

// ListShareTokens returns every live link for a key, newest first.
func (d *DB) ListShareTokens(apiKeyID string) ([]ShareToken, error) {
	rows, err := d.queryMaps(`SELECT token,apiKeyId,COALESCE(label,'') AS label,COALESCE(expiresAt,'') AS expiresAt,
		COALESCE(viewCount,0) AS viewCount,COALESCE(lastViewedAt,'') AS lastViewedAt,createdAt
		FROM shareTokens WHERE apiKeyId = ? ORDER BY createdAt DESC`, apiKeyID)
	if err != nil {
		return nil, err
	}
	out := make([]ShareToken, 0, len(rows))
	for _, row := range rows {
		out = append(out, ShareToken{
			Token:        asStr(row["token"]),
			APIKeyID:     asStr(row["apiKeyId"]),
			Label:        asStr(row["label"]),
			ExpiresAt:    asStr(row["expiresAt"]),
			ViewCount:    int(asInt64(row["viewCount"])),
			LastViewedAt: asStr(row["lastViewedAt"]),
			CreatedAt:    asStr(row["createdAt"]),
		})
	}
	return out, nil
}

// RevokeShareToken deletes one link by token value.
func (d *DB) RevokeShareToken(token string) (bool, error) {
	res, err := d.exec("DELETE FROM shareTokens WHERE token = ?", token)
	if err != nil {
		return false, err
	}
	affected, _ := res.RowsAffected()
	return affected > 0, nil
}

// TouchShareToken bumps the view counter for a public hit.
func (d *DB) TouchShareToken(token string) error {
	_, err := d.exec("UPDATE shareTokens SET viewCount = COALESCE(viewCount,0)+1, lastViewedAt = ? WHERE token = ?",
		nowISO(), token)
	return err
}

// GetShareToken resolves a token to its row, expired links included so the
// caller can answer 410 instead of 404.
func (d *DB) GetShareToken(token string) (*ShareToken, error) {
	rows, err := d.queryMaps(`SELECT token,apiKeyId,COALESCE(label,'') AS label,COALESCE(expiresAt,'') AS expiresAt,
		COALESCE(viewCount,0) AS viewCount,COALESCE(lastViewedAt,'') AS lastViewedAt,createdAt
		FROM shareTokens WHERE token = ?`, token)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	row := rows[0]
	return &ShareToken{
		Token:        asStr(row["token"]),
		APIKeyID:     asStr(row["apiKeyId"]),
		Label:        asStr(row["label"]),
		ExpiresAt:    asStr(row["expiresAt"]),
		ViewCount:    int(asInt64(row["viewCount"])),
		LastViewedAt: asStr(row["lastViewedAt"]),
		CreatedAt:    asStr(row["createdAt"]),
	}, nil
}
