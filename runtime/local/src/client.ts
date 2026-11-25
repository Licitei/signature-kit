import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { Context, Deferred, Effect, Layer, Redacted, Ref, Schema } from "effect";
import type { Duration } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { LocalError, LocalRpcs, PROTOCOL_VERSION } from "./protocol.js";
import type {
  A1OpenInput,
  A1SessionInfo,
  Handle,
  InstanceId,
  PdfInspection,
  PdfPagePixels,
  PdfRenderInput,
  RevisionRef,
} from "./protocol.js";

export class LocalClient extends Context.Service<
  LocalClient,
  {
    readonly instanceId: InstanceId;
    readonly openDocument: (bytes: Uint8Array) => Effect.Effect<RevisionRef, LocalError>;
    readonly exportDocument: (handle: Handle) => Effect.Effect<Uint8Array<ArrayBuffer>, LocalError>;
    readonly releaseDocument: (handle: Handle) => Effect.Effect<void, LocalError>;
    readonly inspectPdf: (handle: Handle) => Effect.Effect<PdfInspection, LocalError>;
    readonly renderPage: (input: PdfRenderInput) => Effect.Effect<PdfPagePixels, LocalError>;
    readonly openA1: (input: A1OpenInput) => Effect.Effect<A1SessionInfo, LocalError>;
    readonly closeA1: () => Effect.Effect<void, LocalError>;
  }
>()("@signature-kit/local/LocalClient") {}

export const LocalClientOptionsSchema = Schema.Struct({
  requestTimeout: Schema.optional(Schema.Duration),
});
export type LocalClientOptions = (typeof LocalClientOptionsSchema)["Type"];

const withDeadline =
  (duration: Duration.Input) =>
  <A>(effect: Effect.Effect<A, LocalError | RpcClientError>): Effect.Effect<A, LocalError> =>
    effect.pipe(
      Effect.catchTag("RpcClientError", () =>
        Effect.fail(new LocalError({ code: "workerUnavailable" })),
      ),
      Effect.timeoutOrElse({
        duration,
        orElse: () => Effect.fail(new LocalError({ code: "workerUnavailable" })),
      }),
    );

export const localClientLayer = (createWorker: () => Worker, options: LocalClientOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const worker = yield* Effect.acquireRelease(
        Effect.try({
          try: createWorker,
          catch: () => new LocalError({ code: "workerUnavailable" }),
        }),
        (worker) => Effect.sync(() => worker.terminate()),
      );
      const send = withDeadline(options.requestTimeout ?? "30 seconds");
      return Layer.effect(
        LocalClient,
        Effect.gen(function* () {
          const rpc = yield* RpcClient.make(LocalRpcs, { spanPrefix: "local.client" });
          const { instanceId, version } = yield* send(rpc.Hello({ version: PROTOCOL_VERSION }));
          if (version !== PROTOCOL_VERSION)
            return yield* new LocalError({ code: "protocolMismatch" });

          const pending = yield* Ref.make({ closing: false, count: 0 });
          const drained = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const { count } = yield* Ref.updateAndGet(pending, (state) => ({
                ...state,
                closing: true,
              }));
              if (count > 0) yield* Deferred.await(drained);
            }),
          );
          const admit = Ref.modify(pending, (state) =>
            state.closing ? [false, state] : [true, { ...state, count: state.count + 1 }],
          ).pipe(
            Effect.filterOrFail(
              (admitted) => admitted,
              () => new LocalError({ code: "runtimeClosed" }),
            ),
          );
          const settle = Ref.updateAndGet(pending, (state) => ({
            ...state,
            count: state.count - 1,
          })).pipe(
            Effect.flatMap(({ closing, count }) =>
              closing && count === 0 ? Deferred.succeed(drained, undefined) : Effect.void,
            ),
          );
          const call = <A>(request: () => Effect.Effect<A, LocalError | RpcClientError>) =>
            Effect.acquireUseRelease(
              admit,
              () => send(request()),
              () => settle,
            );

          return LocalClient.of({
            instanceId,
            openDocument: (bytes) =>
              call(() => rpc.DocumentsOpen({ bytes: new Uint8Array(bytes) })),
            exportDocument: (handle) => call(() => rpc.DocumentsExport({ handle })),
            releaseDocument: (handle) => call(() => rpc.DocumentsRelease({ handle })),
            inspectPdf: (handle) => call(() => rpc.PdfInspect({ handle })),
            renderPage: (input) => call(() => rpc.PdfRenderPage(input)),
            openA1: ({ pfx, password }) =>
              call(() =>
                rpc.A1Open({
                  pfx: Redacted.make(new Uint8Array(Redacted.value(pfx))),
                  password,
                }),
              ),
            closeA1: () => call(() => rpc.A1Close(undefined)),
          });
        }),
      ).pipe(
        Layer.provide(
          RpcClient.layerProtocolWorker({ size: 1, concurrency: 16 }).pipe(
            Layer.provide(BrowserWorker.layer(() => worker)),
            Layer.catchTag("WorkerError", () =>
              Layer.effect(
                RpcClient.Protocol,
                Effect.fail(new LocalError({ code: "workerUnavailable" })),
              ),
            ),
          ),
        ),
      );
    }),
  );
