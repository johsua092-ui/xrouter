// Package hybrid implements the Option B experiment: a Go front listener that
// reverse-proxies to the existing Node gateway.
//
// The point of the spike is to measure, not to ship. Nothing here is wired to
// the running service, the production port, or any systemd unit. The listener
// binds a scratch port and forwards upstream to the Node process unchanged.
//
// What it does:
//   - accepts the connection (goroutine, ~2 KB stack)
//   - strips hop-by-hop headers
//   - streams the response back in 16 KB chunks with an explicit Flush after each,
//     so SSE deltas reach the client without waiting for the upstream to close
//   - counts bytes in/out and live connections for the report
//
// What it deliberately does NOT do yet: auth, rate limiting, caching. Those are
// the later phases of the Option B plan and adding them now would muddy the
// measurement.
package hybrid

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// hop-by-hop headers must not be forwarded (RFC 7230 section 6.1). Forwarding
// "connection: keep-alive" to the downstream writer makes curl hang on SSE.
var hopHeaders = map[string]bool{
	"Connection":          true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
}

// Stats is the live telemetry the spike reports on. Atomic counters so the
// /__spike/stats endpoint can read them without locking the hot path.
type Stats struct {
	Live       int64
	Total      int64
	BytesOut   int64
	BytesIn    int64
	Completed  int64
	Failed     int64
	ActiveRecs int64
}

// Proxy is a streaming reverse proxy to one upstream origin.
type Proxy struct {
	scheme  string
	host    string
	client  *http.Client
	stats   Stats
	bufPool sync.Pool
}

// New builds a proxy aimed at upstreamBase, e.g. "http://127.0.0.1:20128".
func New(upstreamBase string) (*Proxy, error) {
	scheme, host, err := splitBase(upstreamBase)
	if err != nil {
		return nil, err
	}

	transport := &http.Transport{
		Proxy: nil, // never route through an env proxy; this is loopback
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          512,
		MaxIdleConnsPerHost:   512,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DisableCompression:    true, // never let Go re-encode an SSE stream
		ForceAttemptHTTP2:     false,
	}

	p := &Proxy{
		scheme: scheme,
		host:   host,
		client: &http.Client{
			Transport: transport,
			Timeout:   0, // streaming: no client-level timeout
		},
		bufPool: sync.Pool{
			New: func() interface{} {
				b := make([]byte, 32*1024)
				return &b
			},
		},
	}
	return p, nil
}

func splitBase(base string) (string, string, error) {
	base = strings.TrimSpace(base)
	if !strings.Contains(base, "://") {
		return "", "", fmt.Errorf("upstream must include scheme: %q", base)
	}
	parts := strings.SplitN(base, "://", 2)
	scheme, rest := parts[0], parts[1]
	rest = strings.TrimSuffix(rest, "/")
	if scheme != "http" && scheme != "https" {
		return "", "", fmt.Errorf("unsupported scheme %q", scheme)
	}
	if rest == "" {
		return "", "", fmt.Errorf("upstream host is empty")
	}
	return scheme, rest, nil
}

// ServeHTTP forwards r upstream and streams the body back.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	atomic.AddInt64(&p.stats.Live, 1)
	atomic.AddInt64(&p.stats.Total, 1)
	defer atomic.AddInt64(&p.stats.Live, -1)

	target := p.scheme + "://" + p.host + r.URL.RequestURI()

	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
	if err != nil {
		atomic.AddInt64(&p.stats.Failed, 1)
		http.Error(w, "bad upstream request: "+err.Error(), http.StatusBadGateway)
		return
	}
	outReq.ContentLength = r.ContentLength

	// copy request headers, minus hop-by-hop
	for k, vv := range r.Header {
		if hopHeaders[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range vv {
			outReq.Header.Add(k, v)
		}
	}
	// identify as the spike so it shows up distinctly in Node access logs
	outReq.Header.Set("X-Spike-Front", "go-hybrid-proxy")

	t0 := time.Now()
	resp, err := p.client.Do(outReq)
	if err != nil {
		atomic.AddInt64(&p.stats.Failed, 1)
		http.Error(w, "upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// copy response headers, minus hop-by-hop
	for k, vv := range resp.Header {
		if hopHeaders[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}

	// streaming hygiene: no buffering anywhere in the chain
	w.Header().Set("X-Accel-Buffering", "no")
	if isStream(resp) {
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
	}

	flusher, _ := w.(http.Flusher)

	// advertise streaming status so the test client can confirm the path
	w.Header().Set("X-Spike-Upstream", p.host)
	w.Header().Set("X-Spike-Ttfb-Ms", strconv.FormatInt(time.Since(t0).Milliseconds(), 10))

	w.WriteHeader(resp.StatusCode)
	if flusher != nil {
		flusher.Flush() // send headers immediately, before the first body byte
	}

	bufPtr := p.bufPool.Get().(*[]byte)
	defer p.bufPool.Put(bufPtr)
	buf := *bufPtr

	for {
		select {
		case <-r.Context().Done():
			atomic.AddInt64(&p.stats.Failed, 1)
			return
		default:
		}

		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, wErr := w.Write(buf[:n]); wErr != nil {
				atomic.AddInt64(&p.stats.BytesOut, int64(n))
				atomic.AddInt64(&p.stats.Failed, 1)
				return
			}
			atomic.AddInt64(&p.stats.BytesOut, int64(n))
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				atomic.AddInt64(&p.stats.Completed, 1)
			} else {
				atomic.AddInt64(&p.stats.Failed, 1)
			}
			return
		}
	}
}

func isStream(resp *http.Response) bool {
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(ct, "text/event-stream")
}

// StatsSnapshot reads the counters for /__spike/stats.
func (p *Proxy) StatsSnapshot() map[string]interface{} {
	return map[string]interface{}{
		"live_conns":     atomic.LoadInt64(&p.stats.Live),
		"total_requests": atomic.LoadInt64(&p.stats.Total),
		"completed":      atomic.LoadInt64(&p.stats.Completed),
		"failed":         atomic.LoadInt64(&p.stats.Failed),
		"bytes_out":      atomic.LoadInt64(&p.stats.BytesOut),
		"upstream":       p.scheme + "://" + p.host,
		"engine":         "go-hybrid-proxy",
	}
}
