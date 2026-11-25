import * as BrowserRuntime from "@effect/platform-browser/BrowserRuntime";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { paintDisplayList, prepareDisplayListImages } from "@signature-kit/pdf-core/canvas";
import { Effect, Layer, Semaphore } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";
import {
  A1Sessions,
  Documents,
  LocalRuntime,
  PdfEngine,
  localRuntimeLayer,
  pdfEngineLayer,
} from "./engine.js";
import { LocalError, LocalRpcs, PROTOCOL_VERSION } from "./protocol.js";

const localHandlersLayer = LocalRpcs.toLayer(
  Effect.gen(function* () {
    const { instanceId } = yield* LocalRuntime;
    const documents = yield* Documents;
    const a1 = yield* A1Sessions;
    const pdf = yield* PdfEngine;
    const raster = yield* Semaphore.make(1);
    return LocalRpcs.of({
      Hello: Effect.fn("local.hello")(function* ({ version }) {
        if (version !== PROTOCOL_VERSION)
          return yield* new LocalError({ code: "protocolMismatch" });
        return { instanceId, version: PROTOCOL_VERSION };
      }),
      DocumentsOpen: ({ bytes }) => documents.open(bytes),
      DocumentsExport: ({ handle }) => documents.export(handle),
      DocumentsRelease: ({ handle }) => documents.release(handle),
      PdfInspect: ({ handle }) => pdf.inspect(handle),
      PdfRenderPage: (input) =>
        raster.withPermits(1)(
          Effect.gen(function* () {
            const { list, viewport } = yield* pdf.renderPage(input);
            const { width, height } = viewport;
            if (width > 8192 || height > 8192 || width * height > 4096 * 4096) {
              return yield* new LocalError({ code: "renderTooLarge" });
            }
            const canvas = yield* Effect.try({
              try: () => new OffscreenCanvas(width, height),
              catch: () => new LocalError({ code: "canvasUnavailable" }),
            });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                canvas.width = 0;
                canvas.height = 0;
              }),
            );
            const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
            if (context === null) return yield* new LocalError({ code: "canvasUnavailable" });
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, width, height);
            yield* prepareDisplayListImages(list).pipe(
              Effect.flatMap((images) => paintDisplayList(context, list, images)),
              Effect.mapError(
                ({ code }) => new LocalError({ code: "pdfRenderFailed", pdfCode: code }),
              ),
            );
            return yield* Effect.try({
              try: () => {
                const { data } = context.getImageData(0, 0, width, height);
                const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                return { ...viewport, pixels };
              },
              catch: () => new LocalError({ code: "canvasUnavailable" }),
            });
          }).pipe(Effect.scoped),
        ),
      A1Open: a1.open,
      A1Close: a1.close,
    });
  }),
);

BrowserRuntime.runMain(
  Layer.launch(
    RpcServer.layer(LocalRpcs, { spanPrefix: "local.worker" }).pipe(
      Layer.provide(
        localHandlersLayer.pipe(
          Layer.provide(pdfEngineLayer),
          Layer.provide(localRuntimeLayer()),
          Layer.provide(pdfCoreBrowserLayer),
        ),
      ),
      Layer.provide(
        RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
      ),
    ),
  ),
);
