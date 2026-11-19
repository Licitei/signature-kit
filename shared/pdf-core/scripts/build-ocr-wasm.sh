#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/rust/Cargo.toml"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/rust/target}"
BUILT="$TARGET_DIR/wasm32-unknown-unknown/release/signature_kit_pdf_core_ocr.wasm"
OUT_DIR="$ROOT/dist"
OUT="$OUT_DIR/pdf-core-ocr.wasm"

if [[ -x "$ROOT/node_modules/binaryen/bin/wasm-opt" ]]; then
  WASM_OPT="$ROOT/node_modules/binaryen/bin/wasm-opt"
elif command -v wasm-opt >/dev/null 2>&1; then
  WASM_OPT="$(command -v wasm-opt)"
else
  echo "wasm-opt not found; install the binaryen devDependency" >&2
  exit 1
fi

cargo build --release --target wasm32-unknown-unknown --manifest-path "$MANIFEST" -p signature-kit-pdf-core-ocr --lib
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
