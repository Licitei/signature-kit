import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore, pdfCoreBytesSource } from "../dist/pdf-core.js";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const headingPdf = Effect.gen(function* () {
  const core = yield* PdfCore;
  const size = { width: 600, height: 600 };
  const blank = yield* core.create({ pages: [size, size, size] });
  const { nextObjectNumber: font } = yield* core.document(blank);
  const encoder = new TextEncoder();
  return yield* core.edit(blank, [
    { op: "standardFont", ref: { number: font, generation: 0 }, baseFont: "Helvetica" },
    { op: "standardFont", ref: { number: font + 1, generation: 0 }, baseFont: "Helvetica-Bold" },
    { op: "standardFont", ref: { number: font + 2, generation: 0 }, baseFont: "Helvetica-Oblique" },
    ...[0, 1, 2].flatMap(
      (pageIndex) =>
        [
          { op: "addResource", pageIndex, category: "Font", name: "F1", value: `${font} 0 R` },
          { op: "addResource", pageIndex, category: "Font", name: "F2", value: `${font + 1} 0 R` },
          { op: "addResource", pageIndex, category: "Font", name: "F3", value: `${font + 2} 0 R` },
        ] satisfies Parameters<typeof core.edit>[1],
    ),
    {
      op: "appendContent",
      pageIndex: 0,
      ref: { number: font + 3, generation: 0 },
      data: encoder.encode(
        "BT /F1 10 Tf 40 355 Td (See the Reference Guide and the Annual Report for details.) Tj ET " +
          "BT /F2 18 Tf 225 567 Td (LETTERHEAD) Tj ET " +
          "BT /F2 28 Tf 184 463 Td (PROJECT) Tj 150 0 Td (SUMMARY) Tj ET " +
          "BT /F3 12 Tf 40 395 Td (Prepared for review) Tj ET " +
          "BT /F1 10 Tf 40 240 Td (Common label) Tj ET",
      ),
    },
    {
      op: "appendContent",
      pageIndex: 1,
      ref: { number: font + 4, generation: 0 },
      data: encoder.encode(
        "BT /F2 18 Tf 226 567 Td (LETTERHEAD) Tj ET " +
          "BT /F1 10 Tf 40 350 Td (A different body on the second page.) Tj ET " +
          "BT /F1 10 Tf 41 241 Td (Common label) Tj ET",
      ),
    },
    { op: "set", target: { base: { kind: "page", pageIndex: 2 } }, key: "Rotate", value: "90" },
    {
      op: "set",
      target: { base: { kind: "page", pageIndex: 2 } },
      key: "CropBox",
      value: "[100 100 500 500]",
    },
    {
      op: "appendContent",
      pageIndex: 2,
      ref: { number: font + 5, generation: 0 },
      data: encoder.encode("BT /F2 20 Tf 0 1 -1 0 180 240 Tm (ROTATED TITLE) Tj ET"),
    },
  ]);
});

describe("PdfCore.headings", () => {
  it.effect("ranks a complete heading above body mentions and marks repeated lines", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = yield* headingPdf;
      const [first, second] = yield* core.headings(pdf, { pageIndexes: [0, 1, 0] });
      expect(first?.candidates[0]).toMatchObject({
        text: "PROJECT SUMMARY",
        fontSize: 28,
        bold: true,
        italic: false,
        uppercaseRatio: 1,
        readingOrder: 1,
        lineCount: 1,
        repeated: false,
      });
      expect(first?.candidates[0]?.relativeFontSize).toBeCloseTo(2.8);
      expect(first?.candidates.find(({ text }) => text === "Prepared for review")?.italic).toBe(
        true,
      );
      for (const page of [first, second]) {
        expect(page?.candidates.find(({ text }) => text === "LETTERHEAD")?.repeated).toBe(true);
        expect(page?.candidates.find(({ text }) => text === "Common label")?.repeated).toBe(true);
      }
      const [limited] = yield* core.headings(pdf, { pageIndexes: [0], limit: 1 });
      expect(limited?.candidates).toEqual(first?.candidates.slice(0, 1));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("maps a rotated heading into its visible crop box and matches lazy results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const pdf = yield* headingPdf;
        const options = { pageIndexes: [2, 0, 1], limit: 5 };
        const [rotated, ...rest] = yield* core.headings(pdf, options);
        const title = rotated?.candidates[0];
        expect(rotated?.pageIndex).toBe(2);
        expect(title?.text).toBe("ROTATED TITLE");
        expect(title?.bounds[0]).toBeCloseTo(0.35);
        expect(title?.bounds[1]).toBeCloseTo(0.16, 1);
        expect(title?.bounds[2]).toBeGreaterThan(0.65);
        expect(title?.bounds[3]).toBeCloseTo(0.21, 1);
        const lazy = yield* core.openLazy(pdfCoreBytesSource(pdf));
        expect(yield* lazy.headings(options)).toEqual([rotated, ...rest]);
        expect(yield* lazy.text({ pageIndexes: [0], maxBlocks: 2 })).toEqual([
          "LETTERHEAD\n\nPROJECT SUMMARY",
        ]);
        expect(yield* lazy.headings({ pageIndexes: [2], limit: 0 })).toEqual([
          { pageIndex: 2, candidates: [] },
        ]);
      }),
    ).pipe(Effect.provide(layer)),
  );
});
