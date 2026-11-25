#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/pdf-core.wasm"

cd "$ROOT"
BINARYEN_MANIFEST="$(readlink -f node_modules/binaryen/package.json 2>/dev/null || true)"
KEY="$(
  {
    find rust/src rust/data -type f
    printf '%s\n' rust/Cargo.toml rust/Cargo.lock rust/build.rs rust/rust-toolchain.toml scripts/build-wasm.sh
  } | LC_ALL=C sort | xargs sha256sum | {
    cat
    if [[ -n "$BINARYEN_MANIFEST" ]]; then sha256sum "$BINARYEN_MANIFEST" | cut -d' ' -f1; fi
  } | sha256sum | cut -d' ' -f1
)"

if [[ "${1:-}" == "--key" ]]; then
  echo "$KEY"
  exit 0
fi

CACHE_DIR="${PDF_CORE_WASM_CACHE:-}"
if [[ -n "$CACHE_DIR" && -f "$CACHE_DIR/$KEY.wasm" ]]; then
  mkdir -p "$(dirname "$OUT")"
  cp "$CACHE_DIR/$KEY.wasm" "$OUT"
  echo "pdf-core.wasm restored from cache $KEY"
  exit 0
fi

bash "$ROOT/scripts/build-wasm.sh"

if [[ -n "$CACHE_DIR" ]]; then
  mkdir -p "$CACHE_DIR"
  find "$CACHE_DIR" -type f -name '*.wasm' -delete
  cp "$OUT" "$CACHE_DIR/$KEY.wasm"
fi
