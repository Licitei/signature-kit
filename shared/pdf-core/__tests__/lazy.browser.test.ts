import { Effect } from "effect";
import { expect, it } from "vitest";

import { pdfCoreBrowserLayer } from "../dist/browser.js";
import { PdfCore, pdfCoreBlobSource } from "../dist/pdf-core.js";
import pdfUrl from "./fixtures/habilitacao-150.pdf?url";

it("reads a Blob selectively and reuses the ranges for subsequent operations", async () => {
  const blob = await (await fetch(pdfUrl)).blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const doc = yield* core.openLazy(pdfCoreBlobSource(blob));
        const pageIndexes = [0];
        const inspect = { pageIndexes, text: true, links: true, runs: true };
        expect(yield* doc.info).toStrictEqual(yield* core.info(bytes));
        expect(yield* doc.text({ pageIndexes, format: "markdown" })).toStrictEqual(
          yield* core.text(bytes, { pageIndexes, format: "markdown" }),
        );
        const stats = yield* doc.stats;
        expect(yield* doc.inspect(inspect)).toStrictEqual(yield* core.inspect(bytes, inspect));
        expect(yield* doc.headings({ pageIndexes })).toStrictEqual(
          yield* core.headings(bytes, { pageIndexes }),
        );
        expect(yield* doc.stats).toEqual(stats);
        expect(stats.strategy).toBe("lazy");
        expect(stats.bytesRead).toBeLessThan(blob.size);
      }),
    ).pipe(Effect.provide(pdfCoreBrowserLayer)),
  );
});
