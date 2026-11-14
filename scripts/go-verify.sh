#!/usr/bin/env bash
# go-verify.sh — desktop-level sanity check for the Go migration branch.
#
# Builds, vets, tests and reports the real binary size. Reads only; never starts the
# service, never binds port 20128, never writes outside bin/.
#
# Usage:  bash scripts/go-verify.sh

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

GO_BIN="${GO:-go}"
OUT_DIR="bin"
BINARY="${OUT_DIR}/xrouter"
FAIL=0

hr() { printf '  %s\n' "------------------------------------------------------------"; }

printf '\n== Go migration verify ==\n'
hr

# --- toolchain ---------------------------------------------------------------
if ! command -v "$GO_BIN" >/dev/null 2>&1; then
  printf '  [fail] go toolchain not found (looked for: %s)\n' "$GO_BIN"
  exit 1
fi
printf '  go:    %s\n' "$("$GO_BIN" version)"
printf '  tree:  %s\n' "$(pwd)"
hr

# --- build -------------------------------------------------------------------
mkdir -p "$OUT_DIR"
printf '  build ... '
if BUILD_LOG=$("$GO_BIN" build -trimpath -ldflags="-s -w" -o "$BINARY" ./cmd/xrouter 2>&1); then
  printf 'ok\n'
else
  printf 'FAILED\n'
  printf '%s\n' "$BUILD_LOG" | sed 's/^/    /'
  FAIL=1
fi
hr

# --- vet ---------------------------------------------------------------------
printf '  vet ... '
if VET_LOG=$("$GO_BIN" vet ./cmd/... ./internal/... 2>&1); then
  printf 'ok\n'
else
  printf 'FAILED\n'
  printf '%s\n' "$VET_LOG" | sed 's/^/    /'
  FAIL=1
fi
hr

# --- test --------------------------------------------------------------------
printf '  test ...\n'
if TEST_LOG=$("$GO_BIN" test ./cmd/... ./internal/... 2>&1); then
  printf '%s\n' "$TEST_LOG" | sed 's/^/    /'
else
  printf '    FAILED\n'
  printf '%s\n' "$TEST_LOG" | sed 's/^/    /'
  FAIL=1
fi
hr

# --- artifact size (the number that matters) ---------------------------------
if [ -f "$BINARY" ]; then
  BYTES=$(wc -c <"$BINARY" | tr -d ' ')
  MB=$(awk -v b="$BYTES" 'BEGIN { printf "%.2f", b/1048576 }')
  printf '  binary : %s\n' "$BINARY"
  printf '  size   : %s MB (%s bytes)\n' "$MB" "$BYTES"
  printf '  target : 25 MB  -> %s\n' \
    "$(awk -v m="$MB" 'BEGIN { print (m<=25 ? "within target" : "OVER target") }')"
else
  printf '  binary : not produced\n'
  FAIL=1
fi
hr

# --- inventory ---------------------------------------------------------------
FILES=$(find cmd internal -name '*.go' 2>/dev/null | wc -l | tr -d ' ')
LINES=$(find cmd internal -name '*.go' -exec cat {} + 2>/dev/null | wc -l | tr -d ' ')
printf '  go files: %s\n' "$FILES"
printf '  go lines: %s\n' "$LINES"
printf '  port 20128: %s\n' "$(ss -ltn 2>/dev/null | grep -q ':20128' && echo 'running (untouched by this script)' || echo 'not listening')"
hr

if [ "$FAIL" -eq 0 ]; then
  printf '  RESULT: PASS\n\n'
else
  printf '  RESULT: FAIL\n\n'
fi
exit "$FAIL"
