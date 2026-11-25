import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { Context, Deferred, Duration, Effect, Layer, Option, Ref, Schema, Scope } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { A1Sessions } from "@signature-kit/engine/engine";
import type { A1SessionBinding } from "@signature-kit/engine/rpc";
import { SignaturePool, makeLocalCompute } from "@signature-kit/engine/signature-compute";
import { SigningHelperRpcs } from "@signature-kit/engine/signing-helper";
import { PdfCoreModule } from "@signature-kit/engine/wasm/pdf-core";
import type { ComputeSource } from "@signature-kit/engine/signature-compute";

export const SigningPoolSizeSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 64 }),
);

const HELPER_START_TIMEOUT = Duration.seconds(10);

class HelperClient extends Context.Service<
  HelperClient,
  RpcClient.FromGroup<typeof SigningHelperRpcs, RpcClientError>
>()("@signature-kit/browser/SigningHelperClient") {}

type Helper = {
  readonly client: Context.Service.Shape<typeof HelperClient>;
  readonly inFlight: Ref.Ref<number>;
  readonly lost: Ref.Ref<boolean>;
  readonly adopted: Ref.Ref<string | undefined>;
};

const helperLayer = (createWorker: () => Worker, module: WebAssembly.Module) =>
  Layer.effect(HelperClient, RpcClient.make(SigningHelperRpcs, { disableTracing: true })).pipe(
    Layer.provide(
      RpcClient.layerProtocolWorker({ size: 1, concurrency: 64 }).pipe(
        Layer.provide(
          BrowserWorker.layer(() => {
            const worker = createWorker();
            worker.postMessage(module);
            return worker;
          }),
        ),
      ),
    ),
  );

const joined = ({ revision }: ComputeSource) => {
  const bytes = new Uint8Array(revision.byteLength);
  let offset = 0;
  for (const part of revision.parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

export const signingPoolLayer = (size: number, createWorker: () => Worker) =>
  Layer.effect(
    SignaturePool,
    Effect.gen(function* () {
      const count = yield* Schema.decodeUnknownEffect(SigningPoolSizeSchema)(size).pipe(
        Effect.orDie,
      );
      const a1 = yield* A1Sessions;
      const module = yield* PdfCoreModule;
      const local = makeLocalCompute(a1);
      const scope = yield* Effect.scope;
      const started = yield* Deferred.make<ReadonlyArray<Helper>>();
      const startOne = Effect.gen(function* () {
        const context = yield* Layer.build(helperLayer(createWorker, module));
        const client = Context.get(context, HelperClient);
        yield* client.HelperReady(undefined);
        return {
          client,
          inFlight: yield* Ref.make(0),
          lost: yield* Ref.make(false),
          adopted: yield* Ref.make<string | undefined>(undefined),
        } satisfies Helper;
      }).pipe(
        Effect.timeoutOption(HELPER_START_TIMEOUT),
        Effect.catchTag("RpcClientError", () => Effect.succeed(Option.none<Helper>())),
        Scope.provide(scope),
      );
      yield* Effect.forEach(Array.from({ length: count }), () => startOne, {
        concurrency: "unbounded",
      }).pipe(
        Effect.flatMap((helpers) => Deferred.succeed(started, helpers.flatMap(Option.toArray))),
        Effect.forkIn(scope),
      );
      const helpers = Deferred.await(started);
      const affinity = yield* Ref.make(new Map<string, Helper>());

      const pick = Effect.gen(function* () {
        let selected: Helper | undefined;
        let lowest = Infinity;
        for (const helper of yield* helpers) {
          if (yield* Ref.get(helper.lost)) continue;
          const load = yield* Ref.get(helper.inFlight);
          if (load < lowest) {
            lowest = load;
            selected = helper;
          }
        }
        return selected;
      });
      const busy = <A, E>(helper: Helper, effect: Effect.Effect<A, E>) =>
        Effect.acquireUseRelease(
          Ref.update(helper.inFlight, (load) => load + 1),
          () => effect,
          () => Ref.update(helper.inFlight, (load) => load - 1),
        );
      const forget = (key: string) =>
        Ref.update(affinity, (current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      const lose = (helper: Helper) => Ref.set(helper.lost, true);
      const adopt = Effect.fnUntraced(function* (helper: Helper, session: A1SessionBinding) {
        const current = `${session.sessionId}/${session.generation}`;
        if ((yield* Ref.get(helper.adopted)) === current) return;
        yield* helper.client.HelperAdopt(yield* a1.share(session));
        yield* Ref.set(helper.adopted, current);
      });

      return SignaturePool.of({
        size: count,
        available: helpers.pipe(Effect.map((all) => all.length)),
        prewarm: helpers.pipe(
          Effect.flatMap((all) =>
            Effect.forEach(
              all,
              (helper) =>
                helper.client
                  .HelperPrewarm(undefined)
                  .pipe(Effect.catchTag("RpcClientError", () => lose(helper))),
              { concurrency: "unbounded", discard: true },
            ),
          ),
          Effect.ignore,
        ),
        prepare: Effect.fnUntraced(function* (source, input) {
          const helper = yield* pick;
          if (helper === undefined) return yield* local.prepare(source, input);
          yield* Ref.update(affinity, (current) => new Map(current).set(source.key, helper));
          return yield* busy(
            helper,
            helper.client.HelperPrepare({ key: source.key, bytes: joined(source), input }),
          ).pipe(
            Effect.catchTag("RpcClientError", () =>
              lose(helper).pipe(
                Effect.andThen(forget(source.key)),
                Effect.andThen(local.prepare(source, input)),
              ),
            ),
          );
        }),
        sign: Effect.fnUntraced(function* (source, input) {
          const known = (yield* Ref.get(affinity)).get(source.key);
          const helper = known ?? (yield* pick);
          if (helper === undefined) return yield* local.sign(source, input);
          const signed = yield* busy(
            helper,
            Effect.gen(function* () {
              yield* adopt(helper, input.session);
              return yield* helper.client.HelperSign({
                key: source.key,
                bytes: known === undefined ? joined(source) : undefined,
                input,
              });
            }),
          ).pipe(
            Effect.catchTag("RpcClientError", () =>
              lose(helper).pipe(Effect.andThen(local.sign(source, input))),
            ),
          );
          yield* forget(source.key);
          return signed;
        }),
        release: (key) =>
          Effect.gen(function* () {
            const helper = (yield* Ref.get(affinity)).get(key);
            if (helper === undefined) return;
            yield* forget(key);
            yield* helper.client.HelperRelease({ key }).pipe(Effect.ignore);
          }),
      });
    }),
  );
