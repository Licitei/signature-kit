import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { Layer } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";
import { VerifyWorkerRequests } from "./tool-rpc.js";
import { verifyWorkerHandlersLayer } from "./tool-verify.js";

BrowserRuntime.runMain(
  Layer.launch(
    RpcServer.layer(VerifyWorkerRequests).pipe(
      Layer.provide(verifyWorkerHandlersLayer.pipe(Layer.provide(pdfCoreBrowserLayer))),
      Layer.provide(
        RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
      ),
    ),
  ),
);
