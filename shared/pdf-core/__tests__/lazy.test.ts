import { readFileSync, readdirSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import { pdfCoreFileLayer, pdfCoreFileSource } from "../dist/file.js";
import { loadPdfCoreNode } from "../dist/node.js";
import { PdfCore, pdfCoreBlobSource } from "../dist/pdf-core.js";

const layer = pdfCoreFileLayer.pipe(Layer.provideMerge(NodeServices.layer));
const fixtures = new URL("./fixtures/", import.meta.url);
const paths = [
  ...readdirSync(fixtures).filter((name) => name.endsWith(".pdf")),
  ...readdirSync(new URL("render/", fixtures))
    .filter((name) => name.endsWith(".pdf"))
    .map((name) => `render/${name}`),
  "encryption/signed.pdf",
].sort((left, right) => left.localeCompare(right));

describe("PdfCore byte-range documents", () => {
  for (const name of paths) {
    it.effect(
      `matches the full path for ${name}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const core = yield* PdfCore;
            const pdf = readFileSync(new URL(name, fixtures));
            const pageCount = (yield* core.inspect(pdf, { text: false, links: false })).pages
              .length;
            const reads: Array<readonly [number, number]> = [];
            const doc = yield* core.openLazy({
              size: pdf.byteLength,
              read: (offset, length) =>
                Effect.sync(() => {
                  reads.push([offset, length]);
                  return pdf.subarray(offset, offset + length);
                }),
            });
            for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
              const pageIndexes = [pageIndex];
              const markdown = { pageIndexes, format: "markdown" } satisfies Parameters<
                typeof doc.text
              >[0];
              expect(yield* doc.text(markdown)).toStrictEqual(yield* core.text(pdf, markdown));
              const stats = yield* doc.stats;
              if (pageIndex === 0 && pageCount > 1 && stats.strategy === "lazy") {
                expect(stats.bytesRead).toBeLessThan(pdf.byteLength);
              }
              if (name === "broken-xref.pdf") {
                expect(stats.strategy).toBe("fallback");
              }
              expect(yield* doc.text({ pageIndexes })).toStrictEqual(
                yield* core.text(pdf, { pageIndexes }),
              );
              expect(yield* doc.tables({ pageIndexes })).toStrictEqual(
                yield* core.tables(pdf, { pageIndexes }),
              );
              expect(yield* doc.renderPages({ pageIndexes })).toStrictEqual(
                yield* core.renderPages(pdf, { pageIndexes }),
              );
            }
            for (const pageIndexes of [[], [pageCount - 1, 0, pageCount - 1], undefined]) {
              const options = pageIndexes === undefined ? {} : { pageIndexes };
              const markdown = { ...options, format: "markdown" } satisfies Parameters<
                typeof doc.text
              >[0];
              expect(yield* doc.text(options)).toStrictEqual(yield* core.text(pdf, options));
              expect(yield* doc.text(markdown)).toStrictEqual(yield* core.text(pdf, markdown));
              expect(yield* doc.tables(options)).toStrictEqual(yield* core.tables(pdf, options));
              expect(yield* doc.renderPages(options)).toStrictEqual(
                yield* core.renderPages(pdf, options),
              );
            }
            const stats = yield* doc.stats;
            expect(stats.bytesRead).toBe(reads.reduce((sum, [, length]) => sum + length, 0));
            expect(
              reads.filter(([offset, length]) => offset === 0 && length === pdf.byteLength),
            ).toHaveLength(stats.strategy === "fallback" ? 1 : 0);
          }),
        ).pipe(Effect.provide(layer)),
      60_000,
    );
  }

  it.effect("caches ranges across operations and closes with the scope", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const doc = yield* Effect.scoped(
        Effect.gen(function* () {
          const source = yield* pdfCoreFileSource(
            new URL("habilitacao-150.pdf", fixtures).pathname,
          );
          const lazy = yield* core.openLazy(source);
          yield* lazy.text({ pageIndexes: [0] });
          const stats = yield* lazy.stats;
          yield* Effect.all(
            [
              lazy.text({ pageIndexes: [0], format: "markdown" }),
              lazy.tables({ pageIndexes: [0] }),
            ],
            { concurrency: 2 },
          );
          expect(yield* lazy.stats).toEqual(stats);
          expect(stats.strategy).toBe("lazy");
          expect(stats.bytesRead).toBeLessThan(source.size);
          return lazy;
        }),
      );
      const error = yield* Effect.flip(doc.text({ pageIndexes: [0] }));
      expect(error.code).toBe(PdfCoreErrorCodeValue.documentClosed);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports a short range without invoking the full loader", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const blob = new Blob([readFileSync(new URL("links.pdf", fixtures))]);
        const source = pdfCoreBlobSource(blob);
        const doc = yield* core.openLazy({
          size: source.size,
          read: (offset, length) => source.read(offset, length - 1),
        });
        const error = yield* Effect.flip(doc.text({ pageIndexes: [0] }));
        expect(error.code).toBe(PdfCoreErrorCodeValue.rangeReadFailed);
        expect((yield* doc.stats).strategy).toBe("lazy");
      }),
    ).pipe(Effect.provide(layer)),
  );

  it("opens, caches, and disposes a Promise document", async () => {
    const core = await loadPdfCoreNode();
    const pdf = readFileSync(new URL("links.pdf", fixtures));
    await using doc = await core.openLazy({
      size: pdf.length,
      read: (offset, length) => Promise.resolve(pdf.subarray(offset, offset + length)),
    });
    const options = { pageIndexes: [0], format: "markdown" } satisfies Parameters<
      typeof doc.text
    >[0];
    expect(await doc.text(options)).toEqual(await core.text(pdf, options));
    const stats = await doc.stats();
    expect(await doc.text(options)).toEqual(await core.text(pdf, options));
    expect(await doc.stats()).toEqual(stats);
    await doc[Symbol.asyncDispose]();
    await doc.close();
    await expect(doc.text(options)).rejects.toMatchObject({
      code: PdfCoreErrorCodeValue.documentClosed,
    });
  });
});
