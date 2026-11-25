import { Effect, Layer, Option, Schema, Stream } from "effect";
import { commands } from "vitest/browser";
import { expect, it } from "vitest";
import { contractTemplate } from "@signature-kit/engine/templates";
import { LocalClient, localClientLayer } from "../src/client.js";
import {
  batchTelemetry,
  beginSession,
  collectSpans,
  prepareContracts,
  reviewedSelection,
} from "./batch-page.js";

const pageMemory = Schema.decodeUnknownOption(
  Schema.Struct({
    memory: Schema.Struct({ usedJSHeapSize: Schema.Finite }),
  }),
);

const percentile = (numbers: ReadonlyArray<number>, p: number) => {
  const sorted = numbers.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
};

it("signs batches of 10 and 50 composed contracts while Chromium blocks network access", async () => {
  const measure = Effect.gen(function* () {
    const client = yield* LocalClient;
    const warm = yield* client.composePdf({ document: contractTemplate() });
    yield* client.releaseDocument(warm.handle);
    const session = yield* beginSession;
    yield* collectSpans;
    yield* Effect.acquireRelease(
      Effect.promise(() => commands.blockLocalRuntimeNetwork(true)),
      () => Effect.promise(() => commands.blockLocalRuntimeNetwork(false)),
    );
    for (const count of [10, 50]) {
      const trials = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
        Effect.gen(function* () {
          let pagePeakHeapBytes = yield* Effect.promise(() => commands.sampleBatchPageHeap());
          const started = performance.now();
          const reviewed = yield* prepareContracts(count, session);
          expect(reviewed.progress.signed).toBe(0);
          yield* client.confirmBatch(reviewed.batchId, yield* reviewedSelection(reviewed.items));
          yield* client.batchEvents(reviewed.batchId).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                const memory = pageMemory(performance);
                if (Option.isSome(memory))
                  pagePeakHeapBytes = Math.max(
                    pagePeakHeapBytes,
                    memory.value.memory.usedJSHeapSize,
                  );
              }),
            ),
            Stream.runDrain,
          );
          const completed = yield* client.batchSnapshot(reviewed.batchId);
          const elapsedMs = performance.now() - started;
          pagePeakHeapBytes = Math.max(
            pagePeakHeapBytes,
            yield* Effect.promise(() => commands.sampleBatchPageHeap()),
          );
          expect(completed.progress.signed).toBe(count);
          const spans = yield* collectSpans;
          const execution = spans.filter(({ name }) => name === "local.batch.item.confirm");
          expect(execution).toHaveLength(count);
          const milliseconds = execution.map(
            ({ startTime, endTime }) => Number(BigInt(endTime) - BigInt(startTime)) / 1_000_000,
          );
          const everySignedPdfVerifies = yield* Effect.forEach(completed.items, ({ receipt }) =>
            receipt === undefined
              ? Effect.succeed(false)
              : client
                  .verifyPdf(receipt.signedRevision)
                  .pipe(Effect.map(({ signatures }) => signatures[0]?.integrity === "valid")),
          );
          expect(everySignedPdfVerifies.every(Boolean)).toBe(true);
          expect((yield* client.releaseBatch(reviewed.batchId)).progress.retainedBytes).toBe(0);
          yield* collectSpans;
          return {
            elapsedMs,
            milliseconds,
            pagePeakHeapBytes,
            peakBytes: completed.progress.peakBytes,
          };
        }),
      );
      const milliseconds = trials.flatMap((trial) => trial.milliseconds);
      console.info(
        JSON.stringify({
          batch: count,
          totalMedianMs: percentile(
            trials.map((trial) => trial.elapsedMs),
            0.5,
          ),
          itemP50Ms: percentile(milliseconds, 0.5),
          itemP95Ms: percentile(milliseconds, 0.95),
          pagePeakHeapBytes: Math.max(...trials.map((trial) => trial.pagePeakHeapBytes)),
          peakBytes: Math.max(...trials.map((trial) => trial.peakBytes)),
        }),
      );
    }
  });
  await Effect.runPromise(
    Effect.scoped(measure).pipe(
      Effect.provide(
        localClientLayer(
          () =>
            new Worker(new URL("./batch-benchmark.worker.ts", import.meta.url), { type: "module" }),
        ).pipe(Layer.provideMerge(batchTelemetry)),
      ),
    ),
  );
}, 120_000);

it("recovers committed receipts after a tab reload and enforces a same-origin tab lock", async () => {
  await commands.runBatchResume();
}, 120_000);

it("signs batches across a signing worker pool and drains every worker on cancel", async () => {
  const program = Effect.gen(function* () {
    const client = yield* LocalClient;
    const warm = yield* client.composePdf({ document: contractTemplate() });
    yield* client.releaseDocument(warm.handle);
    const session = yield* beginSession;
    yield* client.prewarm();
    yield* Effect.acquireRelease(
      Effect.promise(() => commands.blockLocalRuntimeNetwork(true)),
      () => Effect.promise(() => commands.blockLocalRuntimeNetwork(false)),
    );

    const reviewed = yield* prepareContracts(24, session);
    expect(reviewed.items.every(({ state }) => state === "ready")).toBe(true);
    yield* client.confirmBatch(reviewed.batchId, yield* reviewedSelection(reviewed.items));
    yield* client.batchEvents(reviewed.batchId).pipe(Stream.runDrain);
    const completed = yield* client.batchSnapshot(reviewed.batchId);
    expect(completed.state).toBe("completed");
    expect(completed.progress.signed).toBe(24);
    const integrity = yield* Effect.forEach(completed.items, ({ receipt }) =>
      receipt === undefined
        ? Effect.succeed(undefined)
        : client
            .verifyPdf(receipt.signedRevision)
            .pipe(Effect.map(({ signatures }) => signatures[0]?.integrity)),
    );
    expect(integrity.every((value) => value === "valid")).toBe(true);
    const first = completed.items[0]?.receipt;
    if (first === undefined) return yield* Effect.die("Expected a signed receipt.");
    const signed = yield* client.exportDocument(first.signedRevision.handle);
    yield* Effect.promise(() =>
      commands.verifyPdfIndependently(
        btoa(Array.from(signed, (byte) => String.fromCharCode(byte)).join("")),
        1,
      ),
    );
    expect((yield* client.releaseBatch(reviewed.batchId)).progress.retainedBytes).toBe(0);

    const second = yield* prepareContracts(60, session);
    yield* client.confirmBatch(second.batchId, yield* reviewedSelection(second.items));
    yield* client.cancelBatch(second.batchId);
    yield* client.batchEvents(second.batchId).pipe(Stream.runDrain);
    const cancelled = yield* client.batchSnapshot(second.batchId);
    expect(["cancelled", "completed"]).toContain(cancelled.state);
    expect(cancelled.items.every(({ state }) => state === "signed" || state === "cancelled")).toBe(
      true,
    );
    expect(cancelled.progress.signed + cancelled.progress.cancelled).toBe(60);
    const survivors = yield* Effect.forEach(
      cancelled.items.flatMap(({ receipt }) => (receipt === undefined ? [] : [receipt])),
      (receipt) =>
        client
          .verifyPdf(receipt.signedRevision)
          .pipe(Effect.map(({ signatures }) => signatures[0]?.integrity === "valid")),
    );
    expect(survivors.every(Boolean)).toBe(true);
    expect((yield* client.releaseBatch(second.batchId)).progress.retainedBytes).toBe(0);
  });
  await Effect.runPromise(
    Effect.scoped(program).pipe(
      Effect.provide(
        localClientLayer(
          () =>
            new Worker(new URL("./batch-benchmark.worker.ts", import.meta.url), {
              type: "module",
              name: "3",
            }),
        ).pipe(Layer.provideMerge(batchTelemetry)),
      ),
    ),
  );
}, 120_000);

const signOffline = (helpers: "started" | "missing") =>
  Effect.gen(function* () {
    const client = yield* LocalClient;
    const warm = yield* client.composePdf({ document: contractTemplate() });
    yield* client.releaseDocument(warm.handle);
    const session = yield* beginSession;
    if (helpers === "started") yield* client.prewarm();
    yield* Effect.acquireRelease(
      Effect.promise(() => commands.blockLocalRuntimeNetwork(true)),
      () => Effect.promise(() => commands.blockLocalRuntimeNetwork(false)),
    );
    const reviewed = yield* prepareContracts(50, session);
    expect(reviewed.signingWorkers).toBe(helpers === "started" ? 3 : 0);
    expect(reviewed.items.every(({ state }) => state === "ready")).toBe(true);
    yield* client.confirmBatch(reviewed.batchId, yield* reviewedSelection(reviewed.items));
    yield* client.batchEvents(reviewed.batchId).pipe(Stream.runDrain);
    const completed = yield* client.batchSnapshot(reviewed.batchId);
    expect(completed.state).toBe("completed");
    expect(completed.progress.signed).toBe(50);
    expect(completed.signingWorkers).toBe(reviewed.signingWorkers);
    const first = completed.items[0]?.receipt;
    if (first === undefined) return yield* Effect.die("Expected a signed receipt.");
    const signed = yield* client.exportDocument(first.signedRevision.handle);
    yield* Effect.promise(() =>
      commands.verifyPdfIndependently(
        btoa(Array.from(signed, (byte) => String.fromCharCode(byte)).join("")),
        1,
      ),
    );
    yield* client.releaseBatch(reviewed.batchId);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      localClientLayer(
        () =>
          new Worker(new URL("./offline-pool.worker.ts", import.meta.url), {
            type: "module",
            name: helpers,
          }),
      ),
    ),
  );

it("signs a batch of 50 offline on signing helpers started at worker boot", async () => {
  await Effect.runPromise(signOffline("started"));
}, 120_000);

it("signs a batch of 50 offline on the runtime worker when no signing helper starts", async () => {
  await Effect.runPromise(signOffline("missing"));
}, 120_000);
