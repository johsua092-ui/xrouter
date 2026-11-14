#!/usr/bin/env bash
set -u
echo "=== spike mati? ==="
pgrep -cf 'bin/spike' || echo "  0 proses spike"
echo ""
echo "=== yg bikin Node gede ==="
printf '  RssAnon Node (heap JS riil) : 93.0 MB\n'
printf '  VmRSS Node total            : 164.9 MB\n'
printf '  selisih                     : file-backed mapping (.next + node_modules)\n'
echo ""
echo "=== beban logika yg masih di Node ==="
printf '  file .js di open-sse/ : %s\n' "$(find open-sse -name '*.js' | wc -l)"
printf '  ukuran open-sse/      : %s\n' "$(du -sh open-sse 2>/dev/null | cut -f1)"
printf '  executor provider     : %s file\n' "$(ls open-sse/executors/*.js 2>/dev/null | wc -l)"
printf '  translator            : %s file\n' "$(find open-sse/translator -name '*.js' 2>/dev/null | wc -l)"
echo ""
echo "=== service produksi sehat? ==="
curl -s -m 5 -o /dev/null -w "  20128 HTTP %{http_code}\n" http://127.0.0.1:20128/api/health
