#!/usr/bin/env python3
"""
Option B load spike — 200 concurrent streams through the Go front, measuring
RSS of BOTH processes (Go front + Node upstream) against a direct-to-Node run.

Read-only against the service: it only issues /v1/models GETs, which is a cheap
but realistic load (each response is ~360 KB of JSON, so it exercises the
streaming copy path and the socket fan-out without burning provider quota).

Usage:
    python3 tests/spike-load.py --target http://127.0.0.1:21099 --conc 200 --label go-front
    python3 tests/spike-load.py --target http://127.0.0.1:20128 --conc 200 --label node-direct
"""
import argparse
import json
import os
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
import urllib.request

DB = "/root/xrouter-data/db/data.sqlite"


def api_key():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    return c.execute(
        "select key from apiKeys where isActive=1 order by usedTokens desc limit 1"
    ).fetchone()[0]


def rss_mb(pid):
    """Resident set size in MB, or None if the process is gone."""
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except FileNotFoundError:
        return None
    return None


def find_pid(pattern):
    out = subprocess.run(
        ["pgrep", "-f", pattern], capture_output=True, text=True
    ).stdout.split()
    return int(out[0]) if out else None


def sampler(pids, stop, samples):
    """Poll RSS of every tracked PID until stop is set."""
    while not stop.is_set():
        snap = {name: rss_mb(pid) for name, pid in pids.items() if pid}
        samples.append(snap)
        time.sleep(0.15)


def worker(url, key, results, idx, barrier):
    barrier.wait()  # release everything at once: that is the point of the test
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
        results[idx] = (time.time() - t0, len(body), r.status, None)
    except Exception as e:  # noqa: BLE001
        results[idx] = (time.time() - t0, 0, 0, str(e)[:120])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True)
    ap.add_argument("--conc", type=int, default=200)
    ap.add_argument("--label", default="run")
    ap.add_argument("--path", default="/v1/models")
    args = ap.parse_args()

    key = api_key()
    url = args.target.rstrip("/") + args.path

    go_pid = find_pid(r"bin/spike --listen")
    node_pid = find_pid(r"next-server")
    pids = {}
    if go_pid:
        pids["go_front"] = go_pid
    if node_pid:
        pids["node_upstream"] = node_pid

    print(f"=== RUN: {args.label} ===")
    print(f"  target        : {url}")
    print(f"  concurrency   : {args.conc}")
    print(f"  tracked pids  : {pids}")

    # baseline before any load
    base = {n: rss_mb(p) for n, p in pids.items()}
    print(f"  baseline RSS  : " + ", ".join(f"{n}={v:.1f}MB" for n, v in base.items() if v))

    results = [None] * args.conc
    barrier = threading.Barrier(args.conc)
    threads = [
        threading.Thread(target=worker, args=(url, key, results, i, barrier))
        for i in range(args.conc)
    ]

    stop = threading.Event()
    samples = []
    samp = threading.Thread(target=sampler, args=(pids, stop, samples), daemon=True)
    samp.start()

    t0 = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.time() - t0
    stop.set()
    time.sleep(0.2)

    lat = [r[0] for r in results if r and r[3] is None]
    errs = [r for r in results if r and r[3] is not None]
    sizes = [r[1] for r in results if r and r[3] is None]

    peak = {}
    for name in pids:
        vals = [s.get(name) for s in samples if s.get(name)]
        peak[name] = max(vals) if vals else None

    print("")
    print(f"  wall clock    : {wall:.2f}s")
    print(f"  ok / err      : {len(lat)} / {len(errs)}")
    if lat:
        print(f"  latency p50   : {statistics.median(lat)*1000:.0f} ms")
        print(f"  latency p95   : {sorted(lat)[int(len(lat)*0.95)-1]*1000:.0f} ms")
        print(f"  latency max   : {max(lat)*1000:.0f} ms")
        print(f"  bytes total   : {sum(sizes)/1024/1024:.1f} MB")
    if errs:
        print("  sample errors :")
        for e in errs[:3]:
            print(f"    - {e[3]}")
    print("")
    for name in pids:
        b, pk = base.get(name), peak.get(name)
        if b and pk:
            print(f"  {name:14s} baseline {b:7.1f} MB -> peak {pk:7.1f} MB  (delta {pk-b:+.1f})")
    print(f"  TOTAL tracked peak RSS : {sum(v for v in peak.values() if v):.1f} MB")

    out = {
        "label": args.label,
        "target": url,
        "conc": args.conc,
        "wall_s": round(wall, 3),
        "ok": len(lat),
        "err": len(errs),
        "lat_p50_ms": round(statistics.median(lat) * 1000) if lat else None,
        "lat_p95_ms": round(sorted(lat)[int(len(lat) * 0.95) - 1] * 1000) if lat else None,
        "lat_max_ms": round(max(lat) * 1000) if lat else None,
        "baseline_mb": {k: round(v, 1) for k, v in base.items() if v},
        "peak_mb": {k: round(v, 1) for k, v in peak.items() if v},
        "total_peak_mb": round(sum(v for v in peak.values() if v), 1),
    }
    path = "/root/xrouter/tests/spike-results.json"
    existing = []
    if os.path.exists(path):
        try:
            existing = json.load(open(path))
        except Exception:  # noqa: BLE001
            existing = []
    existing.append(out)
    json.dump(existing, open(path, "w"), indent=2)
    print(f"  saved         : {path}")


if __name__ == "__main__":
    sys.exit(main())
