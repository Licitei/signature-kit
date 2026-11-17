import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { PdfRenderRequests, pdfPageRendererHandlersLayer } from "@signature-kit/pdf/render-browser";
import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { Layer } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";

BrowserRuntime.runMain(
  Layer.launch(
    RpcServer.layer(PdfRenderRequests).pipe(
      Layer.provide(pdfPageRendererHandlersLayer.pipe(Layer.provide(pdfCoreBrowserLayer))),
      Layer.provide(
        RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
      ),
    ),
  ),
);
