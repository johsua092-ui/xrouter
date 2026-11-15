package providers

// Devin CLI executor.
//
// Devin is the only provider in this gateway that does not speak HTTP. It is a
// local binary driven over stdio with the Agent Client Protocol — JSON-RPC 2.0,
// one object per newline — and it shells out to a Node MCP server to expose the
// client's tools back to the agent. Porting it meant porting a subprocess, which
// is why it landed last and why the transport lives behind its own interface
// rather than inside Transport: `Transport.Do` builds an `*http.Request` and
// there is no URL here to build.
//
// Wire shape, from open-sse/executors/devin-cli.js:
//
//	initialize (protocolVersion 0.3)
//	  → result { }
//	session/new { cwd, mcpServers: [], model }
//	  → result { sessionId }
//	session/prompt { sessionId, prompt: [{type:"text", text}] }
//	  → notifications stream while the turn runs, then a final result once
//	    stopReason resolves. The prompt response is NOT the reply: on devin
//	    3000.2.x it only settles after streaming finished, so a client that
//	    waits for it before emitting anything shows an empty turn.
//
// Notifications carry reply text as `session/update` with the payload nested
// under `params.update.sessionUpdate` (older builds used a flat `params.type`),
// and the turn ends on `_cognition.ai/agent_stopped` — separately from the
// prompt response. Both signals are handled, because which one arrives first is
// build-dependent.
//
// Three field names in this protocol are load-bearing and were each the source
// of a real failure upstream (`-32602 Invalid params`):
//
//   - `prompt` is a sequence of content blocks, not a string, and the field is
//     named `prompt` — not `content`.
//   - `mcpServers` is required on session/new and must be a sequence even when
//     empty; omitting it is rejected, not defaulted.
//   - the session id comes back as `sessionId` on the session/new result.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// DevinProtocolVersion is the ACP revision this client speaks. Devin refuses a
// client that negotiates a version it does not implement, so this is pinned
// rather than derived.
const DevinProtocolVersion = "0.3"

// devinKillGrace is how long the agent gets to exit on its own after stdin is
// closed before the process is killed outright.
const devinKillGrace = 2 * time.Second

// devinMaxLine bounds a single ACP frame. A JSON-RPC message carrying a large
// tool result can legitimately run to a few hundred KB; anything past this is a
// stream that never terminated and must not be buffered indefinitely.
const devinMaxLine = 8 << 20

// DevinRunner is implemented by adapters that answer by running a local binary
// instead of making an HTTP call.
//
// The gateway checks for this at dispatch time, before it builds a request. An
// adapter that implements it owns its own transport entirely: there is no URL to
// resolve, no headers to set, and the response is SSE it produced itself.
type DevinRunner interface {
	// RunACP performs one turn and returns client-ready SSE.
	RunACP(ctx context.Context, req Request, cred Credential) (io.ReadCloser, error)
}

// Devin is the devin-cli adapter.
type Devin struct{}

func (d *Devin) Name() string { return "devin-cli" }

// Connectionless reports that this provider stores no credential in the
// gateway database. The subprocess inherits the environment and authenticates
// with whatever `devin auth login` already wrote, so there is nothing for a
// connection row to hold.
func (d *Devin) Connectionless() bool { return true }

// Endpoint and Headers exist only to satisfy Adapter. Transport.Do is never
// reached for this provider — the gateway routes to RunACP first — so these
// return values that would fail loudly if that ever stopped being true, rather
// than silently issuing a request to a bogus URL.
func (d *Devin) Endpoint(req Request, cred Credential) (string, error) {
	return "", fmt.Errorf("devin-cli speaks ACP over stdio, not HTTP: no endpoint")
}

func (d *Devin) Headers(req Request, cred Credential) (map[string]string, error) {
	return nil, nil
}

// WireFormat declares OpenAI. Devin's clients send OpenAI chat completions and
// receive OpenAI SSE chunks, so the translate layer stays a no-op for it even
// though the transport underneath is a subprocess.
func (d *Devin) WireFormat() string { return FormatOpenAI }

// DevinEnabled reports whether the executor is switched on.
//
// Default-off, mirroring the Node gate. This executor hands a shell-capable
// agent to whoever holds an API key for the provider, so opting in is a
// deliberate act. A gateway that never sets this never reaches the subprocess
// code path at all.
func DevinEnabled() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("DEVIN_CLI_ENABLED")), "true")
}

// ─── Binary discovery ────────────────────────────────────────────────────────

// ResolveDevinBin locates the devin binary.
//
// PATH alone is not enough: this gateway is usually run detached, without a
// login shell, so the per-user install directories are probed explicitly. Order
// is env override, then known install locations, then bare name (letting the OS
// resolve it against PATH as a last resort).
func ResolveDevinBin() string {
	if v := strings.TrimSpace(os.Getenv("CLI_DEVIN_BIN")); v != "" {
		return v
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return devinExeName()
	}

	var candidates []string
	if runtime.GOOS == "windows" {
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(home, "AppData", "Local")
		}
		candidates = []string{
			filepath.Join(local, "devin", "cli", "bin", "devin.exe"),
			filepath.Join(home, ".local", "bin", "devin.exe"),
			filepath.Join(home, "scoop", "shims", "devin.exe"),
			filepath.Join(local, "Programs", "devin", "devin.exe"),
		}
	} else {
		candidates = []string{
			filepath.Join(home, ".local", "share", "devin", "bin", "devin"),
			filepath.Join(home, ".devin", "bin", "devin"),
			filepath.Join(home, ".local", "bin", "devin"),
			"/opt/homebrew/bin/devin",
			"/usr/local/bin/devin",
			"/usr/bin/devin",
		}
	}

	for _, candidate := range candidates {
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return candidate
		}
	}
	return devinExeName()
}

func devinExeName() string {
	if runtime.GOOS == "windows" {
		return "devin.exe"
	}
	return "devin"
}

// ─── JSON-RPC ────────────────────────────────────────────────────────────────

// devinRPC is one JSON-RPC 2.0 request or notification. Fields are pointers or
// omitempty so a request with no params does not send `"params":null`, which
// some ACP peer implementations reject.
type devinRPC struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int            `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// devinIncoming is any frame read back from the agent: a response has id+result
// or id+error, a notification has method+params.
type devinIncoming struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int            `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *devinRPCError  `json:"error,omitempty"`
	Params  struct {
		// session/update payload (devin 3000.2.x nests it here)
		Update struct {
			SessionUpdate string          `json:"sessionUpdate"`
			Content       json.RawMessage `json:"content"`
			Title         string          `json:"title"`
			ToolCallID    string          `json:"toolCallId"`
			RawInput      json.RawMessage `json:"rawInput"`
		} `json:"update"`
		// flat shape used by older builds
		Type    string          `json:"type"`
		Content json.RawMessage `json:"content"`
		Delta   string          `json:"delta"`
		Text    string          `json:"text"`
		Message string          `json:"message"`
		// agent_stopped
		Cause        string `json:"cause"`
		ErrorMessage string `json:"errorMessage"`
		// request_permission
		Options []struct {
			OptionID string `json:"optionId"`
			Kind     string `json:"kind"`
		} `json:"options"`
	} `json:"params"`
}

type devinRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data,omitempty"`
}

func (e *devinRPCError) Error() string {
	return fmt.Sprintf("ACP error %d: %s", e.Code, e.Message)
}

// devinToolArguments renders a tool call's arguments for the prompt.
//
// OpenAI clients send `arguments` as a JSON-encoded string; Anthropic-style
// blocks send it as a live object. Emitting the string form verbatim wraps the
// payload in escaped quotes, so the agent receives `"{\"cmd\":\"ls\"}"` rather
// than `{"cmd":"ls"}` — valid JSON either way, but not the arguments the tool
// declared. A string is therefore unquoted before it is emitted.
func devinToolArguments(primary, fallback json.RawMessage) string {
	raw := primary
	if len(raw) == 0 || string(raw) == "null" {
		raw = fallback
	}
	if len(raw) == 0 || string(raw) == "null" {
		return "{}"
	}

	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		if strings.TrimSpace(asString) == "" {
			return "{}"
		}
		return asString
	}
	return string(raw)
}

// devinContentText flattens a `content` field that may be a bare string or a
// content-block object/array, returning the concatenated text.
//
// The same field arrives in three shapes across builds: a string, a single
// {type:"text",text:"..."} block, or an array of blocks. Handling only the
// object shape loses text on the other two without erroring, which is the worst
// kind of failure here — an empty turn with a clean 200.
func devinContentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}

	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}

	var obj struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil && (obj.Text != "" || obj.Type == "text") {
		return obj.Text
	}

	var arr []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &arr); err == nil {
		var b strings.Builder
		for _, block := range arr {
			if block.Type == "" || block.Type == "text" {
				b.WriteString(block.Text)
			}
		}
		return b.String()
	}
	return ""
}

// ─── Prompt assembly ─────────────────────────────────────────────────────────

// devinPromptText flattens an OpenAI conversation into the single prompt block
// Devin accepts.
//
// Devin has no multi-message input: one prompt per session. The whole history is
// therefore inlined with role markers, including prior tool calls and results,
// so a client round-trip after a tool call resumes with the agent able to see
// what it asked for and what came back.
func devinPromptText(body []byte) string {
	var parsed struct {
		Messages []struct {
			Role       string          `json:"role"`
			Content    json.RawMessage `json:"content"`
			ToolCalls  []devinToolCall `json:"tool_calls"`
			ToolCallID string          `json:"tool_call_id"`
		} `json:"messages"`
		Input []json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "(empty)"
	}

	var sections []string

	for _, m := range parsed.Messages {
		text := devinContentText(m.Content)

		// Content blocks: pull text out of text blocks and render tool_use /
		// tool_result blocks inline, since Devin has no separate channel for
		// them and dropping them would erase what the agent already did.
		var blocks []struct {
			Type      string          `json:"type"`
			Text      string          `json:"text"`
			Name      string          `json:"name"`
			ID        string          `json:"id"`
			Input     json.RawMessage `json:"input"`
			ToolUseID string          `json:"tool_use_id"`
			Content   json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(m.Content, &blocks); err == nil {
			var b strings.Builder
			b.WriteString(text)
			for _, block := range blocks {
				switch block.Type {
				case "text":
					// already captured by devinContentText
				case "tool_use":
					input := "{}"
					if len(block.Input) > 0 {
						input = string(block.Input)
					}
					fmt.Fprintf(&b, "\n[Tool call %s id=%s]\n%s\n", block.Name, block.ID, input)
				case "tool_result":
					fmt.Fprintf(&b, "\n[Tool result id=%s]\n%s\n",
						block.ToolUseID, devinContentText(block.Content))
				}
			}
			text = b.String()
		}

		// OpenAI tool_calls on an assistant message.
		if m.Role == "assistant" && len(m.ToolCalls) > 0 {
			parts := make([]string, 0, len(m.ToolCalls))
			for _, tc := range m.ToolCalls {
				name := tc.Function.Name
				if name == "" {
					name = tc.Name
				}
				// Arguments arrive either as an object or as a JSON-encoded
				// string, depending on the client. An object is emitted as its own
				// JSON; a string is unquoted first so the prompt does not end up
				// with escaped quotes around the payload.
				args := devinToolArguments(tc.Function.Arguments, tc.Arguments)
				parts = append(parts, fmt.Sprintf("[Tool call %s id=%s]\n%s", name, tc.ID, args))
			}
			if text != "" {
				text = text + "\n\n" + strings.Join(parts, "\n\n")
			} else {
				text = strings.Join(parts, "\n\n")
			}
		}

		// A role:"tool" message carries a result keyed by tool_call_id.
		if m.Role == "tool" {
			text = fmt.Sprintf("[Tool result id=%s]\n%s", m.ToolCallID, devinContentText(m.Content))
		}

		if strings.TrimSpace(text) == "" {
			continue
		}

		switch m.Role {
		case "system":
			sections = append(sections, "[System]\n"+text)
		case "assistant":
			sections = append(sections, "[Assistant]\n"+text)
		case "tool":
			sections = append(sections, "[Tool]\n"+text)
		default:
			sections = append(sections, "[User]\n"+text)
		}
	}

	// Responses-API input items: accept them rather than returning an empty
	// prompt, which would silently ask the agent nothing.
	if len(sections) == 0 && len(parsed.Input) > 0 {
		for _, item := range parsed.Input {
			var s string
			if err := json.Unmarshal(item, &s); err == nil {
				sections = append(sections, "[User]\n"+s)
				continue
			}
			var obj struct {
				Type    string `json:"type"`
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			}
			if err := json.Unmarshal(item, &obj); err == nil {
				var b strings.Builder
				for _, block := range obj.Content {
					if block.Type == "input_text" || block.Type == "text" || block.Type == "" {
						b.WriteString(block.Text)
					}
				}
				if b.Len() > 0 {
					role := obj.Role
					if role == "" {
						role = "user"
					}
					sections = append(sections, "["+strings.Title(role)+"]\n"+b.String())
				}
			}
		}
	}

	if len(sections) == 0 {
		return "(empty)"
	}
	return strings.Join(sections, "\n\n")
}

type devinToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Name     string `json:"name"`
	Function struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
	Arguments json.RawMessage `json:"arguments"`
}

// ─── Workspace resolution ────────────────────────────────────────────────────

// DevinWorkspaceRoots returns the directories a client-supplied cwd may fall
// inside.
//
// DEVIN_WORKSPACE_ROOTS is a colon-separated list, defaulting to the home
// directory and the temp directory. The containment check exists because the cwd
// is read out of the request body: without it, a caller could point the agent's
// file tools at any directory on the host by sending an absolute path.
func DevinWorkspaceRoots() []string {
	raw := strings.TrimSpace(os.Getenv("DEVIN_WORKSPACE_ROOTS"))
	var roots []string
	if raw != "" {
		for _, part := range strings.Split(raw, string(os.PathListSeparator)) {
			if p := strings.TrimSpace(part); p != "" {
				roots = append(roots, p)
			}
		}
	}
	if len(roots) == 0 {
		if home, err := os.UserHomeDir(); err == nil {
			roots = append(roots, home)
		}
		roots = append(roots, os.TempDir())
	}

	// Resolve symlinks up front so a link cannot be used to escape a root later.
	resolved := make([]string, 0, len(roots))
	for _, root := range roots {
		if real, err := filepath.EvalSymlinks(root); err == nil {
			resolved = append(resolved, real)
		} else {
			resolved = append(resolved, root)
		}
	}
	return resolved
}

// devinInsideRoot reports whether abs is root or sits beneath it.
//
// The comparison is on cleaned absolute paths with an appended separator, so
// "/home/user2" is not treated as inside "/home/user" — a prefix match without
// the separator would allow exactly that.
func devinInsideRoot(abs, root string) bool {
	if abs == root {
		return true
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(os.PathSeparator)) {
		prefix += string(os.PathSeparator)
	}
	return strings.HasPrefix(abs, prefix)
}

// DevinWorkspaceCwd picks the working directory for the agent.
//
// A candidate is used only when it is absolute, exists as a directory, and is
// contained in an allowed root after symlink resolution. Anything else falls
// back to the temp directory, matching the Node behaviour: a bad cwd is not an
// error, it just means the agent works somewhere harmless.
func DevinWorkspaceCwd(body []byte) string {
	var parsed struct {
		Cwd              string `json:"cwd"`
		WorkingDirectory string `json:"working_directory"`
		Workdir          string `json:"workdir"`
		Workspace        string `json:"workspace"`
		Metadata         struct {
			Cwd              string `json:"cwd"`
			WorkingDirectory string `json:"working_directory"`
		} `json:"metadata"`
	}
	_ = json.Unmarshal(body, &parsed)

	candidates := []string{
		parsed.Cwd,
		parsed.WorkingDirectory,
		parsed.Workdir,
		parsed.Workspace,
		parsed.Metadata.Cwd,
		parsed.Metadata.WorkingDirectory,
	}

	// <cwd>...</cwd> embedded in message text, which is how the Codex CLI layer
	// passes it through.
	candidates = append(candidates, devinExtractTaggedCwd(body)...)

	roots := DevinWorkspaceRoots()
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || !filepath.IsAbs(candidate) {
			continue
		}
		real, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			continue
		}
		info, err := os.Stat(real)
		if err != nil || !info.IsDir() {
			continue
		}
		for _, root := range roots {
			if devinInsideRoot(real, root) {
				return real
			}
		}
	}
	return os.TempDir()
}

// devinExtractTaggedCwd pulls every <cwd>…</cwd> value out of the raw body.
func devinExtractTaggedCwd(body []byte) []string {
	var found []string
	lower := bytes.ToLower(body)
	const open = "<cwd>"
	const closeTag = "</cwd>"
	pos := 0
	for {
		i := bytes.Index(lower[pos:], []byte(open))
		if i < 0 {
			break
		}
		start := pos + i + len(open)
		j := bytes.Index(lower[start:], []byte(closeTag))
		if j < 0 {
			break
		}
		value := strings.TrimSpace(string(body[start : start+j]))
		if value != "" {
			found = append(found, value)
		}
		pos = start + j + len(closeTag)
	}
	return found
}

// ─── Subprocess transport ────────────────────────────────────────────────────

// devinSession is one live ACP conversation with a devin subprocess.
type devinSession struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	// stdoutCloser is the raw read end of the stdout pipe. Closing it unblocks
	// a reader parked in ReadBytes, which is the only way out of a deadlock
	// during cancellation (see Close).
	stdoutCloser io.Closer
	stderr       bytes.Buffer
	writeMu      sync.Mutex

	idCounter int

	// closed guards double-close of stdin.
	closedMu sync.Mutex
	closed   bool
}

// DevinACPProcess starts the agent in ACP mode.
//
// cwd is the session working directory, resolved and containment-checked by the
// caller. The environment is inherited so the subprocess finds the credentials
// `devin auth login` stored; only the permission mode and any MCP config home
// are overridden.
func DevinACPProcess(ctx context.Context, bin, cwd string, extraEnv []string) (*devinSession, error) {
	args := []string{"acp"}
	if agentType := strings.TrimSpace(os.Getenv("CLI_DEVIN_AGENT_TYPE")); agentType != "" {
		args = append(args, "--agent-type", agentType)
	}

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), extraEnv...)

	// Auto-approve tool execution. Without this the agent blocks on the first
	// shell or file tool waiting for a permission response that a headless
	// gateway never sends by hand, and the turn hangs until it times out.
	cmd.Env = append(cmd.Env, "DEVIN_PERMISSION_MODE="+devinPermissionMode())

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("devin: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("devin: stdout pipe: %w", err)
	}

	session := &devinSession{
		cmd:          cmd,
		stdin:        stdin,
		stdout:       bufio.NewReaderSize(stdout, 64*1024),
		stdoutCloser: stdout,
	}
	cmd.Stderr = &session.stderr

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("devin: start %s: %w", bin, err)
	}
	return session, nil
}

// devinPermissionMode is the ACP permission mode for the subprocess.
//
// "bypass" lets the agent run tools unattended, which is what makes a headless
// gateway work at all; anything else has to be requested explicitly. This is
// why the whole executor is default-off.
func devinPermissionMode() string {
	if v := strings.TrimSpace(os.Getenv("DEVIN_PERMISSION_MODE")); v != "" {
		return v
	}
	return "bypass"
}

// Send writes one JSON-RPC frame.
func (s *devinSession) Send(method string, params any) (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	s.closedMu.Lock()
	closed := s.closed
	s.closedMu.Unlock()
	if closed {
		return 0, fmt.Errorf("devin: session closed")
	}

	s.idCounter++
	id := s.idCounter

	var raw json.RawMessage
	if params != nil {
		encoded, err := json.Marshal(params)
		if err != nil {
			return 0, fmt.Errorf("devin: encode params for %s: %w", method, err)
		}
		raw = encoded
	}

	line, err := json.Marshal(devinRPC{
		JSONRPC: "2.0",
		ID:      &id,
		Method:  method,
		Params:  raw,
	})
	if err != nil {
		return 0, fmt.Errorf("devin: encode %s: %w", method, err)
	}
	line = append(line, '\n')

	if _, err := s.stdin.Write(line); err != nil {
		return 0, fmt.Errorf("devin: write %s: %w", method, err)
	}
	return id, nil
}

// Reply sends a response to an agent request.
//
// The id in the response must be an exact echo of the request id, so it is taken
// as raw JSON rather than an int — a peer that uses a string id would otherwise
// get a response it cannot correlate.
func (s *devinSession) Reply(id json.RawMessage, result any) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	frame := make([]byte, 0, len(body)+64)
	frame = append(frame, `{"jsonrpc":"2.0","id":`...)
	frame = append(frame, id...)
	frame = append(frame, `,"result":`...)
	frame = append(frame, body...)
	frame = append(frame, '}', '\n')

	_, err = s.stdin.Write(frame)
	return err
}

// Read returns the next JSON frame, skipping lines the agent prints that are not
// JSON (a banner or a log line on stdout would otherwise abort the stream).
func (s *devinSession) Read() (*devinIncoming, error) {
	for {
		line, err := s.stdout.ReadBytes('\n')
		if len(line) > devinMaxLine {
			return nil, fmt.Errorf("devin: ACP frame exceeded %d bytes with no newline", devinMaxLine)
		}
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			var msg devinIncoming
			if jsonErr := json.Unmarshal(trimmed, &msg); jsonErr == nil {
				return &msg, nil
			}
			// not JSON — keep reading
		}
		if err != nil {
			if err == io.EOF {
				return nil, io.EOF
			}
			return nil, err
		}
	}
}

// Close shuts the session down: stdin first so the agent can exit on its own,
// then a kill, then the stdout pipe is released.
//
// Waiting for cmd.Wait() before releasing stdout deadlocks. With StdoutPipe the
// reader goroutine is ours, and Wait() blocks until that pipe is closed — so a
// turn parked in ReadBytes can never be released by Wait(), and a cancellation
// path that waits on it hangs forever. Order matters: signal, kill, then close
// the reader. Wait() is reaped in the background, where a slow exit does not
// hold up anyone.
func (s *devinSession) Close() {
	s.closedMu.Lock()
	alreadyClosed := s.closed
	s.closed = true
	s.closedMu.Unlock()
	if alreadyClosed {
		return
	}

	// Ask the agent to finish.
	_ = s.stdin.Close()

	// Give it the grace period, then take the process down regardless. The
	// exit status after a kill is not interesting — the turn is over.
	exited := make(chan struct{})
	go func() {
		_ = s.cmd.Wait()
		close(exited)
	}()

	select {
	case <-exited:
	case <-time.After(devinKillGrace):
		if s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
	}

	// Release a reader parked on the pipe. This is what actually unblocks the
	// turn goroutine, and it must happen before anything waits on it.
	if s.stdoutCloser != nil {
		_ = s.stdoutCloser.Close()
	}

	select {
	case <-exited:
	case <-time.After(devinKillGrace):
	}
}

// Stderr returns whatever the subprocess wrote to stderr, for diagnostics on a
// failed turn.
func (s *devinSession) Stderr() string {
	return strings.TrimSpace(s.stderr.String())
}
