---
packages:
  "@signature-kit/pdf-core": minor
  "@signature-kit/pdf": minor
---

## Page rendering in the in-house core

`PdfCore.renderPages(pdf, { pageIndexes, scale })` renders pages into compact display lists (a new `pdf_core_render` wasm export), and the new browser module `@signature-kit/pdf-core/canvas` paints them with Canvas 2D: `renderDisplayListImage` returns a PNG `Blob` per page, `paintDisplayList` draws into any 2D context, and `prepareDisplayListImages` decodes the page images first. The renderer covers paths, clipping, line styles, every PDF colour space (tint transforms included), Form XObjects, raster images (Rust-decoded samples with soft masks, mattes and colour keys, browser-decoded JPEG, Rust-decoded CCITT Group 3/4), axial and radial shadings, shading patterns, embedded TrueType, CFF, OpenType and Type 1 glyph outlines, Type 3 fonts, standard-font text runs, and annotation appearance streams. JPX and JBIG2 images draw a grey placeholder; mesh shadings, tiling patterns and soft masks are approximated. Large images are downsampled to the render scale inside the core. New error code `pdfCore.PAINT_FAILED` (en-US/pt-BR messages included).

## LiteParse removed

`@signature-kit/pdf/liteparse-browser` is replaced by `@signature-kit/pdf/render-browser`. `renderPdfPagesBrowser(pdf, { pageIndexes?, scale? })` now requires `PdfCore` (provide `pdfCoreBrowserLayer`) instead of `LiteParseWorkerFactory`, renders through the in-house core, and returns `{ pageIndex, width, height, image }` with a PNG `Blob` instead of `{ pageNum, imageBytes }`. `liteParseWorkerBrowserLayer`, `LiteParseWorkerFactory`, the worker protocol and the 5 s worker timeout are gone, and `@llamaindex/liteparse-wasm` is no longer a dependency. `PdfHandwriting` and `pdfHandwritingBrowserLayer` move to the same subpath. Render failures use the new `pdf.page.render` operation.
