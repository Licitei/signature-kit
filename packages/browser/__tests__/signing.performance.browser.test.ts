import { Context, Duration, Effect, Fiber, Layer, Redacted, Schedule, Stream } from "effect";
import { commands } from "vitest/browser";
import { expect, inject, it } from "vitest";
import { LocalTelemetry } from "@signature-kit/engine/rpc";
import type {
  A1SessionBinding,
  BatchSelection,
  PdfPrepareOptions,
  TelemetrySpan,
} from "@signature-kit/engine/rpc";
import { contractTemplate } from "@signature-kit/engine/templates";
import { pdfCoreBrowserLayer } from "@signature-kit/engine/wasm/browser";
import { PdfCore } from "@signature-kit/engine/wasm/pdf-core";
import ecpf from "../../../tooling/testing/fixtures/local/ecpf.p12?inline";
import { signingCorpus } from "../../../tooling/testing/pdf-signing-benchmark.js";
import { LocalClient, localClientLayer } from "../src/client.js";
import { batchTelemetry } from "./batch-page.js";

const poolSize = inject("benchmarkWorkers");
const plainWorker = (workers: number) => () =>
  new Worker(new URL("./signing-benchmark.worker.ts", import.meta.url), {
    type: "module",
    name: String(workers),
  });
const bundledWorker = () => new Worker(inject("bundledWorkerUrl"), { type: "module" });
const bundledSigningWorker = () =>
  new Worker(inject("bundledSigningWorkerUrl"), { type: "module" });
const tracedWorker = () =>
  new Worker(new URL("./batch-benchmark.worker.ts", import.meta.url), {
    type: "module",
    name: String(poolSize),
  });

const nearest = (values: ReadonlyArray<number>, p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
};
const round = (value: number) => Math.round(value * 100) / 100;
const summary = (values: ReadonlyArray<number>) => ({
  p50: round(nearest(values, 0.5)),
  p95: round(nearest(values, 0.95)),
  n: values.length,
});
const summarize = (rows: ReadonlyArray<Record<string, number>>) => {
  const [first] = rows;
  if (first === undefined) return {};
  return Object.fromEntries(
    Object.keys(first).map((key) => [key, summary(rows.map((row) => row[key] ?? 0))]),
  );
};

const spanMs = ({ startTime, endTime }: TelemetrySpan) =>
  Number(BigInt(endTime) - BigInt(startTime)) / 1_000_000;
const trace = (spans: ReadonlyArray<TelemetrySpan>, root: string) => {
  const found = spans.find(({ name }) => name === root);
  return found === undefined ? [] : spans.filter(({ traceId }) => traceId === found.traceId);
};
const total = (spans: ReadonlyArray<TelemetrySpan>, name: string) =>
  spans.filter((span) => span.name === name).reduce((sum, span) => sum + spanMs(span), 0);
const attribute = (spans: ReadonlyArray<TelemetrySpan>, name: string, key: string) =>
  spans
    .filter((span) => span.name === name)
    .flatMap(({ attributes }) => attributes)
    .reduce(
      (sum, [entry, value]) => (entry === key && typeof value === "number" ? sum + value : sum),
      0,
    );

const signingStages = (spans: ReadonlyArray<TelemetrySpan>, byteLength: number) => {
  const prepare = trace(spans, "local.worker.PdfPrepare");
  const confirm = trace(spans, "local.worker.PdfConfirm");
  const prepareMs = total(prepare, "local.worker.PdfPrepare");
  const confirmMs = total(confirm, "local.worker.PdfConfirm");
  const stages = {
    transferIn:
      total(spans, "local.client.DocumentsOpen") - total(spans, "local.worker.DocumentsOpen"),
    documentOpen: total(spans, "local.documents.open"),
    pdfOpen: total(prepare, "pdfCore.openSigningDocument"),
    fieldResolve: total(prepare, "pdfCore.signatureFields"),
    apAndIncrementalWrite: total(prepare, "pdfCore.prepareSignature"),
    byteRangeDigest: total(prepare, "local.crypto.digest"),
    cmsBuild: total(confirm, "local.pdf.cms") - total(confirm, "local.a1.sign"),
    webCryptoSign: total(confirm, "local.crypto.sign"),
    cmsEmbed: total(confirm, "local.pdf.embed"),
    selfVerify:
      total(confirm, "local.pdf.selfVerify") + total(confirm, "pdfCore.openSigningDocument"),
    transferOut:
      total(spans, "local.client.DocumentsExport") - total(spans, "local.worker.DocumentsExport"),
    exportCopy: total(spans, "local.documents.export"),
    prepareRpc: total(prepare, "local.client.PdfPrepare") - prepareMs,
    confirmRpc: total(confirm, "local.client.PdfConfirm") - confirmMs,
  };
  return {
    ...stages,
    prepareOther:
      prepareMs -
      stages.pdfOpen -
      stages.fieldResolve -
      stages.apAndIncrementalWrite -
      stages.byteRangeDigest,
    receiptOther:
      confirmMs - stages.cmsBuild - stages.webCryptoSign - stages.cmsEmbed - stages.selfVerify,
    prepare: prepareMs,
    confirm: confirmMs,
    confirmWithoutSign: confirmMs - stages.webCryptoSign,
    wasmCopiesPerSignature:
      (attribute(prepare, "pdfCore.wasm.copyIn", "signature_kit.wasm.input_bytes") +
        attribute(confirm, "pdfCore.wasm.copyIn", "signature_kit.wasm.input_bytes")) /
      byteLength,
  };
};

const pfxBytes = Effect.promise(
  async () => new Uint8Array(await (await fetch(ecpf)).arrayBuffer()),
);
const openSession = Effect.gen(function* () {
  const client = yield* LocalClient;
  return yield* client.openA1({
    pfx: Redacted.make(yield* pfxBytes),
    password: Redacted.make("changeit"),
  });
});
const blockNetwork = Effect.acquireRelease(
  Effect.promise(() => commands.blockLocalRuntimeNetwork(true)),
  () => Effect.promise(() => commands.blockLocalRuntimeNetwork(false)),
);
const memorySampler = Effect.gen(function* () {
  const peak = { pageHeapBytes: 0, workerHeapBytes: 0, workerBackingBytes: 0, workers: 0 };
  const sample = Effect.promise(() => commands.sampleRuntimeMemory()).pipe(
    Effect.tap((memory) =>
      Effect.sync(() => {
        peak.pageHeapBytes = Math.max(peak.pageHeapBytes, memory.pageHeapBytes);
        peak.workerHeapBytes = Math.max(peak.workerHeapBytes, memory.workerHeapBytes);
        peak.workerBackingBytes = Math.max(peak.workerBackingBytes, memory.workerBackingBytes);
        peak.workers = Math.max(peak.workers, memory.workers);
      }),
    ),
  );
  const fiber = yield* sample.pipe(Effect.repeat(Schedule.spaced("20 millis")), Effect.forkScoped);
  return {
    stop: Effect.gen(function* () {
      yield* Fiber.interrupt(fiber);
      yield* sample;
      return { ...peak };
    }),
  };
});

const now = Effect.sync(() => performance.now());
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = yield* now;
    const value = yield* effect;
    return { value, ms: (yield* now) - started };
  });

type Fixture = {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly options: (session: A1SessionBinding) => PdfPrepareOptions;
  readonly warmups: number;
  readonly samples: number;
};

const contractOptions = (session: A1SessionBinding): PdfPrepareOptions => ({
  session,
  field: { kind: "existing", name: "assinatura-contratante" },
  appearance: { kind: "visible" },
  policy: "cades",
});

const fixtures = Effect.gen(function* () {
  const client = yield* LocalClient;
  const composed = yield* Effect.forEach(
    [
      { name: "contract-1p", pages: 1 },
      { name: "contract-10p", pages: 10 },
      { name: "report-100p", pages: 100 },
    ],
    ({ name, pages }) =>
      Effect.gen(function* () {
        const revision = yield* client.composePdf({ document: contractTemplate(pages) });
        const bytes = yield* client.exportDocument(revision.handle);
        yield* client.releaseDocument(revision.handle);
        return { name, bytes, options: contractOptions, warmups: 3, samples: 21 } satisfies Fixture;
      }),
  );
  const large = yield* Effect.gen(function* () {
    const core = yield* PdfCore;
    const entry = signingCorpus(core).find(({ name }) => name === "synthetic-21mib");
    if (entry === undefined) return yield* Effect.die("Missing the 21 MiB corpus entry.");
    return yield* entry.pdf;
  }).pipe(Effect.provide(pdfCoreBrowserLayer), Effect.orDie);
  return [
    ...composed,
    {
      name: "synthetic-21mib",
      bytes: large,
      options: (session: A1SessionBinding): PdfPrepareOptions => ({
        session,
        field: { kind: "create", name: "Approval", page: 0, rect: [32, 28, 248, 72] },
        appearance: { kind: "visible", lines: ["Signed locally"] },
        policy: "cades",
      }),
      warmups: 2,
      samples: 11,
    },
  ] satisfies ReadonlyArray<Fixture>;
});

const signOnce = (fixture: Fixture, session: A1SessionBinding) =>
  Effect.gen(function* () {
    const client = yield* LocalClient;
    const { value: source, ms: openMs } = yield* timed(client.openDocument(fixture.bytes));
    const { value: preparation, ms: prepareMs } = yield* timed(
      client.preparePdf(source, fixture.options(session)),
    );
    const { value: receipt, ms: confirmMs } = yield* timed(
      client.confirmPdf(preparation.preparationId),
    );
    const { value: signed, ms: exportMs } = yield* timed(
      client.exportDocument(receipt.signedRevision.handle),
    );
    expect(signed.byteLength).toBe(receipt.signedRevision.byteLength);
    yield* client.releasePdf(preparation.preparationId);
    yield* client.releaseDocument(preparation.previewRevision.handle);
    yield* client.releaseDocument(receipt.signedRevision.handle);
    yield* client.releaseDocument(source.handle);
    return {
      openMs,
      prepareMs,
      confirmMs,
      exportMs,
      totalMs: openMs + prepareMs + confirmMs + exportMs,
    };
  });

const collectSpans = Effect.gen(function* () {
  const client = yield* LocalClient;
  const telemetry = yield* LocalTelemetry;
  yield* client.collectTelemetry();
  return (yield* telemetry.drain).spans;
});

const buildClient = <E>(layer: Layer.Layer<LocalClient, E>) =>
  Layer.build(layer).pipe(Effect.map((context) => Context.get(context, LocalClient)));

const helperMemory = Effect.promise(() => commands.sampleRuntimeMemory()).pipe(
  Effect.map(({ perWorker }) => {
    const bundled = perWorker.filter(({ url }) => url.includes("worker-bundle"));
    const helpers = bundled.filter(({ url }) => url.includes("signing-helper"));
    const runtime = bundled.filter(({ url }) => !url.includes("signing-helper"));
    const mean = (rows: typeof perWorker, key: "heapBytes" | "backingBytes") =>
      rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
    return {
      signingHelpers: helpers.length,
      helperHeapBytes: mean(helpers, "heapBytes"),
      helperBackingBytes: mean(helpers, "backingBytes"),
      runtimeHeapBytes: mean(runtime, "heapBytes"),
      runtimeBackingBytes: mean(runtime, "backingBytes"),
    };
  }),
);

const coldPlain = (fixture: Fixture, createWorker: () => Worker, prewarm = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { value: client, ms: bootMs } = yield* timed(
        buildClient(localClientLayer(createWorker)),
      );
      return yield* Effect.gen(function* () {
        const { ms: prewarmMs } = yield* timed(prewarm ? client.prewarm() : Effect.void);
        const memory = prewarm ? yield* helperMemory : {};
        yield* blockNetwork;
        const { value: session, ms: a1OpenMs } = yield* timed(openSession);
        const signing = yield* signOnce(fixture, session);
        return {
          bootMs,
          ...(prewarm ? { prewarmMs } : {}),
          ...memory,
          a1OpenMs,
          ...signing,
          firstSignatureMs: bootMs + prewarmMs + a1OpenMs + signing.totalMs,
          afterBootMs: a1OpenMs + signing.totalMs,
        };
      }).pipe(Effect.provideService(LocalClient, client));
    }),
  );

const coldTraced = (fixture: Fixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        localClientLayer(tracedWorker).pipe(Layer.provideMerge(batchTelemetry)),
      );
      return yield* Effect.gen(function* () {
        yield* blockNetwork;
        yield* signOnce(fixture, yield* openSession);
        const spans = yield* collectSpans;
        return {
          wasmCompile: total(spans, "pdfCore.wasm.compile"),
          wasmInstantiate: total(spans, "pdfCore.wasm.instantiate"),
          a1Open: total(spans, "local.worker.A1Open"),
          pkcs12Parse: total(spans, "local.a1.parsePkcs12"),
          keyImport: total(spans, "local.crypto.importKey"),
          ...signingStages(spans, fixture.bytes.byteLength),
        };
      }).pipe(Effect.provide(context));
    }),
  );

const batchRun = (count: number, session: A1SessionBinding) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* LocalClient;
      const documents = yield* Effect.forEach(
        Array.from({ length: count }, (_, index) => index),
        (index) =>
          Effect.acquireRelease(
            client.composePdf({ document: contractTemplate(2 + (index % 2)) }),
            (revision) => client.releaseDocument(revision.handle).pipe(Effect.ignore),
          ).pipe(Effect.map((revision) => ({ itemId: String(index + 1), revision }))),
      );
      const [first, ...rest] = documents;
      if (first === undefined) return yield* Effect.die("Expected at least one document.");
      const memory = yield* memorySampler;
      const { value: reviewed, ms: prepareMs } = yield* timed(
        client.prepareBatch({
          session,
          documents: [first, ...rest],
          template: {
            field: { kind: "existing", name: "assinatura-contratante" },
            appearance: { kind: "visible" },
            policy: "cades",
          },
        }),
      );
      const [selectedFirst, ...selectedRest] = reviewed.items.flatMap(({ itemId, preparation }) =>
        preparation === undefined ? [] : [{ itemId, preparationId: preparation.preparationId }],
      );
      if (selectedFirst === undefined) {
        return yield* Effect.die(
          `Expected reviewed items: ${JSON.stringify(reviewed.items.slice(0, 3))}`,
        );
      }
      const selection: BatchSelection = [selectedFirst, ...selectedRest];
      const signStarted = yield* now;
      yield* client.confirmBatch(reviewed.batchId, selection);
      yield* client.batchEvents(reviewed.batchId).pipe(Stream.runDrain);
      const completed = yield* client.batchSnapshot(reviewed.batchId);
      const signMs = (yield* now) - signStarted;
      const peaks = yield* memory.stop;
      if (completed.progress.signed !== count) {
        return yield* Effect.die(
          `Expected ${count} signed items: ${JSON.stringify(completed.items.slice(0, 2))}`,
        );
      }
      const valid = yield* Effect.forEach(completed.items.slice(0, 3), ({ receipt }) =>
        receipt === undefined
          ? Effect.succeed(false)
          : client
              .verifyPdf(receipt.signedRevision)
              .pipe(Effect.map(({ signatures }) => signatures[0]?.integrity === "valid")),
      );
      expect(valid.every(Boolean)).toBe(true);
      yield* client.releaseBatch(reviewed.batchId);
      return {
        prepareMs,
        signMs,
        totalMs: prepareMs + signMs,
        budgetPeakBytes: completed.progress.peakBytes,
        ...peaks,
      };
    }),
  );

it("measures cold and warm single signatures and batches in a Chromium worker", async () => {
  const program = Effect.gen(function* () {
    const client = yield* LocalClient;
    const corpus = yield* fixtures;
    const [contract] = corpus;
    if (contract === undefined) return yield* Effect.die("Expected the contract fixture.");

    const cold = yield* Effect.forEach(Array.from({ length: 7 }), () =>
      coldPlain(contract, plainWorker(poolSize)),
    );
    const coldBundled = yield* Effect.forEach(Array.from({ length: 7 }), () =>
      coldPlain(contract, bundledWorker),
    );
    const coldPrewarmed = yield* Effect.forEach(Array.from({ length: 7 }), () =>
      coldPlain(contract, bundledWorker, true),
    );
    const coldSigning = yield* Effect.forEach(Array.from({ length: 7 }), () =>
      coldPlain(contract, bundledSigningWorker),
    );
    const coldStages = yield* Effect.forEach(Array.from({ length: 3 }), () => coldTraced(contract));

    yield* client.prewarm();
    yield* blockNetwork;
    const session = yield* openSession;
    const warm = yield* Effect.forEach(corpus, (fixture) =>
      Effect.gen(function* () {
        for (let index = 0; index < fixture.warmups; index += 1) yield* signOnce(fixture, session);
        const samples = yield* Effect.forEach(Array.from({ length: fixture.samples }), () =>
          signOnce(fixture, session),
        );
        return { fixture: fixture.name, bytes: fixture.bytes.byteLength, ...summarize(samples) };
      }),
    );

    const batches = [];
    yield* batchRun(10, session);
    for (const { count, trials } of [
      { count: 10, trials: 5 },
      { count: 50, trials: 5 },
      { count: 200, trials: 3 },
    ]) {
      const runs = yield* Effect.forEach(Array.from({ length: trials }), () =>
        batchRun(count, session),
      );
      batches.push({
        documents: count,
        prepareMs: summary(runs.map(({ prepareMs }) => prepareMs)),
        signMs: summary(runs.map(({ signMs }) => signMs)),
        totalMs: summary(runs.map(({ totalMs }) => totalMs)),
        budgetPeakBytes: Math.max(...runs.map(({ budgetPeakBytes }) => budgetPeakBytes)),
        pageHeapPeakBytes: Math.max(...runs.map(({ pageHeapBytes }) => pageHeapBytes)),
        workerHeapPeakBytes: Math.max(...runs.map(({ workerHeapBytes }) => workerHeapBytes)),
        workerBackingPeakBytes: Math.max(
          ...runs.map(({ workerBackingBytes }) => workerBackingBytes),
        ),
        workers: Math.max(...runs.map(({ workers }) => workers)),
      });
    }
    yield* client.closeA1();
    return {
      cold: summarize(cold),
      coldBundled: summarize(coldBundled),
      coldPrewarmed: summarize(coldPrewarmed),
      coldSigning: summarize(coldSigning),
      coldStages: summarize(coldStages),
      warm,
      batches,
    };
  });

  const traced = Effect.gen(function* () {
    const client = yield* LocalClient;
    const corpus = yield* fixtures;
    yield* client.prewarm();
    yield* blockNetwork;
    const session = yield* openSession;
    yield* collectSpans;
    return yield* Effect.forEach(corpus, (fixture) =>
      Effect.gen(function* () {
        for (let index = 0; index < fixture.warmups; index += 1) yield* signOnce(fixture, session);
        yield* collectSpans;
        const samples = yield* Effect.forEach(
          Array.from({ length: Math.min(fixture.samples, 11) }),
          () =>
            Effect.gen(function* () {
              const memory = yield* memorySampler;
              yield* signOnce(fixture, session);
              const peaks = yield* memory.stop;
              const stages = signingStages(yield* collectSpans, fixture.bytes.byteLength);
              return {
                ...stages,
                workerHeapBytes: peaks.workerHeapBytes,
                workerBackingBytes: peaks.workerBackingBytes,
              };
            }).pipe(Effect.scoped),
        );
        yield* client.collectTelemetry();
        return { fixture: fixture.name, bytes: fixture.bytes.byteLength, ...summarize(samples) };
      }),
    );
  });

  const scaling = Effect.forEach([0, 1, 2, 4, poolSize], (workers) =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openSession;
        yield* (yield* LocalClient).prewarm();
        yield* batchRun(10, session);
        yield* blockNetwork;
        const runs = yield* Effect.forEach([1, 2], () => batchRun(200, session));
        return {
          signingWorkers: workers,
          documents: 200,
          prepareMs: summary(runs.map(({ prepareMs }) => prepareMs)),
          signMs: summary(runs.map(({ signMs }) => signMs)),
          totalMs: summary(runs.map(({ totalMs }) => totalMs)),
          workerBackingPeakBytes: Math.max(
            ...runs.map(({ workerBackingBytes }) => workerBackingBytes),
          ),
        };
      }).pipe(
        Effect.provide(
          localClientLayer(plainWorker(workers), { requestTimeout: Duration.seconds(120) }),
        ),
      ),
    ),
  );

  const tracedBatches = Effect.gen(function* () {
    const session = yield* openSession;
    yield* batchRun(10, session);
    yield* (yield* LocalClient).prewarm();
    yield* blockNetwork;
    yield* collectSpans;
    return yield* Effect.forEach([10, 50, 200], (count) =>
      Effect.scoped(
        Effect.gen(function* () {
          const spans: TelemetrySpan[] = [];
          let droppedSpans = 0;
          const client = yield* LocalClient;
          const telemetry = yield* LocalTelemetry;
          const gather = client.collectTelemetry().pipe(
            Effect.andThen(telemetry.drain),
            Effect.tap((batch) =>
              Effect.sync(() => {
                spans.push(...batch.spans);
                droppedSpans += batch.droppedSpans;
              }),
            ),
          );
          let stopped = false;
          const fiber = yield* gather.pipe(
            Effect.andThen(Effect.sleep("25 millis")),
            Effect.repeat({ while: () => !stopped }),
            Effect.forkScoped,
          );
          yield* batchRun(count, session);
          stopped = true;
          yield* Fiber.join(fiber);
          yield* gather;
          const durations = (name: string) =>
            spans.filter((span) => span.name === name).map(spanMs);
          const confirms = durations("local.batch.item.confirm");
          expect(confirms).toHaveLength(count);

          return {
            documents: count,
            itemPrepareMs: summary(durations("local.batch.item.prepare")),
            itemConfirmMs: summary(confirms),
            droppedSpans,
          };
        }),
      ),
    );
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const measured = yield* Effect.scoped(program).pipe(
        Effect.provide(
          localClientLayer(plainWorker(poolSize), { requestTimeout: Duration.seconds(120) }),
        ),
      );
      const stages = yield* Effect.scoped(traced).pipe(
        Effect.provide(
          localClientLayer(tracedWorker, { requestTimeout: Duration.seconds(120) }).pipe(
            Layer.provideMerge(batchTelemetry),
          ),
        ),
      );
      const batchItems = yield* Effect.scoped(tracedBatches).pipe(
        Effect.provide(
          localClientLayer(tracedWorker, { requestTimeout: Duration.seconds(120) }).pipe(
            Layer.provideMerge(batchTelemetry),
          ),
        ),
      );
      const poolScaling = yield* scaling;
      return {
        hardwareConcurrency: navigator.hardwareConcurrency,
        bundleSizes: JSON.parse(inject("bundleSizes")),
        signingWorkers: poolSize,
        poolScaling,
        ...measured,
        stages,
        batchItems,
      };
    }),
  );
  const json = JSON.stringify(result, null, 2);
  console.info(json);
  await commands.writeBenchmark("signing", json);

  const p50 = (value: unknown) =>
    typeof value === "object" && value !== null && "p50" in value && typeof value.p50 === "number"
      ? value.p50
      : Infinity;
  const warm = (fixture: string, metric: string) =>
    p50(
      new Map(Object.entries(result.warm.find((row) => row.fixture === fixture) ?? {})).get(metric),
    );
  const stage = (fixture: string, metric: string) =>
    p50(
      new Map(Object.entries(result.stages.find((row) => row.fixture === fixture) ?? {})).get(
        metric,
      ),
    );
  const batch = (documents: number) =>
    p50(result.batches.find((row) => row.documents === documents)?.totalMs);
  const gates = [
    { name: "contract-1p prepare", measured: warm("contract-1p", "prepareMs"), limit: 5 },
    { name: "contract-1p confirm", measured: warm("contract-1p", "confirmMs"), limit: 8 },
    {
      name: "contract-1p confirm without sign",
      measured: warm("contract-1p", "confirmMs") - stage("contract-1p", "webCryptoSign"),
      limit: 5,
    },
    { name: "report-100p total", measured: warm("report-100p", "totalMs"), limit: 25 },
    { name: "synthetic-21mib prepare", measured: warm("synthetic-21mib", "prepareMs"), limit: 140 },
    { name: "synthetic-21mib confirm", measured: warm("synthetic-21mib", "confirmMs"), limit: 12 },
    { name: "synthetic-21mib total", measured: warm("synthetic-21mib", "totalMs"), limit: 210 },
    { name: "batch of 50 total", measured: batch(50), limit: 250 },
    { name: "batch of 200 total", measured: batch(200), limit: 800 },
    {
      name: "cold bundled first signature",
      measured: p50(result.coldBundled["firstSignatureMs"]),
      limit: 600,
    },
    {
      name: "cold bundled signing-only first signature",
      measured: p50(result.coldSigning["firstSignatureMs"]),
      limit: 500,
    },
    { name: "bundled prewarm", measured: p50(result.coldPrewarmed["prewarmMs"]), limit: 500 },
    { name: "cold A1 open", measured: p50(result.cold["a1OpenMs"]), limit: 70 },
  ];
  for (const { name, measured, limit } of gates) {
    expect.soft(measured, name).toBeLessThanOrEqual(limit);
  }
}, 900_000);
