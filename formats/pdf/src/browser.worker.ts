import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { Effect, Layer } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";
import { PdfWorkerRequests } from "./worker.js";
import { createPdfStampPreview } from "./stamp.js";
import { preparePdfSigningBatch } from "./workflow.js";

const pdfWorkerHandlersLayer = PdfWorkerRequests.toLayer(
  Effect.succeed(
    PdfWorkerRequests.of({
      Preview: (input) => createPdfStampPreview(input),
      Prepare: (input) => preparePdfSigningBatch(input),
    }),
  ),
);

BrowserRuntime.runMain(
  Layer.launch(
    RpcServer.layer(PdfWorkerRequests).pipe(
      Layer.provide(pdfWorkerHandlersLayer.pipe(Layer.provide(pdfCoreBrowserLayer))),
      Layer.provide(
        RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
      ),
    ),
  ),
);
