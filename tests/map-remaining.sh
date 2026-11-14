#!/usr/bin/env bash
# Cari executor yg BELUM ada padanannya di registry Go, + peta translator.
set -u
cd /root/xrouter

echo "=== daftar file executor Node ==="
ls open-sse/executors/*.js | xargs -n1 basename | sed 's/\.js$//' | sort > /tmp/node_exec.txt
wc -l < /tmp/node_exec.txt | sed 's/^/  total: /'

echo ""
echo "=== provider Go yg udah ada padanannya ==="
grep -rhoE '"[a-z0-9-]+"' internal/providers/wave2.go internal/providers/wave3.go internal/providers/openai_compat.go 2>/dev/null \
  | tr -d '"' | sort -u > /tmp/go_prov.txt
wc -l < /tmp/go_prov.txt | sed 's/^/  kandidat: /'

echo ""
echo "=== translator: struktur direktori ==="
ls -d open-sse/translator/*/ 2>/dev/null
echo ""
echo "=== translator: baris per file (top 25) ==="
find open-sse/translator -name '*.js' -exec wc -l {} + | sort -rn | head -26
