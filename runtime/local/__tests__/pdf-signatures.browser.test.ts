import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { Effect, Layer, Redacted } from "effect";
import { expect, it } from "vitest";
import { LocalClient, localClientLayer } from "../src/client.js";
import { LocalTelemetry, localTelemetryLayer } from "../src/telemetry.js";
import ecpfUrl from "./fixtures/ecpf.p12?inline";
import { medianSigningTime, signingCorpus, signingOptions } from "./pdf-signing-benchmark.js";

const createWorker = () =>
  new Worker(new URL("../src/worker-telemetry.ts", import.meta.url), { type: "module" });

it("measures warm-session signing through the Chromium worker on the 1.x corpus", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* LocalClient;
      const telemetry = yield* LocalTelemetry;
      const pfx = yield* Effect.promise(
        async () => new Uint8Array(await (await fetch(ecpfUrl)).arrayBuffer()),
      );
      const session = yield* client.openA1({
        pfx: Redacted.make(pfx),
        password: Redacted.make("changeit"),
      });

      for (const { name, pdf } of signingCorpus) {
        const bytes = yield* pdf;
        const source = yield* client.openDocument(bytes);
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
        const medianMs = yield* medianSigningTime(sign);
        yield* client.collectTelemetry();
        yield* telemetry.drain;
        yield* sign;
        yield* client.collectTelemetry();
        const { spans } = yield* telemetry.drain;
        const copies = spans
          .filter(({ name }) => name === "pdfCore.wasm.copyIn" || name === "pdfCore.wasm.copyOut")
          .map(({ name, attributes }) => ({ name, attributes: Object.fromEntries(attributes) }));
        expect(copies.filter(({ name }) => name === "pdfCore.wasm.copyIn")).toHaveLength(5);
        expect(copies.filter(({ name }) => name === "pdfCore.wasm.copyOut")).toHaveLength(3);
        expect(spans.find(({ name }) => name === "local.pdf.prepare")?.attributes).toContainEqual([
          "policy",
          "cades",
        ]);
        console.info(
          JSON.stringify({
            runtime: "chromium-worker",
            corpus: name,
            bytes: bytes.byteLength,
            medianMs,
            copies,
          }),
        );
        yield* client.releaseDocument(source.handle);
      }
    }).pipe(
      Effect.provide(
        localClientLayer(createWorker).pipe(
          Layer.provideMerge(localTelemetryLayer()),
          Layer.provideMerge(pdfCoreBrowserLayer),
        ),
      ),
    ),
  );
}, 120_000);
