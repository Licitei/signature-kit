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

const pdfObjects = (
  objects: ReadonlyArray<string>,
  padding?: { readonly after: number; readonly bytes: number },
): Uint8Array => {
  let pdf = "%PDF-1.7\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    if (padding?.after === index + 1) {
      pdf += " ".repeat(padding.bytes);
    }
    return offset.toString().padStart(10, "0");
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${offset} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
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
            const ordered = reads.slice().sort(([left], [right]) => left - right);
            let end = 0;
            for (const [offset, length] of ordered) {
              expect(offset).toBeGreaterThanOrEqual(end);
              end = offset + length;
            }
            expect(stats.bytesRead).toBeLessThanOrEqual(pdf.byteLength);
            if (stats.strategy === "fallback") {
              expect(stats.bytesRead).toBe(pdf.byteLength);
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

  it.effect.each([1, 17])("skips unused form streams with %i unused resource names", (count) =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const stream = (dictionary: string, data: string) =>
          `<< ${dictionary} /Length ${data.length} >>\nstream\n${data}\nendstream`;
        const unused = Array.from({ length: count }, (_, index) => `/Other${index} 7 0 R`);
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

  it.effect("accepts a complete content stream before the next xref offset", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const content = "BT /F1 12 Tf 20 100 Td (Selected) Tj ET";
        const pdf = pdfObjects(
          [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
          ],
          { after: 4, bytes: 1024 * 1024 },
        );
        const doc = yield* core.openLazy(pdfCoreBytesSource(pdf), { gapBytes: 0 });
        const options = { pageIndexes: [0] };
        const result = yield* doc.text(options);
        expect(result).toStrictEqual(yield* core.text(pdf, options));
        expect(result.join(" ")).toContain("Selected");
        const stats = yield* doc.stats;
        expect(stats.strategy).toBe("lazy");
        expect(stats.bytesRead).toBeLessThan(pdf.byteLength / 4);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("reads the requested prefix and lets explicit indexes override it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const bytes = readFileSync(new URL("habilitacao-150.pdf", fixtures));
        const source = pdfCoreBytesSource(bytes);
        const doc = yield* core.openLazy(source, { pageLimit: 2 });
        expect(yield* doc.text({ format: "markdown" })).toEqual(
          yield* core.text(bytes, { pageIndexes: [0, 1], format: "markdown" }),
        );
        expect((yield* doc.stats).bytesRead).toBeLessThan(bytes.length);
        expect((yield* doc.stats).strategy).toBe("lazy");
        expect(yield* doc.tables()).toEqual(yield* core.tables(bytes, { pageIndexes: [0, 1] }));
        expect(yield* doc.text({ pageIndexes: [2] })).toEqual(
          yield* core.text(bytes, { pageIndexes: [2] }),
        );
        expect(yield* doc.text({ pageIndexes: [] })).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("parses a single non-first page without reading the other content streams", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const stream = (data: string) => `<< /Length ${data.length} >>\nstream\n${data}\nendstream`;
        const large = stream(" ".repeat(512 * 1024));
        const bytes = pdfObjects([
          "<< /Type /Catalog /Pages 2 0 R >>",
          "<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] /MediaBox [0 0 200 200] /Resources << /Font << /F1 9 0 R >> >> >>",
          "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>",
          "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>",
          "<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>",
          large,
          stream("BT /F1 12 Tf 1 0 0 1 20 100 Tm (Middle page) Tj ET"),
          large,
          "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ]);
        const doc = yield* core.openLazy(pdfCoreBytesSource(bytes), { gapBytes: 0 });
        const selection = { pageIndexes: [1] };
        expect(yield* doc.text(selection)).toEqual(["Middle page"]);
        expect(yield* doc.renderPages(selection)).toEqual(
          yield* core.renderPages(bytes, selection),
        );
        const stats = yield* doc.stats;
        expect(stats.strategy).toBe("lazy");
        expect(stats.bytesRead).toBeLessThan(bytes.length / 4);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("honours the page limit during fallback and fetches each byte only once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const bytes = readFileSync(new URL("broken-xref.pdf", fixtures));
        const doc = yield* core.openLazy(pdfCoreBytesSource(bytes), {
          pageLimit: 1,
          probeBytes: 128,
          maxRoundBytes: 256,
        });
        expect(yield* doc.text()).toEqual(yield* core.text(bytes, { pageIndexes: [0] }));
        expect(yield* doc.renderPages({ scale: 0.5 })).toEqual(
          yield* core.renderPages(bytes, { pageIndexes: [0], scale: 0.5 }),
        );
        const stats = yield* doc.stats;
        expect(stats.strategy).toBe("fallback");
        expect(stats.bytesRead).toBe(bytes.length);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("releases page ranges between operations when the cache budget is zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const bytes = readFileSync(new URL("habilitacao-150.pdf", fixtures));
        const doc = yield* core.openLazy(pdfCoreBytesSource(bytes), {
          pageLimit: 1,
          maxCachedBytes: 0,
          allowFullRead: false,
        });
        expect(yield* doc.text()).toEqual(yield* core.text(bytes, { pageIndexes: [0] }));
        const first = yield* doc.stats;
        expect(first.cachedBytes).toBe(0);
        expect(first.bytesRead).toBeLessThan(bytes.length);
        expect(yield* doc.text({ pageIndexes: [4] })).toEqual(
          yield* core.text(bytes, { pageIndexes: [4] }),
        );
        const second = yield* doc.stats;
        expect(second.cachedBytes).toBe(0);
        expect(second.strategy).toBe("lazy");
        expect(second.bytesRead).toBeGreaterThan(first.bytesRead);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("can decline full recovery before fetching the remaining file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const broken = readFileSync(new URL("broken-xref.pdf", fixtures));
        const bytes = new Uint8Array(64 * 1024).fill(32);
        bytes.set(broken);
        const doc = yield* core.openLazy(pdfCoreBytesSource(bytes), {
          pageLimit: 1,
          probeBytes: 128,
          maxCachedBytes: 0,
          allowFullRead: false,
        });
        const result = yield* Effect.flip(doc.text());
        expect(result.code).toBe(PdfCoreErrorCodeValue.unsupportedFeature);
        const stats = yield* doc.stats;
        expect(stats.bytesRead).toBeLessThan(bytes.length / 4);
        expect(stats.cachedBytes).toBe(0);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("clamps a page limit to the actual page count and accepts zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const bytes = readFileSync(new URL("links.pdf", fixtures));
        const source = pdfCoreBytesSource(bytes);
        const all = yield* core.openLazy(source, { pageLimit: 100 });
        const none = yield* core.openLazy(source, { pageLimit: 0 });
        expect(yield* all.text()).toEqual(yield* core.text(bytes));
        expect(yield* none.text()).toEqual([]);
        expect(yield* none.tables()).toEqual([]);
        expect(yield* none.renderPages()).toEqual([]);
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

  it.effect("reports OCR candidates by original page index and renders only those pages", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const stream = (data: string) => `<< /Length ${data.length} >>\nstream\n${data}\nendstream`;
        const image = "q 180 0 0 180 10 10 cm BI /W 1 /H 1 /BPC 8 /CS /RGB /F /AHx ID 000000> EI Q";
        const text = (value: string) => `BT /F1 12 Tf 1 0 0 1 20 100 Tm (${value}) Tj ET`;
        const bytes = pdfObjects([
          "<< /Type /Catalog /Pages 2 0 R >>",
          "<< /Type /Pages /Count 4 /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /MediaBox [0 0 200 200] /Resources << /Font << /F1 11 0 R >> >> >>",
          "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>",
          "<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>",
          "<< /Type /Page /Parent 2 0 R /Contents 9 0 R >>",
          "<< /Type /Page /Parent 2 0 R /Contents 10 0 R >>",
          stream(text("Native text")),
          stream(image),
          stream(image + " " + text("Stamp")),
          stream(""),
          "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ]);
        const diagnostics = yield* core.pageDiagnostics(bytes);
        expect(
          diagnostics.map(({ pageIndex, textLayer, imageCount }) => [
            pageIndex,
            textLayer,
            imageCount,
          ]),
        ).toEqual([
          [0, "usable", 0],
          [1, "none", 1],
          [2, "weak", 1],
          [3, "none", 0],
        ]);
        const doc = yield* core.openLazy(pdfCoreBytesSource(bytes), {
          pageLimit: 2,
          allowFullRead: false,
        });
        expect(yield* doc.pageDiagnostics()).toEqual(diagnostics.slice(0, 2));
        expect(yield* doc.pageDiagnostics({ pageIndexes: [2, 0] })).toEqual([
          diagnostics[2],
          diagnostics[0],
        ]);
        const pageIndexes = diagnostics
          .filter((item) => item.textLayer !== "usable" && item.imageCount > 0)
          .map((item) => item.pageIndex);
        const pages = yield* doc.renderPages({ pageIndexes, scale: 0.5 });
        expect(pages.map((item) => item.pageIndex)).toEqual([1, 2]);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("copies exactly the seven OCR pages of a ten-page mixed PDF", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const nativePages = [0, 2, 7];
      const pageCount = 10;
      const pageObjects = Array.from({ length: pageCount }, (_, index) => index + 4);
      const image = "BI /W 1 /H 1 /BPC 8 /CS /RGB /F /AHx ID 000000> EI";
      const pdf = pdfObjects([
        "<< /Type /Catalog /Pages 2 0 R >>",
        `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjects.map((id) => `${id} 0 R`).join(" ")}] /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> >>`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ...pageObjects.map(
          (id) => `<< /Type /Page /Parent 2 0 R /Contents ${id + pageCount} 0 R >>`,
        ),
        ...pageObjects.map((_, index) => {
          const content = nativePages.includes(index)
            ? `BT /F1 12 Tf 1 0 0 1 20 100 Tm (Native page ${index + 1}) Tj ET`
            : `q 180 0 0 180 ${index + 1} 10 cm ${image} Q`;
          return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
        }),
      ]);

      const diagnostics = yield* core.pageDiagnostics(pdf);
      const pageIndexes = diagnostics
        .filter((page) => page.textLayer !== "usable")
        .map((page) => page.pageIndex);
      expect(pageIndexes).toEqual([1, 3, 4, 5, 6, 8, 9]);

      const subset = yield* core.merge([{ pdf, pageIndexes }], { dropWidgets: true });
      expect(subset.byteLength).toBeLessThan(pdf.byteLength);
      const expected = yield* core.renderPages(pdf, { pageIndexes });
      const actual = yield* core.renderPages(subset);
      expect(actual).toEqual(expected.map((page, pageIndex) => ({ ...page, pageIndex })));
    }).pipe(Effect.provide(layer)),
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
