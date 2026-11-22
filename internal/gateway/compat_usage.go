package gateway

// compat_usage.go fills the remaining /api/usage views: request detail drill-
// down, live sparks, the error ledger, per-connection quota actions and the SSE
// stats stream. Everything is derived from usageHistory/requestDetails, which
// both engines write.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (g *Gateway) handleUsageExtras(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/usage/"), "/")
	query := r.URL.Query()
	period := firstNonEmpty(query.Get("period"), "7d")

	switch {
	case rest == "available-models":
		provider := query.Get("provider")
		models := []map[string]any{}
		ids := g.catalog.ProviderIDs()
		if provider != "" {
			ids = []string{g.catalog.ResolveID(provider)}
		}
		for _, pid := range ids {
			for _, m := range g.catalog.Models(pid) {
				models = append(models, map[string]any{
					"id":       pid + "/" + m.ID,
					"name":     firstNonEmpty(m.Name, m.ID),
					"provider": pid,
					"kind":     firstNonEmpty(m.Kind, "llm"),
				})
			}
		}
		jsonResponse(w, http.StatusOK, map[string]any{"models": models, "count": len(models)})

	case rest == "errors":
		limit := asIntDefault(query.Get("limit"), 100)
		rows, err := g.db.UsageErrors(limit)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load errors", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"errors": rows, "count": len(rows)})

	case rest == "logs":
		rows, err := g.db.UsageHistoryPage(period, query.Get("provider"), query.Get("model"),
			asIntDefault(query.Get("limit"), 200))
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load logs", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"logs": rows, "period": period})

	case rest == "request-logs":
		rows, err := g.listRequestDetails(asIntDefault(query.Get("limit"), 100), query.Get("provider"), query.Get("model"))
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load request logs", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"logs": rows, "requests": rows})

	case rest == "request-details":
		rows, err := g.listRequestDetails(asIntDefault(query.Get("limit"), 50), query.Get("provider"), query.Get("model"))
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load request details", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"details": rows, "requests": rows})

	case strings.HasPrefix(rest, "request-details/"):
		id := strings.TrimPrefix(rest, "request-details/")
		row, err := g.getRequestDetail(id)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load request detail", err)
			return
		}
		if row == nil {
			jsonError(w, http.StatusNotFound, "Request not found", nil)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"detail": row})

	case rest == "leaderboard":
		rows, err := g.db.UsageGrouped(period, "model")
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load leaderboard", err)
			return
		}
		sort.Slice(rows, func(i, j int) bool {
			return numericField(rows[i], "totalTokens") > numericField(rows[j], "totalTokens")
		})
		if len(rows) > 20 {
			rows = rows[:20]
		}
		jsonResponse(w, http.StatusOK, map[string]any{"leaderboard": rows, "period": period})

	case rest == "sparks":
		series, err := g.db.UsageDailySeries(asIntDefault(query.Get("days"), 14))
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load sparks", err)
			return
		}
		sparks := make([]map[string]any, 0, len(series))
		for _, row := range series {
			sparks = append(sparks, map[string]any{
				"date":     row["dateKey"],
				"tokens":   numericField(row, "totalTokens"),
				"requests": numericField(row, "requests"),
			})
		}
		jsonResponse(w, http.StatusOK, map[string]any{"sparks": sparks, "series": sparks})

	case rest == "token-savings":
		totals, err := g.db.UsageStats(period, "", "")
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load savings", err)
			return
		}
		// Savings are the cached-prompt share the Node UI reports: prompt tokens
		// not re-billed. Without a cache ledger the honest answer is the request
		// volume and total tokens, not an invented multiplier.
		jsonResponse(w, http.StatusOK, map[string]any{
			"period":           period,
			"requests":         totals.Requests,
			"promptTokens":     totals.PromptTokens,
			"completionTokens": totals.CompletionTokens,
			"totalTokens":      totals.TotalTokens,
			"cost":             totals.Cost,
			"savedTokens":      readCounters(cacheCounts)["savedTokens"],
		})

	case rest == "antigravity-tier":
		tier := map[string]any{"provider": "antigravity", "tiers": []any{}}
		if conns, err := g.db.GetActiveConnections("antigravity"); err == nil && len(conns) > 0 {
			var data map[string]any
			if json.Unmarshal(conns[0].Data, &data) == nil {
				if value, ok := data["tier"]; ok {
					tier["tier"] = value
				}
				if value, ok := data["tierId"]; ok {
					tier["tierId"] = value
				}
				if value, ok := data["projectId"]; ok {
					tier["projectId"] = value
				}
			}
			tier["connectionId"] = conns[0].ID
		}
		jsonResponse(w, http.StatusOK, tier)

	case rest == "stream":
		g.streamUsage(w, r, period)

	case strings.HasSuffix(rest, "/claude-reset"),
		strings.HasSuffix(rest, "/codex-reset-credits"),
		strings.HasSuffix(rest, "/glm-claim"),
		strings.HasSuffix(rest, "/glm-reset-cards"),
		strings.HasSuffix(rest, "/zcode-bridge"):
		connectionID := rest[:strings.LastIndex(rest, "/")]
		action := rest[strings.LastIndex(rest, "/")+1:]
		g.connectionQuotaAction(w, r, connectionID, action)

	default:
		// /api/usage/{connectionId}: per-connection totals.
		if !strings.Contains(rest, "/") && rest != "" {
			rows, err := g.db.QueryMaps(`SELECT COUNT(*) AS requests,
				COALESCE(SUM(promptTokens),0) AS promptTokens,
				COALESCE(SUM(completionTokens),0) AS completionTokens,
				COALESCE(SUM(cost),0) AS cost
				FROM usageHistory WHERE connectionId = ?`, rest)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to load connection usage", err)
				return
			}
			totals := map[string]any{}
			if len(rows) > 0 {
				totals = rows[0]
			}
			jsonResponse(w, http.StatusOK, map[string]any{"connectionId": rest, "totals": totals, "usage": totals})
			return
		}
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

func (g *Gateway) listRequestDetails(limit int, provider, model string) ([]map[string]any, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := `SELECT id,timestamp,COALESCE(provider,'') AS provider,COALESCE(model,'') AS model,
		COALESCE(connectionId,'') AS connectionId,COALESCE(status,'') AS status,data
		FROM requestDetails`
	clauses := []string{}
	args := []any{}
	if provider != "" {
		clauses = append(clauses, "provider = ?")
		args = append(args, provider)
	}
	if model != "" {
		clauses = append(clauses, "model = ?")
		args = append(args, model)
	}
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	query += " ORDER BY timestamp DESC LIMIT ?"
	args = append(args, limit)

	rows, err := g.db.QueryMaps(query, args...)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if blob, ok := row["data"].(string); ok && blob != "" {
			var decoded any
			if json.Unmarshal([]byte(blob), &decoded) == nil {
				row["data"] = decoded
			}
		}
	}
	return rows, nil
}

func (g *Gateway) getRequestDetail(id string) (map[string]any, error) {
	rows, err := g.db.QueryMaps(`SELECT id,timestamp,COALESCE(provider,'') AS provider,COALESCE(model,'') AS model,
		COALESCE(connectionId,'') AS connectionId,COALESCE(status,'') AS status,data
		FROM requestDetails WHERE id = ?`, id)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	row := rows[0]
	if blob, ok := row["data"].(string); ok && blob != "" {
		var decoded any
		if json.Unmarshal([]byte(blob), &decoded) == nil {
			row["data"] = decoded
		}
	}
	return row, nil
}

// streamUsage emits the stats snapshot as server-sent events, capped so a tab
// left open overnight cannot hold a worker forever.
func (g *Gateway) streamUsage(w http.ResponseWriter, r *http.Request, period string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, http.StatusInternalServerError, "Streaming unsupported", nil)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	deadline := time.Now().Add(30 * time.Minute)
	for time.Now().Before(deadline) {
		select {
		case <-r.Context().Done():
			return
		default:
		}
		totals, err := g.db.UsageStats(period, "", "")
		if err != nil {
			break
		}
		payload, _ := json.Marshal(map[string]any{
			"period":      period,
			"requests":    totals.Requests,
			"totalTokens": totals.TotalTokens,
			"cost":        totals.Cost,
			"at":          time.Now().UTC().Format(time.RFC3339),
		})
		fmt.Fprintf(w, "data: %s\n\n", payload)
		flusher.Flush()
		select {
		case <-r.Context().Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

// connectionQuotaAction answers the per-connection quota buttons. The Go engine
// clears the local lock and reports what it did; provider-side resets that need
// a browser session report that honestly instead of pretending success.
func (g *Gateway) connectionQuotaAction(w http.ResponseWriter, r *http.Request, connectionID, action string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	conns, err := g.db.GetActiveConnections("")
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to load connections", err)
		return
	}
	var provider string
	for _, conn := range conns {
		if conn.ID == connectionID {
			provider = conn.Provider
			break
		}
	}
	if provider == "" {
		jsonError(w, http.StatusNotFound, "Connection not found", nil)
		return
	}

	cleared := false
	if g.registry != nil {
		if adapter, ok := g.registry.Resolve(provider); ok {
			if resetter, ok := adapter.(interface{ ResetCooldown() }); ok {
				resetter.ResetCooldown()
				cleared = true
			}
		}
	}

	jsonResponse(w, http.StatusOK, map[string]any{
		"success":       true,
		"connectionId":  connectionID,
		"provider":      provider,
		"action":        action,
		"cooldownReset": cleared,
		"providerSide":  action != "zcode-bridge",
		"note":          "local routing lock cleared; provider-side quota is reported by the next request",
	})
}

func numericField(row map[string]any, field string) float64 {
	switch value := row[field].(type) {
	case float64:
		return value
	case int64:
		return float64(value)
	case int:
		return float64(value)
	case string:
		parsed, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}
