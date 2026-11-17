---
packages:
  "@signature-kit/pdf-core": minor
---

## In-house WASM PDF core

New `@signature-kit/pdf-core` package: a zero-dependency Rust/WebAssembly PDF engine with page geometry, link annotations, and positioned text inspection. It exposes a `PdfCore` Effect service with browser and file-system layers and typed `PdfCoreError` failures.

### Tables, markdown and running headers

`PdfCore.tables(pdf, { pageIndexes })` returns structured tables per page: ruled grids from the content-stream path operators (CTM applied, collinear segments merged, clipping-only paths and page-sized frames ignored) and borderless tables from column alignment, with row/column indexes, merged-cell spans, boxes and cell text. `PdfCore.text` gains `format: "markdown"` (paragraph grouping on the plain-text reading order, hyphenation and page-break joins, headings from size, emphasis and numbering depth, bold/italic from the embedded font tables, nested lists that keep numbered and legal markers, link overlays, and GFM tables) and `dropRunningHeaders` (default `true`: headers and footers repeated on at least half of the pages are dropped; a line that is identical on every page keeps one copy on its first page). Ruled tables are now laid out cell by cell, which keeps headings below a table out of its last cell. Text extraction also honours marked-content `/ActualText`, clips glyphs outside a Form XObject `/BBox`, and keeps extracting text under clip render modes 4-7. `pdf_core_tables` is a new wasm export; `pdf_core_text` accepts the new `markdown` and `drop running headers` flags.

### Limits and performance

`inspect` now uses the same extraction limits as `text` and `tables`, so large documents (hundreds of pages, more than 100 000 text items) inspect instead of failing, and page limit violations in `text`/`tables` surface as `pdfCore.LIMIT_EXCEEDED` instead of silently empty pages. Inspect text `offsets` are UTF-16 code unit offsets into `text` (inspect payload version 2). Extraction is faster on long lines, repeated Form XObjects, Identity-H fonts and multi-page inspection, and overlapping ToUnicode/CMap/width ranges resolve to the latest definition.

### Markdown fidelity and speed

Markdown no longer drops text from borderless tables: a wrap line under a bold row that spans two columns ends the table instead of being discarded, and zero-width segments map to their column. With `dropRunningHeaders`, markdown also drops blocks that repeat at the same position among the first or last three blocks of at least max(3, pages / 20) pages (headers and footers outside the top and bottom bands, signature stamps), keeping the first occurrence. URLs broken across lines are rejoined without a space and keep their link, `?`/`&` ending a URL no longer ends a paragraph, trailing `. , ; )` move out of link text, and unspaced markers such as `c)Informar` or `10.10.Os` are recognised as list items and clauses. Plain text output is unchanged. Text extraction is about 20% faster natively and 30% faster in WebAssembly (no libm `mul_add`/`hypot`/`powi` calls, allocation-free inflate Huffman tables, per-TJ placement invariants, and a prefix-only inflate for the embedded-font style probe).
