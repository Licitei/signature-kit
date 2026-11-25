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
