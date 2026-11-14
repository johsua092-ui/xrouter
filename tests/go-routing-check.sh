#!/usr/bin/env bash
# Uji routing Go dengan DB produksi (read-only). Port 28080, produksi tak disentuh.
set -u
GO="http://127.0.0.1:28080"

echo "=== [a] coverage adapter ==="
curl -s -m 8 "$GO/api/system/adapters" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  ported   :',d['ported_count'])
print('  generic  :',d['generic_count'])
print('  total    :',d['node_executor_total'])
print('  fallback :',d['fallback'])
print('  list     :',', '.join(d['ported']))
"

echo ""
echo "=== [b] model tanpa provider/ (harus 400, bukan sukses palsu) ==="
curl -s -m 8 -w "\n  HTTP %{http_code}\n" -X POST "$GO/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"grok-build","messages":[{"role":"user","content":"hi"}]}'

echo ""
echo "=== [c] provider ada tapi koneksi belum terbaca (harus 503 jelas) ==="
curl -s -m 8 -w "\n  HTTP %{http_code}\n" -X POST "$GO/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"nonexistent-provider/whatever","messages":[{"role":"user","content":"hi"}]}'

echo ""
echo "=== [d] grok-cli punya koneksi aktif? (cek DB langsung) ==="
python3 -c "
import sqlite3,json
c=sqlite3.connect('file:/root/xrouter-data/db/data.sqlite?mode=ro',uri=True)
for p in ['grok-cli','qoder','antigravity','ovh','github']:
    n=c.execute('select count(*) from providerConnections where provider=? and isActive=1',(p,)).fetchone()[0]
    print(f'  {p:14s} {n} koneksi aktif')
"

echo ""
echo "=== [e] RSS Go ==="
P=$(pgrep -f 'bin/xrouter' | head -1)
awk -v p="$P" '/^VmRSS:/{r=$2} /^RssAnon:/{a=$2} /^Threads:/{t=$2} END{printf "  PID %s  VmRSS %.1f MB  RssAnon %.1f MB  threads %s\n", p, r/1024, a/1024, t}' /proc/$P/status

echo ""
echo "=== [f] produksi 20128 ==="
curl -s -m 5 -o /dev/null -w "  HTTP %{http_code}\n" http://127.0.0.1:20128/api/health
