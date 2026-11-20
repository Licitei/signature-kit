import { readFileSync, readdirSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";

import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "../dist/config.js";
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

const pdfObjects = (objects: ReadonlyArray<string>) => {
  let pdf = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset.toString().padStart(10, "0");
  });
  const xref = pdf.length;
  const size = objects.length + 1;
  pdf += `xref\n0 ${size}\n0000000000 65535 f \n${offsets.map((offset) => `${offset} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size ${size} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

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
                expect(stats.fallbackReason).toBeDefined();
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
            expect(stats.bytesRead).toBeLessThanOrEqual(pdf.byteLength);
            if (stats.strategy === "fallback") {
              expect(stats.bytesRead).toBe(pdf.byteLength);
            }
            let previousEnd = 0;
            for (const [offset, length] of reads.sort(([left], [right]) => left - right)) {
              expect(offset).toBeGreaterThanOrEqual(previousEnd);
              previousEnd = offset + length;
            }
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

  it.effect("reads the gaps in bounded rounds when startxref is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const fixture = readFileSync(new URL("links.pdf", fixtures));
        const xrefAt = fixture.lastIndexOf("startxref");
        expect(xrefAt).toBeGreaterThan(0);
        const pdf = fixture.subarray(0, xrefAt);
        const source = pdfCoreBytesSource(pdf);
        const coverage = new Uint8Array(pdf.length);
        const lazy = yield* core.openLazy(
          {
            size: source.size,
            read: (offset, length) =>
              Effect.gen(function* () {
                expect(length).toBeLessThanOrEqual(128);
                expect(
                  coverage.subarray(offset, offset + length).every((count) => count === 0),
                ).toBe(true);
                coverage.fill(1, offset, offset + length);
                return yield* source.read(offset, length);
              }),
          },
          { probeBytes: 128, gapBytes: 0, maxRoundBytes: 128 },
        );
        const options = { pageIndexes: [0] };
        expect(yield* lazy.text(options)).toStrictEqual(yield* core.text(pdf, options));
        expect(yield* lazy.tables(options)).toStrictEqual(yield* core.tables(pdf, options));
        const stats = yield* lazy.stats;
        expect(stats).toMatchObject({
          bytesRead: pdf.length,
          strategy: "fallback",
          fallbackReason: "missingStartxref",
        });
        expect(stats.rounds).toBe(Math.ceil(pdf.length / 128));
        expect(coverage.every((count) => count === 1)).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
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
        const bytes = pdfObjects(objects);
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

  it.effect("omits the signature payload when extracting or rendering a signed page", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const content = "BT /F1 12 Tf 1 0 0 1 20 100 Tm (Signed page) Tj ET";
        const appearance = "0 0 20 10 re f";
        const pdf = pdfObjects([
          "<< /Type /Catalog /Pages 2 0 R >>",
          "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Annots [5 0 R] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>",
          `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
          "<< /Type /Annot /Subtype /Widget /FT /Sig /V 6 0 R /Rect [50 50 70 60] /AP << /N 7 0 R >> >>",
          `<< /Type /Sig /Contents <${"00".repeat(256 * 1024)}> >>`,
          `<< /Type /XObject /Subtype /Form /BBox [0 0 20 10] /Length ${appearance.length} >>\nstream\n${appearance}\nendstream`,
        ]);
        const document = yield* core.openLazy(pdfCoreBytesSource(pdf), { gapBytes: 0 });
        const options = { pageIndexes: [0] };
        const text = yield* document.text(options);
        expect(text).toStrictEqual(yield* core.text(pdf, options));
        expect(text.join(" ")).toContain("Signed page");
        expect(yield* document.renderPages(options)).toStrictEqual(
          yield* core.renderPages(pdf, options),
        );
        const stats = yield* document.stats;
        expect(stats.strategy).toBe("lazy");
        expect(stats.bytesRead).toBeLessThan(pdf.byteLength / 2);
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

  it.effect(
    "matches page diagnostics, text, images, tables and rendering across selections and calls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* PdfCore;
          const pdf = readFileSync(new URL("incremental-update.pdf", fixtures));
          const { pages } = yield* core.inspect(pdf, { text: false, links: false });
          const doc = yield* core.openLazy(pdfCoreBlobSource(new Blob([pdf])), {
            probeBytes: 128,
            gapBytes: 0,
          });
          for (const pageIndexes of [
            [pages.length - 1],
            undefined,
            [0, pages.length - 1, 0],
            [0],
          ]) {
            const options = pageIndexes === undefined ? {} : { pageIndexes };
            const markdown = {
              ...options,
              format: "markdown",
              dropRunningHeaders: true,
            } satisfies Parameters<typeof doc.text>[0];
            const actual = yield* Effect.all(
              {
                text: doc.text(markdown),
                textPages: doc.textPages(markdown),
                tables: doc.tables(options),
                diagnostics: doc.pageDiagnostics(options),
                images: doc.pageImages(options),
                render: doc.renderPages(options),
              },
              { concurrency: "unbounded" },
            );
            expect(actual).toStrictEqual({
              text: yield* core.text(pdf, markdown),
              textPages: yield* core.textPages(pdf, markdown),
              tables: yield* core.tables(pdf, options),
              diagnostics: yield* core.pageDiagnostics(pdf, options),
              images: yield* core.pageImages(pdf, options),
              render: yield* core.renderPages(pdf, options),
            });
          }
        }),
      ).pipe(Effect.provide(layer)),
  );

  it.effect("returns the full-load error for corrupt and truncated PDFs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const pdf = readFileSync(new URL("links.pdf", fixtures));
        for (const bytes of [pdf.subarray(0, 64), new TextEncoder().encode("%PDF-1.7\ninvalid")]) {
          const doc = yield* core.openLazy(pdfCoreBytesSource(bytes));
          const full = yield* Effect.flip(core.text(bytes));
          const lazy = yield* Effect.flip(doc.text());
          expect(lazy).toMatchObject({
            code: full.code,
            operation: full.operation,
            reason: full.reason,
          });
          expect((yield* doc.stats).strategy).toBe("fallback");
        }
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("releases interrupted reads and closes their document with the scope", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = readFileSync(new URL("links.pdf", fixtures));
      const source = pdfCoreBytesSource(pdf);
      const started = yield* Deferred.make<void>();
      const released = yield* Ref.make(0);
      const doc = yield* Effect.scoped(
        Effect.gen(function* () {
          const document = yield* core.openLazy({
            size: source.size,
            read: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Ref.update(released, (count) => count + 1)),
              ),
          });
          const fiber = yield* Effect.forkScoped(document.text());
          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);
          expect(yield* Ref.get(released)).toBeGreaterThan(0);
          return document;
        }),
      );
      expect((yield* Effect.flip(doc.text())).code).toBe(PdfCoreErrorCodeValue.documentClosed);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const healthy = yield* core.openLazy(source);
          expect(yield* healthy.text()).toEqual(yield* core.text(pdf));
        }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("classifies a failed Effect source read and retries on the same document", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const pdf = readFileSync(new URL("links.pdf", fixtures));
        const source = pdfCoreBytesSource(pdf);
        const available = yield* Ref.make(false);
        const doc = yield* core.openLazy({
          size: source.size,
          read: (offset, length) =>
            Ref.get(available).pipe(
              Effect.flatMap((ready) =>
                ready
                  ? source.read(offset, length)
                  : Effect.fail(
                      new PdfCoreError({
                        code: PdfCoreErrorCodeValue.limitExceeded,
                        operation: PdfCoreOperationValue.readRange,
                        reason: "The source exhausted its read quota.",
                      }),
                    ),
              ),
            ),
        });
        const error = yield* Effect.flip(doc.text());
        expect(error).toMatchObject({
          code: PdfCoreErrorCodeValue.rangeReadFailed,
          operation: PdfCoreOperationValue.readRange,
        });
        yield* Ref.set(available, true);
        expect(yield* doc.text()).toEqual(yield* core.text(pdf));
      }),
    ).pipe(Effect.provide(layer)),
  );

  it("reports Promise source rejections as range read failures", async () => {
    const core = await loadPdfCoreNode();
    const pdf = readFileSync(new URL("links.pdf", fixtures));
    await using doc = await core.openLazy({
      size: pdf.length,
      read: () => Promise.reject(new Error("unavailable")),
    });
    await expect(doc.text()).rejects.toMatchObject({ code: PdfCoreErrorCodeValue.rangeReadFailed });
  });

  it("reuses WASM memory across 1,000 Promise open and close cycles", async () => {
    const core = await loadPdfCoreNode();
    const pdf = readFileSync(new URL("links.pdf", fixtures));
    const source = {
      size: pdf.length,
      read: (offset: number, length: number) => pdf.subarray(offset, offset + length),
    };
    const cycle = async () => {
      await using doc = await core.openLazy(source);
      await doc.textPages();
    };
    await cycle();
    const warmBytes = await core.wasmMemoryBytes();
    for (let index = 0; index < 1_000; index += 1) await cycle();
    expect(await core.wasmMemoryBytes()).toBe(warmBytes);
  }, 30_000);

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
