---
packages:
  "@signature-kit/pdf-core": minor
---

## Inspect text runs with bold and italic styles

`PdfCore.inspect` accepts `runs: true`: text items then also end where the text is repositioned away from the previous glyph or where the bold/italic style changes, so report columns (`17/06/2026 15:39:26` and `MENSAGEM PREGOEIRO`) and bold labels come back as separate items with their own `x`. A piece drawn exactly where the previous glyph ended (a `™` from another font) stays in the same item. Every text page now carries `styles`, a `Uint8Array` with one byte per item (bit 0 bold, bit 1 italic), resolved from the embedded font program, the font name (also for non-embedded Standard 14 fonts such as `Helvetica-Bold`), the font descriptor, and fill-and-stroke rendering. Without `runs` an item can mix styles, so its bits cover only the style shared by all its glyphs. The inspect payload is version 3 (style bytes after the offsets) and the ABI adds flag bit 5. On 40 BLL/BNC session minutes and proposal reports, the Licitei parsers give the same result as with LiteParse on 32 files; the other 8 differ where pdf-core keeps the document's own characters (double spaces, en dashes and curly quotes from embedded fonts without `ToUnicode`) or where LiteParse dropped lot headers and split numbers out of product names.
