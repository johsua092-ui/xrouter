package providers

// Devin ACP turn loop.
//
// Reads ACP frames from the subprocess and drives the writer, in the order the
// protocol requires: initialize → session/new → session/prompt, then stream
// notifications until the turn ends.
//
// The state is a plain sequence of booleans rather than a formal machine because
// the ordering is not really a graph: devin answers in strict request order, and
// the only ambiguity is which of two end-of-turn signals arrives first, which a
// single `finished` flag on the writer already resolves.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// devinTurnTimeout bounds a whole turn.
//
// A headless agent that hangs waiting on something it will never receive would
// otherwise hold the client connection open indefinitely. Tool-permission
// prompts are auto-approved, so a hang here means the agent itself is stuck.
var devinTurnTimeout = 10 * time.Minute

func devinRunTurn(ctx context.Context, p devinTurnParams) {
	writer := newDevinWriter(p.writer, p.model, len(p.promptText))
	if p.mcpCleanup != nil {
		defer p.mcpCleanup()
	}

	turnCtx, cancel := context.WithTimeout(ctx, devinTurnTimeout)
	defer cancel()

	session, err := DevinACPProcess(turnCtx, p.bin, p.cwd, devinMCPEnv(p.mcpHome))
	if err != nil {
		writer.Fail(err.Error(), "devin_cli_spawn_failed")
		return
	}
	defer session.Close()

	// Cancellation has to close the pipe and kill the process, because the read
	// loop below blocks on subprocess output and would never observe ctx.
	stopWatch := make(chan struct{})
	defer close(stopWatch)
	go func() {
		select {
		case <-turnCtx.Done():
			session.Close()
			writer.Close()
		case <-stopWatch:
		}
	}()

	if _, err := session.Send("initialize", map[string]any{
		"protocolVersion": DevinProtocolVersion,
		"clientInfo":      map[string]any{"name": "synapse-xrouter", "version": "1.0"},
		"capabilities":    map[string]any{},
	}); err != nil {
		writer.Fail(err.Error(), "devin_cli_write_failed")
		return
	}

	var (
		initDone       bool
		sessionCreated bool
		promptSent     bool
		emittedText    bool
		toolCallsSeen  bool
	)

	for {
		if turnCtx.Err() != nil {
			writer.Fail("devin turn cancelled", "devin_cli_cancelled")
			return
		}

		msg, err := session.Read()
		if err != nil {
			// EOF or a killed process. If the agent already produced text the
			// turn is complete enough to finish cleanly; otherwise the exit is
			// the failure.
			if emittedText {
				writer.Finish("stop")
			} else {
				detail := session.Stderr()
				if detail == "" {
					detail = "no output"
				}
				writer.Fail("devin CLI exited before completing the turn: "+detail, "devin_cli_exit")
			}
			return
		}

		// ── initialize result → create the session ───────────────────────────
		if !initDone && msg.Method == "" && msg.ID != nil && msg.Error == nil {
			initDone = true
			// mcpServers is required and must be a sequence even when empty;
			// omitting it is rejected with -32602 rather than defaulted.
			params := map[string]any{
				"cwd":        p.cwd,
				"mcpServers": []any{},
			}
			if p.model != "" {
				params["model"] = p.model
			}
			if _, err := session.Send("session/new", params); err != nil {
				writer.Fail(err.Error(), "devin_cli_write_failed")
				return
			}
			continue
		}

		// ── session/new result → send the prompt ─────────────────────────────
		if initDone && !sessionCreated && msg.Method == "" && msg.ID != nil && msg.Error == nil {
			var res struct {
				SessionID string `json:"sessionId"`
			}
			if err := json.Unmarshal(msg.Result, &res); err != nil || res.SessionID == "" {
				writer.Fail("Devin ACP: session/new returned no sessionId", "devin_cli_no_session")
				return
			}
			sessionCreated = true
			promptSent = true
			// `prompt` is a sequence of content blocks; the field is not named
			// `content` and a bare string is rejected.
			if _, err := session.Send("session/prompt", map[string]any{
				"sessionId": res.SessionID,
				"prompt":    []any{map[string]any{"type": "text", "text": p.promptText}},
			}); err != nil {
				writer.Fail(err.Error(), "devin_cli_write_failed")
				return
			}
			continue
		}

		// ── session/prompt result (ack / final) ─────────────────────────────
		if promptSent && msg.Method == "" && msg.ID != nil && msg.Error == nil {
			// The prompt result settles the turn either way.
			//
			// With text already streamed, this result is the only remaining
			// signal that the turn is over — the agent is not required to send
			// agent_stopped, and waiting for one that never arrives leaves the
			// client connection open indefinitely.
			//
			// Without streamed text the result itself carries the reply, which
			// is the shape a silent agent returns.
			if !emittedText {
				if text := devinExtractResultText(msg.Result); text != "" {
					writer.Delta(text)
				}
			}
			finish := "stop"
			if toolCallsSeen {
				finish = "tool_calls"
			}
			writer.Finish(finish)
			return
		}

		// ── permission request → auto-approve ───────────────────────────────
		if msg.Method == "session/request_permission" && msg.ID != nil {
			optionID := ""
			for _, opt := range msg.Params.Options {
				if strings.Contains(strings.ToLower(opt.Kind), "allow") {
					optionID = opt.OptionID
					break
				}
			}
			if optionID == "" && len(msg.Params.Options) > 0 {
				optionID = msg.Params.Options[0].OptionID
			}
			if optionID != "" {
				idRaw, _ := json.Marshal(*msg.ID)
				_ = session.Reply(idRaw, map[string]any{
					"outcome": map[string]any{"outcome": "selected", "optionId": optionID},
				})
			}
			continue
		}

		// ── agent stopped → end of turn ─────────────────────────────────────
		if msg.Method == "_cognition.ai/agent_stopped" || msg.Method == "$/agent_stopped" {
			if msg.Params.Cause == "error" {
				detail := msg.Params.ErrorMessage
				if detail == "" {
					detail = msg.Params.Message
				}
				if detail == "" {
					detail = "Devin agent error"
				}
				writer.Fail(detail, "devin_cli_agent_error")
				return
			}
			finish := "stop"
			if toolCallsSeen {
				finish = "tool_calls"
			}
			writer.Finish(finish)
			return
		}

		// ── streaming notifications ─────────────────────────────────────────
		if msg.Method == "session/update" || msg.Method == "$/update" {
			update := msg.Params.Update

			// Update kind: nested under params.update.sessionUpdate on devin
			// 3000.2.x, flat under params.type on older builds.
			kind := update.SessionUpdate
			if kind == "" {
				kind = msg.Params.Type
			}

			// Text may arrive as params.update.content, params.content,
			// params.delta or params.text depending on build and message kind.
			contentRaw := update.Content
			if len(contentRaw) == 0 {
				contentRaw = msg.Params.Content
			}
			text := devinContentText(contentRaw)
			if text == "" {
				text = msg.Params.Delta
			}
			if text == "" {
				text = msg.Params.Text
			}

			switch kind {
			case "agent_message_chunk", "message_delta", "text_delta", "content_delta":
				if text != "" {
					emittedText = true
					writer.Delta(text)
				}

			case "tool_call", "tool_call_update":
				// A client-tool call is surfaced to the client as an OpenAI
				// tool_call so it can execute the tool and reply. Devin titles
				// these "Calling mcp_<name> from clientTools"; the title and the
				// rawInput may arrive in separate upserts keyed by toolCallId,
				// so both are matched here and only a call with BOTH a
				// recognised title and its input is emitted. (The Node executor
				// also tracks pending ids across notifications for the same
				// reason.)
				name := devinClientToolName(update.Title)
				if name != "" && len(update.RawInput) > 0 {
					callID := update.ToolCallID
					if callID == "" {
						callID = fmt.Sprintf("call_%d", time.Now().UnixNano())
					}
					emittedText = true
					toolCallsSeen = true
					writer.ToolUse(name, string(update.RawInput), callID)
					writer.Finish("tool_calls")
					return
				}

			case "agent_thought_chunk":
				// Internal reasoning is not surfaced to the client.

			case "message_stop", "stop", "done":
				writer.Finish("stop")
				return

			case "error":
				detail := msg.Params.Message
				if detail == "" {
					detail = "Devin ACP error"
				}
				writer.Fail(detail, "devin_cli_agent_error")
				return
			}
			continue
		}

		// ── error responses ────────────────────────────────────────────────
		if msg.Error != nil {
			writer.Fail(msg.Error.Error(), "devin_cli_rpc_error")
			return
		}
	}
}

// devinClientToolName extracts the original tool name from an ACP tool title.
//
// Shape: "Calling mcp_<name> from clientTools". Only calls that came from the
// client's own MCP bridge are surfaced — devin's internal tools are not echoed
// back to a client that never defined them.
func devinClientToolName(title string) string {
	if !strings.HasPrefix(title, "Calling mcp_") || !strings.Contains(title, "from clientTools") {
		return ""
	}
	rest := strings.TrimPrefix(title, "Calling ")
	if idx := strings.Index(rest, " from clientTools"); idx >= 0 {
		return devinFromMCPToolName(strings.TrimSpace(rest[:idx]))
	}
	return ""
}

// devinFromMCPToolName strips the mcp_ prefix and any server-name separator,
// recovering the name the client originally declared.
func devinFromMCPToolName(name string) string {
	name = strings.TrimPrefix(name, "mcp_")
	// An MCP name may be namespaced as <server>_<tool>; the client's original
	// name is what follows the last separator.
	if idx := strings.LastIndex(name, "_"); idx >= 0 && idx < len(name)-1 {
		if tool := name[idx+1:]; tool != "" && strings.Contains(name, "_") {
			return tool
		}
	}
	return name
}

// devinExtractResultText pulls reply text out of a final session/prompt result,
// across the shapes devin has used: {content}, {text}, {message:{content}},
// {messages:[{role:"assistant",content}]}.
func devinExtractResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var res struct {
		Content string `json:"content"`
		Text    string `json:"text"`
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return ""
	}
	if res.Content != "" {
		return res.Content
	}
	if res.Text != "" {
		return res.Text
	}
	if res.Message.Content != "" {
		return res.Message.Content
	}
	var assistant []string
	for _, m := range res.Messages {
		if m.Role == "assistant" && m.Content != "" {
			assistant = append(assistant, m.Content)
		}
	}
	return strings.Join(assistant, "\n")
}
