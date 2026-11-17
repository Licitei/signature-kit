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
