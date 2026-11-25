import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { pdfCoreFileLayer } from "@signature-kit/pdf-core/file";
import { Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { readFile } from "node:fs/promises";
import { largePdf, syntheticPdf } from "../../../scripts/local-first/bench-v1/corpus.ts";
import { recordSpans } from "../../../tooling/testing/tracing.ts";
import { A1Sessions, Documents, localRuntimeLayer } from "../src/engine.js";
import { PdfSignatures, pdfSignaturesLayer } from "../src/pdf-signatures.js";

const layer = pdfSignaturesLayer.pipe(
  Layer.provideMerge(localRuntimeLayer()),
  Layer.provideMerge(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))),
);

const corpus = [
  { name: "synthetic-1", pages: 1, large: false },
  { name: "synthetic-20", pages: 20, large: false },
  { name: "synthetic-200", pages: 200, large: false },
  { name: "synthetic-21mib", pages: 20, large: true },
];

it.effect(
  "measures warm-session prepare and self-verifying confirm on the 1.x corpus",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2027-01-01T00:00:00Z"));
      const documents = yield* Documents;
      const a1 = yield* A1Sessions;
      const signatures = yield* PdfSignatures;
      const pfx = yield* Effect.promise(
        async () => new Uint8Array(await readFile(new URL("./fixtures/ecpf.p12", import.meta.url))),
      );
      const session = yield* a1.open({
        pfx: Redacted.make(pfx),
        password: Redacted.make("changeit"),
      });

      for (const { name, pages, large } of corpus) {
        const bytes = yield* large ? largePdf : syntheticPdf(pages);
        const source = yield* documents.open(bytes);
        const sign = Effect.gen(function* () {
          const started = performance.now();
          const preparation = yield* signatures.prepare(source, {
            session,
            field: { kind: "create", name: "Approval", page: 0, rect: [32, 28, 248, 72] },
            appearance: { kind: "visible", lines: ["Signed locally"] },
            policy: "cades",
          });
          const receipt = yield* signatures.confirm(preparation.preparationId);
          const milliseconds = performance.now() - started;
          yield* signatures.release(preparation.preparationId);
          yield* documents.release(preparation.previewRevision.handle);
          yield* documents.release(receipt.signedRevision.handle);
          return milliseconds;
        });
        for (let i = 0; i < 3; i += 1) yield* sign;
        const samples = (yield* Effect.forEach(Array.from({ length: 7 }), () => sign)).sort(
          (a, b) => a - b,
        );

        const { exit, spans } = yield* recordSpans(sign);
        yield* exit;
        const inputs = spans.filter(({ name }) => name === "pdfCore.wasm.copyIn");
        const operations = spans.filter(({ name }) => name === "pdfCore.wasm.run");
        expect(inputs).toHaveLength(5);
        expect(
          operations.map(({ attributes }) => attributes["signature_kit.pdf_core.operation"]),
        ).toEqual([
          "pdfCore.signatureFields",
          "pdfCore.prepareSignature",
          "pdfCore.signatures",
          "pdfCore.revisionChanges",
        ]);
        console.info({
          corpus: name,
          bytes: bytes.byteLength,
          medianMs: samples[Math.floor(samples.length / 2)],
          jsToWasmCopies: inputs.length,
          operations: operations.length,
        });
        yield* documents.release(source.handle);
      }
    }).pipe(Effect.provide(layer)),
  120_000,
);
