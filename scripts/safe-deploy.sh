#!/usr/bin/env bash
# Build into a throwaway dist dir, then swap it in and restart. `next build` writes
# into .next directly, so building while the server serves from .next hands it a
# half-written tree: the dashboard answered 500 with
#   InvariantError: The client reference manifest for route "/dashboard/console-log" does not exist
# for the whole build window (9 errors, logged 08:12-08:14, gone after the restart).
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE="${NEXT_DIST_DIR:-.next-new}"
echo "[safe-deploy] building into $STAGE"
rm -rf "$STAGE"
NEXT_DIST_DIR="$STAGE" npm run build

[ -f "$STAGE/BUILD_ID" ] || { echo "[safe-deploy] no BUILD_ID — build failed"; exit 1; }
# The standalone tree keeps its own copy of the dist dir, named after the staging dir
# (server.js carries distDir "./$STAGE_NAME"). After the swap it is still found, because
# the whole tree moves together — so check for it by pattern, not by the ".next" name.
[ -f "$STAGE/standalone/server.js" ] || { echo "[safe-deploy] standalone server.js missing"; exit 1; }
ls "$STAGE"/standalone/.next*/server/pages/500.html >/dev/null 2>&1 \
  || { echo "[safe-deploy] standalone tree incomplete (no 500.html)"; exit 1; }

STAMP="$(date +%Y%m%dT%H%M%S)"
PREV=".next-old-$STAMP"
[ -d .next ] && mv .next "$PREV"
mv "$STAGE" .next

systemctl restart xrouter
sleep 8
systemctl is-active --quiet xrouter || { echo "[safe-deploy] service did not come back"; exit 1; }

echo "[safe-deploy] live · previous build kept at $PREV"
echo "[safe-deploy] rollback: mv .next .next-bad && mv $PREV .next && systemctl restart xrouter"
