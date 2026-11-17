import { PDFDocument } from "@cantoo/pdf-lib";
import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { readA1Fixture } from "../../../tooling/testing/fixtures";
import { extractPdfSignatures, isCompletePdfRevision } from "../src/byte-range";
import { addSignaturePlaceholder } from "../src/placeholder";
import { signPdf } from "../src/sign";
import { verifyPdf, verifyPdfSignatures } from "../src/verify";
import { pdfCoreTestLayer } from "./pdf-core-layer";

const PASSWORD = Redacted.make("changeit");

const createPdf = (useObjectStreams: boolean): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([320, 180]);
    pdf.addPage([320, 180]);
    return new Uint8Array(await pdf.save({ useObjectStreams }));
  });

const startsWith = (data: Uint8Array, prefix: Uint8Array): boolean =>
  prefix.every((byte, index) => data[index] === byte);

const signingLayer = Effect.gen(function* () {
  const pfx = yield* readA1Fixture("ecnpj");
  return Layer.merge(a1SignaturesLayer({ pfx, password: PASSWORD }), pdfCoreTestLayer);
});

describe("PDF incremental signing", () => {
  for (const useObjectStreams of [false, true]) {
    it.effect(
      `keeps earlier signatures valid across a second signature (object streams: ${useObjectStreams})`,
      () =>
        Effect.gen(function* () {
          const layer = yield* signingLayer;
          const source = yield* createPdf(useObjectStreams);
          const first = yield* signPdf({ pdf: source, signatureLength: 8192 }).pipe(
            Effect.provide(layer),
          );
          const second = yield* signPdf({
            pdf: first,
            signatureLength: 8192,
            appearance: { pageIndex: 1, widgetRect: [20, 20, 140, 60] },
          }).pipe(Effect.provide(layer));

          expect(startsWith(first, source)).toBe(true);
          expect(startsWith(second, first)).toBe(true);
          const results = yield* verifyPdfSignatures({ pdf: second }).pipe(
            Effect.provide(pdfCoreTestLayer),
          );
          expect(results).toHaveLength(2);
          expect(results.map((result) => result.valid)).toEqual([true, true]);
          expect(results[0]?.revisionEnd).toBe(first.byteLength);
          expect(results[1]?.coversFileEnd).toBe(true);
          const verification = yield* verifyPdf({ pdf: second }).pipe(
            Effect.provide(pdfCoreTestLayer),
          );
          expect(verification.valid).toBe(true);
          expect(verification.signatureCount).toBe(2);
          const reopened = yield* Effect.promise(() => PDFDocument.load(second));
          expect(reopened.getPageCount()).toBe(2);
        }),
    );
  }

  it.effect("adds the placeholder as an incremental update of the untouched source", () =>
    Effect.gen(function* () {
      const source = yield* createPdf(false);
      const placeholder = yield* addSignaturePlaceholder({ pdf: source, signatureLength: 256 });

      expect(startsWith(placeholder, source)).toBe(true);
      expect(yield* isCompletePdfRevision(placeholder, source.byteLength)).toBe(true);
      expect(yield* isCompletePdfRevision(placeholder, placeholder.byteLength)).toBe(true);
      const unsigned = yield* Effect.result(extractPdfSignatures(placeholder));
      expect(unsigned._tag).toBe("Failure");
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
