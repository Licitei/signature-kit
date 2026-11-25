import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { pdfCoreFileLayer } from "@signature-kit/engine/wasm/file";
import { PdfCore, pdfCoreBytesSource } from "@signature-kit/engine/wasm/pdf-core";
import { Cause, Context, Effect, Exit, Layer } from "effect";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { recordSpans } from "../../../tooling/testing/tracing.ts";
import { Documents, PdfEngine, localRuntimeLayer, pdfEngineLayer } from "../src/engine.js";
import { createPages } from "../../../tooling/testing/fixtures/local/pdf.js";

const layer = pdfEngineLayer.pipe(
  Layer.provide(localRuntimeLayer()),
  Layer.provideMerge(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))),
);

it.effect("inspects and renders a cropped, rotated document through one cached WASM handle", () =>
  Effect.gen(function* () {
    const documents = yield* Documents;
    const pdf = yield* PdfEngine;
    const { handle } = yield* documents.open(createPages(2));

    const { spans, exit } = yield* recordSpans(
      Effect.gen(function* () {
        const inspection = yield* pdf.inspect(handle);
        expect(inspection).toEqual({
          pageCount: 2,
          pages: Array.from({ length: 2 }, () => ({
            mediaBox: [0, 0, 220, 160],
            cropBox: [20, 10, 200, 130],
            rotate: 90,
          })),
        });
        const first = yield* pdf.renderPage({ handle, pageIndex: 0, scale: 1 });
        expect(first.viewport).toEqual({
          width: 120,
          height: 180,
          transform: [0, 1, 1, 0, -10, -20],
        });
        const second = yield* pdf.renderPage({ handle, pageIndex: 1, scale: 2, rotation: 90 });
        expect(second.viewport).toEqual({
          width: 360,
          height: 240,
          transform: [-2, 0, 0, 2, 400, -20],
        });
        expect(second.list.pageIndex).toBe(1);
        expect(
          yield* Effect.flip(pdf.renderPage({ handle, pageIndex: 2, scale: 1 })),
        ).toMatchObject({
          code: "invalidPageIndex",
        });
      }),
    );
    yield* exit;
    expect(spans.filter(({ name }) => name === "pdfCore.openLazy")).toHaveLength(1);

    yield* documents.release(handle);
    yield* documents.release(handle);
    expect(yield* Effect.flip(pdf.inspect(handle))).toMatchObject({ code: "unknownHandle" });
    expect(yield* Effect.flip(pdf.renderPage({ handle, pageIndex: 0, scale: 1 }))).toMatchObject({
      code: "unknownHandle",
    });
    const reopened = yield* documents.open(createPages(2));
    const next = yield* recordSpans(
      pdf.renderPage({ handle: reopened.handle, pageIndex: 0, scale: 1 }),
    );
    yield* next.exit;
    expect(next.spans.filter(({ name }) => name === "pdfCore.openLazy")).toHaveLength(1);

    const malformed = yield* documents.open(new Uint8Array([37, 80, 68, 70]));
    expect(yield* Effect.flip(pdf.inspect(malformed.handle))).toMatchObject({
      code: "pdfInspectFailed",
      pdfCode: "pdfCore.INVALID_PDF",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("closes the parsed cache and the document store with the layer scope", () =>
  Effect.gen(function* () {
    const { documents, pdf, handle } = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        const documents = Context.get(context, Documents);
        const pdf = Context.get(context, PdfEngine);
        const { handle } = yield* documents.open(createPages(1));
        yield* pdf.renderPage({ handle, pageIndex: 0, scale: 1 });
        return { documents, pdf, handle };
      }),
    );
    expect(yield* Effect.flip(documents.export(handle))).toMatchObject({ code: "runtimeClosed" });
    const inspect = yield* Effect.exit(pdf.inspect(handle));
    expect(Exit.isFailure(inspect) && Cause.hasInterruptsOnly(inspect.cause)).toBe(true);
  }),
);

it.effect("measures reopening versus keeping the parsed document between renders", () =>
  Effect.gen(function* () {
    const documents = yield* Documents;
    const pdf = yield* PdfEngine;
    const core = yield* PdfCore;
    const habilitacao = yield* Effect.promise(
      async () =>
        new Uint8Array(
          await readFile(
            new URL("../../../crates/pdf/tests/fixtures/pdf/habilitacao-150.pdf", import.meta.url),
          ),
        ),
    );
    const sources = [
      { name: "generated-200", bytes: createPages(200) },
      { name: "habilitacao-150", bytes: habilitacao },
    ];
    const pages = Array.from({ length: 40 }, (_, index) => index + 1);
    const time = (operation: (pageIndex: number) => Effect.Effect<unknown, unknown>) =>
      Effect.gen(function* () {
        const start = performance.now();
        yield* Effect.forEach(pages, operation, { discard: true });
        return (performance.now() - start) / pages.length;
      });
    for (const { name, bytes } of sources) {
      const { handle } = yield* documents.open(bytes);
      const warmup = yield* pdf.renderPage({ handle, pageIndex: 0, scale: 1 });
      expect(warmup.list.ops.byteLength).toBeGreaterThan(0);

      const cachedMs = yield* time((pageIndex) => pdf.renderPage({ handle, pageIndex, scale: 1 }));
      const reopenedLazyMs = yield* time((pageIndex) =>
        core.openLazy(pdfCoreBytesSource(bytes)).pipe(
          Effect.flatMap((document) =>
            document.renderPages({ pageIndexes: [pageIndex], scale: 1 }),
          ),
          Effect.scoped,
        ),
      );
      const eagerMs = yield* time((pageIndex) =>
        core.renderPages(bytes, { pageIndexes: [pageIndex], scale: 1 }),
      );
      yield* documents.release(handle);
      console.info({ name, measuredPages: pages.length, cachedMs, reopenedLazyMs, eagerMs });
    }
  }).pipe(Effect.provide(layer)),
);
