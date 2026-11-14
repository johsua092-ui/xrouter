#!/usr/bin/env bash
# Peta 37 executor Node: baris, endpoint, auth, header khusus.
set -u
cd /root/xrouter
echo "=== ukuran tiap executor ==="
wc -l open-sse/executors/*.js | sort -rn | head -40
echo ""
echo "=== base url / endpoint yg di-hardcode ==="
grep -rhoE 'https://[a-zA-Z0-9._/-]+' open-sse/executors/*.js | sort | uniq -c | sort -rn | head -30
