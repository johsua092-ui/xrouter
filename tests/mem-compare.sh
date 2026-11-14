#!/usr/bin/env bash
# Ukur RSS spike (Go) vs Node (produksi), idle. Read-only.
set -u

GO_PID=$(pgrep -f 'bin/spike --listen 127.0.0.1:21098' | head -1)
NODE_PID=$(pgrep -f 'next-server' | head -1)

echo "=== RINGKASAN MEMORI ==="
printf '%-14s %-10s %-10s %-10s %-8s\n' PROSES PID VmRSS RssAnon THREADS

for spec in "Go-spike:$GO_PID" "Node-prod:$NODE_PID"; do
  name="${spec%%:*}"; pid="${spec##*:}"
  [ -z "$pid" ] && continue
  awk -v n="$name" -v p="$pid" '
    /^VmRSS:/  {rss=$2}
    /^RssAnon:/{anon=$2}
    /^Threads:/{th=$2}
    END { printf "%-14s %-10s %-10.1fMB %-10.1fMB %-8s\n", n, p, rss/1024, anon/1024, th }
  ' "/proc/$pid/status"
done

echo ""
echo "=== BINARY ==="
ls -l /root/xrouter/bin/spike 2>/dev/null | awk '{printf "  spike (Go)     : %.1f MB\n", $5/1048576}'

echo ""
echo "=== DIREKTORI RUNTIME ==="
du -sh /root/xrouter/node_modules 2>/dev/null | awk '{print "  node_modules   : "$1}'
du -sh /root/xrouter/.next 2>/dev/null | awk '{print "  .next          : "$1}'
echo "  Go binary      : 1 file, no deps, no node_modules"
