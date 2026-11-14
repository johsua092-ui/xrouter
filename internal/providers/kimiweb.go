package providers

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Kimi Web — port of open-sse/executors/kimi-web.js.
//
// This is not an OpenAI-compatible endpoint. It is a gRPC-Connect-style service
// over HTTP: the request body is a length-prefixed frame, the response is a stream
// of frames, and the payloads are the provider's own message schema rather than
// chat-completions. The client's transcript is therefore folded into one prompt
// string, since the upstream takes a single user message with an optional system
// prompt rather than a message array.
//
// Connect framing (5-byte header, big-endian length):
//
//	byte 0    flags
//	bytes 1-4 uint32 payload length
//	bytes 5-  payload
//
// Two flag bits are meaningful: 0x01 marks a compressed payload and 0x02 marks the
// end of the stream. A compressed frame is refused rather than mis-parsed — the
// alternative is silently producing garbage from deflate-compressed bytes.

const (
	kimiBaseURL  = "https://www.kimi.ai"
	kimiChatPath = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat"
	kimiRefresh  = "/api/auth/token/refresh"

	// kimiUserAgent is a browser string because the endpoint is the web app's own
	// backend: a non-browser UA is refused by the edge.
	kimiUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"

	// kimiMaxFrameLen bounds a frame. An unbounded length read from an untrusted
	// stream is a memory-exhaustion vector, not a parse error.
	kimiMaxFrameLen = 8 * 1024 * 1024

	kimiFlagCompressed = 0x01
	kimiFlagEndStream  = 0x02
)

// kimiModelConfig is the per-model scenario and reasoning settings.
type kimiModelConfig struct {
	Scenario               string
	SupportedReasoning     []string
	DefaultReasoningEffort string
}

// KimiWebModels are the models this provider serves. An id outside this set is
// refused before any request: the upstream's scenario field is model-specific, and
// guessing it produces a confusing upstream error.
var KimiWebModels = map[string]kimiModelConfig{
	"k3": {
		Scenario:               "SCENARIO_K2D5",
		SupportedReasoning:     []string{"REASONING_EFFORT_NONE", "REASONING_EFFORT_LOW"},
		DefaultReasoningEffort: "REASONING_EFFORT_NONE",
	},
	"k2d6": {
		Scenario:               "SCENARIO_K2D5",
		SupportedReasoning:     []string{"REASONING_EFFORT_NONE", "REASONING_EFFORT_LOW"},
		DefaultReasoningEffort: "REASONING_EFFORT_NONE",
	},
}

// ── credential extraction ────────────────────────────────────────────────────

// ExtractKimiAccessToken pulls an access token out of whatever the user pasted.
//
// The dashboard invites a paste from DevTools Local Storage, which can be a JSON
// blob, a full Cookie header, a bare `authorization: Bearer …` line, or the token
// alone. Each form is tried in turn; a value containing `=` or `;` that matches
// nothing is rejected rather than sent as a token, since a mis-pasted cookie
// header produces a 401 that looks like an expired credential.
func ExtractKimiAccessToken(rawValue string) string {
	raw := strings.TrimSpace(rawValue)
	if raw == "" {
		return ""
	}

	if strings.HasPrefix(raw, "{") && strings.HasSuffix(raw, "}") {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
			for _, k := range []string{"access_token", "token"} {
				if v, ok := parsed[k].(string); ok && strings.TrimSpace(v) != "" {
					return strings.TrimSpace(v)
				}
			}
		}
	}

	// "authorization: Bearer <token>" with the scheme case-insensitive. A leading
	// `Bearer ` is also accepted on its own, since that is what a DevTools
	// request header copies as.
	if v := kimiBearerValue(raw); v != "" {
		return v
	}

	for _, key := range []string{"access_token", "kimi-auth"} {
		if v := kimiNamedValue(raw, key); v != "" {
			return v
		}
	}

	// A JSON object that holds only a refresh token is a refresh credential, not an
	// access token. Falling through would hand the JSON blob to the upstream as a
	// bearer value.
	if strings.HasPrefix(raw, "{") && strings.HasSuffix(raw, "}") {
		return ""
	}

	if !strings.Contains(raw, "=") && !strings.Contains(raw, ";") {
		return raw
	}
	return ""
}

// ExtractKimiRefreshToken pulls a refresh token out of the same paste.
func ExtractKimiRefreshToken(rawValue string) string {
	raw := strings.TrimSpace(rawValue)
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "{") && strings.HasSuffix(raw, "}") {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
			if v, ok := parsed["refresh_token"].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
	}
	return kimiNamedValue(raw, "refresh_token")
}

// kimiBearerValue extracts the token from a Bearer-style string.
//
// The leading scheme is stripped whether or not it is preceded by the header name,
// because both forms are copied out of DevTools and both mean the same thing.
func kimiBearerValue(raw string) string {
	rest := strings.TrimSpace(raw)
	if i := strings.Index(strings.ToLower(rest), "authorization:"); i == 0 {
		rest = strings.TrimSpace(rest[len("authorization:"):])
	}
	rest = strings.Trim(rest, "\"")
	if len(rest) >= 7 && strings.EqualFold(rest[:7], "bearer ") {
		return strings.TrimSpace(rest[7:])
	}
	return ""
}

// kimiNamedValue finds `key=value` in a cookie- or query-style string.
func kimiNamedValue(raw, key string) string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ';' || r == ' ' || r == '\n' || r == '\t'
	})
	for _, f := range fields {
		if i := strings.Index(f, "="); i > 0 {
			if strings.EqualFold(f[:i], key) {
				return strings.Trim(f[i+1:], "\"' ")
			}
		}
	}
	return ""
}

// ── Connect framing ──────────────────────────────────────────────────────────

// FrameConnectMessage encodes a payload as a Connect frame.
func FrameConnectMessage(payload []byte) []byte {
	out := make([]byte, 5+len(payload))
	out[0] = 0
	binary.BigEndian.PutUint32(out[1:5], uint32(len(payload)))
	copy(out[5:], payload)
	return out
}

// KimiFrame is one decoded Connect frame.
type KimiFrame struct {
	Flags   byte
	Message map[string]any
	// Payload is the raw frame body, kept so a caller can log or re-inspect it.
	Payload []byte
}

// DecodeKimiFrame decodes one frame starting at offset.
//
// The three outcomes are distinct and each is meaningful:
//
//	consumed > 0  a frame was decoded
//	consumed == 0 the buffer does not yet hold a whole frame; read more
//	consumed < 0  the frame is invalid and the stream must be abandoned
//
// Collapsing "need more bytes" into "invalid" would truncate a legitimate stream,
// which is why the Node implementation distinguishes them and so does this.
func DecodeKimiFrame(buf []byte, offset int) (KimiFrame, int, error) {
	if offset+5 > len(buf) {
		return KimiFrame{}, 0, nil
	}

	flags := buf[offset]
	length := binary.BigEndian.Uint32(buf[offset+1 : offset+5])

	// A length beyond the ceiling is a hard error, not a "wait for more": no
	// legitimate frame is that large, and waiting would buffer without bound.
	if int(length) > kimiMaxFrameLen {
		return KimiFrame{}, -1, fmt.Errorf("kimi connect frame length %d exceeds the %d ceiling", length, kimiMaxFrameLen)
	}
	if offset+5+int(length) > len(buf) {
		return KimiFrame{}, 0, nil
	}

	if flags&^byte(kimiFlagCompressed|kimiFlagEndStream) != 0 {
		return KimiFrame{}, -1, fmt.Errorf("kimi connect frame used unsupported flags: %d", flags)
	}
	if flags&kimiFlagCompressed != 0 {
		// Refused rather than mis-parsed: interpreting compressed bytes as JSON
		// would either fail opaquely or, worse, parse into nonsense.
		return KimiFrame{}, -1, errors.New("kimi connect compressed frames are not supported")
	}

	payload := buf[offset+5 : offset+5+int(length)]
	var msg map[string]any
	if length > 0 {
		if err := json.Unmarshal(payload, &msg); err != nil {
			return KimiFrame{}, -1, errors.New("kimi connect frame contained invalid JSON")
		}
	}
	return KimiFrame{Flags: flags, Message: msg, Payload: payload}, 5 + int(length), nil
}

// EndStreamError reports the upstream error on an end-of-stream frame, if any.
//
// Reading the error only from the terminal frame is deliberate: an error frame
// earlier in the stream is informational, and treating it as fatal would abort a
// stream the upstream intended to continue.
func (f KimiFrame) EndStreamError() string {
	if f.Flags&kimiFlagEndStream == 0 {
		return ""
	}
	errObj, ok := f.Message["error"].(map[string]any)
	if !ok {
		return ""
	}
	code, _ := errObj["code"].(string)
	if code == "" {
		code = "unknown"
	}
	msg, _ := errObj["message"].(string)
	if msg == "" {
		msg = "upstream error"
	}
	return code + ": " + msg
}

// ── delta extraction ─────────────────────────────────────────────────────────

// KimiDelta is one increment of model output.
type KimiDelta struct {
	// Kind is "text" or "think". Thinking is separated so a client can render it
	// in a different channel rather than mixing it into the answer.
	Kind string
	Text string
}

// ExtractKimiDelta reads the text out of a stream message.
//
// The upstream addresses fields by a `mask` path with an `op` verb. Only `append`
// and `set` on the block text and think paths carry output; anything else is
// metadata and is skipped rather than guessed at.
func ExtractKimiDelta(msg map[string]any) *KimiDelta {
	if msg == nil {
		return nil
	}
	op, _ := msg["op"].(string)
	mask, _ := msg["mask"].(string)

	block, _ := msg["block"].(map[string]any)

	switch op {
	case "append":
		switch mask {
		case "block.text.content":
			if text := kimiBlockText(block, "text", "content"); text != "" {
				return &KimiDelta{Kind: "text", Text: text}
			}
		case "block.think.content":
			if text := kimiBlockText(block, "think", "content"); text != "" {
				return &KimiDelta{Kind: "think", Text: text}
			}
		}
	case "set":
		switch mask {
		case "block.text":
			if text := kimiBlockText(block, "text", "content"); text != "" {
				return &KimiDelta{Kind: "text", Text: text}
			}
		case "block.think":
			if text := kimiBlockText(block, "think", "content"); text != "" {
				return &KimiDelta{Kind: "think", Text: text}
			}
		}
	}
	return nil
}

// kimiBlockText reads block[outer][inner] as a string.
func kimiBlockText(block map[string]any, outer, inner string) string {
	if block == nil {
		return ""
	}
	section, ok := block[outer].(map[string]any)
	if !ok {
		return ""
	}
	s, _ := section[inner].(string)
	return s
}

// ── transcript folding ───────────────────────────────────────────────────────

// KimiFoldedMessages is a transcript flattened into the two strings the upstream
// accepts.
type KimiFoldedMessages struct {
	Prompt       string
	SystemPrompt string
}

// FoldKimiMessages flattens a chat transcript into one prompt plus an optional
// system prompt.
//
// The upstream takes a single user message, so every turn is rendered into one
// string. Two details are load-bearing:
//
//   - A tool result is rendered as `[Tool Result (name)]: …` so the model can tell
//     it apart from user speech. Without the label the model treats a tool's output
//     as the user talking.
//   - An assistant tool call is rendered back as the `<tool>` fence, which is the
//     same contract the bridge uses. That keeps the model's own earlier call
//     visible in the transcript, so it does not repeat the call.
func FoldKimiMessages(messages []any) (KimiFoldedMessages, error) {
	var systemParts, conversationParts []string

	for _, raw := range messages {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		text, err := kimiTextFromContent(m["content"])
		if err != nil {
			return KimiFoldedMessages{}, err
		}

		role, _ := m["role"].(string)

		if role == "tool" || role == "function" {
			name, _ := m["name"].(string)
			if name == "" {
				name, _ = m["tool_call_id"].(string)
			}
			if name == "" {
				name = "tool"
			}
			conversationParts = append(conversationParts, fmt.Sprintf("[Tool Result (%s)]:\n%s", name, text))
			continue
		}

		if calls, ok := m["tool_calls"].([]any); ok && len(calls) > 0 {
			if text != "" {
				conversationParts = append(conversationParts, "Assistant: "+text)
			}
			for _, tc := range calls {
				call, _ := tc.(map[string]any)
				fn, _ := call["function"].(map[string]any)
				name := ""
				if fn != nil {
					name, _ = fn["name"].(string)
				}
				var args any
				if fn != nil {
					args = fn["arguments"]
				}
				payload, err := json.Marshal(map[string]any{"name": name, "arguments": args})
				if err != nil {
					continue
				}
				conversationParts = append(conversationParts, "Assistant: <tool>"+string(payload)+"</tool>")
			}
			continue
		}

		switch role {
		case "system", "developer":
			if text != "" {
				systemParts = append(systemParts, text)
			}
		case "user":
			if text != "" {
				// The first user turn is unprefixed: it reads as the actual
				// question, with later turns labelled so the model can follow the
				// exchange.
				if len(conversationParts) > 0 {
					conversationParts = append(conversationParts, "User: "+text)
				} else {
					conversationParts = append(conversationParts, text)
				}
			}
		case "assistant":
			if text != "" {
				conversationParts = append(conversationParts, "Assistant: "+text)
			}
		default:
			if text != "" {
				conversationParts = append(conversationParts, role+": "+text)
			}
		}
	}

	return KimiFoldedMessages{
		Prompt:       strings.TrimSpace(strings.Join(conversationParts, "\n\n")),
		SystemPrompt: strings.TrimSpace(strings.Join(systemParts, "\n\n")),
	}, nil
}

// kimiTextFromContent reads text out of a string or a text-part array.
//
// Non-text parts are refused rather than dropped: a request carrying an image
// would otherwise go upstream with the image silently missing, and the user would
// see an answer about a picture the model never received.
func kimiTextFromContent(content any) (string, error) {
	if s, ok := content.(string); ok {
		return s, nil
	}
	parts, ok := content.([]any)
	if !ok {
		if content == nil {
			return "", nil
		}
		return "", errors.New("kimi web only supports text message content")
	}

	var b strings.Builder
	for _, raw := range parts {
		p, ok := raw.(map[string]any)
		if !ok {
			return "", errors.New("kimi web only supports text message content")
		}
		typ, _ := p["type"].(string)
		if (typ == "text" || typ == "input_text") && isString(p["text"]) {
			b.WriteString(p["text"].(string))
			continue
		}
		return "", errors.New("kimi web does not support image, audio, file, or tool content")
	}
	return b.String(), nil
}

func isString(v any) bool {
	_, ok := v.(string)
	return v == nil || ok
}

// ── request body ─────────────────────────────────────────────────────────────

// BuildKimiRequestBody assembles the upstream message envelope.
//
// The frame carries the provider's own schema, not chat-completions: a chat_id,
// a scenario chosen per model, and a single message whose blocks hold the folded
// prompt. `thinking` is enabled because the upstream expects the field, and the
// reasoning effort is only included when the model declares support for it —
// sending an unsupported effort is refused.
func BuildKimiRequestBody(folded KimiFoldedMessages, cfg kimiModelConfig, reasoningEffort string) ([]byte, error) {
	options := map[string]any{
		"thinking":      true,
		"enable_plugin": false,
	}
	if folded.SystemPrompt != "" {
		options["system_prompt"] = folded.SystemPrompt
	}
	if reasoningEffort != "" {
		options["reasoning_effort"] = reasoningEffort
	}

	payload := map[string]any{
		"chat_id":  "",
		"scenario": cfg.Scenario,
		"tools":    []any{},
		"message": map[string]any{
			"id":                   "",
			"parent_id":            "",
			"children_message_ids": []any{},
			"role":                 "user",
			"blocks": []any{
				map[string]any{
					"id":         "",
					"message_id": "",
					"text":       map[string]any{"content": folded.Prompt},
				},
			},
			"scenario":   cfg.Scenario,
			"labels":     []any{},
			"references": []any{},
			"is_goal":    false,
		},
		"options":    options,
		"project_id": "",
	}
	return json.Marshal(payload)
}

// KimiWeb is the adapter.
type KimiWeb struct{}

// NewKimiWeb builds the adapter.
func NewKimiWeb() *KimiWeb { return &KimiWeb{} }

func (a *KimiWeb) Name() string       { return "kimi-web" }
func (a *KimiWeb) WireFormat() string { return FormatOpenAI }

// Endpoint is the Connect RPC method path.
//
// The service and method are part of the path, not headers: a Connect call is an
// ordinary POST to `/<package>.<Service>/<Method>`, which is why this adapter
// cannot be expressed as a base-URL override.
func (a *KimiWeb) Endpoint(req Request, cred Credential) (string, error) {
	return kimiBaseURL + kimiChatPath, nil
}

// Headers sets the Connect framing headers plus the pasted session bearer.
func (a *KimiWeb) Headers(req Request, cred Credential) (map[string]string, error) {
	// The dashboard stores the pasted value in the cookie slot; the API-key slot
	// holds it too when a user pastes a bearer. Either way the value is a token,
	// so the same extractor handles both.
	token := ExtractKimiAccessToken(cred.AccessToken)
	if token == "" {
		token = ExtractKimiAccessToken(cred.Cookie)
	}
	if token == "" {
		token = ExtractKimiAccessToken(cred.APIKey)
	}
	if token == "" {
		return nil, errors.New("kimi-web: no usable access token in the credential")
	}
	return map[string]string{
		"Authorization":            "Bearer " + token,
		"Content-Type":             "application/connect+json",
		"Connect-Protocol-Version": "1",
		"Accept":                   "*/*",
		"Origin":                   "https://www.kimi.ai",
		"Referer":                  "https://www.kimi.ai/",
		"User-Agent":               kimiUserAgent,
		"x-language":               "en-US",
		"x-msh-platform":           "web",
	}, nil
}
