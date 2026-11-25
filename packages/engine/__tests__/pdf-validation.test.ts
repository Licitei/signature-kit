import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { pdfCoreFileLayer } from "@signature-kit/engine/wasm/file";
import { Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { readFile } from "node:fs/promises";
import * as pki from "pkijs";
import { A1Sessions, Documents, localRuntimeLayer, pdfEngineLayer } from "../src/engine.js";
import { PdfSignatures, pdfSignaturesLayer } from "../src/pdf-signatures.js";
import { verifyIndependently } from "../../../tooling/testing/verify-pdf.js";
import { existingField } from "../../../tooling/testing/cosign.js";

const layer = pdfSignaturesLayer.pipe(
  Layer.provideMerge(pdfEngineLayer),
  Layer.provideMerge(localRuntimeLayer()),
  Layer.provideMerge(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))),
);

const fixture = (name: string) =>
  Effect.promise(
    async () =>
      new Uint8Array(
        await readFile(new URL(`../../../tooling/testing/fixtures/${name}`, import.meta.url)),
      ),
  );

it.effect("appends and reads DSS evidence without changing the signed bytes", () =>
  Effect.gen(function* () {
    const ca = yield* fixture("validation/ca.der");
    const good = yield* fixture("validation/good.der");
    const signer = yield* fixture("validation/signer.der");
    const ocsp = pki.OCSPResponse.fromBER(good);
    const basic = ocsp.responseBytes?.response.valueBlock.valueHexView;
    if (basic === undefined) return yield* Effect.die("Missing OCSP fixture body.");
    const at = new Date(
      pki.BasicOCSPResponse.fromBER(basic).tbsResponseData.producedAt.getTime() + 60_000,
    );
    yield* TestClock.setTime(at.getTime());
    const a1 = yield* A1Sessions;
    const documents = yield* Documents;
    const pdf = yield* PdfSignatures;
    const source = yield* documents.open(yield* fixture("cosign/sent.pdf"));
    const session = yield* a1.open({
      pfx: Redacted.make(yield* fixture("validation/signer.p12")),
      password: Redacted.make("changeit"),
    });
    const prepared = yield* pdf.prepare(source, existingField(session, "Contratante"));
    const signed = (yield* pdf.confirm(prepared.preparationId)).signedRevision;
    const dss = { certificates: [signer], ocsp: [good], crls: [] };
    const updated = yield* pdf.addValidationData(signed, dss);
    expect(yield* pdf.addValidationData(updated, dss)).toEqual(updated);
    const bytes = yield* documents.export(updated.handle);
    expect(bytes.subarray(0, signed.byteLength)).toEqual(yield* documents.export(signed.handle));
    expect((yield* pdf.verify(updated, { trust: [ca], at })).signatures[0]).toMatchObject({
      integrity: "valid",
      trust: "trusted",
      revocation: { kind: "verified", source: "ocsp", result: { status: "good" } },
    });
    expect(yield* pdf.prepareDocumentTimestamp(updated)).toHaveLength(32);
    const wrong = yield* fixture("validation/timestamp-token.der");
    expect(yield* Effect.flip(pdf.addDocumentTimestamp(updated, wrong))).toMatchObject({
      code: "documentTimestampFailed",
    });
    yield* verifyIndependently(bytes, 1);
  }).pipe(Effect.provide(layer)),
);
