---
packages:
  "@signature-kit/pdf-core": patch
---

## Repair missing PDF catalog types during edits

When an edit writes the document catalog, the PDF core adds a missing `/Type /Catalog` in the same revision. Signing includes the repaired catalog in the bytes covered by the signature.
