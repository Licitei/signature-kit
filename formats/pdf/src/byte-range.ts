import { PdfCoreErrorCodeValue } from "@signature-kit/pdf-core/config";
import type {
  PdfCoreSignatureAnalysis,
  PdfCoreSignatureDictionary,
  PdfCoreSignatureFailure,
  PdfCoreSignatureReport,
} from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect, Match, Schema } from "effect";
import { concatBytes, encodeAscii, replaceRange } from "./bytes.js";
import {
  MAX_PDF_SIGNATURE_BYTES,
  PdfByteRangeSchema,
  PdfError,
  PdfErrorCodeValue,
  PdfOperationValue,
} from "./config.js";
import type { PdfOperation } from "./config.js";
export { PdfByteRangeSchema } from "./config.js";

const LEFT_ANGLE = 0x3c;
const RIGHT_ANGLE = 0x3e;
export const MAX_PDF_REVISIONS = 128;
export const MAX_PDF_SIGNATURE_DICTIONARIES = 1_024;
export const MAX_PDF_SIGNATURE_REVISION_WORK = 200_000;
export type PdfByteRange = (typeof PdfByteRangeSchema)["Type"];

export const PreparedPdfSignatureSchema = Schema.Struct({
  pdf: Schema.Uint8Array,
  byteRange: PdfByteRangeSchema,
  signedData: Schema.Uint8Array,
  contentsStart: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  contentsEnd: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  placeholderLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type PreparedPdfSignature = (typeof PreparedPdfSignatureSchema)["Type"];

export const ExtractedPdfSignatureSchema = Schema.Struct({
  byteRange: PdfByteRangeSchema,
  signedData: Schema.Uint8Array,
  signature: Schema.Uint8Array,
  signatureCount: Schema.Finite,
  startsAtZero: Schema.Boolean,
  coversFileEnd: Schema.Boolean,
  subFilter: Schema.optional(Schema.String),
});
export type ExtractedPdfSignature = (typeof ExtractedPdfSignatureSchema)["Type"];

const isPdfWhitespaceByte = (byte: number | undefined): boolean =>
  byte === 0x00 ||
  byte === 0x09 ||
  byte === 0x0a ||
  byte === 0x0c ||
  byte === 0x0d ||
  byte === 0x20;

const skipPdfWhitespace = (pdf: Uint8Array, offset: number): number => {
  let current = offset;
  while (current < pdf.byteLength && isPdfWhitespaceByte(pdf[current])) current += 1;
  return current;
};

const signatureFailureReasons = {
  streamEnd: "Failed to locate the end of a PDF stream.",
  revisionLengths: "Failed to locate bounded PDF revision stream lengths.",
  indirectLengths: "Failed to resolve indirect PDF stream lengths.",
  lengthBudget: "Exceeded the indirect PDF stream-length budget.",
  dictionaryParse: "Failed to parse PDF signature dictionaries.",
  revisionStructure: "Failed to parse PDF revision structure.",
  crossReferenceStream: "Failed to decode PDF cross-reference stream.",
  objectStream: "Failed to resolve a compressed PDF object.",
  traversalBudget: "Exceeded the PDF signature revision traversal budget.",
  invalidByteRange: "A reachable signature dictionary has an invalid /ByteRange.",
} satisfies Record<PdfCoreSignatureFailure, string>;

type PdfRegularSignatureDictionary = PdfCoreSignatureDictionary & {
  readonly kind: "signature";
  readonly byteRange: NonNullable<PdfCoreSignatureDictionary["byteRange"]>;
};

const isRegularSignatureWithByteRange = (
  dictionary: PdfCoreSignatureDictionary,
): dictionary is PdfRegularSignatureDictionary =>
  dictionary.kind === "signature" && dictionary.byteRange !== undefined;

const signatureReport = (
  pdf: Uint8Array,
  analysis: PdfCoreSignatureAnalysis,
  operation: PdfOperation,
): Effect.Effect<PdfCoreSignatureReport, PdfError, PdfCore> =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    return yield* core.signatures(pdf, analysis);
  }).pipe(
    Effect.mapError(
      (error) =>
        new PdfError({
          code: Match.value(error.code).pipe(
            Match.when(PdfCoreErrorCodeValue.limitExceeded, () => PdfErrorCodeValue.limitExceeded),
            Match.orElse(() => PdfErrorCodeValue.pdfLoadFailed),
          ),
          retryable: false,
          operation,
          reason: error.reason ?? "The PDF core could not analyze PDF signatures.",
        }),
    ),
  );

const signatureDictionaries = (
  pdf: Uint8Array,
  analysis: PdfCoreSignatureAnalysis,
  operation: PdfOperation,
): Effect.Effect<ReadonlyArray<PdfCoreSignatureDictionary>, PdfError, PdfCore> =>
  signatureReport(pdf, analysis, operation).pipe(
    Effect.flatMap((report) =>
      report.failure === undefined
        ? Effect.succeed(report.dictionaries)
        : Effect.fail(
            new PdfError({
              code: PdfErrorCodeValue.placeholderNotFound,
              retryable: false,
              reason: signatureFailureReasons[report.failure],
              operation,
            }),
          ),
    ),
  );

const scanFailedClosed = (report: PdfCoreSignatureReport): boolean =>
  report.parseFailed || report.streamFailed || report.streamUncertain;

export const isCompletePdfRevision = (
  pdf: Uint8Array,
  end: number,
): Effect.Effect<boolean, never, PdfCore> =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    return yield* core.revisionComplete(pdf, end);
  }).pipe(Effect.orElseSucceed(() => false));

export const hasPdfSignatureDictionary = (
  pdf: Uint8Array,
): Effect.Effect<boolean, PdfError, PdfCore> =>
  signatureReport(pdf, "scan", PdfOperationValue.verify).pipe(
    Effect.map((report) => scanFailedClosed(report) || report.dictionaries.length > 0),
  );

export const hasPdfByteRange = (pdf: Uint8Array): Effect.Effect<boolean, PdfError, PdfCore> =>
  signatureReport(pdf, "scan", PdfOperationValue.verify).pipe(
    Effect.map(
      (report) =>
        scanFailedClosed(report) ||
        report.dictionaries.some((dictionary) => dictionary.byteRange !== undefined),
    ),
  );

export const hasPdfSignatureDictionaryEffect = (
  pdf: Uint8Array,
): Effect.Effect<boolean, PdfError, PdfCore> =>
  signatureDictionaries(pdf, "dictionaries", PdfOperationValue.mergeDocuments).pipe(
    Effect.map((dictionaries) => dictionaries.length > 0),
  );

export const findPdfByteRangeOffsets = (
  pdf: Uint8Array,
): Effect.Effect<ReadonlyArray<number>, PdfError, PdfCore> =>
  signatureDictionaries(pdf, "dictionaries", PdfOperationValue.verify).pipe(
    Effect.flatMap((dictionaries) => {
      const signatures = dictionaries.filter(isRegularSignatureWithByteRange);
      return signatures.length === 0
        ? Effect.fail(
            new PdfError({
              code: PdfErrorCodeValue.placeholderNotFound,
              retryable: false,
              reason: "Failed to locate /ByteRange.",
              operation: PdfOperationValue.verify,
            }),
          )
        : Effect.succeed(signatures.map((dictionary) => dictionary.byteRange.keyStart));
    }),
  );

export const preparePdfByteRange = (
  pdf: Uint8Array,
): Effect.Effect<PreparedPdfSignature, PdfError, PdfCore> =>
  Effect.gen(function* () {
    const dictionaries = yield* signatureDictionaries(pdf, "dictionaries", PdfOperationValue.sign);
    const signature = dictionaries
      .filter(isRegularSignatureWithByteRange)
      .filter((candidate) => candidate.unsignedPlaceholder)
      .at(-1);
    if (signature === undefined) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.placeholderNotFound,
        retryable: false,
        reason: "No /ByteRange placeholder found.",
        operation: PdfOperationValue.sign,
      });
    }

    const contents = signature.contents;
    if (contents === undefined) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.placeholderNotFound,
        retryable: false,
        reason: "No /Contents placeholder found.",
        operation: PdfOperationValue.sign,
      });
    }

    const contentsStart = contents.valueStart;
    const contentsEnd = contents.valueEnd - 1;
    if (
      contentsStart < 0 ||
      contentsEnd <= contentsStart ||
      pdf[contentsStart] !== LEFT_ANGLE ||
      pdf[contentsEnd] !== RIGHT_ANGLE
    ) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.placeholderNotFound,
        retryable: false,
        reason: "Malformed /Contents placeholder.",
        operation: PdfOperationValue.sign,
      });
    }

    const byteRange: PdfByteRange = [
      0,
      contentsStart,
      contentsEnd + 1,
      pdf.byteLength - (contentsEnd + 1),
    ];
    const actualByteRange = concatBytes([
      pdf.subarray(signature.byteRange.keyStart, signature.byteRange.valueStart),
      encodeAscii(`[${byteRange.join(" ")}]`),
    ]);
    const byteRangeLength = signature.byteRange.valueEnd - signature.byteRange.keyStart;
    if (actualByteRange.byteLength > byteRangeLength) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.placeholderNotFound,
        retryable: false,
        reason: "The /ByteRange placeholder is too small.",
        operation: PdfOperationValue.sign,
      });
    }

    const paddedByteRange = new Uint8Array(byteRangeLength);
    paddedByteRange.fill(0x20);
    paddedByteRange.set(actualByteRange);
    const withByteRange = replaceRange(
      pdf,
      signature.byteRange.keyStart,
      signature.byteRange.valueEnd,
      paddedByteRange,
    );
    const signedData = concatBytes([
      withByteRange.subarray(byteRange[0], byteRange[0] + byteRange[1]),
      withByteRange.subarray(byteRange[2], byteRange[2] + byteRange[3]),
    ]);

    return {
      pdf: withByteRange,
      byteRange,
      signedData,
      contentsStart,
      contentsEnd,
      placeholderLength: contentsEnd - contentsStart - 1,
    };
  });

const MAX_BER_DEPTH = 64;

const berElementEnd = (bytes: Uint8Array, offset: number, depth: number): number | undefined => {
  if (depth > MAX_BER_DEPTH) return undefined;
  const tag = bytes[offset];
  if (tag === undefined) return undefined;
  let cursor = offset + 1;
  if ((tag & 0x1f) === 0x1f) {
    while (((bytes[cursor] ?? 0) & 0x80) !== 0) cursor += 1;
    cursor += 1;
  }
  const lengthByte = bytes[cursor];
  if (lengthByte === undefined) return undefined;
  cursor += 1;
  if (lengthByte < 0x80) {
    const end = cursor + lengthByte;
    return end <= bytes.byteLength ? end : undefined;
  }
  if (lengthByte === 0x80) {
    if ((tag & 0x20) === 0) return undefined;
    while (cursor < bytes.byteLength) {
      if (bytes[cursor] === 0 && bytes[cursor + 1] === 0) return cursor + 2;
      const next = berElementEnd(bytes, cursor, depth + 1);
      if (next === undefined || next <= cursor) return undefined;
      cursor = next;
    }
    return undefined;
  }
  const lengthByteCount = lengthByte & 0x7f;
  if (lengthByteCount > 4 || cursor + lengthByteCount > bytes.byteLength) return undefined;
  let contentLength = 0;
  for (let index = 0; index < lengthByteCount; index += 1) {
    contentLength = contentLength * 256 + (bytes[cursor + index] ?? 0);
  }
  const end = cursor + lengthByteCount + contentLength;
  return end <= bytes.byteLength ? end : undefined;
};

const cmsTotalLength = (bytes: Uint8Array): number | undefined =>
  bytes[0] === 0x30 ? berElementEnd(bytes, 0, 0) : undefined;

const hexNibble = (code: number): number | undefined => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return undefined;
};

const decodeSignatureHex = (
  pdf: Uint8Array,
  start: number,
  end: number,
): Effect.Effect<Uint8Array, PdfError> => {
  let hexLength = 0;
  for (let index = start; index < end; index += 1) {
    const code = pdf[index];
    if (code === undefined) continue;
    if (hexNibble(code) !== undefined) {
      hexLength += 1;
    } else if (!isPdfWhitespaceByte(code)) {
      return Effect.fail(
        new PdfError({
          code: PdfErrorCodeValue.placeholderNotFound,
          retryable: false,
          reason: "Malformed signature /Contents hex.",
          operation: PdfOperationValue.verify,
        }),
      );
    }
  }
  const byteLength = Math.ceil(hexLength / 2);
  if (byteLength > MAX_PDF_SIGNATURE_BYTES) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.placeholderNotFound,
        retryable: false,
        reason: "Signature /Contents exceeds supported capacity.",
        operation: PdfOperationValue.verify,
      }),
    );
  }

  const bytes = new Uint8Array(byteLength);
  let outputIndex = 0;
  let highNibble: number | undefined;
  for (let index = start; index < end; index += 1) {
    const code = pdf[index];
    if (code === undefined || isPdfWhitespaceByte(code)) continue;
    const nibble = hexNibble(code);
    if (nibble === undefined) {
      return Effect.fail(
        new PdfError({
          code: PdfErrorCodeValue.placeholderNotFound,
          retryable: false,
          reason: "Malformed signature /Contents hex.",
          operation: PdfOperationValue.verify,
        }),
      );
    }
    if (highNibble === undefined) {
      highNibble = nibble;
    } else {
      bytes[outputIndex] = (highNibble << 4) | nibble;
      outputIndex += 1;
      highNibble = undefined;
    }
  }
  if (highNibble !== undefined) bytes[outputIndex] = highNibble << 4;
  return Effect.succeed(bytes);
};

const hasOnlyZeroBytesFrom = (bytes: Uint8Array, offset: number): boolean => {
  for (let index = offset; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
};

const trimTrailingZeroBytes = (bytes: Uint8Array): Uint8Array => {
  let end = bytes.byteLength;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.subarray(0, end);
};

const extractPdfSignatureFromDictionary = (
  pdf: Uint8Array,
  dictionary: PdfRegularSignatureDictionary,
  signatureCount: number,
): Effect.Effect<ExtractedPdfSignature, PdfError> =>
  Effect.gen(function* () {
    if (dictionary.byteRangeValues === undefined) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.placeholderNotFound,
        retryable: false,
        reason: "Failed to parse /ByteRange values.",
        operation: PdfOperationValue.verify,
      });
    }
    const byteRange: PdfByteRange = [...dictionary.byteRangeValues];
    const rangeEnd = byteRange[2] + byteRange[3];
    if (
      byteRange[1] < 0 ||
      byteRange[3] < 0 ||
      byteRange[2] <= byteRange[0] + byteRange[1] ||
      rangeEnd > pdf.byteLength
    ) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.placeholderNotFound,
        retryable: false,
        reason: "Malformed /ByteRange values.",
        operation: PdfOperationValue.verify,
      });
    }
    const signedData = concatBytes([
      pdf.subarray(byteRange[0], byteRange[0] + byteRange[1]),
      pdf.subarray(byteRange[2], byteRange[2] + byteRange[3]),
    ]);
    const contentsBoundaryStart = byteRange[0] + byteRange[1];
    const contentsBoundaryEnd = byteRange[2] - 1;
    const contentsStart = skipPdfWhitespace(pdf, contentsBoundaryStart);
    let contentsEnd = contentsBoundaryEnd;
    while (contentsEnd > contentsStart && isPdfWhitespaceByte(pdf[contentsEnd])) contentsEnd -= 1;
    const contents = dictionary.contents;
    if (
      contents === undefined ||
      contentsStart !== contents.valueStart ||
      contentsEnd !== contents.valueEnd - 1 ||
      contentsStart >= contentsEnd ||
      pdf[contentsStart] !== LEFT_ANGLE ||
      pdf[contentsEnd] !== RIGHT_ANGLE
    ) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.placeholderNotFound,
        retryable: false,
        reason: "Malformed signature /Contents range.",
        operation: PdfOperationValue.verify,
      });
    }
    const paddedSignature = yield* decodeSignatureHex(pdf, contentsStart + 1, contentsEnd);
    const derLength = cmsTotalLength(paddedSignature);
    if (derLength !== undefined && !hasOnlyZeroBytesFrom(paddedSignature, derLength)) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.placeholderNotFound,
        retryable: false,
        reason: "Non-zero bytes after BER signature contents.",
        operation: PdfOperationValue.verify,
      });
    }
    const signature =
      derLength === undefined
        ? trimTrailingZeroBytes(paddedSignature)
        : paddedSignature.subarray(0, derLength);
    return {
      byteRange,
      signedData,
      signature,
      signatureCount,
      startsAtZero: byteRange[0] === 0,
      coversFileEnd: rangeEnd === pdf.byteLength,
      ...(dictionary.subFilter === undefined ? {} : { subFilter: dictionary.subFilter }),
    };
  });

export const extractPdfSignatureAtOffset = (
  pdf: Uint8Array,
  byteRangeStart: number,
  signatureCount: number,
): Effect.Effect<ExtractedPdfSignature, PdfError, PdfCore> =>
  signatureDictionaries(pdf, "verification", PdfOperationValue.verify).pipe(
    Effect.flatMap((dictionaries) => {
      const dictionary = dictionaries
        .filter(isRegularSignatureWithByteRange)
        .find((candidate) => candidate.byteRange.keyStart === byteRangeStart);
      return dictionary === undefined
        ? Effect.fail(
            new PdfError({
              code: PdfErrorCodeValue.placeholderNotFound,
              retryable: false,
              reason: "Failed to locate /ByteRange.",
              operation: PdfOperationValue.verify,
            }),
          )
        : extractPdfSignatureFromDictionary(pdf, dictionary, signatureCount);
    }),
  );

const verificationRegularSignatureDictionaries = (
  pdf: Uint8Array,
): Effect.Effect<ReadonlyArray<PdfRegularSignatureDictionary>, PdfError, PdfCore> =>
  signatureDictionaries(pdf, "verification", PdfOperationValue.verify).pipe(
    Effect.flatMap((dictionaries) => {
      if (dictionaries.some((dictionary) => dictionary.kind === "documentTimestamp")) {
        return Effect.fail(
          new PdfError({
            code: PdfErrorCodeValue.verifyFailed,
            retryable: false,
            reason: "PDF DocTimeStamp verification is not supported.",
            operation: PdfOperationValue.verify,
          }),
        );
      }
      const signatures = dictionaries.filter(isRegularSignatureWithByteRange);
      return signatures.length === 0
        ? Effect.fail(
            new PdfError({
              code: PdfErrorCodeValue.placeholderNotFound,
              retryable: false,
              reason: "Failed to locate /ByteRange.",
              operation: PdfOperationValue.verify,
            }),
          )
        : Effect.succeed(signatures);
    }),
  );

export const forEachPdfSignature = <E, R>(
  pdf: Uint8Array,
  f: (
    signature: ExtractedPdfSignature,
    index: number,
    signatureCount: number,
  ) => Effect.Effect<void, E, R>,
): Effect.Effect<void, PdfError | E, R | PdfCore> =>
  verificationRegularSignatureDictionaries(pdf).pipe(
    Effect.flatMap((dictionaries) =>
      Effect.forEach(
        dictionaries,
        (dictionary, index) =>
          extractPdfSignatureFromDictionary(pdf, dictionary, dictionaries.length).pipe(
            Effect.flatMap((signature) => f(signature, index, dictionaries.length)),
          ),
        { discard: true },
      ),
    ),
  );

export const extractPdfSignatures = (
  pdf: Uint8Array,
): Effect.Effect<ReadonlyArray<ExtractedPdfSignature>, PdfError, PdfCore> =>
  verificationRegularSignatureDictionaries(pdf).pipe(
    Effect.flatMap((dictionaries) =>
      Effect.forEach(dictionaries, (dictionary) =>
        extractPdfSignatureFromDictionary(pdf, dictionary, dictionaries.length),
      ),
    ),
  );

export const extractPdfSignature = (
  pdf: Uint8Array,
): Effect.Effect<ExtractedPdfSignature, PdfError, PdfCore> =>
  Effect.gen(function* () {
    const signatures = yield* extractPdfSignatures(pdf);
    const last = signatures[signatures.length - 1];
    if (last === undefined) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.placeholderNotFound,
        retryable: false,
        reason: "Failed to locate /ByteRange.",
        operation: PdfOperationValue.verify,
      });
    }
    return last;
  });
