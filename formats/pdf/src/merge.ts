import { PdfCoreErrorCodeValue } from "@signature-kit/pdf-core/config";
import type { PdfCoreMergeSources } from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect, Match, Schema } from "effect";
import { hasPdfSignatureDictionaryEffect } from "./byte-range.js";
import {
  PdfError,
  PdfErrorCodeValue,
  PdfExtractPagesInputSchema,
  PdfMergeDocumentsSchema,
  PdfMergeOptionsSchema,
  PdfOperationValue,
  PdfSchemaNameValue,
} from "./config.js";
import type { PdfExtractPagesInput, PdfMergeOptions, PdfOperation } from "./config.js";

const copyPages = Effect.fn(function* (
  sources: PdfCoreMergeSources,
  operation: PdfOperation,
  signedSources?: PdfMergeOptions["signedSources"],
) {
  if (signedSources !== "flatten") {
    yield* Effect.forEach(
      sources,
      ({ pdf }) =>
        Effect.gen(function* () {
          const signed = yield* hasPdfSignatureDictionaryEffect(pdf, operation);
          if (signed) {
            return yield* new PdfError({
              code: PdfErrorCodeValue.invalidBuilderInput,
              retryable: false,
              operation,
              reason: "PDF page copying does not accept signed or document-timestamp sources.",
            });
          }
        }),
      { discard: true },
    );
  }

  const core = yield* PdfCore;
  return yield* core.merge(sources, { dropWidgets: true }).pipe(
    Effect.mapError(
      (error) =>
        new PdfError({
          code: Match.value(error.code).pipe(
            Match.when(PdfCoreErrorCodeValue.encryptedPdf, () => PdfErrorCodeValue.encryptedPdf),
            Match.when(PdfCoreErrorCodeValue.limitExceeded, () => PdfErrorCodeValue.limitExceeded),
            Match.when(
              PdfCoreErrorCodeValue.invalidOptions,
              () => PdfErrorCodeValue.invalidBuilderInput,
            ),
            Match.orElse(() => PdfErrorCodeValue.invalidPdf),
          ),
          retryable: false,
          operation,
          reason: error.reason ?? "Failed to copy PDF pages.",
        }),
    ),
  );
});

export const mergePdfs = (
  documents: ReadonlyArray<Uint8Array>,
  options: PdfMergeOptions = {},
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  Effect.gen(function* () {
    const operation = PdfOperationValue.mergeDocuments;
    const valid = yield* Schema.decodeUnknownEffect(PdfMergeDocumentsSchema)(documents).pipe(
      Effect.mapError(
        (issue) =>
          new PdfError({
            code: PdfErrorCodeValue.invalidBuilderInput,
            retryable: false,
            operation,
            schemaName: PdfSchemaNameValue.pdfMergeDocuments,
            reason: "PDF merge input failed schema validation.",
            issueMessage: String(issue),
          }),
      ),
    );
    const { signedSources } = yield* Schema.decodeUnknownEffect(PdfMergeOptionsSchema)(
      options,
    ).pipe(
      Effect.mapError(
        (issue) =>
          new PdfError({
            code: PdfErrorCodeValue.invalidBuilderInput,
            retryable: false,
            operation,
            schemaName: PdfSchemaNameValue.pdfMergeOptions,
            reason: "PDF merge options failed schema validation.",
            issueMessage: String(issue),
          }),
      ),
    );
    return yield* copyPages(
      valid.map((pdf) => ({ pdf })),
      operation,
      signedSources,
    );
  });

export const extractPdfPages = (
  pdf: PdfExtractPagesInput["pdf"],
  pageIndexes: ReadonlyArray<number>,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  Effect.gen(function* () {
    const operation = PdfOperationValue.extractPages;
    const source = yield* Schema.decodeUnknownEffect(PdfExtractPagesInputSchema)({
      pdf,
      pageIndexes,
    }).pipe(
      Effect.mapError(
        (issue) =>
          new PdfError({
            code: PdfErrorCodeValue.invalidBuilderInput,
            retryable: false,
            operation,
            schemaName: PdfSchemaNameValue.pdfExtractPagesInput,
            reason: "PDF page extraction input failed schema validation.",
            issueMessage: String(issue),
          }),
      ),
    );
    return yield* copyPages([source], operation);
  });
