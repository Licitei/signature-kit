---
packages:
  "@signature-kit/pdf-core": patch
  "@signature-kit/pdf": patch
---

## Sign already-signed PDFs with trailing bytes, and name damaged ones

Already-signed PDFs are stamped and signed through incremental updates so earlier signatures stay valid. When such a file had bytes after its final `%%EOF` (a download footer, for example), stamping failed with `pdf.STAMP_FAILED` and the reason `incremental update needs an intact cross-reference chain`. `PdfCore.edit` in incremental mode now drops the bytes after the final `%%EOF`, which no signature covers, and appends the update to the intact revision, so the earlier signatures stay valid.

Signed files whose cross-reference chain is damaged in other ways still cannot take an incremental update without invalidating their signatures. They now fail with `pdfCore.DAMAGED_XREF`, whose reason says what is wrong: bytes before the `%PDF` header, no `startxref`, a cross-reference table that had to be rebuilt, or an incomplete revision. Stamping and placeholder insertion report these failures as `pdf.DAMAGED_SIGNED_PDF`, with a message that asks the user to download the document again from its original source, instead of `pdf.STAMP_FAILED` or `pdf.INVALID_PDF`.
