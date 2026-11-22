package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/johsua092-ui/xrouter/internal/catalog"
)

// Kind identifiers used by the catalogue and by the model-listing endpoints.
// They match the Node strings exactly: a client that filters on ?kind=stt is
// sending this value, not a Go-flavoured synonym.
const (
	KindLLM       = "llm"
	KindImage     = "image"
	KindTTS       = "tts"
	KindSTT       = "stt"
	KindEmbedding = "embedding"
	KindImageToTx = "imageToText"
	KindWebSearch = "webSearch"
	KindWebFetch  = "webFetch"
)

// kindEndpoint maps a model kind onto the endpoint that serves it. This is the
// contract /v1/models/info publishes so a client can discover where a model is
// actually callable, and it mirrors the Node KIND_ENDPOINT table.
var kindEndpoint = map[string]string{
	KindLLM:       "/v1/chat/completions",
	KindImage:     "/v1/images/generations",
	KindTTS:       "/v1/audio/speech",
	KindSTT:       "/v1/audio/transcriptions",
	KindEmbedding: "/v1/embeddings",
	KindImageToTx: "/v1/chat/completions",
	KindWebSearch: "/v1/search",
	KindWebFetch:  "/v1/fetch",
}

// kindSlug maps the URL slug a client asks for onto catalogue kinds. `web`
// covers both halves of the web tool pair, exactly as Node's KIND_SLUG_MAP does.
var kindSlug = map[string][]string{
	"image":         {KindImage},
	"tts":           {KindTTS},
	"stt":           {KindSTT},
	"embedding":     {KindEmbedding},
	"image-to-text": {KindImageToTx},
	"web":           {KindWebSearch, KindWebFetch},
}

// ttsVoicesProviders are the TTS backends that expose a live voice list, so the
// info endpoint can advertise a voicesUrl for them.
var ttsVoicesProviders = map[string]bool{
	"elevenlabs": true, "edge-tts": true, "deepgram": true,
	"inworld": true, "local-device": true,
}

// modelEntries builds the OpenAI-shaped model list for the requested kinds.
//
// Node builds this from the live catalogue plus per-connection resolvers,
// disabled-model settings and API-key allowlists. The Go core deliberately
// serves the static catalogue: it cannot decrypt the sealed credential vault,
// so a live per-connection catalogue would be a promise it cannot keep. Routes
// are unchanged — a model listed here is routable through the same adapters.
func (g *Gateway) modelEntries(kinds []string) []map[string]any {
	c := g.catalog
	allowed := func(kind string) bool {
		if len(kinds) == 0 {
			return true
		}
		for _, k := range kinds {
			if k == kind {
				return true
			}
		}
		return false
	}

	out := make([]map[string]any, 0, 256)
	seen := make(map[string]bool, 256)

	for _, id := range c.ProviderIDs() {
		p := c.Providers[id]
		alias := catalog.AliasOf(p)
		for _, m := range c.Models(alias) {
			kind := catalog.KindOf(m)
			if !allowed(kind) {
				continue
			}
			full := alias + "/" + m.ID
			if seen[full] {
				continue
			}
			seen[full] = true

			entry := map[string]any{
				"id":       full,
				"object":   "model",
				"owned_by": alias,
			}
			if m.Name != "" {
				entry["name"] = m.Name
			}
			if kind != KindLLM {
				entry["kind"] = kind
			}
			if hasItems(m.Capabilities) {
				entry["capabilities"] = m.Capabilities
			}
			if cw, ok := m.ContextWindow.(float64); ok && cw > 0 {
				entry["context_length"] = int(cw)
			}
			out = append(out, entry)
		}
	}
	return out
}

// modelInfoEntry enriches one list entry with everything a client needs to call
// it: the endpoint, declared params, capabilities and — for TTS backends with a
// live voice list — where to fetch voices.
func modelInfoEntry(c *catalog.Catalog, alias string, m catalog.Model, p catalog.Provider) map[string]any {
	kind := catalog.KindOf(m)
	entry := map[string]any{
		"id":       alias + "/" + m.ID,
		"name":     firstNonEmpty(m.Name, m.ID),
		"kind":     kind,
		"owned_by": alias,
		"endpoint": kindEndpoint[kind],
	}
	if len(m.Params) > 0 {
		entry["params"] = m.Params
	}
	if hasItems(m.Capabilities) {
		entry["capabilities"] = m.Capabilities
	}
	if hasItems(m.Options) {
		entry["options"] = m.Options
	}
	if m.Dimensions != nil {
		entry["dimensions"] = m.Dimensions
	}
	if m.ContextWindow != nil {
		entry["contextWindow"] = m.ContextWindow
	}
	if kind == KindTTS && ttsVoicesProviders[p.ID] {
		entry["voicesUrl"] = "/v1/audio/voices?provider=" + p.ID
	}
	if kind == KindWebSearch && p.SearchConfig != nil {
		if len(p.SearchConfig.SearchTypes) > 0 {
			entry["searchTypes"] = p.SearchConfig.SearchTypes
		}
		if p.SearchConfig.MaxMaxResults > 0 {
			entry["maxResults"] = p.SearchConfig.MaxMaxResults
		}
		if len(p.SearchConfig.RequiredOptions) > 0 {
			entry["required"] = p.SearchConfig.RequiredOptions
		}
	}
	return entry
}

// hasItems reports whether a catalogue value carries content. These fields are
// decoded as `any` because the Node catalogue puts both objects and arrays in
// them, so an emptiness check has to look at the concrete type.
func hasItems(v any) bool {
	switch val := v.(type) {
	case nil:
		return false
	case []any:
		return len(val) > 0
	case map[string]any:
		return len(val) > 0
	case string:
		return val != ""
	}
	return true
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// handleModels serves GET /v1/models — the OpenAI list of chat models.
func (g *Gateway) handleModels(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, http.StatusOK, map[string]any{
		"object": "list",
		"data":   g.modelEntries([]string{KindLLM}),
	})
}

// handleModelInfo serves GET /v1/models/info. With a model query parameter it
// answers for that model only; without one it describes the whole catalogue,
// which is what the media-provider dashboards consume.
func (g *Gateway) handleModelInfo(w http.ResponseWriter, r *http.Request) {
	wanted := strings.TrimSpace(r.URL.Query().Get("model"))
	c := g.catalog

	out := make([]map[string]any, 0, 64)
	for _, id := range c.ProviderIDs() {
		p := c.Providers[id]
		alias := catalog.AliasOf(p)
		for _, m := range c.Models(alias) {
			full := alias + "/" + m.ID
			if wanted != "" && full != wanted {
				continue
			}
			out = append(out, modelInfoEntry(c, alias, m, p))
		}
	}

	if wanted != "" {
		if len(out) == 0 {
			modelNotFound(w, wanted)
			return
		}
		jsonResponse(w, http.StatusOK, out[0])
		return
	}

	jsonResponse(w, http.StatusOK, map[string]any{
		"object": "list",
		"data":   out,
	})
}

// handleModelByPath serves the catch-all under /v1/models.
//
// One segment is a kind filter ("/v1/models/image"), two or more is a single
// model lookup ("/v1/models/oc/glm-5.3-flash") — provider-prefixed ids contain a
// slash, which is why the route has to be a catch-all in the first place.
func (g *Gateway) handleModelByPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/models"), "/")
	if rest == "" {
		g.handleModels(w, r)
		return
	}
	if rest == "info" {
		g.handleModelInfo(w, r)
		return
	}

	segments := strings.Split(rest, "/")
	if len(segments) == 1 {
		if kinds, ok := kindSlug[segments[0]]; ok {
			jsonResponse(w, http.StatusOK, map[string]any{
				"object": "list",
				"data":   g.modelEntries(kinds),
			})
			return
		}
	}

	full := strings.Join(segments, "/")
	m, p, ok := g.catalog.Model(full)
	if !ok {
		modelNotFound(w, full)
		return
	}
	jsonResponse(w, http.StatusOK, modelInfoEntry(g.catalog, catalog.AliasOf(p), m, p))
}

// modelNotFound writes the OpenAI error document a client expects for an
// unknown model id.
func modelNotFound(w http.ResponseWriter, model string) {
	jsonResponse(w, http.StatusNotFound, map[string]any{
		"error": map[string]any{
			"message": "The model '" + model + "' does not exist or you do not have access to it.",
			"type":    "invalid_request_error",
			"code":    "model_not_found",
		},
	})
}

// handleGeminiModels serves GET /v1beta/models in the shape the Gemini SDK
// expects. Gemini names models "models/<id>", so the provider prefix is folded
// into the name rather than dropped.
func (g *Gateway) handleGeminiModels(w http.ResponseWriter, r *http.Request) {
	c := g.catalog
	models := make([]map[string]any, 0, 256)
	seen := make(map[string]bool, 256)

	add := func(name, display, description string, methods []string) {
		if seen[name] {
			return
		}
		seen[name] = true
		models = append(models, map[string]any{
			"name":                       name,
			"displayName":                display,
			"description":                description,
			"supportedGenerationMethods": methods,
			"inputTokenLimit":            128000,
			"outputTokenLimit":           8192,
		})
	}

	for _, id := range c.ProviderIDs() {
		p := c.Providers[id]
		alias := catalog.AliasOf(p)
		for _, m := range c.Models(alias) {
			display := firstNonEmpty(m.Name, m.ID)
			add("models/"+alias+"/"+m.ID, display,
				alias+" model: "+display,
				[]string{"generateContent"})
			if alias == "gemini" {
				add("models/"+m.ID, display, "Gemini model: "+display,
					[]string{"generateContent", "streamGenerateContent"})
			}
		}
	}

	jsonResponse(w, http.StatusOK, map[string]any{"models": models})
}

// handleGeminiModelAction serves /v1beta/models/{path} — the Gemini generate
// entry point.
//
// Gemini puts the model in the URL, not the body, so the path has to be parsed
// and folded into the request before the chat path runs. Both URL conventions
// are accepted: "/v1beta/models/{model}" (provider inferred) and
// "/v1beta/models/{provider}/{model}".
func (g *Gateway) handleGeminiModelAction(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1beta/models"), "/")
	rest = strings.TrimSuffix(rest, ":streamGenerateContent")
	rest = strings.TrimSuffix(rest, ":generateContent")
	if rest == "" {
		jsonError(w, http.StatusBadRequest, "missing model in path", nil)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "could not read request body", err)
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		jsonError(w, http.StatusBadRequest, "request body is not a JSON object", err)
		return
	}

	model := rest
	if !strings.Contains(rest, "/") {
		// Bare model name: resolve the provider from the catalogue so the
		// request still reaches a concrete adapter.
		_, _, ok := g.catalog.Model("gemini/" + rest)
		if !ok {
			found := ""
			for _, id := range g.catalog.ProviderIDs() {
				alias := catalog.AliasOf(g.catalog.Providers[id])
				for _, m := range g.catalog.Models(alias) {
					if m.ID == rest {
						found = alias + "/" + rest
						break
					}
				}
				if found != "" {
					break
				}
			}
			if found == "" {
				modelNotFound(w, rest)
				return
			}
			model = found
		} else {
			model = "gemini/" + rest
		}
	}
	parsed["model"] = model

	rewritten, err := json.Marshal(parsed)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not serialise request", err)
		return
	}
	r.Body = io.NopCloser(strings.NewReader(string(rewritten)))

	// The Gemini dialect is chosen by the path, so the request is handed to the
	// chat path unchanged apart from the body.
	g.handleChatCompletions(w, r)
}
