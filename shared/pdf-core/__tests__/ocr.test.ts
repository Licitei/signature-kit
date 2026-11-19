import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Ref } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import type { PdfCoreEditOperation, PdfCoreOcrRequest, PdfCoreOcrResult } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { loadPdfCoreNode } from "../dist/node.js";
import { PdfCore, pdfCoreBytesSource } from "../dist/pdf-core.js";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));
const encoder = new TextEncoder();
const width = 300;
const height = 300;
const entries = [
  ["ITEM", "QTY", "COST"],
  ["INK", "10", "25"],
  ["PEN", "20", "50"],
].flatMap((row, line) =>
  row.map((text, col) => ({
    text,
    line,
    x: 45 + col * 75,
    y: 210 - line * 16,
  })),
);

const glyphs: Readonly<Record<string, ReadonlyArray<string>>> = {
  I: ["111", "010", "010", "010", "111"],
  T: ["111", "010", "010", "010", "010"],
  E: ["111", "100", "110", "100", "111"],
  M: ["101", "111", "111", "101", "101"],
  Q: ["111", "101", "101", "111", "001"],
  Y: ["101", "101", "010", "010", "010"],
  C: ["111", "100", "100", "100", "111"],
  O: ["111", "101", "101", "101", "111"],
  S: ["111", "100", "111", "001", "111"],
  N: ["101", "111", "101", "101", "101"],
  K: ["101", "110", "100", "110", "101"],
  P: ["111", "101", "111", "100", "100"],
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "5": ["111", "100", "111", "001", "111"],
};

const grayscale = (): Uint8Array<ArrayBuffer> => {
  const pixels = new Uint8Array(width * height).fill(255);
  for (const { text, x, y } of entries) {
    Array.from(text).forEach((letter, index) => {
      const glyph = glyphs[letter];
      glyph?.forEach((row, dy) => {
        const start = (height - y - 10 + dy * 2) * width + x + index * 7;
        Array.from(row).forEach((pixel, dx) => {
          if (pixel === "1") {
            const at = start + dx * 2;
            pixels.fill(0, at, at + 2);
            pixels.fill(0, at + width, at + width + 2);
          }
        });
      });
    });
  }
  return pixels;
};

const fixture = Effect.fn(function* (
  pages: ReadonlyArray<"cover" | "scan" | "overlay" | "native" | "blank">,
  padding = 0,
) {
  const core = yield* PdfCore;
  const pdf = yield* core.create({
    pages: [{ width, height }, ...pages.slice(1).map(() => ({ width, height }))],
  });
  const { nextObjectNumber } = yield* core.document(pdf);
  const font = { number: nextObjectNumber, generation: 0 };
  const scan = { number: nextObjectNumber + 1, generation: 0 };
  const ops: Array<PdfCoreEditOperation> = [
    { op: "standardFont", ref: font, baseFont: "Helvetica" },
    {
      op: "image",
      ref: scan,
      width,
      height,
      colorSpace: "gray",
      alpha: false,
      samples: grayscale(),
    },
  ];
  pages.forEach((kind, pageIndex) => {
    if (kind === "blank") return;
    const native =
      kind === "native"
        ? entries.map(({ text, x, y }) => `BT /F1 10 Tf ${x} ${y} Td (${text}) Tj ET`).join("\n")
        : "";
    const cover =
      kind === "cover"
        ? `BT /F1 12 Tf 40 220 Td (Native cover) Tj ET\n%${"A".repeat(padding)}\n`
        : "";
    const picture =
      kind === "scan" || kind === "overlay" ? `q ${width} 0 0 ${height} 0 0 cm /Scan Do Q\n` : "";
    const overlay =
      kind === "overlay" ? "BT /F1 10 Tf 3 Tr 45 210 Td (Stale text layer) Tj ET" : "";
    ops.push(
      { op: "addResource", pageIndex, category: "Font", name: "F1", value: `${font.number} 0 R` },
      {
        op: "appendContent",
        pageIndex,
        ref: { number: nextObjectNumber + 2 + pageIndex, generation: 0 },
        data: encoder.encode(native + cover + picture + overlay),
        compress: false,
      },
    );
    if (picture !== "")
      ops.push({
        op: "addResource",
        pageIndex,
        category: "XObject",
        name: "Scan",
        value: `${scan.number} 0 R`,
      });
  });
  return yield* core.edit(pdf, ops, { mode: "rewrite" });
});

const recognizeTable = (request: PdfCoreOcrRequest): PdfCoreOcrResult => ({
  kind: "words",
  width: request.image.width,
  height: request.image.height,
  words: entries.map(({ text, line, x, y }) => ({
    text,
    line,
    confidence: 0.875,
    box: [x, height - y - 10, x + text.length * 4.5, height - y],
  })),
});

class Recognizer extends Context.Service<Recognizer, (pageIndex: number) => string>()(
  "test/OcrRecognizer",
) {}

describe("caller-supplied PDF OCR", () => {
  it.effect("uses the native table and Markdown layout and replaces an invisible overlay", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = yield* fixture(["cover", "overlay"]);
      const twin = yield* fixture(["cover", "native"]);
      const calls = yield* Ref.make<Array<number>>([]);
      const ocr = {
        recognize: Effect.fn(function* (request: PdfCoreOcrRequest) {
          yield* Ref.update(calls, (current) => [...current, request.pageIndex]);
          expect(request).toMatchObject({
            pageIndex: 1,
            pageBox: [0, 0, width, height],
            rotate: 0,
            textLayer: "weak",
            placement: [width, 0, 0, height, 0, 0],
            image: { width, height, mediaType: "image/png", dpiX: 72, dpiY: 72 },
          });
          expect(request.image.bytes.slice(0, 4)).toEqual(Uint8Array.of(137, 80, 78, 71));
          return recognizeTable(request);
        }),
      };
      for (const format of ["text", "markdown"] satisfies ReadonlyArray<"text" | "markdown">) {
        expect(yield* core.text(pdf, { ocr, format })).toEqual(yield* core.text(twin, { format }));
      }
      const tables = yield* core.tables(pdf, { ocr });
      const native = yield* core.tables(twin);
      expect(native).toHaveLength(1);
      expect(
        tables.map(({ bbox: _bbox, cells, ...table }) => ({
          ...table,
          cells: cells.map(({ bbox: _cellBox, ...cell }) => cell),
        })),
      ).toEqual(
        native.map(({ bbox: _bbox, cells, ...table }) => ({
          ...table,
          source: "ocr",
          cells: cells.map(({ bbox: _cellBox, ...cell }) => cell),
        })),
      );
      const pages = yield* core.textPages(pdf, { ocr, pageIndexes: [1, 0, 1] });
      expect(pages).toMatchObject([
        { pageIndex: 1, source: "ocr", textLayer: "weak", confidence: 0.875 },
        { pageIndex: 0, source: "native", text: "Native cover", textLayer: "usable" },
      ]);
      expect(yield* Ref.get(calls)).toEqual([1, 1, 1, 1]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "checks image availability and result geometry and preserves the Effect error and environment",
    () =>
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const blank = yield* fixture(["blank"]);
        const scan = yield* fixture(["scan"]);
        const text = (value: string): PdfCoreOcrResult => ({ kind: "text", text: value });
        const notCalled = () => Effect.die("Unexpected recognition");
        const missing = yield* Effect.flip(core.text(blank, { ocr: { recognize: notCalled } }));
        expect(missing).toMatchObject({
          code: PdfCoreErrorCodeValue.pageImageUnavailable,
          pageIndex: 0,
        });
        expect(yield* core.text(scan, { ocr: { policy: "never", recognize: notCalled } })).toEqual([
          "",
        ]);
        const invalid = yield* Effect.flip(
          core.text(scan, {
            ocr: {
              recognize: (request) =>
                Effect.succeed({
                  kind: "words",
                  width: request.image.width,
                  height: request.image.height,
                  words: [{ text: "invalid", box: [1, 1, 0, 0] }],
                }),
            },
          }),
        );
        expect(invalid).toMatchObject({
          code: PdfCoreErrorCodeValue.invalidOcrResult,
          pageIndex: 0,
        });
        const service = core.text(scan, {
          ocr: {
            recognize: ({ pageIndex }) =>
              Effect.map(Recognizer, (resolve) => text(resolve(pageIndex))),
          },
        });
        expect(
          yield* service.pipe(Effect.provideService(Recognizer, (index) => `Page ${index}`)),
        ).toEqual(["Page 0"]);
        const upstream = { message: "recognizer service unavailable" };
        expect(
          yield* Effect.flip(
            core.text(scan, {
              ocr: { recognize: () => Effect.fail(upstream) },
            }),
          ),
        ).toBe(upstream);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "uses a renderer for a page without a dominant image and preserves verbatim Markdown",
    () =>
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const png = Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/Wl1sAAAAASUVORK5CYII=",
          ),
          (character) => character.charCodeAt(0),
        );
        const cover = yield* fixture(["cover"]);
        const rendered = yield* core.text(cover, {
          format: "markdown",
          ocr: {
            policy: "always",
            render: (page) => {
              expect(page.view).toEqual([0, 0, width, height]);
              return Effect.succeed({
                mediaType: "image/png",
                bytes: png,
                width: 1,
                height: 1,
                dpiX: 0.24,
                dpiY: 0.24,
                placement: [width, 0, 0, height, 0, 0],
              });
            },
            recognize: () => Effect.succeed({ kind: "text", text: "Title", markdown: "# Title\n" }),
          },
        });
        expect(rendered).toEqual(["# Title\n"]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("reads only the requested scan through the lazy document", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const pdf = yield* fixture(["cover", "scan"], 512 * 1024);
        const doc = yield* core.openLazy(pdfCoreBytesSource(pdf), {
          gapBytes: 0,
          probeBytes: 1024,
        });
        const options = {
          pageIndexes: [1],
          ocr: {
            recognize: (request: PdfCoreOcrRequest) => Effect.succeed(recognizeTable(request)),
          },
        };
        const pages = yield* doc.textPages(options);
        expect(yield* doc.text(options)).toEqual(pages.map(({ text }) => text));
        expect(yield* doc.tables(options)).toMatchObject([{ pageIndex: 1, source: "ocr" }]);
        expect(pages).toMatchObject([{ pageIndex: 1, source: "ocr", textLayer: "none" }]);
        expect(pages[0]?.text).toContain("INK");
        const stats = yield* doc.stats;
        expect(stats.strategy).toBe("lazy");
        expect(stats.bytesRead).toBeLessThan(pdf.byteLength / 8);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("interrupts active recognition and leaves queued pages untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const pdf = yield* fixture(["scan", "scan", "scan"]);
        const admitted = yield* Deferred.make<void>();
        const started = yield* Ref.make(0);
        const finalized = yield* Ref.make(0);
        const read = core.text(pdf, {
          ocr: {
            concurrency: 2,
            recognize: () =>
              Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(started, (current) => current + 1);
                if (count === 2) yield* Deferred.succeed(admitted, undefined);
                return yield* Effect.never;
              }).pipe(Effect.ensuring(Ref.update(finalized, (current) => current + 1))),
          },
        });
        const fiber = yield* Effect.forkScoped(read);
        yield* Effect.raceFirst(Deferred.await(admitted), Fiber.join(fiber));
        yield* Fiber.interrupt(fiber);
        expect(yield* Ref.get(started)).toBe(2);
        expect(yield* Ref.get(finalized)).toBe(2);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it("adapts Promise callbacks on full and lazy documents", async () => {
    const core = await loadPdfCoreNode();
    const pdf = await Effect.runPromise(fixture(["scan"]).pipe(Effect.provide(layer)));
    await expect(
      core.text(pdf, {
        ocr: { recognize: () => Promise.reject("offline") },
      }),
    ).rejects.toMatchObject({
      code: PdfCoreErrorCodeValue.ocrFailed,
      pageIndex: 0,
    });
    await using doc = await core.openLazy({
      size: pdf.byteLength,
      read: (offset, length) => pdf.subarray(offset, offset + length),
    });
    await expect(
      doc.text({
        ocr: {
          recognize: async (_request, signal) => ({
            kind: "text",
            text: signal.aborted ? "interrupted" : "Promise OCR",
          }),
        },
      }),
    ).resolves.toEqual(["Promise OCR"]);
  });
});
