---
packages:
  "@signature-kit/pdf": minor
  "@signature-kit/react": patch
---

## Text anchors run on the in-house WASM core

`findPdfTextAnchors`, `prepareAndSignPdf`, and `preparePdfVisualPreview` now read page geometry, text items, and link annotations through `@signature-kit/pdf-core` instead of LiteParse. There is no per-document worker and no 5 s cap, and text and digit anchors also work in Node and Bun.

The requirement `LiteParseWorkerFactory` becomes `PdfCore`: provide `pdfCoreBrowserLayer` in the browser or `pdfCoreFileLayer` on Node/Bun. Calls that pass `pages` and `textBoxes` with only `text`/`digits` matchers still need no service. `parsePdfTextBoxesBrowser` and the LiteParse text-result schemas are removed; `renderPdfPagesBrowser` keeps using the LiteParse worker for page thumbnails.

`findPdfTextAnchors` reports documents that exceed a pdf-core processing limit as the new `pdf.LIMIT_EXCEEDED` error code (en-US/pt-BR messages included) instead of `pdf.INVALID_PDF`.
