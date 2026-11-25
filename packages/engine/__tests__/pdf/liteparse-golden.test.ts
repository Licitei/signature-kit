import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import type { PdfCoreInspection } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore } from "../dist/pdf-core.js";
import { CORPUS_FIXTURE_NAMES, PDF_CORE_FIXTURES_DIR } from "./corpus.ts";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

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

type VisibleRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

const normalize = (text: string): string => text.replace(/\s+/gu, "").replaceAll("—", "-");

const visibleRect = (
  [left, bottom, right, top]: readonly [number, number, number, number],
  page: PdfCoreInspection["pages"][number],
): VisibleRect => {
  const [cropLeft, cropBottom, cropRight, cropTop] = page.cropBox;
  switch (page.rotate) {
    case 90:
      return {
        x: bottom - cropBottom,
        y: left - cropLeft,
        width: top - bottom,
        height: right - left,
      };
    case 180:
      return {
        x: cropRight - right,
        y: bottom - cropBottom,
        width: right - left,
        height: top - bottom,
      };
    case 270:
      return {
        x: cropTop - top,
        y: cropRight - right,
        width: top - bottom,
        height: right - left,
      };
    default:
      return {
        x: left - cropLeft,
        y: cropTop - top,
        width: right - left,
        height: top - bottom,
      };
  }
};

const overlapArea = (left: VisibleRect, right: VisibleRect): number =>
  Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)) *
  Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));

const itemsOf = (inspection: PdfCoreInspection, pageIndex: number) => {
  const page = inspection.pages[pageIndex];
  const textPage = inspection.text.find((candidate) => candidate.pageIndex === pageIndex);
  if (page === undefined || textPage === undefined) {
    return [];
  }
  return Array.from({ length: textPage.offsets.length - 1 }, (_, index) => ({
    text: normalize(textPage.text.slice(textPage.offsets[index], textPage.offsets[index + 1])),
    rect: visibleRect(
      [
        textPage.rects[index * 5] ?? 0,
        textPage.rects[index * 5 + 1] ?? 0,
        textPage.rects[index * 5 + 2] ?? 0,
        textPage.rects[index * 5 + 3] ?? 0,
      ],
      page,
    ),
  }));
};

describe("pdf-core LiteParse text parity", () => {
  for (const fixture of CORPUS_FIXTURE_NAMES) {
    it.effect(`finds every LiteParse text item of ${fixture} in a pdf-core item`, () =>
      Effect.gen(function* () {
        const stem = fixture.replace(/\.pdf$/u, "");
        const golden = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LiteParseGolden))(
          readFileSync(join(PDF_CORE_FIXTURES_DIR, `${stem}.liteparse.json`), "utf8"),
        );
        const core = yield* PdfCore;
        const inspection = yield* core.inspect(
          new Uint8Array(readFileSync(join(PDF_CORE_FIXTURES_DIR, fixture))),
          { text: true, links: false },
        );

        expect(inspection.pages).toHaveLength(golden.pages.length);
        golden.pages.forEach((goldenPage, pageIndex) => {
          const items = itemsOf(inspection, pageIndex);
          for (const expected of goldenPage.textItems) {
            const text = normalize(expected.text);
            const found = items.some(
              (item) => item.text.includes(text) && overlapArea(item.rect, expected) > 0,
            );
            expect(found, `${fixture} page ${pageIndex}: "${expected.text}" not found`).toBe(true);
          }
        });
      }).pipe(Effect.provide(layer)),
    );
  }
});
