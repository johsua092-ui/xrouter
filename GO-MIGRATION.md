# Go Migration Branch

**Status:** testing branch — not merged, not released, not connected to the running dashboard
**Branched from:** `main` @ `88535f1` (Next.js 16.4.2 / React 19.2.4, version 0.1.0)
**Created:** 2026-11-14

This branch is a sandbox for moving the X Router backend from the Node.js runtime to
a Go core. Nothing on this branch is production. The Node build stays the default
until the Go core reaches parity.

---

## Why this branch exists

The Node runtime holds 130–150 MB RSS on this box and climbs under concurrent SSE
streaming. The Go core target is a single self-contained binary with a 15–30 MB
footprint that serves both the API gateway (`/v1/*`) and the embedded dashboard.

Read `docs/ROADMAP_GO_MIGRATION.md` for the full four-phase plan and the risk table.

---

## What is already on this branch

The Go skeleton was written earlier and lives in the tree:

```
cmd/xrouter/main.go            entrypoint
internal/config/               config loading
internal/gateway/server.go     HTTP server
internal/sse/proxy.go          streaming proxy
internal/database/db.go        SQLite (modernc.org/sqlite, CGO-free)
internal/bypass/               vault + kernel
internal/connection/bot.go     bot connection
internal/httpx/ipv6dial.go     IPv6 dialer
Dockerfile.go                  container build
go.mod                         Go 1.26.0
```

Total: 10 Go files, 1397 lines. The module builds, but no Go binary has ever been
built on this box and no provider adapter has been ported yet.

Directory layout still differs from the roadmap target. The roadmap wants:

```
internal/providers/    40+ provider adapters          <- does not exist yet
internal/cache/        cache-aware affinity + RAM cache <- does not exist yet
internal/vouchers/     bansos anti-abuse engine        <- does not exist yet
internal/embed.go      //go:embed the dashboard        <- does not exist yet
```

---

## How to work on this branch

```bash
make go-verify      # build + vet + test, reports binary size
make go-size        # just the binary size number
make go-run         # run the Go binary locally (does not touch port 20128)
```

None of these touch the Node service. `go-run` uses the Go binary's own port so the
running dashboard is left alone.

---

## Rules for this branch

1. **Do not touch anything outside the Go path.** The Node app is working. Edits here
   are limited to `cmd/`, `internal/`, `go.mod`, `Makefile`, `Dockerfile.go`, and the
   migration docs. Editing `src/`, `open-sse/`, or `next.config.mjs` on this branch is
   out of scope.
2. **Never bind the production port.** Port 20128 belongs to the running service.
3. **Measure, do not claim.** The 25 MB figure is a target. Only record a size that
   came out of `make go-size` on this box.
4. **No secret in any commit.** Audit staged diffs before committing.
5. **Do not push or merge.** This branch is a sandbox for review before any decision.
6. **Keep the SQLite schema identical.** Table names and columns must match the Node
   schema so an existing database opens without migration.
