package providers

import "encoding/json"

// Small JSON helpers shared by the adapters. Kept deliberately tolerant: the
// upstream contract is "best effort normalisation", so a type mismatch yields a
// zero value rather than an error the caller would have to swallow.

// marshalJSON encodes a body for the wire.
func marshalJSON(v interface{}) ([]byte, error) {
	return json.Marshal(v)
}

// unmarshalJSON decodes a request body. Returns an empty map on failure so a
// malformed payload does not panic a normalisation path.
func unmarshalJSON(b []byte) (map[string]interface{}, error) {
	if len(b) == 0 {
		return map[string]interface{}{}, nil
	}
	var out map[string]interface{}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]interface{}{}
	}
	return out, nil
}

// str reads a string field defensively.
func str(v interface{}) string {
	s, _ := v.(string)
	return s
}

// parseInputArray pulls the responses "input" array out of a raw body.
func parseInputArray(body []byte) ([]interface{}, bool) {
	m, err := unmarshalJSON(body)
	if err != nil {
		return nil, false
	}
	arr, ok := m["input"].([]interface{})
	return arr, ok
}

// toStringSlice coerces a JSON value into a string slice.
func toStringSlice(v interface{}) []string {
	arr, ok := v.([]interface{})
	if !ok {
		if s, ok := v.([]string); ok {
			return append([]string(nil), s...)
		}
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// containsStr reports membership in a small slice.
func containsStr(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}

// firstNonEmpty returns the first non-empty string.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
