#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
if [[ "$TARGET_DIR" != /* ]]; then
  TARGET_DIR="$ROOT/$TARGET_DIR"
fi
BUILT="$TARGET_DIR/wasm32-unknown-unknown/release/signature_kit_wasm.wasm"
ENGINE="$ROOT/packages/engine"
OUT_DIR="$ENGINE/dist/wasm"
OUT="$OUT_DIR/signature-kit.wasm"

if [[ -x "$ENGINE/node_modules/binaryen/bin/wasm-opt" ]]; then
  WASM_OPT="$ENGINE/node_modules/binaryen/bin/wasm-opt"
elif command -v wasm-opt >/dev/null 2>&1; then
  WASM_OPT="$(command -v wasm-opt)"
else
  echo "wasm-opt not found; install the binaryen devDependency" >&2
  exit 1
fi

CARGO_TARGET_DIR="$TARGET_DIR" CARGO_PROFILE_RELEASE_OPT_LEVEL=s cargo build --locked --release --target wasm32-unknown-unknown --package signature-kit-wasm
mkdir -p "$OUT_DIR"
"$WASM_OPT" -O3 \
  --enable-bulk-memory \
  --enable-sign-ext \
  --enable-nontrapping-float-to-int \
  --enable-mutable-globals \
  --enable-multivalue \
  --enable-reference-types \
  --strip-debug \
  --strip-producers \
  --converge \
  "$BUILT" \
  -o "$OUT"
