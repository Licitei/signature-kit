import { BrowserKeyValueStore, IndexedDb } from "@effect/platform-browser";
import { batchDatabase, indexedDbBatchStorageLayer } from "./batch-storage.js";
import { Batches, batchesLayer } from "@signature-kit/engine/batches";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { compose } from "@signature-kit/engine/compose";
import { composeBrowserLayer } from "@signature-kit/engine/wasm/compose";
import { pdfCoreModuleBrowserLayer } from "@signature-kit/engine/wasm/browser";
import { PdfCoreModule, pdfCoreModuleLayer } from "@signature-kit/engine/wasm/pdf-core";
import { paintDisplayList, prepareDisplayListImages } from "@signature-kit/engine/wasm/canvas";
import { Effect, Layer, Option, References, Schema, Semaphore } from "effect";
import * as RpcServer from "effect/rpc/RpcServer";
import {
  A1Sessions,
  Documents,
  LocalRuntime,
  PdfEngine,
  localRuntimeLayer,
  pdfEngineLayer,
} from "@signature-kit/engine/engine";
import {
  BatchConfigSchema,
  LocalTelemetry,
  LocalError,
  LocalRpcs,
  PROTOCOL_VERSION,
} from "@signature-kit/engine/rpc";
import {
  localTelemetryLayer,
  TelemetryOptionsSchema,
  withQueueTiming,
} from "@signature-kit/engine/telemetry";
import { PdfSignatures, pdfSignaturesLayer } from "@signature-kit/engine/pdf-signatures";
import { SignaturePool } from "@signature-kit/engine/signature-compute";
import {
  SigningHelperRpcs,
  signingHelperHandlersLayer,
} from "@signature-kit/engine/signing-helper";
import { SigningPoolSizeSchema, signingPoolLayer } from "./signing-pool.js";

const localHandlersLayer = LocalRpcs.toLayer(
  Effect.gen(function* () {
    const { instanceId } = yield* LocalRuntime;
    const documents = yield* Documents;
    const a1 = yield* A1Sessions;
    const pdf = yield* PdfEngine;
    const signatures = yield* PdfSignatures;
    const batches = yield* Batches;
    const pool = Option.getOrUndefined(yield* Effect.serviceOption(SignaturePool));
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
      Prewarm: () => signatures.prewarm.pipe(Effect.andThen(pool?.prewarm ?? Effect.void)),
      DocumentsOpen: ({ bytes }) => documents.open(bytes),
      DocumentsExport: ({ handle }) => documents.export(handle),
      DocumentsDigest: ({ revision }) => documents.digest(revision),
      DocumentsRelease: ({ handle }) => documents.release(handle),
      PdfCompose: ({ document, options }) =>
        compose(document, options).pipe(
          Effect.mapError(
            ({ code }) => new LocalError({ code: "pdfComposeFailed", pdfCode: code }),
          ),
          Effect.flatMap(documents.open),
        ),
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
      PdfAddSignatureFields: ({ revision, fields }) => signatures.addFields(revision, fields),
      PdfAddValidationData: ({ revision, evidence }) =>
        signatures.addValidationData(revision, evidence),
      PdfPrepareDocumentTimestamp: ({ revision }) => signatures.prepareDocumentTimestamp(revision),
      PdfAddDocumentTimestamp: ({ revision, token }) =>
        signatures.addDocumentTimestamp(revision, token),
      PdfCompare: ({ sent, returned, options }) => signatures.compare(sent, returned, options),
      PdfPrepare: ({ revision, options }) => signatures.prepare(revision, options),
      PdfConfirm: ({ preparationId }) => signatures.confirm(preparationId),
      PdfRelease: ({ preparationId }) => signatures.release(preparationId),
      PdfVerify: ({ revision, options }) => signatures.verify(revision, options),
      BatchPrepare: batches.prepare,
      BatchConfirm: ({ batchId, selection }) => batches.confirm(batchId, selection),
      BatchCancel: ({ batchId }) => batches.cancel(batchId),
      BatchRetry: ({ batchId, itemIds }) => batches.retry(batchId, itemIds),
      BatchSnapshot: ({ batchId }) => batches.snapshot(batchId),
      BatchEvents: ({ batchId }) => batches.events(batchId),
      BatchRelease: ({ batchId }) => batches.release(batchId),
      BatchDelete: ({ batchId }) => batches.delete(batchId),
      TelemetryDrain: () =>
        telemetry?.drain ??
        Effect.succeed({ spans: [], bytes: 0, droppedSpans: 0, droppedAttributes: 0 }),
    });
  }),
);

const indexedDbWorkerLayer = Layer.effect(
  IndexedDb.IndexedDb,
  Effect.sync(() => IndexedDb.make({ indexedDB, IDBKeyRange })),
);

const resumeLayer = indexedDbBatchStorageLayer.pipe(
  Layer.provide(BrowserKeyValueStore.layerIndexedDb({ database: batchDatabase })),
  Layer.provide(indexedDbWorkerLayer),
);

export const LocalWorkerOptionsSchema = Schema.Struct({
  batchConfig: Schema.optional(BatchConfigSchema),
  resumeBatches: Schema.optional(Schema.Boolean),
  signingWorkers: Schema.optional(SigningPoolSizeSchema),
  telemetry: Schema.optional(TelemetryOptionsSchema),
});
export type LocalWorkerOptions = (typeof LocalWorkerOptionsSchema)["Type"];

const defaultBatchConfig = (concurrency: number) => ({
  concurrency,
  queueCapacity: Math.max(4, concurrency * 2),
  byteBudget: 64 * 1024 * 1024,
  eventCapacity: 128,
});

export const localWorker = (
  telemetry: boolean,
  options: LocalWorkerOptions = {},
  createSigningHelper?: () => Worker,
) => {
  const helpers = createSigningHelper === undefined ? 0 : (options.signingWorkers ?? 0);
  const pool =
    createSigningHelper === undefined || helpers === 0
      ? undefined
      : signingPoolLayer(helpers, createSigningHelper);
  return Layer.launch(
    RpcServer.layer(LocalRpcs, {
      spanPrefix: "local.worker",
      disableTracing: !telemetry,
    }).pipe(
      Layer.provide(
        localHandlersLayer.pipe(
          Layer.provide(
            batchesLayer(
              options.batchConfig ??
                defaultBatchConfig(pool === undefined ? 2 : Math.min(64, helpers * 2)),
            ),
          ),
          Layer.provide(options.resumeBatches === true ? resumeLayer : Layer.empty),
          Layer.provide(pool ?? Layer.empty),
          Layer.provide(pdfSignaturesLayer),
          Layer.provide(pdfEngineLayer),
          Layer.provide(localRuntimeLayer()),
          Layer.provide(pdfCoreModuleLayer),
          Layer.provide(composeBrowserLayer),
          Layer.provide(pdfCoreModuleBrowserLayer),
        ),
      ),
      Layer.provide(
        RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
      ),
      Layer.provide(
        telemetry
          ? localTelemetryLayer(options.telemetry)
          : Layer.succeed(References.TracerEnabled, false),
      ),
    ),
  );
};

const WasmModuleSchema = Schema.instanceOf(WebAssembly.Module);

export const signingHelperWorker = (bootstrap: unknown) =>
  Schema.decodeUnknownEffect(WasmModuleSchema)(bootstrap).pipe(
    Effect.orDie,
    Effect.flatMap((module) =>
      Layer.launch(
        RpcServer.layer(SigningHelperRpcs, { disableTracing: true }).pipe(
          Layer.provide(
            signingHelperHandlersLayer.pipe(
              Layer.provide(pdfSignaturesLayer),
              Layer.provide(pdfEngineLayer),
              Layer.provide(localRuntimeLayer()),
              Layer.provide(pdfCoreModuleLayer),
              Layer.provide(Layer.succeed(PdfCoreModule, module)),
            ),
          ),
          Layer.provide(
            RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(BrowserWorkerRunner.layer)),
          ),
          Layer.provide(Layer.succeed(References.TracerEnabled, false)),
        ),
      ),
    ),
  );
