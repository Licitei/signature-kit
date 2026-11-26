import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { pdfCoreFileLayer } from "@signature-kit/engine/wasm/file";
import { PdfCore } from "@signature-kit/engine/wasm/pdf-core";
import { Effect, Layer, Redacted } from "effect";
import { readFile } from "node:fs/promises";
import { existingField, signatories, trustAt } from "../../../tooling/testing/cosign.js";
import {
  medianSigningTime,
  signingCorpus,
} from "../../../tooling/testing/pdf-signing-benchmark.js";
import { A1Sessions, Documents, localRuntimeLayer, pdfEngineLayer } from "../src/engine.js";
import { PdfSignatures, pdfSignaturesLayer } from "../src/pdf-signatures.js";
import { PdfVerification, pdfVerificationLayer } from "../src/pdf-verification.js";
import type { RevisionRef } from "../src/rpc.js";

const layer = Layer.merge(pdfSignaturesLayer, pdfVerificationLayer).pipe(
  Layer.provideMerge(pdfEngineLayer),
  Layer.provideMerge(localRuntimeLayer()),
  Layer.provideMerge(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))),
);
const fixture = (name: string) =>
  Effect.promise(
    async () =>
      new Uint8Array(
        await readFile(
          new URL(`../../../tooling/testing/fixtures/cosign/${name}`, import.meta.url),
        ),
      ),
  );

it.live(
  "measures PDF comparison with two signatures and an explicit trust root",
  () =>
    Effect.gen(function* () {
      const documents = yield* Documents;
      const a1 = yield* A1Sessions;
      const pdf = yield* PdfSignatures;
      const verification = yield* PdfVerification;
      const core = yield* PdfCore;
      const trust = [yield* fixture("root.der")] satisfies readonly [Uint8Array];
      const certificates = yield* Effect.all([fixture("ecpf.p12"), fixture("ecnpj.p12")]);
      const sign = (source: RevisionRef, pfx: Uint8Array<ArrayBuffer>, name: string) =>
        Effect.gen(function* () {
          const session = yield* a1.open({
            pfx: Redacted.make(pfx),
            password: Redacted.make("changeit"),
          });
          const prepared = yield* pdf.prepare(source, existingField(session, name));
          const receipt = yield* pdf.confirm(prepared.preparationId);
          yield* pdf.release(prepared.preparationId);
          yield* documents.release(prepared.previewRevision.handle);
          return receipt.signedRevision;
        });
      for (const { name, pdf: input } of signingCorpus(core)) {
        const draft = yield* documents.open(yield* input);
        const sent = yield* pdf.addFields(draft, signatories);
        const first = yield* sign(sent, certificates[0], signatories[0].name);
        const returned = yield* sign(first, certificates[1], signatories[1].name);
        const timing = yield* medianSigningTime(
          Effect.gen(function* () {
            const start = performance.now();
            const report = yield* verification.compare(sent, returned, { trust, at: trustAt });
            const duration = performance.now() - start;
            expect(report.verdict).toBe("signedAsExpected");
            expect(report.signatures).toHaveLength(2);
            return duration;
          }),
        );
        console.info(JSON.stringify({ corpus: name, bytes: returned.byteLength, ...timing }));
        for (const { handle } of [draft, sent, first, returned]) yield* documents.release(handle);
      }
    }).pipe(Effect.provide(layer)),
  120_000,
);
