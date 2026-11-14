package providers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// DeepSeek Web — port of open-sse/executors/deepseek-web.js.
//
// The browser chat endpoint, driven with a pasted session cookie. Two things make
// it more than a URL adapter:
//
//  1. A proof of work is required. The caller is handed a challenge, the solver
//     searches for a nonce whose digest equals it, and the nonce is replayed. The
//     digest is DeepSeekHashV1 (see deepseekpow.go).
//  2. The reply arrives as a JSON-patch stream — `{p, o, v}` frames that add and
//     replace entries in a server-side response object — not as token deltas. The
//     assistant text has to be reassembled from the patches before it can be
//     forwarded as a normal stream.
//
// The DSML tool-call affordance is deliberately NOT enabled: the web endpoint
// emits its own `<|DSML|...>` envelope, and the file that parses it is the same
// code that synthesises it. Feeding the cloud tool contract through that envelope
// is how a tool call becomes a stray tag in the assistant's reply.
const (
	deepSeekWebChatURL   = "https://chat.deepseek.com/api/v0/chat/completion"
	deepSeekWebCreateURL = "https://chat.deepseek.com/api/v0/chat_session/create"
	deepSeekWebPowURL    = "https://chat.deepseek.com/api/v0/chat/create_pow_challenge"
	deepSeekWebUA        = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
	deepSeekWebPowDifficulty = 200000
)

// deepSeekWebSession is the cookie-derived credential.
type deepSeekWebSession struct {
	cookies   string
	userAgent string
}

// deepSeekWebPatch is one JSON-patch frame from the completion stream.
//
// The endpoint sends these as `data: {"p":"...","o":"...","v":...}`. `p` is the
// path, `v` is the value. Most frames carry narrative status; the ones that matter
// are `response/fragments`, which carry appended text.
type deepSeekWebPatch struct {
	Path  string          `json:"p"`
	Op    string          `json:"o"`
	Value json.RawMessage `json:"v"`
}

// extractDeepSeekWebSession pulls the cookie from whatever the dashboard stored.
//
// Accepted: a raw cookie header, a `Cookie:` prefixed header (the form a DevTools
// "copy as cURL" produces), or a JSON blob holding a `cookie` field. Anything else
// is passed through as the cookie value so an unusual-but-valid header still works.
func extractDeepSeekWebSession(raw string) *deepSeekWebSession {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil
	}

	if strings.HasPrefix(value, "{") {
		var obj map[string]any
		if err := json.Unmarshal([]byte(value), &obj); err == nil {
			for _, key := range []string{"cookie", "cookies", "cookieHeader"} {
				if s, ok := obj[key].(string); ok && strings.TrimSpace(s) != "" {
					value = strings.TrimSpace(s)
					break
				}
			}
		}
	}

	// Strip a leading `Cookie:` / `cookie:` label and any newlines a paste may carry.
	if idx := strings.Index(strings.ToLower(value), "cookie:"); idx == 0 {
		value = strings.TrimSpace(value[len("cookie:"):])
	}
	value = strings.ReplaceAll(value, "\r", "")
	value = strings.ReplaceAll(value, "\n", " ")

	if !strings.Contains(value, "=") {
		return nil
	}

	// A token is not a cookie: sending a bare bearer value in the Cookie header
	// yields an auth error that looks like an expired session.
	if strings.HasPrefix(strings.ToLower(value), "bearer ") {
		return nil
	}

	return &deepSeekWebSession{cookies: value, userAgent: deepSeekWebUA}
}

// solveDeepSeekWebPow fetches a challenge and searches for its nonce.
func solveDeepSeekWebPow(client *http.Client, session *deepSeekWebSession) (string, error) {
	body := strings.NewReader(`{"target_path":"/api/v0/chat/completion"}`)
	req, err := http.NewRequest(http.MethodPost, deepSeekWebPowURL, body)
	if err != nil {
		return "", err
	}
	applyDeepSeekWebHeaders(req, session)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("deepseek pow challenge: HTTP %d: %s", resp.StatusCode, truncateForError(string(raw), 300))
	}

	var parsed struct {
		Data struct {
			Challenge  string `json:"challenge"`
			Salt       string `json:"salt"`
			Difficulty int    `json:"difficulty"`
			Algorithm  string `json:"algorithm"`
			ExpireAt   int64  `json:"expire_at"`
			Signature  string `json:"signature"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("deepseek pow challenge: decode: %w", err)
	}

	challenge := parsed.Data.Challenge
	salt := parsed.Data.Salt
	if challenge == "" {
		return "", fmt.Errorf("deepseek pow challenge: empty challenge")
	}

	// The prefix is salt + "_" + expireAt + "_", the layout the endpoint issues.
	prefix := salt + "_" + strconv.FormatInt(parsed.Data.ExpireAt, 10) + "_"

	difficulty := parsed.Data.Difficulty
	if difficulty <= 0 || difficulty > MaxDeepSeekPowDifficulty {
		difficulty = deepSeekWebPowDifficulty
	}

	nonce, err := FindDeepSeekPowNonce(prefix, challenge, difficulty)
	if err != nil {
		return "", err
	}
	if nonce < 0 {
		return "", fmt.Errorf("deepseek pow: no nonce found within difficulty %d", difficulty)
	}

	answer := map[string]any{
		"algorithm":   firstNonEmpty(parsed.Data.Algorithm, "DeepSeekHashV1"),
		"challenge":   challenge,
		"salt":        salt,
		"answer":      nonce,
		"signature":   parsed.Data.Signature,
		"target_path": "/api/v0/chat/completion",
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		return "", err
	}
	return base64Std(encoded), nil
}

// applyDeepSeekWebHeaders sets the browser-shaped header set the endpoint expects.
func applyDeepSeekWebHeaders(req *http.Request, session *deepSeekWebSession) {
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Origin", "https://chat.deepseek.com")
	req.Header.Set("Referer", "https://chat.deepseek.com/")
	req.Header.Set("User-Agent", session.userAgent)
	req.Header.Set("sec-ch-ua", `"Chromium";v="131", "Not_A Brand";v="24"`)
	req.Header.Set("sec-ch-ua-mobile", "?0")
	req.Header.Set("sec-ch-ua-platform", `"Windows"`)
	req.Header.Set("Cookie", session.cookies)
}

// createDeepSeekWebSession makes a chat session. The completion call is scoped to
// it, so it cannot be skipped.
func createDeepSeekWebSession(client *http.Client, session *deepSeekWebSession) (string, error) {
	body := strings.NewReader(`{"character_id":null}`)
	req, err := http.NewRequest(http.MethodPost, deepSeekWebCreateURL, body)
	if err != nil {
		return "", err
	}
	applyDeepSeekWebHeaders(req, session)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("deepseek session create: HTTP %d: %s", resp.StatusCode, truncateForError(string(raw), 300))
	}

	var parsed struct {
		Data struct {
			BizData struct {
				ID string `json:"id"`
			} `json:"biz_data"`
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("deepseek session create: decode: %w", err)
	}
	id := firstNonEmpty(parsed.Data.BizData.ID, parsed.Data.ID)
	if id == "" {
		return "", fmt.Errorf("deepseek session create: no session id in response")
	}
	return id, nil
}

// deepSeekWebFragment is one piece of assistant output inside a patch value.
type deepSeekWebFragment struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// deepSeekWebDSMLFilter removes `<|DSML|...>` envelopes from a stream.
//
// The endpoint emits tool-call envelopes inline. When the caller did not ask for
// tools there is nothing to execute them against, and forwarding the raw tags
// leaks a syntax the client never requested. The filter buffers across chunk
// boundaries because a tag can be split mid-write.
type deepSeekWebDSMLFilter struct {
	buffer    strings.Builder
	inDSML    bool
	closeHint string
}

// push returns the safe prefix of the stream, and buffers any partial tag.
func (f *deepSeekWebDSMLFilter) push(chunk string) string {
	if chunk == "" {
		return ""
	}
	f.buffer.WriteString(chunk)
	return f.drain()
}

// flush returns whatever remains, tag-free, at end of stream.
func (f *deepSeekWebDSMLFilter) flush() string {
	if f.inDSML {
		f.buffer.Reset()
		f.inDSML = false
		return ""
	}
	out := f.buffer.String()
	f.buffer.Reset()
	return out
}

func (f *deepSeekWebDSMLFilter) drain() string {
	var out strings.Builder
	for {
		text := f.buffer.String()
		if text == "" {
			return out.String()
		}

		if !f.inDSML {
			open := indexDeepSeekDSMLOpen(text)
			if open < 0 {
				// Hold back a possible partial opener at the tail.
				if keep := deepSeekDSMLPartialTail(text); keep > 0 {
					out.WriteString(text[:len(text)-keep])
					f.buffer.Reset()
					f.buffer.WriteString(text[len(text)-keep:])
					return out.String()
				}
				out.WriteString(text)
				f.buffer.Reset()
				return out.String()
			}
			out.WriteString(text[:open])
			f.inDSML = true
			f.closeHint = text[open:]
			f.buffer.Reset()
			f.buffer.WriteString(text[open:])
			continue
		}

		// Inside an envelope: drop everything up to and including the close tag.
		close := indexDeepSeekDSMLClose(f.buffer.String(), f.closeHint)
		if close < 0 {
			return out.String()
		}
		rest := f.buffer.String()[close:]
		f.buffer.Reset()
		f.buffer.WriteString(rest)
		f.inDSML = false
		f.closeHint = ""
	}
}

// indexDeepSeekDSMLOpen finds the next envelope opener, or -1.
func indexDeepSeekDSMLOpen(text string) int {
	lower := strings.ToLower(text)
	best := -1
	for _, marker := range []string{"<|dsml|", "<｜dsml｜", "<||dsml||"} {
		if i := strings.Index(lower, marker); i >= 0 && (best < 0 || i < best) {
			best = i
		}
	}
	return best
}

// indexDeepSeekDSMLClose finds the end (exclusive) of the current envelope, or -1.
//
// The close tag is `<|/DSML|...>` or, for the `calls` form, `<|/DSML| calls>`.
func indexDeepSeekDSMLClose(text, hint string) int {
	lower := strings.ToLower(text)
	for _, marker := range []string{"<|/dsml|", "<｜/dsml｜", "<||/dsml||"} {
		if i := strings.Index(lower, marker); i >= 0 {
			if j := strings.Index(lower[i:], ">"); j >= 0 {
				return i + j + 1
			}
			return -1
		}
	}
	return -1
}

// deepSeekDSMLPartialTail reports how many trailing bytes might be the start of an
// opener, capped so ordinary text ending in `<` is not held indefinitely.
func deepSeekDSMLPartialTail(text string) int {
	for n := len(text); n > 0 && len(text)-n < 16; n-- {
		tail := strings.ToLower(text[n-1:])
		if strings.HasPrefix("<|dsml|", tail) || strings.HasPrefix("<｜dsml｜", tail) {
			return len(text) - n + 1
		}
	}
	if strings.HasSuffix(text, "<") || strings.HasSuffix(text, "<|") {
		return 1
	}
	return 0
}

func truncateForError(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// DeepSeekWeb is the adapter.
type DeepSeekWeb struct{}

// NewDeepSeekWeb builds the adapter.
func NewDeepSeekWeb() *DeepSeekWeb { return &DeepSeekWeb{} }

func (a *DeepSeekWeb) Name() string       { return "deepseek-web" }
func (a *DeepSeekWeb) WireFormat() string { return FormatOpenAI }

// Endpoint is the browser chat completion path.
func (a *DeepSeekWeb) Endpoint(req Request, cred Credential) (string, error) {
	return deepSeekWebChatURL, nil
}

// Headers sets the browser-shaped header set the endpoint expects.
func (a *DeepSeekWeb) Headers(req Request, cred Credential) (map[string]string, error) {
	raw := cred.Cookie
	if raw == "" {
		raw = cred.APIKey
	}
	session := extractDeepSeekWebSession(raw)
	if session == nil {
		return nil, errors.New("deepseek-web: credential is not a usable session cookie")
	}
	return map[string]string{
		"Accept":             "*/*",
		"Accept-Language":    "en-US,en;q=0.9",
		"Content-Type":       "application/json",
		"Origin":             "https://chat.deepseek.com",
		"Referer":            "https://chat.deepseek.com/",
		"User-Agent":         session.userAgent,
		"sec-ch-ua":          `"Chromium";v="131", "Not_A Brand";v="24"`,
		"sec-ch-ua-mobile":   "?0",
		"sec-ch-ua-platform": `"Windows"`,
		"Cookie":             session.cookies,
	}, nil
}
