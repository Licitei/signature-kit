import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { pdfCoreBrowserLayer } from "@signature-kit/engine/wasm/browser";
import { paintDisplayList, prepareDisplayListImages } from "@signature-kit/engine/wasm/canvas";
import { Effect, Layer, Option, References, Semaphore } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";
import {
  A1Sessions,
  Documents,
  LocalRuntime,
  PdfEngine,
  localRuntimeLayer,
  pdfEngineLayer,
} from "@signature-kit/engine/engine";
import { LocalTelemetry, LocalError, LocalRpcs, PROTOCOL_VERSION } from "@signature-kit/engine/rpc";
import { localTelemetryLayer, withQueueTiming } from "@signature-kit/engine/telemetry";
import { PdfSignatures, pdfSignaturesLayer } from "@signature-kit/engine/pdf-signatures";

const localHandlersLayer = LocalRpcs.toLayer(
  Effect.gen(function* () {
    const { instanceId } = yield* LocalRuntime;
    const documents = yield* Documents;
    const a1 = yield* A1Sessions;
    const pdf = yield* PdfEngine;
    const signatures = yield* PdfSignatures;
    const telemetry = Option.getOrUndefined(yield* Effect.serviceOption(LocalTelemetry));
    const raster = withQueueTiming(
      yield* Semaphore.make(1),
      telemetry !== undefined,
      "local.queue.raster",
    );
    return LocalRpcs.of({
      Hello: Effect.fn("local.hello")(function* ({ version }) {
        if (version !== PROTOCOL_VERSION)
          return yield* new LocalError({ code: "protocolMismatch" });
        return { instanceId, version: PROTOCOL_VERSION, telemetry: telemetry !== undefined };
      }),
      DocumentsOpen: ({ bytes }) => documents.open(bytes),
      DocumentsExport: ({ handle }) => documents.export(handle),
      DocumentsRelease: ({ handle }) => documents.release(handle),
      PdfInspect: ({ handle }) => pdf.inspect(handle),
      PdfRenderPage: (input) =>
        raster(
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
      PdfSignatureFields: ({ revision }) => signatures.fields(revision),
      PdfPrepare: ({ revision, options }) => signatures.prepare(revision, options),
      PdfConfirm: ({ preparationId }) => signatures.confirm(preparationId),
      PdfRelease: ({ preparationId }) => signatures.release(preparationId),
      PdfVerify: ({ revision, options }) => signatures.verify(revision, options),
      TelemetryDrain: () =>
        telemetry?.drain ??
        Effect.succeed({ spans: [], bytes: 0, droppedSpans: 0, droppedAttributes: 0 }),
    });
  }),
);

export const localWorker = (telemetry: boolean) =>
  Layer.launch(
    RpcServer.layer(LocalRpcs, {
      spanPrefix: "local.worker",
      disableTracing: !telemetry,
    }).pipe(
      Layer.provide(
        localHandlersLayer.pipe(
          Layer.provide(pdfSignaturesLayer),
          Layer.provide(pdfEngineLayer),
          Layer.provide(localRuntimeLayer()),
          Layer.provide(pdfCoreBrowserLayer),
        ),
      ),
      Layer.provide(
        RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
      ),
      Layer.provide(
        telemetry ? localTelemetryLayer() : Layer.succeed(References.TracerEnabled, false),
      ),
    ),
  );
