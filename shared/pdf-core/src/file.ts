import { Effect, FileSystem, Layer, Path } from "effect";

import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "./config.js";
import { PdfCoreOcr, makePdfCoreOcr } from "./ocr.js";
import { PdfCore, makePdfCore } from "./pdf-core.js";
import type { PdfCoreRangeSource } from "./pdf-core.js";

const compileFileModule = (url: URL) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const location = yield* path.fromFileUrl(url).pipe(
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
    return yield* Effect.tryPromise({
      try: () => WebAssembly.compile(bytes),
      catch: () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.wasmLoadFailed,
          operation: PdfCoreOperationValue.load,
          reason: "The PDF core WebAssembly module could not be compiled.",
        }),
    });
  });

export const pdfCoreFileLayer: Layer.Layer<
  PdfCore,
  PdfCoreError,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(
  PdfCore,
  Effect.flatMap(compileFileModule(new URL("./pdf-core.wasm", import.meta.url)), makePdfCore),
);

export const pdfCoreOcrFileLayer: Layer.Layer<
  PdfCoreOcr,
  PdfCoreError,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(
  PdfCoreOcr,
  Effect.flatMap(
    compileFileModule(new URL("./pdf-core-ocr.wasm", import.meta.url)),
    makePdfCoreOcr,
  ),
);

export const pdfCoreFileSource = Effect.fn(function* (location: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const file = yield* fileSystem.open(location, { flag: "r" }).pipe(
    Effect.mapError(
      () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.rangeReadFailed,
          operation: PdfCoreOperationValue.openLazy,
          reason: "The PDF file could not be opened.",
        }),
    ),
  );
  const info = yield* file.stat.pipe(
    Effect.mapError(
      () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.rangeReadFailed,
          operation: PdfCoreOperationValue.openLazy,
          reason: "The PDF file size could not be read.",
        }),
    ),
  );
  return {
    size: Number(info.size),
    read: Effect.fn(function* (offset: number, length: number) {
      const bytes = new Uint8Array(length);
      let total = 0;
      while (total < length) {
        const count = yield* file
          .read(bytes.subarray(total), { position: BigInt(offset + total) })
          .pipe(
            Effect.mapError(
              () =>
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.rangeReadFailed,
                  operation: PdfCoreOperationValue.readRange,
                  reason: `The PDF file could not read ${length} bytes at offset ${offset}.`,
                }),
            ),
          );
        if (count === 0) {
          break;
        }
        total += count;
      }
      return bytes.subarray(0, total);
    }),
  } satisfies PdfCoreRangeSource;
});
