package translate

import (
	"encoding/json"
	"strings"
)

// parseDataURI splits a base64 data URI into its mime type and payload. Returns
// nil when the input is not a data URI. The pattern tolerates newlines inside the
// payload, which some clients insert when they wrap long base64.
func parseDataURI(url string) *dataURI {
	if url == "" {
		return nil
	}
	if !hasPrefix(url, "data:") {
		return nil
	}
	rest := url[len("data:"):]
	semi := strings.Index(rest, ";base64,")
	if semi < 0 {
		return nil
	}
	mime := rest[:semi]
	payload := rest[semi+len(";base64,"):]
	if mime == "" || payload == "" {
		return nil
	}
	return &dataURI{mimeType: mime, base64: collapseWhitespace(payload)}
}

type dataURI struct {
	mimeType string
	base64   string
}

func collapseWhitespace(s string) string {
	if !strings.ContainsAny(s, "\r\n\t") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\r', '\n', '\t':
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

// indentJSON renders pretty-printed JSON for embedding in a prompt, used by the
// JSON-mode system instruction and by the Claude tool-result renderer.
func indentJSON(v any) ([]byte, error) {
	return json.MarshalIndent(v, "", "  ")
}

// fallbackAdapterShim keeps the sentinel adapter name referenced from the
// providers package test suite stable across refactors.
const fallbackAdapterShim = "openai-compatible"
