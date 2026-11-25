---
packages:
  "@signature-kit/pdf-core": minor
---

## Read complete books and other very large PDFs

`PdfCore.text`, `markdown`, `inspect` and `render` failed with `pdfCore.LIMIT_EXCEEDED` ("page count exceeds limit") on documents above 10,000 pages, and full-text extraction also stopped at 4 MB of text or 100,000 text items. A 19,004-page novel (41 MB, 24.8 million characters) could not be opened at all.

The default limits now allow 1,000,000 pages, 512 MB of extracted text, 50,000,000 text items in total and 100,000 per page. Byte, object, nesting and decoded-stream limits are unchanged, so malformed or hostile files are still bounded. That novel now extracts in about 6 seconds on Linux x64 (0.32 ms per page), and its first page renders in about 70 ms.
