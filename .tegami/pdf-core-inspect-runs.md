---
packages:
  "@signature-kit/pdf-core": minor
---

## Inspect text runs with bold and italic styles

`PdfCore.inspect` accepts `runs: true`: text items then also end where the bold/italic style changes, or where the text is repositioned more than 0.2 em past the last visible glyph, so report columns (`17/06/2026 15:39:26` and `MENSAGEM PREGOEIRO`) and bold labels come back as separate items with their own `x`. A piece drawn within that distance (a `™` from another font) stays in the same item, and `TJ` kerning never splits one. Every text page now carries `styles`, a `Uint8Array` with one byte per item (bit 0 bold, bit 1 italic), resolved from the embedded font program, the font name (also for non-embedded Standard 14 fonts such as `Helvetica-Bold`), the font descriptor, and fill-and-stroke rendering. Without `runs` an item can mix styles, so its bits cover only the style shared by all its glyphs. The inspect payload is version 3 (style bytes after the offsets) and the ABI adds flag bit 5.
