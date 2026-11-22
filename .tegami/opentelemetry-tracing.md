---
packages:
  "@signature-kit/pdf-core": minor
  "@signature-kit/http": minor
  "@signature-kit/signatures": minor
  "@signature-kit/certificates": minor
  "@signature-kit/crypto": minor
  "@signature-kit/cms": minor
  "@signature-kit/a1": minor
  "@signature-kit/assinafy": minor
  "@signature-kit/clicksign": minor
  "@signature-kit/documenso": minor
  "@signature-kit/docuseal": minor
  "@signature-kit/zapsign": minor
  "@signature-kit/pdf": minor
  "@signature-kit/react": minor
  "@signature-kit/xml": minor
  "@signature-kit/iti": minor
---

## OpenTelemetry spans for every public operation

Public operations now run inside named Effect spans, for example `pdfCore.text`, `pdf.sign`, `crypto.pkcs12.parse` and `assinafy.reconcile`. PDF core calls split into `pdfCore.wasm.copyIn`, `pdfCore.wasm.run` and `pdfCore.wasm.decode`. HTTP calls are client spans with method, status and server attributes. Attributes record sizes, counts and algorithm or status literals, never document content, certificate identity, secrets or URLs with paths. No new runtime dependency: provide `@effect/opentelemetry` at the app boundary to export spans. See the OpenTelemetry tracing recipe.
