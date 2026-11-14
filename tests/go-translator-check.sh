#!/usr/bin/env bash
# Uji translator di jalur request nyata.
#
# Yang dibuktikan di sini: body Claude dikonversi ke dialek provider SEBELUM ke
# upstream. Buktinya bukan "ada file translator", tapi: request Claude ke provider
# yg dialeknya beda menghasilkan respons yg BERBEDA dari request yg sama tanpa
# translator — yaitu error skema dari upstream, bukan error kita.
set -u
GO="http://127.0.0.1:28080"

echo "=== [1] request Claude ke qoder (upstream: Messages dialect) ==="
echo "-- body Claude native, /v1/messages --"
curl -s -m 15 -X POST "$GO/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qoder/qwen3-coder","max_tokens":64,"system":[{"type":"text","text":"be terse"}],"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}' \
  | head -c 700
echo ""

echo ""
echo "=== [2] request yg SAMA tapi provider dialeknya cocok (antigravity=gemini) ==="
curl -s -m 15 -X POST "$GO/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"antigravity/gemini-3.8-flash-high","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}' \
  | head -c 500
echo ""

echo ""
echo "=== [3] provider tak dikenal: harus gagal dgn diagnostik jelas, bukan sukses palsu ==="
curl -s -m 10 -X POST "$GO/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"provider-palsu/model-x","messages":[{"role":"user","content":"hi"}]}' \
  | head -c 400
echo ""

echo ""
echo "=== [4] model tanpa bentuk provider/model ==="
curl -s -m 10 -X POST "$GO/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}' \
  | head -c 300
echo ""

echo ""
echo "=== [5] coverage provider ==="
curl -s -m 10 "$GO/api/system/adapters" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ported:',d['ported_count'],'| generic:',d['generic_count'],'| node total:',d['node_executor_total'])"
