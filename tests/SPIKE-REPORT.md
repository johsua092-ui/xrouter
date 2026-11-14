# Spike Report — Go Front / Node Backend (Option B), Run 1

**Date:** 2026-11-14
**Branch:** `go-hybrid-proxy`
**Rig:** `cmd/spike` + `internal/hybrid` — Go reverse proxy on scratch port `21099`,
upstream `http://127.0.0.1:20128` (the live Node gateway)
**Production touched:** no. Port 20128 never bound; Node process never restarted;
no config, no DB write, no systemd change.

---

## What was built

| File | Purpose |
| :--- | :--- |
| `internal/hybrid/proxy.go` | Streaming reverse proxy. Strips hop-by-hop headers, copies the body in 32 KB chunks from a pooled buffer, `Flush()` after every write so SSE deltas leave immediately. Atomic counters for live connections / bytes / failures. |
| `cmd/spike/main.go` | The rig. Binds `127.0.0.1:21099`, exposes `/__spike/stats`. **Hard-refuses to bind port 20128** — typo protection. |
| `tests/spike-sse-test.sh` | SSE correctness check (chunk count, `[DONE]` terminator, TTFB). |
| `tests/spike-load.py` | 200-thread barrier-released load test, samples RSS of *both* processes every 150 ms. |
| `tests/spike-results.json` | Raw numbers from both runs. |

Binary: `bin/spike` — **11 MB**.

---

## Correctness — streaming survives the extra hop

Single SSE request for 30 enumerated tokens through the Go front:

```
HTTP 200
data: lines     : 92
[DONE] present  : yes
client TTFB     : 4.58 s   <- model's own think time, not proxy latency
client total    : 5.71 s
bytes           : 26,598
X-Spike-Ttfb-Ms : 8        <- proxy-to-upstream header time: 8 ms
```

The `X-Spike-Ttfb-Ms: 8` header is the number that matters. The Go hop adds
**8 ms** to first byte; the remaining 4.5 s is the upstream model thinking. Proxy
overhead is noise.

Passthrough fidelity: `/v1/models` returns **708 models** through the Go front,
identical to direct — headers, content type, status all preserved.

---

## Load — 200 concurrent streams

Both runs: 200 requests, 200 OK, **0 errors**, 64.1 MB transferred, identical payload.

| Metric | Go front (`:21099`) | Node direct (`:20128`) |
| :--- | ---: | ---: |
| Wall clock | 1.53 s | 1.31 s |
| Latency p50 | 989 ms | 656 ms |
| Latency p95 | 1443 ms | 1213 ms |
| Node RSS baseline → peak | 169.2 → **200.4 MB** | 200.9 → 200.9 MB |
| Go front RSS | 5.4 → **5.4 MB** | — |
| **Total tracked peak** | **205.9 MB** | **206.3 MB** |

### Go front, under 200 concurrent connections

```
RSS                : 5.4 MB  ->  5.4 MB     (delta 0.0)
heap_alloc peak    : 6.71 MB
goroutines peak    : 405     ->  405 idle   (no leak)
num_gc             : 2
failed             : 0 / 202
```

**The headline.** 202 requests, 405 goroutines, 64 MB copied through, and the Go
front's RSS did not move. It sat at 5.4 MB from baseline to peak, and returned to
5.4 MB after the load. Two GC cycles total. Streams are copied through a pooled
32 KB buffer with zero persistent allocation per connection.

### Why the total is roughly a wash on this test

Total tracked peak: **205.9 MB (with Go) vs 206.3 MB (Node direct)** — statistically
identical. This is the honest result, and it is not a disappointment, it is the
mechanism:

The proxy does not remove work from Node, it adds a hop. Node still parses all 200
requests and serializes all 64 MB of JSON. So Node's own peak is unchanged (~200 MB
either way), and the Go front adds 5.4 MB on top. For a **CPU-bound JSON endpoint
that Node handles fine, the extra hop costs, it does not save.**

Option B's win does not live in this test. It lives in what the test does not
measure: **idle connection holding.** This test holds 200 *active* connections for
1.3 seconds. The production problem is holding thousands of *idle* SSE streams open
for minutes — one JS object graph per socket, GC-tracked, versus a goroutine at
~2 KB of stack that does not need collecting.

---

## What the numbers say

**Confirmed:**
- Streaming is byte-transparent through the extra hop. SSE framing, `[DONE]`,
  headers — all intact. 8 ms added to first byte.
- Go front memory is flat: 5.4 MB peak holding 200 concurrent connections, zero
  growth, no goroutine leak (405 → 405).
- Nol port baru di produksi, nol restart, nol error di kedua run.

**Not confirmed (and not claimed):**
- Idle-connection savings. Not measured here — this rig tests throughput, not
  long-lived idle sockets. Needs a second spike that opens N streams and *holds
  them* while sampling both RSS curves.
- Latency parity. p50 is 989 ms vs 656 ms — the extra hop costs ~333 ms at p50
  under 200-way concurrency on this box. Whether that is acceptable is a product
  decision, not a technical one.

**Landed on:** Option B is a viable **front-door** pattern — the Go layer holds
connections cheaply and forwards faithfully. It is **not** a way to shrink the
running footprint, because Node stays resident and stays just as large. Anyone
expecting the 25 MB number from this branch is looking at the wrong option;
Option A is the only route to that number.

---

## Next spike (if this branch is picked up)

1. Hold 2000 idle SSE streams open through the Go front, sample RSS of both
   processes for 5 minutes, compare with 2000 held directly on Node.
2. Re-run the throughput test with the Go front also doing auth + rate-limit,
   to see whether moving that work off Node actually moves Node's number.
3. Only then decide: does the flatter idle curve justify the extra process?

Rules from `OPTION-B-HYBRID.md` all held: Node path untouched, production port
never bound, no secrets committed, no push, both runtimes measured together.
