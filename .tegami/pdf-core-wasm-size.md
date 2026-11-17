---
packages:
  "@signature-kit/pdf-core": patch
---

## Smaller pdf-core WebAssembly module

The release wasm module is about 13% smaller than `feat/pdf-core-render-v5g` (1.25 MiB → 1.06 MiB raw; ~424 KB → ~413 KB gzip; ~327 KB → ~320 KB brotli). Size wins come from Binaryen `wasm-opt -O3` in the build (pinned `binaryen` 130), CFF standard-string zlib packing, Standard 14 width-row dedupe, AGL codepoints as `u16`, dropping production `format!` / Debug format strings, Latin-1 case folding instead of Unicode `to_lowercase`, and collapsing stable-sort monomorphizations. Glyph/AGL hot tables stay as plain static data so text extraction stays within noise of the baseline. The wasm budget test is 1072 KiB.
