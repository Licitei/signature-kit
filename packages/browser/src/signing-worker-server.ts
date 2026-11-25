import { BrowserKeyValueStore, IndexedDb } from "@effect/platform-browser";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { Effect, Layer, Option, References, Schema } from "effect";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";
import { Batches, batchesLayer } from "@signature-kit/engine/batches";
import {
  A1Sessions,
  Documents,
  LocalRuntime,
  PdfEngine,
  localRuntimeLayer,
  pdfEngineLayer,
} from "@signature-kit/engine/engine";
import { PdfSignatures, pdfSignaturesLayer } from "@signature-kit/engine/pdf-signatures";
import {
  BatchConfigSchema,
  LocalError,
  LocalRpcs,
  LocalTelemetry,
  PROTOCOL_VERSION,
} from "@signature-kit/engine/rpc";
import { SignaturePool } from "@signature-kit/engine/signature-compute";
import {
  SigningHelperRpcs,
  signingHelperHandlersLayer,
} from "@signature-kit/engine/signing-helper";
import { localTelemetryLayer, TelemetryOptionsSchema } from "@signature-kit/engine/telemetry";
import { pdfCoreModuleBrowserLayer } from "@signature-kit/engine/wasm/browser";
import { PdfCoreModule, pdfCoreModuleLayer } from "@signature-kit/engine/wasm/pdf-core";
import { batchDatabase, indexedDbBatchStorageLayer } from "./batch-storage.js";
import { SigningPoolSizeSchema, signingPoolLayer } from "./signing-pool.js";

export type ViewerHandlers = Pick<
  RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof LocalRpcs>>,
  "PdfCompose" | "PdfRenderPage" | "PdfVerify" | "PdfCompare"
>;

export const localHandlersLayer = <E, R>(viewer: Effect.Effect<ViewerHandlers, E, R>) =>
  LocalRpcs.toLayer(
    Effect.gen(function* () {
      const { instanceId } = yield* LocalRuntime;
      const documents = yield* Documents;
      const a1 = yield* A1Sessions;
      const pdf = yield* PdfEngine;
      const signatures = yield* PdfSignatures;
      const batches = yield* Batches;
      const pool = Option.getOrUndefined(yield* Effect.serviceOption(SignaturePool));
      const telemetry = Option.getOrUndefined(yield* Effect.serviceOption(LocalTelemetry));
      return LocalRpcs.of({
        ...(yield* viewer),
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
        PdfInspect: ({ handle }) => pdf.inspect(handle),
        A1Open: a1.open,
        A1Close: a1.close,
        PdfSignatureFields: ({ revision }) => signatures.fields(revision),
        PdfAddSignatureFields: ({ revision, fields }) => signatures.addFields(revision, fields),
        PdfAddValidationData: ({ revision, evidence }) =>
          signatures.addValidationData(revision, evidence),
        PdfPrepareDocumentTimestamp: ({ revision }) =>
          signatures.prepareDocumentTimestamp(revision),
        PdfAddDocumentTimestamp: ({ revision, token }) =>
          signatures.addDocumentTimestamp(revision, token),
        PdfPrepare: ({ revision, options }) => signatures.prepare(revision, options),
        PdfConfirm: ({ preparationId }) => signatures.confirm(preparationId),
        PdfRelease: ({ preparationId }) => signatures.release(preparationId),
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

const unavailable = () => Effect.fail(new LocalError({ code: "operationUnavailable" }));

const signingOnlyHandlersLayer = localHandlersLayer(
  Effect.succeed({
    PdfCompose: unavailable,
    PdfRenderPage: unavailable,
    PdfVerify: unavailable,
    PdfCompare: unavailable,
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

export const localWorkerRuntime = <E>(
  handlers: Layer.Layer<
    Rpc.ToHandler<RpcGroup.Rpcs<typeof LocalRpcs>>,
    E,
    LocalRuntime | Documents | A1Sessions | PdfEngine | PdfSignatures | Batches
  >,
  telemetry: boolean,
  options: LocalWorkerOptions,
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
        handlers.pipe(
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

export const signingWorker = (
  telemetry: boolean,
  options: LocalWorkerOptions = {},
  createSigningHelper?: () => Worker,
) => localWorkerRuntime(signingOnlyHandlersLayer, telemetry, options, createSigningHelper);

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
