## @signature-kit/iti@0.3.0

### OpenTelemetry spans for every public operation

Public operations now run inside named Effect spans, for example `pdfCore.text`, `pdf.sign`, `crypto.pkcs12.parse` and `assinafy.reconcile`. PDF core calls split into `pdfCore.wasm.copyIn`, `pdfCore.wasm.run` and `pdfCore.wasm.decode`. HTTP calls are client spans with method, status and server attributes. Attributes record sizes, counts and algorithm or status literals, never document content, certificate identity, secrets or URLs with paths. No new runtime dependency: provide `@effect/opentelemetry` at the app boundary to export spans. See the OpenTelemetry tracing recipe.

## @signature-kit/iti@0.2.1

### Faster selected-page and Markdown PDF extraction

The PDF core opens selected pages without materializing the whole page tree, defers unused XObjects, and accepts complete streams before the next cross-reference offset. Markdown rendering reuses buffers and the number parser uses bounded accumulation for common operands. Page resources share the resolved dictionary across readers, and the JavaScript bindings share result-block validation and disposal.

The pdf-core README documents the procurement corpus results, evidence audit, Wasm size, and an isolated benchmark against LiteParse and PDF Inspector. This release also refreshes all public SignatureKit packages.

## @signature-kit/iti@0.2.0

### PDF writing and signature analysis in the in-house core

`@signature-kit/pdf-core` now writes PDFs. `PdfCore.edit(pdf, operations, options)` applies typed edit operations (set or add objects and streams, dictionary and array edits, flag ORs, page content with `q`/`Q` wrapping, page resources, image XObjects with soft masks, standard-14 fonts, signature dictionaries with `/ByteRange` and `/Contents` placeholders, catalog repair) and serializes the result either as an incremental update that leaves the original bytes untouched (classic table or xref stream, chained with `/Prev`) or as a full rewrite with renumbered objects and optional object streams. `PdfCore.merge` copies selected pages from several documents, `PdfCore.document` describes pages, annotations, signature slots, and the next free signature field name, and `PdfCore.deflate` exposes the new in-house zlib encoder. Invalid edit requests fail with `pdfCore.INVALID_OPTIONS`.

`PdfCore.signatures(pdf, analysis)` and `PdfCore.revisionComplete(pdf, end)` port the signature and revision analysis that `@signature-kit/pdf` previously ran on pdf-lib's parser internals: signature dictionaries with exact `/ByteRange` and `/Contents` offsets, per-revision indirect stream lengths, classic, xref-stream, and hybrid cross-reference sections, object streams (signature dictionaries are never packed into one), AcroForm reachability, and the same fail-closed limits (128 revisions, 1,024 signature dictionaries, 200,000 traversal steps). The wasm module exports six new functions; the ABI is documented in the README.

### PDF signing and verification run on the in-house core

`@signature-kit/pdf` no longer parses signatures or writes signature placeholders with pdf-lib. `signPdf` appends the signature dictionary, widget, AcroForm field, and `/SigFlags` as an incremental update, so the source bytes and every earlier signature stay valid; documents whose cross-reference chain fails the same completeness check the verifier applies are rewritten instead, and already signed documents always fail closed rather than being rewritten. Linearized documents, whose first-page cross-reference section points forward with `/Prev`, are accepted by both the writer and the verifier, so they are signed incrementally too.

The requirement `PdfCore` is added to `signPdf`, `verifyPdf`, `verifyPdfSignatures`, `mergePdfs`, `removePdfLinkAnchors`, `stampPdfVisibleSignature`, `stampPdfRubric`, `stampPdfRubricOnPages` (when `forIncrementalUpdate` is omitted), `signPdfSignatureField`, `signPdfSignatureBatch`, and `preparePdfSigningBatch`, and to the `@signature-kit/pdf/byte-range` helpers. `hasPdfByteRange` and `hasPdfSignatureDictionary` are now Effects. Provide `pdfCoreBrowserLayer` in the browser or `pdfCoreFileLayer` on Node and Bun; the PDF worker provides it inside the worker.

### ITI conformance

`validatePdfConformance` and `validatePdfWithIti` require `PdfCore` because they read signatures and revisions through `@signature-kit/pdf/byte-range`.

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

## @signature-kit/iti@0.1.1

### Simplify Effect programs

Use native void effects and value-discarding combinators while preserving public success, error, and dependency contracts. The workspace now enforces Effect correctness and selected simplification rules through the official Effect TypeScript-Go integration with Oxlint.

### Runtime updates and signature inspection

Update to stable Effect 4 and current compatible dependencies. Error classes use the native branded Schema.TaggedError constructor. Use TypeScript 7 for builds and checks with the official TypeScript 6 API compatibility alias. Upgrade direct ASN.1 dependencies to v4, interchange SDK values through DER, and encode timestamp requests with the native RFC 3161 schema. Packages do not require a consumer ASN.1 override.

Add per-signature PDF verification, certificate-validity inspection through the Effect clock, and cancellable polling for final request states in all five remote signers. Applications control polling deadlines and retry policy; a terminal request is not necessarily completed.

Update the documentation runtime, use the loading task for PDF.js cleanup, and fix dynamic Node routes by forwarding Request.duplex in the Hono adapter. Keep the app and Fumapress on a single Waku runtime.

Reject non-finite domain numbers, validate XML signature methods before WebCrypto verification, and preserve unexpected SDK failures as defects. Strengthen native Effect and accessibility lint checks.

Add branded PDF stamps with proportional PNG logos and handwriting, theme/title controls, and a PDF-rendered preview. Run browser PDF preparation and preview rendering through native Effect worker RPC with scoped termination and typed validation failures. Preserve caller buffers and signing dates across the worker boundary.

Fix structured batch stamp option conflicts, reject badges without usable drawing space, and prevent premeasured text from wrapping into adjacent rows. Restore signer interaction after React StrictMode mount replay and register localized Fumapress demo routes through the framework's native locale option. Add real worker, StrictMode, PDF text-stream, cropped/rotated page, cancellation, and invalid-image regressions.

# @signature-kit/iti

## 0.1.0

- Initial release with the local ITI PAdES ICP-Brasil conformance validator and
  the remote validar.iti.gov.br client, built on the split
  `@signature-kit/http` and `@signature-kit/signatures` packages after
  `@signature-kit/core` retirement.
