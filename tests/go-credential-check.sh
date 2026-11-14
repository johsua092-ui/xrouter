#!/usr/bin/env bash
# Uji jalur kredensial nyata: GrokCli adapter baca koneksi dari DB produksi.
# Ini menjawab: apakah kredensial terbaca, atau terkunci vault?
set -u
GO="http://127.0.0.1:28080"

echo "=== kirim request nyata ke grok-cli lewat adapter Go ==="
curl -s -m 20 -w "\n  HTTP %{http_code}\n" -X POST "$GO/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"grok-cli/grok-build","stream":false,"input":[{"role":"user","type":"message","content":"say OK"}]}'

echo ""
echo "=== jalur kredensial: apakah terbaca atau terkunci? ==="
python3 - <<'PY'
import sqlite3, json
c=sqlite3.connect('file:/root/xrouter-data/db/data.sqlite?mode=ro',uri=True)
r=c.execute("select id, provider, authType, data from providerConnections where provider='grok-cli' and isActive=1 order by priority asc limit 1").fetchone()
d=json.loads(r[3])
at=d.get('accessToken','')
api=d.get('apiKey','')
print(f"  id            : {r[0][:20]}...")
print(f"  authType      : {r[2]}")
print(f"  accessToken   : {'enc:v1 (TERKUNCI VAULT)' if at.startswith('enc:v1:') else 'plaintext' if at else 'kosong'}")
print(f"  apiKey        : {'enc:v1 (TERKUNCI VAULT)' if str(api).startswith('enc:v1:') else 'plaintext' if api else 'kosong'}")
PY

echo ""
echo "=== berapa koneksi aktif yg plaintext vs terkunci (semua provider) ==="
python3 - <<'PY'
import sqlite3, json
c=sqlite3.connect('file:/root/xrouter-data/db/data.sqlite?mode=ro',uri=True)
plain=lock=none=0
rows=c.execute("select data from providerConnections where isActive=1").fetchall()
for (raw,) in rows:
    try: d=json.loads(raw) if raw else {}
    except Exception: d={}
    vals=[d.get('accessToken',''),d.get('apiKey','')]
    vals=[v for v in vals if v]
    if not vals: none+=1
    elif any(str(v).startswith('enc:v1:') for v in vals): lock+=1
    else: plain+=1
print(f"  plaintext : {plain}")
print(f"  terkunci  : {lock}")
print(f"  kosong    : {none}")
print(f"  total     : {plain+lock+none}")
PY
