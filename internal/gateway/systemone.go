package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/johsua092-ui/xrouter/internal/catalog"
)

// handleSystemone serves POST /v1/systemone — the decision-model endpoint.
//
// Decision models take a native payload (state + questions) and answer with
// their own JSON; there is no chat translation layer in between. The body is
// forwarded with `model` folded in, and the upstream document is relayed as-is,
// because the caller owns the schema.
func (g *Gateway) handleSystemone(w http.ResponseWriter, r *http.Request) {
	body, err := readBodyPeek(r)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "could not read request body", err)
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		jsonError(w, http.StatusBadRequest, "Invalid JSON body", err)
		return
	}

	modelStr := asString(parsed["model"])
	if modelStr == "" {
		jsonError(w, http.StatusBadRequest, "Missing model", nil)
		return
	}
	if parsed["state"] == nil {
		jsonError(w, http.StatusBadRequest, "Missing required field: state", nil)
		return
	}
	if _, ok := parsed["questions"].(map[string]any); !ok {
		jsonError(w, http.StatusBadRequest, "Missing required field: questions", nil)
		return
	}

	providerName, modelID, ok := splitProviderModel(modelStr)
	if !ok {
		jsonError(w, http.StatusBadRequest, "Invalid model format", nil)
		return
	}
	providerName = g.catalog.ResolveID(providerName)

	provider, found := g.catalog.Provider(providerName)
	if !found {
		jsonError(w, http.StatusBadRequest, "Unknown provider "+providerName, nil)
		return
	}
	cfg := provider.Media["systemoneConfig"]
	if cfg == nil {
		jsonError(w, http.StatusBadRequest,
			"Provider '"+providerName+"' does not support System One.", nil)
		return
	}

	conn, connErr := g.db.FindActiveConnection(providerName)
	if connErr != nil || conn == nil {
		jsonResponse(w, http.StatusServiceUnavailable, map[string]any{
			"error":    "no active connection for provider",
			"provider": providerName,
			"detail":   errString(connErr),
		})
		return
	}

	target := conn.BaseURL
	if target == "" {
		target = asString(cfg["baseUrl"])
	}
	if target == "" {
		jsonError(w, http.StatusBadRequest,
			"Provider '"+providerName+"' has no System One base url", nil)
		return
	}

	parsed["model"] = modelID
	payload, err := json.Marshal(parsed)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not serialise request", err)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, strings.NewReader(string(payload)))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not build upstream request", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	token := conn.APIKey
	if token == "" {
		token = conn.Token
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if headers, ok := cfg["headers"].(map[string]any); ok {
		for name, value := range headers {
			if s, ok := value.(string); ok {
				req.Header.Set(name, s)
			}
		}
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		jsonError(w, http.StatusBadGateway,
			"upstream call failed for "+providerName+"/"+modelID, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusBadRequest {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		jsonResponse(w, resp.StatusCode, map[string]any{
			"error":    "upstream rejected the request",
			"provider": providerName,
			"model":    modelID,
			"upstream": strings.TrimSpace(string(detail)),
		})
		return
	}

	var upstream map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&upstream); err != nil {
		jsonError(w, http.StatusBadGateway,
			"Invalid JSON response from "+providerName, err)
		return
	}

	jsonResponse(w, http.StatusOK, upstream)
}

// systemoneProviders lists providers whose catalogue entry carries a System One
// descriptor. Exposed for diagnostics so an empty set is visible rather than
// inferred from a failing request.
func (g *Gateway) systemoneProviders() []string {
	out := make([]string, 0, 4)
	for _, id := range g.catalog.ProviderIDs() {
		p := g.catalog.Providers[id]
		if p.Media["systemoneConfig"] != nil {
			out = append(out, catalog.AliasOf(p))
		}
	}
	return out
}
