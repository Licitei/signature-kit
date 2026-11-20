import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";

import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "../dist/config.js";
import type { PdfCoreLazyStats } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore, pdfCoreBytesSource } from "../dist/pdf-core.js";
import { buildPdf, stream } from "./pdf-fixture.js";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.pdf`, import.meta.url));
const page1 = { pageIndexes: [0] };
const catalog = "<< /Type /Catalog /Pages 2 0 R >>";
const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] >>";
const encode = new TextEncoder();
const decode = new TextDecoder();
const pageWithContent =
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>";
const firstPageText = "BT /F1 12 Tf 10 100 Td (Complete stream) Tj ET";

const moveFixtureXref = (pdf: string, misalignedOffset: number): Uint8Array => {
  const offset = (at: number) => String(at).padStart(10, "0");
  return encode.encode(
    pdf.replace(`${offset(pdf.indexOf("5 0 obj"))} 00000 n`, `${offset(misalignedOffset)} 00000 n`),
  );
};

describe("PdfCore byte-range robustness", () => {
  it.effect.each([false, true])(
    "does not truncate a stream at an unrelated xref offset (indirect length: %s)",
    (indirect) =>
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* PdfCore;
          const content = `% leading data\nendstream\nendobj\n% cut here\n${firstPageText}`;
          const length = indirect ? "6 0 R" : content.length;
          const built = decode.decode(
            buildPdf([
              catalog,
              "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
              pageWithContent,
              `<< /Length ${length} >>\nstream\n${content}\nendstream`,
              "null",
              String(content.length),
            ]),
          );
          const bytes = moveFixtureXref(built, built.indexOf("% cut here"));
          const doc = yield* core.openLazy(pdfCoreBytesSource(bytes));
          const expected = yield* core.text(bytes, page1);
          expect(expected).toEqual(["Complete stream"]);
          expect(yield* doc.text(page1)).toStrictEqual(expected);
          expect((yield* doc.stats).strategy).toBe("fallback");
        }),
      ).pipe(Effect.provide(layer)),
  );

  it.effect.each([false, true])(
    "validates the stream terminator beyond a misleading xref boundary (indirect length: %s)",
    (indirect) =>
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* PdfCore;
          const content = `${firstPageText}\nendstream\nendobj\nBT /F1 12 Tf 10 50 Td (Unexpected text) Tj ET\n`;
          const length = indirect ? "6 0 R" : content.length;
          const built = decode.decode(
            buildPdf([
              catalog,
              "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
              pageWithContent,
              `<< /Length ${length} >>\nstream\n${content}endobjSuffix\nendstream`,
              "null",
              String(content.length),
            ]),
          );
          const bytes = moveFixtureXref(built, built.indexOf("endobjSuffix") + 5);
          const doc = yield* core.openLazy(pdfCoreBytesSource(bytes));
          const expected = yield* core.text(bytes, page1);
          expect(expected).toEqual(["Complete stream"]);
          expect(yield* doc.text(page1)).toStrictEqual(expected);
          expect((yield* doc.stats).strategy).toBe("fallback");
        }),
      ).pipe(Effect.provide(layer)),
  );

  it.effect("rejects a large declared size and oversized responses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const source = pdfCoreBytesSource(fixture("links"));
        const oversized = yield* core.openLazy({
          ...source,
          read: (offset, length) =>
            source.read(offset, length).pipe(Effect.map(() => new Uint8Array(length + 1))),
        });
        const overstated = yield* core.openLazy({ ...source, size: source.size + 1 });
        for (const doc of [oversized, overstated]) {
          expect((yield* Effect.flip(doc.text(page1))).code).toBe(
            PdfCoreErrorCodeValue.rangeReadFailed,
          );
        }
        const bytes = fixture("links").subarray(0, 64);
        const understated = yield* core.openLazy({ ...source, size: bytes.length });
        expect((yield* Effect.flip(understated.text(page1))).code).toBe(
          (yield* Effect.flip(core.text(bytes, page1))).code,
        );
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("can retry an operation after a transient range failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const bytes = fixture("habilitacao-150");
        const source = pdfCoreBytesSource(bytes);
        const attempts = yield* Ref.make(0);
        const doc = yield* core.openLazy({
          ...source,
          read: (offset, length) =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(attempts, (n) => n + 1);
              if (count === 3) {
                return yield* new PdfCoreError({
                  code: PdfCoreErrorCodeValue.rangeReadFailed,
                  operation: PdfCoreOperationValue.readRange,
                  reason: "Transient source failure",
                });
              }
              return yield* source.read(offset, length);
            }),
        });
        expect((yield* Effect.flip(doc.text(page1))).code).toBe(
          PdfCoreErrorCodeValue.rangeReadFailed,
        );
        expect(yield* doc.text(page1)).toStrictEqual(yield* core.text(bytes, page1));
        expect((yield* doc.stats).strategy).toBe("lazy");
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("admits four slow reads in a round and serializes operations on the handle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const pad = stream(" ".repeat(8_192));
        const bytes = buildPdf([
          catalog,
          "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] /Contents [4 0 R 6 0 R 8 0 R 10 0 R 12 0 R] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>",
          stream(firstPageText),
          pad,
          stream(firstPageText),
          pad,
          stream(firstPageText),
          pad,
          stream(firstPageText),
          pad,
          stream(firstPageText),
          pad,
        ]);
        const source = pdfCoreBytesSource(bytes);
        const active = yield* Ref.make(0);
        const max = yield* Ref.make(0);
        const fourStarted = yield* Deferred.make<void>();
        const doc = yield* core.openLazy(
          {
            ...source,
            read: (offset, length) =>
              Effect.acquireUseRelease(
                Ref.updateAndGet(active, (n) => n + 1),
                (count) =>
                  Effect.gen(function* () {
                    yield* Ref.update(max, (previous) => Math.max(previous, count));
                    if (count === 4) yield* Deferred.succeed(fourStarted, undefined);
                    yield* Effect.sleep("40 millis");
                    return yield* source.read(offset, length);
                  }),
                () => Ref.update(active, (n) => n - 1),
              ),
          },
          { gapBytes: 0, probeBytes: 512 },
        );
        const inspect = { ...page1, text: true, links: true, runs: true };
        const text = yield* Effect.forkChild(doc.text(page1));
        const inspection = yield* Effect.forkChild(doc.inspect(inspect));
        for (let round = 0; round < 20; round += 1) {
          yield* TestClock.adjust("40 millis");
          if ((yield* Ref.get(max)) === 4) break;
        }
        expect(yield* Deferred.isDone(fourStarted)).toBe(true);
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(text)).toStrictEqual(yield* core.text(bytes, page1));
        expect(yield* Fiber.join(inspection)).toStrictEqual(yield* core.inspect(bytes, inspect));
        expect(yield* Ref.get(max)).toBe(4);
        expect(yield* Ref.get(active)).toBe(0);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("does not read after scope closure, including a pending operation", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const source = pdfCoreBytesSource(fixture("links"));
      const started = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const { doc, pending } = yield* Effect.scoped(
        Effect.gen(function* () {
          const doc = yield* core.openLazy({
            ...source,
            read: (offset, length) =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(source.read(offset, length)),
              ),
          });
          const pending = yield* Effect.forkChild(Effect.flip(doc.text(page1)));
          yield* Deferred.await(started);
          return { doc, pending };
        }),
      );
      yield* Deferred.succeed(resume, undefined);
      expect((yield* Fiber.join(pending)).code).toBe(PdfCoreErrorCodeValue.documentClosed);
      expect((yield* Effect.flip(doc.info)).code).toBe(PdfCoreErrorCodeValue.documentClosed);
      expect((yield* Effect.flip(doc.text(page1))).code).toBe(PdfCoreErrorCodeValue.documentClosed);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("handles a tiny input, junk around EOF, malformed linearization and repair", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const tiny = encode.encode("%PDF-1.7\n%%EOF\n");
        const invalid = yield* core.openLazy(pdfCoreBytesSource(tiny));
        expect((yield* Effect.flip(invalid.text(page1))).code).toBe(
          (yield* Effect.flip(core.text(tiny, page1))).code,
        );
        const valid = fixture("links");
        const hinted = decode.decode(
          buildPdf(
            [
              "<< /Linearized 1 /L 9999999999 /H [1 9999999999] /O 4 /E 130 /N 1 /T 0 >>",
              "<< /Type /Catalog /Pages 3 0 R >>",
              "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
              page.replace("/Parent 2", "/Parent 3"),
            ],
            2,
          ),
        );
        const badHints = hinted.replace("9999999999", String(hinted.length).padStart(10, "0"));
        const cases: ReadonlyArray<{
          name: string;
          bytes: Uint8Array;
          reason?: PdfCoreLazyStats["fallbackReason"];
        }> = [
          { name: "bad linearization hints", bytes: encode.encode(badHints) },
          {
            name: "startxref found after widening the tail probe",
            bytes: Buffer.concat([valid, encode.encode(" ".repeat(1_000))]),
          },
          {
            name: "trailing garbage",
            bytes: Buffer.concat([valid, encode.encode("trailing garbage")]),
          },
          {
            name: "startxref beyond tail probe",
            bytes: Buffer.concat([valid, encode.encode("trailing garbage".repeat(400))]),
            reason: "startxref",
          },
          {
            name: "leading garbage",
            bytes: Buffer.concat([encode.encode("leading garbage\n"), valid]),
            reason: "header",
          },
          { name: "broken xref", bytes: fixture("broken-xref"), reason: "cross-reference" },
          { name: "incremental xref", bytes: fixture("incremental-update") },
          { name: "object stream", bytes: fixture("object-streams") },
        ];
        for (const { name, bytes, reason } of cases) {
          const doc = yield* core.openLazy(pdfCoreBytesSource(bytes));
          const options = { ...page1, text: true, links: true, runs: true };
          expect(yield* doc.inspect(options), name).toStrictEqual(
            yield* core.inspect(bytes, options),
          );
          const stats = yield* doc.stats;
          expect(stats.strategy, name).toBe(reason === undefined ? "lazy" : "fallback");
          expect(stats.fallbackReason, name).toBe(reason);
        }
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("reports the page limit consistently on large page trees", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const count = 10_001;
        const kids = Array.from({ length: count }, (_, index) => `${index + 3} 0 R`).join(" ");
        const bytes = buildPdf([
          catalog,
          `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
          ...Array.from({ length: count }, () => page),
        ]);
        const doc = yield* core.openLazy(pdfCoreBytesSource(bytes));
        expect((yield* Effect.flip(doc.info)).code).toBe(PdfCoreErrorCodeValue.limitExceeded);
        expect((yield* Effect.flip(doc.text(page1))).code).toBe(
          (yield* Effect.flip(core.text(bytes, page1))).code,
        );
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("bounds concurrent handles and admits new documents after release", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const first = fixture("links");
      const second = fixture("markdown-basics");
      const expected = yield* Effect.all([core.text(first, page1), core.text(second, page1)]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const docs = yield* Effect.forEach(
            Array.from({ length: 1024 }, (_, index) => index),
            (index) => core.openLazy(pdfCoreBytesSource(index % 2 === 0 ? first : second)),
            { concurrency: 4 },
          );
          expect((yield* Effect.flip(core.openLazy(pdfCoreBytesSource(first)))).code).toBe(
            PdfCoreErrorCodeValue.limitExceeded,
          );
          const indexes = [0, 1, 30, 31, 1022, 1023];
          yield* Effect.forEach(
            indexes,
            (index) =>
              Effect.gen(function* () {
                const doc = docs[index];
                if (doc === undefined) return yield* Effect.die("Missing handle");
                expect(yield* doc.text(page1)).toStrictEqual(expected[index % 2]);
              }),
            { concurrency: 4, discard: true },
          );
        }),
      );
      const doc = yield* core.openLazy(pdfCoreBytesSource(first));
      expect(yield* doc.text(page1)).toStrictEqual(expected[0]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reuses linear memory across 1,000 parsed handle lifetimes", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const bytes = fixture("links");
      const source = pdfCoreBytesSource(bytes);
      const expected = yield* core.text(bytes, page1);
      const parse = Effect.scoped(
        Effect.gen(function* () {
          const doc = yield* core.openLazy(source);
          expect(yield* doc.text(page1)).toEqual(expected);
        }),
      );
      yield* parse;
      const initial = yield* core.wasmMemoryBytes();
      for (let cycle = 0; cycle < 1_000; cycle += 1) yield* parse;
      expect(yield* core.wasmMemoryBytes()).toBeLessThanOrEqual(initial + 65_536);
    }).pipe(Effect.provide(layer)),
  );
});
