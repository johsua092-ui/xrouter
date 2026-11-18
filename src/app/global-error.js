"use client";

/**
 * Global error boundary (Next.js App Router). Replaces the built-in
 * global-error.js screen that users hit after every server rebuild:
 *
 * The browser caches the HTML from the previous deployment; when it lazily
 * loads a route chunk, the old /_next/static/chunks/<hash>.js no longer
 * exists on the server (each build reshuffles hashes), the fetch 404s, and
 * React surfaces ChunkLoadError as the default "This page couldn't load"
 * boundary. One reload fixes it — so do that automatically.
 *
 * Reload safety: a sessionStorage counter guards against a reload loop. If
 * the page keeps crashing after two self-reloads (a real bug, not a stale
 * chunk), the boundary renders its own minimal UI instead of reloading
 * forever — plain HTML/CSS only, no imports beyond react, because this file
 * renders even when the rest of the bundle failed to load.
 *
 * Scope: this file catches errors from the root layout and above. Route
 * segments may add their own error.js later; this one must stay dependency-
 * free to survive a fully broken bundle.
 */

import { useEffect } from "react";

const RELOAD_KEY = "xr:chunk-error-reloads";
const MAX_AUTO_RELOADS = 2;
// Window in which repeated reloads count toward the loop guard. After it
// passes the counter resets, so a user hitting a stale chunk twice a day is
// never blocked.
const RELOAD_WINDOW_MS = 10_000;

function isStaleChunkError(error) {
  if (!error) return false;
  const name = typeof error.name === "string" ? error.name : "";
  const msg = typeof error.message === "string" ? error.message : "";
  const digest = typeof error.digest === "string" ? error.digest : "";
  // Next.js marks asset-404 digests with this prefix.
  if (digest.includes("DYNAMIC_SERVER_USAGE") || digest.startsWith("NEXT_")) return false;
  return (
    name === "ChunkLoadError" ||
    /Loading chunk [\d]+ failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg) ||
    /Loading CSS chunk [\d]+ failed/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /error while loading route/i.test(msg) ||
    /dynamically imported module/i.test(msg)
  );
}

function shouldReload(error) {
  if (!isStaleChunkError(error)) return false;
  if (typeof window === "undefined") return false;
  try {
    const now = Date.now();
    const raw = window.sessionStorage.getItem(RELOAD_KEY);
    let entry = null;
    try {
      entry = raw ? JSON.parse(raw) : null;
    } catch {
      entry = null;
    }
    const count = entry && now - entry.ts < RELOAD_WINDOW_MS ? entry.count : 0;
    if (count >= MAX_AUTO_RELOADS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ count: count + 1, ts: now }));
    return true;
  } catch {
    // Storage unavailable (private mode): allow one blind reload — the common
    // stale-chunk case still self-heals, the loop guard just can't count.
    return true;
  }
}

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    if (shouldReload(error)) {
      // replace() keeps the broken URL out of history so Back skips it.
      window.location.replace(window.location.href);
    }
  }, [error]);

  const staleChunk = isStaleChunkError(error);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          background: "#0b0d10",
          color: "#e6e8eb",
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ maxWidth: 420, padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>
            {staleChunk ? "Update detected — reloading" : "Something went wrong"}
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: "#9aa0a6", margin: "0 0 20px" }}>
            {staleChunk
              ? "The server was updated and this tab holds an older version. A reload usually fixes it — if it keeps appearing, close the tab and open the dashboard again."
              : "An unexpected client-side error occurred. Reload the page; if it persists, check the server logs."}
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button
              onClick={() => window.location.replace(window.location.href)}
              style={{
                background: "#e6e8eb",
                color: "#0b0d10",
                border: 0,
                borderRadius: 8,
                padding: "8px 16px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
            {typeof reset === "function" && (
              <button
                onClick={() => reset()}
                style={{
                  background: "transparent",
                  color: "#e6e8eb",
                  border: "1px solid #2a2f36",
                  borderRadius: 8,
                  padding: "8px 16px",
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
