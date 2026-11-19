import { describe, expect, it } from "vitest";

import { loadPdfCoreNode } from "../dist/node.js";

const stream = (dict: string, data: string) =>
  `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;
const native = "BT /F1 10 Tf 1 0 0 1 10 50 Tm (Native text) Tj ET";
const scan = "q 100 0 0 100 0 0 cm /Scan Do Q";

const scannedPdf = (contents: ReadonlyArray<string>) => {
  const kids = contents.map((_, index) => `${5 + index * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${contents.length} /Kids [${kids}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(
      "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
      "X",
    ),
    ...contents.flatMap((content, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents ${6 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Scan 4 0 R >> >> >>`,
      stream("", content),
    ]),
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return String(offset).padStart(10, "0");
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${offset} 00000 n \n`).join("");
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

describe("PdfCore.pageDiagnostics", () => {
  it("distinguishes a native cover, scans, invisible OCR and empty pages", async () => {
    const core = await loadPdfCoreNode();
    const pdf = scannedPdf([native, scan, `${scan} q 3 Tr ${native} Q`, ""]);
    const diagnostics = await core.pageDiagnostics(pdf);
    expect(diagnostics).toMatchObject([
      { pageIndex: 0, glyphs: 11, unmapped: 0, visibleChars: 10, textLayer: "usable" },
      { pageIndex: 1, rasterCoverage: 1, imageCount: 1, glyphs: 0, textLayer: "none" },
      {
        pageIndex: 2,
        rasterCoverage: 1,
        glyphs: 11,
        invisible: 11,
        textArea: 0,
        textLayer: "weak",
      },
      { pageIndex: 3, rasterCoverage: 0, glyphs: 0, textLayer: "none" },
    ]);
    expect(diagnostics[0]?.textArea).toBeGreaterThan(0);
    expect((await core.text(pdf))[2]).toContain("Native text");
    await expect(core.pageDiagnostics(pdf, { pageIndexes: [99] })).rejects.toMatchObject({
      operation: "pdfCore.pageDiagnostics",
      code: "pdfCore.INVALID_PDF",
    });
  });

  it("counts clipped and white text and deduplicates overlapping image and glyph area", async () => {
    const core = await loadPdfCoreNode();
    const clipped = `q 0 0 10 10 re W n ${native} Q`;
    const white = `q 1 g ${native} Q`;
    const strips = "q 55 0 0 100 0 0 cm /Scan Do Q q 55 0 0 100 20 0 cm /Scan Do Q";
    const inline = "q 25 0 0 100 75 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID X EI Q";
    const pdf = scannedPdf([native, `${native} ${native} ${clipped} ${white} ${strips}`, inline]);
    const [single, multiple, inlinePage] = await core.pageDiagnostics(pdf);
    expect(multiple).toMatchObject({
      glyphs: 44,
      visibleChars: 20,
      invisible: 22,
      imageCount: 2,
      rasterCoverage: 0.75,
      textArea: single?.textArea,
    });
    expect(inlinePage).toMatchObject({ imageCount: 1, rasterCoverage: 0.25 });
  });

  it("reads only selected page content through the lazy range source", async () => {
    const core = await loadPdfCoreNode();
    const pdf = scannedPdf([native, scan, " ".repeat(384 * 1024)]);
    await using doc = await core.openLazy(
      {
        size: pdf.byteLength,
        read: (offset, length) => pdf.subarray(offset, offset + length),
      },
      { probeBytes: 512, gapBytes: 0 },
    );
    const selection = { pageIndexes: [1] };
    expect(await doc.pageDiagnostics(selection)).toEqual(
      await core.pageDiagnostics(pdf, selection),
    );
    const stats = await doc.stats();
    expect(stats.strategy).toBe("lazy");
    expect(stats.bytesRead).toBeLessThan(pdf.byteLength / 4);
  });
});
