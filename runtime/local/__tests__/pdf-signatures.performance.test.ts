import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { pdfCoreFileLayer } from "@signature-kit/pdf-core/file";
import { Effect, Layer, Redacted } from "effect";
import { readFile } from "node:fs/promises";
import { recordSpans } from "../../../tooling/testing/tracing.ts";
import { A1Sessions, Documents, localRuntimeLayer, pdfEngineLayer } from "../src/engine.js";
import { PdfSignatures, pdfSignaturesLayer } from "../src/pdf-signatures.js";
import { LocalTelemetry, localTelemetryLayer } from "../src/telemetry.js";
import { medianSigningTime, signingCorpus, signingOptions } from "./pdf-signing-benchmark.js";

const layer = pdfSignaturesLayer.pipe(
  Layer.provideMerge(pdfEngineLayer),
  Layer.provideMerge(localRuntimeLayer()),
  Layer.provideMerge(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provideMerge(localTelemetryLayer()),
);

it.live(
  "measures warm-session prepare and self-verifying confirm on the 1.x corpus",
  () =>
    Effect.gen(function* () {
      const documents = yield* Documents;
      const a1 = yield* A1Sessions;
      const signatures = yield* PdfSignatures;
      const telemetry = yield* LocalTelemetry;
      const pfx = yield* Effect.promise(
        async () => new Uint8Array(await readFile(new URL("./fixtures/ecpf.p12", import.meta.url))),
      );
      const session = yield* a1.open({
        pfx: Redacted.make(pfx),
        password: Redacted.make("changeit"),
      });

      for (const { name, pdf } of signingCorpus) {
        const bytes = yield* pdf;
        const source = yield* documents.open(bytes);
        const sign = Effect.gen(function* () {
          const started = performance.now();
          const preparation = yield* signatures.prepare(source, signingOptions(session));
          const receipt = yield* signatures.confirm(preparation.preparationId);
          const milliseconds = performance.now() - started;
          yield* signatures.release(preparation.preparationId);
          yield* documents.release(preparation.previewRevision.handle);
          yield* documents.release(receipt.signedRevision.handle);
          return milliseconds;
        });
        const medianMs = yield* medianSigningTime(sign.pipe(Effect.withTracerEnabled(false)));
        yield* telemetry.drain;

        const { exit, spans } = yield* recordSpans(sign);
        yield* exit;
        const steps = spans
          .filter(({ name }) =>
            /^(local\.(pdf|crypto|a1\.sign|documents\.open)|pdfCore\.wasm\.)/.test(name),
          )
          .map(({ name, duration, attributes }) => ({
            name,
            ms: Number((duration[0] * 1000 + duration[1] / 1_000_000).toFixed(3)),
            operation: attributes["signature_kit.pdf_core.operation"],
            bytes:
              attributes["signature_kit.wasm.input_bytes"] ??
              attributes["signature_kit.wasm.output_bytes"] ??
              attributes["signature_kit.wasm.result_bytes"] ??
              attributes.byteLength,
          }));
        expect(steps.filter(({ name }) => name === "pdfCore.wasm.copyIn")).toHaveLength(5);
        expect(steps.filter(({ name }) => name === "pdfCore.wasm.copyOut")).toHaveLength(3);
        console.info(
          JSON.stringify({
            runtime: "node",
            corpus: name,
            bytes: bytes.byteLength,
            medianMs,
            steps,
          }),
        );
        yield* documents.release(source.handle);
      }
    }).pipe(Effect.provide(layer)),
  120_000,
);
