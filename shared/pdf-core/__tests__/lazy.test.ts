import { readFileSync, readdirSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Ref } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import { pdfCoreFileLayer, pdfCoreFileSource } from "../dist/file.js";
import { loadPdfCoreNode } from "../dist/node.js";
import { PdfCore, pdfCoreBlobSource, pdfCoreBytesSource } from "../dist/pdf-core.js";

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

  it.effect("starts both probes before either read finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const bytes = readFileSync(new URL("habilitacao-150.pdf", fixtures));
        const source = pdfCoreBytesSource(bytes);
        const bothStarted = yield* Deferred.make<void>();
        const started = yield* Ref.make(0);
        const probeBytes = 1024;
        const doc = yield* core.openLazy(
          {
            size: source.size,
            read: (offset, length) =>
              Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(started, (current) => current + 1);
                if (count <= 2) {
                  expect(length).toBe(probeBytes);
                  expect([0, source.size - probeBytes]).toContain(offset);
                  if (count === 2) {
                    yield* Deferred.succeed(bothStarted, undefined);
                  }
                  yield* Deferred.await(bothStarted);
                }
                return yield* source.read(offset, length);
              }),
          },
          { probeBytes, gapBytes: 0, maxRoundBytes: 2 * probeBytes },
        );
        const options = { pageIndexes: [0] };
        expect(yield* doc.text(options)).toStrictEqual(yield* core.text(bytes, options));
        expect((yield* doc.stats).strategy).toBe("lazy");
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("fetches a used form without loading the shared form dictionary's other streams", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const stream = (dictionary: string, data: string) =>
          `<< ${dictionary} /Length ${data.length} >>\nstream\n${data}\nendstream`;
        const unused = Array.from({ length: 17 }, (_, index) => `/Other${index} 7 0 R`);
        const font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
        const form = "/Type /XObject /Subtype /Form /BBox [0 0 200 200]";
        const objects = [
          "<< /Type /Catalog /Pages 2 0 R >>",
          "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 ${font} >> /XObject << /Used 6 0 R ${unused.join(" ")} >> >> >>`,
          stream("", "/Used Do"),
          stream("", " ".repeat(256 * 1024)),
          stream(form, "BT /F1 12 Tf 1 0 0 1 20 100 Tm (Selected) Tj ET"),
          stream(form, " ".repeat(256 * 1024)),
        ];
        let pdf = "%PDF-1.7\n";
        const offsets = objects.map((object, index) => {
          const offset = pdf.length;
          pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
          return offset.toString().padStart(10, "0");
        });
        const xref = pdf.length;
        pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.map((offset) => `${offset} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size 8 >>\nstartxref\n${xref}\n%%EOF\n`;
        const bytes = new TextEncoder().encode(pdf);
        const doc = yield* core.openLazy(pdfCoreBytesSource(bytes), { gapBytes: 0 });
        const options = { pageIndexes: [0] };
        const result = yield* doc.text(options);
        expect(result).toStrictEqual(yield* core.text(bytes, options));
        expect(result.join(" ")).toContain("Selected");
        const stats = yield* doc.stats;
        expect(stats.strategy).toBe("lazy");
        expect(stats.rounds).toBe(2);
        expect(stats.bytesRead).toBeLessThan(bytes.byteLength / 2);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("rejects invalid tuning and oversized sources before reading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const source = {
          size: 10,
          read: () => Effect.die("Unexpected range read"),
        };
        const invalid = yield* Effect.flip(core.openLazy(source, { gapBytes: -1 }));
        expect(invalid.code).toBe(PdfCoreErrorCodeValue.invalidOptions);
        expect(invalid.schemaName).toBe("PdfCoreLazyOptions");
        const oversized = yield* Effect.flip(core.openLazy({ ...source, size: 4 * 1024 ** 3 }));
        expect(oversized.code).toBe(PdfCoreErrorCodeValue.limitExceeded);
      }),
    ).pipe(Effect.provide(layer)),
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
    expect(await doc.headings(options)).toEqual(await core.headings(pdf, options));
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
