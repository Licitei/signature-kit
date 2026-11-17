import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { findPdfTextAnchors, removePdfLinkAnchors } from "../src/anchors";
import type { PdfCoreEditOperation } from "@signature-kit/pdf-core/config";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import { box, createFixturePdf, editFixturePdf, ref } from "./pdf-fixtures";

const ANCHOR_URI = "https://example.com/#signature-anchor";
const OTHER_URI = "https://example.com/other";
const stampSize = { width: 80, height: 20 };

type LinkSpec = {
  readonly uri: string;
  readonly rect: readonly [number, number, number, number];
  readonly hex?: boolean;
  readonly indirectAction?: boolean;
};

const utf16Hex = (text: string): string =>
  `<FEFF${Array.from({ length: text.length }, (_, index) =>
    text.charCodeAt(index).toString(16).padStart(4, "0"),
  ).join("")}>`;

const pdfWithLinks = (
  pages: ReadonlyArray<{
    readonly size: readonly [number, number];
    readonly cropBox?: readonly [number, number, number, number];
    readonly links: ReadonlyArray<LinkSpec>;
  }>,
) =>
  createFixturePdf(
    pages.map(({ size, cropBox }) => ({ size, ...(cropBox === undefined ? {} : { cropBox }) })),
  ).pipe(
    Effect.flatMap((base) =>
      editFixturePdf(base, ({ next }) =>
        pages.flatMap(({ links }, pageIndex) =>
          links.flatMap(({ uri, rect, hex, indirectAction }): Array<PdfCoreEditOperation> => {
            const action = `<< /S /URI /URI ${hex === true ? utf16Hex(uri) : `(${uri})`} >>`;
            const actionRef = indirectAction === true ? next() : undefined;
            const annotation = next();
            const operations: Array<PdfCoreEditOperation> =
              actionRef === undefined ? [] : [{ op: "setObject", ref: actionRef, value: action }];
            return [
              ...operations,
              {
                op: "setObject",
                ref: annotation,
                value: `<< /Type /Annot /Subtype /Link /Rect ${box(rect)} /Border [0 0 0] /A ${
                  actionRef === undefined ? action : ref(actionRef)
                } >>`,
              },
              {
                op: "append",
                target: { base: { kind: "page", pageIndex } },
                key: "Annots",
                value: ref(annotation),
              },
            ];
          }),
        ),
      ),
    ),
  );

describe("PDF link anchors", () => {
  it.effect("places the stamp from a link annotation without parsing text", () =>
    Effect.gen(function* () {
      const pdf = yield* pdfWithLinks([
        { size: [300, 200], links: [{ uri: OTHER_URI, rect: [10, 150, 60, 160] }] },
        { size: [300, 200], links: [{ uri: ANCHOR_URI, rect: [40, 100, 140, 110] }] },
      ]);

      const anchors = yield* findPdfTextAnchors({
        pdf,
        matchers: [{ link: ANCHOR_URI }],
        stampSize,
        placement: "below",
        offset: 0,
      });

      expect(anchors).toStrictEqual([{ pageIndex: 1, x: 40, y: 100, width: 80, height: 20 }]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("matches hex-encoded URIs and indirect actions", () =>
    Effect.gen(function* () {
      const pdf = yield* pdfWithLinks([
        {
          size: [300, 200],
          links: [{ uri: ANCHOR_URI, rect: [40, 100, 140, 110], hex: true, indirectAction: true }],
        },
      ]);

      const anchors = yield* findPdfTextAnchors({
        pdf,
        matchers: [{ link: ANCHOR_URI }],
        stampSize,
        placement: "above",
        offset: 0,
      });

      expect(anchors).toStrictEqual([{ pageIndex: 0, x: 40, y: 70, width: 80, height: 20 }]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("maps link rectangles through the visible crop box", () =>
    Effect.gen(function* () {
      const pdf = yield* pdfWithLinks([
        {
          size: [300, 200],
          cropBox: [20, 10, 280, 190],
          links: [{ uri: ANCHOR_URI, rect: [60, 110, 160, 120] }],
        },
      ]);

      const anchors = yield* findPdfTextAnchors({
        pdf,
        matchers: [{ link: ANCHOR_URI }],
        stampSize,
        placement: "below",
        offset: 0,
      });

      expect(anchors).toStrictEqual([{ pageIndex: 0, x: 40, y: 80, width: 80, height: 20 }]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("requires pdf bytes for link matchers", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        findPdfTextAnchors({
          pages: [{ index: 0, width: 300, height: 200 }],
          textBoxes: [[]],
          matchers: [{ link: ANCHOR_URI }],
          stampSize,
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("removes only the matched link annotation", () =>
    Effect.gen(function* () {
      const pdf = yield* pdfWithLinks([
        {
          size: [300, 200],
          links: [
            { uri: OTHER_URI, rect: [10, 150, 60, 160] },
            { uri: ANCHOR_URI, rect: [40, 100, 140, 110], indirectAction: true },
          ],
        },
      ]);

      const cleaned = yield* removePdfLinkAnchors(pdf, [{ link: ANCHOR_URI }]);
      const anchors = yield* findPdfTextAnchors({
        pdf: cleaned,
        matchers: [{ link: ANCHOR_URI }, { link: OTHER_URI }],
        stampSize,
        placement: "below",
        offset: 0,
      });

      expect(anchors).toStrictEqual([{ pageIndex: 0, x: 10, y: 50, width: 80, height: 20 }]);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("keeps the PDF untouched without link matchers", () =>
    Effect.gen(function* () {
      const pdf = yield* pdfWithLinks([
        { size: [300, 200], links: [{ uri: ANCHOR_URI, rect: [40, 100, 140, 110] }] },
      ]);

      const cleaned = yield* removePdfLinkAnchors(pdf, [{ text: "signature" }]);

      expect(cleaned).toBe(pdf);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
