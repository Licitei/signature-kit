import { MAX_PDF_CORE_SIGNATURE_CONTENTS } from "@signature-kit/pdf-core/config";
import type {
  PdfCorePreparedSignature,
  PdfCoreSignatureDictionary,
} from "@signature-kit/pdf-core/config";
import { Effect } from "effect";
import { LocalError } from "./protocol.js";

export const signedBytes = (pdf: Uint8Array, range: PdfCorePreparedSignature["byteRange"]) => {
  const [start, firstLength, secondStart, secondLength] = range;
  const content = new Uint8Array(firstLength + secondLength);
  content.set(pdf.subarray(start, start + firstLength));
  content.set(pdf.subarray(secondStart, secondStart + secondLength), firstLength);
  return content;
};

const isPdfWhitespace = (byte: number): boolean =>
  byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;

const hexNibble = (byte: number): number => {
  if (byte >= 48 && byte <= 57) return byte - 48;
  const lower = byte | 32;
  return lower >= 97 && lower <= 102 ? lower - 87 : -1;
};

export const signatureContents = Effect.fnUntraced(function* (
  pdf: Uint8Array,
  { byteRangeValues, contents }: PdfCoreSignatureDictionary,
) {
  if (byteRangeValues === undefined || contents === undefined) {
    return yield* new LocalError({ code: "pdfReadFailed" });
  }

  const [start, firstLength, secondStart, secondLength] = byteRangeValues;
  const gapStart = start + firstLength;
  const revisionEnd = secondStart + secondLength;
  const { valueStart, valueEnd } = contents;
  if (
    gapStart > valueStart ||
    valueEnd > secondStart ||
    valueEnd - valueStart < 3 ||
    revisionEnd > pdf.byteLength ||
    secondStart - gapStart > MAX_PDF_CORE_SIGNATURE_CONTENTS * 4 ||
    pdf[valueStart] !== 0x3c ||
    pdf[valueEnd - 1] !== 0x3e ||
    !pdf.subarray(gapStart, valueStart).every(isPdfWhitespace) ||
    !pdf.subarray(valueEnd, secondStart).every(isPdfWhitespace)
  )
    return yield* new LocalError({ code: "pdfReadFailed" });

  return pdf.subarray(valueStart + 1, valueEnd - 1);
});

export const decodeSignatureContents = Effect.fnUntraced(function* (contents: Uint8Array) {
  const padded = new Uint8Array(
    Math.min(MAX_PDF_CORE_SIGNATURE_CONTENTS, Math.ceil(contents.byteLength / 2)),
  );
  let length = 0;
  let high = -1;
  for (const byte of contents) {
    if (isPdfWhitespace(byte)) continue;
    const nibble = hexNibble(byte);
    if (nibble < 0 || length === padded.byteLength) {
      return yield* new LocalError({ code: "pdfReadFailed" });
    }
    if (high < 0) {
      high = nibble;
    } else {
      padded[length++] = high * 16 + nibble;
      high = -1;
    }
  }
  if (high >= 0) padded[length++] = high * 16;
  return padded.subarray(0, length);
});

export const embedPreparedSignature = Effect.fnUntraced(function* (
  { pdf, contentsStart, contentsEnd }: PdfCorePreparedSignature,
  cms: Uint8Array,
) {
  if (cms.byteLength * 2 > contentsEnd - contentsStart) {
    return yield* new LocalError({ code: "signatureTooLarge" });
  }
  const signed = new Uint8Array(pdf);
  const hex = "0123456789abcdef";
  for (const [index, byte] of cms.entries()) {
    signed[contentsStart + index * 2] = hex.charCodeAt(byte >> 4);
    signed[contentsStart + index * 2 + 1] = hex.charCodeAt(byte & 15);
  }
  return signed;
});
