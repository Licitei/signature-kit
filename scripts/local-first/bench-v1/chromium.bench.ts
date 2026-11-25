import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import {
  pdfPageRendererLayer,
  pdfPageRendererWorkerLayer,
  renderPdfPagesBrowser,
} from "@signature-kit/pdf/render-browser";
import { foldkitBenchmarkSigningLayer } from "../../../apps/docs/foldkit/benchmark-signing-domain";
import { Effect, Layer, Schema, Tracer } from "effect";
import * as RpcTest from "effect/rpc/RpcTest";
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import {
  makeSigningBatch,
  makeSigningWorkerSession,
} from "../../../apps/docs/foldkit/signing-runtime";
import { A1WorkerRequests, a1WorkerHandlersLayer } from "../../../formats/react/dist/a1-worker.js";
import { makeA1WorkerSession } from "../../../formats/react/dist/a1-worker-client.js";
import { readA1FixtureFromBrowser } from "../../../tooling/testing/fixtures.browser";
import { pdfFixtures } from "./corpus";
import { makeRecorder, peak, statistics } from "./measure";
import { fixturePassword, pdfInput, runOperations } from "./operations";

const heapSchema = Schema.Struct({ usedJSHeapSize: Schema.Finite });
const pageHeap = (): Record<string, number> =>
  "memory" in performance
    ? Schema.is(heapSchema)(performance.memory)
      ? { usedJSHeapSize: performance.memory.usedJSHeapSize }
      : {}
    : {};

it("records SignatureKit v1 operations and real workers in Chromium", async () => {
  const method = "CDP Performance.getMetrics (page JS heap)";
  const { record, cases } = makeRecorder("chromium", method, commands.readV1Heap);
  const pdfs = Object.fromEntries(
    await Promise.all(
      Object.entries(pdfFixtures).map(async ([name, path]) => {
        const response = await fetch("/" + path);
        expect(response.ok).toBe(true);
        return [name, new Uint8Array(await response.arrayBuffer())];
      }),
    ),
  );
  const ecpf = await Effect.runPromise(readA1FixtureFromBrowser("ecpf"));
  const ecnpj = await Effect.runPromise(readA1FixtureFromBrowser("ecnpj"));
  const { copies, cores, unavailable } = await runOperations(
    record,
    pdfCoreBrowserLayer,
    { ecpf, ecnpj },
    pdfs,
    async (corpus) => {
      const response = await fetch("/.cache/bench-v1/corpus/" + corpus + ".xml");
      expect(response.ok).toBe(true);
      return response.text();
    },
  );
  const rendering = pdfPageRendererLayer.pipe(Layer.provide(pdfCoreBrowserLayer));
  const coreContext = await Effect.runPromise(Effect.scoped(Layer.build(rendering)));
  for (const { corpus, bytes, pages, pdf } of cores) {
    for (const [id, scale] of [
      ["pdf-core.render.thumbnail", 0.25],
      ["pdf-core.render.full-page", 1],
    ] satisfies Array<[string, number]>) {
      await record({ id, corpus, bytes, pages }, async () => {
        const images = await Effect.runPromise(
          renderPdfPagesBrowser(pdf, { pageIndexes: [0], scale }).pipe(
            Effect.provideContext(coreContext),
          ),
        );
        expect(images[0]?.image.size).toBeGreaterThan(0);
      });
    }
  }

  const seed = cores.find(({ corpus }) => corpus === "synthetic-1");
  expect(seed).toBeDefined();
  if (seed === undefined) return;
  const { pdf, corpus, bytes, pages } = seed;
  const entry = { corpus, bytes, pages };
  const input = pdfInput(pdf);
  const workerOptions = { pfx: ecpf, password: fixturePassword };

  await record(
    { id: "worker.a1.cold-first-dispose", corpus: "empty-session", bytes: 0, pages: null },
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeA1WorkerSession;
            yield* session.client.Dispose();
          }),
        ),
      ),
  );
  await record({ id: "worker.render.cold-first-thumbnail", ...entry }, () =>
    Effect.runPromise(
      renderPdfPagesBrowser(pdf, { pageIndexes: [0], scale: 0.25 }).pipe(
        Effect.provide(pdfPageRendererWorkerLayer()),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(pdfPageRendererWorkerLayer());
        const render = renderPdfPagesBrowser(pdf, { pageIndexes: [0], scale: 0.25 }).pipe(
          Effect.provideContext(context),
        );
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        yield* render;
        yield* Effect.promise(() =>
          record({ id: "worker.render.warm-thumbnail", ...entry }, () => run(render)),
        );
      }),
    ),
  );
  const payloads: Array<{
    requestPdfBytes: number;
    responsePdfBytes: number;
    requestBufferDetached: boolean;
  }> = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* makeA1WorkerSession;
        const context = yield* Effect.context<never>();
        const run = Effect.runPromiseWith(context);
        yield* session.client.Dispose();
        yield* Effect.promise(() =>
          record(
            { id: "worker.a1.rpc-dispose", corpus: "empty-session", bytes: 0, pages: null },
            () => run(session.client.Dispose()),
          ),
        );
        yield* Effect.promise(() =>
          record(
            { id: "worker.a1.initialize", corpus: "ecpf", bytes: ecpf.byteLength, pages: null },
            () => run(session.client.Initialize(workerOptions)),
          ),
        );
        const { generation } = yield* session.client.Initialize(workerOptions);
        yield* Effect.promise(() =>
          record({ id: "worker.a1.sign-rpc", ...entry }, async () => {
            const signed = await run(session.client.Sign({ generation, input }));
            payloads.push({
              requestPdfBytes: bytes,
              responsePdfBytes: signed.byteLength,
              requestBufferDetached: pdf.buffer.byteLength === 0,
            });
          }),
        );
      }),
    ),
  );

  expect(payloads.every(({ requestBufferDetached }) => !requestBufferDetached)).toBe(true);

  let pkcs12Parses = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(A1WorkerRequests);
        yield* client.Initialize(workerOptions);
      }),
    ).pipe(
      Effect.provide(a1WorkerHandlersLayer.pipe(Layer.provide(pdfCoreBrowserLayer))),
      Effect.withTracer(
        Tracer.make({
          span(options) {
            if (options.name === "crypto.pkcs12.parse") pkcs12Parses += 1;
            return new Tracer.NativeSpan(options);
          },
        }),
      ),
    ),
  );
  expect(pkcs12Parses).toBe(2);

  const batches = [];
  for (const size of [10, 50]) {
    const items: number[][] = [];
    let itemHeapPeak = pageHeap();
    const row = await record(
      {
        id: "foldkit.batch",
        corpus: `synthetic-1-x${size}`,
        bytes: bytes * size,
        pages: size,
        iterations: 5,
        warmups: 1,
      },
      async () => {
        const perItem: number[] = [];
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* makeSigningWorkerSession;
              const { generation } = yield* session.client.Initialize(workerOptions);
              const batch = yield* makeSigningBatch;
              const results = yield* batch.run({
                target: "benchmark",
                batchId: 1,
                generation,
                documents: Array.from({ length: size }, (_, index) => ({
                  id: String(index),
                  input,
                })),
                onState: () => {
                  itemHeapPeak = peak(itemHeapPeak, pageHeap());
                },
                sign: (request) =>
                  Effect.suspend(() => {
                    const start = performance.now();
                    return session.client.Sign(request).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          perItem.push(performance.now() - start);
                        }),
                      ),
                    );
                  }),
              });
              expect(results).toHaveLength(size);
              for (const { result } of results) expect(result._tag).toBe("Success");
            }),
          ).pipe(Effect.provide(foldkitBenchmarkSigningLayer)),
        );
        items.push(perItem);
      },
    );
    const itemSamples = items.slice(row.warmups).flat();
    batches.push({
      size,
      itemSamples,
      ...statistics(itemSamples),
      sampledPageHeapPeak: itemHeapPeak,
    });
  }
  await commands.writeV1Browser({
    cases,
    unavailable,
    copies,
    workers: {
      pkcs12Parses,
      payloads: payloads.slice(3),
      requestEncoding: "cloned",
      responseEncoding: "cloned",
    },
    batches,
  });
}, 360_000);
