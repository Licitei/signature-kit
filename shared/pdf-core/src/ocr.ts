import { Context, Effect, Layer, Schema } from "effect";

import {
  PdfCoreError,
  PdfCoreErrorCodeValue,
  PdfCoreOperationValue,
  PdfCoreOcrEngineResultSchema,
  PdfCoreOcrEngineImageSchema,
  PdfCoreOcrExportsSchema,
  PdfCoreSchemaNameValue,
} from "./config.js";
import type { PdfCoreOcrEngineResult, PdfCoreOcrEngineImage } from "./config.js";

const MAGIC = 0x52434f50;
const VERSION = 1;
const HEADER_BYTES = 24;
const MIN_WORD_BYTES = 28;

export class PdfCoreOcr extends Context.Service<
  PdfCoreOcr,
  {
    readonly recognize: (
      image: PdfCoreOcrEngineImage,
    ) => Effect.Effect<PdfCoreOcrEngineResult, PdfCoreError>;
  }
>()("@signature-kit/pdf-core/PdfCoreOcr") {}

const readPayload = (view: DataView) => {
  let offset = 4;
  const uint32 = () => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const string = () => {
    const size = uint32();
    if (size > view.byteLength - offset) {
      return null;
    }
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, size);
    offset += size;
    return decoder.decode(bytes);
  };
  const magic = uint32();
  const version = uint32();
  if (magic !== MAGIC || version !== VERSION) {
    return null;
  }
  const width = uint32();
  const height = uint32();
  const count = uint32();
  if (count > (view.byteLength - HEADER_BYTES) / MIN_WORD_BYTES) {
    return null;
  }
  const words = [];
  for (let index = 0; index < count; index += 1) {
    const box: [number, number, number, number] = [uint32(), uint32(), uint32(), uint32()];
    const confidence = view.getFloat32(offset, true);
    offset += 4;
    const line = uint32();
    const text = string();
    const [left, top, right, bottom] = box;
    if (text === null || left >= right || top >= bottom || right > width || bottom > height) {
      return null;
    }
    words.push({ box, confidence, line, text });
  }
  const text = string();
  return text !== null && offset === view.byteLength
    ? { kind: "words", width, height, words, text }
    : null;
};

export const makePdfCoreOcr = Effect.fn(function* (module: WebAssembly.Module) {
  const instance = yield* Effect.tryPromise({
    try: () => WebAssembly.instantiate(module, {}),
    catch: () =>
      new PdfCoreError({
        code: PdfCoreErrorCodeValue.wasmLoadFailed,
        operation: PdfCoreOperationValue.load,
        reason: "The PDF OCR WebAssembly module failed to instantiate.",
      }),
  });
  const core = yield* Schema.decodeUnknownEffect(PdfCoreOcrExportsSchema)(instance.exports).pipe(
    Effect.mapError(
      (issue) =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.wasmLoadFailed,
          operation: PdfCoreOperationValue.load,
          schemaName: PdfCoreSchemaNameValue.ocrExports,
          reason: "The PDF OCR WebAssembly module does not expose the expected exports.",
          issueMessage: String(issue),
        }),
    ),
  );
  if (core.pdf_core_ocr_version() !== VERSION) {
    return yield* new PdfCoreError({
      code: PdfCoreErrorCodeValue.wasmLoadFailed,
      operation: PdfCoreOperationValue.load,
      reason: "The PDF OCR WebAssembly module has an incompatible ABI version.",
    });
  }
  const recognize = Effect.fn(function* (request: PdfCoreOcrEngineImage) {
    const image = yield* Schema.decodeUnknownEffect(PdfCoreOcrEngineImageSchema)(request).pipe(
      Effect.mapError(
        (issue) =>
          new PdfCoreError({
            code: PdfCoreErrorCodeValue.invalidOcrImage,
            operation: PdfCoreOperationValue.recognize,
            schemaName: PdfCoreSchemaNameValue.ocrImage,
            issueMessage: String(issue),
          }),
      ),
    );
    const length = image.bytes.byteLength;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const input = yield* Effect.acquireRelease(
          Effect.suspend(() => {
            const pointer = core.pdf_core_ocr_alloc(length) >>> 0;
            if (pointer === 0) {
              return Effect.fail(
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.limitExceeded,
                  operation: PdfCoreOperationValue.recognize,
                  reason: "The PDF OCR module could not allocate the image buffer.",
                }),
              );
            }
            return Effect.succeed(pointer);
          }),
          (pointer) => Effect.sync(() => core.pdf_core_ocr_free(pointer, length)),
        );
        const output = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              new Uint8Array(core.memory.buffer, input, length).set(image.bytes);
              const dpi = Math.round(((image.dpiX + image.dpiY) / 2) * 1000);
              const pointer =
                core.pdf_core_ocr_recognize(
                  input,
                  length,
                  image.mediaType === "image/jpeg" ? 1 : 0,
                  image.width,
                  image.height,
                  dpi,
                  0,
                ) >>> 0;
              if (pointer === 0) {
                return null;
              }
              const view = new DataView(core.memory.buffer, pointer);
              return { pointer, length: view.getUint32(0, true) };
            },
            catch: () =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.ocrFailed,
                operation: PdfCoreOperationValue.recognize,
                reason: "The PDF OCR WebAssembly operation failed.",
              }),
          }).pipe(
            Effect.filterOrFail(
              (allocation) => allocation !== null,
              () =>
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.invalidOcrImage,
                  operation: PdfCoreOperationValue.recognize,
                  reason: "The PDF OCR module could not decode the supplied image.",
                }),
            ),
          ),
          (allocation) =>
            Effect.sync(() => core.pdf_core_ocr_free(allocation.pointer, allocation.length)),
        );
        const payload = yield* Effect.try({
          try: () => readPayload(new DataView(core.memory.buffer, output.pointer, output.length)),
          catch: () =>
            new PdfCoreError({
              code: PdfCoreErrorCodeValue.ocrFailed,
              operation: PdfCoreOperationValue.recognize,
              reason: "The PDF OCR module returned an invalid binary payload.",
            }),
        });
        return yield* Schema.decodeUnknownEffect(PdfCoreOcrEngineResultSchema)(payload).pipe(
          Effect.mapError(
            (issue) =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.ocrFailed,
                operation: PdfCoreOperationValue.recognize,
                schemaName: PdfCoreSchemaNameValue.ocrResult,
                issueMessage: String(issue),
              }),
          ),
        );
      }),
    );
  });
  return PdfCoreOcr.of({ recognize });
});

export const pdfCoreOcrLayer = (
  module: WebAssembly.Module,
): Layer.Layer<PdfCoreOcr, PdfCoreError> => Layer.effect(PdfCoreOcr, makePdfCoreOcr(module));
