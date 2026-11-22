package gateway

// compat_models.go closes the management-plane gaps the Node dashboard still
// calls: the model catalogue views, combo presets, provider extras (client
// listing, overrides, validation, batch tests) and the shared-key endpoints.
//
// Design rule for every handler here: answer from the same SQLite rows the Node
// handlers read (kv, providerConnections, combos, customModels). No parallel
// bookkeeping that would silently diverge from the Node side while both engines
// are alive.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/johsua092-ui/xrouter/internal/database"
)

// kvScopeList is the shape most of the dashboard singletons share: an array of
// objects under one kv key.
func (g *Gateway) kvList(scope, key string) []map[string]any {
	raw, err := g.db.GetKV(scope, key)
	if err != nil || raw == "" {
		return []map[string]any{}
	}
	var out []map[string]any
	if json.Unmarshal([]byte(raw), &out) != nil {
		return []map[string]any{}
	}
	return out
}

func (g *Gateway) kvPutList(scope, key string, items []map[string]any) error {
	blob, err := json.Marshal(items)
	if err != nil {
		return err
	}
	return g.db.PutKV(scope, key, string(blob))
}

func (g *Gateway) kvObject(scope, key string) map[string]any {
	raw, err := g.db.GetKV(scope, key)
	if err != nil || raw == "" {
		return map[string]any{}
	}
	var out map[string]any
	if json.Unmarshal([]byte(raw), &out) != nil {
		return map[string]any{}
	}
	return out
}

func (g *Gateway) kvPutObject(scope, key string, obj map[string]any) error {
	blob, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	return g.db.PutKV(scope, key, string(blob))
}

func newCompatID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(buf)
}

// ---------------------------------------------------------------- models views

// handleModelsCompat dispatches /api/models and its sub-resources.
func (g *Gateway) handleModelsCompat(w http.ResponseWriter, r *http.Request) {
	sub := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/models"), "/")

	switch sub {
	case "":
		if r.Method == http.MethodPut {
			g.modelsSetAlias(w, r)
			return
		}
		g.modelsList(w, r)
	case "alias":
		g.modelsAliases(w, r)
	case "custom":
		g.modelsCustom(w, r)
	case "disabled":
		g.modelsDisabled(w, r)
	case "catalog":
		g.modelsCatalog(w, r)
	case "catalog-sync":
		g.modelsCatalogSync(w, r)
	case "availability":
		g.modelsAvailability(w, r)
	case "test":
		g.modelsTest(w, r)
	default:
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

// modelsList mirrors the Node payload closely enough for the dashboard table:
// one row per routable model, with connection counts and the alias applied.
func (g *Gateway) modelsList(w http.ResponseWriter, r *http.Request) {
	aliases := g.kvObject("meta", "modelAliases")
	disabled := map[string]bool{}
	for _, item := range g.kvList("meta", "disabledModels") {
		if name := asString(item["model"]); name != "" {
			disabled[name] = true
		}
	}

	conns, _ := g.db.GetActiveConnections("")
	perProvider := map[string]int{}
	for _, c := range conns {
		perProvider[c.Provider]++
	}

	models := make([]map[string]any, 0, 256)
	for _, pid := range g.catalog.ProviderIDs() {
		provider, ok := g.catalog.Provider(pid)
		if !ok {
			continue
		}
		prefix := pid
		if provider.Alias != "" {
			prefix = provider.Alias
		}
		for _, m := range g.catalog.Models(pid) {
			full := prefix + "/" + m.ID
			canonical := pid + "/" + m.ID
			row := map[string]any{
				"id":              full,
				"canonicalId":     canonical,
				"name":            firstNonEmpty(m.Name, m.ID),
				"provider":        pid,
				"providerName":    provider.Name,
				"kind":            firstNonEmpty(m.Kind, "llm"),
				"connectionCount": perProvider[pid],
				"isCustom":        false,
				"isCombo":         false,
				"disabled":        disabled[full] || disabled[canonical],
			}
			// Aliases and disable flags are addressed by whichever id the
			// operator used: the prefixed id the dashboard shows, or the
			// canonical provider/model id.
			if alias, ok := aliases[full]; ok {
				row["alias"] = alias
			} else if alias, ok := aliases[canonical]; ok {
				row["alias"] = alias
			}
			models = append(models, row)
		}
	}

	for _, item := range g.kvList("meta", "customModels") {
		full := asString(item["id"])
		if full == "" {
			continue
		}
		models = append(models, map[string]any{
			"id":              full,
			"name":            firstNonEmpty(asString(item["name"]), full),
			"provider":        firstNonEmpty(asString(item["provider"]), "custom"),
			"kind":            firstNonEmpty(asString(item["kind"]), "llm"),
			"connectionCount": 1,
			"isCustom":        true,
			"isCombo":         false,
			"disabled":        disabled[full],
		})
	}

	if combos, err := g.db.ListCombos(); err == nil {
		for _, c := range combos {
			models = append(models, map[string]any{
				"id":            c.Name,
				"name":          c.Name,
				"provider":      "combo",
				"kind":          firstNonEmpty(c.Kind, "llm"),
				"isCustom":      false,
				"isCombo":       true,
				"disabled":      disabled[c.Name],
				"contextWindow": c.ContextWindow,
			})
		}
	}

	sort.Slice(models, func(i, j int) bool {
		return asString(models[i]["id"]) < asString(models[j]["id"])
	})
	jsonResponse(w, http.StatusOK, map[string]any{"models": models})
}

func (g *Gateway) modelsSetAlias(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	model := strings.TrimSpace(asString(body["model"]))
	alias := strings.TrimSpace(asString(body["alias"]))
	if model == "" || alias == "" {
		jsonError(w, http.StatusBadRequest, "Model and alias required", nil)
		return
	}
	aliases := g.kvObject("meta", "modelAliases")
	for existingModel, existingAlias := range aliases {
		if asString(existingAlias) == alias && existingModel != model {
			jsonError(w, http.StatusBadRequest, "Alias already in use", nil)
			return
		}
	}
	aliases[model] = alias
	if err := g.kvPutObject("meta", "modelAliases", aliases); err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to update alias", err)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"success": true, "model": model, "alias": alias})
}

func (g *Gateway) modelsAliases(w http.ResponseWriter, r *http.Request) {
	aliases := g.kvObject("meta", "modelAliases")
	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, http.StatusOK, map[string]any{"aliases": aliases})
	case http.MethodPost, http.MethodPut:
		g.modelsSetAlias(w, r)
	case http.MethodDelete:
		model := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("model"), r.URL.Query().Get("alias")))
		if model == "" {
			jsonError(w, http.StatusBadRequest, "model is required", nil)
			return
		}
		delete(aliases, model)
		if err := g.kvPutObject("meta", "modelAliases", aliases); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to delete alias", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

func (g *Gateway) modelsCustom(w http.ResponseWriter, r *http.Request) {
	items := g.kvList("meta", "customModels")

	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, http.StatusOK, map[string]any{"models": items})
	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		id := strings.TrimSpace(firstNonEmpty(asString(body["id"]), asString(body["model"])))
		if id == "" {
			jsonError(w, http.StatusBadRequest, "id is required", nil)
			return
		}
		body["id"] = id
		if asString(body["createdAt"]) == "" {
			body["createdAt"] = time.Now().UTC().Format(time.RFC3339)
		}
		for _, existing := range items {
			if asString(existing["id"]) == id {
				jsonError(w, http.StatusConflict, "Model already exists", nil)
				return
			}
		}
		items = append(items, body)
		if err := g.kvPutList("meta", "customModels", items); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save model", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "model": body})
	case http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		id := strings.TrimSpace(firstNonEmpty(asString(body["id"]), asString(body["model"])))
		updated := false
		for i, existing := range items {
			if asString(existing["id"]) == id {
				body["id"] = id
				items[i] = body
				updated = true
				break
			}
		}
		if !updated {
			jsonError(w, http.StatusNotFound, "Model not found", nil)
			return
		}
		if err := g.kvPutList("meta", "customModels", items); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save model", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "model": body})
	case http.MethodDelete:
		id := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("id"), r.URL.Query().Get("model")))
		kept := items[:0]
		for _, existing := range items {
			if asString(existing["id"]) != id {
				kept = append(kept, existing)
			}
		}
		if err := g.kvPutList("meta", "customModels", kept); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to delete model", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

func (g *Gateway) modelsDisabled(w http.ResponseWriter, r *http.Request) {
	items := g.kvList("meta", "disabledModels")
	switch r.Method {
	case http.MethodGet:
		names := make([]string, 0, len(items))
		for _, item := range items {
			if name := asString(item["model"]); name != "" {
				names = append(names, name)
			}
		}
		jsonResponse(w, http.StatusOK, map[string]any{"disabled": names, "models": names})
	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		name := strings.TrimSpace(firstNonEmpty(asString(body["model"]), asString(body["id"])))
		if name == "" {
			jsonError(w, http.StatusBadRequest, "model is required", nil)
			return
		}
		for _, item := range items {
			if asString(item["model"]) == name {
				jsonResponse(w, http.StatusOK, map[string]any{"success": true, "disabled": name})
				return
			}
		}
		items = append(items, map[string]any{"model": name, "createdAt": time.Now().UTC().Format(time.RFC3339)})
		if err := g.kvPutList("meta", "disabledModels", items); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to disable model", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "disabled": name})
	case http.MethodDelete:
		name := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("model"), r.URL.Query().Get("id")))
		kept := items[:0]
		for _, item := range items {
			if asString(item["model"]) != name {
				kept = append(kept, item)
			}
		}
		if err := g.kvPutList("meta", "disabledModels", kept); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to enable model", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "enabled": name})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// modelsCatalog returns the provider/model tree the picker renders. It is built
// from the embedded catalogue plus live connection counts, exactly the inputs
// the Node route uses.
func (g *Gateway) modelsCatalog(w http.ResponseWriter, r *http.Request) {
	conns, _ := g.db.GetActiveConnections("")
	counts := map[string]int{}
	for _, c := range conns {
		counts[c.Provider]++
	}

	providers := make([]map[string]any, 0, 160)
	models := make([]map[string]any, 0, 1500)
	for _, pid := range g.catalog.ProviderIDs() {
		provider, ok := g.catalog.Provider(pid)
		if !ok {
			continue
		}
		list := g.catalog.Models(pid)
		providers = append(providers, map[string]any{
			"id":              pid,
			"name":            provider.Name,
			"alias":           provider.Alias,
			"kind":            provider.Kind,
			"baseUrl":         provider.BaseURL,
			"authType":        provider.AuthType,
			"connectionCount": counts[pid],
			"modelCount":      len(list),
		})
		for _, m := range list {
			models = append(models, map[string]any{
				"id":           pid + "/" + m.ID,
				"name":         firstNonEmpty(m.Name, m.ID),
				"provider":     pid,
				"kind":         firstNonEmpty(m.Kind, "llm"),
				"capabilities": m.Capabilities,
			})
		}
	}

	overrides := g.kvObject("settings", "providerOverrides")
	nodes := g.kvList("meta", "providerNodes")
	combos, _ := g.db.ListCombos()

	jsonResponse(w, http.StatusOK, map[string]any{
		"providers":      providers,
		"models":         models,
		"nodes":          nodes,
		"combos":         combos,
		"overrides":      overrides,
		"customModels":   g.kvList("meta", "customModels"),
		"disabledModels": g.kvList("meta", "disabledModels"),
		"generatedAt":    time.Now().UTC().Format(time.RFC3339),
	})
}

func (g *Gateway) modelsCatalogSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	total := 0
	for _, pid := range g.catalog.ProviderIDs() {
		total += len(g.catalog.Models(pid))
	}
	jsonResponse(w, http.StatusOK, map[string]any{
		"success":   true,
		"providers": len(g.catalog.ProviderIDs()),
		"models":    total,
		"source":    g.catalog.Source(),
		"syncedAt":  time.Now().UTC().Format(time.RFC3339),
	})
}

func (g *Gateway) modelsAvailability(w http.ResponseWriter, r *http.Request) {
	conns, _ := g.db.GetActiveConnections("")
	available := map[string]bool{}
	for _, c := range conns {
		available[c.Provider] = true
	}
	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, http.StatusOK, map[string]any{
			"availability": available,
			"providers":    available,
			"count":        len(available),
		})
	case http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		provider := strings.TrimSpace(asString(body["provider"]))
		if provider == "" {
			jsonError(w, http.StatusBadRequest, "Invalid request", nil)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"ok":        true,
			"provider":  provider,
			"available": available[provider],
		})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// modelsTest performs a live check against an OpenAI-compatible /models probe so
// the dashboard's "test model" button reports something real instead of a stub.
func (g *Gateway) modelsTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	model := strings.TrimSpace(firstNonEmpty(asString(body["model"]), asString(body["id"])))
	if model == "" {
		jsonError(w, http.StatusBadRequest, "Model required", nil)
		return
	}
	start := time.Now()
	diag := g.probeProvider(model)
	diag["model"] = model
	diag["latencyMs"] = time.Since(start).Milliseconds()
	jsonResponse(w, http.StatusOK, diag)
}

// ------------------------------------------------------------- combo presets

func (g *Gateway) handleComboPresets(w http.ResponseWriter, r *http.Request) {
	source := strings.TrimSpace(r.URL.Query().Get("source"))
	items := g.buildPresetItems(source)

	switch r.Method {
	case http.MethodGet:
		if source != "cursor" && source != "claude" {
			jsonError(w, http.StatusBadRequest, "source must be 'cursor' or 'claude'", nil)
			return
		}
		combos, _ := g.db.ListCombos()
		existing := map[string]bool{}
		for _, c := range combos {
			existing[c.Name] = true
		}
		preview := make([]map[string]any, 0, len(items))
		for _, item := range items {
			preview = append(preview, map[string]any{
				"name":   item["name"],
				"models": item["models"],
				"exists": existing[asString(item["name"])],
			})
		}
		jsonResponse(w, http.StatusOK, map[string]any{"source": source, "items": preview})
	case http.MethodPost:
		body, _ := decodeJSONBody(w, r)
		if s := strings.TrimSpace(asString(body["source"])); s != "" {
			source = s
			items = g.buildPresetItems(source)
		}
		if source != "cursor" && source != "claude" {
			jsonError(w, http.StatusBadRequest, "source must be 'cursor' or 'claude'", nil)
			return
		}
		created := []string{}
		skipped := []string{}
		for _, item := range items {
			name := asString(item["name"])
			models, _ := json.Marshal(item["models"])
			if _, err := g.db.CreateCombo(database.Combo{
				ID:     name,
				Name:   name,
				Kind:   "llm",
				Models: string(models),
			}); err != nil {
				skipped = append(skipped, name)
				continue
			}
			created = append(created, name)
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"success": true,
			"created": created,
			"skipped": skipped,
		})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// buildPresetItems ports src/lib/comboPresets.js: client-native names seeded
// with the matching prefixed model so a Cursor/Claude client routes without a
// rewrite.
func (g *Gateway) buildPresetItems(source string) []map[string]any {
	spec := map[string]struct {
		provider string
		alias    string
	}{
		"cursor": {"cursor", "cu"},
		"claude": {"claude", "cc"},
	}[source]
	if spec.provider == "" {
		return []map[string]any{}
	}

	models := []map[string]any{}
	seen := map[string]bool{}
	providerAlias := spec.alias
	if provider, ok := g.catalog.Provider(spec.provider); ok && provider.Alias != "" {
		providerAlias = provider.Alias
	}
	for _, m := range g.catalog.Models(spec.provider) {
		if m.ID == "" || seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		models = append(models, map[string]any{
			"name":   m.ID,
			"models": []string{providerAlias + "/" + m.ID},
		})
	}
	if source == "claude" {
		extra := map[string]string{
			"default":  providerAlias + "/claude-sonnet-5",
			"opusplan": providerAlias + "/claude-opus-5",
		}
		for name, target := range extra {
			if seen[name] {
				continue
			}
			seen[name] = true
			models = append(models, map[string]any{"name": name, "models": []string{target}})
		}
	}
	return models
}

// ------------------------------------------------------------ provider extras

func (g *Gateway) handleProvidersExtras(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/providers"), "/")

	switch {
	case rest == "client":
		g.providersClient(w, r)
	case rest == "prune-dead":
		g.providersPruneDead(w, r)
	case rest == "suggested-models":
		g.providersSuggestedModels(w, r)
	case rest == "kilo/free-models":
		g.providersKiloFreeModels(w, r)
	case rest == "test-batch":
		g.providersTestBatch(w, r)
	case rest == "validate":
		g.providersValidate(w, r)
	case strings.HasSuffix(rest, "/overrides"):
		g.providerOverrides(w, r, strings.TrimSuffix(rest, "/overrides"))
	case strings.HasSuffix(rest, "/test-models"):
		g.providerTestModels(w, r, strings.TrimSuffix(rest, "/test-models"))
	case strings.HasSuffix(rest, "/test"):
		g.providerTestSingle(w, r, strings.TrimSuffix(rest, "/test"))
	default:
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

func (g *Gateway) providersClient(w http.ResponseWriter, r *http.Request) {
	conns, _ := g.db.GetActiveConnections("")
	providerFilter := strings.TrimSpace(r.URL.Query().Get("provider"))
	accountStatus := strings.TrimSpace(r.URL.Query().Get("accountStatus"))

	options := map[string]bool{}
	eligible := make([]map[string]any, 0, len(conns))
	for _, c := range conns {
		options[c.Provider] = true
		if providerFilter != "" && providerFilter != "all" && c.Provider != providerFilter {
			continue
		}
		if accountStatus == "inactive" {
			continue
		}
		eligible = append(eligible, map[string]any{
			"id":        c.ID,
			"provider":  c.Provider,
			"authType":  c.AuthType,
			"name":      c.Name,
			"email":     c.Email,
			"priority":  c.Priority,
			"isActive":  c.IsActive,
			"createdAt": c.CreatedAt,
			"updatedAt": c.UpdatedAt,
		})
	}
	optionList := make([]string, 0, len(options))
	for name := range options {
		optionList = append(optionList, name)
	}
	sort.Strings(optionList)

	jsonResponse(w, http.StatusOK, map[string]any{
		"connections":     eligible,
		"providerOptions": optionList,
		"pagination": map[string]any{
			"page":       1,
			"pageSize":   len(eligible),
			"total":      len(eligible),
			"totalPages": 1,
		},
		"totals": map[string]any{
			"eligibleConnections":         len(eligible),
			"providerFilteredConnections": len(eligible),
		},
	})
}

func (g *Gateway) providersPruneDead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	removed, err := g.db.PruneDeadProxyPools()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to prune dead pools", err)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"success": true, "removed": removed})
}

func (g *Gateway) providersSuggestedModels(w http.ResponseWriter, r *http.Request) {
	url := strings.TrimSpace(r.URL.Query().Get("url"))
	kind := strings.TrimSpace(r.URL.Query().Get("type"))
	if url == "" || kind == "" {
		jsonError(w, http.StatusBadRequest, "Missing url or type", nil)
		return
	}
	// Free catalogues that need no auth and speak OpenAI: answer from the
	// embedded catalogue so the picker still fills while offline.
	data := []map[string]any{}
	for _, pid := range g.catalog.ProviderIDs() {
		provider, ok := g.catalog.Provider(pid)
		if !ok || !provider.NoAuth {
			continue
		}
		for _, m := range g.catalog.Models(pid) {
			data = append(data, map[string]any{"id": m.ID, "name": firstNonEmpty(m.Name, m.ID)})
			if len(data) >= 200 {
				break
			}
		}
		if len(data) >= 200 {
			break
		}
	}
	jsonResponse(w, http.StatusOK, map[string]any{"data": data, "url": url, "type": kind})
}

func (g *Gateway) providersKiloFreeModels(w http.ResponseWriter, r *http.Request) {
	models := []map[string]any{}
	for _, m := range g.catalog.Models("kilo") {
		models = append(models, map[string]any{"id": m.ID, "name": firstNonEmpty(m.Name, m.ID)})
	}
	jsonResponse(w, http.StatusOK, map[string]any{"models": models, "count": len(models)})
}

func (g *Gateway) providersTestBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	ids := asStringSlice(body["providers"])
	if len(ids) == 0 {
		ids = asStringSlice(body["ids"])
	}
	results := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		diag := g.probeProvider(id)
		diag["provider"] = id
		results = append(results, diag)
	}
	jsonResponse(w, http.StatusOK, map[string]any{"success": true, "results": results})
}

func (g *Gateway) providersValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	provider := strings.TrimSpace(asString(body["provider"]))
	apiKey := strings.TrimSpace(firstNonEmpty(asString(body["apiKey"]), asString(body["key"])))
	if provider == "" || apiKey == "" {
		jsonError(w, http.StatusBadRequest, "Provider and API key required", nil)
		return
	}
	// The catalogue knows the auth style; anything without a base URL cannot be
	// probed, which is reported instead of guessed as valid.
	entry, known := g.catalog.Provider(provider)
	if !known {
		jsonResponse(w, http.StatusOK, map[string]any{"valid": false, "error": "Unknown provider"})
		return
	}
	if entry.BaseURL == "" {
		jsonResponse(w, http.StatusOK, map[string]any{"valid": true, "note": "provider does not expose a probe endpoint"})
		return
	}
	diag := g.probeKey(entry.BaseURL, apiKey)
	jsonResponse(w, http.StatusOK, diag)
}

func (g *Gateway) providerOverrides(w http.ResponseWriter, r *http.Request, provider string) {
	provider = strings.Trim(provider, "/")
	overrides := g.kvObject("settings", "providerOverrides")

	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, http.StatusOK, map[string]any{"provider": provider, "override": overrides[provider]})
	case http.MethodPut, http.MethodPost:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		blocked := map[string]bool{
			"host": true, "content-length": true, "content-type": true,
			"connection": true, "transfer-encoding": true, "authorization": true, "cookie": true,
		}
		headers, _ := body["headers"].(map[string]any)
		clean := map[string]any{}
		for name, value := range headers {
			lower := strings.ToLower(name)
			if blocked[lower] {
				jsonError(w, http.StatusBadRequest, "Header "+name+" cannot be overridden", nil)
				return
			}
			text, isString := value.(string)
			if !isString || strings.ContainsAny(text, "\r\n") {
				jsonError(w, http.StatusBadRequest, "Invalid value for header "+name, nil)
				return
			}
			if strings.TrimSpace(text) == "" {
				continue
			}
			clean[name] = text
		}
		if len(clean) == 0 {
			delete(overrides, provider)
		} else {
			overrides[provider] = map[string]any{"headers": clean}
		}
		if err := g.kvPutObject("settings", "providerOverrides", overrides); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save override", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "provider": provider, "override": overrides[provider]})
	case http.MethodDelete:
		delete(overrides, provider)
		if err := g.kvPutObject("settings", "providerOverrides", overrides); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to delete override", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

func (g *Gateway) providerTestSingle(w http.ResponseWriter, r *http.Request, provider string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	diag := g.probeProvider(strings.Trim(provider, "/"))
	diag["provider"] = strings.Trim(provider, "/")
	jsonResponse(w, http.StatusOK, diag)
}

func (g *Gateway) providerTestModels(w http.ResponseWriter, r *http.Request, provider string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	provider = strings.Trim(provider, "/")
	body, _ := decodeJSONBody(w, r)
	ids := asStringSlice(body["models"])
	if len(ids) == 0 {
		for _, m := range g.catalog.Models(provider) {
			ids = append(ids, m.ID)
			if len(ids) >= 20 {
				break
			}
		}
	}
	results := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		diag := g.probeProvider(provider)
		diag["model"] = id
		results = append(results, diag)
	}
	jsonResponse(w, http.StatusOK, map[string]any{"success": true, "provider": provider, "results": results})
}

// --------------------------------------------------------------- key sharing

func (g *Gateway) handleKeysExtras(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/keys"), "/")
	switch {
	case strings.HasSuffix(rest, "/share"):
		id := strings.TrimSuffix(rest, "/share")
		g.keyShare(w, r, strings.Trim(id, "/"))
	case strings.HasSuffix(rest, "/acl"):
		id := strings.TrimSuffix(rest, "/acl")
		g.keyACLExtras(w, r, strings.Trim(id, "/"))
	default:
		jsonError(w, http.StatusNotFound, "not found", nil)
	}
}

func (g *Gateway) keyShare(w http.ResponseWriter, r *http.Request, keyID string) {
	keys, err := g.db.ListAPIKeys()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to load keys", err)
		return
	}
	known := false
	for i := range keys {
		if keys[i].ID == keyID {
			known = true
			break
		}
	}
	if !known {
		jsonError(w, http.StatusNotFound, "Key not found", nil)
		return
	}

	switch r.Method {
	case http.MethodGet:
		shares, err := g.db.ListShareTokens(keyID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load shares", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"success": true,
			"shares":  shares,
			"tokens":  shares,
		})
	case http.MethodPost:
		body, _ := decodeJSONBody(w, r)
		ttl := 30
		if value := asInt(body["ttlDays"]); value > 0 {
			ttl = value
		}
		share, err := g.db.CreateShareToken(keyID, asString(body["label"]), ttl)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to create share", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"success": true,
			"share":   share,
			"token":   share.Token,
			"url":     "/share/" + share.Token,
		})
	case http.MethodDelete:
		token := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("token"), r.URL.Query().Get("id")))
		if token == "" {
			jsonError(w, http.StatusBadRequest, "token is required", nil)
			return
		}
		removed, err := g.db.RevokeShareToken(token)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to revoke share", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": removed})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

func (g *Gateway) keyACLExtras(w http.ResponseWriter, r *http.Request, keyID string) {
	keys, err := g.db.ListAPIKeys()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "Failed to load keys", err)
		return
	}
	var key *database.APIKey
	for i := range keys {
		if keys[i].ID == keyID {
			key = &keys[i]
			break
		}
	}
	if key == nil {
		jsonError(w, http.StatusNotFound, "Key not found", nil)
		return
	}

	switch r.Method {
	case http.MethodGet:
		acl, err := g.db.GetAPIKeyACL(keyID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to load ACL", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{
			"success":          true,
			"apiKeyId":         keyID,
			"allowedModels":    firstNonEmpty(key.AllowedModels, "*"),
			"deniedModels":     acl.DeniedModels,
			"allowedProviders": acl.AllowedProviders,
			"notes":            acl.Notes,
			"updatedAt":        acl.UpdatedAt,
		})
	case http.MethodPost, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		acl := database.APIKeyACL{
			APIKeyID:         keyID,
			DeniedModels:     joinPatterns(body["deniedModels"]),
			AllowedProviders: joinPatterns(body["allowedProviders"]),
			Notes:            asString(body["notes"]),
		}
		if err := g.db.UpsertAPIKeyACL(acl); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to save ACL", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "acl": acl})
	case http.MethodDelete:
		acl := database.APIKeyACL{APIKeyID: keyID}
		if err := g.db.UpsertAPIKeyACL(acl); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to clear ACL", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true, "acl": acl})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}

// joinPatterns normalises the ACL fields, which the Node repo stores as
// comma-separated pattern lists.
func joinPatterns(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(asString(item)); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, ",")
	default:
		return strings.TrimSpace(asString(value))
	}
}

// --------------------------------------------------------------- provider nodes

func (g *Gateway) handleProviderNodes(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/provider-nodes"), "/")
	if rest == "validate" {
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		baseURL := strings.TrimSpace(asString(body["baseUrl"]))
		if baseURL == "" {
			jsonError(w, http.StatusBadRequest, "baseUrl is required", nil)
			return
		}
		diag := g.probeKey(baseURL, asString(body["apiKey"]))
		jsonResponse(w, http.StatusOK, diag)
		return
	}

	nodes := g.kvList("meta", "providerNodes")

	if rest == "" {
		switch r.Method {
		case http.MethodGet:
			jsonResponse(w, http.StatusOK, map[string]any{"nodes": nodes})
		case http.MethodPost:
			body, ok := decodeJSONBody(w, r)
			if !ok {
				return
			}
			name := strings.TrimSpace(asString(body["name"]))
			prefix := strings.TrimSpace(asString(body["prefix"]))
			if name == "" || prefix == "" {
				jsonError(w, http.StatusBadRequest, "Name and prefix are required", nil)
				return
			}
			for _, node := range nodes {
				if asString(node["prefix"]) == prefix {
					jsonError(w, http.StatusConflict, "Prefix already in use", nil)
					return
				}
			}
			body["id"] = newCompatID()
			body["name"] = name
			body["prefix"] = prefix
			body["createdAt"] = time.Now().UTC().Format(time.RFC3339)
			nodes = append(nodes, body)
			if err := g.kvPutList("meta", "providerNodes", nodes); err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to save node", err)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"success": true, "node": body})
		default:
			jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		}
		return
	}

	// /api/provider-nodes/{id}
	id := strings.Trim(rest, "/")
	switch r.Method {
	case http.MethodGet:
		for _, node := range nodes {
			if asString(node["id"]) == id {
				jsonResponse(w, http.StatusOK, map[string]any{"node": node})
				return
			}
		}
		jsonError(w, http.StatusNotFound, "Node not found", nil)
	case http.MethodPatch, http.MethodPut:
		body, ok := decodeJSONBody(w, r)
		if !ok {
			return
		}
		for i, node := range nodes {
			if asString(node["id"]) != id {
				continue
			}
			for key, value := range body {
				node[key] = value
			}
			node["id"] = id
			node["updatedAt"] = time.Now().UTC().Format(time.RFC3339)
			nodes[i] = node
			if err := g.kvPutList("meta", "providerNodes", nodes); err != nil {
				jsonError(w, http.StatusInternalServerError, "Failed to update node", err)
				return
			}
			jsonResponse(w, http.StatusOK, map[string]any{"success": true, "node": node})
			return
		}
		jsonError(w, http.StatusNotFound, "Node not found", nil)
	case http.MethodDelete:
		kept := make([]map[string]any, 0, len(nodes))
		for _, node := range nodes {
			if asString(node["id"]) != id {
				kept = append(kept, node)
			}
		}
		if err := g.kvPutList("meta", "providerNodes", kept); err != nil {
			jsonError(w, http.StatusInternalServerError, "Failed to delete node", err)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"success": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
	}
}
