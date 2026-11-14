package translate

import "sync"

// Registry holds request and response translators keyed by "from:to".
//
// Node keeps two separate maps and the same pair can be registered for one
// direction only — claude→openai registers a request function and a nil response
// function, because the response side is registered by the mirror module. Two
// maps here, not one, so a request-only registration cannot shadow a response
// translator that happens to share the key.
type Registry struct {
	mu       sync.RWMutex
	requests map[string]RequestFn
	response map[string]ResponseFn
}

// RequestFn converts a request body from one dialect to another.
//
// The Node signature is (model, body, stream, credentials). Credentials are
// carried as a map rather than a typed struct because translators reach into
// provider-specific fields, and one typed view would have to grow a field for
// every provider that does.
type RequestFn func(model string, body map[string]any, stream bool, creds map[string]any) (map[string]any, error)

// ResponseFn converts one response chunk (or a whole non-streaming body).
//
// It returns a slice because a single upstream chunk can fan out into several
// client chunks — a Kiro EventStream frame carrying both text and a tool call
// becomes two content_block_delta frames.
type ResponseFn func(chunk map[string]any, state *StreamState) ([]map[string]any, error)

// StreamState is the per-connection scratch space translators use to carry
// identity across chunks: the tool-name map for Claude cloaking, the index of the
// open content block, whether message_start has been emitted.
type StreamState struct {
	// ToolNameMap restores cloaked tool names on the way out.
	ToolNameMap map[string]string
	// ContentIndex is the index of the currently open Claude content block.
	ContentIndex int
	// MessageStarted tracks whether message_start has been sent.
	MessageStarted bool
	// Model is remembered because later Claude frames omit it.
	Model string
	// Scratps is free space for converter-local bookkeeping.
	Scratch map[string]any
}

// NewStreamState returns state with its maps allocated. Callers should use this
// rather than a zero literal: a translator that writes to Scratch before anyone
// reads it would panic on a nil map otherwise.
func NewStreamState() *StreamState {
	return &StreamState{
		ToolNameMap: map[string]string{},
		Scratch:     map[string]any{},
	}
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{
		requests: map[string]RequestFn{},
		response: map[string]ResponseFn{},
	}
}

// key builds the registry key. Both sides must format it identically or a
// registered pair becomes unreachable.
func key(from, to Format) string {
	return string(from) + ":" + string(to)
}

// RegisterRequest installs a request translator for from→to.
func (r *Registry) RegisterRequest(from, to Format, fn RequestFn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests[key(from, to)] = fn
}

// RegisterResponse installs a response translator for target→source.
func (r *Registry) RegisterResponse(from, to Format, fn ResponseFn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.response[key(from, to)] = fn
}

// RequestFor looks up a request translator.
func (r *Registry) RequestFor(from, to Format) (RequestFn, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	fn, ok := r.requests[key(from, to)]
	return fn, ok
}

// ResponseFor looks up a response translator.
func (r *Registry) ResponseFor(from, to Format) (ResponseFn, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	fn, ok := r.response[key(from, to)]
	return fn, ok
}

// RequestPairs lists the registered request pairs, sorted. Used by the coverage
// endpoint and by tests that pin the ported set.
func (r *Registry) RequestPairs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.requests))
	for k := range r.requests {
		out = append(out, k)
	}
	return sortedStrings(out)
}

// ResponsePairs lists the registered response pairs, sorted.
func (r *Registry) ResponsePairs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.response))
	for k := range r.response {
		out = append(out, k)
	}
	return sortedStrings(out)
}

// Default is the process-wide registry the translators register into at init,
// mirroring Node's module-load-time self-registration.
// Default is the process-wide registry the pipeline falls back to when a caller
// passes nil. The gateway passes its own so a test can inject a scoped set.
var Default = NewRegistry()

// RegisterDefaults populates a registry with every converter built into this
// package.
//
// Each converter also self-registers into Default from its own init(), so this
// exists for callers that want an isolated registry — a test that registers a
// probe converter must not mutate the process-wide set. The keys are copied as
// opaque "from:to" strings rather than split, so a future format name containing
// a colon cannot silently mis-parse here.
func RegisterDefaults(r *Registry) {
	if r == nil {
		return
	}
	Default.mu.RLock()
	reqs := make(map[string]RequestFn, len(Default.requests))
	for k, fn := range Default.requests {
		reqs[k] = fn
	}
	resps := make(map[string]ResponseFn, len(Default.response))
	for k, fn := range Default.response {
		resps[k] = fn
	}
	Default.mu.RUnlock()

	r.mu.Lock()
	defer r.mu.Unlock()
	for k, fn := range reqs {
		r.requests[k] = fn
	}
	for k, fn := range resps {
		r.response[k] = fn
	}
}

// Register is the package-level convenience the translator files use from their
// init functions.
func Register(from, to Format, req RequestFn, resp ResponseFn) {
	if req != nil {
		Default.RegisterRequest(from, to, req)
	}
	if resp != nil {
		Default.RegisterResponse(from, to, resp)
	}
}
