---
packages:
  "@signature-kit/pdf-core": minor
  "@signature-kit/docs": patch
---

## takumi-pdf generation for signature anchors

Adds `takumi-pdf` 0.20.0 for PDF generation in the docs registry and pdf-core regression corpus. The shadcn `pdf-signature-anchor` registry item now ships invisible text (`{{signature}}`) and URI link (`https://signature.invalid/anchor`) markers for `findPdfTextAnchors`. Committed fixture `takumi-declaration.pdf` with golden anchor metadata exercises multi-page Portuguese copy, Liberation fonts, and paginated footers. Generation benchmarks compare takumi-pdf vs react-pdf under `shared/pdf-core/bench/`. `@react-pdf/renderer` is removed from `apps/docs`; react-pdf preview (`signature-pdf-viewer`) is unchanged.
