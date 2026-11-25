import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { Context, Effect, Layer, Ref, Schema, Scope } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { A1Sessions } from "@signature-kit/engine/engine";
import { LocalError } from "@signature-kit/engine/rpc";
import type { A1SessionBinding } from "@signature-kit/engine/rpc";
import { SignaturePool } from "@signature-kit/engine/signature-compute";
import { SigningHelperRpcs } from "@signature-kit/engine/signing-helper";
import type { ComputeSource } from "@signature-kit/engine/signature-compute";

const SigningPoolSizeSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }));

class HelperClient extends Context.Service<
  HelperClient,
  RpcClient.FromGroup<typeof SigningHelperRpcs, RpcClientError>
>()("@signature-kit/browser/SigningHelperClient") {}

type Helper = {
  readonly client: Context.Service.Shape<typeof HelperClient>;
  readonly inFlight: Ref.Ref<number>;
  readonly adopted: Ref.Ref<string | undefined>;
};

const helperLayer = (createWorker: () => Worker) =>
  Layer.effect(HelperClient, RpcClient.make(SigningHelperRpcs, { disableTracing: true })).pipe(
    Layer.provide(
      RpcClient.layerProtocolWorker({ size: 1, concurrency: 64 }).pipe(
        Layer.provide(BrowserWorker.layer(createWorker)),
      ),
    ),
  );

const unavailable = <A, E>(effect: Effect.Effect<A, E | RpcClientError>) =>
  effect.pipe(
    Effect.catchTag("RpcClientError", () =>
      Effect.fail(new LocalError({ code: "workerUnavailable" })),
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
      const scope = yield* Effect.scope;
      const helpers = yield* Effect.cached(
        Effect.forEach(
          Array.from({ length: count }),
          () =>
            Effect.gen(function* () {
              const context = yield* Layer.build(helperLayer(createWorker));
              return {
                client: Context.get(context, HelperClient),
                inFlight: yield* Ref.make(0),
                adopted: yield* Ref.make<string | undefined>(undefined),
              } satisfies Helper;
            }).pipe(Scope.provide(scope)),
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError(() => new LocalError({ code: "workerUnavailable" }))),
      );
      const affinity = yield* Ref.make(new Map<string, Helper>());

      const pick = Effect.gen(function* () {
        const all = yield* helpers;
        let selected: Helper | undefined;
        let lowest = Infinity;
        for (const helper of all) {
          const load = yield* Ref.get(helper.inFlight);
          if (load < lowest) {
            lowest = load;
            selected = helper;
          }
        }
        if (selected === undefined) return yield* Effect.die("The signing pool has no workers.");
        return selected;
      });
      const busy = <A, E>(helper: Helper, effect: Effect.Effect<A, E>) =>
        Effect.acquireUseRelease(
          Ref.update(helper.inFlight, (load) => load + 1),
          () => effect,
          () => Ref.update(helper.inFlight, (load) => load - 1),
        );
      const adopt = Effect.fnUntraced(function* (helper: Helper, session: A1SessionBinding) {
        const current = `${session.sessionId}/${session.generation}`;
        if ((yield* Ref.get(helper.adopted)) === current) return;
        yield* unavailable(helper.client.HelperAdopt(yield* a1.share(session)));
        yield* Ref.set(helper.adopted, current);
      });

      return SignaturePool.of({
        size: count,
        start: helpers.pipe(
          Effect.flatMap((all) =>
            Effect.forEach(all, ({ client }) => unavailable(client.HelperPrewarm(undefined)), {
              concurrency: "unbounded",
              discard: true,
            }),
          ),
        ),
        prepare: Effect.fnUntraced(function* (source, input) {
          const helper = yield* pick;
          yield* Ref.update(affinity, (current) => new Map(current).set(source.key, helper));
          return yield* busy(
            helper,
            unavailable(
              helper.client.HelperPrepare({ key: source.key, bytes: joined(source), input }),
            ),
          );
        }),
        sign: Effect.fnUntraced(function* (source, input) {
          const known = (yield* Ref.get(affinity)).get(source.key);
          const helper = known ?? (yield* pick);
          if (known === undefined) {
            yield* Ref.update(affinity, (current) => new Map(current).set(source.key, helper));
          }
          const signed = yield* busy(
            helper,
            Effect.gen(function* () {
              yield* adopt(helper, input.session);
              return yield* unavailable(
                helper.client.HelperSign({
                  key: source.key,
                  bytes: known === undefined ? joined(source) : undefined,
                  input,
                }),
              );
            }),
          );
          yield* Ref.update(affinity, (current) => {
            const next = new Map(current);
            next.delete(source.key);
            return next;
          });
          return signed;
        }),
        release: (key) =>
          Effect.gen(function* () {
            const helper = (yield* Ref.get(affinity)).get(key);
            if (helper === undefined) return;
            yield* Ref.update(affinity, (current) => {
              const next = new Map(current);
              next.delete(key);
              return next;
            });
            yield* helper.client.HelperRelease({ key }).pipe(Effect.ignore);
          }),
      });
    }),
  );
