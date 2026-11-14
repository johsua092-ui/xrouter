// Command spike is the Option B measurement harness.
//
// It stands up the Go front listener on a scratch port and proxies everything to
// the already-running Node gateway. It is a test rig: it binds 127.0.0.1 only,
// defaults to port 21099 (never 20128), and holds no secrets of its own — it
// forwards whatever Authorization header the client supplies.
//
// Usage:
//
//	spike --listen 127.0.0.1:21099 --upstream http://127.0.0.1:20128
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/johsua092-ui/xrouter/internal/hybrid"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:21099", "scratch port to bind (never the production port)")
	upstream := flag.String("upstream", "http://127.0.0.1:20128", "Node gateway to proxy to")
	pidFile := flag.String("pidfile", "", "optional file to write the PID to")
	flag.Parse()

	// refuse to clobber the production port, by mistake or by typo
	if _, port, err := net.SplitHostPort(*listen); err == nil && port == "20128" {
		log.Fatalf("[spike FATAL] refusing to bind the production port 20128 — use a scratch port")
	}

	proxy, err := hybrid.New(*upstream)
	if err != nil {
		log.Fatalf("[spike FATAL] %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", proxy)
	mux.HandleFunc("/__spike/stats", func(w http.ResponseWriter, r *http.Request) {
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)

		snap := proxy.StatsSnapshot()
		snap["rss_note"] = "goroutine/heap view; read process RSS from ps for the true number"
		snap["heap_alloc_mb"] = float64(ms.Alloc) / (1024 * 1024)
		snap["heap_sys_mb"] = float64(ms.Sys) / (1024 * 1024)
		snap["goroutines"] = runtime.NumGoroutine()
		snap["num_gc"] = ms.NumGC
		snap["uptime_s"] = time.Since(start).Seconds()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(snap)
	})

	srv := &http.Server{
		Addr:    *listen,
		Handler: mux,
		// streaming: never let the server time out a long-lived SSE response
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}

	if *pidFile != "" {
		if err := os.WriteFile(*pidFile, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o644); err != nil {
			log.Printf("[spike] pidfile note: %v", err)
		}
	}

	log.Printf("[spike] Go front listening on http://%s -> %s", *listen, *upstream)
	log.Printf("[spike] pid %d  goroutines-baseline %d", os.Getpid(), runtime.NumGoroutine())

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[spike FATAL] listen failed: %v", err)
		}
	}()

	<-quit
	log.Println("[spike] shutting down")
	_ = srv.Close()
}

var start = time.Now()
