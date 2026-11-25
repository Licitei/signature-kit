import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { Layer } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";
import { XmlWorkerRequests } from "./tool-rpc.js";
import { xmlWorkerHandlersLayer } from "./tool-xml.js";

BrowserRuntime.runMain(
  Layer.launch(
    RpcServer.layer(XmlWorkerRequests).pipe(
      Layer.provide(xmlWorkerHandlersLayer),
      Layer.provide(
        RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
      ),
    ),
  ),
);
