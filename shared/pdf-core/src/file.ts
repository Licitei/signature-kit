import { Effect, FileSystem, Layer, Path } from "effect";

import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "./config.js";
import { PdfCore, makePdfCore } from "./pdf-core.js";

export const pdfCoreFileLayer: Layer.Layer<
  PdfCore,
  PdfCoreError,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(
  PdfCore,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const location = yield* path.fromFileUrl(new URL("./pdf-core.wasm", import.meta.url)).pipe(
      Effect.mapError(
        () =>
          new PdfCoreError({
            code: PdfCoreErrorCodeValue.wasmLoadFailed,
            operation: PdfCoreOperationValue.load,
            reason: "The PDF core WebAssembly location is not a file URL.",
          }),
      ),
    );
    const bytes = yield* fileSystem.readFile(location).pipe(
      Effect.mapError(
        () =>
          new PdfCoreError({
            code: PdfCoreErrorCodeValue.wasmLoadFailed,
            operation: PdfCoreOperationValue.load,
            reason: "The PDF core WebAssembly module could not be read.",
          }),
      ),
    );
    const module = yield* Effect.tryPromise({
      try: () => WebAssembly.compile(bytes),
      catch: () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.wasmLoadFailed,
          operation: PdfCoreOperationValue.load,
          reason: "The PDF core WebAssembly module could not be compiled.",
        }),
    });
    return yield* makePdfCore(module);
  }),
);
