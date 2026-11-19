import { Effect, Layer } from "effect";

import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "./config.js";
import { PdfCoreOcr, makePdfCoreOcr } from "./ocr.js";
import { PdfCore, makePdfCore } from "./pdf-core.js";

const WASM_CONTENT_TYPE = "application/wasm";

const compileBrowserModule = (url: URL): Effect.Effect<WebAssembly.Module, PdfCoreError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (active) => Effect.sync(() => active.abort()),
      );
      const response = yield* Effect.tryPromise({
        try: () => fetch(url, { signal: controller.signal }),
        catch: () =>
          new PdfCoreError({
            code: PdfCoreErrorCodeValue.wasmLoadFailed,
            operation: PdfCoreOperationValue.load,
            reason: "The PDF core WebAssembly module could not be fetched.",
          }),
      });
      if (!response.ok) {
        return yield* new PdfCoreError({
          code: PdfCoreErrorCodeValue.wasmLoadFailed,
          operation: PdfCoreOperationValue.load,
          status: response.status,
          reason: "The PDF core WebAssembly module request failed.",
        });
      }
      return yield* Effect.tryPromise({
        try: async () =>
          response.headers.get("content-type") === WASM_CONTENT_TYPE
            ? WebAssembly.compileStreaming(response)
            : WebAssembly.compile(await response.arrayBuffer()),
        catch: () =>
          new PdfCoreError({
            code: PdfCoreErrorCodeValue.wasmLoadFailed,
            operation: PdfCoreOperationValue.load,
            reason: "The PDF core WebAssembly module could not be compiled.",
          }),
      });
    }),
  );

export const pdfCoreBrowserModule = compileBrowserModule(
  new URL("./pdf-core.wasm", import.meta.url),
);

export const pdfCoreOcrBrowserLayer: Layer.Layer<PdfCoreOcr, PdfCoreError> = Layer.effect(
  PdfCoreOcr,
  Effect.flatMap(
    compileBrowserModule(new URL("./pdf-core-ocr.wasm", import.meta.url)),
    makePdfCoreOcr,
  ),
);

export const pdfCoreBrowserLayer: Layer.Layer<PdfCore, PdfCoreError> = Layer.effect(
  PdfCore,
  Effect.flatMap(pdfCoreBrowserModule, makePdfCore),
);
