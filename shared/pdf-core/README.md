# @signature-kit/pdf-core

In-house PDF engine compiled to WebAssembly. It inspects page geometry, link annotations, and positioned text without any third-party PDF parser. The Rust crate lives in `rust/` and has zero external dependencies; TypeScript talks to it through a tiny C ABI (no wasm-bindgen).

## Install

```sh
bun add @signature-kit/pdf-core effect
```

## Public surface

- `@signature-kit/pdf-core/config` — `PdfCoreError`, `PdfCoreErrorCodeValue`, `pdfCoreErrorMessages`, and the option and inspection schemas.
- `@signature-kit/pdf-core/pdf-core` — the `PdfCore` service, `makePdfCore(module)`, and `pdfCoreLayer(module)`.
- `@signature-kit/pdf-core/browser` — `pdfCoreBrowserLayer`: fetches `pdf-core.wasm` next to the module, compiles it with `WebAssembly.compileStreaming`, and falls back to `WebAssembly.compile` when the response is not served as `application/wasm`.
- `@signature-kit/pdf-core/file` — `pdfCoreFileLayer`: reads `pdf-core.wasm` through the Effect `FileSystem` and `Path` services. The caller provides the Node or Bun platform layer.
- `@signature-kit/pdf-core/pdf-core.wasm` — the compiled module for bundlers and custom loaders.

`WebAssembly`, `fetch`, and `TextDecoder` are standard Web APIs and are part of this package's declared cross-runtime contract. Each layer compiles the module once when the layer is built.

## Example

```ts
import { NodeServices } from "@effect/platform-node";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { pdfCoreFileLayer } from "@signature-kit/pdf-core/file";
import { Effect, Layer } from "effect";

declare const pdf: Uint8Array;

const program = Effect.gen(function* () {
  const core = yield* PdfCore;
  const inspection = yield* core.inspect(pdf, { text: true, links: true });
  return inspection.pages.map((page) => page.mediaBox);
});

program.pipe(Effect.provide(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))));
```

`inspect` returns `pages` (`mediaBox`, `cropBox`, `rotate`), `links` (`pageIndex`, `uri`, `rect`), and `text` pages. Each text page carries `rects` (a `Float64Array` of `[x0, y0, x1, y1, fontSize]` per item), `text` (all item texts joined), and `offsets` (a `Uint32Array` of `items + 1` UTF-8 byte offsets into `text`). Results are copied out of wasm memory before the wasm buffers are released.

## Errors

Failures use `PdfCoreError` with the codes `pdfCore.WASM_LOAD_FAILED`, `pdfCore.INVALID_PDF`, `pdfCore.ENCRYPTED_PDF`, `pdfCore.LIMIT_EXCEEDED`, `pdfCore.UNSUPPORTED_FEATURE`, and `pdfCore.INVALID_OPTIONS`. `pdfCoreErrorMessages` carries `en-US` and `pt-BR` copy.

## Wasm ABI

The module exports `memory` and three functions. There is no global mutable state; every buffer is owned by the caller and released with `pdf_core_free`.

| Export                                                                          | Contract                                                             |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `pdf_core_alloc(len) -> ptr`                                                    | 8-byte aligned block of `len` bytes, or `0` when out of memory.      |
| `pdf_core_free(ptr, len)`                                                       | Releases a block returned by `pdf_core_alloc` or `pdf_core_inspect`. |
| `pdf_core_inspect(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) -> result_ptr` | Returns a result block, or `0` when out of memory.                   |

`flags`: bit 0 = extract text, bit 1 = extract links, bit 2 = `pages_ptr` holds `pages_len` little-endian `u32` page indexes (otherwise every page).

### Result block

All integers are little-endian. The block is 8-byte aligned and `total_len` is the length to pass to `pdf_core_free`.

| Offset | Type  | Field                                                                                  |
| ------ | ----- | -------------------------------------------------------------------------------------- |
| 0      | `u32` | `total_len` — header plus payload                                                      |
| 4      | `u32` | `status` — `0` ok, `1` invalid PDF, `2` encrypted, `3` limit exceeded, `4` unsupported |
| 8      | bytes | payload (UTF-8 reason when `status != 0`)                                              |

### Payload (version 1)

Payload offsets are relative to the payload start, so every float section stays 8-byte aligned in memory and can be viewed as a `Float64Array` without copying. Every section is padded with zero bytes to a multiple of 8.

Header (32 bytes), all `u32`: `magic` (`0x43464450`, "PDFC"), `version` (`1`), `page_count`, `link_count`, `text_page_count`, `pages_offset`, `links_offset`, `text_offset`.

Pages — `page_count` records of 72 bytes: `media_box` (4 × `f64`), `crop_box` (4 × `f64`), `rotate` (`i32`), 4 bytes padding.

Links — `link_count` records of 48 bytes: `rect` (4 × `f64`), `page_index` (`u32`), `uri_offset` (`u32`), `uri_len` (`u32`), 4 bytes padding; then one UTF-8 blob holding every URI (`uri_offset` is relative to the blob start), padded to 8.

Text — `text_page_count` pages back to back. Each page: header of 16 bytes (`page_index`, `item_count`, `text_len` — all `u32` — and 4 bytes padding); `item_count` × 5 `f64` (`x0`, `y0`, `x1`, `y1`, `font_size`); `item_count + 1` `u32` offsets into the text blob, padded to 8; the UTF-8 text blob of `text_len` bytes, padded to 8.

## Development

```sh
cd shared/pdf-core/rust
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

`bun run build` compiles the crate for `wasm32-unknown-unknown` (the `build-wasm` Nx target) and copies it to `dist/pdf-core.wasm`; it requires a Rust toolchain with that target installed. The module must stay under 1 MiB.

## License

MIT. See `LICENSE`.
