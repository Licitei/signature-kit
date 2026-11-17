import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { findPdfTextAnchors } from "../src/anchors";
import { PdfErrorCodeValue } from "../src/config";
import { pdfCoreTestLayer } from "./pdf-core-layer";

const page: ReadonlyArray<{ index: number; width: number; height: number }> = [
  { index: 0, width: 220, height: 120 },
];

const stampSize = { width: 80, height: 20 };

const findAnchorsForText = (text: string) =>
  findPdfTextAnchors({
    pages: page,
    textBoxes: [[{ text, x: 12, y: 12, width: 100, height: 12 }]],
    matchers: [{ digits: "12345678901" }],
    stampSize,
    placement: "below",
    offset: 0,
  });

describe("PDF digit anchor matching", () => {
  it.effect("does not match CPF digits when surrounded by CNPJ digits", () =>
    Effect.gen(function* () {
      const anchors = yield* findAnchorsForText("CNPJ 12.345.678/9012-34");

      expect(anchors).toHaveLength(0);
    }),
  );

  it.effect("does not match CPF digits in phone + date digit soup", () =>
    Effect.gen(function* () {
      const anchors = yield* findAnchorsForText("Telefone: (11) 2345-6789 01/01");

      expect(anchors).toHaveLength(0);
    }),
  );

  it.effect("matches a formatted CPF value", () =>
    Effect.gen(function* () {
      const anchors = yield* findAnchorsForText("123.456.789-01");

      expect(anchors).toHaveLength(1);
    }),
  );
});

describe("PDF text-anchor page identity", () => {
  it.effect("maps sparse unsorted pages through their declared indexes", () =>
    Effect.gen(function* () {
      const anchors = yield* findPdfTextAnchors({
        pages: [
          { index: 2, width: 300, height: 140 },
          { index: 0, width: 220, height: 120 },
        ],
        textBoxes: [
          [{ text: "first page", x: 12, y: 10, width: 100, height: 12 }],
          [],
          [{ text: "third page", x: 30, y: 20, width: 100, height: 12 }],
        ],
        matchers: [{ text: "page" }],
        stampSize,
        placement: "below",
        offset: 0,
      });

      expect(anchors).toStrictEqual([
        { pageIndex: 2, x: 30, y: 32, width: 80, height: 20 },
        { pageIndex: 0, x: 12, y: 22, width: 80, height: 20 },
      ]);
    }),
  );

  it.effect("rejects text boxes that do not cover declared page indexes", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        findPdfTextAnchors({
          pages: [{ index: 2, width: 300, height: 140 }],
          textBoxes: [[{ text: "third page", x: 30, y: 20, width: 100, height: 12 }]],
          matchers: [{ text: "page" }],
          stampSize,
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe("pdf.INVALID_BUILDER_INPUT");
        expect(result.failure.operation).toBe("pdf.text-anchor.find");
        expect(result.failure.schemaName).toBe("PdfTextAnchorSearchInput");
      }
    }),
  );
});

const oversizedPagePdf = (items: number): Uint8Array => {
  const lines = ["BT /F1 10 Tf"];
  for (let index = 0; index < items; index += 1) {
    lines.push(`1 0 0 1 ${Math.floor(index / 700) * 30} ${(index % 700) + 20} Tm (a) Tj`);
  }
  lines.push("ET");
  const content = lines.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: Array<number> = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

describe("PDF text-anchor processing limits", () => {
  it.effect("maps pdf-core limit violations to pdf.LIMIT_EXCEEDED", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        findPdfTextAnchors({
          pdf: oversizedPagePdf(250_001),
          matchers: [{ text: "a" }],
          stampSize,
          placement: "below",
        }),
      );
      expect(error.code).toBe(PdfErrorCodeValue.limitExceeded);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
