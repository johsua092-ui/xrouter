package providers

import (
	"net/http"
	"strings"
)

// CredentialFromDB is the subset of a provider connection row the credential
// build needs. Kept as a plain struct so this package has no database
// dependency: the gateway maps the query result into it.
type CredentialFromDB struct {
	ProviderID string
	APIKey     string
	Token      string
	BaseURL    string
	AccountID  string
	UserID     string
	Email      string
	AgentID    string
	SessionID  string
	Region     string
	// Extra carries any other provider-specific field the adapter may read.
	Extra map[string]string
}

// CredentialFromConnection builds an adapter credential from a connection row
// plus the incoming request headers.
//
// Strings are trimmed because these values are pasted into the dashboard by hand
// and a trailing newline in a key is a silent 401 upstream.
func CredentialFromConnection(c CredentialFromDB, h http.Header) Credential {
	extra := map[string]string{}
	for k, v := range c.Extra {
		extra[k] = strings.TrimSpace(v)
	}
	putIfSet := func(k, v string) {
		if v = strings.TrimSpace(v); v != "" {
			extra[k] = v
		}
	}
	putIfSet("accountId", c.AccountID)
	putIfSet("userId", c.UserID)
	putIfSet("email", c.Email)
	putIfSet("agentId", c.AgentID)
	putIfSet("connectionId", c.SessionID)

	raw := map[string]string{}
	if b := h.Get("anthropic-beta"); b != "" {
		raw["anthropic-beta"] = b
	}

	return Credential{
		APIKey:      strings.TrimSpace(c.APIKey),
		AccessToken: strings.TrimSpace(c.Token),
		BaseURL:     strings.TrimRight(strings.TrimSpace(c.BaseURL), "/"),
		Extra:       extra,
		RawHeaders:  raw,
	}
}
