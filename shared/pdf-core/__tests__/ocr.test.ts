import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import { pdfCoreOcrFileLayer } from "../dist/file.js";
import { PdfCoreOcr } from "../dist/ocr.js";

const MAX_OCR_WASM_BYTES = 224 * 1024;
const layer = pdfCoreOcrFileLayer.pipe(Layer.provide(NodeServices.layer));

it.effect("keeps the optional OCR WebAssembly artifact within its size budget", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const location = yield* path.fromFileUrl(new URL("../dist/pdf-core-ocr.wasm", import.meta.url));
    const bytes = yield* fs.readFile(location);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_OCR_WASM_BYTES);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("decodes and segments JPEG and gray8 in the optional WebAssembly module", () =>
  Effect.gen(function* () {
    const ocr = yield* PdfCoreOcr;
    const width = 320;
    const height = 150;
    const bytes = new Uint8Array(width * height).fill(255);
    for (const top of [20, 50, 80]) {
      for (const left of [20, 30, 40, 70, 80]) {
        for (let row = top; row < top + 14; row += 1) {
          bytes.fill(0, row * width + left, row * width + left + 8);
        }
      }
    }
    const result = yield* ocr.recognize({
      mediaType: "image/x-gray",
      bytes,
      width,
      height,
      dpiX: 300,
      dpiY: 300,
    });
    expect(result).toMatchObject({ kind: "words", width, height });
    expect(result.words.map((word) => [word.line, word.box])).toEqual([
      [0, [20, 20, 48, 34]],
      [0, [70, 20, 88, 34]],
      [1, [20, 50, 48, 64]],
      [1, [70, 50, 88, 64]],
      [2, [20, 80, 48, 94]],
      [2, [70, 80, 88, 94]],
    ]);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const location = yield* path.fromFileUrl(
      new URL("../rust/ocr/tests/fixtures/progressive.jpg", import.meta.url),
    );
    const jpeg = yield* fs.readFile(location);
    const decoded = yield* ocr.recognize({
      mediaType: "image/jpeg",
      bytes: jpeg,
      width: 79,
      height: 53,
      dpiX: 300,
      dpiY: 300,
    });
    expect(decoded).toMatchObject({ width: 79, height: 53 });
  }).pipe(Effect.provide([layer, NodeServices.layer])),
);

it.effect("returns typed invalid-image failures and keeps the module reusable", () =>
  Effect.gen(function* () {
    const ocr = yield* PdfCoreOcr;
    const malformed = { bytes: Uint8Array.of(0xff), width: 2, height: 2, dpiX: 300, dpiY: 300 };
    const invalidGray = yield* ocr
      .recognize({ ...malformed, mediaType: "image/x-gray" })
      .pipe(Effect.result);
    const invalidJpeg = yield* ocr
      .recognize({ ...malformed, mediaType: "image/jpeg" })
      .pipe(Effect.result);
    expect(Result.isFailure(invalidGray) && invalidGray.failure.code).toBe(
      PdfCoreErrorCodeValue.invalidOcrImage,
    );
    expect(Result.isFailure(invalidJpeg) && invalidJpeg.failure.code).toBe(
      PdfCoreErrorCodeValue.invalidOcrImage,
    );
    const result = yield* ocr.recognize({
      ...malformed,
      mediaType: "image/x-gray",
      bytes: Uint8Array.of(255, 255, 255, 255),
    });
    expect(result.words).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
