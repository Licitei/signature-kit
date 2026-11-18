import { describe, expect, it } from "@effect/vitest";
import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import type { CmsError } from "@signature-kit/cms/config";
import type { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import type { SignatureKitError } from "@signature-kit/signatures";
import { errorMessage } from "@signature-kit/i18n";
import { Effect, Redacted } from "effect";
import { readFileSync } from "node:fs";
import { readA1Fixture } from "../../../tooling/testing/fixtures";
import { findPdfTextAnchors } from "../src/anchors";
import type { PdfError } from "../src/config";
import { PdfErrorCodeValue, pdfErrorMessages } from "../src/config";
import { extractPdfPages, mergePdfs } from "../src/merge";
import { stampPdfRubric, stampPdfRubricOnPages, stampPdfVisibleSignature } from "../src/stamp";
import { prepareAndSignPdf } from "../src/workflow";
import { pdfCoreTestLayer } from "./pdf-core-layer";

describe("encrypted PDF errors", () => {
  it.effect("reports password protection through the PDF operations and locale catalog", () =>
    Effect.gen(function* () {
      const pdf = readFileSync(new URL("./fixtures/encrypted.pdf", import.meta.url));
      const pfx = yield* readA1Fixture("ecnpj");
      const stampSize = { width: 100, height: 30 };
      const operations: ReadonlyArray<
        Effect.Effect<unknown, PdfError | CmsError | SignatureKitError, PdfCore>
      > = [
        prepareAndSignPdf({ pdf, signing: {} }).pipe(
          Effect.provide(a1SignaturesLayer({ pfx, password: Redacted.make("changeit") })),
        ),
        mergePdfs([pdf]),
        mergePdfs([pdf], { signedSources: "flatten" }),
        extractPdfPages(pdf, [0]),
        findPdfTextAnchors({ pdf, matchers: [{ text: "Signature" }], stampSize }),
        stampPdfVisibleSignature({
          pdf,
          pageIndex: 0,
          rect: { pageIndex: 0, x: 10, y: 10, ...stampSize },
          lines: ["Signature"],
        }),
        stampPdfRubric(pdf, { rect: [10, 10, 110, 40], lines: ["Signature"], pages: [0] }),
        stampPdfRubricOnPages({
          pdf,
          pageDimensions: [{ index: 0, width: 300, height: 200 }],
          pages: [0],
          lines: ["Signature"],
        }),
      ];
      for (const operation of operations) {
        const error = yield* Effect.flip(operation);
        expect(error).toMatchObject({
          code: PdfErrorCodeValue.encryptedPdf,
          retryable: false,
        });
        expect(errorMessage(error, { locale: "en-US", catalogs: [pdfErrorMessages] })).toContain(
          "encrypted",
        );
        expect(errorMessage(error, { locale: "pt-BR", catalogs: [pdfErrorMessages] })).toContain(
          "criptografado",
        );
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
