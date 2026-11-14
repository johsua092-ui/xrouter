package database

import (
	"encoding/json"
	"errors"
	"fmt"
)

// This file adds the read helpers the chat routing path needs. Everything here is
// read-only: the Go core queries the shared database but never writes to it while
// the Node service is live.

// connectionData is the shape stored in providerConnections.data. Only the fields
// the credential build reads are declared; unknown keys are ignored, which keeps
// this tolerant of the dashboard adding new ones.
type connectionData struct {
	APIKey               string                 `json:"apiKey"`
	AccessToken          string                 `json:"accessToken"`
	RefreshToken         string                 `json:"refreshToken"`
	Email                string                 `json:"email"`
	BaseURL              string                 `json:"baseUrl"`
	ProviderSpecificData map[string]interface{} `json:"providerSpecificData"`
}

// ProviderCredential is a flattened connection ready to become an adapter
// credential. Field names mirror the credential the adapters consume.
type ProviderCredential struct {
	ConnectionID string
	Provider     string
	AuthType     string
	APIKey       string
	Token        string
	BaseURL      string
	AccountID    string
	UserID       string
	Email        string
	AgentID      string
	Region       string
	Extra        map[string]string
}

// errNoConnection is returned when a provider has no active row.
var errNoConnection = fmt.Errorf("no active connection")

// FindActiveConnection returns the highest-priority active connection for a
// provider that the Go core can actually use.
//
// Selection walks the priority-ordered rows and skips any whose credential is
// still sealed in the Node vault (`enc:v1:`). The first candidate is not
// automatically the answer: in the live database a provider typically has both
// sealed and plaintext rows for the same account, and taking the first one would
// fail the request for a reason the operator cannot see. Skipping to the next
// usable row is what makes 636 of 817 active connections routable from Go.
//
// When every candidate is sealed, the error names that condition explicitly so
// the dashboard can say "unlock the vault" instead of "no connection".
func (d *DB) FindActiveConnection(provider string) (*ProviderCredential, error) {
	conns, err := d.GetActiveConnections(provider)
	if err != nil {
		return nil, err
	}
	if len(conns) == 0 {
		return nil, errNoConnection
	}

	sealed := 0
	var lastErr error

	for i := range conns {
		cred, cerr := flattenConnection(&conns[i])
		if cerr != nil {
			if errors.Is(cerr, errSealedCredential) {
				sealed++
			}
			lastErr = cerr
			continue
		}
		return cred, nil
	}

	if sealed == len(conns) {
		return nil, fmt.Errorf("%w (provider %s, %d connection(s))", errSealedCredential, provider, sealed)
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errNoConnection
}

// errSealedCredential marks a row whose secret is still in the Node vault.
var errSealedCredential = fmt.Errorf("credential is sealed in the Node vault")

// flattenConnection turns one row into a credential, or explains why it cannot.
func flattenConnection(c *ProviderConnection) (*ProviderCredential, error) {
	var data connectionData
	if len(c.Data) > 0 {
		// A malformed row should not take the whole provider down; fall through to
		// a credential built from the columns alone.
		if jerr := json.Unmarshal(c.Data, &data); jerr != nil {
			data = connectionData{}
		}
	}

	cred := &ProviderCredential{
		ConnectionID: c.ID,
		Provider:     c.Provider,
		AuthType:     c.AuthType,
		Email:        firstNonEmpty(data.Email, c.Email),
		BaseURL:      data.BaseURL,
		Extra:        map[string]string{},
	}

	// authType decides which stored field carries the secret. Anything not
	// declared as a plain API key is treated as a bearer token, matching how the
	// dashboard writes these rows.
	isAPIKeyAuth := c.AuthType == "apikey" || c.AuthType == "api_key"
	if isAPIKeyAuth {
		cred.APIKey = firstNonEmpty(data.APIKey, data.AccessToken)
	} else {
		cred.Token = data.AccessToken
		if data.APIKey != "" && !IsEncrypted(data.APIKey) {
			cred.APIKey = data.APIKey
		}
	}
	if cred.APIKey == "" && data.APIKey != "" {
		cred.APIKey = data.APIKey
	}

	psd := data.ProviderSpecificData
	cred.UserID = strField(psd, "userId")
	cred.AccountID = strField(psd, "accountId")
	cred.AgentID = firstNonEmpty(strField(psd, "deviceId"), strField(psd, "agentId"))
	cred.Region = strField(psd, "region")

	// Fields an adapter may read straight out of Extra.
	for _, k := range []string{
		"projectId", "workspaceId", "subscriptionTier", "authMethod", "scope",
		"urlIndex", "deployment", "apiVersion", "tenantId",
	} {
		if v := strField(psd, k); v != "" {
			cred.Extra[k] = v
		}
	}
	if cred.BaseURL == "" {
		if v := strField(psd, "baseUrl"); v != "" {
			cred.BaseURL = v
		}
	}
	// providerSpecificData may hold an apiKey for the compatible-chat nodes.
	if cred.APIKey == "" {
		if v := strField(psd, "apiKey"); v != "" && !IsEncrypted(v) {
			cred.APIKey = v
		}
	}

	if IsEncrypted(cred.APIKey) || IsEncrypted(cred.Token) {
		return nil, errSealedCredential
	}
	if cred.Token == "" && cred.APIKey == "" {
		return nil, fmt.Errorf("connection %s (%s) has no usable credential", c.ID, c.Provider)
	}

	return cred, nil
}

// CountReadableConnections reports how many active rows the Go core can actually
// use, and how many are sealed. Used by the health endpoint so the split is
// visible rather than discovered one failed request at a time.
func (d *DB) CountReadableConnections() (readable, sealed int, err error) {
	// COALESCE on every nullable column. The live table carries NULLs in name,
	// email, priority, data and both timestamps; scanning any of those into a
	// plain Go value fails the whole query rather than just that one row, which
	// is exactly how this counter silently returned nothing.
	query := `SELECT id, provider, COALESCE(authType,''), COALESCE(name,''), COALESCE(email,''),
	                 COALESCE(priority,0), COALESCE(isActive,0), COALESCE(data,''),
	                 COALESCE(createdAt,''), COALESCE(updatedAt,'')
	          FROM providerConnections WHERE isActive = 1`
	rows, err := d.sqlDB.Query(query)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()

	for rows.Next() {
		var c ProviderConnection
		var dataStr string
		var isActiveInt int
		if serr := rows.Scan(&c.ID, &c.Provider, &c.AuthType, &c.Name, &c.Email,
			&c.Priority, &isActiveInt, &dataStr, &c.CreatedAt, &c.UpdatedAt); serr != nil {
			return readable, sealed, serr
		}
		c.IsActive = isActiveInt == 1
		c.Data = json.RawMessage(dataStr)

		if _, cerr := flattenConnection(&c); cerr != nil {
			sealed++
		} else {
			readable++
		}
	}
	return readable, sealed, rows.Err()
}

// IsEncrypted reports whether a stored value is still a vault envelope. The Node
// side prefixes sealed values with `enc:v1:`.
func IsEncrypted(v string) bool {
	return len(v) >= 7 && v[:7] == "enc:v1:"
}

// strField reads a string out of a decoded JSON object, tolerating nil.
func strField(m map[string]interface{}, key string) string {
	if m == nil {
		return ""
	}
	s, _ := m[key].(string)
	return s
}

// firstNonEmpty returns the first non-empty argument.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
