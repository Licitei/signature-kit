import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { findPdfTextAnchors } from "../src/anchors";
import type { PdfTextAnchorMatcher } from "../src/config";
import { liteParsePages, liteParseTextBoxes, makeLiteParseText } from "../scripts/liteparse-node";
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
  readonly liteParseP50: number;
};

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

type ContentMatcher = Exclude<PdfTextAnchorMatcher, { readonly link: string }>;

const isContentMatcher = (matcher: PdfTextAnchorMatcher): matcher is ContentMatcher =>
  !("link" in matcher);

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
    "finds anchors through pdf-core faster than the LiteParse text path on every fixture",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const pdfCore = yield* Layer.build(pdfCoreTestLayer);
          const parseLiteParse = yield* makeLiteParseText;
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

            const liteParseRun = Effect.gen(function* () {
              const parsed = yield* parseLiteParse(pdf);
              return yield* findPdfTextAnchors({
                pages: liteParsePages(parsed),
                textBoxes: liteParseTextBoxes(parsed),
                matchers: matchers.filter(isContentMatcher),
                stampSize: CORPUS_STAMP_SIZE,
                placement: "below",
                offset: 0,
              });
            }).pipe(Effect.provideContext(pdfCore));

            rows.push({
              fixture,
              pdfCoreP50: yield* warmMedian(pdfCoreRun),
              liteParseP50: yield* warmMedian(liteParseRun),
            });
          }

          console.info(
            [
              "| fixture | pdf-core p50 ms | liteparse p50 ms | speedup |",
              "| --- | ---: | ---: | ---: |",
              ...rows.map(
                (row) =>
                  `| ${row.fixture} | ${row.pdfCoreP50.toFixed(2)} | ${row.liteParseP50.toFixed(2)} | ${(row.liteParseP50 / row.pdfCoreP50).toFixed(1)}x |`,
              ),
            ].join("\n"),
          );

          expect(rows.length).toBeGreaterThanOrEqual(9);
          for (const row of rows) {
            expect(row.pdfCoreP50, `${row.fixture} pdf-core p50`).toBeLessThan(row.liteParseP50);
          }
        }),
      ),
    120_000,
  );
});
