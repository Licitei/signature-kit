import { renderDisplayListImage } from "@signature-kit/pdf-core/canvas";
import type { PdfCorePageImage } from "@signature-kit/pdf-core/canvas";
import { PdfCoreErrorCodeValue } from "@signature-kit/pdf-core/config";
import type { PdfCoreError } from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Context, Effect, Layer, Match, Schema } from "effect";

import {
  PdfError,
  PdfErrorCodeValue,
  PdfOperationValue,
  PdfPageRenderOptionsSchema,
  PdfSchemaNameValue,
} from "./config.js";
import type { PdfPageRenderOptions } from "./config.js";

const RENDER_BATCH_PAGES = 16;
const RENDER_CONCURRENCY = 4;

export type PdfPageImage = PdfCorePageImage;

const batches = (pageIndexes: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> => {
  const [first, ...rest] = pageIndexes;
  if (first === undefined) return [];
  const groups: Array<ReadonlyArray<number>> = [[first]];
  for (let start = 0; start < rest.length; start += RENDER_BATCH_PAGES) {
    groups.push(rest.slice(start, start + RENDER_BATCH_PAGES));
  }
  return groups;
};

export const renderPdfPagesBrowser = (
  pdf: Uint8Array,
  rawOptions: PdfPageRenderOptions = {},
): Effect.Effect<ReadonlyArray<PdfPageImage>, PdfError, PdfCore> =>
  Effect.gen(function* () {
    const options = yield* Schema.decodeUnknownEffect(PdfPageRenderOptionsSchema)(rawOptions).pipe(
      Effect.mapError(
        (issue) =>
          new PdfError({
            code: PdfErrorCodeValue.invalidPdf,
            retryable: false,
            operation: PdfOperationValue.renderPages,
            schemaName: PdfSchemaNameValue.pdfPageRenderOptions,
            reason: "Invalid PDF page render options.",
            issueMessage: String(issue),
          }),
      ),
    );
    const core = yield* PdfCore;
    const pageIndexes =
      options.pageIndexes ??
      (yield* core
        .inspect(pdf, { text: false, links: false })
        .pipe(Effect.map((inspection) => inspection.pages.map((_, index) => index))));
    const rendered = yield* Effect.forEach(batches(pageIndexes), (batch) =>
      Effect.gen(function* () {
        const lists = yield* core.renderPages(pdf, {
          pageIndexes: batch,
          ...(options.scale === undefined ? {} : { scale: options.scale }),
        });
        return yield* Effect.forEach(lists, (list) => renderDisplayListImage(list), {
          concurrency: RENDER_CONCURRENCY,
        });
      }),
    );
    return rendered.flat();
  }).pipe(
    Effect.catchTag("PdfCoreError", (error: PdfCoreError) =>
      Effect.fail(
        new PdfError({
          code: Match.value(error.code).pipe(
            Match.when(PdfCoreErrorCodeValue.wasmLoadFailed, () => PdfErrorCodeValue.pdfLoadFailed),
            Match.when(PdfCoreErrorCodeValue.paintFailed, () => PdfErrorCodeValue.pdfLoadFailed),
            Match.when(PdfCoreErrorCodeValue.limitExceeded, () => PdfErrorCodeValue.limitExceeded),
            Match.orElse(() => PdfErrorCodeValue.invalidPdf),
          ),
          retryable: false,
          operation: PdfOperationValue.renderPages,
          reason: error.reason ?? "The PDF pages could not be rendered.",
        }),
      ),
    ),
  );

export class PdfHandwriting extends Context.Service<
  PdfHandwriting,
  { readonly render: (text: string) => Effect.Effect<Uint8Array, PdfError> }
>()("@signature-kit/pdf/PdfHandwriting") {}

export const pdfHandwritingBrowserLayer = (font: string) =>
  Layer.succeed(PdfHandwriting, {
    render: (text) =>
      Effect.gen(function* () {
        const value = yield* Schema.decodeUnknownEffect(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
        )(text.trim()).pipe(
          Effect.mapError(
            (issue) =>
              new PdfError({
                code: PdfErrorCodeValue.stampFailed,
                retryable: false,
                operation: PdfOperationValue.stamp,
                reason: "Handwritten signature text is invalid.",
                issueMessage: String(issue),
              }),
          ),
        );
        yield* Effect.tryPromise({
          try: () => document.fonts.load(font, value),
          catch: () =>
            new PdfError({
              code: PdfErrorCodeValue.stampFailed,
              retryable: false,
              operation: PdfOperationValue.stamp,
              reason: "Handwriting font could not be loaded.",
            }),
        }).pipe(
          Effect.filterOrFail(
            (faces) => faces.length > 0,
            () =>
              new PdfError({
                code: PdfErrorCodeValue.stampFailed,
                retryable: false,
                operation: PdfOperationValue.stamp,
                reason: "Handwriting font is unavailable.",
              }),
          ),
        );
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (context === null)
          return yield* new PdfError({
            code: PdfErrorCodeValue.stampFailed,
            retryable: false,
            operation: PdfOperationValue.stamp,
            reason: "Handwriting canvas is unavailable.",
          });
        context.font = font;
        const metrics = context.measureText(value);
        canvas.width = Math.ceil(Math.min(4096, Math.max(64, metrics.width + 48)) * 2);
        canvas.height = 200;
        context.scale(2, 2);
        context.font = font;
        context.fillStyle = "#111111";
        context.textBaseline = "middle";
        context.fillText(value, 24, 50, 2000);
        const dataUrl = yield* Effect.try({
          try: () => canvas.toDataURL("image/png"),
          catch: () =>
            new PdfError({
              code: PdfErrorCodeValue.stampFailed,
              retryable: false,
              operation: PdfOperationValue.stamp,
              reason: "Handwriting PNG could not be generated.",
            }),
        });
        const prefix = "data:image/png;base64,";
        if (!dataUrl.startsWith(prefix) || dataUrl.length === prefix.length) {
          return yield* new PdfError({
            code: PdfErrorCodeValue.stampFailed,
            retryable: false,
            operation: PdfOperationValue.stamp,
            reason: "Handwriting canvas returned no PNG data.",
          });
        }
        return yield* Effect.try({
          try: () =>
            Uint8Array.from(atob(dataUrl.slice(prefix.length)), (character) =>
              character.charCodeAt(0),
            ),
          catch: () =>
            new PdfError({
              code: PdfErrorCodeValue.stampFailed,
              retryable: false,
              operation: PdfOperationValue.stamp,
              reason: "Handwriting PNG could not be decoded.",
            }),
        });
      }),
  });
