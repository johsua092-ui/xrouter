package gateway

import (
	"bytes"
	"io"
	"net/http"
)

// readBodyPeek reads the request body so a handler can inspect it and still run
// the normal path afterwards. Callers must restore the body with replayBody.
func readBodyPeek(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	return io.ReadAll(io.LimitReader(r.Body, maxRequestBody))
}

// replayBody rebuilds a request body that has already been consumed.
func replayBody(body []byte) io.ReadCloser {
	return io.NopCloser(bytes.NewReader(body))
}

// asObject reads a decoded JSON object, returning nil for any other type.
func asObject(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// asString reads a string from a decoded JSON value, treating anything else as
// absent.
func asString(v any) string {
	s, _ := v.(string)
	return s
}
