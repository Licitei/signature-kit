---
packages:
  "@signature-kit/pdf": minor
  "@signature-kit/react": patch
---

## Link-annotation signature anchors

Text anchors accept a `{ link: "<uri>" }` matcher. It places the stamp from the rectangle of a PDF link annotation with that URI, read directly from the document instead of parsed text, so generated PDFs can mark the signature spot without loading LiteParse or hitting its per-document parse timeout. Crop boxes and page rotation are respected.

`prepareAndSignPdf` removes the matched link annotation, and its URI action, before stamping, so the signed PDF keeps no clickable anchor. PDFs that already carry a signature are left untouched to preserve earlier byte ranges.
