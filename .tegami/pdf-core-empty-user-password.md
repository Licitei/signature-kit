---
packages:
  "@signature-kit/pdf-core": minor
---

## Read PDFs with an empty opening password

PdfCore can inspect, extract text and tables, describe, render, and merge Standard Security PDFs that open with an empty user password. It supports RC4 revisions 2–4, AES-128 revision 4, and AES-256 revision 6. Merge and full edits produce an unencrypted PDF. The automatic edit mode rewrites encrypted inputs, including when preparing a first signature. An explicit incremental edit or an input requiring a nonempty user password fails with `pdfCore.ENCRYPTED_PDF`.
