#!/usr/bin/env bash
set -u
cd /root/xrouter
echo "=== verif remote go-migration ==="
git ls-remote origin refs/heads/go-migration
echo "  lokal: $(git rev-parse HEAD)"
echo ""
echo "=== main & stable TIDAK tersentuh ==="
echo "  main   lokal $(git rev-parse --short main)  remote $(git ls-remote origin refs/heads/main | cut -c1-7)"
echo "  stable lokal $(git rev-parse --short stable-pre-nextjs16)  remote $(git ls-remote origin refs/heads/stable-pre-nextjs16 | cut -c1-7)"
echo ""
echo "=== bersihin proses uji ==="
pkill -f 'bin/xrouter' 2>/dev/null
sleep 1
echo "  proses Go    : $(pgrep -cf 'bin/xrouter' || echo 0)"
echo "  listener 28080: $(ss -ltn 2>/dev/null | grep -c 28080)"
echo "  produksi 20128: $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:20128/api/health)"
