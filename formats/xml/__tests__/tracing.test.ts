import { describe, expect, it } from "@effect/vitest";
import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import { signatures } from "@signature-kit/signatures";
import { Effect, Exit, Redacted } from "effect";

import { XmlOperationValue } from "../src/config";
import { xmlRuntimeLayer } from "../src/runtime";
import { signXml } from "../src/sign";
import { verifyXml } from "../src/verify";
import { readA1Fixture } from "../../../tooling/testing/fixtures";
import { childSpans, recordSpans, spanNamed } from "../../../tooling/testing/tracing.ts";

const PASSWORD = Redacted.make("changeit");
const SECRET_TEXT = "confidential-invoice-amount";

describe("XML tracing", () => {
  it.effect("records runtime, sign, verify and key import spans without document content", () =>
    Effect.gen(function* () {
      const pfx = yield* readA1Fixture("ecpf");
      const layer = a1SignaturesLayer({ pfx, password: PASSWORD });
      const { exit, spans } = yield* recordSpans(
        Effect.gen(function* () {
          const certificate = yield* signatures.certificate();
          const signed = yield* signXml({
            xml: `<Invoice Id="invoice"><Note>${SECRET_TEXT}</Note></Invoice>`,
            referenceId: "invoice",
          });
          return yield* verifyXml({ xml: signed, publicKeyDer: certificate.publicKeyDer });
        }).pipe(Effect.provide(layer), Effect.provide(xmlRuntimeLayer)),
      );
      expect(Exit.isSuccess(exit)).toBe(true);

      expect(spanNamed(spans, XmlOperationValue.runtime)).toBeDefined();
      const sign = spanNamed(spans, XmlOperationValue.sign);
      expect(sign?.attributes).toMatchObject({
        "signature_kit.signature.algorithm": "rsa-sha256",
        "signature_kit.xml.canonicalization": "exclusive",
      });
      const signChildren = childSpans(spans, sign).map((span) => span.name);
      expect(signChildren).toContain(XmlOperationValue.parse);
      expect(signChildren).toContain("xml.signature");

      const verify = spanNamed(spans, XmlOperationValue.verify);
      expect(verify?.attributes).toMatchObject({
        "signature_kit.xml.signature_count": 1,
        "signature_kit.xml.valid": true,
      });
      const verifyChildren = childSpans(spans, verify).map((span) => span.name);
      expect(verifyChildren).toContain(XmlOperationValue.keyImport);
      expect(verifyChildren).toContain("xml.verify.signature");
      expect(spanNamed(spans, XmlOperationValue.keyImport)?.attributes).toMatchObject({
        "signature_kit.xml.key_source": "spki",
      });

      const attributes = JSON.stringify(spans.map((span) => span.attributes));
      expect(attributes).not.toContain(SECRET_TEXT);
      expect(attributes).not.toContain("invoice");
    }),
  );

  it.effect("marks parse failures as span errors", () =>
    Effect.gen(function* () {
      const { exit, spans } = yield* recordSpans(
        verifyXml({ xml: "<unclosed>", publicKeyDer: new Uint8Array([1]) }).pipe(
          Effect.provide(xmlRuntimeLayer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(spanNamed(spans, XmlOperationValue.parse)?.status.code).toBe(2);
      expect(spanNamed(spans, XmlOperationValue.verify)?.status.code).toBe(2);
    }),
  );
});
