package providers

// The Cursor AgentService transport: a bidirectional HTTP/2 exchange.
//
// This is the part of the Cursor port with no analogue elsewhere in the gateway.
// Every other provider is request/response: send a body, read a stream back.
// AgentService emits *its own requests* interleaved into the response — for IDE
// context, for KV blobs, and for MCP tool calls — and stalls silently until each
// is answered on the same connection.
//
// Go's net/http exposes that duplex shape through ClientConn.RoundTrip: the
// request body is an io.Reader the client keeps writing to while the response
// body is read concurrently. That is exactly the shape this needs, and it means
// the transport stays inside the standard library (net/http + http2 ALPN) rather
// than reaching for a lower-level framing API.

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// agentSendTimeout bounds a single frame write. A write that blocks means the peer
// stopped reading, which is a dead stream rather than backpressure worth waiting on.
const agentSendTimeout = 10 * time.Second

// cursorDuplexBody is the request body: an infinite reader the caller keeps
// writing into, which is what keeps a RoundTrip duplex rather than half-closed.
//
// A plain bytes.Reader would signal end-of-body as soon as it were drained, and
// the upstream would then refuse to accept further acks — which is precisely the
// stall this transport exists to avoid.
type cursorDuplexBody struct {
	mu        sync.Mutex
	cond      *sync.Cond
	pending   [][]byte
	closed    bool
	readErr   error
	writtenAt time.Time
}

func newCursorDuplexBody() *cursorDuplexBody {
	body := &cursorDuplexBody{writtenAt: time.Now()}
	body.cond = sync.NewCond(&body.mu)
	return body
}

// Write queues one frame for the wire.
func (b *cursorDuplexBody) Write(frame []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return 0, errors.New("cursor: the agent stream is closed")
	}
	copied := make([]byte, len(frame))
	copy(copied, frame)
	b.pending = append(b.pending, copied)
	b.writtenAt = time.Now()
	b.cond.Broadcast()
	return len(frame), nil
}

// Read blocks until a frame is queued, then hands it out. It returns only when
// the body is closed, which is what makes the RoundTrip stay open while the
// response is being consumed.
func (b *cursorDuplexBody) Read(p []byte) (int, error) {
	b.mu.Lock()
	for len(b.pending) == 0 && !b.closed {
		b.cond.Wait()
	}
	if len(b.pending) > 0 {
		frame := b.pending[0]
		b.pending = b.pending[1:]
		n := copy(p, frame)
		if n < len(frame) {
			// A partial drain means the caller's buffer is smaller than the
			// frame; keep the remainder queued rather than losing bytes.
			rest := make([]byte, len(frame)-n)
			copy(rest, frame[n:])
			b.pending = append([][]byte{rest}, b.pending...)
		}
		b.mu.Unlock()
		return n, nil
	}
	err := b.readErr
	b.mu.Unlock()
	if err != nil {
		return 0, err
	}
	return 0, io.EOF
}

// Close ends the request side.
func (b *cursorDuplexBody) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	b.cond.Broadcast()
	return nil
}

// cursorAgentConn is one live duplex Run.
type cursorAgentConn struct {
	requestBody *cursorDuplexBody
	response    *http.Response
	conn        *http.ClientConn
	closeOnce   sync.Once
}

// write sends one framed message to the upstream.
func (c *cursorAgentConn) write(frame []byte) error {
	done := make(chan error, 1)
	go func() {
		_, err := c.requestBody.Write(frame)
		done <- err
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(agentSendTimeout):
		return errors.New("cursor: timed out writing a frame to the agent stream")
	}
}

// body is the response side, where the server's frames arrive.
func (c *cursorAgentConn) body() io.ReadCloser { return c.response.Body }

// close tears the exchange down. Idempotent: the error paths and the success
// path both call it.
func (c *cursorAgentConn) close() {
	c.closeOnce.Do(func() {
		c.requestBody.Close()
		if c.response != nil && c.response.Body != nil {
			c.response.Body.Close()
		}
		if c.conn != nil {
			c.conn.Release()
		}
	})
}

// cursorAgentDialer opens the duplex exchange for a Run.
//
// A fresh connection per Run: an AgentService session is not resumable, so
// pooling would only hold a socket the upstream has already abandoned.
func cursorAgentDialer(ctx context.Context, rawURL string, headers map[string]string) (*cursorAgentConn, error) {
	host, _, err := cursorParseHost(rawURL)
	if err != nil {
		return nil, fmt.Errorf("cursor: parsing agent url: %w", err)
	}

	tlsConfig := &tls.Config{
		ServerName: strings.Split(host, ":")[0],
		NextProtos: []string{"h2"},
		MinVersion: tls.VersionTLS12,
	}

	transport := &http2Transport{
		tlsConfig:   tlsConfig,
		dialTimeout: 15 * time.Second,
	}

	conn, err := transport.newClientConn(ctx, "https", host)
	if err != nil {
		return nil, fmt.Errorf("cursor: opening h2 connection: %w", err)
	}

	body := newCursorDuplexBody()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, body)
	if err != nil {
		conn.Release()
		return nil, fmt.Errorf("cursor: building agent request: %w", err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	request.Header.Set("content-type", "application/connect+proto")

	response, err := conn.RoundTrip(request)
	if err != nil {
		body.Close()
		conn.Release()
		return nil, fmt.Errorf("cursor: agent round trip: %w", err)
	}

	return &cursorAgentConn{
		requestBody: body,
		response:    response,
		conn:        conn,
	}, nil
}

// http2Transport is a minimal h2 client built on net/http.Transport, whose
// NewClientConn is the supported route to a single duplex connection.
type http2Transport struct {
	tlsConfig   *tls.Config
	dialTimeout time.Duration
}

func (t *http2Transport) newClientConn(ctx context.Context, scheme, address string) (*http.ClientConn, error) {
	transport := &http.Transport{
		TLSClientConfig:   t.tlsConfig,
		ForceAttemptHTTP2: true,
		// One connection, held open for the life of the Run: the duplex body
		// stays writable, so a pool would be meaningless here.
		MaxConnsPerHost: 1,
		IdleConnTimeout: 0,
		DialContext: func(dialCtx context.Context, network, addr string) (net.Conn, error) {
			dialer := &net.Dialer{Timeout: t.dialTimeout}
			return dialer.DialContext(dialCtx, network, addr)
		},
	}
	_ = bytes.MinRead // keep the import honest if the file is trimmed
	return transport.NewClientConn(ctx, scheme, address)
}

// ── agent response frames ────────────────────────────────────────────────────

// cursorAgentEvent is what one decoded server frame produced.
type cursorAgentEvent struct {
	// Kind is one of: text, thinking, tool_call, exec, kv, done.
	Kind string
	Text string
	Call *cursorToolCall
	// ExecFields carries an agent.v1.ExecServerMessage for the caller to answer.
	ExecFields map[int][]pbField
	// KVFields carries an agent.v1.KvServerMessage for the caller to answer.
	KVFields map[int][]pbField
}

// decodeCursorAgentFrame classifies one AgentServerMessage payload.
//
// The variants are interaction_update (1), exec (2) and kv (4). A frame can carry
// more than one, so the returned slice preserves encounter order.
func decodeCursorAgentFrame(payload []byte) ([]cursorAgentEvent, error) {
	fields, err := pbMessage(payload)
	if err != nil {
		return nil, err
	}
	events := []cursorAgentEvent{}

	// interaction_update = 1
	if raw := pbFirstBytes(fields, agentServerFieldUpdate); raw != nil {
		update, err := pbMessage(raw)
		if err != nil {
			return nil, err
		}
		if textRaw := pbFirstBytes(update, agentUpdateFieldTextDelta); textRaw != nil {
			if delta, err := pbMessage(textRaw); err == nil {
				if text := pbFirstString(delta, agentDeltaFieldText); text != "" {
					events = append(events, cursorAgentEvent{Kind: "text", Text: text})
				}
			}
		}
		if thinkRaw := pbFirstBytes(update, agentUpdateFieldThinkingDelta); thinkRaw != nil {
			if delta, err := pbMessage(thinkRaw); err == nil {
				if text := pbFirstString(delta, agentDeltaFieldText); text != "" {
					events = append(events, cursorAgentEvent{Kind: "thinking", Text: text})
				}
			}
		}
		if pbHas(update, agentUpdateFieldTurnDone) {
			events = append(events, cursorAgentEvent{Kind: "done"})
		}
	}

	// exec = 2
	if raw := pbFirstBytes(fields, agentServerFieldExec); raw != nil {
		execFields, err := pbMessage(raw)
		if err != nil {
			return nil, err
		}
		answered := false
		if pbHas(execFields, agentExecVariantMcpArgs) {
			name, callID, toolName, args, argsErr := decodeAgentMcpArgs(pbFirstBytes(execFields, agentExecVariantMcpArgs))
			if argsErr != nil {
				return nil, argsErr
			}
			display := toolName
			if display == "" {
				display = name
			}
			if display != "" {
				encoded, marshalErr := json.Marshal(args)
				if marshalErr != nil {
					encoded = []byte("{}")
				}
				id := callID
				if id == "" {
					id = "call_" + curUUID()
				}
				events = append(events, cursorAgentEvent{
					Kind: "tool_call",
					Call: &cursorToolCall{ID: id, Name: display, Arguments: string(encoded), IsLast: true},
				})
				answered = true
			}
		}
		if !answered {
			events = append(events, cursorAgentEvent{Kind: "exec", ExecFields: execFields})
		}
	}

	// kv = 4
	if raw := pbFirstBytes(fields, agentServerFieldKv); raw != nil {
		kvFields, err := pbMessage(raw)
		if err != nil {
			return nil, err
		}
		events = append(events, cursorAgentEvent{Kind: "kv", KVFields: kvFields})
	}

	return events, nil
}

// cursorAgentKVAnswer builds the ack for a get or set KV request.
func cursorAgentKVAnswer(kvFields map[int][]pbField) []byte {
	id := pbFirstVarint(kvFields, agentKvMsgFieldID)
	metadata := pbFirstBytes(kvFields, agentKvMsgFieldMeta)

	switch {
	case pbHas(kvFields, agentKvMsgFieldGet):
		var value pbWriter
		value.fieldBytes(agentKvResultFieldOK, nil)
		return encodeAgentKvMessage(id, agentKvResultFieldVal, value.bytes(), metadata)
	case pbHas(kvFields, agentKvMsgFieldSet):
		return encodeAgentKvMessage(id, agentKvResultFieldAck, nil, metadata)
	}
	return nil
}

// cursorAgentErrorBody reads a non-200 AgentService body as text.
func cursorAgentErrorBody(body io.Reader) string {
	raw, err := io.ReadAll(io.LimitReader(body, 64*1024))
	if err != nil {
		return ""
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ""
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
		if message := cursorExtractError(parsed); message != "" {
			return message
		}
	}
	return trimmed
}
