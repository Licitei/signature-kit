import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect, Schema } from "effect";
import {
  PdfError,
  PdfErrorCodeValue,
  PdfMergeDocumentsSchema,
  PdfOperationValue,
  PdfSchemaNameValue,
} from "./config.js";
import { hasPdfSignatureDictionaryEffect } from "./byte-range.js";

export const mergePdfs = (
  documents: ReadonlyArray<Uint8Array>,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  Schema.decodeUnknownEffect(PdfMergeDocumentsSchema)(documents).pipe(
    Effect.mapError(
      (issue) =>
        new PdfError({
          code: PdfErrorCodeValue.invalidBuilderInput,
          retryable: false,
          operation: PdfOperationValue.mergeDocuments,
          schemaName: PdfSchemaNameValue.pdfMergeDocuments,
          reason: "PDF merge input failed schema validation.",
          issueMessage: String(issue),
        }),
    ),
    Effect.flatMap((valid) =>
      Effect.forEach(valid, (source) =>
        hasPdfSignatureDictionaryEffect(source).pipe(
          Effect.flatMap((hasSignature) =>
            hasSignature
              ? Effect.fail(
                  new PdfError({
                    code: PdfErrorCodeValue.invalidBuilderInput,
                    retryable: false,
                    operation: PdfOperationValue.mergeDocuments,
                    reason: "PDF merge does not accept signed or document-timestamp source PDFs.",
                  }),
                )
              : Effect.void,
          ),
        ),
      ).pipe(
        Effect.flatMap(() =>
          PdfCore.pipe(
            Effect.flatMap((core) =>
              core.merge(
                valid.map((pdf) => ({ pdf })),
                { dropWidgets: true },
              ),
            ),
            Effect.mapError(
              () =>
                new PdfError({
                  code: PdfErrorCodeValue.invalidPdf,
                  retryable: false,
                  operation: PdfOperationValue.mergeDocuments,
                  reason: "Failed to merge PDF documents.",
                }),
            ),
          ),
        ),
      ),
    ),
  );
