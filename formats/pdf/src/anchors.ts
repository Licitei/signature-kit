import { PdfCoreErrorCodeValue } from "@signature-kit/pdf-core/config";
import type { PdfCoreEditOperation, PdfCoreInspection } from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect, Match, Schema } from "effect";
import { hasPdfByteRange } from "./byte-range.js";
import {
  clampCoordinate,
  topLeftRectFromPdfPageGeometry,
  visiblePdfPageSizeFromGeometry,
} from "./stamp.js";
import {
  PdfError,
  PdfErrorCodeValue,
  PdfOperationValue,
  PdfSchemaNameValue,
  PdfTextAnchorSearchInputSchema,
} from "./config.js";
import type {
  PdfSignaturePage,
  PdfSignatureRect,
  PdfTextAnchorMatcher,
  PdfTextAnchorSearchInput,
  PdfTextBox,
} from "./config.js";

const DEFAULT_ANCHOR_OFFSET = 4;

type PdfLinkAnchorMatcher = Extract<PdfTextAnchorMatcher, { readonly link: string }>;
type PdfContentAnchorMatcher = Exclude<PdfTextAnchorMatcher, PdfLinkAnchorMatcher>;

const isLinkAnchorMatcher = (matcher: PdfTextAnchorMatcher): matcher is PdfLinkAnchorMatcher =>
  "link" in matcher;

const isContentAnchorMatcher = (
  matcher: PdfTextAnchorMatcher,
): matcher is PdfContentAnchorMatcher => !("link" in matcher);

const linkAnchorUris = (matchers: ReadonlyArray<PdfTextAnchorMatcher>): ReadonlySet<string> =>
  new Set(matchers.filter(isLinkAnchorMatcher).map((matcher) => matcher.link));

const CPF_CNPJ_DIGIT_SEPARATORS = /[./-]/gu;
const MAXIMAL_DIGIT_RUN_PATTERN = /\d+/gu;

const digitRunsFromText = (value: string): ReadonlyArray<string> =>
  value
    .split(/\s+/gu)
    .flatMap(
      (part) => part.replace(CPF_CNPJ_DIGIT_SEPARATORS, "").match(MAXIMAL_DIGIT_RUN_PATTERN) ?? [],
    );

const matcherMatches = (
  text: string,
  digitRuns: ReadonlyArray<string>,
  matcher: PdfContentAnchorMatcher,
): boolean => {
  if ("text" in matcher) {
    return text.includes(matcher.text);
  }
  const normalizedMatcherDigits = matcher.digits.replace(/\D/gu, "");
  return digitRuns.some((run) => run === normalizedMatcherDigits);
};

const boxMatches = (box: PdfTextBox, matchers: ReadonlyArray<PdfContentAnchorMatcher>): boolean => {
  const text = box.text ?? "";
  if (text.length === 0) return false;
  const digitRuns = digitRunsFromText(text);
  return matchers.some((matcher) => matcherMatches(text, digitRuns, matcher));
};

const rectForAnchorBox = (
  page: PdfSignaturePage,
  box: PdfTextBox,
  input: PdfTextAnchorSearchInput,
): PdfSignatureRect => {
  const width = Math.min(input.stampSize.width, page.width);
  const height = Math.min(input.stampSize.height, page.height);
  const maxX = Math.max(0, page.width - width);
  const maxY = Math.max(0, page.height - height);
  const offset = input.offset ?? DEFAULT_ANCHOR_OFFSET;
  const preferredY =
    input.placement === "above" ? box.y - offset - height : box.y + box.height + offset;

  return {
    pageIndex: page.index,
    x: clampCoordinate(box.x, 0, maxX),
    y: clampCoordinate(preferredY, 0, maxY),
    width,
    height,
  };
};

type ResolvedAnchorGeometry = {
  readonly pageTextBoxes: ReadonlyArray<{
    readonly page: PdfSignaturePage;
    readonly textBoxes: ReadonlyArray<PdfTextBox>;
  }>;
};

type PdfTextAnchorSearchWithGeometry = Omit<
  PdfTextAnchorSearchInput,
  "matchers" | "pages" | "textBoxes"
> & {
  readonly matchers: ReadonlyArray<PdfContentAnchorMatcher>;
  readonly pages: ReadonlyArray<PdfSignaturePage>;
  readonly textBoxes: ReadonlyArray<ReadonlyArray<PdfTextBox>>;
};

const resolvedAnchorGeometry = (
  pages: ReadonlyArray<PdfSignaturePage>,
  textBoxes: ReadonlyArray<ReadonlyArray<PdfTextBox>>,
): Effect.Effect<ResolvedAnchorGeometry, PdfError> => {
  const declaredPageIndexes = new Set<number>();
  let greatestPageIndex = -1;
  for (const page of pages) {
    if (declaredPageIndexes.has(page.index)) {
      return Effect.fail(
        new PdfError({
          code: PdfErrorCodeValue.invalidBuilderInput,
          retryable: false,
          operation: PdfOperationValue.findTextAnchors,
          schemaName: PdfSchemaNameValue.pdfTextAnchorSearchInput,
          reason: `Text-anchor pages declare duplicate page index ${page.index}.`,
        }),
      );
    }
    declaredPageIndexes.add(page.index);
    greatestPageIndex = Math.max(greatestPageIndex, page.index);
  }
  if (textBoxes.length !== greatestPageIndex + 1) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.invalidBuilderInput,
        retryable: false,
        operation: PdfOperationValue.findTextAnchors,
        schemaName: PdfSchemaNameValue.pdfTextAnchorSearchInput,
        reason: "Text-anchor textBoxes must cover exactly the declared page-index range.",
      }),
    );
  }
  for (const [pageIndex, boxes] of textBoxes.entries()) {
    if (!declaredPageIndexes.has(pageIndex) && boxes.length > 0) {
      return Effect.fail(
        new PdfError({
          code: PdfErrorCodeValue.invalidBuilderInput,
          retryable: false,
          operation: PdfOperationValue.findTextAnchors,
          schemaName: PdfSchemaNameValue.pdfTextAnchorSearchInput,
          reason: `Text-anchor textBoxes reference undeclared page ${pageIndex}.`,
        }),
      );
    }
  }
  const pageTextBoxes: Array<{
    readonly page: PdfSignaturePage;
    readonly textBoxes: ReadonlyArray<PdfTextBox>;
  }> = [];
  for (const page of pages) {
    const boxes = textBoxes[page.index];
    if (boxes === undefined) {
      return Effect.fail(
        new PdfError({
          code: PdfErrorCodeValue.invalidBuilderInput,
          retryable: false,
          operation: PdfOperationValue.findTextAnchors,
          schemaName: PdfSchemaNameValue.pdfTextAnchorSearchInput,
          reason: `Text-anchor textBoxes omit declared page ${page.index}.`,
        }),
      );
    }
    pageTextBoxes.push({ page, textBoxes: boxes });
  }
  return Effect.succeed({ pageTextBoxes });
};

const textBoxesFromInspection = (
  inspection: PdfCoreInspection,
  pageCount: number,
): ReadonlyArray<ReadonlyArray<PdfTextBox>> => {
  const textBoxes: Array<ReadonlyArray<PdfTextBox>> = Array.from({ length: pageCount }, () => []);
  for (const textPage of inspection.text) {
    const geometry = inspection.pages[textPage.pageIndex];
    if (geometry === undefined || textPage.pageIndex >= pageCount) continue;
    const boxes: Array<PdfTextBox> = [];
    for (let item = 0; item + 1 < textPage.offsets.length; item += 1) {
      const start = textPage.offsets[item] ?? 0;
      const end = textPage.offsets[item + 1] ?? start;
      const text = textPage.text.slice(start, end);
      if (text.trim().length === 0) continue;
      const at = item * 5;
      const rect = topLeftRectFromPdfPageGeometry(
        [
          textPage.rects[at] ?? 0,
          textPage.rects[at + 1] ?? 0,
          textPage.rects[at + 2] ?? 0,
          textPage.rects[at + 3] ?? 0,
        ],
        geometry,
      );
      boxes.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, text });
    }
    textBoxes[textPage.pageIndex] = boxes;
  }
  return textBoxes;
};

const linkAnchorBoxes = (
  inspection: PdfCoreInspection,
  uris: ReadonlySet<string>,
): ReadonlyArray<{ readonly page: PdfSignaturePage; readonly box: PdfTextBox }> =>
  inspection.links.flatMap((link) => {
    const geometry = inspection.pages[link.pageIndex];
    if (geometry === undefined || !uris.has(link.uri)) return [];
    const size = visiblePdfPageSizeFromGeometry(geometry);
    return [
      {
        page: { index: link.pageIndex, width: size.width, height: size.height },
        box: topLeftRectFromPdfPageGeometry(link.rect, geometry),
      },
    ];
  });

const emptyInspection: PdfCoreInspection = { pages: [], links: [], text: [] };

const inspectPdfForAnchors = Effect.fn(function* (
  pdf: Uint8Array | undefined,
  options: { readonly text: boolean; readonly links: boolean },
  needsPages: boolean,
) {
  if (pdf === undefined) {
    return yield* new PdfError({
      code: PdfErrorCodeValue.invalidBuilderInput,
      retryable: false,
      operation: PdfOperationValue.findTextAnchors,
      reason: options.links
        ? "Link anchor search requires pdf bytes."
        : needsPages
          ? "Text-anchor search requires either pages or pdf bytes."
          : "Text-anchor search requires either textBoxes or pdf bytes.",
    });
  }
  const core = yield* PdfCore;
  return yield* core.inspect(pdf, options).pipe(
    Effect.mapError(
      (error) =>
        new PdfError({
          code: Match.value(error.code).pipe(
            Match.when(PdfCoreErrorCodeValue.wasmLoadFailed, () => PdfErrorCodeValue.pdfLoadFailed),
            Match.when(PdfCoreErrorCodeValue.limitExceeded, () => PdfErrorCodeValue.limitExceeded),
            Match.orElse(() => PdfErrorCodeValue.invalidPdf),
          ),
          retryable: false,
          operation: PdfOperationValue.findTextAnchors,
          reason: error.reason ?? "The PDF core could not inspect the document for text anchors.",
        }),
    ),
  );
});

export function findPdfTextAnchors(
  input: PdfTextAnchorSearchWithGeometry,
): Effect.Effect<ReadonlyArray<PdfSignatureRect>, PdfError>;
export function findPdfTextAnchors(
  input: PdfTextAnchorSearchInput,
): Effect.Effect<ReadonlyArray<PdfSignatureRect>, PdfError, PdfCore>;
export function findPdfTextAnchors(
  input: PdfTextAnchorSearchInput,
): Effect.Effect<ReadonlyArray<PdfSignatureRect>, PdfError, PdfCore> {
  return Effect.gen(function* () {
    const valid = yield* Schema.decodeUnknownEffect(PdfTextAnchorSearchInputSchema)(input).pipe(
      Effect.mapError(
        (issue) =>
          new PdfError({
            code: PdfErrorCodeValue.invalidBuilderInput,
            retryable: false,
            operation: PdfOperationValue.findTextAnchors,
            schemaName: PdfSchemaNameValue.pdfTextAnchorSearchInput,
            reason: "PDF text-anchor search input failed schema validation.",
            issueMessage: String(issue),
          }),
      ),
    );
    const contentMatchers = valid.matchers.filter(isContentAnchorMatcher);
    const linkUris = linkAnchorUris(valid.matchers);
    const needsText = contentMatchers.length > 0 && valid.textBoxes === undefined;
    const needsLinks = linkUris.size > 0;
    const needsPages = contentMatchers.length > 0 && valid.pages === undefined;
    const inspection =
      needsText || needsLinks || needsPages
        ? yield* inspectPdfForAnchors(valid.pdf, { text: needsText, links: needsLinks }, needsPages)
        : emptyInspection;

    const contentRects: Array<PdfSignatureRect> = [];
    if (contentMatchers.length > 0) {
      const pages =
        valid.pages ??
        inspection.pages.map((page, index) => ({
          index,
          ...visiblePdfPageSizeFromGeometry(page),
        }));
      const pageCount = pages.reduce((count, page) => Math.max(count, page.index + 1), 0);
      const { pageTextBoxes } = yield* resolvedAnchorGeometry(
        pages,
        valid.textBoxes ?? textBoxesFromInspection(inspection, pageCount),
      );
      for (const { page, textBoxes } of pageTextBoxes) {
        for (const box of textBoxes) {
          if (boxMatches(box, contentMatchers))
            contentRects.push(rectForAnchorBox(page, box, valid));
        }
      }
    }
    const linkRects = needsLinks
      ? linkAnchorBoxes(inspection, linkUris).map(({ page, box }) =>
          rectForAnchorBox(page, box, valid),
        )
      : [];
    return [...contentRects, ...linkRects];
  });
}

export const removePdfLinkAnchors = (
  pdf: Uint8Array,
  matchers: ReadonlyArray<PdfTextAnchorMatcher>,
): Effect.Effect<Uint8Array, PdfError, PdfCore> => {
  const uris = linkAnchorUris(matchers);
  if (uris.size === 0) return Effect.succeed(pdf);
  const failure = () =>
    new PdfError({
      code: PdfErrorCodeValue.invalidPdf,
      retryable: false,
      operation: PdfOperationValue.findTextAnchors,
      reason: "Failed to remove link anchors from the PDF.",
    });
  return hasPdfByteRange(pdf).pipe(
    Effect.flatMap((signed) =>
      signed
        ? Effect.succeed(pdf)
        : Effect.gen(function* () {
            const core = yield* PdfCore;
            const inspection = yield* core.inspect(pdf, { text: false, links: true }).pipe(
              Effect.mapError(
                () =>
                  new PdfError({
                    code: PdfErrorCodeValue.invalidPdf,
                    retryable: false,
                    operation: PdfOperationValue.findTextAnchors,
                    reason: "Failed to load PDF link annotations for anchor placement.",
                  }),
              ),
            );
            const annotationPages = [
              ...new Set(
                inspection.links.filter((link) => uris.has(link.uri)).map((link) => link.pageIndex),
              ),
            ];
            if (annotationPages.length === 0) return pdf;
            const document = yield* core
              .document(pdf, { annotationPages })
              .pipe(Effect.mapError(failure));
            const operations: Array<PdfCoreEditOperation> = [];
            for (const annotation of document.annotations) {
              if (
                annotation.ref === undefined ||
                annotation.rect === undefined ||
                annotation.uri === undefined ||
                !uris.has(annotation.uri)
              ) {
                continue;
              }
              operations.push({
                op: "removeItem",
                target: { base: { kind: "page", pageIndex: annotation.pageIndex } },
                key: "Annots",
                value: `${annotation.ref.number} ${annotation.ref.generation} R`,
              });
            }
            if (operations.length === 0) return pdf;
            return yield* core.edit(pdf, operations).pipe(Effect.mapError(failure));
          }),
    ),
  );
};
