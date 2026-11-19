import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { loadPdfCoreNode } from "../dist/node.js";

const stream = (dict: string, data: string) =>
  `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;
const native = "BT /F1 10 Tf 1 0 0 1 10 50 Tm (Native text) Tj ET";
const scan = "q 100 0 0 100 0 0 cm /Scan Do Q";

const rawImage =
  "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8";

const scannedPdf = (
  contents: ReadonlyArray<string>,
  image = stream(rawImage, "X"),
  pageOptions = "",
) => {
  const kids = contents.map((_, index) => `${5 + index * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${contents.length} /Kids [${kids}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    image,
    ...contents.flatMap((content, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] ${pageOptions} /Contents ${6 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Scan 4 0 R >> >> >>`,
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
  return Uint8Array.from(Buffer.from(pdf, "latin1"));
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

  it("counts missing glyph mappings and replacement characters from ActualText", async () => {
    const core = await loadPdfCoreNode();
    const marked = `/Span << /ActualText <FEFFD800> >> BDC ${native} EMC`;
    const missingFont = native.replace("/F1", "/Missing");
    const pdf = scannedPdf([marked, missingFont]);
    expect(await core.pageDiagnostics(pdf)).toMatchObject([
      { glyphs: 11, unmapped: 0, replacement: 1, visibleChars: 0, textLayer: "weak" },
      { glyphs: 11, unmapped: 11, replacement: 0, visibleChars: 0, textLayer: "weak" },
    ]);
  });

  it("distinguishes sparse stamps on graphical pages from readable text with invisible duplicates", async () => {
    const core = await loadPdfCoreNode();
    const smallText = native.replace("10 Tf", "5 Tf");
    const stamp = `q 100 0 0 65 0 0 cm /Scan Do Q ${smallText}`;
    const outlined = `0 10 m 5 10 5 15 10 15 c f `.repeat(1024) + smallText;
    const rows = Array.from(
      { length: 7 },
      (_, row) => `BT /F1 7 Tf 8 ${10 + row * 12} Td (abcdefghijklmnopqrstuv) Tj ET`,
    ).join(" ");
    const pdf = scannedPdf([stamp, outlined, `${rows} q 3 Tr ${rows} ${rows} Q`, native]);
    expect((await core.pageDiagnostics(pdf)).map(({ textLayer }) => textLayer)).toEqual([
      "weak",
      "weak",
      "usable",
      "usable",
    ]);
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

const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AN/R9RvoNEsIYby4jijt41RElYKoCgAAA8Cv/9k=",
  "base64",
);

describe("PdfCore.pageImages", () => {
  it("passes JPEG bytes through and reports placement, DPI, rotation and Decode metadata", async () => {
    const core = await loadPdfCoreNode();
    const image = stream(
      "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Decode [1 0]",
      jpeg.toString("latin1"),
    );
    const placed = "q 0 100 -100 0 100 0 cm /Scan Do Q";
    const pdf = scannedPdf(
      [native, placed, " ".repeat(384 * 1024)],
      image,
      "/Rotate 90 /UserUnit 2",
    );
    const options = { pageIndexes: [0, 1], format: "gray" } satisfies Parameters<
      typeof core.pageImages
    >[1];
    const results = await core.pageImages(pdf, options);
    expect(results).toEqual([
      { pageIndex: 0, kind: "none", reason: "no-dominant-image" },
      {
        pageIndex: 1,
        kind: "image",
        mediaType: "image/jpeg",
        bytes: Uint8Array.from(jpeg),
        width: 2,
        height: 2,
        dpiX: 0.72,
        dpiY: 0.72,
        placement: [0, 100, -100, 0, 100, 0],
        coverage: 1,
        rotate: 90,
        jpegDecode: [1, 0],
        jpegCmyk: false,
      },
    ]);
    await using doc = await core.openLazy(
      {
        size: pdf.length,
        read: (offset, length) => pdf.subarray(offset, offset + length),
      },
      { probeBytes: 512, gapBytes: 0 },
    );
    expect(await doc.pageImages(options)).toEqual(results);
    expect(
      await doc.text({
        pageIndexes: [0, 1],
        ocr: {
          render: () => Promise.reject("The dominant JPEG must bypass rendering"),
          recognize: async (request) => {
            expect(request).toMatchObject({
              pageIndex: 1,
              rotate: 90,
              placement: [0, 100, -100, 0, 100, 0],
              jpegDecode: [1, 0],
              image: { mediaType: "image/jpeg", dpiX: 0.72, dpiY: 0.72 },
            });
            expect(request.image.bytes).toEqual(Uint8Array.from(jpeg));
            return {
              kind: "words",
              width: 2,
              height: 2,
              words: [{ text: "Scan", box: [0, 0, 2, 1] }],
            };
          },
        },
      }),
    ).toEqual(["Native text", "Scan"]);
    expect(await doc.stats()).toMatchObject({ strategy: "lazy" });
    expect((await doc.stats()).bytesRead).toBeLessThan(pdf.length / 4);
  });

  it("round-trips Flate gray and Group 4 fax pixels through PNG and raw gray", async () => {
    const core = await loadPdfCoreNode();
    const samples = [
      {
        dictionary: "/Width 2 /Height 1 /BitsPerComponent 8 /Filter /FlateDecode",
        data: deflateSync(Uint8Array.of(3, 211)),
        expected: [3, 211],
        encoded: [0, 3, 211],
      },
      {
        dictionary:
          "/Width 2 /Height 1 /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 2 /Rows 1 >>",
        data: Buffer.from([0x23, 0xa0]),
        expected: [255, 0],
        encoded: [0, 128],
      },
    ];
    for (const { dictionary, data, expected, encoded } of samples) {
      const pdf = scannedPdf(
        [scan],
        stream(
          `/Type /XObject /Subtype /Image /ColorSpace /DeviceGray ${dictionary}`,
          data.toString("latin1"),
        ),
      );
      const [png] = await core.pageImages(pdf);
      const [gray] = await core.pageImages(pdf, { format: "gray" });
      if (png?.kind !== "image" || gray?.kind !== "image") {
        return expect.fail("Expected both PNG and gray raster results");
      }
      expect(png.mediaType).toBe("image/png");
      expect(
        await core.text(pdf, {
          ocr: {
            recognize: async ({ image }) => {
              expect(image.mediaType).toBe("image/png");
              expect(image.bytes).toEqual(png.bytes);
              return { kind: "text", text: "Recognized" };
            },
          },
        }),
      ).toEqual(["Recognized"]);
      expect(gray.mediaType).toBe("application/octet-stream");
      expect(Array.from(gray.bytes)).toEqual(expected);
      expect(await core.pngSize(png.bytes)).toMatchObject({ width: 2, height: 1 });
      const pngBytes = Buffer.from(png.bytes);
      const payload = pngBytes.indexOf("IDAT") + 4;
      const length = pngBytes.readUInt32BE(payload - 8);
      expect(Array.from(inflateSync(pngBytes.subarray(payload, payload + length)))).toEqual(
        encoded,
      );
    }
  });

  it("reports unsupported dominant filters and requires one dominant placement", async () => {
    const core = await loadPdfCoreNode();
    const strips = "q 100 0 0 50 0 0 cm /Scan Do Q q 100 0 0 50 0 50 cm /Scan Do Q";
    const clipped = "q 0 0 80 100 re W n 100 0 0 100 0 0 cm /Scan Do Q";
    const shear = "q 100 0 100 100 0 0 cm /Scan Do Q";
    const pdf = scannedPdf(
      [scan, strips, clipped, shear],
      stream(`${rawImage} /Filter /JBIG2Decode`, "X"),
    );
    expect(await core.pageImages(pdf)).toEqual([
      { pageIndex: 0, kind: "none", reason: "unsupported-filter" },
      { pageIndex: 1, kind: "none", reason: "no-dominant-image" },
      { pageIndex: 2, kind: "none", reason: "no-dominant-image" },
      { pageIndex: 3, kind: "none", reason: "no-dominant-image" },
    ]);
    expect((await core.pageDiagnostics(pdf))[3]?.rasterCoverage).toBeCloseTo(0.5, 10);
  });
});
