import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { pdfCoreFileLayer } from "@signature-kit/engine/wasm/file";
import { Effect, Layer, Redacted } from "effect";
import { readFile } from "node:fs/promises";
import { recordSpans } from "../../../tooling/testing/tracing.ts";
import { A1Sessions, Documents, localRuntimeLayer, pdfEngineLayer } from "../src/engine.js";
import { PdfSignatures, pdfSignaturesLayer } from "../src/pdf-signatures.js";
import { PdfCore } from "@signature-kit/engine/wasm/pdf-core";
import { LocalTelemetry } from "@signature-kit/engine/rpc";
import { localTelemetryLayer } from "@signature-kit/engine/telemetry";
import {
  medianSigningTime,
  signingCorpus,
  signingOptions,
} from "../../../tooling/testing/pdf-signing-benchmark.js";

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
        async () =>
          new Uint8Array(
            await readFile(
              new URL("../../../tooling/testing/fixtures/local/ecpf.p12", import.meta.url),
            ),
          ),
      );
      const core = yield* PdfCore;
      for (const enabled of [false, true]) {
        const session = yield* a1.open({
          pfx: Redacted.make(pfx),
          password: Redacted.make("changeit"),
        });
        const trace = Effect.withTracerEnabled(enabled);
        for (const { name, pdf } of signingCorpus(core)) {
          const bytes = yield* pdf;
          const openStarted = performance.now();
          const source = yield* documents.open(bytes).pipe(trace);
          const openMs = performance.now() - openStarted;
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
          const timing = yield* medianSigningTime(sign.pipe(trace));
          yield* telemetry.drain;

          const { exit, spans } = yield* recordSpans(sign);
          yield* exit;
          const { exit: coldExit, spans: coldSpans } = yield* recordSpans(
            Effect.gen(function* () {
              const tracedSource = yield* documents.open(bytes);
              const coldPreparation = yield* signatures.prepare(
                tracedSource,
                signingOptions(session),
              );
              return { tracedSource, coldPreparation };
            }),
          );
          const { tracedSource, coldPreparation } = yield* coldExit;
          yield* signatures.release(coldPreparation.preparationId);
          yield* documents.release(coldPreparation.previewRevision.handle);
          yield* documents.release(tracedSource.handle);

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
          expect(
            steps.filter(({ name }) => name === "pdfCore.wasm.copyIn").length,
          ).toBeLessThanOrEqual(2);
          expect(
            steps.filter(({ name }) => name === "pdfCore.wasm.copyOut").length,
          ).toBeLessThanOrEqual(2);
          console.info(
            JSON.stringify({
              runtime: enabled ? "node-telemetry" : "node",
              corpus: name,
              bytes: bytes.byteLength,
              ...timing,
              openMs,
              coldSteps: coldSpans
                .filter(
                  ({ name }) =>
                    name === "local.crypto.digestPrefix" || name === "pdfCore.wasm.copyIn",
                )
                .map(({ name, duration }) => ({
                  name,
                  ms: duration[0] * 1000 + duration[1] / 1_000_000,
                })),
              steps,
            }),
          );
          yield* documents.release(source.handle);
        }
        yield* a1.close();
      }
    }).pipe(Effect.provide(layer)),
  120_000,
);
