import { pdfCoreBrowserLayer } from "@signature-kit/engine/wasm/browser";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { expect, it } from "vitest";
import { LocalClient, localClientLayer } from "../src/client.js";
import { PdfCore } from "@signature-kit/engine/wasm/pdf-core";
import { LocalTelemetry, TelemetryBatch } from "@signature-kit/engine/rpc";
import { localTelemetryLayer } from "@signature-kit/engine/telemetry";
import ecpfUrl from "../../../tooling/testing/fixtures/local/ecpf.p12?inline";
import {
  medianSigningTime,
  signingCorpus,
  signingOptions,
} from "../../../tooling/testing/pdf-signing-benchmark.js";

const encodeBatch = Schema.encodeEffect(TelemetryBatch);

const createWorker = () =>
  new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" });
const createTelemetryWorker = () =>
  new Worker(new URL("../src/worker-telemetry.ts", import.meta.url), { type: "module" });

it("measures warm-session signing through the Chromium worker on the 1.x corpus", async () => {
  const benchmark = Effect.gen(function* () {
    const client = yield* LocalClient;
    const telemetry = Option.getOrUndefined(yield* Effect.serviceOption(LocalTelemetry));
    const pfx = yield* Effect.promise(
      async () => new Uint8Array(await (await fetch(ecpfUrl)).arrayBuffer()),
    );
    const session = yield* client.openA1({
      pfx: Redacted.make(pfx),
      password: Redacted.make("changeit"),
    });

    for (const { name, pdf } of signingCorpus(yield* PdfCore)) {
      const bytes = yield* pdf;
      const openStarted = performance.now();
      const source = yield* client.openDocument(bytes);
      const openMs = performance.now() - openStarted;
      const sign = Effect.gen(function* () {
        const started = performance.now();
        const preparation = yield* client.preparePdf(source, signingOptions(session));
        const receipt = yield* client.confirmPdf(preparation.preparationId);
        const milliseconds = performance.now() - started;
        yield* client.releasePdf(preparation.preparationId);
        yield* client.releaseDocument(preparation.previewRevision.handle);
        yield* client.releaseDocument(receipt.signedRevision.handle);
        return milliseconds;
      });
      const timing = yield* medianSigningTime(sign);
      let copies;
      let telemetryProfile;
      if (telemetry !== undefined) {
        yield* client.collectTelemetry();
        yield* telemetry.drain;
        const signMs = yield* sign;
        const drainStarted = performance.now();
        yield* client.collectTelemetry();
        const collectMs = performance.now() - drainStarted;
        const pageDrainStarted = performance.now();
        const batch = yield* telemetry.drain;
        const drainMs = performance.now() - pageDrainStarted;
        const encodingStarted = performance.now();
        yield* encodeBatch(batch);
        const encodeMs = performance.now() - encodingStarted;
        const { spans, bytes: telemetryBytes } = batch;
        telemetryProfile = {
          signMs,
          collectMs,
          drainMs,
          encodeMs,
          spans: spans.length,
          attributes: spans.reduce((count, span) => count + span.attributes.length, 0),
          bytes: telemetryBytes,
        };
        copies = spans
          .filter(({ name }) => name === "pdfCore.wasm.copyIn" || name === "pdfCore.wasm.copyOut")
          .map(({ name, attributes }) => ({ name, attributes: Object.fromEntries(attributes) }));
        expect(copies.filter(({ name }) => name === "pdfCore.wasm.copyIn")).toHaveLength(2);
        expect(copies.filter(({ name }) => name === "pdfCore.wasm.copyOut")).toHaveLength(2);
        expect(spans.find(({ name }) => name === "local.pdf.prepare")?.attributes).toContainEqual([
          "policy",
          "cades",
        ]);
      }
      console.info(
        JSON.stringify({
          runtime: telemetry === undefined ? "chromium-worker" : "chromium-worker-telemetry",
          corpus: name,
          bytes: bytes.byteLength,
          ...timing,
          openMs,
          telemetryProfile,
          copies,
        }),
      );
      yield* client.releaseDocument(source.handle);
    }
  });
  await Effect.runPromise(
    benchmark.pipe(
      Effect.provide(localClientLayer(createWorker).pipe(Layer.provideMerge(pdfCoreBrowserLayer))),
    ),
  );
  await Effect.runPromise(
    benchmark.pipe(
      Effect.provide(
        localClientLayer(createTelemetryWorker).pipe(
          Layer.provideMerge(localTelemetryLayer()),
          Layer.provideMerge(pdfCoreBrowserLayer),
        ),
      ),
    ),
  );
}, 120_000);
