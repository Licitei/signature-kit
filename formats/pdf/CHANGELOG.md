## @signature-kit/pdf@0.6.1

### Faster selected-page and Markdown PDF extraction

The PDF core opens selected pages without materializing the whole page tree, defers unused XObjects, and accepts complete streams before the next cross-reference offset. Markdown rendering reuses buffers and the number parser uses bounded accumulation for common operands. Page resources share the resolved dictionary across readers, and the JavaScript bindings share result-block validation and disposal.

The pdf-core README documents the procurement corpus results, evidence audit, Wasm size, and an isolated benchmark against LiteParse and PDF Inspector. This release also refreshes all public SignatureKit packages.

## @signature-kit/pdf@0.6.0

### Verify signatures encoded with indefinite-length BER

Signature `/Contents` encoded as indefinite-length BER (`30 80 …`), as produced by common ICP-Brasil signing tools, no longer fail with `cms.DECODE_ERROR`. The signature length is now measured by walking the BER structure up to its end-of-contents octets instead of trimming trailing zero bytes, which used to strip those octets. Non-zero bytes after the signature still fail closed.

### Page rendering in the in-house core

`PdfCore.renderPages(pdf, { pageIndexes, scale })` renders pages into compact display lists (a new `pdf_core_render` wasm export), and the new browser module `@signature-kit/pdf-core/canvas` paints them with Canvas 2D: `renderDisplayListImage` returns a PNG `Blob` per page (JPEG or WebP on request, oversized pages clamped to the canvas limits), `paintDisplayList` returns an `Effect` that draws into any 2D context and fails with a typed error on malformed display lists, and `prepareDisplayListImages` decodes the page images into a scoped map whose bitmaps are closed with the scope. The renderer covers paths, clipping, line styles, every PDF colour space (tint transforms included), Form XObjects, raster images (Rust-decoded samples with soft masks, mattes and colour keys, browser-decoded JPEG, Rust-decoded CCITT Group 3/4), axial and radial shadings, shading patterns, embedded TrueType, CFF, OpenType and Type 1 glyph outlines, Type 3 fonts, standard-font text runs, and annotation appearance streams. Optional content (OFF groups, OCMDs, `BDC /OC`, XObject and annotation `/OC`) is honoured, `/Interpolate` decides image smoothing so upscaled 1-bit images stay crisp, and clip render modes with standard fonts clip to glyph boxes. JPX and JBIG2 images draw a grey placeholder; mesh shadings, tiling patterns and soft masks are approximated. Glyph outlines, Type 3 glyphs and Form XObjects run under per-glyph and per-page work budgets, and decoded forms, Type 3 glyph programs and colour spaces are cached per document. Large images are downsampled to the render scale inside the core. New error code `pdfCore.PAINT_FAILED` (en-US/pt-BR messages included).

### LiteParse removed

`@signature-kit/pdf/liteparse-browser` is replaced by `@signature-kit/pdf/render-browser`. `renderPdfPagesBrowser(pdf, { pageIndexes?, scale? })` now requires the `PdfPageRenderer` service instead of `LiteParseWorkerFactory`: `pdfPageRendererWorkerLayer({ timeoutMillis? }, create?)` renders in a dedicated Web Worker with a per-request time limit (default 30 s) that terminates and replaces a stuck worker and fails with the new `pdf.RENDER_TIMEOUT` code, and `pdfPageRendererLayer` renders on the current thread from `PdfCore`. It renders through the in-house core and returns `{ pageIndex, width, height, image }` with a PNG `Blob` instead of `{ pageNum, imageBytes }`. `liteParseWorkerBrowserLayer`, `LiteParseWorkerFactory` and the LiteParse worker protocol are gone (`PdfRenderRequests` and `pdfPageRendererHandlersLayer` serve the new worker), and `@llamaindex/liteparse-wasm` is no longer a dependency. `PdfHandwriting` and `pdfHandwritingBrowserLayer` move to the same subpath. Render failures use the new `pdf.page.render` operation.

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

### PDF page copying and encrypted document errors

Use `mergePdfs(pdfs, { signedSources: "flatten" })` to create an unsigned preview from signed PDFs. It removes signature widgets and form metadata while retaining stamps drawn into the page content. Merge still rejects signed sources by default.

Use `extractPdfPages(pdf, pageIndexes)` to copy a non-empty selection of zero-based pages into a new PDF.

PDF preparation, stamping, text-anchor search, and page copying now expose `pdf.ENCRYPTED_PDF` for encrypted inputs, with English and Brazilian Portuguese messages.

### Text anchors run on the in-house WASM core

`findPdfTextAnchors`, `prepareAndSignPdf`, and `preparePdfVisualPreview` now read page geometry, text items, and link annotations through `@signature-kit/pdf-core` instead of LiteParse. There is no per-document worker and no 5 s cap, and text and digit anchors also work in Node and Bun.

The requirement `LiteParseWorkerFactory` becomes `PdfCore`: provide `pdfCoreBrowserLayer` in the browser or `pdfCoreFileLayer` on Node/Bun. Calls that pass `pages` and `textBoxes` with only `text`/`digits` matchers still need no service. `parsePdfTextBoxesBrowser` and the LiteParse text-result schemas are removed.

`findPdfTextAnchors` reports documents that exceed a pdf-core processing limit as the new `pdf.LIMIT_EXCEEDED` error code (en-US/pt-BR messages included) instead of `pdf.INVALID_PDF`.

## @signature-kit/pdf@0.5.0

### Link-annotation signature anchors

Text anchors accept a `{ link: "<uri>" }` matcher. It places the stamp from the rectangle of a PDF link annotation with that URI, read directly from the document instead of parsed text, so generated PDFs can mark the signature spot without loading LiteParse or hitting its per-document parse timeout. Crop boxes and page rotation are respected.

`prepareAndSignPdf` removes the matched link annotation, and its URI action, before stamping, so the signed PDF keeps no clickable anchor. PDFs that already carry a signature are left untouched to preserve earlier byte ranges.

## @signature-kit/pdf@0.4.0

### Runtime updates and signature inspection

Update to stable Effect 4 and current compatible dependencies. Error classes use the native branded Schema.TaggedError constructor. Use TypeScript 7 for builds and checks with the official TypeScript 6 API compatibility alias. Upgrade direct ASN.1 dependencies to v4, interchange SDK values through DER, and encode timestamp requests with the native RFC 3161 schema. Packages do not require a consumer ASN.1 override.

Add per-signature PDF verification, certificate-validity inspection through the Effect clock, and cancellable polling for final request states in all five remote signers. Applications control polling deadlines and retry policy; a terminal request is not necessarily completed.

Update the documentation runtime, use the loading task for PDF.js cleanup, and fix dynamic Node routes by forwarding Request.duplex in the Hono adapter. Keep the app and Fumapress on a single Waku runtime.

Reject non-finite domain numbers, validate XML signature methods before WebCrypto verification, and preserve unexpected SDK failures as defects. Strengthen native Effect and accessibility lint checks.

Add branded PDF stamps with proportional PNG logos and handwriting, theme/title controls, and a PDF-rendered preview. Run browser PDF preparation and preview rendering through native Effect worker RPC with scoped termination and typed validation failures. Preserve caller buffers and signing dates across the worker boundary.

Fix structured batch stamp option conflicts, reject badges without usable drawing space, and prevent premeasured text from wrapping into adjacent rows. Restore signer interaction after React StrictMode mount replay and register localized Fumapress demo routes through the framework's native locale option. Add real worker, StrictMode, PDF text-stream, cropped/rotated page, cancellation, and invalid-image regressions.

# Changelog

## 0.3.0

- Export English and pt-BR `pdfErrorMessages` catalogs for code-keyed display
  copy.
- Add vector QR-code support to visible signature stamps, enabling ITI validator
  links without raster images in Node and browser PDF flows.
- Add a structured digital-signature badge stamp layout with QR, rounded
  Brazilian-government-style framing, legal footer text, and URI link
  annotations.
- Add package-owned PDF DX helpers: text-anchor placement, `prepareAndSignPdf`,
  vector initials rubrics with `deriveSignerInitials`, `mergePdfs`, and a
  bottom-right default signature rectangle helper.
- Use the pinned ICP-Brasil AD-RB policy metadata by default for
  `policy: "pades-icp-brasil"`, and reserve 32768 `/Contents` bytes for that
  policy unless callers set `signatureLength` explicitly.
- Security: `verifyPdf` rejects ByteRange signatures that do not start at byte 0
  or whose newest signature does not cover the file end, blocking
  signature-exclusion forgeries.
- Security: `verifyPdf` verifies every PDF signature in the file, not only the
  newest incremental revision, and reports the worst `revocationStatus` across
  all signatures.
- Treat `valid` as chain-valid when `trustedRoots` are supplied; a trusted root
  set now makes `valid` require successful chain verification.
- Detect `/ByteRange` when any PDF whitespace appears between the name and `[`,
  allowing third-party PDFs with non-space formatting to verify and preserving
  incremental re-signing for them.
- Preserve existing signatures when signing an already-signed PDF by adding the
  new signature as an incremental update.
- Enforce the unsigned `/Contents` hole by requiring `<`/`>` delimiters, failing
  closed on malformed hex, and allowing only zero padding after the DER
  signature.
- Verify multi-signature PDFs one signed range at a time instead of
  materializing every signed-range copy simultaneously.
- PAdES CMS output no longer emits the prohibited CMS `signingTime` signed
  attribute (OID 1.2.840.113549.1.9.5); ITI Validar
  (PA_PAdES_AD_RB_v1_1) now approves generated signatures. Signing time remains
  in the PDF dictionary `/M` entry.

Breaking: `policyTimeoutMillis` was removed from public PDF signing request
schemas.

Behavior change: PDFs that previously verified despite unsigned appended bytes
or a broken older signature now fail verification.

## 0.2.0

- Embed the ICP-Brasil certificate chain in the detached CMS.
- Surface `chainValid` and `revocationStatus` from CMS verification; `chainValid` is now
  `false` unless `trustedRoots` are supplied.

## 0.1.0

- Initial npm-ready release for `@signature-kit/pdf`.
- Published package metadata, MIT license, README, and package-local changelog.
- Ships PDF/PAdES document preparation, visible signature placement, stamping, signing, verification, and browser text-box extraction.
