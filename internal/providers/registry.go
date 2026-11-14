// Package providers holds the Go ports of the Node executor adapters.
//
// The Node engine has 37 executor files under open-sse/executors/. Option A's job
// is to bring the request path for those providers into Go. This package starts
// with the shape every one of them shares and ports the OpenAI-compatible
// majority (default.js), which is what the bulk of the active connections in the
// live database actually route through.
//
// Design rule taken from the roadmap risk table: adapters must be *config-driven*
// and modular. Upstream protocols drift, so changing a provider means editing a
// descriptor, not rewriting the engine. Every adapter here is a small struct
// implementing one interface, registered by name, resolved at request time.
package providers

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Credential is what a request needs to authenticate upstream. Ported from the
// shape the Node side builds out of `providerConnections.data` plus the decrypted
// vault entry.
type Credential struct {
	APIKey      string
	AccessToken string
	Cookie      string
	// BaseURL is the per-connection override (providerSpecificData.baseUrl in the
	// Node engine). Empty means "use the adapter's default".
	BaseURL string
	// Extra carries provider-specific fields an adapter may need (accountId for
	// the {accountId} URL template, projectId for vertex, and so on).
	Extra map[string]string
	// RawHeaders are headers the client already sent that must survive the hop
	// (anthropic-beta flows through here in the Node engine).
	RawHeaders map[string]string
}

// Request is the normalised input to an adapter.
type Request struct {
	Provider string
	Model    string
	Stream   bool
	// Body is the client payload, already translated into the provider's wire
	// format by the caller. Adapters only place it on the wire, they never
	// reshape it — same division of labour as Node's executor vs translator.
	Body []byte
}

// Response hands the adapter's upstream response back to the gateway, which is
// responsible for streaming it downstream.
type Response struct {
	StatusCode int
	Header     http.Header
	Body       io.ReadCloser
}

// Adapter is the contract every provider port implements. One method, no
// lifecycle: the gateway owns the shared HTTP client so connection pooling is
// global rather than per-provider.
type Adapter interface {
	// Name is the registry key, matching the Node provider id.
	Name() string
	// Endpoint builds the absolute upstream URL for this request.
	Endpoint(req Request, cred Credential) (string, error)
	// Headers builds the upstream header set, auth included.
	Headers(req Request, cred Credential) (map[string]string, error)
}

// Transport performs the HTTP call. Shared by every adapter so there is exactly
// one place where timeouts, proxying and SSE-streaming behaviour are defined.
type Transport struct {
	client *http.Client
}

// NewTransport builds the shared transport. No client-level timeout: streaming
// responses must be allowed to run as long as the model takes.
func NewTransport(client *http.Client) *Transport {
	if client == nil {
		client = &http.Client{Transport: DefaultHTTPTransport()}
	}
	return &Transport{client: client}
}

// DefaultHTTPTransport is the pool every adapter shares. Sized for concurrent SSE
// fan-out: a high idle cap per host means a burst of streams reuses sockets
// instead of opening new ones, and DisableCompression keeps Go from touching an
// event-stream body.
func DefaultHTTPTransport() *http.Transport {
	return &http.Transport{
		MaxIdleConns:          512,
		MaxIdleConnsPerHost:   256,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DisableCompression:    true,
		ForceAttemptHTTP2:     true,
	}
}

// Do executes the adapter's request. Returns a Response whose Body is the caller's
// responsibility to close (which the streaming path does via defer).
func (t *Transport) Do(ctx context.Context, a Adapter, req Request, cred Credential) (*Response, error) {
	endpoint, err := a.Endpoint(req, cred)
	if err != nil {
		return nil, fmt.Errorf("%s: endpoint: %w", a.Name(), err)
	}
	headers, err := a.Headers(req, cred)
	if err != nil {
		return nil, fmt.Errorf("%s: headers: %w", a.Name(), err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(req.Body)))
	if err != nil {
		return nil, fmt.Errorf("%s: build request: %w", a.Name(), err)
	}
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	resp, err := t.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("%s: upstream: %w", a.Name(), err)
	}

	return &Response{
		StatusCode: resp.StatusCode,
		Header:     resp.Header,
		Body:       resp.Body,
	}, nil
}

// Registry resolves a provider name to its adapter.
type Registry struct {
	mu       sync.RWMutex
	adapters map[string]Adapter
	fallback Adapter
}

// NewRegistry returns an empty registry whose unknown-provider behaviour is the
// OpenAI-compatible default, mirroring how Node falls back to default.js.
func NewRegistry() *Registry {
	return &Registry{adapters: make(map[string]Adapter)}
}

// SetFallback installs the adapter used when a provider has no explicit port yet.
func (r *Registry) SetFallback(a Adapter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fallback = a
}

// Register adds or replaces an adapter under its own name.
func (r *Registry) Register(a Adapter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.adapters[a.Name()] = a
}

// Resolve returns the adapter for provider, or the fallback.
func (r *Registry) Resolve(provider string) (Adapter, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if a, ok := r.adapters[provider]; ok {
		return a, true
	}
	if r.fallback != nil {
		return r.fallback, false
	}
	return nil, false
}

// Names lists the explicitly registered providers, sorted. Used by the coverage
// endpoint so the ported-provider count is observable rather than assumed.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.adapters))
	for n := range r.adapters {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Count reports how many providers are explicitly ported (fallback excluded).
func (r *Registry) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.adapters)
}
