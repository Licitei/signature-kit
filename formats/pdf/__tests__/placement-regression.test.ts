import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { PdfCoordinateTupleSchema, PdfErrorCodeValue, PdfOperationValue } from "../src/config";
import type { PdfCoordinateTuple, PdfSignatureAppearance } from "../src/config";
import { addSignaturePlaceholder } from "../src/placeholder";
import { resolveSignatureWidgetPlacement } from "../src/placement";
import type { PdfCoreEditOperation, PdfCoreObjectRef } from "@signature-kit/pdf-core/config";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import {
  acroFormField,
  acroFormFieldNumbers,
  arrayRefs,
  box,
  childObject,
  createFixturePdf,
  editFixturePdf,
  entryRef,
  hasKey,
  numberEntry,
  ref,
} from "./pdf-fixtures";
import type { FixturePage } from "./pdf-fixtures";

type Rect = readonly [number, number, number, number];

const signatureFixture = (
  build: (context: { readonly next: () => PdfCoreObjectRef; readonly page: string }) => {
    readonly objects: ReadonlyArray<readonly [PdfCoreObjectRef, string]>;
    readonly annotations: ReadonlyArray<PdfCoreObjectRef>;
    readonly fields: ReadonlyArray<PdfCoreObjectRef>;
  },
  page: FixturePage = {},
) =>
  createFixturePdf([page]).pipe(
    Effect.flatMap((pdf) =>
      editFixturePdf(pdf, ({ next, page: pageRef }) => {
        const { objects, annotations, fields } = build({ next, page: ref(pageRef(0)) });
        const operations: Array<PdfCoreEditOperation> = objects.map(([objectRef, value]) => ({
          op: "setObject",
          ref: objectRef,
          value,
        }));
        operations.push({
          op: "set",
          target: { base: { kind: "page", pageIndex: 0 } },
          key: "Annots",
          value: `[${annotations.map(ref).join(" ")}]`,
        });
        if (fields.length > 0) {
          operations.push({
            op: "set",
            target: { base: { kind: "catalog" } },
            key: "AcroForm",
            value: `<< /Fields [${fields.map(ref).join(" ")}] >>`,
          });
        }
        return operations;
      }),
    ),
  );

const obstaclePdf = (page: FixturePage, rects: ReadonlyArray<Rect>) =>
  signatureFixture(({ next, page: pageRef }) => {
    const objects = rects.map((rect): readonly [PdfCoreObjectRef, string] => [
      next(),
      `<< /Type /Annot /Subtype /Link /Rect ${box(rect)} /P ${pageRef} >>`,
    ]);
    return { objects, annotations: objects.map(([objectRef]) => objectRef), fields: [] };
  }, page);

const createHierarchicalSignatureSlots = signatureFixture(({ next, page }) => {
  const objects: Array<readonly [PdfCoreObjectRef, string]> = [];
  const widgets: Array<PdfCoreObjectRef> = [];
  const fields: Array<PdfCoreObjectRef> = [];
  for (const rect of [
    [20, 20, 140, 60],
    [180, 20, 300, 60],
  ] satisfies ReadonlyArray<Rect>) {
    const widget = next();
    const field = next();
    objects.push(
      [
        widget,
        `<< /Type /Annot /Subtype /Widget /Rect ${box(rect)} /F 1 /P ${page} /Parent ${ref(field)} >>`,
      ],
      [field, `<< /FT /Sig /T (DuplicateSignatureName) /Kids [${ref(widget)}] >>`],
    );
    widgets.push(widget);
    fields.push(field);
  }
  return { objects, annotations: widgets, fields };
});

const nestedSignatureSlot = (cyclic: boolean) =>
  signatureFixture(({ next, page }) => {
    const widget = next();
    const intermediate = next();
    const root = next();
    return {
      objects: [
        [
          widget,
          `<< /Type /Annot /Subtype /Widget /Rect [180 20 300 60] /P ${page} /Parent ${ref(intermediate)} >>`,
        ],
        [intermediate, `<< /Kids [${ref(widget)}] /Parent ${ref(root)} >>`],
        [
          root,
          cyclic
            ? `<< /FT /Sig /Kids [${ref(intermediate)}] /Parent ${ref(intermediate)} >>`
            : `<< /FT /Sig /T (InheritedSignature) /Kids [${ref(intermediate)}] >>`,
        ],
      ],
      annotations: [widget],
      fields: [root],
    };
  });

const createInheritedSignatureSlot = nestedSignatureSlot(false);
const createCyclicSignatureSlot = nestedSignatureSlot(true);

const createMergedSiblingSignatureSlots = signatureFixture(({ next, page }) => {
  const root = next();
  const rects: ReadonlyArray<Rect> = [
    [20, 20, 140, 60],
    [180, 20, 300, 60],
  ];
  const widgets = rects.map((rect): readonly [PdfCoreObjectRef, string] => [
    next(),
    `<< /Type /Annot /Subtype /Widget /FT /Sig /T (MergedSignature) /Rect ${box(rect)} /P ${page} /Parent ${ref(root)} >>`,
  ]);
  return {
    objects: [
      ...widgets,
      [root, `<< /Kids [${widgets.map(([widget]) => ref(widget)).join(" ")}] >>`],
    ],
    annotations: widgets.map(([widget]) => widget),
    fields: [root],
  };
});

const fieldNumber = (pdf: Uint8Array, index: number): number | undefined =>
  acroFormFieldNumbers(pdf)[index];

const hierarchyPlacement = {
  placement: {
    kind: "auto",
    pageIndex: 0,
    width: 120,
    height: 40,
    margin: 20,
    gap: 8,
    anchor: "bottom-right",
  },
} satisfies PdfSignatureAppearance;
describe("PDF auto-placement geometry", () => {
  it.effect("uses CropBox-relative rotated coordinates for obstacles", () =>
    Effect.gen(function* () {
      const cases = [
        {
          rotation: 90,
          empty: [260, 210, 290, 250],
          blocked: [230, 210, 260, 250],
        },
        {
          rotation: 270,
          empty: [110, 110, 140, 150],
          blocked: [140, 110, 170, 150],
        },
      ] satisfies ReadonlyArray<{
        readonly rotation: number;
        readonly empty: PdfCoordinateTuple;
        readonly blocked: PdfCoordinateTuple;
      }>;

      for (const placementCase of cases) {
        const page: FixturePage = {
          size: [400, 400],
          cropBox: [100, 100, 300, 260],
          rotate: placementCase.rotation,
        };

        const empty = yield* resolveSignatureWidgetPlacement(yield* createFixturePdf([page]), {
          placement: {
            kind: "auto",
            pageIndex: 0,
            width: 40,
            height: 30,
            margin: 10,
            gap: 0,
            anchor: "bottom-right",
          },
        });
        expect(empty.widgetRect).toEqual(placementCase.empty);

        const blocked = yield* resolveSignatureWidgetPlacement(
          yield* obstaclePdf(page, [placementCase.empty]),
          {
            placement: {
              kind: "auto",
              pageIndex: 0,
              width: 40,
              height: 30,
              margin: 10,
              gap: 0,
              anchor: "bottom-right",
            },
          },
        );
        expect(blocked.widgetRect).toEqual(placementCase.blocked);
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect("skips blank signature widgets outside the rotated CropBox", () =>
    Effect.gen(function* () {
      const source = yield* signatureFixture(
        ({ next, page }) => {
          const widget = next();
          return {
            objects: [
              [
                widget,
                `<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [10 10 80 50] /P ${page} >>`,
              ],
            ],
            annotations: [widget],
            fields: [],
          };
        },
        { size: [400, 400], cropBox: [100, 100, 300, 260], rotate: 90 },
      );

      const resolved = yield* resolveSignatureWidgetPlacement(source, {
        placement: {
          kind: "auto",
          pageIndex: 0,
          width: 40,
          height: 30,
          margin: 10,
          gap: 0,
          anchor: "bottom-right",
        },
      });

      expect(resolved.widgetRect).toEqual([260, 210, 290, 250]);
      expect(resolved.existingWidgetObject).toBeUndefined();
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect("preserves manual widget rectangles in raw PDF coordinates", () =>
    Effect.gen(function* () {
      const source = yield* createFixturePdf([
        { size: [400, 400], cropBox: [100, 100, 300, 260], rotate: 90 },
      ]);

      const resolved = yield* resolveSignatureWidgetPlacement(source, {
        placement: { kind: "manual", pageIndex: 0, widgetRect: [10, 10, 80, 50] },
      });

      expect(resolved.widgetRect).toEqual([10, 10, 80, 50]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("binds hierarchical signature widgets through their selected parent field", () =>
    Effect.gen(function* () {
      const source = yield* createHierarchicalSignatureSlots;
      const resolved = yield* resolveSignatureWidgetPlacement(source, hierarchyPlacement);
      expect(resolved.widgetRect).toEqual([180, 20, 300, 60]);
      expect(resolved.existingWidgetObject).not.toBeUndefined();
      expect(resolved.existingSignatureFieldObject).not.toBeUndefined();
      expect(resolved.existingWidgetObject).not.toEqual(resolved.existingSignatureFieldObject);

      const prepared = yield* addSignaturePlaceholder({
        pdf: source,
        signatureLength: 128,
        appearance: hierarchyPlacement,
      });
      const firstField = acroFormField(prepared, 0);
      const secondField = acroFormField(prepared, 1);
      const secondWidget = childObject(prepared, secondField, "Kids", 0);

      expect(hasKey(firstField, "V")).toBe(false);
      expect(hasKey(secondField, "V")).toBe(true);
      expect(hasKey(secondWidget, "V")).toBe(false);
      expect(hasKey(secondWidget, "T")).toBe(false);
      expect(numberEntry(secondWidget, "F")).toBe(5);
      expect(entryRef(secondWidget, "Parent")).toBe(fieldNumber(prepared, 1));
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("binds an inherited signature type to its terminal child field", () =>
    Effect.gen(function* () {
      const source = yield* createInheritedSignatureSlot;
      const resolved = yield* resolveSignatureWidgetPlacement(source, hierarchyPlacement);
      const sourceRoot = acroFormField(source, 0);

      expect(resolved.widgetRect).toEqual([180, 20, 300, 60]);
      expect(resolved.existingSignatureFieldObject).toEqual({
        kind: "object",
        ref: { number: arrayRefs(sourceRoot, "Kids")[0], generation: 0 },
      });

      const prepared = yield* addSignaturePlaceholder({
        pdf: source,
        signatureLength: 128,
        appearance: hierarchyPlacement,
      });
      const root = acroFormField(prepared, 0);
      const terminal = childObject(prepared, root, "Kids", 0);
      const widget = childObject(prepared, terminal, "Kids", 0);

      expect(hasKey(root, "V")).toBe(false);
      expect(hasKey(terminal, "V")).toBe(true);
      expect(hasKey(widget, "V")).toBe(false);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("fails typed when the selected signature hierarchy is cyclic", () =>
    Effect.gen(function* () {
      const source = yield* createCyclicSignatureSlot;
      const result = yield* Effect.result(
        resolveSignatureWidgetPlacement(source, hierarchyPlacement),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe("pdf.SIGNATURE_PLACEMENT_FAILED");
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("keeps a merged signature widget as its own value owner", () =>
    Effect.gen(function* () {
      const source = yield* createMergedSiblingSignatureSlots;
      const prepared = yield* addSignaturePlaceholder({
        pdf: source,
        signatureLength: 128,
        appearance: hierarchyPlacement,
      });
      const root = acroFormField(prepared, 0);
      const firstWidget = childObject(prepared, root, "Kids", 0);
      const secondWidget = childObject(prepared, root, "Kids", 1);

      expect(hasKey(root, "V")).toBe(false);
      expect(hasKey(firstWidget, "V")).toBe(false);
      expect(hasKey(secondWidget, "V")).toBe(true);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("rejects non-finite, zero-area, and inverted widget rectangles", () =>
    Effect.gen(function* () {
      const invalidTuple = yield* Effect.result(
        Schema.decodeUnknownEffect(PdfCoordinateTupleSchema)([Number.NaN, 0, 10, 10]),
      );
      expect(Result.isFailure(invalidTuple)).toBe(true);

      const pdf = yield* createFixturePdf();
      const invisible = yield* addSignaturePlaceholder({ pdf, signatureLength: 128 });
      expect(invisible.byteLength).toBeGreaterThan(pdf.byteLength);
      const invalidRects: ReadonlyArray<PdfCoordinateTuple> = [
        [Number.NaN, 0, 10, 10],
        [0, 0, Number.POSITIVE_INFINITY, 10],
        [0, 0, 0, 10],
        [10, 0, 0, 10],
        [0, 10, 10, 0],
      ];

      for (const widgetRect of invalidRects) {
        const result = yield* Effect.result(
          addSignaturePlaceholder({
            pdf,
            signatureLength: 128,
            appearance: { pageIndex: 0, widgetRect },
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.operation).toBe("pdf.placeholder");
        }
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("bounds auto-placement comparisons without rejecting the exact budget boundary", () =>
    Effect.gen(function* () {
      for (const placementCase of [
        { obstacleCount: 1_000, expectedFailure: false },
        { obstacleCount: 1_001, expectedFailure: true },
      ] satisfies ReadonlyArray<{ obstacleCount: number; expectedFailure: boolean }>) {
        const source = yield* obstaclePdf(
          { size: [1_000, 1] },
          Array.from({ length: placementCase.obstacleCount }, (_, index): Rect => [
            2_000 + index * 2,
            0,
            2_001 + index * 2,
            1,
          ]),
        );
        const result = yield* Effect.result(
          resolveSignatureWidgetPlacement(source, {
            placement: {
              kind: "auto",
              pageIndex: 0,
              width: 1,
              height: 1,
              margin: 0,
              gap: 0,
              anchor: "bottom-right",
            },
          }),
        );

        expect(Result.isFailure(result)).toBe(placementCase.expectedFailure);
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe("pdf.SIGNATURE_PLACEMENT_FAILED");
          expect(result.failure.code).toBe(PdfErrorCodeValue.signaturePlacementFailed);
          expect(result.failure.operation).toBe(PdfOperationValue.placeholder);
          expect(result.failure.reason).toBe(
            "Automatic signature placement scan exceeds the supported comparison budget.",
          );
        } else {
          expect(result.success.widgetRect).toEqual([999, 0, 1000, 1]);
        }
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
  it.effect("rejects annotation arrays over the obstacle cap before materializing obstacles", () =>
    Effect.gen(function* () {
      const source = yield* signatureFixture(({ next }) => {
        const annotation = next();
        return {
          objects: [[annotation, "<< /Type /Annot >>"]],
          annotations: Array.from({ length: 10_001 }, () => annotation),
          fields: [],
        };
      });

      const result = yield* Effect.result(
        resolveSignatureWidgetPlacement(source, {
          placement: {
            kind: "auto",
            pageIndex: 0,
            width: 120,
            height: 40,
            margin: 20,
            gap: 8,
            anchor: "bottom-right",
          },
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe("pdf.SIGNATURE_PLACEMENT_FAILED");
        expect(result.failure.code).toBe(PdfErrorCodeValue.signaturePlacementFailed);
        expect(result.failure.operation).toBe(PdfOperationValue.placeholder);
        expect(result.failure.reason).toBe(
          "Automatic signature placement scan exceeds the supported comparison budget.",
        );
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
