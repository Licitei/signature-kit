import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { findPdfTextAnchors } from "../src/anchors";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import { CORPUS_FIXTURES_DIRECTORY, CORPUS_STAMP_SIZE } from "./text-anchors-corpus";

const AnchorRects = Schema.Array(
  Schema.Struct({
    pageIndex: Schema.Int,
    x: Schema.Finite,
    y: Schema.Finite,
    width: Schema.Finite,
    height: Schema.Finite,
  }),
);

describe("takumi-declaration corpus fixture", () => {
  it.effect("places the invisible text anchor from pdf-core generation", () =>
    Effect.gen(function* () {
      const pdf = new Uint8Array(
        readFileSync(join(CORPUS_FIXTURES_DIRECTORY, "takumi-declaration.pdf")),
      );
      const anchors = yield* findPdfTextAnchors({
        pdf,
        matchers: [{ text: "[[licitei-assinatura]]" }],
        stampSize: CORPUS_STAMP_SIZE,
        placement: "below",
        offset: 0,
      });
      const decoded = yield* Schema.decodeUnknownEffect(AnchorRects)(anchors);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]?.pageIndex).toBe(2);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});