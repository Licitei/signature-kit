import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { startBatchMachine } from "./batch-machine.js";
import { BatchPlan, BatchStorage } from "./batch-storage.js";
import { A1Sessions, Documents } from "./engine.js";
import { PdfSignatures } from "./pdf-signatures.js";
import { SignaturePool } from "./signature-compute.js";
import { BatchConfigSchema, BatchEventSchema, BatchPrepareInputSchema, LocalError } from "./rpc.js";
import type {
  BatchConfig,
  BatchEvent,
  BatchPrepareInput,
  BatchItem,
  BatchItemIds,
  BatchSelection,
  BatchSnapshot,
  BatchState,
  PdfPreparation,
  RevisionRef,
} from "./rpc.js";

export class Batches extends Context.Service<
  Batches,
  {
    readonly prepare: (input: BatchPrepareInput) => Effect.Effect<BatchSnapshot, LocalError>;
    readonly confirm: (
      id: string,
      selection: BatchSelection,
    ) => Effect.Effect<BatchSnapshot, LocalError>;
    readonly cancel: (id: string) => Effect.Effect<BatchSnapshot, LocalError>;
    readonly retry: (id: string, itemIds: BatchItemIds) => Effect.Effect<BatchSnapshot, LocalError>;
    readonly snapshot: (id: string) => Effect.Effect<BatchSnapshot, LocalError>;
    readonly events: (id: string) => Stream.Stream<BatchEvent, LocalError>;
    readonly release: (id: string) => Effect.Effect<BatchSnapshot, LocalError>;
    readonly delete: (id: string) => Effect.Effect<void, LocalError>;
  }
>()("@signature-kit/engine/Batches") {}

type Source = {
  readonly revision: RevisionRef;
  readonly preparation: PdfPreparation;
  readonly retained: number;
  readonly working: number;
};

const terminal = (state: BatchState) =>
  state === "completed" || state === "failed" || state === "cancelled";
const encodePlan = Schema.encodeEffect(Schema.fromJsonString(BatchPlan));

export const batchesLayer = (
  options: BatchConfig = {
    concurrency: 2,
    queueCapacity: 4,
    byteBudget: 64 * 1024 * 1024,
    eventCapacity: 128,
  },
) =>
  Layer.effect(
    Batches,
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(BatchConfigSchema)(options).pipe(
        Effect.orDie,
      );
      const documents = yield* Documents;
      const a1 = yield* A1Sessions;
      const signatures = yield* PdfSignatures;
      const storage = Option.getOrUndefined(yield* Effect.serviceOption(BatchStorage));
      const pool = Option.getOrUndefined(yield* Effect.serviceOption(SignaturePool));
      const runtimeScope = yield* Effect.scope;
      const registryLock = yield* Semaphore.make(1);

      const makeBatch = Effect.fn(function* (
        id: string,
        input: BatchPrepareInput,
        scope: Scope.Closeable,
      ) {
        const persistence = input.resumeId === undefined ? undefined : storage;
        const signingWorkers = pool === undefined ? 0 : yield* pool.available;
        const compute = signingWorkers > 0 ? pool : undefined;
        const lock = yield* Semaphore.make(1);
        const bytes = yield* Semaphore.make(config.byteBudget);
        const admission = yield* Semaphore.make(1);
        const updates = yield* PubSub.sliding<BatchEvent>(config.eventCapacity);
        yield* Effect.addFinalizer(() => PubSub.shutdown(updates));
        const transition = yield* startBatchMachine;
        const items = new Map<string, BatchItem>(
          input.documents.map(({ itemId }) => [itemId, { itemId, state: "pending" }]),
        );
        const owner = Symbol();
        const sources = new Map<string, Source>();
        const outputs = new Map<string, RevisionRef>();
        const stopped = yield* Deferred.make<void>();
        let state: BatchState = "preparing";
        let reason: LocalError["code"] | undefined;
        let seq = 0;
        let retained = 0;
        let inFlight = 0;
        let peak = 0;
        let released = false;
        const progress = (): BatchSnapshot["progress"] => {
          let signed = 0;
          let failed = 0;
          let cancelled = 0;
          for (const item of items.values()) {
            if (item.state === "signed") signed++;
            if (item.state === "failed" || item.state === "needsAttention") failed++;
            if (item.state === "cancelled") cancelled++;
          }
          return {
            signed,
            failed,
            cancelled,
            total: items.size,
            retainedBytes: retained,
            peakBytes: peak,
          };
        };
        const snapshot = (): BatchSnapshot => ({
          batchId: id,
          seq,
          state,
          signingWorkers,
          items: Array.from(items.values()),
          progress: progress(),
          reason,
        });
        const publishProgress = Effect.suspend(() =>
          PubSub.publish(updates, { _tag: "progress", seq: ++seq, progress: progress() }),
        );
        const move = Effect.fn(function* (
          event: Parameters<typeof transition>[0],
          code?: LocalError["code"],
        ) {
          state = yield* transition(event);
          reason = code;
          yield* PubSub.publish(updates, { _tag: "batchStateChanged", seq: ++seq, state, reason });
        });
        const save = (item: BatchItem, outputDigest?: string) => {
          const { preparation: _preparation, ...stored } = item;
          return (
            persistence?.writeItem(id, {
              ...stored,
              version: 1,
              ...(outputDigest === undefined ? {} : { outputDigest }),
            }) ?? Effect.void
          );
        };
        const change = Effect.fn(function* (item: BatchItem) {
          items.set(item.itemId, item);
          yield* PubSub.publish(updates, { _tag: "itemStateChanged", seq: ++seq, item });
          yield* publishProgress;
        });
        const update = Effect.fn(function* (item: BatchItem) {
          yield* save(item);
          yield* change(item);
        });
        const account = (delta: number) =>
          Effect.suspend(() => {
            retained += delta;
            peak = Math.max(peak, retained + inFlight);
            return bytes.resize(config.byteBudget - retained);
          });

        const dropSource = Effect.fn(function* (itemId: string, outputBytes = 0) {
          const source = sources.get(itemId);
          if (source === undefined) return;
          yield* signatures.release(source.preparation.preparationId, owner);
          yield* documents.release(source.preparation.previewRevision.handle);
          yield* documents.release(source.revision.handle);
          sources.delete(itemId);
          yield* account(outputBytes - source.retained);
        });

        const cleanup = Effect.gen(function* () {
          yield* Effect.forEach(sources.keys(), (itemId) => dropSource(itemId), { discard: true });
          yield* Effect.forEach(outputs.values(), ({ handle }) => documents.release(handle), {
            discard: true,
          });
          outputs.clear();
          yield* account(-retained);
        });
        yield* Effect.addFinalizer(() => cleanup.pipe(Effect.orDie));

        const reserveReview = (owned: number, working: number, much: number) =>
          admission.withPermit(
            Effect.gen(function* () {
              if (owned + working > config.byteBudget) {
                return yield* new LocalError({ code: "itemExceedsBudget" });
              }
              let largest = working;
              for (const source of sources.values()) largest = Math.max(largest, source.working);
              if (retained + much + largest > config.byteBudget) {
                return yield* new LocalError({ code: "batchBudgetFull" });
              }
              yield* account(much);
            }),
          );

        const prepareOne = Effect.fn(function* ({
          itemId,
          revision,
          anchors,
        }: BatchPrepareInput["documents"][number]) {
          const saved = yield* persistence?.readItem(id, itemId) ?? Effect.succeed(undefined);
          const receipt = saved?.receipt;
          if (saved?.state === "signed" && persistence !== undefined) {
            if (receipt === undefined || saved.outputDigest === undefined) {
              return yield* new LocalError({ code: "batchStorageCorrupt" });
            }
            const length = receipt.signedRevision.byteLength;
            yield* reserveReview(length, length, length);
            const output = yield* persistence.readOutput(id, itemId);
            if (output?.byteLength !== length) {
              return yield* new LocalError({ code: "batchStorageCorrupt" });
            }
            peak = Math.max(peak, retained + length);
            const restored = yield* documents.open(output);
            outputs.set(itemId, restored);
            if ((yield* documents.digest(restored)) !== saved.outputDigest) {
              return yield* new LocalError({ code: "batchStorageCorrupt" });
            }
            return yield* change({
              itemId,
              attemptId: saved.attemptId,
              state: "signed",
              receipt: { ...receipt, signedRevision: restored },
            });
          }
          const { field, ...template } = input.template;
          const started = yield* Clock.currentTimeMillis;
          let owned = 0;
          let working = 0;
          let source: RevisionRef | undefined;
          const prepare = Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan(
              "queueWaitMs",
              Math.max(0, (yield* Clock.currentTimeMillis) - started),
            );
            const placement =
              field.kind === "anchor" &&
              anchors !== undefined &&
              Object.hasOwn(anchors, field.anchor)
                ? anchors[field.anchor]
                : undefined;
            if (field.kind === "anchor" && placement === undefined) {
              return yield* new LocalError({ code: "fieldNotFound" });
            }
            const sourceBytes = revision.byteLength * 2;
            yield* reserveReview(sourceBytes, 0, sourceBytes);
            owned = sourceBytes;
            source = yield* documents.retain(revision);
            const preparation = yield* signatures.prepare(
              source,
              {
                ...template,
                session: input.session,
                field:
                  field.kind === "anchor" && placement !== undefined
                    ? { kind: "create", name: field.name, ...placement }
                    : field.kind === "anchor"
                      ? { kind: "existing", name: field.name }
                      : field,
              },
              {
                identity: owner,
                nonce: crypto.randomUUID(),
                compute,
                reserve: ({
                  appendixBytes,
                  digestBytes,
                  previewBytes,
                  contentsCapacity,
                  preparedPayloadBytes,
                }) => {
                  const additional = preparedPayloadBytes + digestBytes + previewBytes;
                  return Effect.gen(function* () {
                    working =
                      appendixBytes +
                      contentsCapacity * 2 +
                      previewBytes * (persistence === undefined ? 2 : 3);
                    yield* reserveReview(owned + additional, working, additional);
                    owned += additional;
                    peak = Math.max(
                      peak,
                      retained - previewBytes - digestBytes + preparedPayloadBytes,
                    );
                  });
                },
              },
            );
            sources.set(itemId, { revision: source, preparation, retained: owned, working });
            return preparation;
          }).pipe(Effect.withSpan("local.batch.item.prepare"), Effect.uninterruptible);
          const result = yield* Effect.result(
            prepare.pipe(
              Effect.onError(() =>
                Effect.gen(function* () {
                  if (source !== undefined)
                    yield* documents.release(source.handle).pipe(Effect.orDie);
                  yield* account(-owned);
                }),
              ),
            ),
          );
          if (Result.isSuccess(result)) {
            return yield* update({ itemId, preparation: result.success, state: "ready" });
          }
          yield* update({ itemId, state: "needsAttention", reason: result.failure.code });
        });

        const prepare = Effect.gen(function* () {
          if (persistence !== undefined) {
            const plan = BatchPlan.make({
              version: 1,
              template: input.template,
              documents: yield* Effect.forEach(input.documents, ({ itemId, revision, anchors }) =>
                documents.digest(revision).pipe(
                  Effect.map((digest) => ({
                    itemId,
                    digest,
                    anchors:
                      anchors === undefined
                        ? undefined
                        : Object.fromEntries(
                            Object.entries(anchors).sort(([left], [right]) =>
                              left.localeCompare(right),
                            ),
                          ),
                  })),
                ),
              ),
            });
            yield* Scope.provide(persistence.lock(id), scope);
            const existing = yield* persistence.readPlan(id);
            if (existing === undefined) {
              yield* persistence.writePlan(id, plan);
            } else {
              const before = yield* encodePlan(existing).pipe(Effect.orDie);
              const after = yield* encodePlan(plan).pipe(Effect.orDie);
              if (before !== after) return yield* new LocalError({ code: "batchResumeMismatch" });
            }
          }
          yield* Effect.forEach(input.documents, prepareOne, {
            concurrency: config.concurrency,
            discard: true,
          });
          yield* move({ _tag: "Review" });
          if (progress().signed === items.size) {
            yield* move({ _tag: "Drain" });
            yield* move({ _tag: "Complete" });
          }
          return snapshot();
        });

        const sign = Effect.fn(function* (itemId: string, queuedAt: number) {
          const item = items.get(itemId);
          const source = sources.get(itemId);
          if (item === undefined || item.state !== "queued" || source === undefined) {
            return yield* Effect.die("Expected a queued item with a batch-owned preparation.");
          }
          const begin = lock.withPermit(
            Effect.gen(function* () {
              if (yield* Deferred.isDone(stopped)) return false;
              yield* update({ ...item, state: "signing" });
              inFlight += source.working;
              peak = Math.max(peak, retained + inFlight);
              return true;
            }),
          );
          const execute = Effect.gen(function* () {
            if (!(yield* begin)) return;
            let working = source.working;
            yield* Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan(
                "queueWaitMs",
                Math.max(0, (yield* Clock.currentTimeMillis) - queuedAt),
              );
              const result = yield* Effect.result(
                signatures.confirm(source.preparation.preparationId, owner),
              );
              yield* lock.withPermit(
                Effect.gen(function* () {
                  if (Result.isFailure(result)) {
                    yield* update({ ...item, state: "failed", reason: result.failure.code });
                    return;
                  }
                  const receipt = result.success;
                  outputs.set(itemId, receipt.signedRevision);
                  const signed: BatchItem = {
                    itemId,
                    attemptId: item.attemptId,
                    state: "signed",
                    receipt,
                  };
                  if (persistence !== undefined) {
                    const output = yield* documents.export(receipt.signedRevision.handle);
                    yield* persistence.writeOutput(id, itemId, output);
                    yield* save(signed, yield* documents.digest(receipt.signedRevision));
                  }
                  inFlight -= working;
                  working = 0;
                  yield* dropSource(itemId, receipt.signedRevision.byteLength);
                  yield* change(signed);
                }),
              );
            }).pipe(
              Effect.withSpan("local.batch.item.confirm"),
              Effect.ensuring(
                lock.withPermit(
                  Effect.sync(() => {
                    inFlight -= working;
                  }),
                ),
              ),
            );
          });
          yield* Effect.scoped(
            bytes
              .takeScoped(source.working)
              .pipe(Effect.andThen(execute.pipe(Effect.uninterruptible))),
          );
        });

        const run = Effect.fn(function* (selected: ReadonlyArray<string>, queuedAt: number) {
          const queue = yield* Queue.bounded<string, Cause.Done>(config.queueCapacity);
          const offer = Effect.forEach(selected, (itemId) => Queue.offer(queue, itemId), {
            discard: true,
          });
          const produce = Effect.raceFirst(offer, Deferred.await(stopped)).pipe(
            Effect.ensuring(Queue.end(queue)),
          );
          const consume = Queue.take(queue).pipe(
            Effect.flatMap((itemId) => sign(itemId, queuedAt)),
            Effect.forever,
            Effect.catchTag("Done", () => Effect.void),
          );
          const result = yield* Effect.exit(
            Effect.all(
              [
                produce,
                Effect.forEach(Array.from({ length: config.concurrency }), () => consume, {
                  concurrency: "unbounded",
                  discard: true,
                }),
              ],
              { concurrency: "unbounded", discard: true },
            ),
          );
          yield* lock.withPermit(
            Effect.gen(function* () {
              if (state === "confirming") yield* move({ _tag: "Drain" });
              const wasCancelled = yield* Deferred.isDone(stopped);
              let storageCode: LocalError["code"] | undefined;
              for (const item of items.values()) {
                if (item.state === "queued" || item.state === "signing") {
                  yield* dropSource(item.itemId);
                  const next: BatchItem = {
                    itemId: item.itemId,
                    attemptId: item.attemptId,
                    state: wasCancelled ? "cancelled" : "failed",
                    reason: wasCancelled ? undefined : "batchExecutionFailed",
                  };
                  const persisted = yield* Effect.result(save(next));
                  if (Result.isFailure(persisted)) storageCode ??= persisted.failure.code;
                  yield* change(next);
                }
              }
              if (Exit.isFailure(result)) {
                const failure = result.cause.reasons.find(Cause.isFailReason);
                yield* move({ _tag: "Fail" }, failure?.error.code ?? "batchExecutionFailed");
              } else if (storageCode !== undefined) {
                yield* move({ _tag: "Fail" }, storageCode);
              } else {
                yield* move({ _tag: wasCancelled ? "Cancel" : "Complete" });
              }
            }),
          );
        });

        const beginAttempt = Effect.fn(function* (
          selected: ReadonlyArray<string>,
          event: { readonly _tag: "Confirm" | "Retry" },
          skipped: ReadonlyArray<BatchItem> = [],
        ) {
          const queuedAt = yield* Clock.currentTimeMillis;
          const queued = yield* Effect.forEach(selected, (itemId) => {
            const item = items.get(itemId);
            if (item === undefined) return Effect.die("Expected a selected batch item.");
            return Effect.succeed({
              ...item,
              state: "queued",
              reason: undefined,
              attemptId: crypto.randomUUID(),
            } satisfies BatchItem);
          });
          yield* Effect.forEach([...skipped, ...queued], (item) => save(item), { discard: true });
          yield* move(event);
          for (const item of skipped) {
            yield* dropSource(item.itemId);
            yield* change(item);
          }
          yield* Effect.forEach(queued, change, { discard: true });
          yield* run(selected, queuedAt).pipe(Effect.forkIn(scope));
        });

        const confirm = Effect.fn(function* (selection: BatchSelection) {
          if (state !== "reviewing" || released)
            return yield* new LocalError({ code: "batchTransition" });
          const ids = selection.map(({ itemId }) => itemId);
          if (
            new Set(ids).size !== ids.length ||
            selection.some(({ itemId, preparationId }) => {
              const item = items.get(itemId);
              return item?.state !== "ready" || item.preparation?.preparationId !== preparationId;
            })
          )
            return yield* new LocalError({ code: "batchSelection" });

          const skipped = Array.from(items.values()).flatMap(({ itemId, state }) =>
            state === "ready" && !ids.includes(itemId)
              ? [{ itemId, state: "skipped" } satisfies BatchItem]
              : [],
          );
          yield* beginAttempt(ids, { _tag: "Confirm" }, skipped);
          return snapshot();
        });

        const cancel = Effect.gen(function* () {
          if (released || terminal(state)) return snapshot();
          const alreadyReviewing = state === "reviewing";
          if (state !== "draining") yield* move({ _tag: "Drain" });
          yield* Deferred.succeed(stopped, undefined);
          if (alreadyReviewing) {
            let storageCode: LocalError["code"] | undefined;
            for (const item of items.values()) {
              if (item.state !== "ready") continue;
              yield* dropSource(item.itemId);
              const cancelled: BatchItem = { itemId: item.itemId, state: "cancelled" };
              const persisted = yield* Effect.result(save(cancelled));
              if (Result.isFailure(persisted)) storageCode ??= persisted.failure.code;
              yield* change(cancelled);
            }
            yield* storageCode === undefined
              ? move({ _tag: "Cancel" })
              : move({ _tag: "Fail" }, storageCode);
          }
          return snapshot();
        });

        const retry = Effect.fn(function* (itemIds: BatchItemIds) {
          if (state !== "completed" || released)
            return yield* new LocalError({ code: "batchTransition" });
          if (
            new Set(itemIds).size !== itemIds.length ||
            itemIds.some((itemId) => items.get(itemId)?.state !== "failed" || !sources.has(itemId))
          )
            return yield* new LocalError({ code: "batchSelection" });
          yield* beginAttempt(itemIds, { _tag: "Retry" });
          return snapshot();
        });

        const events = Stream.unwrap(
          Effect.gen(function* () {
            const observerScope = yield* Effect.scope;
            const { initial, subscription } = yield* lock.withPermit(
              Effect.gen(function* () {
                if (released) return yield* new LocalError({ code: "batchUnknown" });
                return {
                  subscription: yield* Scope.provide(PubSub.subscribe(updates), observerScope),
                  initial: snapshot(),
                };
              }),
            );
            const first = Stream.succeed(
              BatchEventSchema.make({ _tag: "snapshot", seq: initial.seq, snapshot: initial }),
            );
            if (terminal(initial.state)) return first;
            return Stream.concat(
              first,
              Stream.fromSubscription(subscription).pipe(
                Stream.takeUntil(
                  (event) => event._tag === "batchStateChanged" && terminal(event.state),
                ),
              ),
            );
          }),
        );

        const release = Effect.gen(function* () {
          if (!terminal(state) || released)
            return yield* new LocalError({ code: "batchTransition" });
          released = true;
          yield* cleanup;
          return snapshot();
        });

        return {
          scope,
          prepare,
          confirm: (selection: BatchSelection) =>
            lock.withPermit(confirm(selection).pipe(Effect.uninterruptible)),
          cancel: lock.withPermit(cancel.pipe(Effect.uninterruptible)),
          retry: (ids: BatchItemIds) => lock.withPermit(retry(ids).pipe(Effect.uninterruptible)),
          snapshot: lock.withPermit(Effect.sync(snapshot)),
          events,
          release: lock.withPermit(release),
        };
      });

      const batches = yield* Ref.make(
        new Map<string, Effect.Success<ReturnType<typeof makeBatch>>>(),
      );
      const find = (id: string) =>
        Ref.get(batches).pipe(
          Effect.flatMap((current) => {
            const batch = current.get(id);
            return batch === undefined
              ? Effect.fail(new LocalError({ code: "batchUnknown" }))
              : Effect.succeed(batch);
          }),
        );
      return Batches.of({
        prepare: Effect.fn(function* (input) {
          const parsed = yield* Schema.decodeUnknownEffect(BatchPrepareInputSchema)(input).pipe(
            Effect.mapError(() => new LocalError({ code: "batchSelection" })),
          );
          if (
            new Set(parsed.documents.map(({ itemId }) => itemId)).size !== parsed.documents.length
          ) {
            return yield* new LocalError({ code: "batchSelection" });
          }
          if (parsed.resumeId !== undefined && storage === undefined) {
            return yield* new LocalError({ code: "batchResumeUnavailable" });
          }
          yield* a1.validate(parsed.session);
          const id = parsed.resumeId ?? crypto.randomUUID();
          const scope = yield* Scope.fork(runtimeScope);
          return yield* Effect.gen(function* () {
            if ((yield* Ref.get(batches)).has(id))
              return yield* new LocalError({ code: "batchLocked" });
            const batch = yield* Scope.provide(makeBatch(id, parsed, scope), scope);
            const snapshot = yield* batch.prepare;
            yield* Ref.update(batches, (current) => new Map(current).set(id, batch));
            return snapshot;
          }).pipe(
            (effect) => registryLock.withPermit(effect),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
            ),
            Effect.uninterruptible,
          );
        }),
        confirm: (id, selection) =>
          find(id).pipe(Effect.flatMap((batch) => batch.confirm(selection))),
        cancel: (id) => find(id).pipe(Effect.flatMap((batch) => batch.cancel)),
        retry: (id, ids) => find(id).pipe(Effect.flatMap((batch) => batch.retry(ids))),
        snapshot: (id) => find(id).pipe(Effect.flatMap((batch) => batch.snapshot)),
        events: (id) => Stream.unwrap(find(id).pipe(Effect.map((batch) => batch.events))),
        release: (id) =>
          registryLock.withPermit(
            Effect.gen(function* () {
              const batch = yield* find(id);
              const released = yield* batch.release;
              yield* Ref.update(batches, (current) => {
                const next = new Map(current);
                next.delete(id);
                return next;
              });
              yield* Scope.close(batch.scope, Exit.void);
              return released;
            }).pipe(Effect.uninterruptible),
          ),
        delete: (id) =>
          registryLock.withPermit(
            Effect.scoped(
              Effect.gen(function* () {
                if (storage === undefined)
                  return yield* new LocalError({ code: "batchResumeUnavailable" });
                if ((yield* Ref.get(batches)).has(id))
                  return yield* new LocalError({ code: "batchLocked" });
                yield* storage.lock(id);
                yield* storage.delete(id);
              }),
            ),
          ),
      });
    }),
  );
