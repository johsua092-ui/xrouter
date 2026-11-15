package providers

// Devin CLI tests.
//
// The protocol tests drive a real subprocess: a small shell script that speaks
// ACP on stdin/stdout. That is deliberate — the parts of this executor most
// likely to be wrong (JSON-RPC framing, request ordering, notification shapes,
// subprocess lifecycle) are exactly the parts a unit test with a mocked session
// would skip over. A script-based agent exercises the real exec, real pipes and
// real buffering.
//
// What these tests still cannot prove is that real devin 3000.2.x emits the
// shapes this client expects. No credential is available here, so the field
// names and notification kinds remain a reconstruction from the Node executor.
// The tests pin the contract; they do not validate it against upstream.

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// ─── prompt assembly ─────────────────────────────────────────────────────────

func TestDevinPromptTextInlinesRolesAndToolCalls(t *testing.T) {
	body := []byte(`{
		"messages": [
			{"role": "system", "content": "You are concise."},
			{"role": "user", "content": "list go files"},
			{"role": "assistant", "content": "sure", "tool_calls": [
				{"id": "call_1", "type": "function",
				 "function": {"name": "run_shell", "arguments": "{\"cmd\":\"ls\"}"}}
			]},
			{"role": "tool", "tool_call_id": "call_1", "content": "main.go"}
		]
	}`)

	out := devinPromptText(body)

	for _, want := range []string{
		"[System]\nYou are concise.",
		"[User]\nlist go files",
		"[Assistant]\nsure",
		"[Tool call run_shell id=call_1]\n{\"cmd\":\"ls\"}",
		// The tool result arrives as a role:"tool" message, keyed by
		// tool_call_id. Without this the agent cannot see what its own call
		// returned, and a multi-turn tool loop silently loses a step.
		"[Tool result id=call_1]\nmain.go",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("prompt missing %q\n--- got ---\n%s", want, out)
		}
	}
}

func TestDevinPromptTextHandlesContentBlocks(t *testing.T) {
	// Anthropic-style content blocks: tool_use and tool_result must both be
	// rendered, since devin has no separate channel for them.
	body := []byte(`{
		"messages": [
			{"role": "user", "content": [{"type": "text", "text": "read the file"}]},
			{"role": "assistant", "content": [
				{"type": "text", "text": "reading"},
				{"type": "tool_use", "id": "tu_1", "name": "read_file", "input": {"path": "/tmp/a"}}
			]},
			{"role": "user", "content": [
				{"type": "tool_result", "tool_use_id": "tu_1", "content": "hello"}
			]}
		]
	}`)

	out := devinPromptText(body)

	for _, want := range []string{"read the file", "reading", "read_file", "/tmp/a", "hello"} {
		if !strings.Contains(out, want) {
			t.Errorf("prompt missing %q\n--- got ---\n%s", want, out)
		}
	}
}

func TestDevinPromptTextEmptyInputYieldsPlaceholder(t *testing.T) {
	// A prompt that serialises to "" would ask the agent nothing and produce an
	// empty turn with a clean 200 — the silent failure mode this guards.
	if got := devinPromptText([]byte(`{"messages":[]}`)); got != "(empty)" {
		t.Errorf("empty conversation: got %q, want (empty)", got)
	}
	if got := devinPromptText([]byte(`not json`)); got != "(empty)" {
		t.Errorf("malformed body: got %q, want (empty)", got)
	}
}

func TestDevinPromptTextReadsResponsesInput(t *testing.T) {
	body := []byte(`{"input":[
		{"type":"message","role":"user","content":[{"type":"input_text","text":"hello there"}]}
	]}`)
	if out := devinPromptText(body); !strings.Contains(out, "hello there") {
		t.Errorf("responses-style input dropped: got %q", out)
	}
}

// ─── content flattening ──────────────────────────────────────────────────────

func TestDevinContentTextAcrossShapes(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"bare string", `"hi"`, "hi"},
		{"single block", `{"type":"text","text":"hi"}`, "hi"},
		{"block array", `[{"type":"text","text":"a"},{"type":"text","text":"b"}]`, "ab"},
		{"non-text blocks skipped", `[{"type":"image","text":"x"},{"type":"text","text":"y"}]`, "y"},
		{"empty", ``, ""},
		{"null", `null`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := devinContentText(json.RawMessage(tc.raw)); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// ─── workspace containment ───────────────────────────────────────────────────

func TestDevinInsideRootRejectsSiblingPrefix(t *testing.T) {
	sep := string(os.PathSeparator)
	root := "/home/user"

	if !devinInsideRoot("/home/user", root) {
		t.Error("root itself should be inside root")
	}
	if !devinInsideRoot("/home/user/project", root) {
		t.Error("child should be inside root")
	}
	// The prefix trap: /home/user2 shares a string prefix with /home/user but is
	// a different directory. A naive HasPrefix check allows it.
	if devinInsideRoot("/home/user2", root) {
		t.Error("/home/user2 must NOT be inside /home/user")
	}
	_ = sep
}

func TestDevinWorkspaceCwdContainsRequestedPath(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "project")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("DEVIN_WORKSPACE_ROOTS", root)

	if got := DevinWorkspaceCwd([]byte(`{"cwd":"` + inside + `"}`)); got != inside {
		t.Errorf("in-root cwd: got %q, want %q", got, inside)
	}

	// A directory outside every root must not be honoured, or a caller could
	// point the agent's file tools at any path on the host.
	outside := t.TempDir()
	if got := DevinWorkspaceCwd([]byte(`{"cwd":"` + outside + `"}`)); got == outside {
		t.Errorf("out-of-root cwd was honoured: %q", got)
	}

	// Relative and nonexistent paths fall back.
	if got := DevinWorkspaceCwd([]byte(`{"cwd":"relative/path"}`)); got != os.TempDir() {
		t.Errorf("relative cwd: got %q, want temp dir", got)
	}
	if got := DevinWorkspaceCwd([]byte(`{"cwd":"/does/not/exist"}`)); got != os.TempDir() {
		t.Errorf("missing cwd: got %q, want temp dir", got)
	}
}

func TestDevinWorkspaceCwdReadsTaggedCwd(t *testing.T) {
	root := t.TempDir()
	t.Setenv("DEVIN_WORKSPACE_ROOTS", root)

	body := []byte(`{"messages":[{"role":"user","content":"work in <cwd>` + root + `</cwd> please"}]}`)
	if got := DevinWorkspaceCwd(body); got != root {
		t.Errorf("tagged cwd: got %q, want %q", got, root)
	}
}

// ─── enabled gate ────────────────────────────────────────────────────────────

func TestDevinEnabledGate(t *testing.T) {
	t.Setenv("DEVIN_CLI_ENABLED", "")
	if DevinEnabled() {
		t.Error("default must be disabled: this executor hands out a shell-capable agent")
	}
	t.Setenv("DEVIN_CLI_ENABLED", "false")
	if DevinEnabled() {
		t.Error("explicit false must be disabled")
	}
	t.Setenv("DEVIN_CLI_ENABLED", "TRUE")
	if !DevinEnabled() {
		t.Error("case-insensitive true must enable")
	}
}

func TestDevinRunACPRefusesWhenDisabled(t *testing.T) {
	t.Setenv("DEVIN_CLI_ENABLED", "")
	d := &Devin{}
	_, err := d.RunACP(context.Background(), Request{Model: "devin"}, Credential{})
	if err == nil {
		t.Fatal("RunACP must refuse when the executor is not enabled")
	}
	if !strings.Contains(err.Error(), "DEVIN_CLI_ENABLED") {
		t.Errorf("refusal should name the opt-in variable, got: %v", err)
	}
}

func TestDevinAdapterSatisfiesInterfaces(t *testing.T) {
	d := &Devin{}
	if d.Name() != "devin-cli" {
		t.Errorf("name: got %q", d.Name())
	}
	// Endpoint must error rather than return a bogus URL: a non-empty URL would
	// make Transport.Do issue a real HTTP request if dispatch ever regressed.
	if _, err := d.Endpoint(Request{}, Credential{}); err == nil {
		t.Error("Endpoint must report that this provider has no HTTP endpoint")
	}
	var _ DevinRunner = d
}

// ─── ACP protocol, against a real subprocess ─────────────────────────────────

// devinFakeAgent writes an executable shell script that speaks ACP.
//
// The script logs every request it receives to a sidecar file so the test can
// assert on request ORDER — initialize before session/new before session/prompt
// — which is a protocol requirement that a response-only assertion misses.
func devinFakeAgent(t *testing.T, scriptBody string) (bin, logPath string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake ACP agent uses a POSIX shell script")
	}

	dir := t.TempDir()
	bin = filepath.Join(dir, "devin")
	logPath = filepath.Join(dir, "requests.log")

	full := "#!/bin/sh\nLOG='" + logPath + "'\n" + scriptBody
	if err := os.WriteFile(bin, []byte(full), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, logPath
}

func devinReadSSE(t *testing.T, r io.Reader) []map[string]any {
	t.Helper()
	raw, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read SSE: %v", err)
	}
	var frames []map[string]any
	for _, block := range strings.Split(string(raw), "\n\n") {
		block = strings.TrimSpace(block)
		if !strings.HasPrefix(block, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(block, "data: ")
		if payload == "[DONE]" {
			continue
		}
		var frame map[string]any
		if err := json.Unmarshal([]byte(payload), &frame); err != nil {
			t.Fatalf("bad SSE frame %q: %v", payload, err)
		}
		frames = append(frames, frame)
	}
	return frames
}

func devinFrameText(frames []map[string]any) string {
	var b strings.Builder
	for _, f := range frames {
		choices, _ := f["choices"].([]any)
		for _, c := range choices {
			choice, _ := c.(map[string]any)
			delta, _ := choice["delta"].(map[string]any)
			if text, ok := delta["content"].(string); ok {
				b.WriteString(text)
			}
		}
	}
	return b.String()
}

func devinLastFinish(frames []map[string]any) string {
	for i := len(frames) - 1; i >= 0; i-- {
		choices, _ := frames[i]["choices"].([]any)
		for _, c := range choices {
			choice, _ := c.(map[string]any)
			if fr, ok := choice["finish_reason"].(string); ok && fr != "" {
				return fr
			}
		}
	}
	return ""
}

// devinStreamedTurn runs one turn against the fake agent and returns the frames.
func devinStreamedTurn(t *testing.T, scriptBody string, body []byte) []map[string]any {
	t.Helper()
	bin, _ := devinFakeAgent(t, scriptBody)
	t.Setenv("DEVIN_CLI_ENABLED", "true")
	t.Setenv("CLI_DEVIN_BIN", bin)
	t.Setenv("DEVIN_WORKSPACE_ROOTS", t.TempDir())

	d := &Devin{}
	stream, err := d.RunACP(context.Background(), Request{Model: "devin", Body: body}, Credential{})
	if err != nil {
		t.Fatalf("RunACP: %v", err)
	}
	defer stream.Close()
	return devinReadSSE(t, stream)
}

// devinReplier is the shell prologue that answers one request by id.
//
// `read line` gets a full JSON-RPC request; the id is extracted with sed so the
// response can echo it. Implementing the same thing inline per case would
// duplicate this four times.
const devinReplier = `
reply() {
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  printf '%s\n' "$2" | sed "s/__ID__/$id/"
}
`

func TestDevinACPOrdersRequestsCorrectly(t *testing.T) {
	// The fake agent writes each method name it sees, then replies.
	script := devinReplier + `
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG"
  case "$line" in
    *'"method":"initialize"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
    *'"method":"session/new"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{"sessionId":"sess-1"}}' ;;
    *'"method":"session/prompt"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{"content":"done"}}' ;;
  esac
done
`

	bin, logPath := devinFakeAgent(t, script)
	t.Setenv("DEVIN_CLI_ENABLED", "true")
	t.Setenv("CLI_DEVIN_BIN", bin)
	t.Setenv("DEVIN_WORKSPACE_ROOTS", t.TempDir())

	d := &Devin{}
	stream, err := d.RunACP(context.Background(),
		Request{Model: "devin", Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)},
		Credential{})
	if err != nil {
		t.Fatalf("RunACP: %v", err)
	}
	defer stream.Close()

	frames := devinReadSSE(t, stream)

	// The silent-stream fallback: no notifications, so the final prompt result
	// must carry the text. Without it the client sees an empty turn.
	if text := devinFrameText(frames); !strings.Contains(text, "done") {
		t.Errorf("expected text from prompt result, got %q", text)
	}

	logged, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read request log: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(logged)), "\n")
	if len(lines) < 3 {
		t.Fatalf("expected 3 requests, got %d:\n%s", len(lines), logged)
	}

	for i, want := range []string{"initialize", "session/new", "session/prompt"} {
		if !strings.Contains(lines[i], `"method":"`+want+`"`) {
			t.Errorf("request %d: want %s, got %s", i, want, lines[i])
		}
	}

	// Protocol details that each caused a real -32602 upstream. Field order is
	// not asserted: these params are a map, so json.Marshal emits keys sorted.
	if !strings.Contains(lines[1], `"mcpServers":[]`) {
		t.Errorf("session/new must send mcpServers as an empty array, got: %s", lines[1])
	}
	if !strings.Contains(lines[2], `"prompt":[{"`) {
		t.Errorf("session/prompt must send prompt as a content-block array, got: %s", lines[2])
	}
	if !strings.Contains(lines[2], `"type":"text"`) {
		t.Errorf("prompt blocks must carry type=text, got: %s", lines[2])
	}
	if !strings.Contains(lines[2], `"sessionId":"sess-1"`) {
		t.Errorf("session/prompt must carry the sessionId from session/new, got: %s", lines[2])
	}
}

func TestDevinACPStreamsNestedSessionUpdate(t *testing.T) {
	// devin 3000.2.x nests the payload under params.update.
	script := devinReplier + `
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
    *'"method":"session/new"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{"sessionId":"s1"}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hel"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"lo"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"_cognition.ai/agent_stopped","params":{"cause":"done"}}'
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
  esac
done
`

	frames := devinStreamedTurn(t, script, []byte(`{"messages":[{"role":"user","content":"hi"}]}`))

	if text := devinFrameText(frames); text != "Hello" {
		t.Errorf("streamed text: got %q, want %q", text, "Hello")
	}
	if got := devinLastFinish(frames); got != "stop" {
		t.Errorf("finish_reason: got %q, want stop", got)
	}
}

func TestDevinACPStreamsFlatUpdate(t *testing.T) {
	// Older builds use a flat params.type / params.delta shape. Supporting only
	// the nested form makes this build stream nothing.
	script := devinReplier + `
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
    *'"method":"session/new"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{"sessionId":"s1"}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"type":"agent_message_chunk","delta":"flat text"}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"_cognition.ai/agent_stopped","params":{}}'
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
  esac
done
`

	frames := devinStreamedTurn(t, script, []byte(`{"messages":[{"role":"user","content":"hi"}]}`))

	if text := devinFrameText(frames); !strings.Contains(text, "flat text") {
		t.Errorf("flat update dropped: got %q", text)
	}
}

func TestDevinACPToolCallEmitsToolCallsFinish(t *testing.T) {
	// A client-tool call must become an OpenAI tool_call and end the turn with
	// finish_reason "tool_calls", which is the client's cue to run the tool and
	// send the result back.
	script := devinReplier + `
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
    *'"method":"session/new"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{"sessionId":"s1"}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","title":"Calling mcp_read_file from clientTools","toolCallId":"tc1","rawInput":{"path":"/tmp/a"}}}}'
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
  esac
done
`

	frames := devinStreamedTurn(t, script, []byte(`{"messages":[{"role":"user","content":"read it"}]}`))

	if got := devinLastFinish(frames); got != "tool_calls" {
		t.Fatalf("finish_reason: got %q, want tool_calls", got)
	}

	var name, args, callID string
	for _, f := range frames {
		choices, _ := f["choices"].([]any)
		for _, c := range choices {
			choice, _ := c.(map[string]any)
			delta, _ := choice["delta"].(map[string]any)
			calls, _ := delta["tool_calls"].([]any)
			for _, tc := range calls {
				call, _ := tc.(map[string]any)
				callID, _ = call["id"].(string)
				fn, _ := call["function"].(map[string]any)
				name, _ = fn["name"].(string)
				args, _ = fn["arguments"].(string)
			}
		}
	}

	// The mcp_ prefix and the server namespace are stripped so the client sees
	// the tool name it originally declared.
	if name != "file" && name != "read_file" {
		t.Errorf("tool name: got %q, want the client's own name", name)
	}
	if callID != "tc1" {
		t.Errorf("tool call id: got %q, want tc1", callID)
	}
	if !strings.Contains(args, "/tmp/a") {
		t.Errorf("tool arguments lost rawInput: got %q", args)
	}
}

func TestDevinACPIgnoresDevinInternalToolCalls(t *testing.T) {
	// Only calls that came through the client's MCP bridge are echoed back.
	// Surfacing devin's own internal tools would hand the client calls for
	// functions it never declared.
	script := devinReplier + `
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
    *'"method":"session/new"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{"sessionId":"s1"}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","title":"Running internal grep","toolCallId":"tc9","rawInput":{"q":"x"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"observed"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"_cognition.ai/agent_stopped","params":{}}'
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
  esac
done
`

	frames := devinStreamedTurn(t, script, []byte(`{"messages":[{"role":"user","content":"hi"}]}`))

	if got := devinLastFinish(frames); got != "stop" {
		t.Errorf("internal tool call should not end the turn as tool_calls, got %q", got)
	}
	if text := devinFrameText(frames); !strings.Contains(text, "observed") {
		t.Errorf("turn should continue after an internal call, got %q", text)
	}
}

func TestDevinACPAutoApprovesPermissionRequests(t *testing.T) {
	// A headless gateway never answers a permission prompt by hand, so the
	// agent would block forever. The client must reply itself.
	script := devinReplier + `
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
    *'"method":"session/new"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{"sessionId":"s1"}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":{"options":[{"optionId":"allow_once","kind":"allow_once"},{"optionId":"deny","kind":"reject"}]}}'
      # The next request back must be the permission reply, not a new method.
      if IFS= read -r resp; then
        printf '%s\n' "$resp" >> "$LOG.reply"
      fi
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"approved"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"_cognition.ai/agent_stopped","params":{}}'
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
  esac
done
`

	bin, logPath := devinFakeAgent(t, script)
	t.Setenv("DEVIN_CLI_ENABLED", "true")
	t.Setenv("CLI_DEVIN_BIN", bin)
	t.Setenv("DEVIN_WORKSPACE_ROOTS", t.TempDir())

	d := &Devin{}
	stream, err := d.RunACP(context.Background(),
		Request{Model: "devin", Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)},
		Credential{})
	if err != nil {
		t.Fatalf("RunACP: %v", err)
	}
	defer stream.Close()
	_ = devinReadSSE(t, stream)

	reply, err := os.ReadFile(logPath + ".reply")
	if err != nil {
		t.Fatalf("agent never received a permission reply: %v", err)
	}
	// The reply id must echo the request id exactly, or the agent cannot
	// correlate it and stays blocked.
	if !strings.Contains(string(reply), `"id":77`) {
		t.Errorf("permission reply did not echo the request id: %s", reply)
	}
	if !strings.Contains(string(reply), "allow_once") {
		t.Errorf("permission reply did not select the allow option: %s", reply)
	}
}

func TestDevinACPReportsRPCError(t *testing.T) {
	script := devinReplier + `
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
    *'"method":"session/new"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"error":{"code":-32602,"message":"Invalid params: mcpServers is required"}}' ;;
  esac
done
`

	frames := devinStreamedTurn(t, script, []byte(`{"messages":[{"role":"user","content":"hi"}]}`))

	var errMsg string
	for _, f := range frames {
		if e, ok := f["error"].(map[string]any); ok {
			errMsg, _ = e["message"].(string)
		}
	}
	if !strings.Contains(errMsg, "Invalid params") {
		t.Errorf("RPC error not surfaced to the client, got: %q", errMsg)
	}
}

func TestDevinACPReportsAgentError(t *testing.T) {
	script := devinReplier + `
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
    *'"method":"session/new"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{"sessionId":"s1"}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"_cognition.ai/agent_stopped","params":{"cause":"error","errorMessage":"auth token expired"}}'
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
  esac
done
`

	frames := devinStreamedTurn(t, script, []byte(`{"messages":[{"role":"user","content":"hi"}]}`))

	var errMsg string
	for _, f := range frames {
		if e, ok := f["error"].(map[string]any); ok {
			errMsg, _ = e["message"].(string)
		}
	}
	if !strings.Contains(errMsg, "auth token expired") {
		t.Errorf("agent error not surfaced, got: %q", errMsg)
	}
}

func TestDevinACPSurvivesNonJSONBanner(t *testing.T) {
	// A binary that prints a banner or a log line to stdout must not abort the
	// stream: only frames that fail to parse are skipped.
	script := devinReplier + `
echo "devin cli 3000.2.1 starting"
echo "warn: no cache dir"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
    *'"method":"session/new"'*)
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{"sessionId":"s1"}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"survived"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"_cognition.ai/agent_stopped","params":{}}'
      reply "$line" '{"jsonrpc":"2.0","id":__ID__,"result":{}}' ;;
  esac
done
`

	frames := devinStreamedTurn(t, script, []byte(`{"messages":[{"role":"user","content":"hi"}]}`))

	if text := devinFrameText(frames); !strings.Contains(text, "survived") {
		t.Errorf("banner on stdout broke the stream, got %q", text)
	}
}

func TestDevinACPCancellationClosesStream(t *testing.T) {
	// A hanging agent must not hold the client connection open forever.
	script := `
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}' ;;
    *'"method":"session/prompt"'*)
      sleep 300 ;;
  esac
done
`

	bin, _ := devinFakeAgent(t, script)
	t.Setenv("DEVIN_CLI_ENABLED", "true")
	t.Setenv("CLI_DEVIN_BIN", bin)
	t.Setenv("DEVIN_WORKSPACE_ROOTS", t.TempDir())

	ctx, cancel := context.WithCancel(context.Background())

	d := &Devin{}
	stream, err := d.RunACP(ctx, Request{Model: "devin", Body: []byte(`{"messages":[{"role":"user","content":"hi"}]}`)}, Credential{})
	if err != nil {
		t.Fatalf("RunACP: %v", err)
	}
	defer stream.Close()

	done := make(chan error, 1)
	go func() {
		_, err := io.ReadAll(stream)
		done <- err
	}()

	time.Sleep(300 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// stream closed as expected
	case <-time.After(10 * time.Second):
		t.Fatal("cancellation did not close the stream: the subprocess outlived its context")
	}
}

// ─── MCP config bridge ───────────────────────────────────────────────────────

func TestDevinMCPConfigIsolatedAndCleanedUp(t *testing.T) {
	home, cleanup, err := devinWriteMCPConfig([]byte(`{
		"mcp_servers": [{"name":"local","command":"/usr/bin/mcp-server","args":["--port","1"]}]
	}`))
	if err != nil {
		t.Fatalf("write MCP config: %v", err)
	}
	if home == "" {
		t.Fatal("expected an isolated config home")
	}
	defer cleanup()

	// The config must live under the temp home, never in the user's own devin
	// config directory.
	if !strings.HasPrefix(home, os.TempDir()) {
		t.Errorf("config home %q is not inside the temp dir", home)
	}

	configPath := filepath.Join(home, "devin", "config.json")
	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("config not written: %v", err)
	}
	var parsed struct {
		MCPServers []map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("config not valid JSON: %v", err)
	}
	if len(parsed.MCPServers) != 1 {
		t.Fatalf("expected 1 server, got %d", len(parsed.MCPServers))
	}
	if parsed.MCPServers[0]["command"] != "/usr/bin/mcp-server" {
		t.Errorf("command lost: %v", parsed.MCPServers[0])
	}

	cleanup()
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Errorf("cleanup left %q behind", home)
	}
}

func TestDevinMCPConfigEmptyWhenNoServers(t *testing.T) {
	home, cleanup, err := devinWriteMCPConfig([]byte(`{"messages":[]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if home != "" || cleanup != nil {
		t.Error("no servers means no config directory should be created")
	}
}

func TestDevinMCPFromBodyReadsAllDeclarations(t *testing.T) {
	servers := devinMCPFromBody([]byte(`{"mcp_servers":[{"name":"a","url":"http://x"}]}`))
	if len(servers) != 1 || servers[0]["url"] != "http://x" {
		t.Errorf("http MCP server not parsed: %v", servers)
	}

	// A tools-only request still needs its tool names exposed.
	servers = devinMCPFromBody([]byte(`{"tools":[{"type":"function","function":{"name":"get_weather"}}]}`))
	if len(servers) != 1 {
		t.Fatalf("tools list not parsed: %v", servers)
	}
	names, _ := servers[0]["_clientTools"].([]string)
	if len(names) != 1 || names[0] != "get_weather" {
		t.Errorf("tool names not captured: %v", servers[0])
	}
}

// ─── SSE writer ──────────────────────────────────────────────────────────────

func TestDevinWriterEmitsSingleRoleChunk(t *testing.T) {
	reader, writer := io.Pipe()
	w := newDevinWriter(writer, "devin", 100)

	go func() {
		w.Delta("a")
		w.Delta("b")
		w.ToolUse("fn", "{}", "c1")
		w.Finish("tool_calls")
	}()

	raw, _ := io.ReadAll(reader)
	blocks := strings.Split(strings.TrimSpace(string(raw)), "\n\n")

	var roleChunks int
	for _, block := range blocks {
		if strings.Contains(block, `"role":"assistant"`) {
			roleChunks++
		}
	}
	if roleChunks != 1 {
		t.Errorf("role chunk emitted %d times, want exactly 1", roleChunks)
	}
	if !strings.HasSuffix(strings.TrimSpace(string(raw)), "[DONE]") {
		t.Error("stream must end with [DONE]")
	}
}

func TestDevinWriterFinishIsIdempotent(t *testing.T) {
	// Both the agent_stopped notification and the prompt result can end a turn.
	// A second finish must not emit a second finish_reason or a second [DONE],
	// which would corrupt the client's stream parse.
	reader, writer := io.Pipe()
	w := newDevinWriter(writer, "devin", 10)

	go func() {
		w.Delta("x")
		w.Finish("stop")
		w.Finish("stop")
	}()

	raw, _ := io.ReadAll(reader)
	if got := strings.Count(string(raw), "[DONE]"); got != 1 {
		t.Errorf("emitted %d [DONE] markers, want 1", got)
	}
	if got := strings.Count(string(raw), `"finish_reason":"stop"`); got != 1 {
		t.Errorf("emitted %d finish frames, want 1", got)
	}
}

func TestDevinWriterFailSurfacesErrorThenCloses(t *testing.T) {
	reader, writer := io.Pipe()
	w := newDevinWriter(writer, "devin", 10)

	go func() { w.Fail("boom", "devin_cli_exit") }()

	raw, _ := io.ReadAll(reader)
	if !strings.Contains(string(raw), "boom") {
		t.Errorf("error message not emitted: %s", raw)
	}
	if !strings.Contains(string(raw), "[DONE]") {
		t.Error("a failed stream must still terminate with [DONE]")
	}
}

func TestDevinWriterUsageIsPresent(t *testing.T) {
	reader, writer := io.Pipe()
	w := newDevinWriter(writer, "devin", 400)

	go func() {
		w.Delta(strings.Repeat("t", 200))
		w.Finish("stop")
	}()
	raw, _ := io.ReadAll(reader)

	// 400 prompt chars / 4 = 100 prompt tokens; 200 completion / 4 = 50.
	if !strings.Contains(string(raw), `"prompt_tokens":100`) {
		t.Errorf("prompt token estimate missing or wrong: %s", raw)
	}
	if !strings.Contains(string(raw), `"completion_tokens":50`) {
		t.Errorf("completion token estimate missing or wrong: %s", raw)
	}
}

// ─── registry ────────────────────────────────────────────────────────────────

func TestDevinResolvesThroughRegistry(t *testing.T) {
	r := NewRegistry()
	RegisterWave7(r)

	adapter, ok := r.Resolve("devin-cli")
	if !ok {
		t.Fatal("devin-cli did not resolve through the registry")
	}
	if adapter.Name() != "devin-cli" {
		t.Errorf("resolved to %q", adapter.Name())
	}
}
