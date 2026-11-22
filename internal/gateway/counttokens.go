package gateway

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
)

// EstimateAnthropicInputTokens is the Go port of the Node estimator used by
// POST /v1/messages/count_tokens.
//
// It is a character heuristic, not a tokeniser: text + tools + every message
// body, divided by four and rounded up. The point is to answer a client's
// pre-flight budget question without shipping a vocabulary, and it has to match
// the Node numbers exactly or a client that budgets against one engine and runs
// on the other will see its estimates drift.
func EstimateAnthropicInputTokens(body map[string]any) int {
	total := countValueChars(body["system"]) + countValueChars(body["tools"])

	if messages, ok := body["messages"].([]any); ok {
		for _, msg := range messages {
			total += countMessageChars(msg)
		}
	}

	return int(math.Ceil(float64(total) / 4))
}

// countValueChars counts the characters a value contributes, including object
// keys — the Node original does the same, so a JSON body's field names count
// toward the estimate.
func countValueChars(value any) int {
	switch v := value.(type) {
	case nil:
		return 0
	case string:
		return len(v)
	case bool:
		if v {
			return 4 // "true"
		}
		return 5 // "false"
	case float64:
		// JSON numbers decode to float64; count their JSON form the way
		// String(value) would on the Node side.
		return len(numberString(v))
	case []any:
		total := 0
		for _, item := range v {
			total += countValueChars(item)
		}
		return total
	case map[string]any:
		total := 0
		for key, item := range v {
			total += len(key) + countValueChars(item)
		}
		return total
	}
	return 0
}

// numberString renders a JSON number without an exponent or a trailing ".0",
// matching JavaScript's String(number).
func numberString(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return jsonNumberInt(f)
	}
	raw, err := json.Marshal(f)
	if err != nil {
		return "0"
	}
	return string(raw)
}

func jsonNumberInt(f float64) string {
	// strconv-free integer rendering keeps the import list small and avoids
	// float formatting surprises for the magnitudes a token count sees.
	if f == 0 {
		return "0"
	}
	neg := f < 0
	if neg {
		f = -f
	}
	digits := make([]byte, 0, 20)
	for f >= 1 {
		d := int(math.Mod(f, 10))
		digits = append([]byte{byte('0' + d)}, digits...)
		f = math.Floor(f / 10)
	}
	if neg {
		return "-" + string(digits)
	}
	return string(digits)
}

// countContentBlockChars counts one content block. Different block types carry
// their payload in different fields, and a tool_use block's name matters as much
// as its arguments — the Node original counts both.
func countContentBlockChars(block any) int {
	switch b := block.(type) {
	case nil:
		return 0
	case string:
		return len(b)
	case map[string]any:
		switch asString(b["type"]) {
		case "text":
			return countValueChars(b["text"])
		case "tool_use":
			return countValueChars(b["name"]) + countValueChars(b["input"])
		case "tool_result":
			return countValueChars(b["content"])
		case "thinking":
			return countValueChars(b["thinking"])
		default:
			return countValueChars(b)
		}
	}
	return countValueChars(block)
}

func countMessageChars(message any) int {
	msg, ok := message.(map[string]any)
	if !ok {
		return 0
	}

	switch content := msg["content"].(type) {
	case string:
		return len(content)
	case []any:
		total := 0
		for _, block := range content {
			total += countContentBlockChars(block)
		}
		return total
	default:
		return countValueChars(content)
	}
}

// handleCountTokens serves POST /v1/messages/count_tokens.
func (g *Gateway) handleCountTokens(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody))
	if err != nil {
		jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "Invalid JSON body"})
		return
	}

	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "Invalid JSON body"})
		return
	}

	jsonResponse(w, http.StatusOK, map[string]any{
		"input_tokens": EstimateAnthropicInputTokens(parsed),
	})
}
