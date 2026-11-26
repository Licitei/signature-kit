import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect";
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
  readonly adopted: Ref.Ref<string | undefined>;
  readonly adoptLock: Semaphore.Semaphore;
};

type Scheduler = {
  readonly helpers: ReadonlyArray<Helper>;
  readonly inFlight: ReadonlyMap<Helper, number>;
  readonly lost: ReadonlySet<Helper>;
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
      const scheduler = yield* Ref.make<Scheduler>({
        helpers: [],
        inFlight: new Map(),
        lost: new Set(),
      });
      const startOne = Effect.gen(function* () {
        const context = yield* Layer.build(helperLayer(createWorker, module));
        const client = Context.get(context, HelperClient);
        yield* client.HelperReady(undefined);
        return {
          client,
          adopted: yield* Ref.make<string | undefined>(undefined),
          adoptLock: yield* Semaphore.make(1),
        } satisfies Helper;
      }).pipe(
        Effect.timeoutOption(HELPER_START_TIMEOUT),
        Effect.catchTag("RpcClientError", () => Effect.succeed(Option.none<Helper>())),
        Scope.provide(scope),
      );
      yield* Effect.forEach(
        Array.from({ length: count }),
        () =>
          startOne.pipe(
            Effect.flatMap((helper) =>
              Option.isSome(helper)
                ? Ref.update(scheduler, (current) => ({
                    ...current,
                    helpers: [...current.helpers, helper.value],
                  }))
                : Effect.void,
            ),
          ),
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.andThen(Ref.get(scheduler)),
        Effect.flatMap(({ helpers }) => Deferred.succeed(started, helpers)),
        Effect.forkIn(scope),
      );
      const affinity = yield* Ref.make(new Map<string, Helper>());

      const acquire = (preferred?: Helper) =>
        Ref.modify(scheduler, (current) => {
          let selected =
            preferred !== undefined &&
            current.helpers.includes(preferred) &&
            !current.lost.has(preferred)
              ? preferred
              : undefined;
          let lowest = selected === undefined ? Infinity : (current.inFlight.get(selected) ?? 0);
          if (selected === undefined) {
            for (const helper of current.helpers) {
              if (current.lost.has(helper)) continue;
              const load = current.inFlight.get(helper) ?? 0;
              if (load < lowest) {
                lowest = load;
                selected = helper;
              }
            }
          }
          if (selected === undefined) return [undefined, current];
          const inFlight = new Map(current.inFlight);
          inFlight.set(selected, lowest + 1);
          return [selected, { ...current, inFlight }];
        });
      const releaseHelper = (helper: Helper) =>
        Ref.update(scheduler, (current) => {
          const load = (current.inFlight.get(helper) ?? 1) - 1;
          const inFlight = new Map(current.inFlight);
          if (load > 0) inFlight.set(helper, load);
          else inFlight.delete(helper);
          return { ...current, inFlight };
        });
      const withHelper = <A, E>(
        preferred: Helper | undefined,
        use: (helper: Helper | undefined) => Effect.Effect<A, E>,
      ) =>
        Effect.acquireUseRelease(acquire(preferred), use, (helper) =>
          helper === undefined ? Effect.void : releaseHelper(helper),
        );
      const forget = (key: string) =>
        Ref.update(affinity, (current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      const lose = (helper: Helper) =>
        Ref.update(scheduler, (current) => ({
          ...current,
          lost: new Set(current.lost).add(helper),
        }));
      const adopt = Effect.fnUntraced(function* (helper: Helper, session: A1SessionBinding) {
        yield* helper.adoptLock.withPermit(
          Effect.gen(function* () {
            const current = `${session.sessionId}/${session.generation}`;
            if ((yield* Ref.get(helper.adopted)) === current) return;
            yield* helper.client.HelperAdopt(yield* a1.share(session));
            yield* Ref.set(helper.adopted, current);
          }),
        );
      });

      return SignaturePool.of({
        size: count,
        available: Deferred.await(started).pipe(Effect.map((all) => all.length)),
        prewarm: Deferred.await(started).pipe(
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
          return yield* withHelper(undefined, (helper) => {
            if (helper === undefined) return local.prepare(source, input);
            return Ref.update(affinity, (current) => new Map(current).set(source.key, helper)).pipe(
              Effect.andThen(
                Effect.all(
                  [
                    adopt(helper, input.options.session),
                    helper.client.HelperPrepare({ key: source.key, bytes: joined(source), input }),
                  ],
                  { concurrency: 2 },
                ).pipe(Effect.map(([, prepared]) => prepared)),
              ),
              Effect.catchTag("RpcClientError", () =>
                lose(helper).pipe(
                  Effect.andThen(forget(source.key)),
                  Effect.andThen(local.prepare(source, input)),
                ),
              ),
            );
          });
        }),
        sign: Effect.fnUntraced(function* (source, input) {
          const known = (yield* Ref.get(affinity)).get(source.key);
          return yield* withHelper(known, (helper) => {
            if (helper === undefined) return local.sign(source, input);
            return Effect.gen(function* () {
              yield* adopt(helper, input.session);
              return yield* helper.client.HelperSign({
                key: source.key,
                bytes: helper === known ? undefined : joined(source),
                input:
                  helper === known
                    ? {
                        session: input.session,
                        policy: input.policy,
                        signedAt: input.signedAt,
                        digest: input.digest,
                      }
                    : input,
              });
            }).pipe(
              Effect.catchTag("RpcClientError", () =>
                lose(helper).pipe(Effect.andThen(local.sign(source, input))),
              ),
              Effect.tap(() => forget(source.key)),
            );
          });
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
