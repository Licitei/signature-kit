import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import * as pki from "pkijs";
import { evaluateRevocation } from "../../src/validation/revocation.js";

const fixture = (name: string) =>
  Effect.promise(
    async () =>
      new Uint8Array(
        await readFile(
          new URL(`../../../../tooling/testing/fixtures/validation/${name}.der`, import.meta.url),
        ),
      ),
  );

it.effect("validates OCSP and CRL signatures, authority, serial and validity", () =>
  Effect.gen(function* () {
    const [ca, signer, good, revoked, expired, wrong, crl] = yield* Effect.all([
      fixture("ca"),
      fixture("signer"),
      fixture("good"),
      fixture("revoked"),
      fixture("expired"),
      fixture("wrong-responder"),
      fixture("revoked-crl"),
    ]);
    const path = [pki.Certificate.fromBER(signer), pki.Certificate.fromBER(ca)];
    const envelope = pki.OCSPResponse.fromBER(good);
    const response = envelope.responseBytes?.response.valueBlock.valueHexView;
    if (response === undefined) return yield* Effect.die("Missing OCSP response fixture");
    const basic = pki.BasicOCSPResponse.fromBER(response);
    const at = new Date(basic.tbsResponseData.producedAt.getTime() + 60_000);
    const future = new Date(at.getTime() + 2 * 86_400_000);

    expect(yield* evaluateRevocation({ ocsp: [good], crls: [] }, path, at)).toEqual({
      kind: "verified",
      source: "ocsp",
      result: { status: "good" },
    });
    expect(yield* evaluateRevocation({ ocsp: [good, revoked], crls: [] }, path, at)).toMatchObject({
      kind: "verified",
      source: "ocsp",
      result: { status: "revoked", reason: 1 },
    });
    expect(yield* evaluateRevocation({ ocsp: [], crls: [crl] }, path, at)).toMatchObject({
      kind: "verified",
      source: "crl",
      result: { status: "revoked", reason: 1 },
    });
    expect(yield* evaluateRevocation({ ocsp: [expired], crls: [] }, path, future)).toMatchObject({
      kind: "embeddedEvidence",
      reasons: ["outsideValidity"],
    });
    expect(yield* evaluateRevocation({ ocsp: [wrong], crls: [] }, path, at)).toMatchObject({
      kind: "embeddedEvidence",
      reasons: ["unauthorizedResponder"],
    });
    expect(yield* evaluateRevocation({ ocsp: [good], crls: [] }, [], at)).toMatchObject({
      kind: "embeddedEvidence",
      reasons: ["untrustedIssuer"],
    });

    const signature = basic.signature.valueBlock.valueHexView;
    signature[0] = (signature[0] ?? 0) ^ 1;
    const forged = new Uint8Array(basic.toSchema().toBER(false));
    expect(yield* evaluateRevocation({ ocsp: [forged], crls: [] }, path, at)).toMatchObject({
      kind: "embeddedEvidence",
      reasons: ["invalidSignature"],
    });
  }),
);
