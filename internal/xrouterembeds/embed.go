// Package xrouterembeds exposes the dashboard assets baked into the binary.
//
// This is the `internal/embed.go` the migration roadmap asks for. The contract is
// deliberately narrow: this package EMBEDS whatever dashboard build output exists
// at compile time and hands back a filesystem. It does not build the dashboard and
// it does not decide what to do when assets are missing — both belong to the
// caller, so a binary with no assets still compiles and still serves the API.
package xrouterembeds

import (
	"embed"
	"io/fs"
	"strings"
)

// The dashboard build tree.
//
// `all:` is required: without it the go tool skips files whose names begin with
// `_` or `.` — and a Next.js export emits exactly those (`_next/`), so a plain
// //go:embed would silently produce a dashboard missing its JS bundle.
//
// The pattern is a directory glob rather than a fixed file list so a rebuilt
// dashboard is picked up by recompiling, with no code change here.

//go:embed all:dashboard_dist
var dashboardFS embed.FS

// DashboardRoot is the embedded directory holding the build output.
const DashboardRoot = "dashboard_dist"

// FS returns the embedded dashboard filesystem, rooted so that a request path is
// resolved relative to the dashboard root.
//
// The second return is false when nothing was embedded — which is the normal
// state on a tree that has not produced a dashboard build. Callers must treat
// that as "serve the API only", not as an error: a Go binary with no dashboard is
// a valid, useful artifact, and failing to start over missing static files would
// break every test and CI run that only cares about the gateway.
func FS() (fs.FS, bool) {
	sub, err := fs.Sub(dashboardFS, DashboardRoot)
	if err != nil {
		return nil, false
	}
	// A placeholder-only tree means the dashboard was never built. Reporting that
	// as "present" would make the server route every unknown path into it and
	// return a placeholder page instead of a 404.
	entries, err := fs.ReadDir(sub, ".")
	if err != nil || len(entries) == 0 {
		return nil, false
	}
	if len(entries) == 1 && entries[0].Name() == PlaceholderFile {
		return nil, false
	}
	return sub, true
}

// PlaceholderFile keeps the embed pattern valid on a tree where the dashboard has
// not been built, so this package always compiles.
const PlaceholderFile = "PLACEHOLDER"

// IsAssetPath reports whether a request path should be served from the embedded
// dashboard rather than treated as an API route.
//
// The API owns the prefixes below. Everything else that is not an API path is a
// dashboard route — a client-side router handles the ones that do not correspond
// to a real file, so serving index.html for them is correct rather than a 404.
func IsAssetPath(path string) bool {
	if path == "" || path == "/" {
		return true
	}
	for _, prefix := range reservedPrefixes {
		if strings.HasPrefix(path, prefix) {
			return false
		}
	}
	return true
}

// reservedPrefixes are API and protocol surfaces that must never be answered from
// the static tree. Listing them here (rather than testing for a file extension)
// keeps an API route without a dot — `/v1/models` — from being swallowed by the
// dashboard fallback.
var reservedPrefixes = []string{
	"/v1/",
	"/api/",
	"/health",
	"/metrics",
	"/ws",
	"/socket",
	"/static/",
}
