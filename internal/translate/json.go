package translate

import "encoding/json"

// mustJSON serialises a value for the wire. Translation runs on request bodies
// that already round-tripped through encoding/json, so every value here is
// marshalable; a failure would mean a translator inserted a func or channel, which
// is a programming error rather than bad input.
//
// Returning the empty object rather than panicking keeps a single malformed
// argument from taking down the gateway process — the upstream then rejects that
// one request with a schema error instead.
func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// parseJSONObject decodes a JSON object, returning nil on any failure. Used when a
// translator has to inspect a JSON-encoded argument string it did not produce.
func parseJSONObject(s string) map[string]any {
	if s == "" {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return nil
	}
	return out
}

// deepCopyMap clones a JSON object one level deep in the map, copying nested maps
// and slices by value. Translators mutate bodies in place in Node; the Go port
// copies first wherever a caller might still hold the original (the raw client
// body is logged and re-read).
func deepCopyMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = deepCopyValue(v)
	}
	return out
}

func deepCopyValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return deepCopyMap(t)
	case []any:
		out := make([]any, len(t))
		for i, item := range t {
			out[i] = deepCopyValue(item)
		}
		return out
	default:
		return v
	}
}
