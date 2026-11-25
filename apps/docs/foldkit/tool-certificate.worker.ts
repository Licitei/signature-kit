import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { Layer } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";
import { CertificateWorkerRequests } from "./tool-rpc.js";
import { certificateWorkerHandlersLayer } from "./tool-certificate.js";

BrowserRuntime.runMain(
  Layer.launch(
    RpcServer.layer(CertificateWorkerRequests).pipe(
      Layer.provide(certificateWorkerHandlersLayer),
      Layer.provide(
        RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
      ),
    ),
  ),
);
