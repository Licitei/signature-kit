import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore } from "../dist/pdf-core.js";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const enabled = process.env["SIGNATURE_KIT_PDF_CORPUS"] === "1";

const download = (url: string) =>
  Effect.promise(async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    return new Uint8Array(await response.arrayBuffer());
  });

const flat = (text: string): string => text.replaceAll("*", "").replace(/\s+/g, " ");

const markdown = (url: string, pageIndexes?: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const bytes = yield* download(url);
    const pages = yield* core.text(bytes, { format: "markdown", pageIndexes });
    return pages.map(flat);
  });

const ordered = (text: string, needles: ReadonlyArray<string>): void => {
  const positions = needles.map((needle) => text.indexOf(needle));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
};

describe.runIf(enabled)("PdfCore reading order on public documents", () => {
  it.effect(
    "reads the tracemonkey paper column by column",
    () =>
      Effect.gen(function* () {
        const [first] = yield* markdown(
          "https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf",
          [0],
        );
        ordered(first ?? "", [
          "Abstract",
          "Categories and Subject Descriptors",
          "General Terms",
          "Keywords",
          "1. Introduction",
          "client-side web programming and is used for the application logic",
          "Compilers for statically typed languages",
        ]);
      }).pipe(Effect.provide(layer)),
    60_000,
  );

  it.effect(
    "reads IRS Publication 17 narrow columns in order",
    () =>
      Effect.gen(function* () {
        const [page] = yield* markdown("https://www.irs.gov/pub/irs-pdf/p17.pdf", [4]);
        expect(page).toContain("Preparer e-file mandate. Most paid preparers must e-file");
        expect(page).toContain("Puerto Rico are no longer required");
        expect(page).not.toContain("|");
      }).pipe(Effect.provide(layer)),
    60_000,
  );

  it.effect(
    "keeps footnotes and captions out of page continuations in arXiv 1706.03762",
    () =>
      Effect.gen(function* () {
        const pages = yield* markdown("https://arxiv.org/pdf/1706.03762v7");
        const all = pages.join("\n");
        expect(all).toContain("yielding dv-dimensional output values. These are concatenated");
        expect(all).toContain("translation on the development set, newstest2013.");
        expect(all).toContain("† Work performed while at Google Brain.");
        expect(all).toContain("∗ Equal contribution.");
        expect(all).not.toContain("translation on the Table 3");
      }).pipe(Effect.provide(layer)),
    60_000,
  );
});
