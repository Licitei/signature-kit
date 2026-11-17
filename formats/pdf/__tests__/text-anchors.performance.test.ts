import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { findPdfTextAnchors } from "../src/anchors";
import type { PdfSignaturePage, PdfTextAnchorMatcher, PdfTextBox } from "../src/config";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import {
  CORPUS_FIXTURES_DIRECTORY,
  CORPUS_STAMP_SIZE,
  corpusAnchorMatchers,
  corpusFixtureNames,
} from "./text-anchors-corpus";

const WARMUP_RUNS = 3;
const MEASURED_RUNS = 15;

type PerformanceRow = {
  readonly fixture: string;
  readonly pdfCoreP50: number;
  readonly pdfjsP50: number;
};

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

type ContentMatcher = Exclude<PdfTextAnchorMatcher, { readonly link: string }>;

const isContentMatcher = (matcher: PdfTextAnchorMatcher): matcher is ContentMatcher =>
  !("link" in matcher);

const pdfjsText = (pdf: Uint8Array) =>
  Effect.promise(async () => {
    const task = getDocument({
      data: pdf.slice(),
      disableFontFace: true,
      verbosity: 0,
    });
    const document = await task.promise;
    const pages: Array<PdfSignaturePage> = [];
    const textBoxes: Array<ReadonlyArray<PdfTextBox>> = [];
    for (let index = 0; index < document.numPages; index += 1) {
      const page = await document.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({ index, width: viewport.width, height: viewport.height });
      textBoxes.push(
        content.items.flatMap((item) =>
          "str" in item && item.str.trim().length > 0
            ? [
                {
                  x: item.transform[4] ?? 0,
                  y: viewport.height - (item.transform[5] ?? 0) - item.height,
                  width: item.width,
                  height: item.height,
                  text: item.str,
                },
              ]
            : [],
        ),
      );
    }
    await task.destroy();
    return { pages, textBoxes };
  });

const warmMedian = <E>(run: Effect.Effect<unknown, E>) =>
  Effect.gen(function* () {
    for (let index = 0; index < WARMUP_RUNS; index += 1) {
      yield* run;
    }
    const samples: number[] = [];
    for (let index = 0; index < MEASURED_RUNS; index += 1) {
      const startedAt = performance.now();
      yield* run;
      samples.push(performance.now() - startedAt);
    }
    return median(samples);
  });

describe("text anchor performance", () => {
  it.effect(
    "finds anchors through pdf-core faster than the pdf.js text path on every fixture",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const pdfCore = yield* Layer.build(pdfCoreTestLayer);
          const rows: PerformanceRow[] = [];

          for (const fixture of corpusFixtureNames()) {
            const pdf = new Uint8Array(readFileSync(join(CORPUS_FIXTURES_DIRECTORY, fixture)));
            const matchers = corpusAnchorMatchers(fixture);

            const pdfCoreRun = findPdfTextAnchors({
              pdf,
              matchers,
              stampSize: CORPUS_STAMP_SIZE,
              placement: "below",
              offset: 0,
            }).pipe(Effect.provideContext(pdfCore));

            const pdfjsRun = Effect.gen(function* () {
              const parsed = yield* pdfjsText(pdf);
              return yield* findPdfTextAnchors({
                pages: parsed.pages,
                textBoxes: parsed.textBoxes,
                matchers: matchers.filter(isContentMatcher),
                stampSize: CORPUS_STAMP_SIZE,
                placement: "below",
                offset: 0,
              });
            }).pipe(Effect.provideContext(pdfCore));

            rows.push({
              fixture,
              pdfCoreP50: yield* warmMedian(pdfCoreRun),
              pdfjsP50: yield* warmMedian(pdfjsRun),
            });
          }

          console.info(
            [
              "| fixture | pdf-core p50 ms | pdf.js p50 ms | speedup |",
              "| --- | ---: | ---: | ---: |",
              ...rows.map(
                (row) =>
                  `| ${row.fixture} | ${row.pdfCoreP50.toFixed(2)} | ${row.pdfjsP50.toFixed(2)} | ${(row.pdfjsP50 / row.pdfCoreP50).toFixed(1)}x |`,
              ),
            ].join("\n"),
          );

          expect(rows.length).toBeGreaterThanOrEqual(9);
          for (const row of rows) {
            expect(row.pdfCoreP50, `${row.fixture} pdf-core p50`).toBeLessThan(row.pdfjsP50);
          }
        }),
      ),
    120_000,
  );
});
