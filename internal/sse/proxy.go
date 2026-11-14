package sse

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

var sseBufferPool = sync.Pool{
	New: func() interface{} {
		b := make([]byte, 16*1024)
		return &b
	},
}

var defaultTransport = &http.Transport{
	MaxIdleConns:        100,
	MaxIdleConnsPerHost: 20,
	IdleConnTimeout:     90 * time.Second,
	DisableCompression:  false,
}

var streamingClient = &http.Client{
	Transport: defaultTransport,
	Timeout:   0, // No timeout for streaming connections
}

/**
 * StreamProxy forwards a streaming SSE request from upstream to downstream client,
 * monitoring client disconnection via context.
 */
func StreamProxy(ctx context.Context, w http.ResponseWriter, upstreamReq *http.Request) error {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return fmt.Errorf("response writer does not support streaming/flushing")
	}

	upstreamReq = upstreamReq.WithContext(ctx)
	resp, err := streamingClient.Do(upstreamReq)
	if err != nil {
		return fmt.Errorf("upstream request failed: %w", err)
	}
	defer resp.Body.Close()

	// Copy upstream headers to downstream
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(resp.StatusCode)
	flusher.Flush()

	reader := bufio.NewReaderSize(resp.Body, 16*1024)
	bufPtr := sseBufferPool.Get().(*[]byte)
	defer sseBufferPool.Put(bufPtr)
	buf := *bufPtr

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		n, err := reader.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			flusher.Flush()
		}

		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}
