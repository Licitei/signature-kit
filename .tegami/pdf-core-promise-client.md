---
packages:
  "@signature-kit/pdf-core": minor
---

## Promise client for apps without Effect

`loadPdfCoreNode()` (`@signature-kit/pdf-core/node`) and `loadPdfCoreBrowser()` (`@signature-kit/pdf-core/promise`) load the WebAssembly module and return the `PdfCore` operations as Promises that reject with the `PdfCoreError`, so an app can use the engine without installing or importing `effect`. `createPdfCoreClient(module)` builds the same client from a compiled module, and `pdfCoreBrowserModule` exposes the browser module loader behind `pdfCoreBrowserLayer`.
