## @signature-kit/pdf-core@0.4.0

### Sign already-signed PDFs with trailing bytes, and name damaged ones

Already-signed PDFs are stamped and signed through incremental updates so earlier signatures stay valid. When such a file had bytes after its final `%%EOF` (a download footer, for example), stamping failed with `pdf.STAMP_FAILED` and the reason `incremental update needs an intact cross-reference chain`. `PdfCore.edit` in incremental mode now drops the bytes after the final `%%EOF`, which no signature covers, and appends the update to the intact revision, so the earlier signatures stay valid.

Signed files whose cross-reference chain is damaged in other ways still cannot take an incremental update without invalidating their signatures. They now fail with `pdfCore.DAMAGED_XREF`, whose reason says what is wrong: bytes before the `%PDF` header, no `startxref`, a cross-reference table that had to be rebuilt, or an incomplete revision. Stamping and placeholder insertion report these failures as `pdf.DAMAGED_SIGNED_PDF`, with a message that asks the user to download the document again from its original source, instead of `pdf.STAMP_FAILED` or `pdf.INVALID_PDF`.

### OpenTelemetry spans for every public operation

Public operations now run inside named Effect spans, for example `pdfCore.text`, `pdf.sign`, `crypto.pkcs12.parse` and `assinafy.reconcile`. PDF core calls split into `pdfCore.wasm.copyIn`, `pdfCore.wasm.run` and `pdfCore.wasm.decode`. HTTP calls are client spans with method, status and server attributes. Attributes record sizes, counts and algorithm or status literals, never document content, certificate identity, secrets or URLs with paths. No new runtime dependency: provide `@effect/opentelemetry` at the app boundary to export spans. See the OpenTelemetry tracing recipe.

### Column-aware reading order and text flow

`text` and Markdown now split each page into column regions at prose and index gutters before building lines, tables and blocks. Two-column papers read the whole left column before the right one, tight 3–4 column layouts (gutters of about 1 em) read column by column, and prose columns no longer turn into borderless tables. Footnotes at the bottom of a column move to the end of the page, superscript footnote markers stay with their text, and page continuations skip footnotes, captions and tables. End-of-line hyphens are joined with a document-vocabulary rule that keeps real compounds.

## @signature-kit/pdf-core@0.3.0

### Faster selected-page and Markdown PDF extraction

The PDF core opens selected pages without materializing the whole page tree, defers unused XObjects, and accepts complete streams before the next cross-reference offset. Markdown rendering reuses buffers and the number parser uses bounded accumulation for common operands. Page resources share the resolved dictionary across readers, and the JavaScript bindings share result-block validation and disposal.

The pdf-core README documents the procurement corpus results, evidence audit, Wasm size, and an isolated benchmark against LiteParse and PDF Inspector. This release also refreshes all public SignatureKit packages.

## Unreleased

### Read selected pages from a byte-range source

`PdfCore.openLazy(source)` opens a scoped range reader for text, Markdown, tables, and rendering. It caches fetched ranges across calls, preserves original page indexes, and reports full-load fallback in its stats. The Promise client supports `close()` and `await using`. Source adapters cover bytes, Blob, Node file handles, and Effect `FileSystem`.

The planner probes both ends of the file concurrently, follows the cross-reference chain using cached windows, and batches each dependency frontier. It reuses parsed objects and object streams across rounds, follows indirect stream lengths when their headers are available, and fetches adjacent objects within the configured read-ahead gap. Valid linearization hints can prefetch the first page section. Large shared form dictionaries fetch the forms used by the selected page during extraction. The defaults are 64 KiB per probe, a 32 KiB read-ahead gap, and a 2 MiB selective-read batch. Both Effect and Promise clients accept overrides.

Page-0 Markdown matched on all 294 files with zero read failures. Warm measurements use separate long-lived Wasm instances, one warm-up and the median of three trials per file. Values separated by slashes are p50, p90 and max, or p50 and p90 where specified.

| Measurement                                  |                  `pdfs` (30), before → after |        `editais-extra` (264), before → after |
| -------------------------------------------- | -------------------------------------------: | -------------------------------------------: |
| Lazy rounds                                  |                     23 / 32 / 39 → 3 / 5 / 8 |                    19 / 28 / 40 → 3 / 5 / 13 |
| Warm local lazy (ms)                         |  11.03 / 15.02 / 68.34 → 5.43 / 8.38 / 11.39 | 8.38 / 18.29 / 127.88 → 4.66 / 11.78 / 61.75 |
| Warm local full (ms)                         |  5.45 / 21.75 / 40.46 → 5.89 / 25.07 / 34.84 |  5.99 / 23.85 / 74.64 → 6.20 / 21.35 / 58.66 |
| Simulated 40 ms RTT lazy (ms, p50 / p90)     |          1148.28 / 1882.81 → 127.97 / 212.40 |           945.67 / 1756.36 → 128.94 / 224.57 |
| Simulated 40 ms RTT full (ms, p50 / p90)     |                50.10 / 82.55 → 48.92 / 72.53 |                49.59 / 72.77 → 50.52 / 72.42 |
| Loopback HTTP lazy (ms, 12 files per corpus) | 17.81 / 29.00 / 79.43 → 6.50 / 10.42 / 14.06 |  13.46 / 28.49 / 93.40 → 4.81 / 7.82 / 43.06 |
| Loopback HTTP full (ms, 12 files per corpus) |  5.54 / 31.93 / 40.70 → 6.45 / 35.54 / 53.03 |  7.35 / 22.96 / 31.48 → 6.25 / 32.21 / 37.08 |
| Lazy bytes read                              |                                3.63% → 6.05% |                                9.81% → 8.80% |
| Warm peak lazy Wasm memory (MiB)             |                                  5.44 → 4.38 |                                37.38 → 21.44 |
| Warm peak full Wasm memory (MiB)             |                                39.25 → 39.25 |                                77.19 → 77.19 |
| Full-load fallbacks                          |                                        0 → 0 |                                        4 → 0 |

The 40 ms model delays each read and permits up to four concurrent range reads. The full download takes one simulated request, and the model applies no bandwidth limit. On the 74 files with at least 100 pages, warm p50/p90 was 6.38/13.78 ms lazy and 16.45/32.54 ms full. Across both corpora, lazy read 8.47% of the source bytes. The four previous fallbacks stayed lazy and read 6.89%, 1.77%, 33.22%, and 35.10% of their respective files.

Disabling read-ahead raised lazy rounds from 3/5 to 5/8 at p50/p90 on both corpora. Reducing the probe to 32 KiB raised p90 from five to six on both. In one-change-at-a-time runs on the 30 primary files and 30 evenly spaced extra files, serializing the two probes added one round to every file. Serializing known cross-reference reads added one round to one file, and serializing dependency ranges added up to two rounds to eight files. Disabling the linearized shortcut, delaying indirect-length lookup, and probing an object stream header first resulted in the same round counts on that sample.

In fresh processes, p50/p90 was 46.37/84.51 ms lazy and 46.26/104.03 ms full on `pdfs`, and 44.57/66.93 ms lazy and 36.13/70.06 ms full on `editais-extra`. The release Wasm keeps `opt-level = 3`: the lazy planner adds about 39 KB (1,125,410 → 1,164,368 bytes), so the Wasm budget test moves from 1104 KiB to 1144 KiB. Building with `opt-level = "s"` would shrink the module to 841,262 bytes but makes full-load Markdown extraction 9.6% slower (2.47 → 2.71 ms/page on the 30 editais), so it was not adopted.

## @signature-kit/pdf-core@0.2.0

### Repair missing PDF catalog types during edits

When an edit writes the document catalog, the PDF core adds a missing `/Type /Catalog` in the same revision. Signing includes the repaired catalog in the bytes covered by the signature.

### Read PDFs with an empty opening password

PdfCore can inspect, extract text and tables, describe, render, and merge Standard Security PDFs that open with an empty user password. It supports RC4 revisions 2–4, AES-128 revision 4, and AES-256 revisions 5–6. Merge and full edits produce an unencrypted PDF. The automatic edit mode rewrites encrypted inputs, including when preparing a first signature. An explicit incremental edit or an input requiring a nonempty user password fails with `pdfCore.ENCRYPTED_PDF`.

### Inspect text runs with bold and italic styles

`PdfCore.inspect` accepts `runs: true`: text items then also end where the bold/italic style changes, or where the text is repositioned more than 0.2 em past the last visible glyph, so report columns (`17/06/2026 15:39:26` and `MENSAGEM PREGOEIRO`) and bold labels come back as separate items with their own `x`. A piece drawn within that distance (a `™` from another font) stays in the same item, and `TJ` kerning never splits one. Every text page now carries `styles`, a `Uint8Array` with one byte per item (bit 0 bold, bit 1 italic), resolved from the embedded font program, the font name (also for non-embedded Standard 14 fonts such as `Helvetica-Bold`), the font descriptor, and fill-and-stroke rendering. Without `runs` an item can mix styles (its bits cover only the style shared by all its glyphs) and the weight of embedded TrueType fonts is not read, so read `styles` with `runs: true`. The inspect payload is version 3 (style bytes after the offsets) and the ABI adds flag bit 5.

### Promise client for apps without Effect

`loadPdfCoreNode()` (`@signature-kit/pdf-core/node`) and `loadPdfCoreBrowser()` (`@signature-kit/pdf-core/promise`) load the WebAssembly module and return the `PdfCore` operations as Promises that reject with the `PdfCoreError`, so an app can use the engine without installing or importing `effect`. `createPdfCoreClient(module)` builds the same client from a compiled module, and `pdfCoreBrowserModule` exposes the browser module loader behind `pdfCoreBrowserLayer`.

### Page rendering in the in-house core

`PdfCore.renderPages(pdf, { pageIndexes, scale })` renders pages into compact display lists (a new `pdf_core_render` wasm export), and the new browser module `@signature-kit/pdf-core/canvas` paints them with Canvas 2D: `renderDisplayListImage` returns a PNG `Blob` per page (JPEG or WebP on request, oversized pages clamped to the canvas limits), `paintDisplayList` returns an `Effect` that draws into any 2D context and fails with a typed error on malformed display lists, and `prepareDisplayListImages` decodes the page images into a scoped map whose bitmaps are closed with the scope. The renderer covers paths, clipping, line styles, every PDF colour space (tint transforms included), Form XObjects, raster images (Rust-decoded samples with soft masks, mattes and colour keys, browser-decoded JPEG, Rust-decoded CCITT Group 3/4), axial and radial shadings, shading patterns, embedded TrueType, CFF, OpenType and Type 1 glyph outlines, Type 3 fonts, standard-font text runs, and annotation appearance streams. Optional content (OFF groups, OCMDs, `BDC /OC`, XObject and annotation `/OC`) is honoured, `/Interpolate` decides image smoothing so upscaled 1-bit images stay crisp, and clip render modes with standard fonts clip to glyph boxes. JPX and JBIG2 images draw a grey placeholder; mesh shadings, tiling patterns and soft masks are approximated. Glyph outlines, Type 3 glyphs and Form XObjects run under per-glyph and per-page work budgets, and decoded forms, Type 3 glyph programs and colour spaces are cached per document. Large images are downsampled to the render scale inside the core. New error code `pdfCore.PAINT_FAILED` (en-US/pt-BR messages included).

### LiteParse removed

`@signature-kit/pdf/liteparse-browser` is replaced by `@signature-kit/pdf/render-browser`. `renderPdfPagesBrowser(pdf, { pageIndexes?, scale? })` now requires the `PdfPageRenderer` service instead of `LiteParseWorkerFactory`: `pdfPageRendererWorkerLayer({ timeoutMillis? }, create?)` renders in a dedicated Web Worker with a per-request time limit (default 30 s) that terminates and replaces a stuck worker and fails with the new `pdf.RENDER_TIMEOUT` code, and `pdfPageRendererLayer` renders on the current thread from `PdfCore`. It renders through the in-house core and returns `{ pageIndex, width, height, image }` with a PNG `Blob` instead of `{ pageNum, imageBytes }`. `liteParseWorkerBrowserLayer`, `LiteParseWorkerFactory` and the LiteParse worker protocol are gone (`PdfRenderRequests` and `pdfPageRendererHandlersLayer` serve the new worker), and `@llamaindex/liteparse-wasm` is no longer a dependency. `PdfHandwriting` and `pdfHandwritingBrowserLayer` move to the same subpath. Render failures use the new `pdf.page.render` operation.

### Smaller pdf-core WebAssembly module

The release wasm module (reader, writer and renderer) is about 13% smaller: 1,249,882 → 1,087,037 bytes raw, 434 KB → 423 KB gzip, 335 KB → 328 KB brotli. Size wins come from Binaryen `wasm-opt -O3` in the build (pinned `binaryen` 130), CFF standard-string zlib packing, Standard 14 width-row dedupe, AGL codepoints as `u16`, dropping production `format!` / Debug format strings, Latin-1 case folding instead of Unicode `to_lowercase`, and collapsing stable-sort monomorphizations. Glyph/AGL hot tables stay as plain static data so text extraction stays within noise of the baseline. The wasm budget test is 1072 KiB.

### PDF writing and signature analysis in the in-house core

`@signature-kit/pdf-core` now writes PDFs. `PdfCore.edit(pdf, operations, options)` applies typed edit operations (set or add objects and streams, dictionary and array edits, flag ORs, page content with `q`/`Q` wrapping, page resources, image XObjects with soft masks, standard-14 fonts, signature dictionaries with `/ByteRange` and `/Contents` placeholders, catalog repair) and serializes the result either as an incremental update that leaves the original bytes untouched (classic table or xref stream, chained with `/Prev`) or as a full rewrite with renumbered objects and optional object streams. `PdfCore.merge` copies selected pages from several documents, `PdfCore.document` describes pages, annotations, signature slots, and the next free signature field name, and `PdfCore.deflate` exposes the new in-house zlib encoder. Invalid edit requests fail with `pdfCore.INVALID_OPTIONS`.

`PdfCore.signatures(pdf, analysis)` and `PdfCore.revisionComplete(pdf, end)` port the signature and revision analysis that `@signature-kit/pdf` previously ran on pdf-lib's parser internals: signature dictionaries with exact `/ByteRange` and `/Contents` offsets, per-revision indirect stream lengths, classic, xref-stream, and hybrid cross-reference sections, object streams (signature dictionaries are never packed into one), AcroForm reachability, and the same fail-closed limits (128 revisions, 1,024 signature dictionaries, 200,000 traversal steps). The wasm module exports six new functions; the ABI is documented in the README.

### PDF signing and verification run on the in-house core

`@signature-kit/pdf` no longer parses signatures or writes signature placeholders with pdf-lib. `signPdf` appends the signature dictionary, widget, AcroForm field, and `/SigFlags` as an incremental update, so the source bytes and every earlier signature stay valid; documents whose cross-reference chain fails the same completeness check the verifier applies are rewritten instead, and already signed documents always fail closed rather than being rewritten. Linearized documents, whose first-page cross-reference section points forward with `/Prev`, are accepted by both the writer and the verifier, so they are signed incrementally too.

The requirement `PdfCore` is added to `signPdf`, `verifyPdf`, `verifyPdfSignatures`, `mergePdfs`, `removePdfLinkAnchors`, `stampPdfVisibleSignature`, `stampPdfRubric`, `stampPdfRubricOnPages` (when `forIncrementalUpdate` is omitted), `signPdfSignatureField`, `signPdfSignatureBatch`, and `preparePdfSigningBatch`, and to the `@signature-kit/pdf/byte-range` helpers. `hasPdfByteRange` and `hasPdfSignatureDictionary` are now Effects. Provide `pdfCoreBrowserLayer` in the browser or `pdfCoreFileLayer` on Node and Bun; the PDF worker provides it inside the worker.

### ITI conformance

`validatePdfConformance` and `validatePdfWithIti` require `PdfCore` because they read signatures and revisions through `@signature-kit/pdf/byte-range`.

### In-house WASM PDF core

New `@signature-kit/pdf-core` package: a zero-dependency Rust/WebAssembly PDF engine with page geometry, link annotations, and positioned text inspection. It exposes a `PdfCore` Effect service with browser and file-system layers and typed `PdfCoreError` failures.

### Tables, markdown and running headers

`PdfCore.tables(pdf, { pageIndexes })` returns structured tables per page: ruled grids from the content-stream path operators (CTM applied, collinear segments merged, clipping-only paths and page-sized frames ignored) and borderless tables from column alignment, with row/column indexes, merged-cell spans, boxes and cell text. `PdfCore.text` gains `format: "markdown"` (paragraph grouping on the plain-text reading order, hyphenation and page-break joins, headings from size, emphasis and numbering depth, bold/italic from the embedded font tables, nested lists that keep numbered and legal markers, link overlays, and GFM tables) and `dropRunningHeaders` (default `true`: headers and footers repeated on at least half of the pages are dropped; a line that is identical on every page keeps one copy on its first page). Ruled tables are now laid out cell by cell, which keeps headings below a table out of its last cell. Text extraction also honours marked-content `/ActualText`, clips glyphs outside a Form XObject `/BBox`, and keeps extracting text under clip render modes 4-7. `pdf_core_tables` is a new wasm export; `pdf_core_text` accepts the new `markdown` and `drop running headers` flags.

### Limits and performance

`inspect` now uses the same extraction limits as `text` and `tables`, so large documents (hundreds of pages, more than 100 000 text items) inspect instead of failing, and page limit violations in `text`/`tables` surface as `pdfCore.LIMIT_EXCEEDED` instead of silently empty pages. Inspect text `offsets` are UTF-16 code unit offsets into `text` (inspect payload version 2). Extraction is faster on long lines, repeated Form XObjects, Identity-H fonts and multi-page inspection, and overlapping ToUnicode/CMap/width ranges resolve to the latest definition.

### Markdown fidelity and speed

Markdown no longer drops text from borderless tables: a wrap line under a bold row that spans two columns ends the table instead of being discarded, and zero-width segments map to their column. With `dropRunningHeaders`, markdown also drops blocks that repeat at the same position among the first or last three blocks of at least max(3, pages / 20) pages (headers and footers outside the top and bottom bands, signature stamps), keeping the first occurrence. URLs broken across lines are rejoined without a space and keep their link, `?`/`&` ending a URL no longer ends a paragraph, trailing `. , ; )` move out of link text, and unspaced markers such as `c)Informar` or `10.10.Os` are recognised as list items and clauses. Plain text output is unchanged. Text extraction is about 20% faster natively and 30% faster in WebAssembly (no libm `mul_add`/`hypot`/`powi` calls, allocation-free inflate Huffman tables, per-TJ placement invariants, and a prefix-only inflate for the embedded-font style probe).

### takumi-pdf generation for signature anchors

Adds `takumi-pdf` 0.20.0 for PDF generation in the docs registry and pdf-core regression corpus. The shadcn `pdf-signature-anchor` registry item now ships invisible text (`{{signature}}`) and URI link (`https://signature.invalid/anchor`) markers for `findPdfTextAnchors`. Committed fixture `takumi-declaration.pdf` with golden anchor metadata exercises multi-page Portuguese copy, Liberation fonts, and paginated footers. Generation benchmarks compare takumi-pdf vs react-pdf under `shared/pdf-core/bench/`. `@react-pdf/renderer` is removed from `apps/docs`; react-pdf preview (`signature-pdf-viewer`) is unchanged.

### Declare the ETSI SubFilter for ICP-Brasil PAdES

Signing with `policy: "pades-icp-brasil"` now writes `/SubFilter /ETSI.CAdES.detached`. Local AD-RB validation accepts `ETSI.CAdES.detached` and `PBAD.PAdES` and rejects older signatures with `adbe.pkcs7.detached`. Generic CMS signing still writes `adbe.pkcs7.detached`.

Signature dictionary reports and extracted PDF signatures now expose the optional `subFilter` name in place of `usesEtsiCadesDetached`.

### PNG images, blank documents, font metrics, and link URIs in the in-house core

`@signature-kit/pdf-core` gains what stamping needs to stop depending on pdf-lib. The `png` edit operation decodes a PNG (every color type and bit depth, Adam7 interlacing, palette and `tRNS` transparency) into an 8-bit image XObject with an `/SMask` when any pixel is not opaque; input is bounded to 16 MiB, 16 Mi pixels, and 64 MiB of decoded scanlines. `PdfCore.create({ pages })` writes a new document with blank pages, and `PdfCore.fontMetrics(baseFont)` returns the WinAnsi Unicode mapping and advance widths of the twelve WinAnsi standard-14 fonts. `PdfCore.document` now reports the `uri` of link annotations with a URI action (document payload version 2). `PdfCore.pngSize(png)` runs the same bounded decoder and returns the image `width` and `height`; the decoder rejects animated PNG chunks, bytes after `IEND`, and image data that inflates beyond its scanlines. The `addResource` edit operation now fails with `pdfCore.INVALID_OPTIONS` when the page already binds the name to a different object instead of overwriting it. The wasm module exports three new functions, `pdf_core_create`, `pdf_core_font_metrics`, and `pdf_core_png_size`.

### `@signature-kit/pdf` no longer uses pdf-lib

`@cantoo/pdf-lib` is no longer a dependency. Visible signatures, structured badges, QR codes, initials and line rubrics, PNG images, footer links, stamp previews, and illustrative documents are drawn as content streams appended through `PdfCore.edit`, with the same geometry as before; signed PDFs are always updated incrementally, unsigned ones incrementally unless their cross-reference chain needs a rewrite. Text is measured with the Helvetica metrics from `PdfCore.fontMetrics` and drawn with WinAnsi encoding (Latin-1 plus €, typographic quotes, and dashes); text with characters outside WinAnsi fails with `pdf.STAMP_FAILED`, as it did before. Every stamp names its fonts and images after the document's next object number, so a later stamp on the same page never repaints an earlier, possibly signed, appearance. Rounded badge corners and lock icons are drawn as cubic curves converted exactly from their quadratic outlines (pdf-lib drew them with the `v` operator, which bulges the corners slightly). PNG input is validated by the core decoder; stamping no longer inflates PNG data in JavaScript. Failures reported by the core keep their reason, and core limit failures surface as `pdf.LIMIT_EXCEEDED`. Badge layout no longer adds kerning to measured widths that were drawn without it, so badge text and footer separators sit where they are drawn. `mergePdfs` uses `PdfCore.merge`, and `removePdfLinkAnchors` removes the matching annotations from `/Annots`.

Breaking changes:

- `PdfCore` is now required by `stampPdfVisibleSignatures`, `createPdfStampPreview`, `createIllustrativePdf`, `loadPdfSignatureDocument`, `createPdfSignatureTemplateFromBytes`, and `createPdfSignatureBuilderStateFromBytes`.
- `layoutPdfSignatureBadge(badge, container, regularFont, boldFont)` takes `PdfStandardFont` metrics; load them with the new `loadPdfStandardFont("Helvetica")` from `@signature-kit/pdf/stamp`.
- The pdf-lib `PDFPage` helpers `visiblePdfPageSize`, `pdfCoordinateTupleFromTopLeftRect`, and `topLeftRectFromPdfCoordinateTuple` are removed; use `visiblePdfPageSizeFromGeometry`, `pdfCoordinateTupleFromPdfPageGeometry`, and `topLeftRectFromPdfPageGeometry` with the `cropBox` and `rotate` of a `PdfCore.document` page.
- `isSafePdfStampPng` now requires `PdfCore`.
- `PdfWorker.preview` is typed as `(input) => Effect<Uint8Array, PdfError>` instead of the type of `createPdfStampPreview`.

### ITI conformance tests

The `@signature-kit/iti` tests build and tamper with PDFs through `PdfCore` and no longer depend on pdf-lib. The local conformance suites run over both classic cross-reference tables and object-stream PDFs with cross-reference streams.

# Changelog

## 0.1.0

- Initial release of the in-house WASM PDF core: page geometry, link annotations, and positioned text inspection through a tiny C ABI.
