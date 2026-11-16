import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { Layer } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";
import { SigningWorkerRequests } from "./signing-config.js";
import { signingWorkerHandlersLayer } from "./signing-runtime.js";

BrowserRuntime.runMain(
  Layer.launch(
    RpcServer.layer(SigningWorkerRequests).pipe(
      Layer.provide(signingWorkerHandlersLayer.pipe(Layer.provide(pdfCoreBrowserLayer))),
      Layer.provide(
        RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
      ),
    ),
  ),
);
