import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { PdfErrorCodeValue, PdfOperationValue, PdfSchemaNameValue } from "../src/config";
import { extractPdfPages, mergePdfs } from "../src/merge";
import { findPdfTextAnchors } from "../src/anchors";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import { createFixturePdf, editFixturePdf, fixtureDocument, pageSizes } from "./pdf-fixtures";

const createPdf = (sizes: ReadonlyArray<readonly [number, number]>) =>
  createFixturePdf(sizes.map(([width, height]) => ({ size: [width, height] })));
const createCroppedRotatedPdf = (rotationDegrees: number) =>
  createFixturePdf([{ size: [400, 150], cropBox: [100, 25, 300, 125], rotate: rotationDegrees }]);

describe("PDF merge and text-anchor input boundaries", () => {
  it.effect("rejects an empty document list instead of fabricating a page", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(mergePdfs([]));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe(PdfErrorCodeValue.invalidBuilderInput);
        expect(result.failure.retryable).toBe(false);
        expect(result.failure.operation).toBe(PdfOperationValue.mergeDocuments);
        expect(result.failure.schemaName).toBe(PdfSchemaNameValue.pdfMergeDocuments);
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect("does not synthesize a page when valid documents contain no pages", () =>
    Effect.gen(function* () {
      const source = yield* editFixturePdf(yield* createFixturePdf(), () => [
        {
          op: "set",
          target: { base: { kind: "catalog" }, path: ["Pages"] },
          key: "Kids",
          value: "[]",
        },
        {
          op: "set",
          target: { base: { kind: "catalog" }, path: ["Pages"] },
          key: "Count",
          value: "0",
        },
      ]);
      const merged = yield* mergePdfs([source]);
      const pageCount = (yield* fixtureDocument(merged)).pages.length;

      expect(pageCount).toBe(0);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect("rejects non-finite and non-positive text-anchor stamp sizes", () =>
    Effect.gen(function* () {
      const invalidStampSizes = [
        { width: 0, height: 20 },
        { width: -1, height: 20 },
        { width: Number.NaN, height: 20 },
        { width: Number.POSITIVE_INFINITY, height: 20 },
        { width: Number.NEGATIVE_INFINITY, height: 20 },
        { width: 20, height: 0 },
        { width: 20, height: -1 },
        { width: 20, height: Number.NaN },
        { width: 20, height: Number.POSITIVE_INFINITY },
        { width: 20, height: Number.NEGATIVE_INFINITY },
      ];

      for (const stampSize of invalidStampSizes) {
        const result = yield* Effect.result(
          findPdfTextAnchors({
            pages: [{ index: 0, width: 220, height: 120 }],
            textBoxes: [[{ text: "Signature", x: 12, y: 12, width: 100, height: 12 }]],
            matchers: [{ text: "Signature" }],
            stampSize,
          }),
        );

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe(PdfErrorCodeValue.invalidBuilderInput);
          expect(result.failure.retryable).toBe(false);
          expect(result.failure.operation).toBe(PdfOperationValue.findTextAnchors);
          expect(result.failure.schemaName).toBe(PdfSchemaNameValue.pdfTextAnchorSearchInput);
        }
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect("rejects non-finite anchor boxes and offsets while allowing a negative offset", () =>
    Effect.gen(function* () {
      const validInput = {
        pages: [{ index: 0, width: 220, height: 120 }],
        textBoxes: [[{ text: "Signature", x: 12, y: 12, width: 100, height: 12 }]],
        matchers: [{ text: "Signature" }],
        stampSize: { width: 80, height: 20 },
      };
      const invalidInputs = [
        { textBoxes: [[{ text: "Signature", x: Number.NaN, y: 12, width: 100, height: 12 }]] },
        {
          textBoxes: [
            [{ text: "Signature", x: Number.POSITIVE_INFINITY, y: 12, width: 100, height: 12 }],
          ],
        },
        {
          textBoxes: [
            [{ text: "Signature", x: 12, y: Number.NEGATIVE_INFINITY, width: 100, height: 12 }],
          ],
        },
        { textBoxes: [[{ text: "Signature", x: 12, y: 12, width: 0, height: 12 }]] },
        { textBoxes: [[{ text: "Signature", x: 12, y: 12, width: -1, height: 12 }]] },
        { textBoxes: [[{ text: "Signature", x: 12, y: 12, width: 100, height: Number.NaN }]] },
        {
          textBoxes: [
            [{ text: "Signature", x: 12, y: 12, width: 100, height: Number.POSITIVE_INFINITY }],
          ],
        },
        { offset: Number.NaN },
        { offset: Number.POSITIVE_INFINITY },
        { offset: Number.NEGATIVE_INFINITY },
      ];

      for (const invalidInput of invalidInputs) {
        const result = yield* Effect.result(findPdfTextAnchors({ ...validInput, ...invalidInput }));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe(PdfErrorCodeValue.invalidBuilderInput);
          expect(result.failure.retryable).toBe(false);
          expect(result.failure.operation).toBe(PdfOperationValue.findTextAnchors);
          expect(result.failure.schemaName).toBe(PdfSchemaNameValue.pdfTextAnchorSearchInput);
        }
      }

      const anchors = yield* findPdfTextAnchors({ ...validInput, offset: -4 });
      expect(anchors).toStrictEqual([{ pageIndex: 0, x: 12, y: 20, width: 80, height: 20 }]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect(
    "uses visible non-square CropBox dimensions for 90 and 270 degree direct PDF anchors",
    () =>
      Effect.gen(function* () {
        for (const rotation of [450, 270]) {
          const pdf = yield* createCroppedRotatedPdf(rotation);
          const anchors = yield* findPdfTextAnchors({
            pdf,
            textBoxes: [[{ text: "Signature", x: 95, y: 185, width: 10, height: 10 }]],
            matchers: [{ text: "Signature" }],
            stampSize: { width: 80, height: 20 },
            placement: "below",
            offset: 0,
          }).pipe(Effect.provide(pdfCoreTestLayer));

          expect(anchors).toStrictEqual([{ pageIndex: 0, x: 20, y: 180, width: 80, height: 20 }]);
        }
      }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect("merges valid documents in page order", () =>
    Effect.gen(function* () {
      const first = yield* createPdf([[200, 100]]);
      const second = yield* createPdf([
        [300, 150],
        [400, 200],
      ]);
      const merged = yield* mergePdfs([first, second]);
      const sizes = yield* pageSizes(merged);

      expect(sizes).toStrictEqual([
        [200, 100],
        [300, 150],
        [400, 200],
      ]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect("extracts non-consecutive pages in selection order and ignores repeats", () =>
    Effect.gen(function* () {
      const source = yield* createPdf([
        [200, 100],
        [300, 150],
        [400, 200],
      ]);
      const extracted = yield* extractPdfPages(source, [2, 0, 2]);
      const sizes = yield* pageSizes(extracted);

      expect(sizes).toStrictEqual([
        [400, 200],
        [200, 100],
      ]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("rejects invalid page selections at the schema and document boundaries", () =>
    Effect.gen(function* () {
      const source = yield* createPdf([[200, 100]]);
      for (const pageIndexes of [[], [-1], [0.5], [Number.NaN], [0x1_0000_0000]]) {
        const error = yield* Effect.flip(extractPdfPages(source, pageIndexes));
        expect(error).toMatchObject({
          code: PdfErrorCodeValue.invalidBuilderInput,
          operation: PdfOperationValue.extractPages,
          schemaName: PdfSchemaNameValue.pdfExtractPagesInput,
        });
      }

      const outOfRange = yield* Effect.flip(extractPdfPages(source, [1]));
      expect(outOfRange).toMatchObject({
        code: PdfErrorCodeValue.invalidPdf,
        operation: PdfOperationValue.extractPages,
      });
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("finds a valid text anchor with a usable stamp rectangle", () =>
    Effect.gen(function* () {
      const anchors = yield* findPdfTextAnchors({
        pages: [{ index: 0, width: 220, height: 120 }],
        textBoxes: [[{ text: "Signature", x: 12, y: 12, width: 100, height: 12 }]],
        matchers: [{ text: "Signature" }],
        stampSize: { width: 80, height: 20 },
        placement: "below",
        offset: 0,
      });

      expect(anchors).toStrictEqual([{ pageIndex: 0, x: 12, y: 24, width: 80, height: 20 }]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
