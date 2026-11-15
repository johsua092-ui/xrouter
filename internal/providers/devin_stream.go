package providers

// Devin ACP turn driver.
//
// One RunACP call is one turn. The subprocess is started, initialized, given a
// session, and prompted; its notifications are translated into OpenAI SSE chunks
// and streamed to the client as they arrive.
//
// Two lifecycle rules drive the structure of this file, both learned from the
// Node executor:
//
//  1. The session/prompt response is not the reply. On devin 3000.2.x it only
//     resolves once streaming has finished. A client that waits for it before
//     emitting anything shows an empty turn for the whole duration, so text is
//     emitted from notifications and the prompt response is used only as a
//     fallback for the rare silent stream.
//
//  2. The turn ends on `_cognition.ai/agent_stopped`, not on the prompt
//     response. That notification is a separate signal that can arrive before or
//     after the response, so whichever comes first finishes the turn and the
//     later one is ignored.
//
// Transcript assembly happens inside an io.Pipe. A goroutine owns the
// subprocess, the reader side is handed to the gateway, and the client sees
// frames as the agent produces them rather than after the turn completes.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

// RunACP performs one turn against the devin binary and returns client-ready SSE.
func (d *Devin) RunACP(ctx context.Context, req Request, cred Credential) (io.ReadCloser, error) {
	if !DevinEnabled() {
		return nil, fmt.Errorf("devin-cli executor disabled: set DEVIN_CLI_ENABLED=true to opt in")
	}

	bin := ResolveDevinBin()
	if _, err := os.Stat(bin); err != nil {
		// Not necessarily fatal: a bare name resolves through PATH at exec time.
		// Only a path with a separator that does not exist is a hard failure.
		if strings.ContainsRune(bin, os.PathSeparator) {
			return nil, fmt.Errorf(
				"devin CLI not found at %s: install from https://cli.devin.ai or set CLI_DEVIN_BIN", bin)
		}
	}

	cwd := DevinWorkspaceCwd(req.Body)
	model := req.Model
	promptText := devinPromptText(req.Body)

	// MCP config for client tools. Devin only auto-connects servers listed in
	// its own config file; passing them on session/new is not enough, so a
	// throwaway XDG_CONFIG_HOME is written and removed when the turn ends.
	mcpHome, mcpCleanup, mcpErr := devinWriteMCPConfig(req.Body)
	if mcpErr != nil {
		// Non-fatal: the turn still runs, just without client tools.
		mcpHome = ""
	}

	reader, writer := io.Pipe()
	go devinRunTurn(ctx, devinTurnParams{
		bin:        bin,
		cwd:        cwd,
		model:      model,
		promptText: promptText,
		mcpHome:    mcpHome,
		mcpCleanup: mcpCleanup,
		writer:     writer,
	})
	return reader, nil
}

// devinTurnParams bundles everything the turn goroutine needs. Passing a struct
// keeps the goroutine signature stable as fields are added.
type devinTurnParams struct {
	bin        string
	cwd        string
	model      string
	promptText string
	mcpHome    string
	mcpCleanup func()
	writer     *io.PipeWriter
}

// devinWriter serialises SSE frames onto the pipe.
//
// Writes happen from the turn goroutine only, so no lock is needed for ordering;
// the mutex guards against a write racing the pipe's close on cancellation, which
// would panic inside io.Pipe.
type devinWriter struct {
	mu     sync.Mutex
	pipe   *io.PipeWriter
	closed bool
	model  string
	id     string
	ts     int64

	promptChars int

	roleEmitted bool
	total       string
	finished    bool
}

func newDevinWriter(pipe *io.PipeWriter, model string, promptChars int) *devinWriter {
	return &devinWriter{
		pipe:        pipe,
		model:       model,
		id:          fmt.Sprintf("chatcmpl-devin-%d", time.Now().UnixNano()),
		ts:          time.Now().Unix(),
		promptChars: promptChars,
	}
}

// chunk marshals one SSE `data:` frame. A marshal failure cannot be reported to
// a stream that is already open, so it is dropped rather than closing the pipe.
func (w *devinWriter) chunk(payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	w.writeFrame(string(body))
}

// writeFrame writes one `data: <payload>` block. payload is emitted verbatim,
// which is what the non-JSON terminal [DONE] marker needs.
func (w *devinWriter) writeFrame(payload string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	if _, err := w.pipe.Write([]byte("data: " + payload + "\n\n")); err != nil {
		w.closed = true
	}
}

// done writes the terminal [DONE] frame and closes the pipe.
//
// Closing here is not optional: the consumer reads the stream until EOF, so a
// writer that emits [DONE] but leaves the pipe open blocks that reader forever.
// The end of a turn and the end of the stream are the same event.
func (w *devinWriter) done() {
	w.writeFrame("[DONE]")
	w.Close()
}

// ensureRole emits the leading role chunk exactly once, so the client sees a
// well-formed assistant turn whether the first content is text or a tool call.
func (w *devinWriter) ensureRole(content any) {
	if w.roleEmitted {
		return
	}
	w.roleEmitted = true
	w.chunk(map[string]any{
		"id":      w.id,
		"object":  "chat.completion.chunk",
		"created": w.ts,
		"model":   w.model,
		"choices": []any{map[string]any{
			"index":         0,
			"delta":         map[string]any{"role": "assistant", "content": content},
			"finish_reason": nil,
		}},
	})
}

// Delta emits a text delta.
func (w *devinWriter) Delta(text string) {
	if text == "" {
		return
	}
	w.ensureRole("")
	w.total += text
	w.chunk(map[string]any{
		"id":      w.id,
		"object":  "chat.completion.chunk",
		"created": w.ts,
		"model":   w.model,
		"choices": []any{map[string]any{
			"index":         0,
			"delta":         map[string]any{"content": text},
			"finish_reason": nil,
		}},
	})
}

// ToolUse emits an OpenAI tool_call delta and finishes the turn with
// finish_reason "tool_calls", which is how the client learns to run the tool and
// send the result back.
func (w *devinWriter) ToolUse(name, args, callID string) {
	if args == "" {
		args = "{}"
	}
	w.ensureRole(nil)
	w.chunk(map[string]any{
		"id":      w.id,
		"object":  "chat.completion.chunk",
		"created": w.ts,
		"model":   w.model,
		"choices": []any{map[string]any{
			"index": 0,
			"delta": map[string]any{
				"tool_calls": []any{map[string]any{
					"index":    0,
					"id":       callID,
					"type":     "function",
					"function": map[string]any{"name": name, "arguments": args},
				}},
			},
			"finish_reason": nil,
		}},
	})
}

// Finish closes the turn. Only the first call takes effect, because the agent
// can signal completion through both a notification and a process exit.
func (w *devinWriter) Finish(reason string) {
	w.mu.Lock()
	if w.finished {
		w.mu.Unlock()
		return
	}
	w.finished = true
	w.mu.Unlock()

	promptTokens := w.promptChars / 4
	completionTokens := len(w.total) / 4

	w.chunk(map[string]any{
		"id":      w.id,
		"object":  "chat.completion.chunk",
		"created": w.ts,
		"model":   w.model,
		"choices": []any{map[string]any{
			"index":         0,
			"delta":         map[string]any{},
			"finish_reason": reason,
		}},
		"usage": map[string]any{
			"prompt_tokens":     promptTokens,
			"completion_tokens": completionTokens,
			"total_tokens":      promptTokens + completionTokens,
			"estimated":         true,
		},
	})
	w.done()
}

// Fail emits an OpenAI-style error frame and closes the stream. The status is
// already 200 by the time a stream is open, so a failure has to be reported
// inside the stream rather than as an HTTP status.
func (w *devinWriter) Fail(message, kind string) {
	if kind == "" {
		kind = "devin_cli_error"
	}
	w.chunk(map[string]any{
		"error": map[string]any{"message": message, "type": kind},
	})
	w.done()
	w.Close()
}

// Close ends the stream.
func (w *devinWriter) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	w.closed = true
	_ = w.pipe.Close()
}
