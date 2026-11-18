import { Effect, Layer } from "effect";

import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "./config.js";
import { PdfCore, makePdfCore } from "./pdf-core.js";

const WASM_CONTENT_TYPE = "application/wasm";

export const pdfCoreBrowserModule: Effect.Effect<WebAssembly.Module, PdfCoreError> = Effect.gen(
  function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(new URL("./pdf-core.wasm", import.meta.url), { signal }),
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
  },
);

export const pdfCoreBrowserLayer: Layer.Layer<PdfCore, PdfCoreError> = Layer.effect(
  PdfCore,
  Effect.flatMap(pdfCoreBrowserModule, makePdfCore),
);
