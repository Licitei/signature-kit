import { describe, expect, it } from "@effect/vitest";
import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import { signPdf } from "@signature-kit/pdf/sign";
import { verifyPdf } from "@signature-kit/pdf/verify";
import { Effect, Exit, Redacted } from "effect";

import { readA1Fixture } from "../../../tooling/testing/fixtures";
import { childSpans, recordSpans, spanNamed } from "../../../tooling/testing/tracing.ts";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import { createFixturePdf } from "./pdf-fixtures";

const PASSWORD = Redacted.make("changeit");
const SIGNER_NAME = "Pessoa CPF:12345678901";

const createPdf = createFixturePdf([
  { text: [{ x: 32, y: 118, size: 14, text: "SignatureKit tracing document" }] },
]);

describe("PDF tracing", () => {
  it.effect("records the signing phases and verification without PII", () =>
    Effect.gen(function* () {
      const pdf = yield* createPdf;
      const pfx = yield* readA1Fixture("ecpf");
      const { exit, spans } = yield* recordSpans(
        Effect.gen(function* () {
          const signed = yield* signPdf({
            pdf,
            name: SIGNER_NAME,
            reason: "Tracing reason",
            signatureLength: 16384,
          }).pipe(Effect.provide(a1SignaturesLayer({ pfx, password: PASSWORD })));
          return yield* verifyPdf({ pdf: signed });
        }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);

      const sign = spanNamed(spans, "pdf.sign");
      expect(sign?.attributes).toMatchObject({
        "signature_kit.pdf.bytes": pdf.byteLength,
        "signature_kit.hash.algorithm": "sha256",
        "signature_kit.signature.policy": "pades-ades",
      });
      expect(sign?.attributes["signature_kit.pdf.output_bytes"]).toBeGreaterThan(pdf.byteLength);
      expect(childSpans(spans, sign).map((span) => span.name)).toEqual([
        "pdf.placeholder",
        "pdf.byteRange.prepare",
        "pdf.signer.load",
        "pdf.cms.create",
        "pdf.contents.embed",
      ]);
      expect(spanNamed(spans, "pdf.placeholder")?.attributes).toMatchObject({
        "signature_kit.pdf.contents_bytes": 16384,
        "signature_kit.signature.subfilter": "adbe.pkcs7.detached",
      });
      expect(spanNamed(spans, "pdf.cms.create")?.attributes).toMatchObject({
        "signature_kit.hash.algorithm": "sha256",
      });

      const verify = spanNamed(spans, "pdf.verify");
      expect(verify?.attributes).toMatchObject({
        "signature_kit.pdf.signature_count": 1,
        "signature_kit.pdf.valid_signatures": 1,
      });
      expect(childSpans(spans, verify).map((span) => span.name)).toContain("pdf.verify.signature");

      const attributes = JSON.stringify(spans.map((span) => span.attributes));
      expect(attributes).not.toContain("12345678901");
      expect(attributes).not.toContain("Tracing reason");
      expect(attributes).not.toContain("CN=");
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("marks a failed signing attempt as an error span", () =>
    Effect.gen(function* () {
      const pfx = yield* readA1Fixture("ecpf");
      const { exit, spans } = yield* recordSpans(
        signPdf({ pdf: new TextEncoder().encode("not a pdf") }).pipe(
          Effect.provide(a1SignaturesLayer({ pfx, password: PASSWORD })),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const sign = spanNamed(spans, "pdf.sign");
      expect(sign?.status.code).toBe(2);
      expect(sign?.events.map((event) => event.name)).toContain("exception");
      expect(spanNamed(spans, "pdf.placeholder")?.status.code).toBe(2);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
