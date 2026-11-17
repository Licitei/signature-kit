import { describe, expect, it } from "@effect/vitest";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect, Result } from "effect";
import { createIllustrativePdf } from "../src/stamp";
import { verifyPdfSignatures } from "../src/verify";
import { hasPdfByteRange } from "../src/byte-range";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import { PdfErrorCodeValue, PdfOperationValue } from "../src/config";

describe("illustrative PDF documents", () => {
  it.effect("creates valid examples and visual marks without a cryptographic signature", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      for (const variant of ["line", "field", "witnessed", "initials"] satisfies (
        | "line"
        | "field"
        | "witnessed"
        | "initials"
      )[]) {
        const input = {
          title: "Example agreement",
          body: "A sample document.",
          variant,
          marked: false,
          markLabel: "DEMO MARK 2718",
        };
        const plain = yield* createIllustrativePdf(input);
        const marked = yield* createIllustrativePdf({ ...input, marked: true });
        expect((yield* core.document(plain)).pages).toHaveLength(1);
        expect((yield* core.document(marked)).pages).toHaveLength(1);
        const [plainText = ""] = yield* core.text(plain);
        const [markedText = ""] = yield* core.text(marked);
        expect(plainText).toContain("Example agreement");
        expect(plainText).toContain(variant);
        expect(plainText).not.toContain("DEMO MARK 2718");
        expect(markedText).toContain("Example agreement");
        expect(markedText).toContain(variant);
        expect(markedText).toContain("DEMO MARK 2718");
        expect(yield* hasPdfByteRange(marked)).toBe(false);
        const result = yield* Effect.result(verifyPdfSignatures({ pdf: marked }));
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "PdfError",
            code: PdfErrorCodeValue.placeholderNotFound,
            operation: PdfOperationValue.verify,
            reason: "Failed to locate /ByteRange.",
          },
        });
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("rejects malformed inputs with a typed error", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        createIllustrativePdf({ title: "", body: "body", variant: "line", marked: false }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.schemaName).toBe("PdfIllustrativeDocumentInput");
        expect(result.failure.issueMessage).toBeTruthy();
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("rejects text the standard Helvetica encoding cannot represent", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        createIllustrativePdf({ title: "合同", body: "body", variant: "line", marked: false }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "PdfError", code: PdfErrorCodeValue.stampFailed },
      });
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
