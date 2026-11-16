import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result } from "effect";

import { createPdfFixture } from "../../../tooling/testing/fixtures";
import { PdfCoreError, PdfCoreErrorCodeValue } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore, makePdfCore } from "../dist/pdf-core.js";

const MAX_WASM_BYTES = 1024 * 1024;
const wasmUrl = new URL("../dist/pdf-core.wasm", import.meta.url);

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("PdfCore", () => {
  it.effect("inspects page geometry, links and text of a PDF", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const inspection = yield* core.inspect(createPdfFixture(), { text: true, links: true });
      expect(inspection.pages).toHaveLength(1);
      for (const page of inspection.pages) {
        expect(page.mediaBox).toHaveLength(4);
        expect(page.cropBox).toHaveLength(4);
        expect(page.mediaBox.every(Number.isFinite)).toBe(true);
        expect(Number.isInteger(page.rotate)).toBe(true);
      }
      for (const link of inspection.links) {
        expect(link.rect).toHaveLength(4);
        expect(link.pageIndex).toBeLessThan(inspection.pages.length);
        expect(link.uri.length).toBeGreaterThan(0);
      }
      for (const page of inspection.text) {
        const items = page.rects.length / 5;
        expect(Number.isInteger(items)).toBe(true);
        expect(page.offsets).toHaveLength(items + 1);
        expect(page.offsets[0]).toBe(0);
        expect(page.offsets.at(-1)).toBe(encode(page.text).byteLength);
        for (let index = 1; index < page.offsets.length; index += 1) {
          expect(page.offsets[index]).toBeGreaterThanOrEqual(page.offsets[index - 1] ?? 0);
        }
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips links and text unless requested", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const inspection = yield* core.inspect(createPdfFixture(), { text: false, links: false });
      expect(inspection.pages).toHaveLength(1);
      expect(inspection.links).toHaveLength(0);
      expect(inspection.text).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("restricts text to the requested page indexes", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const inspection = yield* core.inspect(createPdfFixture(), {
        text: true,
        links: false,
        pageIndexes: [0],
      });
      expect(inspection.text.every((page) => page.pageIndex === 0)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns arrays that survive later calls", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const first = yield* core.inspect(createPdfFixture(), { text: true, links: true });
      const snapshot = first.text.map((page) => [...page.rects]);
      yield* Effect.forEach(
        Array.from({ length: 20 }, () => createPdfFixture()),
        (pdf) => core.inspect(pdf, { text: true, links: true }),
      );
      expect(first.text.map((page) => [...page.rects])).toEqual(snapshot);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects malformed input with a typed error", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const result = yield* Effect.result(
        core.inspect(encode("this is not a pdf"), { text: true, links: true }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(PdfCoreError);
        expect(result.failure.code).toBe(PdfCoreErrorCodeValue.invalidPdf);
        expect(result.failure.status).toBe(1);
        expect(result.failure.message.length).toBeGreaterThan(0);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects empty input with a typed error", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const error = yield* Effect.flip(
        core.inspect(new Uint8Array(0), { text: false, links: false }),
      );
      expect(error.code).toBe(PdfCoreErrorCodeValue.invalidPdf);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects invalid options before touching the module", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const error = yield* Effect.flip(
        core.inspect(createPdfFixture(), { text: true, links: true, pageIndexes: [-1] }),
      );
      expect(error.code).toBe(PdfCoreErrorCodeValue.invalidOptions);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("serves concurrent inspections", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const results = yield* Effect.all(
        Array.from({ length: 32 }, () =>
          core.inspect(createPdfFixture(), { text: true, links: true }),
        ),
        { concurrency: "unbounded" },
      );
      expect(results.every((inspection) => inspection.pages.length === 1)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "frees every wasm buffer on success and failure paths",
    () =>
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const bulk = new Uint8Array(48 * 1024 * 1024);
        bulk.set(encode("%PDF-1.4\n"));
        const outcomes = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          (index) =>
            core
              .inspect(index % 10 === 9 ? createPdfFixture() : bulk, { text: true, links: true })
              .pipe(Effect.result),
        );
        const exhausted = outcomes.filter(
          (outcome) =>
            Result.isFailure(outcome) &&
            outcome.failure.code === PdfCoreErrorCodeValue.limitExceeded,
        );
        expect(exhausted).toHaveLength(0);
        const after = yield* core.inspect(createPdfFixture(), { text: false, links: false });
        expect(after.pages).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    60_000,
  );

  it.effect("keeps the wasm module within the size budget", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bytes = yield* fileSystem.readFile(wasmUrl.pathname);
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(bytes.byteLength).toBeLessThanOrEqual(MAX_WASM_BYTES);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with a typed error when the module lacks the expected exports", () =>
    Effect.gen(function* () {
      const emptyModule = yield* Effect.promise(() =>
        WebAssembly.compile(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])),
      );
      const error = yield* Effect.flip(makePdfCore(emptyModule));
      expect(error.code).toBe(PdfCoreErrorCodeValue.wasmLoadFailed);
      expect(error.schemaName).toBe("PdfCoreExports");
    }),
  );
});
