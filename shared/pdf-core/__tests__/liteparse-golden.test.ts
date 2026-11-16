import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  CORPUS_FIXTURE_NAMES,
  PDF_CORE_FIXTURES_DIR,
  type CorpusFixtureName,
} from "./corpus.ts";

const pdfCoreDist = join(import.meta.dirname, "../dist/pdf-core.js");
const pdfCoreReady = existsSync(pdfCoreDist);

const describeWhenPdfCoreText = pdfCoreReady ? describe : describe.skip;

const anchorPath = (name: CorpusFixtureName): string => {
  const stem = name.replace(/\.pdf$/u, "");
  return join(PDF_CORE_FIXTURES_DIR, `${stem}.anchors.json`);
};

describeWhenPdfCoreText("pdf-core liteparse anchor parity", () => {
  for (const fixture of CORPUS_FIXTURE_NAMES) {
    it(`matches LiteParse anchors for ${fixture}`, async () => {
      const goldenBytes = readFileSync(anchorPath(fixture));
      const golden = JSON.parse(new TextDecoder().decode(goldenBytes)) as ReadonlyArray<{
        readonly pageIndex: number;
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      }>;
      if ("error" in (golden as unknown as Record<string, unknown>)) {
        return;
      }
      const pdfCore = (await import(pdfCoreDist)) as {
        readonly inspect: (pdf: Uint8Array) => Promise<{
          readonly pages: ReadonlyArray<{
            readonly index: number;
            readonly width: number;
            readonly height: number;
            readonly mediaBox: readonly [number, number, number, number];
            readonly cropBox: readonly [number, number, number, number];
            readonly rotate: number;
            readonly textItems: ReadonlyArray<{
              readonly text: string;
              readonly pdfRect: readonly [number, number, number, number];
            }>;
          }>;
        }>;
      };
      const { topLeftRectFromPdfCoordinateTuple } = await import(
        "../../../formats/pdf/src/stamp.ts"
      );
      const { findPdfTextAnchors } = await import("../../../formats/pdf/src/anchors.ts");
      const { PDFDocument } = await import("@cantoo/pdf-lib");
      const pdf = new Uint8Array(readFileSync(join(PDF_CORE_FIXTURES_DIR, fixture)));
      const inspected = await pdfCore.inspect(pdf);
      const document = await PDFDocument.load(pdf, { ignoreEncryption: true });
      const textBoxes = inspected.pages.map((page) => {
        const pdfPage = document.getPage(page.index);
        return page.textItems.map((item) => {
          const rect = topLeftRectFromPdfCoordinateTuple(item.pdfRect, pdfPage);
          return {
            text: item.text,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        });
      });
      const pages = inspected.pages.map((page) => ({
        index: page.index,
        width: page.width,
        height: page.height,
      }));
      const anchors = await Effect.runPromise(
        findPdfTextAnchors({
          pdf,
          pages,
          textBoxes,
          matchers: [
            { text: "[[licitei-assinatura]]" },
            { text: "{{signature}}" },
            { digits: "12345678909" },
            { digits: "12345678000195" },
          ],
          stampSize: { width: 80, height: 20 },
          placement: "below",
          offset: 0,
        }),
      );
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
    });
  }
});