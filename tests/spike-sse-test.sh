#!/usr/bin/env bash
# uji streaming SSE lewat spike (Go front) — bukan service produksi
set -u
K=$(python3 -c "
import sqlite3
c=sqlite3.connect('file:/root/xrouter-data/db/data.sqlite?mode=ro',uri=True)
print(c.execute('select key from apiKeys where isActive=1 order by usedTokens desc limit 1').fetchone()[0])
")

echo "=== [2] STREAMING SSE via spike ==="
curl -s -N -m 45 \
  -H "Authorization: Bearer $K" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","stream":true,"messages":[{"role":"user","content":"Count from 1 to 30, one number per line. No preamble."}],"max_tokens":200}' \
  -w "\n  [KLIEN] ttfb=%{time_starttransfer}s total=%{time_total}s size=%{size_download}B http=%{http_code}\n" \
  http://127.0.0.1:21099/v1/chat/completions -o /tmp/sse.txt

echo ""
echo "  --- potongan stream ---"
head -c 400 /tmp/sse.txt
echo ""
echo "  baris 'data:' : $(grep -c '^data:' /tmp/sse.txt)"
echo "  ada [DONE]    : $(grep -c '\[DONE\]' /tmp/sse.txt)"

echo ""
echo "=== [3] stats spike setelah request ==="
curl -s -m 5 http://127.0.0.1:21099/__spike/stats | python3 -m json.tool
