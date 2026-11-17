import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { findPdfTextAnchors } from "../src/anchors";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import {
  CORPUS_FIXTURES_DIRECTORY,
  CORPUS_STAMP_SIZE,
  corpusAnchorMatchers,
  corpusFixtureNames,
} from "./text-anchors-corpus";

const AnchorGolden = Schema.Array(
  Schema.Struct({
    pageIndex: Schema.Int,
    x: Schema.Finite,
    y: Schema.Finite,
    width: Schema.Finite,
    height: Schema.Finite,
  }),
);

const TOLERANCE_PT = 1;

describe("text anchors against LiteParse goldens", () => {
  const fixtures = corpusFixtureNames();

  it("covers the whole corpus", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(9);
  });

  for (const fixture of fixtures) {
    it.effect(`places the same anchors as LiteParse for ${fixture}`, () =>
      Effect.gen(function* () {
        const stem = fixture.replace(/\.pdf$/u, "");
        const golden = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AnchorGolden))(
          readFileSync(join(CORPUS_FIXTURES_DIRECTORY, `${stem}.anchors.json`), "utf8"),
        );
        const pdf = new Uint8Array(readFileSync(join(CORPUS_FIXTURES_DIRECTORY, fixture)));

        const anchors = yield* findPdfTextAnchors({
          pdf,
          matchers: corpusAnchorMatchers(fixture),
          stampSize: CORPUS_STAMP_SIZE,
          placement: "below",
          offset: 0,
        });

        expect(anchors).toHaveLength(golden.length);
        for (const expected of golden) {
          const match = anchors.find(
            (anchor) =>
              anchor.pageIndex === expected.pageIndex &&
              Math.abs(anchor.x - expected.x) <= TOLERANCE_PT &&
              Math.abs(anchor.y - expected.y) <= TOLERANCE_PT &&
              Math.abs(anchor.width - expected.width) <= TOLERANCE_PT &&
              Math.abs(anchor.height - expected.height) <= TOLERANCE_PT,
          );
          expect(
            match,
            `missing anchor for ${fixture} on page ${expected.pageIndex}`,
          ).toBeDefined();
        }
      }).pipe(Effect.provide(pdfCoreTestLayer)),
    );
  }
});
