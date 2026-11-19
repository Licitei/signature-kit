import { Effect, Schema } from "effect";

import {
  PdfCoreError,
  PdfCoreErrorCodeValue,
  PdfCoreOcrOptionsSchema,
  PdfCoreOcrRasterSchema,
  PdfCoreOcrResultSchema,
  PdfCoreSchemaNameValue,
} from "./config.js";
import type {
  PdfCoreBox,
  PdfCoreDisplayList,
  PdfCoreOcrOptions,
  PdfCoreOcrPlacement,
  PdfCoreOcrRaster,
  PdfCoreOcrRequest,
  PdfCoreOcrResult,
  PdfCoreOperation,
} from "./config.js";

type Page = Pick<PdfCoreOcrRequest, "pageIndex" | "pageBox" | "rotate" | "textLayer">;
type Raster = PdfCoreOcrRaster & Pick<PdfCoreOcrRequest, "jpegDecode" | "jpegCmyk">;
type PositionedWord = { readonly text: string; readonly geometry: ReadonlyArray<number> };
export type OcrPage = {
  readonly pageIndex: number;
  readonly content: { readonly text: string } | { readonly words: ReadonlyArray<PositionedWord> };
  readonly confidence?: number;
};

const positionWord = (
  {
    box: [left, top, right, bottom],
    text,
  }: Extract<PdfCoreOcrResult, { kind: "words" }>["words"][number],
  width: number,
  height: number,
  [a, b, c, d, e, f]: PdfCoreOcrPlacement,
): PositionedWord => {
  const x0 = left / width;
  const x1 = right / width;
  const y0 = 1 - bottom / height;
  const y1 = 1 - top / height;
  const [ax, bx] = [a * x0, a * x1];
  const [ay, by] = [b * x0, b * x1];
  const [cx, dx] = [c * y0, c * y1];
  const [cy, dy] = [d * y0, d * y1];
  const rect: PdfCoreBox = [
    Math.min(ax, bx) + Math.min(cx, dx) + e,
    Math.min(ay, by) + Math.min(cy, dy) + f,
    Math.max(ax, bx) + Math.max(cx, dx) + e,
    Math.max(ay, by) + Math.max(cy, dy) + f,
  ];
  return { text, geometry: [...rect, a, b, Math.hypot(c, d) * (y1 - y0)] };
};

export const recognizePages = Effect.fn(function* <E, R>(
  operation: PdfCoreOperation,
  options: PdfCoreOcrOptions<E, R> | undefined,
  pages: ReadonlyArray<Page>,
  readImage: (pageIndex: number) => Effect.Effect<Raster | undefined, PdfCoreError>,
  readRender: (pageIndex: number) => Effect.Effect<PdfCoreDisplayList | undefined, PdfCoreError>,
  markdown: boolean,
) {
  if (options === undefined) return [];
  const { policy = "auto", concurrency = 2 } = yield* Schema.decodeUnknownEffect(
    PdfCoreOcrOptionsSchema,
  )(options).pipe(
    Effect.mapError(
      (issue) =>
        new PdfCoreError({
          operation,
          code: PdfCoreErrorCodeValue.invalidOptions,
          schemaName: PdfCoreSchemaNameValue.ocrOptions,
          issueMessage: String(issue),
        }),
    ),
  );
  if (policy === "never") return [];
  const { recognize, render } = options;
  if (typeof recognize !== "function" || (render !== undefined && typeof render !== "function")) {
    return yield* new PdfCoreError({
      operation,
      code: PdfCoreErrorCodeValue.invalidOptions,
      schemaName: PdfCoreSchemaNameValue.ocrOptions,
      reason: "OCR recognize and render callbacks must be functions.",
    });
  }
  const candidates = pages.filter(({ textLayer }) => policy === "always" || textLayer !== "usable");
  return yield* Effect.forEach(
    candidates,
    Effect.fn(function* (page): Effect.fn.Return<OcrPage, PdfCoreError | E, R> {
      let raster = yield* readImage(page.pageIndex);
      if (raster === undefined && render !== undefined) {
        const display = yield* readRender(page.pageIndex);
        if (display !== undefined) {
          const rendered = yield* render(display);
          raster = yield* Schema.decodeUnknownEffect(PdfCoreOcrRasterSchema)(rendered).pipe(
            Effect.mapError(
              (issue) =>
                new PdfCoreError({
                  operation,
                  code: PdfCoreErrorCodeValue.pageImageUnavailable,
                  pageIndex: page.pageIndex,
                  reason: "The OCR renderer returned an invalid page image.",
                  issueMessage: String(issue),
                }),
            ),
          );
        }
      }
      if (raster === undefined) {
        return yield* new PdfCoreError({
          operation,
          code: PdfCoreErrorCodeValue.pageImageUnavailable,
          pageIndex: page.pageIndex,
        });
      }

      const { placement, jpegCmyk, jpegDecode, mediaType, bytes, width, height, dpiX, dpiY } = raster;
      const raw = yield* recognize({
        ...page,
        image: { mediaType, bytes, width, height, dpiX, dpiY },
        placement,
        ...(jpegCmyk === undefined ? {} : { jpegCmyk }),
        ...(jpegDecode === undefined ? {} : { jpegDecode }),
      });
      const result = yield* Schema.decodeUnknownEffect(PdfCoreOcrResultSchema)(raw).pipe(
        Effect.mapError(
          (issue) =>
            new PdfCoreError({
              operation,
              code: PdfCoreErrorCodeValue.invalidOcrResult,
              schemaName: PdfCoreSchemaNameValue.ocrResult,
              pageIndex: page.pageIndex,
              issueMessage: String(issue),
            }),
        ),
      );
      if (result.kind === "text") {
        return {
          pageIndex: page.pageIndex,
          content: { text: markdown ? (result.markdown ?? result.text) : result.text },
        };
      }
      if (result.width !== width || result.height !== height) {
        return yield* new PdfCoreError({
          operation,
          code: PdfCoreErrorCodeValue.invalidOcrResult,
          schemaName: PdfCoreSchemaNameValue.ocrResult,
          pageIndex: page.pageIndex,
          reason: "OCR result dimensions must match the supplied image.",
        });
      }
      const missingLine = 0x1_0000_0000;
      const ordered = [...result.words].sort(
        (left, right) => (left.line ?? missingLine) - (right.line ?? missingLine),
      );
      let scored = 0;
      let total = 0;
      const words = ordered.map((word) => {
        if (word.confidence !== undefined) {
          scored += 1;
          total += word.confidence;
        }
        return positionWord(word, result.width, result.height, placement);
      });
      const confidence = scored === 0 ? undefined : total / scored;
      return {
        pageIndex: page.pageIndex,
        content: { words },
        ...(confidence === undefined ? {} : { confidence }),
      };
    }),
    { concurrency },
  );
});
