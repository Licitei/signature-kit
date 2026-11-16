import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
} from "@cantoo/pdf-lib";
import type { PDFPage } from "@cantoo/pdf-lib";
import { Effect, Schema } from "effect";
import { hasPdfByteRange } from "./byte-range.js";
import { parsePdfTextBoxesBrowser } from "./liteparse-browser.js";
import type { LiteParseWorkerFactory } from "./liteparse-browser.js";
import { clampCoordinate, topLeftRectFromPdfCoordinateTuple, visiblePdfPageSize } from "./stamp.js";
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

const PDF_LINK_SUBTYPE = PDFName.of("Link");
const PDF_SUBTYPE_KEY = PDFName.of("Subtype");
const PDF_ACTION_KEY = PDFName.of("A");
const PDF_URI_KEY = PDFName.of("URI");
const PDF_RECT_KEY = PDFName.of("Rect");

type PdfLinkAnnotation = {
  readonly ref: PDFRef;
  readonly actionRef: PDFRef | undefined;
  readonly uri: string;
  readonly box: PdfTextBox;
};

const pdfLinkAnnotations = (page: PDFPage): ReadonlyArray<PdfLinkAnnotation> =>
  (page.node.Annots()?.asArray() ?? []).flatMap((ref) => {
    if (!(ref instanceof PDFRef)) return [];
    const annotation = page.doc.context.lookup(ref);
    if (!(annotation instanceof PDFDict)) return [];
    if (annotation.get(PDF_SUBTYPE_KEY) !== PDF_LINK_SUBTYPE) return [];
    const action = annotation.lookup(PDF_ACTION_KEY);
    if (!(action instanceof PDFDict)) return [];
    const uri = action.lookup(PDF_URI_KEY);
    const rect = annotation.lookup(PDF_RECT_KEY);
    if (!(uri instanceof PDFString || uri instanceof PDFHexString)) return [];
    if (!(rect instanceof PDFArray)) return [];
    const { x, y, width, height } = rect.asRectangle();
    const actionRef = annotation.get(PDF_ACTION_KEY);
    const text = uri.decodeText();
    return [
      {
        ref,
        actionRef: actionRef instanceof PDFRef ? actionRef : undefined,
        uri: text,
        box: {
          ...topLeftRectFromPdfCoordinateTuple(
            [
              Math.min(x, x + width),
              Math.min(y, y + height),
              Math.max(x, x + width),
              Math.max(y, y + height),
            ],
            page,
          ),
          text,
        },
      },
    ];
  });

const loadPdfForLinkAnchors = (pdf: Uint8Array): Effect.Effect<PDFDocument, PdfError> =>
  Effect.tryPromise({
    try: () => PDFDocument.load(pdf),
    catch: () =>
      new PdfError({
        code: PdfErrorCodeValue.invalidPdf,
        retryable: false,
        operation: PdfOperationValue.findTextAnchors,
        reason: "Failed to load PDF link annotations for anchor placement.",
      }),
  });

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

const pdfPagesFromBytes = (
  pdf: Uint8Array,
): Effect.Effect<ReadonlyArray<PdfSignaturePage>, PdfError> =>
  Effect.tryPromise({
    try: async () => {
      const pdfDoc = await PDFDocument.load(pdf);
      return pdfDoc.getPages().map((page, index) => {
        const size = visiblePdfPageSize(page);
        return { index, width: size.width, height: size.height };
      });
    },
    catch: () =>
      new PdfError({
        code: PdfErrorCodeValue.invalidPdf,
        retryable: false,
        operation: PdfOperationValue.findTextAnchors,
        reason: "Failed to load PDF pages for text-anchor placement.",
      }),
  });

type ResolvedAnchorGeometry = {
  readonly pageTextBoxes: ReadonlyArray<{
    readonly page: PdfSignaturePage;
    readonly textBoxes: ReadonlyArray<PdfTextBox>;
  }>;
};

type PdfTextAnchorSearchWithTextBoxes = PdfTextAnchorSearchInput & {
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

const resolveAnchorGeometry = (
  input: PdfTextAnchorSearchInput,
): Effect.Effect<ResolvedAnchorGeometry, PdfError, LiteParseWorkerFactory> => {
  const resolveTextBoxes = (
    pages: ReadonlyArray<PdfSignaturePage>,
  ): Effect.Effect<ResolvedAnchorGeometry, PdfError, LiteParseWorkerFactory> => {
    if (input.textBoxes !== undefined) {
      return resolvedAnchorGeometry(pages, input.textBoxes);
    }
    if (input.pdf !== undefined) {
      return parsePdfTextBoxesBrowser(input.pdf, pages.length).pipe(
        Effect.flatMap((textBoxes) => resolvedAnchorGeometry(pages, textBoxes)),
      );
    }
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.invalidBuilderInput,
        retryable: false,
        operation: PdfOperationValue.findTextAnchors,
        reason:
          "Text-anchor search requires either textBoxes or pdf bytes that LiteParse can read.",
      }),
    );
  };

  if (input.pages !== undefined) return resolveTextBoxes(input.pages);
  if (input.pdf !== undefined)
    return pdfPagesFromBytes(input.pdf).pipe(Effect.flatMap(resolveTextBoxes));
  return Effect.fail(
    new PdfError({
      code: PdfErrorCodeValue.invalidBuilderInput,
      retryable: false,
      operation: PdfOperationValue.findTextAnchors,
      reason: "Text-anchor search requires either pages or pdf bytes.",
    }),
  );
};

const contentAnchorRects = (
  input: PdfTextAnchorSearchInput,
): Effect.Effect<ReadonlyArray<PdfSignatureRect>, PdfError, LiteParseWorkerFactory> => {
  const matchers = input.matchers.filter(isContentAnchorMatcher);
  if (matchers.length === 0) return Effect.succeed([]);
  return resolveAnchorGeometry(input).pipe(
    Effect.map(({ pageTextBoxes }) =>
      pageTextBoxes.flatMap(({ page, textBoxes }) =>
        textBoxes.flatMap((box) =>
          boxMatches(box, matchers) ? [rectForAnchorBox(page, box, input)] : [],
        ),
      ),
    ),
  );
};

const linkAnchorRects = (
  input: PdfTextAnchorSearchInput,
): Effect.Effect<ReadonlyArray<PdfSignatureRect>, PdfError> => {
  const links = new Set(input.matchers.filter(isLinkAnchorMatcher).map((matcher) => matcher.link));
  if (links.size === 0) return Effect.succeed([]);
  if (input.pdf === undefined) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.invalidBuilderInput,
        retryable: false,
        operation: PdfOperationValue.findTextAnchors,
        reason: "Link anchor search requires pdf bytes.",
      }),
    );
  }
  return loadPdfForLinkAnchors(input.pdf).pipe(
    Effect.map((document) =>
      document.getPages().flatMap((page, index) => {
        const size = visiblePdfPageSize(page);
        return pdfLinkAnnotations(page)
          .filter((annotation) => links.has(annotation.uri))
          .map((annotation) =>
            rectForAnchorBox(
              { index, width: size.width, height: size.height },
              annotation.box,
              input,
            ),
          );
      }),
    ),
  );
};

export function findPdfTextAnchors(
  input: PdfTextAnchorSearchWithTextBoxes,
): Effect.Effect<ReadonlyArray<PdfSignatureRect>, PdfError>;
export function findPdfTextAnchors(
  input: PdfTextAnchorSearchInput,
): Effect.Effect<ReadonlyArray<PdfSignatureRect>, PdfError, LiteParseWorkerFactory>;
export function findPdfTextAnchors(
  input: PdfTextAnchorSearchInput,
): Effect.Effect<ReadonlyArray<PdfSignatureRect>, PdfError, LiteParseWorkerFactory> {
  return Schema.decodeUnknownEffect(PdfTextAnchorSearchInputSchema)(input).pipe(
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
    Effect.flatMap((valid) =>
      Effect.all([contentAnchorRects(valid), linkAnchorRects(valid)]).pipe(
        Effect.map(([contentRects, linkRects]) => [...contentRects, ...linkRects]),
      ),
    ),
  );
}

export const removePdfLinkAnchors = (
  pdf: Uint8Array,
  matchers: ReadonlyArray<PdfTextAnchorMatcher>,
): Effect.Effect<Uint8Array, PdfError> => {
  const links = new Set(matchers.filter(isLinkAnchorMatcher).map((matcher) => matcher.link));
  if (links.size === 0 || hasPdfByteRange(pdf)) return Effect.succeed(pdf);
  return loadPdfForLinkAnchors(pdf).pipe(
    Effect.flatMap((document) => {
      const anchors = document.getPages().flatMap((page) =>
        pdfLinkAnnotations(page)
          .filter((annotation) => links.has(annotation.uri))
          .map((annotation) => ({ page, annotation })),
      );
      if (anchors.length === 0) return Effect.succeed(pdf);
      anchors.forEach(({ page, annotation }) => {
        page.node.removeAnnot(annotation.ref);
        document.context.delete(annotation.ref);
        if (annotation.actionRef !== undefined) document.context.delete(annotation.actionRef);
      });
      return Effect.tryPromise({
        try: () => document.save(),
        catch: () =>
          new PdfError({
            code: PdfErrorCodeValue.invalidPdf,
            retryable: false,
            operation: PdfOperationValue.findTextAnchors,
            reason: "Failed to save PDF after removing link anchors.",
          }),
      });
    }),
  );
};
