import { PDFDocument, PDFHexString, PDFString } from "@cantoo/pdf-lib";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { findPdfTextAnchors, removePdfLinkAnchors } from "../src/anchors";
import { liteParseWorkerBrowserLayer } from "../src/liteparse-browser";

const ANCHOR_URI = "https://example.com/#signature-anchor";
const OTHER_URI = "https://example.com/other";
const stampSize = { width: 80, height: 20 };

type LinkSpec = {
  readonly uri: string;
  readonly rect: readonly [number, number, number, number];
  readonly hex?: boolean;
  readonly indirectAction?: boolean;
};

const pdfWithLinks = async (
  pages: ReadonlyArray<{
    readonly size: readonly [number, number];
    readonly cropBox?: readonly [number, number, number, number];
    readonly links: ReadonlyArray<LinkSpec>;
  }>,
): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  pages.forEach(({ size, cropBox, links }) => {
    const page = document.addPage([size[0], size[1]]);
    if (cropBox !== undefined) page.setCropBox(...cropBox);
    links.forEach(({ uri, rect, hex, indirectAction }) => {
      const action = document.context.obj({
        S: "URI",
        URI: hex === true ? PDFHexString.fromText(uri) : PDFString.of(uri),
      });
      const annotation = document.context.register(
        document.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [...rect],
          Border: [0, 0, 0],
          A: indirectAction === true ? document.context.register(action) : action,
        }),
      );
      page.node.addAnnot(annotation);
    });
  });
  return document.save();
};

describe("PDF link anchors", () => {
  it.effect("places the stamp from a link annotation without parsing text", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() =>
        pdfWithLinks([
          { size: [300, 200], links: [{ uri: OTHER_URI, rect: [10, 150, 60, 160] }] },
          { size: [300, 200], links: [{ uri: ANCHOR_URI, rect: [40, 100, 140, 110] }] },
        ]),
      );

      const anchors = yield* findPdfTextAnchors({
        pdf,
        matchers: [{ link: ANCHOR_URI }],
        stampSize,
        placement: "below",
        offset: 0,
      });

      expect(anchors).toStrictEqual([{ pageIndex: 1, x: 40, y: 100, width: 80, height: 20 }]);
    }).pipe(Effect.provide(liteParseWorkerBrowserLayer)),
  );

  it.effect("matches hex-encoded URIs and indirect actions", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() =>
        pdfWithLinks([
          {
            size: [300, 200],
            links: [
              { uri: ANCHOR_URI, rect: [40, 100, 140, 110], hex: true, indirectAction: true },
            ],
          },
        ]),
      );

      const anchors = yield* findPdfTextAnchors({
        pdf,
        matchers: [{ link: ANCHOR_URI }],
        stampSize,
        placement: "above",
        offset: 0,
      });

      expect(anchors).toStrictEqual([{ pageIndex: 0, x: 40, y: 70, width: 80, height: 20 }]);
    }).pipe(Effect.provide(liteParseWorkerBrowserLayer)),
  );

  it.effect("maps link rectangles through the visible crop box", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() =>
        pdfWithLinks([
          {
            size: [300, 200],
            cropBox: [20, 10, 260, 180],
            links: [{ uri: ANCHOR_URI, rect: [60, 110, 160, 120] }],
          },
        ]),
      );

      const anchors = yield* findPdfTextAnchors({
        pdf,
        matchers: [{ link: ANCHOR_URI }],
        stampSize,
        placement: "below",
        offset: 0,
      });

      expect(anchors).toStrictEqual([{ pageIndex: 0, x: 40, y: 80, width: 80, height: 20 }]);
    }).pipe(Effect.provide(liteParseWorkerBrowserLayer)),
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
    }),
  );

  it.effect("removes only the matched link annotation", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() =>
        pdfWithLinks([
          {
            size: [300, 200],
            links: [
              { uri: OTHER_URI, rect: [10, 150, 60, 160] },
              { uri: ANCHOR_URI, rect: [40, 100, 140, 110], indirectAction: true },
            ],
          },
        ]),
      );

      const cleaned = yield* removePdfLinkAnchors(pdf, [{ link: ANCHOR_URI }]);
      const anchors = yield* findPdfTextAnchors({
        pdf: cleaned,
        matchers: [{ link: ANCHOR_URI }, { link: OTHER_URI }],
        stampSize,
        placement: "below",
        offset: 0,
      });

      expect(anchors).toStrictEqual([{ pageIndex: 0, x: 10, y: 50, width: 80, height: 20 }]);
    }).pipe(Effect.provide(liteParseWorkerBrowserLayer)),
  );

  it.effect("keeps the PDF untouched without link matchers", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() =>
        pdfWithLinks([
          { size: [300, 200], links: [{ uri: ANCHOR_URI, rect: [40, 100, 140, 110] }] },
        ]),
      );

      const cleaned = yield* removePdfLinkAnchors(pdf, [{ text: "signature" }]);

      expect(cleaned).toBe(pdf);
    }),
  );
});
