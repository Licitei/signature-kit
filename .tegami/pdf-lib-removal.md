---
packages:
  "@signature-kit/pdf-core": minor
  "@signature-kit/pdf": minor
  "@signature-kit/iti": patch
---

## PNG images, blank documents, font metrics, and link URIs in the in-house core

`@signature-kit/pdf-core` gains what stamping needs to stop depending on pdf-lib. The `png` edit operation decodes a PNG (every color type and bit depth, Adam7 interlacing, palette and `tRNS` transparency) into an 8-bit image XObject with an `/SMask` when any pixel is not opaque; input is bounded to 16 MiB, 16 Mi pixels, and 64 MiB of decoded scanlines. `PdfCore.create({ pages })` writes a new document with blank pages, and `PdfCore.fontMetrics(baseFont)` returns the WinAnsi Unicode mapping and advance widths of the twelve WinAnsi standard-14 fonts. `PdfCore.document` now reports the `uri` of link annotations with a URI action (document payload version 2). The wasm module exports two new functions, `pdf_core_create` and `pdf_core_font_metrics`.

## `@signature-kit/pdf` no longer uses pdf-lib

`@cantoo/pdf-lib` is no longer a dependency. Visible signatures, structured badges, QR codes, initials and line rubrics, PNG images, footer links, stamp previews, and illustrative documents are drawn as content streams appended through `PdfCore.edit`, with the same geometry as before; signed PDFs are always updated incrementally, unsigned ones incrementally unless their cross-reference chain needs a rewrite. Text is measured with the Helvetica metrics from `PdfCore.fontMetrics` and drawn with WinAnsi encoding (Latin-1 plus €, typographic quotes, and dashes); text with characters outside WinAnsi fails with `pdf.STAMP_FAILED`, as it did before. Badge layout no longer adds kerning to measured widths that were drawn without it, so badge text and footer separators sit where they are drawn. `mergePdfs` uses `PdfCore.merge`, and `removePdfLinkAnchors` removes the matching annotations from `/Annots`.

Breaking changes:

- `PdfCore` is now required by `stampPdfVisibleSignatures`, `createPdfStampPreview`, `createIllustrativePdf`, `loadPdfSignatureDocument`, `createPdfSignatureTemplateFromBytes`, and `createPdfSignatureBuilderStateFromBytes`.
- `layoutPdfSignatureBadge(badge, container, regularFont, boldFont)` takes `PdfStandardFont` metrics; load them with the new `loadPdfStandardFont("Helvetica")` from `@signature-kit/pdf/stamp`.
- The pdf-lib `PDFPage` helpers `visiblePdfPageSize`, `pdfCoordinateTupleFromTopLeftRect`, and `topLeftRectFromPdfCoordinateTuple` are removed; use `visiblePdfPageSizeFromGeometry`, `pdfCoordinateTupleFromPdfPageGeometry`, and `topLeftRectFromPdfPageGeometry` with the `cropBox` and `rotate` of a `PdfCore.document` page.
- `PdfWorker.preview` is typed as `(input) => Effect<Uint8Array, PdfError>` instead of the type of `createPdfStampPreview`.

## ITI conformance tests

The `@signature-kit/iti` tests build and tamper with PDFs through `PdfCore` and no longer depend on pdf-lib.
