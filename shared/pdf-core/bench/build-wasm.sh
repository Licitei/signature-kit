#!/usr/bin/env bash
# Build the release wasm module and shrink it with a pinned Binaryen wasm-opt.
# Invoked from the Nx build-wasm target. Keeps the cargo artifact path portable
# when CARGO_TARGET_DIR is set on the host.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/rust/Cargo.toml"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/rust/target}"
BUILT="$TARGET_DIR/wasm32-unknown-unknown/release/signature_kit_pdf_core.wasm"
OUT_DIR="$ROOT/dist"
OUT="$OUT_DIR/pdf-core.wasm"

# Prefer the package-local binaryen pin, then PATH.
if [[ -x "$ROOT/node_modules/binaryen/bin/wasm-opt" ]]; then
  WASM_OPT="$ROOT/node_modules/binaryen/bin/wasm-opt"
elif command -v wasm-opt >/dev/null 2>&1; then
  WASM_OPT="$(command -v wasm-opt)"
else
  echo "wasm-opt not found; install the binaryen devDependency" >&2
  exit 1
fi

cargo build --release --target wasm32-unknown-unknown --manifest-path "$MANIFEST"
mkdir -p "$OUT_DIR"
# Feature flags match rustc's wasm32-unknown-unknown defaults (Node ≥20 and
# current Chromium/Firefox/Safari). --all-features can emit forms Bun rejects.
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
