---
packages:
  "@signature-kit/pdf": minor
---

## PDF page copying and encrypted document errors

Use `mergePdfs(pdfs, { signedSources: "flatten" })` to create an unsigned preview from signed PDFs. It removes signature widgets and form metadata while retaining stamps drawn into the page content. Merge still rejects signed sources by default.

Use `extractPdfPages(pdf, pageIndexes)` to copy a non-empty selection of zero-based pages into a new PDF.

PDF preparation, stamping, text-anchor search, and page copying now expose `pdf.ENCRYPTED_PDF` for encrypted inputs, with English and Brazilian Portuguese messages.
