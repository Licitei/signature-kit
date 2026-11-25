import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { pdfCoreFileLayer } from "@signature-kit/engine/wasm/file";
import { Deferred, Effect, Fiber, Layer, Queue, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";
import { readFile } from "node:fs/promises";
import { startBatchMachine } from "../src/batch-machine.js";
import { Batches, batchesLayer } from "../src/batches.js";
import { A1Sessions, Documents, localRuntimeLayer, pdfEngineLayer } from "../src/engine.js";
import { PdfSignatures, pdfSignaturesLayer } from "../src/pdf-signatures.js";
import type { BatchItem, BatchPrepareInput, BatchSelection } from "../src/rpc.js";

const config = { concurrency: 1, queueCapacity: 1, byteBudget: 1024 * 1024, eventCapacity: 2 };
const wasm = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));
const fixture = (path: string) =>
  Effect.promise(async () => new Uint8Array(await readFile(new URL(path, import.meta.url))));
const prepareInput = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2027-01-01T00:00:00Z"));
  const a1 = yield* A1Sessions;
  const documents = yield* Documents;
  const pfx = yield* fixture("../../../tooling/testing/fixtures/local/ecpf.p12");
  const source = yield* fixture("../../../crates/pdf/tests/fixtures/pdf/helvetica-winansi.pdf");
  const session = yield* a1.open({ pfx: Redacted.make(pfx), password: Redacted.make("changeit") });
  const revision = yield* documents.open(source);
  return {
    session,
    documents: [
      { itemId: "first", revision, anchors: { approval: { page: 0, rect: [32, 28, 192, 76] } } },
      { itemId: "second", revision, anchors: { approval: { page: 0, rect: [32, 28, 192, 76] } } },
      { itemId: "third", revision, anchors: { approval: { page: 0, rect: [32, 28, 192, 76] } } },
    ],
    template: {
      field: { kind: "anchor", name: "Approval", anchor: "approval" },
      appearance: { kind: "visible" },
      policy: "cades",
    },
  } satisfies BatchPrepareInput;
});

const selection = (items: ReadonlyArray<BatchItem>) => {
  const [first, ...rest] = items;
  if (first?.preparation === undefined) return Effect.die("Expected a prepared first item.");
  return Effect.succeed([
    { itemId: first.itemId, preparationId: first.preparation.preparationId },
    ...rest.flatMap(({ itemId, preparation }) =>
      preparation === undefined ? [] : [{ itemId, preparationId: preparation.preparationId }],
    ),
  ] satisfies BatchSelection);
};

const base = (options = config) =>
  batchesLayer(options).pipe(
    Layer.provideMerge(pdfSignaturesLayer),
    Layer.provideMerge(pdfEngineLayer),
  );

it.effect(
  "reviews exact selections, rejects direct confirmation, and drains the second admitted signature on cancellation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstEntered = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const firstContinues = yield* Deferred.make<void>();
        const secondContinues = yield* Deferred.make<void>();
        let signs = 0;
        const instrumentedA1 = Layer.effect(
          A1Sessions,
          Effect.gen(function* () {
            const service = yield* A1Sessions;
            return A1Sessions.of({
              ...service,
              sign: Effect.fn(function* (id, generation, bytes) {
                signs += 1;
                if (signs === 1) {
                  yield* Deferred.succeed(firstEntered, undefined);
                  yield* Deferred.await(firstContinues);
                }
                if (signs === 2) {
                  yield* Deferred.succeed(secondEntered, undefined);
                  yield* Deferred.await(secondContinues);
                }
                return yield* service.sign(id, generation, bytes);
              }),
            });
          }),
        );
        const layer = base().pipe(
          Layer.provideMerge(instrumentedA1),
          Layer.provide(localRuntimeLayer()),
          Layer.provide(wasm),
        );

        yield* Effect.gen(function* () {
          const batches = yield* Batches;
          const signatures = yield* PdfSignatures;
          const input = yield* prepareInput;
          const reviewed = yield* batches.prepare(input);
          const id = reviewed.batchId;
          expect(reviewed.state).toBe("reviewing");
          expect(signs).toBe(0);
          const approved = yield* selection(reviewed.items);
          expect(new Set(approved.map(({ preparationId }) => preparationId)).size).toBe(3);
          expect((yield* Effect.flip(signatures.confirm(approved[0].preparationId))).code).toBe(
            "preparationUnknown",
          );
          expect((yield* Effect.flip(batches.confirm(id, [approved[0], approved[0]]))).code).toBe(
            "batchSelection",
          );

          const slowStarted = yield* Deferred.make<void>();
          const slowContinues = yield* Deferred.make<void>();
          const slow = yield* batches.events(id).pipe(
            Stream.tap((event) =>
              event._tag === "snapshot"
                ? Deferred.succeed(slowStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(slowContinues)),
                  )
                : Effect.void,
            ),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Deferred.await(slowStarted);
          const fastStarted = yield* Deferred.make<void>();
          const fast = yield* batches.events(id).pipe(
            Stream.tap((event) =>
              event._tag === "snapshot" ? Deferred.succeed(fastStarted, undefined) : Effect.void,
            ),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Deferred.await(fastStarted);

          yield* batches.confirm(id, approved);
          yield* Deferred.await(firstEntered);
          expect((yield* Effect.flip(batches.confirm(id, approved))).code).toBe("batchTransition");
          expect(signs).toBe(1);
          yield* Deferred.succeed(firstContinues, undefined);
          yield* Deferred.await(secondEntered);
          expect((yield* batches.cancel(id)).state).toBe("draining");
          expect((yield* batches.cancel(id)).state).toBe("draining");
          yield* Deferred.succeed(secondContinues, undefined);

          const fastEvents = yield* Fiber.join(fast);
          yield* Deferred.succeed(slowContinues, undefined);
          const slowEvents = yield* Fiber.join(slow);
          const final = yield* batches.snapshot(id);
          expect(final.state).toBe("cancelled");
          expect(final.items.map(({ state }) => state)).toEqual(["signed", "signed", "cancelled"]);
          expect(signs).toBe(2);
          expect(fastEvents.at(-1)?.seq).toBe(final.seq);
          expect(
            slowEvents.some(
              (event, index) => index > 0 && event.seq > (slowEvents[index - 1]?.seq ?? 0) + 1,
            ),
          ).toBe(true);
          expect(yield* batches.events(id).pipe(Stream.runCollect)).toEqual([
            { _tag: "snapshot", seq: final.seq, snapshot: final },
          ]);
          const outputBytes = final.items.reduce(
            (sum, { receipt }) => sum + (receipt?.signedRevision.byteLength ?? 0),
            0,
          );
          expect(final.progress.retainedBytes).toBe(outputBytes);
          expect(final.progress.peakBytes).toBeLessThanOrEqual(config.byteBudget);
          expect((yield* batches.release(id)).progress.retainedBytes).toBe(0);
          expect((yield* Effect.flip(batches.snapshot(id))).code).toBe("batchUnknown");
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect(
  "retries a failed confirmation under a fresh attempt identity and rejects missing anchors before signing",
  () =>
    Effect.gen(function* () {
      const input = yield* prepareInput;
      const batches = yield* Batches;
      const first = input.documents[0];
      const batch = yield* batches.prepare({
        ...input,
        documents: [first, { itemId: "missing", revision: first.revision }],
      });
      expect(batch.items[1]).toMatchObject({ state: "needsAttention", reason: "fieldNotFound" });
      const id = batch.batchId;
      const approved = yield* selection(batch.items);
      yield* TestClock.setTime(Date.parse("2100-01-01T00:00:00Z"));
      yield* batches.confirm(id, approved);
      yield* batches.events(id).pipe(Stream.runDrain);
      const failed = yield* batches.snapshot(id);
      expect(failed.state).toBe("completed");
      expect(failed.items[0]).toMatchObject({ state: "failed", reason: "certificateExpired" });
      yield* TestClock.setTime(Date.parse("2027-01-01T00:00:00Z"));
      yield* batches.retry(id, [first.itemId]);
      yield* batches.events(id).pipe(Stream.runDrain);
      const retried = yield* batches.snapshot(id);
      expect(retried.items[0]?.state).toBe("signed");
      expect(retried.items[0]?.attemptId).not.toBe(failed.items[0]?.attemptId);
      expect(retried.items[1]).toMatchObject({ state: "needsAttention" });
      expect((yield* batches.release(id)).progress.retainedBytes).toBe(0);
    }).pipe(
      Effect.provide(base().pipe(Layer.provideMerge(localRuntimeLayer()), Layer.provide(wasm))),
    ),
);

it.effect("classifies an oversized source immediately without reserving bytes", () =>
  Effect.gen(function* () {
    const input = yield* prepareInput;
    const batches = yield* Batches;
    const batch = yield* batches.prepare(input);
    expect(batch.items.map(({ reason }) => reason)).toEqual(
      Array.from({ length: 3 }, () => "itemExceedsBudget"),
    );
    expect(batch.progress.retainedBytes).toBe(0);
    expect(batch.progress.peakBytes).toBe(0);
    yield* batches.cancel(batch.batchId);
    expect((yield* batches.release(batch.batchId)).progress.retainedBytes).toBe(0);
  }).pipe(
    Effect.provide(
      base({ ...config, byteBudget: 1 }).pipe(
        Layer.provideMerge(localRuntimeLayer()),
        Layer.provide(wasm),
      ),
    ),
  ),
);

it.effect(
  "holds the next signing worker until the first worker releases its byte reservation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = localRuntimeLayer();
        const docLayer = runtime.pipe(Layer.provideMerge(wasm));
        const shared = yield* Layer.build(docLayer);
        const input = yield* prepareInput.pipe(Effect.provide(shared));
        const entered = yield* Queue.unbounded<number>();
        const unblocks = yield* Deferred.make<void>();
        let calls = 0;
        const instrumented = Layer.effect(
          A1Sessions,
          Effect.gen(function* () {
            const runtimeA1 = yield* A1Sessions;
            return A1Sessions.of({
              ...runtimeA1,
              sign: Effect.fn(function* (session, generation, bytes) {
                calls += 1;
                yield* Queue.offer(entered, calls);
                if (calls === 1) yield* Deferred.await(unblocks);
                return yield* runtimeA1.sign(session, generation, bytes);
              }),
            });
          }),
        );
        const standard = base().pipe(Layer.provideMerge(Layer.succeedContext(shared)));
        const { retained, execution } = yield* Effect.gen(function* () {
          const batches = yield* Batches;
          const reference = yield* batches.prepare(input);
          yield* batches.cancel(reference.batchId);
          yield* batches.release(reference.batchId);
          const single = yield* batches.prepare({ ...input, documents: [input.documents[0]] });
          const singleSelection = yield* selection(single.items);
          yield* batches.confirm(single.batchId, singleSelection);
          yield* batches.events(single.batchId).pipe(Stream.runDrain);
          const singleResult = yield* batches.release(single.batchId);
          return {
            retained: reference.progress.retainedBytes,
            execution: singleResult.progress.peakBytes - single.progress.retainedBytes,
          };
        }).pipe(Effect.provide(standard));

        const byteBudget = retained + execution;
        const restricted = base({ ...config, concurrency: 2, byteBudget }).pipe(
          Layer.provide(instrumented),
          Layer.provide(Layer.succeedContext(shared)),
        );
        yield* Effect.gen(function* () {
          const batches = yield* Batches;
          const reviewed = yield* batches.prepare(input);
          expect(reviewed.items.every(({ state }) => state === "ready")).toBe(true);
          yield* batches.confirm(reviewed.batchId, yield* selection(reviewed.items));
          expect(yield* Queue.take(entered)).toBe(1);
          yield* TestClock.adjust("1 millis");
          const active = yield* batches.snapshot(reviewed.batchId);
          expect(active.items.map(({ state }) => state)).toEqual(["signing", "queued", "queued"]);
          expect(active.progress.peakBytes).toBe(byteBudget);
          yield* Deferred.succeed(unblocks, undefined);
          expect(yield* Queue.take(entered)).toBe(2);
          yield* batches.events(reviewed.batchId).pipe(Stream.runDrain);
          const released = yield* batches.release(reviewed.batchId);
          expect(released.progress.signed).toBe(3);
          expect(released.progress.retainedBytes).toBe(0);
        }).pipe(Effect.provide(restricted));
      }),
    ),
);

it.effect("checks the LocalMachine event before sending an invalid transition", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const move = yield* startBatchMachine;
      expect((yield* Effect.flip(move({ _tag: "Confirm" }))).code).toBe("batchTransition");
      expect(yield* move({ _tag: "Review" })).toBe("reviewing");
      expect(yield* move({ _tag: "Confirm" })).toBe("confirming");
      expect((yield* Effect.flip(move({ _tag: "Complete" }))).code).toBe("batchTransition");
      expect(yield* move({ _tag: "Drain" })).toBe("draining");
      expect(yield* move({ _tag: "Complete" })).toBe("completed");
    }),
  ),
);
