package gateway

import (
	"io/fs"
	"net/http"
	"strings"

	"github.com/johsua092-ui/xrouter/internal/xrouterembeds"
)

// mountDashboard serves the embedded dashboard, if one was built into the binary.
//
// Two routes are registered, in this order and for distinct reasons:
//
//   - `/assets/*` serves files straight out of the embedded tree.
//   - `/*` is the last route on the mux, so it only runs when nothing else
//     matched. It serves a real file when the path names one, and index.html
//     otherwise — a client-side router needs the fallback, because `/dashboard`
//     is a route a human types and not a file that exists on disk.
//
// When no dashboard was embedded this returns without registering anything, so a
// gateway-only binary answers unknown paths with the router's own 404 instead of a
// placeholder page.
func (g *Gateway) mountDashboard() {
	assets, ok := xrouterembeds.FS()
	if !ok {
		return
	}

	fileServer := http.FileServer(http.FS(assets))

	g.mux.Handle("/assets/*", http.StripPrefix("/assets/", fileServer))

	// Catch-all. Registered with Handle rather than Get so a POST to an unknown
	// path does not fall through to a bare 404 from the router when the client
	// actually wanted a page; the dashboard answers with index.html and the
	// client-side router reports the mismatch.
	g.mux.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			serveDashboardFile(w, r, assets, "index.html")
			return
		}

		// A path naming a real embedded file is served as-is. A path that does
		// not exist is a client-side route, so index.html is served and the
		// router takes over.
		if f, err := assets.Open(path); err == nil {
			f.Close()
			serveDashboardFile(w, r, assets, path)
			return
		}
		serveDashboardFile(w, r, assets, "index.html")
	}))
}

// serveDashboardFile writes one embedded file, falling back to a plain 404 when
// even the fallback is absent.
//
// http.ServeFile-like semantics are reproduced with http.ServeContent so that a
// conditional request is answered with 304 instead of re-sending the body.
func serveDashboardFile(w http.ResponseWriter, r *http.Request, assets fs.FS, name string) {
	f, err := assets.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}

	seeker, ok := f.(interface {
		Read([]byte) (int, error)
		Seek(int64, int) (int64, error)
	})
	if !ok {
		http.NotFound(w, r)
		return
	}

	// An untyped Content-Type makes a browser guess, and it guesses wrong for a
	// JS bundle served as text/plain. Let the name decide, then ServeContent
	// keeps that value for its own sniffing.
	if ct := contentTypeForName(name); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeContent(w, r, name, info.ModTime(), seeker)
}

// contentTypeForName maps the extensions a dashboard build emits. Returned empty
// for anything else, which lets http.ServeContent sniff from the bytes.
func contentTypeForName(name string) string {
	switch {
	case strings.HasSuffix(name, ".html"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(name, ".js"), strings.HasSuffix(name, ".mjs"):
		return "text/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(name, ".json"), strings.HasSuffix(name, ".map"):
		return "application/json"
	case strings.HasSuffix(name, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(name, ".woff2"):
		return "font/woff2"
	case strings.HasSuffix(name, ".woff"):
		return "font/woff"
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".webp"):
		return "image/webp"
	case strings.HasSuffix(name, ".ico"):
		return "image/x-icon"
	case strings.HasSuffix(name, ".txt"):
		return "text/plain; charset=utf-8"
	}
	return ""
}
