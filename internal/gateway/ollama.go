package gateway

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
)

// ollamaStreamWriter converts the OpenAI SSE the chat path produces into the
// line-delimited JSON that Ollama clients (`/api/chat`) read.
//
// It is a ResponseWriter decorator rather than a buffer: the point of the
// conversion is that a streamed answer arrives incrementally, so the frames have
// to be converted as they are written instead of after the response completes.
// Tool calls are accumulated across frames because OpenAI streams them as
// fragments (name in one chunk, arguments in the next) while Ollama wants one
// complete array on the final line.
type ollamaStreamWriter struct {
	dst   http.ResponseWriter
	model string

	mu            sync.Mutex
	status        int
	headerWritten bool
	buffer        string
	pendingTools  map[int]*ollamaToolCall
	finished      bool
	// passthrough is set once an error status arrives. An error body is a JSON
	// document, not an event stream: converting it would hand the client an
	// empty "done" frame and hide the failure, so it is relayed byte for byte.
	passthrough bool
	flusher     http.Flusher
}

type ollamaToolCall struct {
	Name      string
	Arguments string
}

func newOllamaStreamWriter(dst http.ResponseWriter, model string) *ollamaStreamWriter {
	flusher, _ := dst.(http.Flusher)
	if model == "" {
		model = "llama3.2"
	}
	return &ollamaStreamWriter{
		dst:          dst,
		model:        model,
		status:       http.StatusOK,
		pendingTools: map[int]*ollamaToolCall{},
		flusher:      flusher,
	}
}

func (o *ollamaStreamWriter) Header() http.Header { return o.dst.Header() }

func (o *ollamaStreamWriter) WriteHeader(status int) {
	// The status is held until the first converted frame. Writing it early would
	// commit the upstream Content-Type (text/event-stream) and Ollama clients
	// would then fail to parse the body they asked for.
	o.mu.Lock()
	o.status = status
	if status >= http.StatusBadRequest {
		o.passthrough = true
	}
	o.mu.Unlock()
}

func (o *ollamaStreamWriter) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()

	if o.passthrough {
		if !o.headerWritten {
			o.dst.WriteHeader(o.status)
			o.headerWritten = true
		}
		return o.dst.Write(p)
	}

	o.buffer += string(p)
	lines := strings.Split(o.buffer, "\n")
	o.buffer = lines[len(lines)-1]

	for _, line := range lines[:len(lines)-1] {
		o.handleLineLocked(strings.TrimSpace(line))
	}
	return len(p), nil
}

// Flush implements http.Flusher so the streaming path can push each converted
// line to the client immediately.
func (o *ollamaStreamWriter) Flush() {
	o.mu.Lock()
	o.commitHeaderLocked()
	o.mu.Unlock()
	if o.flusher != nil {
		o.flusher.Flush()
	}
}

// Close flushes any half-line left in the buffer and emits the terminal frame
// Ollama expects, so a client always sees done:true.
func (o *ollamaStreamWriter) Close() {
	o.mu.Lock()
	defer o.mu.Unlock()

	if o.passthrough {
		return
	}

	if strings.TrimSpace(o.buffer) != "" {
		o.handleLineLocked(strings.TrimSpace(o.buffer))
		o.buffer = ""
	}
	if !o.finished {
		o.emitLocked(map[string]any{
			"model":   o.model,
			"message": map[string]any{"role": "assistant", "content": ""},
			"done":    true,
		})
		o.finished = true
	}
	if o.flusher != nil {
		o.flusher.Flush()
	}
}

func (o *ollamaStreamWriter) commitHeaderLocked() {
	if o.headerWritten {
		return
	}
	o.dst.Header().Set("Content-Type", "application/x-ndjson")
	o.dst.Header().Set("Access-Control-Allow-Origin", "*")
	o.dst.WriteHeader(o.status)
	o.headerWritten = true
}

func (o *ollamaStreamWriter) emitLocked(payload map[string]any) {
	o.commitHeaderLocked()
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = o.dst.Write(append(raw, '\n'))
}

func (o *ollamaStreamWriter) handleLineLocked(line string) {
	if !strings.HasPrefix(line, "data:") {
		return
	}
	data := strings.TrimSpace(line[len("data:"):])
	if data == "" {
		return
	}
	if data == "[DONE]" {
		if !o.finished {
			o.emitLocked(map[string]any{
				"model":   o.model,
				"message": map[string]any{"role": "assistant", "content": ""},
				"done":    true,
			})
			o.finished = true
		}
		return
	}

	var chunk map[string]any
	if err := json.Unmarshal([]byte(data), &chunk); err != nil {
		// A frame that is not JSON is provider noise; drop it rather than
		// emitting an unparseable line into a JSON-lines stream.
		return
	}

	choices, _ := chunk["choices"].([]any)
	if len(choices) == 0 {
		return
	}
	choice, _ := choices[0].(map[string]any)
	delta, _ := choice["delta"].(map[string]any)

	if toolCalls, ok := delta["tool_calls"].([]any); ok {
		for _, raw := range toolCalls {
			tc, _ := raw.(map[string]any)
			idx := 0
			if f, ok := tc["index"].(float64); ok {
				idx = int(f)
			}
			pending, exists := o.pendingTools[idx]
			if !exists {
				pending = &ollamaToolCall{}
				o.pendingTools[idx] = pending
			}
			if fn, ok := tc["function"].(map[string]any); ok {
				if name, ok := fn["name"].(string); ok {
					pending.Name += name
				}
				if args, ok := fn["arguments"].(string); ok {
					pending.Arguments += args
				}
			}
		}
	}

	if content, ok := delta["content"].(string); ok && content != "" {
		o.emitLocked(map[string]any{
			"model":   o.model,
			"message": map[string]any{"role": "assistant", "content": content},
			"done":    false,
		})
	}

	finish, _ := choice["finish_reason"].(string)
	if finish != "tool_calls" && finish != "stop" {
		return
	}

	if len(o.pendingTools) > 0 {
		calls := make([]any, 0, len(o.pendingTools))
		for idx := 0; idx < len(o.pendingTools); idx++ {
			tc, ok := o.pendingTools[idx]
			if !ok {
				continue
			}
			var args any = map[string]any{}
			if tc.Arguments != "" {
				var decoded any
				if err := json.Unmarshal([]byte(tc.Arguments), &decoded); err == nil {
					args = decoded
				}
			}
			calls = append(calls, map[string]any{
				"function": map[string]any{"name": tc.Name, "arguments": args},
			})
		}
		o.emitLocked(map[string]any{
			"model":   o.model,
			"message": map[string]any{"role": "assistant", "content": "", "tool_calls": calls},
			"done":    true,
		})
		o.pendingTools = map[int]*ollamaToolCall{}
		o.finished = true
		return
	}

	if finish == "stop" && !o.finished {
		o.emitLocked(map[string]any{
			"model":   o.model,
			"message": map[string]any{"role": "assistant", "content": ""},
			"done":    true,
		})
		o.finished = true
	}
}

// handleOllamaChat serves POST /v1/api/chat — the Ollama-compatible entry point.
//
// The chat path runs unchanged; only the response framing differs, which is why
// the conversion sits in a writer decorator instead of a parallel handler.
func (g *Gateway) handleOllamaChat(w http.ResponseWriter, r *http.Request) {
	model := ""
	if body, err := readBodyPeek(r); err == nil {
		var parsed map[string]any
		if json.Unmarshal(body, &parsed) == nil {
			model, _ = parsed["model"].(string)
		}
		r.Body = replayBody(body)
	}

	writer := newOllamaStreamWriter(w, model)
	defer writer.Close()
	g.handleChatCompletions(writer, r)
}
