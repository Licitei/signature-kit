import { Effect, Layer, Option, Semaphore } from "effect";
import { compose } from "@signature-kit/engine/compose";
import { Documents, PdfEngine } from "@signature-kit/engine/engine";
import { PdfVerification, pdfVerificationLayer } from "@signature-kit/engine/pdf-verification";
import { LocalError, LocalTelemetry } from "@signature-kit/engine/rpc";
import { withQueueTiming } from "@signature-kit/engine/telemetry";
import { paintDisplayList, prepareDisplayListImages } from "@signature-kit/engine/wasm/canvas";
import { composeBrowserLayer } from "@signature-kit/engine/wasm/compose";
import { localHandlersLayer, localWorkerRuntime } from "./signing-worker-server.js";
import type { LocalWorkerOptions, ViewerHandlers } from "./signing-worker-server.js";

const viewerHandlers = Effect.gen(function* () {
  const documents = yield* Documents;
  const pdf = yield* PdfEngine;
  const verification = yield* PdfVerification;
  const telemetry = Option.isSome(yield* Effect.serviceOption(LocalTelemetry));
  const raster = withQueueTiming(yield* Semaphore.make(1), telemetry, "local.queue.raster");
  return {
    PdfCompose: ({ document, options }) =>
      compose(document, options).pipe(
        Effect.mapError(({ code }) => new LocalError({ code: "pdfComposeFailed", pdfCode: code })),
        Effect.flatMap(documents.open),
      ),
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
    PdfVerify: ({ revision, options }) => verification.verify(revision, options),
    PdfCompare: ({ sent, returned, options }) => verification.compare(sent, returned, options),
  } satisfies ViewerHandlers;
});

const fullHandlersLayer = localHandlersLayer(viewerHandlers).pipe(
  Layer.provide(pdfVerificationLayer),
  Layer.provide(composeBrowserLayer),
);

export const localWorker = (
  telemetry: boolean,
  options: LocalWorkerOptions = {},
  createSigningHelper?: () => Worker,
) => localWorkerRuntime(fullHandlersLayer, telemetry, options, createSigningHelper);
