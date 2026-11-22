package gateway

// compat_probe.go gives the dashboard's "test"/"validate" buttons something
// real to report. Both probes are bounded (8s, no body download) so a dead
// provider cannot hang the management plane.

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

var probeClient = &http.Client{
	Timeout: 8 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        16,
		IdleConnTimeout:     30 * time.Second,
		DisableCompression:  true,
		TLSHandshakeTimeout: 6 * time.Second,
	},
}

// probeProvider resolves a provider id/alias to its catalogue entry and first
// active connection, then probes /models.
func (g *Gateway) probeProvider(idOrAlias string) map[string]any {
	idOrAlias = strings.TrimSpace(idOrAlias)
	if idOrAlias == "" {
		return map[string]any{"ok": false, "error": "provider required"}
	}
	// Accept a full model id (alias/model or provider/model) and probe the
	// provider it belongs to.
	if index := strings.Index(idOrAlias, "/"); index > 0 {
		idOrAlias = idOrAlias[:index]
	}
	providerID := g.catalog.ResolveID(idOrAlias)
	entry, known := g.catalog.Provider(providerID)
	if !known {
		return map[string]any{"ok": false, "error": "Unknown provider", "provider": idOrAlias}
	}

	conns, err := g.db.GetActiveConnections(providerID)
	if err != nil {
		return map[string]any{"ok": false, "error": "Failed to load connections"}
	}
	if len(conns) == 0 {
		return map[string]any{
			"ok":       false,
			"error":    "No active connection",
			"provider": providerID,
			"hasAuth":  false,
		}
	}

	conn := conns[0]
	key := connectionSecret(conn.Data)
	diag := g.probeKey(entry.BaseURL, key)
	diag["provider"] = providerID
	diag["connectionId"] = conn.ID
	diag["hasAuth"] = key != ""
	return diag
}

// probeKey performs GET <base>/models with a bearer token. Providers that answer
// 401 report the credential problem; a network failure reports the transport
// error verbatim instead of a generic failure.
func (g *Gateway) probeKey(baseURL, apiKey string) map[string]any {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return map[string]any{"ok": false, "error": "Provider has no base URL"}
	}

	url := baseURL
	if !strings.Contains(url, "/models") {
		url += "/models"
	}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return map[string]any{"ok": false, "error": "Invalid URL"}
	}
	req.Header.Set("Accept", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	start := time.Now()
	resp, err := probeClient.Do(req)
	if err != nil {
		return map[string]any{
			"ok":        false,
			"status":    0,
			"error":     err.Error(),
			"latencyMs": time.Since(start).Milliseconds(),
		}
	}
	defer resp.Body.Close()

	result := map[string]any{
		"ok":        resp.StatusCode >= 200 && resp.StatusCode < 300,
		"status":    resp.StatusCode,
		"latencyMs": time.Since(start).Milliseconds(),
	}
	if !result["ok"].(bool) {
		result["error"] = "HTTP " + resp.Status
	}
	return result
}

// connectionSecret pulls the credential out of the JSON blob the connections
// table stores. Both engines keep the same field names.
func connectionSecret(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var data map[string]any
	if json.Unmarshal(raw, &data) != nil {
		return ""
	}
	for _, field := range []string{"apiKey", "accessToken", "token", "key", "refreshToken"} {
		if value, ok := data[field].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
