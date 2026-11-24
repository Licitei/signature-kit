import { describe, expect, it } from "@effect/vitest";
import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import { signPdf } from "@signature-kit/pdf/sign";
import { prepareAndSignPdf } from "@signature-kit/pdf/workflow";
import { verifyPdfSignatures } from "@signature-kit/pdf/verify";
import { PdfErrorCodeValue } from "@signature-kit/pdf/config";
import { Effect, Layer, Redacted, Result } from "effect";
import { readA1Fixture } from "../../../tooling/testing/fixtures";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import { createFixturePdf } from "./pdf-fixtures";

const PASSWORD = Redacted.make("changeit");
const encoder = new TextEncoder();

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const lastIndexOf = (data: Uint8Array, needle: string): number => {
  const bytes = encoder.encode(needle);
  for (let index = data.byteLength - bytes.byteLength; index >= 0; index -= 1) {
    if (bytes.every((byte, offset) => data[index + offset] === byte)) return index;
  }
  return -1;
};

const trailingBytes = (pdf: Uint8Array) =>
  concat(pdf, encoder.encode("\n<html>download footer</html>\n"));

const damages = {
  "bytes before the %PDF header": (pdf: Uint8Array) => concat(encoder.encode("JUNK\n"), pdf),
  "a startxref offset that misses the cross-reference section": (pdf: Uint8Array) => {
    const at = lastIndexOf(pdf, "startxref");
    return concat(pdf.subarray(0, at), encoder.encode("startxref\n17\n%%EOF\n"));
  },
};

const signedSource = Effect.gen(function* () {
  const pfx = yield* readA1Fixture("ecnpj");
  const base = yield* createFixturePdf([{ size: [320, 180] }]);
  return yield* signPdf({ pdf: base, policy: "pades-icp-brasil" }).pipe(
    Effect.provide(a1SignaturesLayer({ pfx, password: PASSWORD })),
  );
});

const signingLayer = Effect.gen(function* () {
  const pfx = yield* readA1Fixture("ecnpj");
  return Layer.merge(a1SignaturesLayer({ pfx, password: PASSWORD }), pdfCoreTestLayer);
});

const signAgain = (pdf: Uint8Array) =>
  signingLayer.pipe(
    Effect.flatMap((layer) =>
      prepareAndSignPdf({
        pdf,
        pages: [{ index: 0, width: 320, height: 180 }],
        lines: ["SECOND SIGNATURE"],
        signing: { policy: "pades-icp-brasil", reason: "second signature" },
      }).pipe(Effect.provide(layer)),
    ),
  );

const startsWith = (data: Uint8Array, prefix: Uint8Array): boolean =>
  prefix.every((byte, index) => data[index] === byte);

describe("signing an already-signed PDF whose cross-reference chain is damaged", () => {
  it.effect("drops bytes after the final %%EOF and keeps the earlier signature valid", () =>
    Effect.gen(function* () {
      const signed = yield* signedSource;
      const signedAgain = yield* signAgain(trailingBytes(signed));

      expect(startsWith(signedAgain, signed)).toBe(true);
      const results = yield* verifyPdfSignatures({ pdf: signedAgain });
      expect(results.map((result) => result.valid)).toEqual([true, true]);
      expect(results[0]?.revisionEnd).toBe(signed.byteLength);
      expect(results[1]?.coversFileEnd).toBe(true);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  for (const [name, damage] of Object.entries(damages)) {
    it.effect(`reports ${name} as a damaged signed PDF instead of a stamp failure`, () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(signAgain(damage(yield* signedSource)));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe(PdfErrorCodeValue.damagedSignedPdf);
          expect(result.failure.reason).toMatch(/^incremental update needs an intact/);
        }
      }).pipe(Effect.provide(pdfCoreTestLayer)),
    );
  }
});
