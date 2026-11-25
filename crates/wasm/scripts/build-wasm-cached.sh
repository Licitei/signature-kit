#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT_DIR="$ROOT/packages/engine/dist/wasm"
OUT="$OUT_DIR/signature-kit.wasm"
COMPOSE="$OUT_DIR/compose.wasm"

cd "$ROOT"
BINARYEN_MANIFEST="$(readlink -f packages/engine/node_modules/binaryen/package.json 2>/dev/null || true)"
KEY="$(
  {
    find crates/wasm/src crates/pdf/src crates/pdf/data crates/font crates/compose -type f
    printf '%s\n' Cargo.toml Cargo.lock rust-toolchain.toml crates/pdf/Cargo.toml crates/pdf/build.rs crates/wasm/Cargo.toml crates/wasm/scripts/build-wasm.sh crates/wasm/scripts/build-wasm-cached.sh
  } | LC_ALL=C sort | xargs sha256sum | {
    cat
    if [[ -n "$BINARYEN_MANIFEST" ]]; then sha256sum "$BINARYEN_MANIFEST" | cut -d' ' -f1; fi
  } | sha256sum | cut -d' ' -f1
)"

if [[ "${1:-}" == "--key" ]]; then
  echo "$KEY"
  exit 0
fi

CACHE_DIR="${SIGNATURE_KIT_WASM_CACHE:-}"
if [[ -n "$CACHE_DIR" && -f "$CACHE_DIR/$KEY.wasm" && -f "$CACHE_DIR/$KEY-compose.wasm" ]]; then
  mkdir -p "$(dirname "$OUT")"
  cp "$CACHE_DIR/$KEY.wasm" "$OUT"
  cp "$CACHE_DIR/$KEY-compose.wasm" "$COMPOSE"
  echo "WASM artifacts restored from cache $KEY"
else
  bash "$ROOT/crates/wasm/scripts/build-wasm.sh"
  bash "$ROOT/crates/wasm/scripts/build-wasm.sh" --compose
fi

bun packages/engine/scripts/build-compose-fonts.ts

if [[ -n "$CACHE_DIR" ]]; then
  mkdir -p "$CACHE_DIR"
  cp "$OUT" "$CACHE_DIR/$KEY.wasm"
  cp "$COMPOSE" "$CACHE_DIR/$KEY-compose.wasm"
fi
