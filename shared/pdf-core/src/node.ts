import { readFile } from "node:fs/promises";
import { Effect } from "effect";

import { PdfCoreError, PdfCoreErrorCodeValue, PdfCoreOperationValue } from "./config.js";
import { createPdfCoreClient } from "./promise.js";
import type { PdfCoreClient } from "./promise.js";

export const loadPdfCoreNode = (): Promise<PdfCoreClient> =>
  // effect-boundary: promise entry point for Node apps without Effect [allow-run: rejects with the PdfCoreError]
  Effect.runPromise(
    Effect.tryPromise({
      try: async () =>
        WebAssembly.compile(await readFile(new URL("./pdf-core.wasm", import.meta.url))),
      catch: () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.wasmLoadFailed,
          operation: PdfCoreOperationValue.load,
          reason: "The PDF core WebAssembly module could not be read or compiled.",
        }),
    }),
  ).then(createPdfCoreClient);
