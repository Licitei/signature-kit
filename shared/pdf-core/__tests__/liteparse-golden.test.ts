import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { findPdfTextAnchors } from "../../../formats/pdf/src/anchors.ts";
import {
  topLeftRectFromPdfCoordinateTuple,
  visiblePdfPageSize,
} from "../../../formats/pdf/src/stamp.ts";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore } from "../dist/pdf-core.js";
import type { PdfCoreInspection } from "../dist/config.js";
import {
  CORPUS_FIXTURE_NAMES,
  LINK_FIXTURE_URIS,
  PDF_CORE_FIXTURES_DIR,
  type CorpusFixtureName,
} from "./corpus.ts";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const AnchorGolden = Schema.Array(
  Schema.Struct({
    pageIndex: Schema.Int,
    x: Schema.Finite,
    y: Schema.Finite,
    width: Schema.Finite,
    height: Schema.Finite,
  }),
);

const LiteParseGolden = Schema.Struct({
  pages: Schema.Array(
    Schema.Struct({
      textItems: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          x: Schema.Finite,
          y: Schema.Finite,
          width: Schema.Finite,
          height: Schema.Finite,
        }),
      ),
    }),
  ),
});

const stem = (name: CorpusFixtureName): string => name.replace(/\.pdf$/u, "");

const readGolden = <S extends Schema.Top>(
  name: CorpusFixtureName,
  suffix: "anchors" | "liteparse",
  schema: S,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
    readFileSync(join(PDF_CORE_FIXTURES_DIR, `${stem(name)}.${suffix}.json`), "utf8"),
  );

const contentMatchers = [
  { text: "[[licitei-assinatura]]" },
  { text: "{{signature}}" },
  { digits: "12345678909" },
  { digits: "12345678000195" },
];

const linkMatchersFor = (name: CorpusFixtureName) => {
  if (name === "links.pdf") {
    return [
      { link: LINK_FIXTURE_URIS.primary },
      { link: LINK_FIXTURE_URIS.secondary },
      { link: LINK_FIXTURE_URIS.indirect },
    ];
  }
  if (name === "rotated-cropped.pdf") {
    return [{ link: LINK_FIXTURE_URIS.rotated }];
  }
  return [];
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const itemsOf = (page: PdfCoreInspection["text"][number]) => {
  const bytes = encoder.encode(page.text);
  return Array.from({ length: page.offsets.length - 1 }, (_, index) => {
    const pdfRect: readonly [number, number, number, number] = [
      page.rects[index * 5] ?? 0,
      page.rects[index * 5 + 1] ?? 0,
      page.rects[index * 5 + 2] ?? 0,
      page.rects[index * 5 + 3] ?? 0,
    ];
    return {
      text: decoder.decode(bytes.subarray(page.offsets[index], page.offsets[index + 1])),
      pdfRect,
    };
  });
};

const normalize = (text: string): string => text.replace(/\s+/gu, "").replaceAll("—", "-");

const loadFixture = (name: CorpusFixtureName) =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const pdf = new Uint8Array(readFileSync(join(PDF_CORE_FIXTURES_DIR, name)));
    const inspection = yield* core.inspect(pdf, { text: true, links: false });
    const document = yield* Effect.promise(() => PDFDocument.load(pdf, { ignoreEncryption: true }));
    const pages = inspection.text.map((textPage) => {
      const pdfPage = document.getPage(textPage.pageIndex);
      const size = visiblePdfPageSize(pdfPage);
      return {
        index: textPage.pageIndex,
        width: size.width,
        height: size.height,
        boxes: itemsOf(textPage).map((item) => {
          const rect = topLeftRectFromPdfCoordinateTuple(item.pdfRect, pdfPage);
          return { text: item.text, ...rect };
        }),
      };
    });
    return { pdf, pages };
  });

describe("pdf-core liteparse parity", () => {
  for (const fixture of CORPUS_FIXTURE_NAMES) {
    it.effect(`matches LiteParse anchors for ${fixture}`, () =>
      Effect.gen(function* () {
        const golden = yield* readGolden(fixture, "anchors", AnchorGolden);
        const { pdf, pages } = yield* loadFixture(fixture);
        const anchors = yield* findPdfTextAnchors({
          pdf,
          pages: pages.map(({ index, width, height }) => ({ index, width, height })),
          textBoxes: pages.map((page) => page.boxes),
          matchers: [...contentMatchers, ...linkMatchersFor(fixture)],
          stampSize: { width: 80, height: 20 },
          placement: "below",
          offset: 0,
        });
        for (const expected of golden) {
          const match = anchors.find(
            (anchor) =>
              anchor.pageIndex === expected.pageIndex &&
              Math.abs(anchor.x - expected.x) <= 1 &&
              Math.abs(anchor.y - expected.y) <= 1 &&
              Math.abs(anchor.width - expected.width) <= 1 &&
              Math.abs(anchor.height - expected.height) <= 1,
          );
          expect(match, `missing anchor for ${fixture} page ${expected.pageIndex}`).toBeDefined();
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect(`matches LiteParse text items for ${fixture}`, () =>
      Effect.gen(function* () {
        const golden = yield* readGolden(fixture, "liteparse", LiteParseGolden);
        const { pages } = yield* loadFixture(fixture);
        expect(pages).toHaveLength(golden.pages.length);
        golden.pages.forEach((goldenPage, pageIndex) => {
          const boxes = pages[pageIndex]?.boxes ?? [];
          expect(boxes).toHaveLength(goldenPage.textItems.length);
          goldenPage.textItems.forEach((expected, index) => {
            const actual = boxes[index];
            expect(normalize(actual?.text ?? "")).toBe(normalize(expected.text));
            expect(actual?.x ?? Number.NaN).toBeCloseTo(expected.x, 0);
            expect(actual?.y ?? Number.NaN).toBeCloseTo(expected.y, 0);
            expect(actual?.width ?? Number.NaN).toBeCloseTo(expected.width, 0);
            expect(actual?.height ?? Number.NaN).toBeCloseTo(expected.height, 0);
          });
        });
      }).pipe(Effect.provide(layer)),
    );
  }
});
