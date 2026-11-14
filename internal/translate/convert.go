package translate

import (
	"fmt"
	"sort"
	"strings"
)

func sortedStrings(in []string) []string {
	sort.Strings(in)
	return in
}

// helper conversions shared by the translators. These are deliberately small and
// tolerant: the Node originals use JS implicit coercion, and the Go port has to
// make the same decisions explicitly rather than panic on a shape it did not  expect.

// asMap reads a JSON object, returning nil when the value is absent or another type.
func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// asSlice reads a JSON array, returning nil when the value is absent or another type.
func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

// asString reads a string, treating a missing value as "".
func asString(v any) string {
	s, _ := v.(string)
	return s
}

// asBool reads a boolean, defaulting to false.
func asBool(v any) bool {
	b, _ := v.(bool)
	return b
}

// asFloat reads a number, accepting the int and float shapes encoding/json
// produces. Returns (0, false) when the value is not numeric so callers can tell
// "absent" from "zero" — the difference matters for temperature and top_p.
func asFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

// asInt reads a whole number, truncating a float the way JS does on bitwise or
// index use.
func asInt(v any) (int, bool) {
	f, ok := asFloat(v)
	if !ok {
		return 0, false
	}
	return int(f), true
}

// textOf extracts the plain text of a content value that may be a string or a
// Claude content-block array. Used when a translator needs the text regardless of
// which dialect produced it.
func textOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	parts := asSlice(v)
	var b strings.Builder
	for i, p := range parts {
		m := asMap(p)
		if m == nil {
			continue
		}
		if t, ok := m["text"].(string); ok {
			if i > 0 && b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(t)
		}
	}
	return b.String()
}

// collapseTextParts mirrors concerns/message.js: a single text part collapses to a
// bare string, anything else stays an array.
func collapseTextParts(parts []any) any {
	if len(parts) == 1 {
		if m := asMap(parts[0]); m != nil && asString(m["type"]) == OpenAIText {
			return asString(m["text"])
		}
	}
	return parts
}

// encodeDataURI builds the data: URL OpenAI expects for an inline image.
func encodeDataURI(mediaType, data string) string {
	mt := mediaType
	if mt == "" {
		mt = DefaultImageMIME
	}
	return "data:" + mt + ";base64," + data
}

// errShape reports a body that cannot be translated at all. Translators return
// this instead of producing a half-converted request, which would fail upstream
// with a much less informative error.
func errShape(what string, got any) error {
	return fmt.Errorf("translator: %s has unexpected shape %T", what, got)
}
