import { describe, expect, it } from "@effect/vitest";
import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import { Effect, Redacted } from "effect";
import { readA1Fixture } from "../../../tooling/testing/fixtures";
import { signPdf } from "../src/sign";
import { stampPdfRubric } from "../src/stamp";
import { verifyPdf } from "../src/verify";
import type { PdfCoordinateTuple } from "../src/config";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import { createFixturePdf } from "./pdf-fixtures";
import type { FixturePage } from "./pdf-fixtures";

const PASSWORD = Redacted.make("changeit");
const RUBRIC_RECT: PdfCoordinateTuple = [24, 24, 172, 68];

const createMultiPagePdf = createFixturePdf(
  Array.from({ length: 8 }, (_, index): FixturePage => ({
    size: [612, 792],
    text: [
      { x: 72, y: 720, size: 14, text: `SignatureKit performance page ${index + 1}` },
      {
        x: 72,
        y: 680,
        size: 10,
        text: "Body text keeps the generated PDF close to a real document path.",
      },
    ],
  })),
);

const millisecondsSince = (startedAt: number): number => performance.now() - startedAt;

describe("PDF workflow performance", () => {
  it.effect("keeps multi-page rubrica plus A1 signing inside an app-request budget", () =>
    Effect.gen(function* () {
      const pfx = yield* readA1Fixture("ecpf");
      const pdf = yield* createMultiPagePdf;
      const layer = a1SignaturesLayer({ pfx, password: PASSWORD });

      const startedAt = performance.now();
      const stamped = yield* stampPdfRubric(pdf, {
        rect: RUBRIC_RECT,
        pages: "all",
        lines: ["SIGNATUREKIT PERFORMANCE", "CPF/CNPJ: 12345678901", "2026-07-01"],
      });
      const signed = yield* signPdf({
        pdf: stamped,
        reason: "SignatureKit PDF performance regression test",
        name: "Performance CPF:12345678901",
        location: "BR",
        signatureLength: 16384,
      }).pipe(Effect.provide(layer));
      const verification = yield* verifyPdf({ pdf: signed });
      const elapsedMillis = millisecondsSince(startedAt);
      console.info(`bench-v1-internal pdf.rubric-fresh-sign ${elapsedMillis}`);

      expect(stamped.byteLength).toBeGreaterThan(pdf.byteLength);
      expect(signed.byteLength).toBeGreaterThan(stamped.byteLength);
      expect(verification.valid).toBe(true);
      expect(verification.signatureCount).toBe(1);
      expect(elapsedMillis).toBeLessThan(8_000);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
