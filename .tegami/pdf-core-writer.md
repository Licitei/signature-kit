---
packages:
  "@signature-kit/pdf-core": minor
  "@signature-kit/pdf": minor
  "@signature-kit/iti": minor
---

## PDF writing and signature analysis in the in-house core

`@signature-kit/pdf-core` now writes PDFs. `PdfCore.edit(pdf, operations, options)` applies typed edit operations (set or add objects and streams, dictionary and array edits, flag ORs, page content with `q`/`Q` wrapping, page resources, image XObjects with soft masks, standard-14 fonts, signature dictionaries with `/ByteRange` and `/Contents` placeholders, catalog repair) and serializes the result either as an incremental update that leaves the original bytes untouched (classic table or xref stream, chained with `/Prev`) or as a full rewrite with renumbered objects and optional object streams. `PdfCore.merge` copies selected pages from several documents, `PdfCore.document` describes pages, annotations, signature slots, and the next free signature field name, and `PdfCore.deflate` exposes the new in-house zlib encoder. Invalid edit requests fail with `pdfCore.INVALID_OPTIONS`.

`PdfCore.signatures(pdf, analysis)` and `PdfCore.revisionComplete(pdf, end)` port the signature and revision analysis that `@signature-kit/pdf` previously ran on pdf-lib's parser internals: signature dictionaries with exact `/ByteRange` and `/Contents` offsets, per-revision indirect stream lengths, classic, xref-stream, and hybrid cross-reference sections, object streams, AcroForm reachability, and the same fail-closed limits (128 revisions, 1,024 signature dictionaries, 200,000 traversal steps). The wasm module exports six new functions; the ABI is documented in the README.

## PDF signing and verification run on the in-house core

`@signature-kit/pdf` no longer parses signatures or writes signature placeholders with pdf-lib. `signPdf` appends the signature dictionary, widget, AcroForm field, and `/SigFlags` as an incremental update, so the source bytes and every earlier signature stay valid; documents whose cross-reference chain needs repair are rewritten instead, and already signed documents always fail closed rather than being rewritten.

The requirement `PdfCore` is added to `signPdf`, `verifyPdf`, `verifyPdfSignatures`, `mergePdfs`, `removePdfLinkAnchors`, `stampPdfVisibleSignature`, `stampPdfRubric`, `stampPdfRubricOnPages` (when `forIncrementalUpdate` is omitted), `signPdfSignatureField`, `signPdfSignatureBatch`, and `preparePdfSigningBatch`, and to the `@signature-kit/pdf/byte-range` helpers. `hasPdfByteRange` and `hasPdfSignatureDictionary` are now Effects. Provide `pdfCoreBrowserLayer` in the browser or `pdfCoreFileLayer` on Node and Bun; the PDF worker provides it inside the worker.

## ITI conformance

`validatePdfConformance` and `validatePdfWithIti` require `PdfCore` because they read signatures and revisions through `@signature-kit/pdf/byte-range`.
