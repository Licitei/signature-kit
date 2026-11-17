# @signature-kit/pdf-core

In-house PDF engine compiled to WebAssembly. It inspects page geometry, link annotations, and positioned text, renders pages, analyzes signature revisions, and writes PDFs (incremental updates, full rewrites, page merges) without any third-party PDF library. The Rust crate lives in `rust/` and has zero external dependencies; TypeScript talks to it through a tiny C ABI (no wasm-bindgen).

## Install

```sh
bun add @signature-kit/pdf-core effect
```

## Public surface

- `@signature-kit/pdf-core/config` — `PdfCoreError`, `PdfCoreErrorCodeValue`, `pdfCoreErrorMessages`, and the option and inspection schemas.
- `@signature-kit/pdf-core/pdf-core` — the `PdfCore` service, `makePdfCore(module)`, and `pdfCoreLayer(module)`.
- `@signature-kit/pdf-core/browser` — `pdfCoreBrowserLayer`: fetches `pdf-core.wasm` next to the module, compiles it with `WebAssembly.compileStreaming`, and falls back to `WebAssembly.compile` when the response is not served as `application/wasm`.
- `@signature-kit/pdf-core/file` — `pdfCoreFileLayer`: reads `pdf-core.wasm` through the Effect `FileSystem` and `Path` services. The caller provides the Node or Bun platform layer.
- `@signature-kit/pdf-core/canvas` — browser painter for render display lists: `paintDisplayList`, `prepareDisplayListImages`, `renderDisplayListImage`, `displayListViewport`, and `displayListImageBlobs`. It uses Canvas 2D (`OffscreenCanvas`, `Path2D`, `createImageBitmap`), so it runs in windows and workers.
- `@signature-kit/pdf-core/pdf-core.wasm` — the compiled module for bundlers and custom loaders.

`WebAssembly`, `fetch`, `TextEncoder`, and `TextDecoder` are standard Web APIs and are part of this package's declared cross-runtime contract. Each layer compiles the module once when the layer is built.

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

`text` returns one reading-order plain-text string per page (pdftotext style). It clusters positioned runs into lines, splits lines into cells on wide gaps, groups cells into blocks, orders blocks with an XY-cut (columns are read column by column, table rows row by row), honours `/Rotate` and sideways text, and ignores content streams that cannot show text:

```ts
const pages = yield * core.text(pdf, { pageIndexes: [0, 1] });
```

`pageIndexes` is optional; omitted, every page is returned. Pages whose content cannot be decoded come back as empty strings instead of failing the document.

Text options:

- `format`: `"text"` (default) or `"markdown"`. Markdown keeps the reading order of `text` (columns that each hold flowing paragraphs are read column by column) and groups lines into paragraphs: a line joins the previous one unless the vertical gap exceeds the line pitch, a list or clause marker starts it, the size or emphasis changes, or the previous line ends a sentence and the next word would have fit on it. End-of-line hyphenation is joined (`administra-`/`tivo` becomes `administrativo`; compounds such as `mão-de-`/`obra`, clitics such as `apresentá-`/`lo` and digit groups keep the hyphen), and a paragraph cut by a page break continues on the previous page when it does not end a sentence and the next page starts in lowercase, skipping page stamps in between. Headings come from the size ratio to the body text, bold or uppercase lines and the numbering depth (`1.` is `##`, `1.1.` is `###`); numbered clauses inside body text stay paragraphs. Bold and italic come from the embedded font (`OS/2`, `head`), the font names and descriptors and fill-and-stroke render mode; when a style covers most of the body text it is not marked. Bullets become `- `, numbered items keep their number, and `a)` or `I -` items keep their marker inside a `- ` item, nested by indentation. Link annotations over text become `[text](url)`, bare URLs stay as they are, and every detected table is a GFM table (`|` escaped, wrapped cell lines joined like paragraphs, merged cells left empty after their first slot). There are no page separators; each page is its own string.
- `dropRunningHeaders` (default `true`): lines repeated in the top or bottom 10% of at least half of the selected pages (markdown: at least three pages and 5% of them) (digits normalised, so `Página 3 de 79` matches `Página 4 de 79`) are dropped, so sentences continue across page breaks. When the repeated line is identical on every page (a fixed address, say) the first page keeps one copy; when its digits change (page numbers) it is dropped everywhere. It needs at least two selected pages. `inspect` is never affected.

Ruled tables (cell borders drawn as strokes or thin filled rectangles, with the CTM applied; clipping-only paths and page-sized frames are ignored) are laid out cell by cell in both formats, so a bordered form reads row by row and a heading below the table never merges into its last cell. Borderless tables are detected from column alignment of the text runs and are structured in `markdown` and `tables` only; `text` keeps the row-major block layout for them.

`tables` returns the structure of every table:

```ts
const tables = yield * core.tables(pdf, { pageIndexes: [0] });
// [{ pageIndex, bbox, rows, cols, cells: [{ row, col, rowSpan, colSpan, bbox, text }] }]
```

`bbox` values are in page user space like `inspect` rects; `row`/`col` follow the visible reading orientation (top to bottom, left to right) even on rotated pages. Merged cells appear once with `rowSpan`/`colSpan` greater than 1.

Marked-content `/ActualText` replaces the glyph text of its span, glyphs fully outside a Form XObject `/BBox` are skipped, and text render modes 4-7 (clip) still extract text, in `text`, `markdown` and `tables`.

`inspect` returns `pages` (`mediaBox`, `cropBox`, `rotate`), `links` (`pageIndex`, `uri`, `rect`), and `text` pages. Each text page carries `rects` (a `Float64Array` of `[x0, y0, x1, y1, fontSize]` per item), `text` (all item texts joined), and `offsets` (a `Uint32Array` of `items + 1` UTF-16 code unit offsets into `text`, so item `n` is `text.slice(offsets[n], offsets[n + 1])`). Results are decoded straight from wasm memory, and the typed arrays copied out, before the wasm buffers are released.

## Signatures and revisions

`signatures(pdf, analysis)` reports the signature dictionaries of a PDF. Every dictionary carries its kind (`signature` or `documentTimestamp`), its object number and start offset, the exact byte spans of its `/ByteRange` and `/Contents` entries, the parsed byte-range values when they are four non-negative safe integers, and whether it is an unsigned placeholder (`[0 /********** /********** /**********]` with a zero-filled `/Contents`).

- `"scan"` scans every indirect object once. `parseFailed`, `streamFailed`, and `streamUncertain` report syntax the scanner could not bound; callers treat them as fail-closed.
- `"dictionaries"` resolves forward indirect stream lengths from each revision's own number objects before rescanning, and reports `failure: "streamEnd"` when a stream still cannot be bounded.
- `"verification"` additionally reads every revision (classic tables, xref streams with Flate and PNG/TIFF predictors, hybrid `/XRefStm` sections, object streams), binds each dictionary to the revision whose `%%EOF` ends its byte range, and keeps only dictionaries reachable from that revision's AcroForm signature fields.

Work is bounded: 128 revisions, 1,024 signature dictionaries, 200,000 indirect number values, 500,000 cross-reference entries, 16 MiB per xref or object stream, 64 MiB of decompressed object streams, and 200,000 reachability steps. Exceeding a bound reports a `failure` instead of a partial answer.

`revisionComplete(pdf, end)` is `true` when `pdf.subarray(0, end)` is a complete revision: it ends at `%%EOF` (trailing whitespace allowed), its cross-reference chain is intact, and the prefix opens as a document.

## Writing

`document(pdf, options)` describes what an edit needs: `nextObjectNumber`, every page (`ref`, boxes, rotation, annotation count), whether the catalog has an AcroForm, the annotations of `annotationPages` (reference, widget flag, `/T` presence, `/Rect`, the `uri` of `/Link` annotations with a URI action, and the signature slot analysis of empty signature widgets), and with `fieldNamePrefix` the first unused `<prefix><n>` field name (or why the field tree could not be read within its depth, node, and name-length budgets).

`edit(pdf, operations, options)` applies typed operations and serializes the result. Values are PDF syntax (`"<< /Fields [] >>"`, `"12 0 R"`, `"(text)"`); new objects use numbers from `nextObjectNumber` upward. Operations:

| `op`             | Effect                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `setObject`      | Replaces or adds an indirect object.                                                                                                |
| `setStream`      | Replaces or adds a stream object; `compress` Flate-encodes the data with the in-house zlib encoder.                                 |
| `set` / `remove` | Sets or removes a dictionary key at a target. Targets start at the catalog, a page, or an object and follow a path of keys/indexes. |
| `append`         | Appends to an array entry (indirect arrays are edited in place; a missing entry becomes a new array).                               |
| `removeItem`     | Removes every equal item from an array entry (for example an annotation reference).                                                 |
| `setFlags`       | ORs bits into an integer entry such as `/F` or `/SigFlags`.                                                                         |
| `appendContent`  | Adds a content stream to a page; with `wrapRef` the existing content is wrapped in `q`/`Q` first.                                   |
| `addResource`    | Adds a named resource (`Font`, `XObject`, `ExtGState`, …) to a page, materializing inherited resources.                             |
| `image`          | Adds an 8-bit gray or RGB image XObject; with `alpha` the alpha channel becomes an `/SMask` object.                                 |
| `png`            | Decodes a PNG (every color type and bit depth, Adam7 interlacing, `tRNS`) into an 8-bit image XObject with an `/SMask` when alpha.  |
| `standardFont`   | Adds a standard-14 Type 1 font (`WinAnsiEncoding` except Symbol and ZapfDingbats).                                                  |
| `signature`      | Adds a signature dictionary with a `/ByteRange` placeholder and a zero-filled `/Contents` of `contentsLength` bytes.                |
| `repairCatalog`  | Sets `/Type /Catalog` on the document catalog.                                                                                      |

`mode` chooses the serialization. `"incremental"` appends the changed objects after the untouched original bytes with a new cross-reference section linked by `/Prev` (a classic table, or an xref stream when the previous section is one), so earlier signatures stay valid; it fails when the cross-reference chain had to be repaired. `"rewrite"` copies the reachable object graph into a new file with renumbered objects, dropping unreachable ones; `objectStreams: true` packs non-stream objects into Flate object streams. `"auto"` (default) is incremental when possible and a rewrite otherwise.

PNG input is bounded to 16 MiB, 16 Mi pixels, 64 MiB of decoded scanlines and 4,096 chunks; malformed PNGs fail with `pdfCore.INVALID_OPTIONS`.

`create({ pages })` writes a new document with blank pages of the given sizes (1 to 10,000 pages, sides up to 14,400 points); edit it like any other PDF.

`fontMetrics(baseFont)` returns, for one of the twelve WinAnsi standard-14 fonts, the Unicode code point (`unicode`, `0` when undefined) and the advance width in 1/1000 em (`widths`) of each of the 256 WinAnsi codes, so callers can encode and measure text drawn with the `standardFont` operation.

`pngSize(png)` decodes a PNG with the same bounded decoder as the `png` edit operation and returns its `width` and `height`; it fails with `pdfCore.INVALID_OPTIONS` or `pdfCore.LIMIT_EXCEEDED` for anything that operation would reject, including animated PNG chunks and bytes after `IEND`.

`merge(sources, options)` copies pages into a new document: each source may select `pageIndexes`; inherited boxes, rotation, and resources are materialized, references to pages that are not copied become `null`, and `dropWidgets` removes widget annotations. `deflate(bytes)` returns a zlib stream.

## Rendering

`renderPages` turns pages into compact display lists; the browser painter draws them with Canvas 2D, so JPEG decoding and anti-aliased rasterization stay in the browser and the wasm module stays small.

```ts
import { renderDisplayListImage } from "@signature-kit/pdf-core/canvas";

const lists = yield * core.renderPages(pdf, { pageIndexes: [0], scale: 150 / 72 });
const thumbnail = yield * renderDisplayListImage(lists[0]); // { pageIndex, width, height, image: Blob }
```

`scale` is device pixels per PDF point (default `150 / 72`, i.e. 150 DPI). Each display list carries `pageIndex`, `view` (crop box clipped to the media box), `rotate`, `scale`, the `ops` bytes, and `blobs`. `scale` also bounds image work: images larger than their device footprint are box-filtered down in Rust before they cross the wasm boundary. `renderDisplayListImage(list, { scale })` paints into an `OffscreenCanvas` on a white background and encodes a PNG `Blob`; `paintDisplayList(context, list, images, scale)` paints into any 2D context after `prepareDisplayListImages(list)` decoded the images (close the returned bitmaps when done).

Covered: paths (`m l c v y h re`), fill, stroke and even-odd rules, clipping (`W W*`), line width, cap, join, miter limit and dash patterns (lines thinner than one device pixel are drawn one pixel wide), `cm`, `q`/`Q`, DeviceGray/RGB/CMYK, CalGray/CalRGB, ICCBased (by `/N` or `/Alternate`), Lab, Indexed, Separation and DeviceN through their tint transforms (sampled, exponential, stitching and bounded PostScript calculator functions), ExtGState `LW LC LJ ML D CA ca BM Font`, Form XObjects clipped to their `/BBox`, image XObjects and inline images (Flate, LZW, RunLength, ASCIIHex, ASCII85 and raw samples decoded to RGBA in Rust with 1/2/4/8/16 bits per component, `/Decode` arrays, stencil masks, `/SMask` with `/Matte`, colour-key and stencil `/Mask`; DCT JPEG bytes are passed to the browser decoder; CCITT Group 3 and Group 4 are decoded in Rust), axial and radial shadings for `sh` and shading patterns, embedded TrueType, CFF (including CID-keyed), OpenType CFF and Type 1 (eexec) glyph outlines drawn as cached glyph paths, Type 3 glyph procedures, text render modes 0–7 (3 is invisible, 4–7 clip), and the normal appearance stream of every annotation that is not hidden, no-view or a popup. Non-embedded fonts are drawn with `fillText` in a mapped sans, serif or monospace family stretched to the PDF `/Widths`.

Approximations and gaps: JPX and JBIG2 images are drawn as a neutral grey placeholder; function-based and mesh shadings fill with their `/Background` (function-based ones with the colour at the domain centre); tiling patterns fill with the first non-white colour of the tile; ExtGState soft masks, transparency-group isolation/knockout and optional-content visibility are ignored; a gradient painted on text uses its middle colour. Hostile input is bounded: content streams share the decoded-stream byte budget, a page stops after 4 000 000 operators or 96 MiB of display list, decoded images are capped at 64 Mi pixels (16 Mi after downsampling) and 384 MiB per page, Form XObject and Type 3 nesting stops at 16 levels with cycle detection, and graphics-state nesting at 256 levels. A page that hits a budget is returned truncated instead of failing.

## Errors

Failures use `PdfCoreError` with the codes `pdfCore.WASM_LOAD_FAILED`, `pdfCore.INVALID_PDF`, `pdfCore.ENCRYPTED_PDF`, `pdfCore.LIMIT_EXCEEDED`, `pdfCore.UNSUPPORTED_FEATURE`, `pdfCore.INVALID_OPTIONS`, and `pdfCore.PAINT_FAILED` (the browser could not create a canvas, decode an image, or encode the page image). Invalid edit operations (malformed PDF syntax, missing targets, impossible incremental updates) fail with `pdfCore.INVALID_OPTIONS`. `pdfCoreErrorMessages` carries `en-US` and `pt-BR` copy.

## Wasm ABI

The module exports `memory` and fourteen functions. There is no global mutable state; every buffer is owned by the caller and released with `pdf_core_free`.

| Export                                                                                                   | Contract                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pdf_core_alloc(len) -> ptr`                                                                             | 8-byte aligned block of `len` bytes, or `0` when out of memory.                                                  |
| `pdf_core_free(ptr, len)`                                                                                | Releases a block returned by `pdf_core_alloc`, `pdf_core_inspect` or `pdf_core_text`.                            |
| `pdf_core_inspect(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) -> result_ptr`                          | Returns a result block, or `0` when out of memory.                                                               |
| `pdf_core_text(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) -> result_ptr`                             | Returns a text result block, or `0` when out of memory.                                                          |
| `pdf_core_tables(pdf_ptr, pdf_len, flags, pages_ptr, pages_len) -> result_ptr`                           | Returns a tables result block, or `0` when out of memory.                                                        |
| `pdf_core_render(pdf_ptr, pdf_len, flags, pages_ptr, pages_len, scale: f64) -> result_ptr`               | Returns a render result block, or `0` when out of memory. `scale` is device pixels per point, `0 < scale <= 64`. |
| `pdf_core_signatures(pdf_ptr, pdf_len, mode) -> result_ptr`                                              | Signature analysis; `mode` `0` scan, `1` dictionaries, `2` verification.                                         |
| `pdf_core_revision_complete(pdf_ptr, pdf_len, end) -> u32`                                               | `1` when the first `end` bytes are a complete revision, else `0`.                                                |
| `pdf_core_document(pdf_ptr, pdf_len, flags, pages_ptr, pages_len, prefix_ptr, prefix_len) -> result_ptr` | Document description; `flags` bit 2 selects annotation pages.                                                    |
| `pdf_core_edit(pdf_ptr, pdf_len, ops_ptr, ops_len) -> result_ptr`                                        | Applies an edit payload; the result payload is the new PDF.                                                      |
| `pdf_core_merge(payload_ptr, payload_len, flags) -> result_ptr`                                          | Merges sources; `flags` bit 0 drops widgets, bit 1 packs object streams.                                         |
| `pdf_core_deflate(data_ptr, data_len) -> result_ptr`                                                     | The result payload is a zlib stream.                                                                             |
| `pdf_core_create(sizes_ptr, sizes_len) -> result_ptr`                                                    | `sizes_len` `f64` values, width and height per page; the payload is the new PDF.                                 |
| `pdf_core_font_metrics(name_ptr, name_len) -> result_ptr`                                                | Standard-14 font metrics; see the font metrics payload.                                                          |
| `pdf_core_png_size(png_ptr, png_len) -> result_ptr`                                                      | Decoded PNG `width` and `height` as two little-endian `u32` values.                                              |

`flags`: bit 0 = extract text, bit 1 = extract links, bit 2 = `pages_ptr` holds `pages_len` little-endian `u32` page indexes (otherwise every page), bit 3 = markdown output (`pdf_core_text`), bit 4 = drop running headers and footers (`pdf_core_text`).

### Result block

All integers are little-endian. The block is 8-byte aligned and `total_len` is the length to pass to `pdf_core_free`.

| Offset | Type  | Field                                                                                                       |
| ------ | ----- | ----------------------------------------------------------------------------------------------------------- |
| 0      | `u32` | `total_len` — header plus payload                                                                           |
| 4      | `u32` | `status` — `0` ok, `1` invalid PDF, `2` encrypted, `3` limit exceeded, `4` unsupported, `5` invalid request |
| 8      | bytes | payload (UTF-8 reason when `status != 0`)                                                                   |

### Payload (version 2)

Payload offsets are relative to the payload start, so every float section stays 8-byte aligned in memory and can be viewed as a `Float64Array` without copying. Every section is padded with zero bytes to a multiple of 8.

Header (32 bytes), all `u32`: `magic` (`0x43464450`, "PDFC"), `version` (`2`), `page_count`, `link_count`, `text_page_count`, `pages_offset`, `links_offset`, `text_offset`.

Pages — `page_count` records of 72 bytes: `media_box` (4 × `f64`), `crop_box` (4 × `f64`), `rotate` (`i32`), 4 bytes padding.

Links — `link_count` records of 48 bytes: `rect` (4 × `f64`), `page_index` (`u32`), `uri_offset` (`u32`), `uri_len` (`u32`), 4 bytes padding; then one UTF-8 blob holding every URI (`uri_offset` is relative to the blob start), padded to 8.

Text — `text_page_count` pages back to back. Each page: header of 16 bytes (`page_index`, `item_count`, `text_len` — all `u32` — and 4 bytes padding); `item_count` × 5 `f64` (`x0`, `y0`, `x1`, `y1`, `font_size`); `item_count + 1` `u32` UTF-16 code unit offsets into the decoded text blob, padded to 8; the UTF-8 text blob of `text_len` bytes, padded to 8. Version 1 used UTF-8 byte offsets.

### Text payload (version 1)

`pdf_core_text` uses the same result block and status codes. `flags` bits 2 (page indexes), 3 (markdown) and 4 (drop running headers) apply. The payload is little-endian and 8-byte aligned: `magic` (`0x58544450`, "PDTX"), `version` (`1`), `page_count`, `text_len` — all `u32`; then `page_count + 1` `u32` offsets into the blob, padded to 8; then the UTF-8 blob of `text_len` bytes, padded to 8. Page `n` is `blob[offsets[n]..offsets[n + 1]]`.

### Tables payload (version 1)

`pdf_core_tables` uses the same result block and status codes; only `flags` bit 2 applies. The payload is little-endian and 8-byte aligned. Header of 16 bytes, all `u32`: `magic` (`0x42544450`, "PDTB"), `version` (`1`), `table_count`, `cell_count`. Then `table_count` tables back to back, each a 48-byte record — `page_index`, `rows`, `cols`, `cell_count` (all `u32`) and `bbox` (4 × `f64`) — followed by its cells in row-major order, 56 bytes each: `row`, `col`, `row_span`, `col_span` (all `u32`), `bbox` (4 × `f64`), `text_offset`, `text_len` (`u32`, relative to the text blob). The UTF-8 text blob follows the last record and is padded to 8.

### Signatures payload (version 1)

Header of 24 bytes, all `u32`: `magic` (`0x47534450`, "PDSG"), `version` (`1`), `failure` (`0` none, then `1`–`10` in the order `streamEnd`, `revisionLengths`, `indirectLengths`, `lengthBudget`, `dictionaryParse`, `revisionStructure`, `crossReferenceStream`, `objectStream`, `traversalBudget`, `invalidByteRange`), `flags` (bit 0 parse failed, bit 1 stream failed, bit 2 stream uncertain, bit 3 limit exceeded), `count`, padding. Then `count` records of 72 bytes: `object_number`, `generation`, `object_start`, `flags` (bit 0 document timestamp, bit 1 has `/ByteRange`, bit 2 has `/Contents`, bit 3 byte-range values valid, bit 4 unsigned placeholder), the `/ByteRange` span and the `/Contents` span (`key_start`, `value_start`, `value_end` each, all `u32`), and the four byte-range values as `f64`.

### Document payload (version 2)

Header of 32 bytes, all `u32`: `magic` (`0x49444450`, "PDDI"), `version` (`1`), `page_count`, `annotation_count`, `next_object_number`, `flags` (bit 0 AcroForm, bit 1 field name available, bit 2 field name failed), `field_failure` (`1`–`6`: depth, node budget, cyclic, name length, qualified name length, character budget), `field_name_len`. Pages are 80-byte records: `media_box` and `crop_box` (4 × `f64` each), `rotate` (`i32`), `ref_number`, `ref_generation` (`0` when the page is not indirect), `annotation_count`. Annotations are 72-byte records: `page_index`, `index`, `ref_number`, `ref_generation`, `flags` (bit 0 widget, bit 1 has rect, bit 2 has `/T`, bit 3 has a link URI), `slot` (`0` none, `1` open on the widget, `2` open on the referenced field, `3` open on the widget's direct `/Parent`, `4` malformed), `slot_a` (field object number, or `1` cyclic, `2` invalid parent, `3` depth), `slot_b` (field generation), `rect` (4 × `f64`), then `uri_offset` and `uri_len` (`u32`, relative to the URI blob). The UTF-8 URI blob (every link URI back to back) follows the records, then the UTF-8 field name, padded to 8. Version 1 had 64-byte records and no URIs.

### Font metrics payload (version 1)

Little-endian: `magic` (`0x4d464450`, "PDFM"), `version` (`1`), then 256 records of `unicode` and `width` (`u16` each), indexed by WinAnsi code.

### Edit payload (version 1)

Little-endian and unaligned: `magic` (`0x44455044`, "PDED"), `version` (`1`), `flags` (bits 0–1 mode: `0` auto, `1` incremental, `2` rewrite; bit 2 object streams), `count`, then `count` operations. Each operation starts with its opcode (`1` setObject … `10` image, `11` standardFont, `12` signature, `13` repairCatalog, `14` png). Byte strings are a `u32` length followed by the bytes; references are `number`, `generation`; optional references use number `0` for none; targets are `kind` (`0` catalog, `1` page, `2` object), two `u32` arguments (page index, or number and generation), a step count, and steps (`0` + key bytes, or `1` + `u32` index).

### Merge payload

`count`, then per source `pdf_len` and `page_count` (`0xFFFFFFFF` for every page) followed by that many page indexes, then the PDFs back to back.

### Render payload (version 1)

`pdf_core_render` uses the same result block and status codes; only `flags` bit 2 applies. Header of 16 bytes: `magic` (`0x4C524450`, "PDRL"), `version` (`1`), `page_count`, padding (all `u32`). Then one section per page, 8-byte aligned: `page_index` (`u32`), `rotate` (`i32`), `ops_len` (`u32`), `blob_count` (`u32`), `view` (4 × `f64`), `section_len` (`u32`, from the section start to the next section), padding (`u32`); the `ops_len` op bytes, padded to 8; `blob_count` × (`offset`, `len`) `u32` pairs relative to the blob data, padded to 8; the blob data, each blob padded to 8.

Ops are a byte code followed by little-endian operands (`f32` numbers, `u32` counts and ids). A matrix is 6 × `f32`; a path is `u32` verb count, verbs (`0` move 2, `1` line 2, `2` cubic 6, `3` close 0, `4` quadratic 4 coordinates), `u32` coordinate count, `f32` coordinates. Paths and images are in PDF user space under the last `TRANSFORM`; the painter maps user space to device pixels from `view`, `rotate` and the scale.

| Code | Op                | Operands                                                                                                                                                                                                      |
| ---- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `SAVE`            | —                                                                                                                                                                                                             |
| 2    | `RESTORE`         | —                                                                                                                                                                                                             |
| 3    | `TRANSFORM`       | matrix (absolute CTM)                                                                                                                                                                                         |
| 4    | `PATH`            | path (becomes the current path)                                                                                                                                                                               |
| 5    | `FILL`            | `u8` rule (`0` non-zero, `1` even-odd)                                                                                                                                                                        |
| 6    | `STROKE`          | —                                                                                                                                                                                                             |
| 7    | `CLIP`            | `u8` rule                                                                                                                                                                                                     |
| 8    | `FILL_COLOR`      | 4 × `u8` RGBA                                                                                                                                                                                                 |
| 9    | `STROKE_COLOR`    | 4 × `u8` RGBA                                                                                                                                                                                                 |
| 10   | `LINE_WIDTH`      | `f32`                                                                                                                                                                                                         |
| 11   | `LINE_CAP`        | `u8`                                                                                                                                                                                                          |
| 12   | `LINE_JOIN`       | `u8`                                                                                                                                                                                                          |
| 13   | `MITER`           | `f32`                                                                                                                                                                                                         |
| 14   | `DASH`            | `u32` count, `f32` lengths, `f32` phase                                                                                                                                                                       |
| 15   | `BLEND`           | `u8` PDF blend mode (`0` Normal … `15` Luminosity)                                                                                                                                                            |
| 16   | `GLYPH_DEFINE`    | `u32` id, path in glyph space                                                                                                                                                                                 |
| 17   | `GLYPH`           | `u8` modes (`1` fill, `2` stroke, `4` add to text clip), `u32` id, matrix (glyph space to user space)                                                                                                         |
| 18   | `TEXT_CLIP`       | — (clip with the glyphs collected since the last `TEXT_CLIP`)                                                                                                                                                 |
| 19   | `TEXT`            | `u8` flags (`1` serif, `2` monospace, `4` bold, `8` italic, `16` fill, `32` stroke), matrix (em space to user space), `f32` advance in em, `u32` length, UTF-8 text                                           |
| 20   | `IMAGE`           | `u8` flags (`1` JPEG, `2` JPEG soft mask, `4` matte), `u8` alpha, `u32` blob, width, height, mask blob (`0xFFFFFFFF` none), mask width, mask height, 4 × `u8` matte RGB + padding; drawn into the unit square |
| 21   | `SHADE`           | gradient: `u8` flags (`1` radial, `2` extend start, `4` extend end), 6 × `f32` coordinates (`x0 y0 x1 y1` or `x0 y0 r0 x1 y1 r1`), `u32` stop count, stops (`f32` offset, 4 × `u8` RGBA)                      |
| 22   | `FILL_GRADIENT`   | gradient flags and coordinates, matrix (pattern space to page space), stops; later fills use it until the next fill colour                                                                                    |
| 23   | `STROKE_GRADIENT` | same as `FILL_GRADIENT` for strokes                                                                                                                                                                           |

Raw image blobs are RGBA (`width × height × 4`); raw mask blobs are 8-bit alpha (`mask width × mask height`); JPEG blobs are the stream bytes after any non-image filters.

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
