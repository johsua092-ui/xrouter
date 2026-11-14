# Option B — Hybrid Go Front / Node Backend (Testing Branch)

**Status:** testing branch — not merged, not pushed, not wired to the running service
**Branched from:** `main` @ `88535f1`
**Sibling branch:** `go-migration` (holds Option A, the full Go rewrite scaffold)
**Created:** 2026-11-14

---

## The idea

Option A ports 40+ provider adapters into Go before anything can ship. That is a long
road. Option B gets most of the memory win with a fraction of the work:

Put **Go in front** as the long-lived listener. Go holds the connections — one
goroutine is about 2 KB of stack, so thousands of concurrent SSE streams cost almost
nothing — and does the cheap work: accepting connections, auth, rate limiting, header
rewriting, caching. The expensive per-provider translation logic is **proxied** to the
Node process, which keeps doing what it already does correctly.

```
                 Option A                        Option B (this branch)
        ┌───────────────────────┐       ┌───────────────────────────────┐
client ─┤ Go: everything, 25MB  │       client ─┤ Go listener :20128      │
        └───────────────────────┘       │  auth · rate limit · cache    │
                                        │  SSE fan-out (goroutines)     │
        Node runtime deleted.           └──────────┬────────────────────┘
        ~~~~~~~~~                                  │ proxy /v1/* provider work
                                                   ▼
                                        ┌───────────────────────────────┐
                                        │ Node worker (hidden port)     │
                                        │ 40+ adapters, unchanged       │
                                        └───────────────────────────────┘
```

Both processes stay alive. Go is the front door, Node is the tradesman in the back.

---

## Where the win actually comes from

The Node runtime cannot be removed in Option B, so the ceiling is lower than Option A.
The saving comes from what Go **takes off** Node's plate:

| Load | Now (Node only) | Option B |
| :--- | :--- | :--- |
| Idle sockets / health checks | thousands of JS objects each, GC-tracked | goroutines, ~2 KB stack each |
| Auth + rate limit per request | JS middleware, allocation per request | Go handler, near-zero alloc |
| Cache lookup | JS object graph, GC pressure | `sync.Map` / LRU, atomic |
| Provider translation | Node (unchanged) | Node (unchanged) |
| Dashboard | Node serves it | **still Node** — deleted the separate port |

Option B does **not** hit 15–30 MB, because Node is still resident. It does flatten
the *ramp* under concurrency, which is the part that actually hurts in production.

---

## Honest expectation

- Idle: **higher** than now (two runtimes instead of one). If Node sits at ~137 MB
  and Go adds ~12 MB, idle lands around ~150 MB.
- Under load: **much flatter**. Option A wins outright on idle; Option B wins on
  concurrency cost per connection.

If the goal is the number "25 MB", Option A is the only route. If the goal is "stop
the RAM climbing when 200 streams are open", Option B gets there cheaply.

---

## Rules for this branch

1. **Do not delete the Node path.** This branch depends on it.
2. **Never bind the production port** (20128) while testing — use a scratch port.
3. **No secret in any commit.** Audit staged diffs before committing.
4. **Do not push or merge.** Sandbox for review before any decision.
5. **Measure both runtimes** — report Go RSS *and* Node RSS together, never one alone.

---

## First spike (when picked up)

1. Stand up the Go listener on a scratch port with a `/v1/*` passthrough proxy to the
   existing Node service.
2. Run 200 concurrent streams against it and record RSS of both processes.
3. Compare with 200 streams hitting Node directly.
4. Report the two memory curves side by side. Decide from data, not from theory.
