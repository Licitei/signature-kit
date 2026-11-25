import { Duration, Effect, Layer, Schema } from "effect";
import { expect, inject, it } from "vitest";
import { commands } from "vitest/browser";
import { LocalClient, localClientLayer } from "../src/client.js";
import { LocalTelemetry } from "@signature-kit/engine/rpc";
import { localTelemetryLayer, summarizeTelemetry } from "@signature-kit/engine/telemetry";
import { localTelemetryOtlpLayer } from "../src/telemetry-otlp.js";
import { paintPage } from "../src/viewer.js";
import { createPages } from "../../../tooling/testing/fixtures/local/pdf.js";

const createWorker = () =>
  new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" });
const createTelemetryWorker = () =>
  new Worker(new URL("../src/worker-telemetry.ts", import.meta.url), { type: "module" });
const clientWithTelemetry = localClientLayer(createTelemetryWorker).pipe(
  Layer.provideMerge(localTelemetryLayer()),
);
const offline = Effect.acquireRelease(
  Effect.promise(() => commands.blockLocalRuntimeNetwork(true)),
  () => Effect.promise(() => commands.blockLocalRuntimeNetwork(false)),
);
const collectorPayload = (endpoint: string) =>
  Effect.promise(async () => (await fetch(endpoint)).text());

const OtlpResponse = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                traceId: Schema.String,
                spanId: Schema.String,
                parentSpanId: Schema.optional(Schema.String),
                attributes: Schema.Array(Schema.Struct({ key: Schema.String })),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);

it("propagates a single trace through offline Chromium and exports the sanitized batch over OTLP", async () => {
  const endpoint = `${inject("localTelemetryCollectorOrigin")}/telemetry-test`;
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* LocalClient;
      const telemetry = yield* LocalTelemetry;
      yield* telemetry.drain;
      yield* client.collectTelemetry();
      yield* telemetry.drain;

      yield* Effect.acquireRelease(
        Effect.promise(() => commands.trackLocalRuntimeRequests("start")),
        () => Effect.promise(() => commands.trackLocalRuntimeRequests("stop")),
      );
      const batch = yield* Effect.gen(function* () {
        yield* offline;
        const { handle } = yield* client.openDocument(createPages(1));
        const canvas = document.createElement("canvas");
        yield* paintPage(canvas, { handle, pageIndex: 0, scale: 1 }).pipe(
          Effect.withSpan("local.viewer.paintPage", {
            attributes: { filename: "restricted.pdf", holderKind: "111.444.777-35" },
          }),
        );
        yield* client.collectTelemetry();
        const urls = yield* Effect.promise(() => commands.trackLocalRuntimeRequests("read"));
        expect(urls).toEqual([]);
        return yield* telemetry.snapshot;
      }).pipe(Effect.scoped);

      const pageSpan = batch.spans.find(({ name }) => name === "local.viewer.paintPage");
      const rpc = batch.spans.find(({ name }) => name === "local.client.PdfRenderPage");
      const worker = batch.spans.find(({ name }) => name === "local.worker.PdfRenderPage");
      const engine = batch.spans.find(({ name }) => name === "local.pdf.renderPage");
      expect(pageSpan).toBeDefined();
      expect(rpc).toMatchObject({ traceId: pageSpan?.traceId, parentSpanId: pageSpan?.spanId });
      expect(worker).toMatchObject({ traceId: rpc?.traceId, parentSpanId: rpc?.spanId });
      expect(engine).toMatchObject({ traceId: worker?.traceId, parentSpanId: worker?.spanId });
      expect(
        batch.spans.some(
          ({ name, traceId }) => name === "pdfCore.wasm.run" && traceId === rpc?.traceId,
        ),
      ).toBe(true);
      const summary = summarizeTelemetry(batch.spans);
      expect(summary.get("PdfRenderPage")).toMatchObject({ success: 1, matchedRoundTrips: 1 });
      expect(summary.get("PdfRenderPage")?.wasmMs).toBeGreaterThan(0);
      expect(summary.get("PdfRenderPage")?.bytesToWasm).toBeGreaterThan(0);
      expect(summary.get("PdfRenderPage")?.bytesFromWasm).toBeGreaterThan(0);
      expect(summary.get("DocumentsOpen")?.cryptoMs).toBeGreaterThan(0);

      expect(yield* collectorPayload(endpoint)).toBe("null");
      yield* Layer.build(localTelemetryOtlpLayer(endpoint));
      const payload = yield* Effect.promise(() =>
        expect.poll(async () => (await fetch(endpoint)).text()).not.toBe("null"),
      ).pipe(Effect.andThen(collectorPayload(endpoint)));
      const { resourceSpans } = yield* Schema.decodeUnknownEffect(OtlpResponse)(payload);
      const received = resourceSpans.flatMap(({ scopeSpans }) =>
        scopeSpans.flatMap(({ spans }) => spans),
      );
      expect(received.find(({ name }) => name === "local.worker.PdfRenderPage")).toMatchObject({
        traceId: rpc?.traceId,
        parentSpanId: rpc?.spanId,
      });
      const exported = new Map(batch.spans.map((span) => [span.spanId, span]));
      for (const span of received) {
        const original = exported.get(span.spanId);
        expect(original).toBeDefined();
        expect(span.attributes.map(({ key }) => key)).toEqual(
          original?.attributes.map(([key]) => key),
        );
      }
      expect(payload).not.toContain("restricted.pdf");
      expect(payload).not.toContain("111.444.777-35");
    }).pipe(Effect.provide(clientWithTelemetry), Effect.scoped),
  );
}, 30_000);

it("measures DocumentsOpen and warm viewer paint with telemetry off, buffered and exported", async () => {
  const endpoint = `${inject("localTelemetryCollectorOrigin")}/telemetry-bench`;
  const source = createPages(20);
  const samples = 120;
  const modes = [
    { name: "off", layer: localClientLayer(createWorker) },
    { name: "buffer", layer: clientWithTelemetry },
    {
      name: "otlp",
      layer: localTelemetryOtlpLayer(endpoint, { interval: Duration.millis(15) }).pipe(
        Layer.provideMerge(clientWithTelemetry),
      ),
    },
  ];
  for (const { name, layer } of modes) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* LocalClient;
        const { handle } = yield* client.openDocument(source);
        const canvas = document.createElement("canvas");
        const paint = paintPage(canvas, { handle, pageIndex: 0, scale: 1 });
        const openTimings: number[] = [];
        const renderTimings: number[] = [];
        for (let index = -20; index < samples; index += 1) {
          const openStart = performance.now();
          const document = yield* client.openDocument(source);
          const openDuration = performance.now() - openStart;
          yield* client.releaseDocument(document.handle);
          const renderStart = performance.now();
          yield* paint;
          const renderDuration = performance.now() - renderStart;
          if (index >= 0) {
            openTimings.push(openDuration);
            renderTimings.push(renderDuration);
          }
        }
        const percentiles = (timings: number[]) => {
          timings.sort((a, b) => a - b);
          return {
            p50: timings[Math.floor(timings.length * 0.5)],
            p95: timings[Math.floor(timings.length * 0.95)],
          };
        };
        console.info(
          JSON.stringify({
            mode: name,
            samples,
            documentsOpenMs: percentiles(openTimings),
            viewerPaintMs: percentiles(renderTimings),
          }),
        );
        if (name === "otlp") {
          yield* Effect.promise(() =>
            expect.poll(async () => (await fetch(endpoint)).text()).not.toBe("null"),
          );
        }
      }).pipe(Effect.provide(layer)),
    );
  }
}, 60_000);
