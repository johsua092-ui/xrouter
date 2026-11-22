package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/johsua092-ui/xrouter/internal/catalog"
)

func newTestGateway() *Gateway {
	return &Gateway{catalog: catalog.MustLoad()}
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, rec.Body.String())
	}
	return out
}

func TestModelsListServesCatalogue(t *testing.T) {
	g := newTestGateway()
	rec := httptest.NewRecorder()
	g.handleModels(rec, httptest.NewRequest(http.MethodGet, "/v1/models", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decode(t, rec)
	if body["object"] != "list" {
		t.Fatalf("object = %v, want list", body["object"])
	}
	data, _ := body["data"].([]any)
	if len(data) < 100 {
		t.Fatalf("expected a full catalogue, got %d models", len(data))
	}

	// Every id must be provider-prefixed, otherwise routing cannot split it.
	for _, raw := range data[:20] {
		entry := raw.(map[string]any)
		id, _ := entry["id"].(string)
		if !strings.Contains(id, "/") {
			t.Fatalf("model id %q has no provider prefix", id)
		}
		if entry["owned_by"] == "" {
			t.Fatalf("model %q has no owned_by", id)
		}
	}
}

func TestKindFilterReturnsOnlyThatKind(t *testing.T) {
	g := newTestGateway()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/models/image", nil)
	g.handleModelByPath(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	data := decode(t, rec)["data"].([]any)
	if len(data) == 0 {
		t.Fatal("image filter returned no models")
	}
	for _, raw := range data {
		if kind, _ := raw.(map[string]any)["kind"].(string); kind != KindImage {
			t.Fatalf("image filter leaked kind %q", kind)
		}
	}
}

func TestModelInfoIncludesEndpoint(t *testing.T) {
	g := newTestGateway()

	var target string
	for _, id := range g.catalog.ProviderIDs() {
		alias := catalog.AliasOf(g.catalog.Providers[id])
		models := g.catalog.Models(alias)
		if len(models) > 0 {
			target = alias + "/" + models[0].ID
			break
		}
	}

	rec := httptest.NewRecorder()
	g.handleModelByPath(rec, httptest.NewRequest(http.MethodGet, "/v1/models/"+target, nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	entry := decode(t, rec)
	if entry["id"] != target {
		t.Fatalf("id = %v, want %s", entry["id"], target)
	}
	if entry["endpoint"] == "" {
		t.Fatal("model info has no endpoint")
	}
	if entry["kind"] == "" {
		t.Fatal("model info has no kind")
	}
}

func TestUnknownModelReturnsOpenAIShape(t *testing.T) {
	g := newTestGateway()
	rec := httptest.NewRecorder()
	g.handleModelByPath(rec, httptest.NewRequest(http.MethodGet, "/v1/models/nope/none", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	errObj, _ := decode(t, rec)["error"].(map[string]any)
	if errObj["code"] != "model_not_found" {
		t.Fatalf("error code = %v, want model_not_found", errObj["code"])
	}
}

func TestGeminiModelsArePrefixed(t *testing.T) {
	g := newTestGateway()
	rec := httptest.NewRecorder()
	g.handleGeminiModels(rec, httptest.NewRequest(http.MethodGet, "/v1beta/models", nil))

	models, _ := decode(t, rec)["models"].([]any)
	if len(models) < 100 {
		t.Fatalf("expected a full catalogue, got %d", len(models))
	}
	for _, raw := range models[:20] {
		name, _ := raw.(map[string]any)["name"].(string)
		if !strings.HasPrefix(name, "models/") {
			t.Fatalf("gemini model name %q is not prefixed", name)
		}
		methods, _ := raw.(map[string]any)["supportedGenerationMethods"].([]any)
		if len(methods) == 0 {
			t.Fatalf("gemini model %q has no methods", name)
		}
	}
}

func TestEstimateAnthropicInputTokens(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
		want int
	}{
		{
			name: "empty",
			body: map[string]any{},
			want: 0,
		},
		{
			name: "system and string content",
			body: map[string]any{
				"system": "12345678", // 8 chars
				"messages": []any{
					map[string]any{"role": "user", "content": "abcd"}, // 4 chars
				},
			},
			want: 3, // (8+4)/4
		},
		{
			name: "content blocks",
			body: map[string]any{
				"messages": []any{
					map[string]any{"content": []any{
						map[string]any{"type": "text", "text": "1234"},                  // 4
						map[string]any{"type": "tool_use", "name": "ab", "input": "cd"}, // 4
					}},
				},
			},
			want: 2, // 8/4
		},
		{
			name: "object keys count",
			body: map[string]any{
				"messages": []any{
					map[string]any{"content": map[string]any{"ab": "cd"}}, // 2 key + 2 value
				},
			},
			want: 1,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := EstimateAnthropicInputTokens(tc.body); got != tc.want {
				t.Fatalf("got %d tokens, want %d", got, tc.want)
			}
		})
	}
}

func TestCountTokensRejectsInvalidJSON(t *testing.T) {
	g := newTestGateway()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens",
		strings.NewReader("{not json"))
	g.handleCountTokens(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestOllamaWriterTransformsStream(t *testing.T) {
	rec := httptest.NewRecorder()
	writer := newOllamaStreamWriter(rec, "llama3.2")

	frames := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"Hel"}}]}`,
		``,
		`data: {"choices":[{"delta":{"content":"lo"}}]}`,
		``,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	if _, err := writer.Write([]byte(frames)); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	writer.Close()

	// Three lines: two content frames plus one terminal frame. The trailing
	// [DONE] must not add a second done:true — the writer collapses it once the
	// stream has already been terminated.
	lines := strings.Split(strings.TrimSpace(rec.Body.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 ndjson lines, got %d: %q", len(lines), rec.Body.String())
	}

	var first map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatalf("first line is not JSON: %v", err)
	}
	if first["model"] != "llama3.2" {
		t.Fatalf("model = %v", first["model"])
	}
	msg, _ := first["message"].(map[string]any)
	if msg["content"] != "Hel" {
		t.Fatalf("first content = %v, want Hel", msg["content"])
	}
	if first["done"] != false {
		t.Fatalf("first line should not be done")
	}

	last := lines[len(lines)-1]
	var final map[string]any
	if err := json.Unmarshal([]byte(last), &final); err != nil {
		t.Fatalf("last line is not JSON: %v", err)
	}
	if final["done"] != true {
		t.Fatalf("final line done = %v, want true", final["done"])
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/x-ndjson" {
		t.Fatalf("content-type = %q, want application/x-ndjson", ct)
	}
}

func TestOllamaWriterPassesErrorsThrough(t *testing.T) {
	rec := httptest.NewRecorder()
	writer := newOllamaStreamWriter(rec, "llama3.2")

	writer.WriteHeader(http.StatusServiceUnavailable)
	body := `{"error":"no active connection for provider","provider":"agnes"}`
	if _, err := writer.Write([]byte(body)); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	writer.Close()

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != body {
		t.Fatalf("error body was rewritten: %q", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"done"`) {
		t.Fatal("error body was converted to an ollama frame")
	}
}

func TestOllamaWriterAccumulatesToolCalls(t *testing.T) {
	rec := httptest.NewRecorder()
	writer := newOllamaStreamWriter(rec, "qwen3")

	frames := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_","arguments":"{\"ci"}}]}}]}`,
		``,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"weather","arguments":"ty\":\"Paris\"}"}}]}}]}`,
		``,
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		``,
	}, "\n")

	if _, err := writer.Write([]byte(frames)); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	writer.Close()

	lines := strings.Split(strings.TrimSpace(rec.Body.String()), "\n")
	var final map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &final); err != nil {
		t.Fatalf("final line is not JSON: %v", err)
	}
	msg, _ := final["message"].(map[string]any)
	calls, _ := msg["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("expected 1 tool call, got %d (%s)", len(calls), rec.Body.String())
	}
	fn, _ := calls[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "get_weather" {
		t.Fatalf("tool name = %v, want get_weather (fragments must be concatenated)", fn["name"])
	}
	args, _ := fn["arguments"].(map[string]any)
	if args["city"] != "Paris" {
		t.Fatalf("arguments = %v, want decoded city Paris", args)
	}
	if final["done"] != true {
		t.Fatalf("final line done = %v", final["done"])
	}
}
