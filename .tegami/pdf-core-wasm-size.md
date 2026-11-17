---
packages:
  "@signature-kit/pdf-core": patch
---

## Smaller pdf-core WebAssembly module

The release wasm module is about 16% smaller (1.26 MiB → 1.03 MiB raw; ~428 KB → ~404 KB gzip). Size wins come from Binaryen `wasm-opt -O3` in the build, packing Adobe Glyph List and CFF string tables (zlib blobs, u8 length/delta indexes), deduplicating Standard 14 width rows, dropping production `format!` / Debug format strings / panic locations, and a pinned `binaryen` 130 build dependency. Speed guards on text extraction and page rendering stay within noise of the previous opt-level=3 baseline. The wasm budget test is now 1056 KiB.
