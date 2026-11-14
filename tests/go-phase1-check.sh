#!/usr/bin/env bash
# Uji binary Go: apakah gerbang Phase 1 hijau?
#   Phase 1 gate: go build hijau + /v1/models jalan
# Read-only terhadap produksi. Hanya menembak port 28080 (Go), bukan 20128.
set -u

GO="http://127.0.0.1:28080"

echo "=== [0] listener ==="
ss -ltnp 2>/dev/null | grep -E '28080|20128' | sed 's/^/  /'

echo ""
echo "=== [1] /api/health (Go) ==="
curl -s -m 5 -w "\n  HTTP %{http_code}  time %{time_total}s\n" "$GO/api/health"

echo ""
echo "=== [2] /v1/models (Go) — GERBANG PHASE 1 ==="
curl -s -m 8 -w "\n  HTTP %{http_code}\n" "$GO/v1/models" | head -c 900

echo ""
echo ""
echo "=== [3] /api/auth/status ==="
curl -s -m 5 "$GO/api/auth/status"

echo ""
echo ""
echo "=== [4] RSS proses Go ==="
PID=$(pgrep -f 'bin/xrouter' | head -1)
if [ -n "$PID" ]; then
  awk -v p="$PID" '
    /^VmRSS:/  {rss=$2}
    /^RssAnon:/{anon=$2}
    /^Threads:/{th=$2}
    END { printf "  PID %s  VmRSS %.1f MB  RssAnon %.1f MB  threads %s\n", p, rss/1024, anon/1024, th }
  ' "/proc/$PID/status"
else
  echo "  proses bin/xrouter tidak ketemu"
fi

echo ""
echo "=== [5] produksi (20128) masih normal? ==="
curl -s -m 5 -o /dev/null -w "  HTTP %{http_code}\n" http://127.0.0.1:20128/api/health
