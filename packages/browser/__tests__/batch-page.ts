import { LocalClient, localClientLayer } from "../src/client.js";
import { Effect, Layer, ManagedRuntime, Option, Redacted, Result, Stream } from "effect";
import { localTelemetryLayer } from "@signature-kit/engine/telemetry";
import { LocalTelemetry } from "@signature-kit/engine/rpc";
import type { A1SessionBinding, BatchItem, BatchSelection } from "@signature-kit/engine/rpc";
import { contractTemplate } from "@signature-kit/engine/templates";
import ecpf from "../../../tooling/testing/fixtures/local/ecpf.p12?inline";

const createWorker = () =>
  new Worker(new URL("./batch-resume.worker.ts", import.meta.url), { type: "module" });

export const batchTelemetry = localTelemetryLayer({ maxSpans: 4096, maxBytes: 2 * 1024 * 1024 });
export const beginSession = Effect.gen(function* () {
  const client = yield* LocalClient;
  const bytes = yield* Effect.promise(
    async () => new Uint8Array(await (await fetch(ecpf)).arrayBuffer()),
  );
  return yield* client.openA1({ pfx: Redacted.make(bytes), password: Redacted.make("changeit") });
});
export const prepareContracts = Effect.fn(function* (
  count: number,
  session: A1SessionBinding,
  resumeId?: string,
) {
  const client = yield* LocalClient;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const contracts = yield* Effect.forEach(
        Array.from({ length: count }, (_, index) => index),
        (index) =>
          Effect.acquireRelease(
            client.composePdf({ document: contractTemplate(2 + (index % 2)) }),
            (revision) => client.releaseDocument(revision.handle).pipe(Effect.ignore),
          ).pipe(Effect.map((revision) => ({ itemId: String(index + 1), revision }))),
      );
      const [first, ...rest] = contracts;
      if (first === undefined) return yield* Effect.die("Expected at least one contract.");
      return yield* client.prepareBatch({
        session,
        documents: [first, ...rest],
        resumeId,
        template: {
          field: { kind: "existing", name: "assinatura-contratante" },
          appearance: { kind: "visible" },
          policy: "cades",
        },
      });
    }),
  );
});
export const reviewedSelection = (items: ReadonlyArray<BatchItem>) => {
  const [first, ...rest] = items.flatMap(({ itemId, preparation }) =>
    preparation === undefined ? [] : [{ itemId, preparationId: preparation.preparationId }],
  );
  return first === undefined
    ? Effect.die("Expected at least one reviewed item.")
    : Effect.succeed([first, ...rest] satisfies BatchSelection);
};
export const collectSpans = Effect.gen(function* () {
  const client = yield* LocalClient;
  const telemetry = yield* LocalTelemetry;
  yield* client.collectTelemetry();
  return (yield* telemetry.drain).spans;
});

export const openBatchPage = (resumeId: string, count: number) => {
  const runtime = ManagedRuntime.make(
    localClientLayer(createWorker).pipe(Layer.provideMerge(batchTelemetry)),
  );
  return {
    warm: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const client = yield* LocalClient;
          const warm = yield* client.composePdf({ document: contractTemplate() });
          yield* client.releaseDocument(warm.handle);
          const session = yield* beginSession;
          return { sessionId: session.sessionId, generation: session.generation };
        }),
      ),
    prepare: (session: A1SessionBinding) =>
      runtime.runPromise(prepareContracts(count, session, resumeId)),
    rejected: (session: A1SessionBinding) =>
      runtime.runPromise(
        Effect.flip(prepareContracts(count, session, resumeId)).pipe(
          Effect.map(({ code }) => code),
        ),
      ),
    signUntilFirstReceipt: (items: ReadonlyArray<BatchItem>) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const client = yield* LocalClient;
          yield* client.confirmBatch(resumeId, yield* reviewedSelection(items));
          const first = yield* client.batchEvents(resumeId).pipe(
            Stream.filterMap((event) => {
              const item =
                event._tag === "snapshot"
                  ? event.snapshot.items.find(({ state }) => state === "signed")
                  : event._tag === "itemStateChanged" && event.item.state === "signed"
                    ? event.item
                    : undefined;
              return item?.receipt === undefined
                ? Result.failVoid
                : Result.succeed({
                    itemId: item.itemId,
                    receiptId: item.receipt.receiptId,
                  });
            }),
            Stream.runHead,
          );
          return Option.getOrNull(first);
        }),
      ),
    finish: (items: ReadonlyArray<BatchItem>) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const client = yield* LocalClient;
          yield* client.confirmBatch(resumeId, yield* reviewedSelection(items));
          yield* client.batchEvents(resumeId).pipe(Stream.runDrain);
          const snapshot = yield* client.batchSnapshot(resumeId);
          const spans = yield* collectSpans;
          const signs = spans.filter(({ name }) => name === "local.a1.sign").length;
          return { snapshot, signs };
        }),
      ),
    release: () =>
      runtime.runPromise(Effect.flatMap(LocalClient, (client) => client.releaseBatch(resumeId))),
    remove: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const client = yield* LocalClient;
          yield* client.releaseBatch(resumeId);
          yield* client.deleteBatch(resumeId);
        }),
      ),
    dispose: () => runtime.dispose(),
  };
};
