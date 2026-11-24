## @signature-kit/react@0.2.0

### OpenTelemetry spans for every public operation

Public operations now run inside named Effect spans, for example `pdfCore.text`, `pdf.sign`, `crypto.pkcs12.parse` and `assinafy.reconcile`. PDF core calls split into `pdfCore.wasm.copyIn`, `pdfCore.wasm.run` and `pdfCore.wasm.decode`. HTTP calls are client spans with method, status and server attributes. Attributes record sizes, counts and algorithm or status literals, never document content, certificate identity, secrets or URLs with paths. No new runtime dependency: provide `@effect/opentelemetry` at the app boundary to export spans. See the OpenTelemetry tracing recipe.

## @signature-kit/react@0.1.5

### Faster selected-page and Markdown PDF extraction

The PDF core opens selected pages without materializing the whole page tree, defers unused XObjects, and accepts complete streams before the next cross-reference offset. Markdown rendering reuses buffers and the number parser uses bounded accumulation for common operands. Page resources share the resolved dictionary across readers, and the JavaScript bindings share result-block validation and disposal.

The pdf-core README documents the procurement corpus results, evidence audit, Wasm size, and an isolated benchmark against LiteParse and PDF Inspector. This release also refreshes all public SignatureKit packages.

## @signature-kit/react@0.1.4

### Text anchors run on the in-house WASM core

`findPdfTextAnchors`, `prepareAndSignPdf`, and `preparePdfVisualPreview` now read page geometry, text items, and link annotations through `@signature-kit/pdf-core` instead of LiteParse. There is no per-document worker and no 5 s cap, and text and digit anchors also work in Node and Bun.

The requirement `LiteParseWorkerFactory` becomes `PdfCore`: provide `pdfCoreBrowserLayer` in the browser or `pdfCoreFileLayer` on Node/Bun. Calls that pass `pages` and `textBoxes` with only `text`/`digits` matchers still need no service. `parsePdfTextBoxesBrowser` and the LiteParse text-result schemas are removed.

`findPdfTextAnchors` reports documents that exceed a pdf-core processing limit as the new `pdf.LIMIT_EXCEEDED` error code (en-US/pt-BR messages included) instead of `pdf.INVALID_PDF`.

## @signature-kit/react@0.1.2

### Link-annotation signature anchors

Text anchors accept a `{ link: "<uri>" }` matcher. It places the stamp from the rectangle of a PDF link annotation with that URI, read directly from the document instead of parsed text, so generated PDFs can mark the signature spot without loading LiteParse or hitting its per-document parse timeout. Crop boxes and page rotation are respected.

`prepareAndSignPdf` removes the matched link annotation, and its URI action, before stamping, so the signed PDF keeps no clickable anchor. PDFs that already carry a signature are left untouched to preserve earlier byte ranges.

## @signature-kit/react@0.1.1

### Runtime updates and signature inspection

Update to stable Effect 4 and current compatible dependencies. Error classes use the native branded Schema.TaggedError constructor. Use TypeScript 7 for builds and checks with the official TypeScript 6 API compatibility alias. Upgrade direct ASN.1 dependencies to v4, interchange SDK values through DER, and encode timestamp requests with the native RFC 3161 schema. Packages do not require a consumer ASN.1 override.

Add per-signature PDF verification, certificate-validity inspection through the Effect clock, and cancellable polling for final request states in all five remote signers. Applications control polling deadlines and retry policy; a terminal request is not necessarily completed.

Update the documentation runtime, use the loading task for PDF.js cleanup, and fix dynamic Node routes by forwarding Request.duplex in the Hono adapter. Keep the app and Fumapress on a single Waku runtime.

Reject non-finite domain numbers, validate XML signature methods before WebCrypto verification, and preserve unexpected SDK failures as defects. Strengthen native Effect and accessibility lint checks.

Add branded PDF stamps with proportional PNG logos and handwriting, theme/title controls, and a PDF-rendered preview. Run browser PDF preparation and preview rendering through native Effect worker RPC with scoped termination and typed validation failures. Preserve caller buffers and signing dates across the worker boundary.

Fix structured batch stamp option conflicts, reject badges without usable drawing space, and prevent premeasured text from wrapping into adjacent rows. Restore signer interaction after React StrictMode mount replay and register localized Fumapress demo routes through the framework's native locale option. Add real worker, StrictMode, PDF text-stream, cropped/rotated page, cancellation, and invalid-image regressions.

# Changelog

## Unreleased

- Rename the external-state subpath from `@signature-kit/react/builder` to `@signature-kit/react/sync-store` and reuse it in the docs app.
- Export Schema-first certificate snapshots, hook outcomes, signer rows, and signer snapshots from `@signature-kit/react/config`.

## 0.1.0

- Initial hooks-only package for React browser A1 signing.
- Adds headless browser A1 hooks: certificate loading, sequential PDF signing,
  and PDF object-URL lifecycle helpers.
- Publishes hooks and headless data seams only. UI components are distributed
  through the docs-hosted shadcn registry instead of an npm `components` export.
