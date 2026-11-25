import type { FileHandle } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { Effect } from "effect";

import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "./config.js";
import { createPdfCoreClient } from "./promise.js";
import type { PdfCoreClient, PdfCorePromiseRangeSource } from "./promise.js";

export const loadPdfCoreNode = (): Promise<PdfCoreClient> =>
  // effect-boundary: promise entry point for Node apps without Effect [allow-run: rejects with the PdfCoreError]
  Effect.runPromise(
    Effect.tryPromise({
      try: async () =>
        WebAssembly.compile(await readFile(new URL("./signature-kit.wasm", import.meta.url))),
      catch: () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.wasmLoadFailed,
          operation: PdfCoreOperationValue.load,
          reason: "The PDF core WebAssembly module could not be read or compiled.",
        }),
    }),
  ).then(createPdfCoreClient);

export const pdfCoreNodeSource = (file: FileHandle, size: number): PdfCorePromiseRangeSource => ({
  size,
  read: async (offset, length) => {
    const bytes = new Uint8Array(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await file.read(bytes, total, length - total, offset + total);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    return bytes.subarray(0, total);
  },
});
