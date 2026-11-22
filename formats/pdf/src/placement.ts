import { PdfCoreErrorCodeValue } from "@signature-kit/pdf-core/config";
import type {
  PdfCoreAnnotation,
  PdfCoreDocument,
  PdfCoreDocumentOptions,
  PdfCoreDocumentPage,
  PdfCoreFieldTarget,
  PdfCoreSignatureSlotFailure,
} from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Effect, Match } from "effect";
import { PdfError, PdfErrorCodeValue, PdfOperationValue } from "./config.js";
import type {
  PdfCoordinateTuple,
  PdfSignatureAnchor,
  PdfSignatureAppearance,
  PdfSignatureRect,
} from "./config.js";
import {
  pdfCoordinateTupleFromPdfPageGeometry,
  topLeftRectFromPdfPageGeometry,
  visiblePdfPageSizeFromGeometry,
} from "./stamp.js";

const DEFAULT_AUTO_WIDTH = 180;
const DEFAULT_AUTO_HEIGHT = 54;
const DEFAULT_AUTO_MARGIN = 36;
const DEFAULT_AUTO_GAP = 8;
const DEFAULT_AUTO_ANCHOR: PdfSignatureAnchor = "bottom-right";

type PdfRectangle = {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
};

type PlacementRectangle = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

type ExistingSignatureSlot = {
  readonly widget: PdfCoreAnnotation;
  readonly field: PdfCoreFieldTarget;
  readonly widgetRect: PdfCoordinateTuple;
  readonly rect: PlacementRectangle;
};

export type ResolvedPdfSignaturePlacement = {
  readonly pageIndex: number;
  readonly widgetRect: PdfCoordinateTuple;
  readonly invisible?: true;
  readonly existingWidgetObject?: PdfCoreAnnotation;
  readonly existingSignatureFieldObject?: PdfCoreFieldTarget;
};

const signatureSlotFailureReasons = {
  cyclic: "Signature widget field hierarchy is cyclic.",
  invalidParent: "Signature widget field hierarchy has an invalid parent.",
  depth: "Signature widget field hierarchy exceeds the supported depth.",
} satisfies Record<PdfCoreSignatureSlotFailure, string>;

const rectangleFromCoordinates = (
  left: number,
  bottom: number,
  right: number,
  top: number,
): PdfRectangle => ({
  left: Math.min(left, right),
  bottom: Math.min(bottom, top),
  right: Math.max(left, right),
  top: Math.max(bottom, top),
});

const placementRectangleFromEdges = (
  left: number,
  top: number,
  right: number,
  bottom: number,
): PlacementRectangle => ({ left, top, right, bottom });

const isVisibleWidgetRect = ([left, bottom, right, top]: PdfCoordinateTuple): boolean =>
  Number.isFinite(left) &&
  Number.isFinite(bottom) &&
  Number.isFinite(right) &&
  Number.isFinite(top) &&
  left < right &&
  bottom < top;

const placementRectangleFromPdfCoordinates = (
  rect: PdfRectangle,
  page: PdfCoreDocumentPage,
): PlacementRectangle => {
  const visibleRect = topLeftRectFromPdfPageGeometry(
    [rect.left, rect.bottom, rect.right, rect.top],
    page,
  );
  return placementRectangleFromEdges(
    visibleRect.x,
    visibleRect.y,
    visibleRect.x + visibleRect.width,
    visibleRect.y + visibleRect.height,
  );
};

const placementRectangleFitsVisiblePage = (
  rect: PlacementRectangle,
  page: PdfCoreDocumentPage,
): boolean => {
  const { width, height } = visiblePdfPageSizeFromGeometry(page);
  return rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height;
};

const MAX_AUTO_PLACEMENT_CANDIDATES = 100_000;
const MAX_AUTO_PLACEMENT_OBSTACLES = 10_000;
const MAX_AUTO_PLACEMENT_COMPARISONS = 1_000_000;

const pageAnnotationRectangles = (
  page: PdfCoreDocumentPage,
  annotations: ReadonlyArray<PdfCoreAnnotation>,
): ReadonlyArray<PlacementRectangle> =>
  annotations.flatMap((annotation) =>
    annotation.rect === undefined
      ? []
      : [placementRectangleFromPdfCoordinates(rectangleFromCoordinates(...annotation.rect), page)],
  );

type SignatureSlotCandidate =
  | ExistingSignatureSlot
  | {
      readonly malformed: true;
      readonly rect: PlacementRectangle;
      readonly reason: string;
    };

const pageSignatureSlots = (
  page: PdfCoreDocumentPage,
  annotations: ReadonlyArray<PdfCoreAnnotation>,
): ReadonlyArray<SignatureSlotCandidate> => {
  const slots: Array<SignatureSlotCandidate> = [];
  for (const widget of annotations) {
    const widgetRect = widget.rect;
    if (!widget.widget || widgetRect === undefined || !isVisibleWidgetRect(widgetRect)) continue;
    const rect = placementRectangleFromPdfCoordinates(
      rectangleFromCoordinates(...widgetRect),
      page,
    );
    if (!placementRectangleFitsVisiblePage(rect, page)) continue;
    const slot = widget.signatureSlot;
    if (slot.kind === "open") slots.push({ widget, field: slot.field, widgetRect, rect });
    if (slot.kind === "malformed") {
      slots.push({ malformed: true, rect, reason: signatureSlotFailureReasons[slot.reason] });
    }
  }
  return slots;
};

const anchorPoint = (
  rect: PlacementRectangle,
  anchor: PdfSignatureAnchor,
): readonly [number, number] => {
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;

  switch (anchor) {
    case "bottom-left":
      return [rect.left, rect.bottom];
    case "bottom-center":
      return [centerX, rect.bottom];
    case "bottom-right":
      return [rect.right, rect.bottom];
    case "middle-left":
      return [rect.left, centerY];
    case "middle-center":
      return [centerX, centerY];
    case "middle-right":
      return [rect.right, centerY];
    case "top-left":
      return [rect.left, rect.top];
    case "top-center":
      return [centerX, rect.top];
    case "top-right":
      return [rect.right, rect.top];
  }
};

const squaredAnchorDistance = (
  candidate: PlacementRectangle,
  bounds: PlacementRectangle,
  anchor: PdfSignatureAnchor,
): number => {
  const target = anchorPoint(bounds, anchor);
  const candidatePoint = anchorPoint(candidate, anchor);
  const deltaX = target[0] - candidatePoint[0];
  const deltaY = target[1] - candidatePoint[1];
  return deltaX * deltaX + deltaY * deltaY;
};

type PlacementAxis = {
  readonly start: number;
  readonly end: number;
  readonly step: number;
  readonly regularPositions: number;
  readonly positions: number;
};

const resolvedVisibleWidgetPlacement = (
  pageIndex: number,
  widgetRect: PdfCoordinateTuple,
): Effect.Effect<ResolvedPdfSignaturePlacement, PdfError> =>
  isVisibleWidgetRect(widgetRect)
    ? Effect.succeed({ pageIndex, widgetRect })
    : Effect.fail(
        new PdfError({
          code: PdfErrorCodeValue.signaturePlacementFailed,
          retryable: false,
          reason: "Signature widget coordinates must form a finite non-empty rectangle.",
          operation: PdfOperationValue.placeholder,
        }),
      );

const placementAxis = (
  start: number,
  end: number,
  step: number,
): Effect.Effect<PlacementAxis, PdfError> => {
  if (start === end) {
    return Effect.succeed({ start, end, step, regularPositions: 1, positions: 1 });
  }

  if (start + step <= start) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.signaturePlacementFailed,
        retryable: false,
        reason: "Automatic signature placement grid cannot advance at the selected precision.",
        operation: PdfOperationValue.placeholder,
      }),
    );
  }

  let regularPositions = Math.floor((end - start) / step) + 1;
  if (!Number.isSafeInteger(regularPositions) || regularPositions > MAX_AUTO_PLACEMENT_CANDIDATES) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.signaturePlacementFailed,
        retryable: false,
        reason: "Automatic signature placement grid is too dense.",
        operation: PdfOperationValue.placeholder,
      }),
    );
  }

  let lastPosition = start + (regularPositions - 1) * step;
  if (lastPosition > end) {
    regularPositions -= 1;
    lastPosition = start + (regularPositions - 1) * step;
  }
  const positions = regularPositions + (lastPosition === end ? 0 : 1);
  if (!Number.isSafeInteger(positions) || positions > MAX_AUTO_PLACEMENT_CANDIDATES) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.signaturePlacementFailed,
        retryable: false,
        reason: "Automatic signature placement grid is too dense.",
        operation: PdfOperationValue.placeholder,
      }),
    );
  }

  return Effect.succeed({ start, end, step, regularPositions, positions });
};

const rectanglesOverlap = (
  left: PlacementRectangle,
  right: PlacementRectangle,
  gap: number,
): boolean =>
  left.left < right.right + gap &&
  left.right > right.left - gap &&
  left.top < right.bottom + gap &&
  left.bottom > right.top - gap;

const hasCollision = (
  candidate: PlacementRectangle,
  obstacles: ReadonlyArray<PlacementRectangle>,
  gap: number,
): boolean => {
  for (const obstacle of obstacles) {
    if (rectanglesOverlap(candidate, obstacle, gap)) return true;
  }
  return false;
};

const chooseAutoRect = (
  bounds: PlacementRectangle,
  obstacles: ReadonlyArray<PlacementRectangle>,
  width: number,
  height: number,
  gap: number,
  anchor: PdfSignatureAnchor,
): Effect.Effect<PlacementRectangle | undefined, PdfError> =>
  Effect.gen(function* () {
    const maxLeft = bounds.right - width;
    const maxTop = bounds.bottom - height;
    const horizontal = yield* placementAxis(bounds.left, maxLeft, width + gap);
    const vertical = yield* placementAxis(bounds.top, maxTop, height + gap);
    if (horizontal.positions > Math.floor(MAX_AUTO_PLACEMENT_CANDIDATES / vertical.positions)) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.signaturePlacementFailed,
        retryable: false,
        reason: "Automatic signature placement grid is too dense.",
        operation: PdfOperationValue.placeholder,
      });
    }
    const candidateCount = horizontal.positions * vertical.positions;
    if (
      obstacles.length > MAX_AUTO_PLACEMENT_OBSTACLES ||
      (obstacles.length > 0 &&
        candidateCount > Math.floor(MAX_AUTO_PLACEMENT_COMPARISONS / obstacles.length))
    ) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.signaturePlacementFailed,
        retryable: false,
        reason: "Automatic signature placement scan exceeds the supported comparison budget.",
        operation: PdfOperationValue.placeholder,
      });
    }

    let bestRect: PlacementRectangle | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    let previousLeft: number | undefined;

    for (let column = 0; column < horizontal.positions; column += 1) {
      const left =
        column < horizontal.regularPositions
          ? horizontal.start + column * horizontal.step
          : horizontal.end;
      if (previousLeft !== undefined && left <= previousLeft) {
        return yield* new PdfError({
          code: PdfErrorCodeValue.signaturePlacementFailed,
          retryable: false,
          reason: "Automatic signature placement grid cannot advance at the selected precision.",
          operation: PdfOperationValue.placeholder,
        });
      }
      previousLeft = left;

      let previousTop: number | undefined;
      for (let row = 0; row < vertical.positions; row += 1) {
        const top =
          row < vertical.regularPositions ? vertical.start + row * vertical.step : vertical.end;
        if (previousTop !== undefined && top <= previousTop) {
          return yield* new PdfError({
            code: PdfErrorCodeValue.signaturePlacementFailed,
            retryable: false,
            reason: "Automatic signature placement grid cannot advance at the selected precision.",
            operation: PdfOperationValue.placeholder,
          });
        }
        previousTop = top;

        const candidate = placementRectangleFromEdges(left, top, left + width, top + height);
        if (!hasCollision(candidate, obstacles, gap)) {
          const score = squaredAnchorDistance(candidate, bounds, anchor);
          if (score < bestScore) {
            bestScore = score;
            bestRect = candidate;
          }
        }
      }
    }

    return bestRect;
  });

const chooseExistingSignatureSlot = (
  bounds: PlacementRectangle,
  slots: ReadonlyArray<SignatureSlotCandidate>,
  anchor: PdfSignatureAnchor,
): SignatureSlotCandidate | undefined => {
  let bestSlot: SignatureSlotCandidate | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const slot of slots) {
    const score = squaredAnchorDistance(slot.rect, bounds, anchor);
    if (score < bestScore) {
      bestScore = score;
      bestSlot = slot;
    }
  }

  return bestSlot;
};

const resolvedPageIndex = (
  pageCount: number,
  requestedPageIndex: number | undefined,
  placementPage: "first" | "last" | undefined,
): Effect.Effect<number, PdfError> => {
  const pageIndex = requestedPageIndex ?? (placementPage === "last" ? pageCount - 1 : 0);

  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.invalidPdf,
        retryable: false,
        reason: "The selected PDF page does not exist.",
        operation: PdfOperationValue.placeholder,
      }),
    );
  }

  return Effect.succeed(pageIndex);
};

const resolveAutoPlacement = (
  pdf: Uint8Array,
  document: PdfCoreDocument,
  pageIndex: number,
  appearance: PdfSignatureAppearance,
): Effect.Effect<ResolvedPdfSignaturePlacement, PdfError, PdfCore> =>
  Effect.gen(function* () {
    const placement = appearance.placement;
    const page = document.pages[pageIndex];
    if (page === undefined) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.invalidPdf,
        retryable: false,
        reason: "The selected PDF page does not exist.",
        operation: PdfOperationValue.placeholder,
      });
    }

    const width =
      placement?.kind === "auto" ? (placement.width ?? DEFAULT_AUTO_WIDTH) : DEFAULT_AUTO_WIDTH;
    const height =
      placement?.kind === "auto" ? (placement.height ?? DEFAULT_AUTO_HEIGHT) : DEFAULT_AUTO_HEIGHT;
    const margin =
      placement?.kind === "auto" ? (placement.margin ?? DEFAULT_AUTO_MARGIN) : DEFAULT_AUTO_MARGIN;
    const gap = placement?.kind === "auto" ? (placement.gap ?? DEFAULT_AUTO_GAP) : DEFAULT_AUTO_GAP;
    const anchor =
      placement?.kind === "auto" ? (placement.anchor ?? DEFAULT_AUTO_ANCHOR) : DEFAULT_AUTO_ANCHOR;

    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      !Number.isFinite(margin) ||
      !Number.isFinite(gap) ||
      width <= 0 ||
      height <= 0 ||
      margin < 0 ||
      gap < 0
    ) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.signaturePlacementFailed,
        retryable: false,
        reason: "Automatic signature placement dimensions must be finite positive numbers.",
        operation: PdfOperationValue.placeholder,
      });
    }

    const { width: pageWidth, height: pageHeight } = visiblePdfPageSizeFromGeometry(page);
    const availableWidth = pageWidth - margin * 2;
    const availableHeight = pageHeight - margin * 2;
    if (width > availableWidth || height > availableHeight) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.signaturePlacementFailed,
        retryable: false,
        reason: "Automatic signature placement does not fit inside the selected page margins.",
        operation: PdfOperationValue.placeholder,
      });
    }
    const bounds = placementRectangleFromEdges(
      margin,
      margin,
      pageWidth - margin,
      pageHeight - margin,
    );
    if (page.annotationCount > MAX_AUTO_PLACEMENT_OBSTACLES) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.signaturePlacementFailed,
        retryable: false,
        reason: "Automatic signature placement scan exceeds the supported comparison budget.",
        operation: PdfOperationValue.placeholder,
      });
    }
    const annotations =
      page.annotationCount === 0
        ? []
        : (yield* describePdf(pdf, { annotationPages: [pageIndex] })).annotations;
    const existingSlot = chooseExistingSignatureSlot(
      bounds,
      pageSignatureSlots(page, annotations),
      anchor,
    );
    if (existingSlot !== undefined) {
      if ("malformed" in existingSlot) {
        return yield* new PdfError({
          code: PdfErrorCodeValue.signaturePlacementFailed,
          retryable: false,
          reason: existingSlot.reason,
          operation: PdfOperationValue.placeholder,
        });
      }
      return {
        pageIndex,
        widgetRect: existingSlot.widgetRect,
        existingWidgetObject: existingSlot.widget,
        existingSignatureFieldObject: existingSlot.field,
      };
    }

    const chosen = yield* chooseAutoRect(
      bounds,
      pageAnnotationRectangles(page, annotations),
      width,
      height,
      gap,
      anchor,
    );
    if (chosen === undefined) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.signaturePlacementFailed,
        retryable: false,
        reason: "No empty signature placement slot was found on the selected page.",
        operation: PdfOperationValue.placeholder,
      });
    }
    const widgetRect = pdfCoordinateTupleFromPdfPageGeometry(
      {
        pageIndex,
        x: chosen.left,
        y: chosen.top,
        width: chosen.right - chosen.left,
        height: chosen.bottom - chosen.top,
      } satisfies PdfSignatureRect,
      page,
    );
    return { pageIndex, widgetRect };
  });

export const describePdf = (
  pdf: Uint8Array,
  options: PdfCoreDocumentOptions,
): Effect.Effect<PdfCoreDocument, PdfError, PdfCore> =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    return yield* core.document(pdf, options);
  }).pipe(
    Effect.mapError(
      (error) =>
        new PdfError({
          code: Match.value(error.code).pipe(
            Match.when(PdfCoreErrorCodeValue.limitExceeded, () => PdfErrorCodeValue.limitExceeded),
            Match.orElse(() => PdfErrorCodeValue.invalidPdf),
          ),
          retryable: false,
          operation: PdfOperationValue.placeholder,
          ...(error.reason === undefined ? {} : { reason: error.reason }),
        }),
    ),
  );

export const resolvePlacementForDocument = (
  pdf: Uint8Array,
  document: PdfCoreDocument,
  appearance: PdfSignatureAppearance,
): Effect.Effect<ResolvedPdfSignaturePlacement, PdfError, PdfCore> => {
  const placement = appearance.placement;
  if (appearance.widgetRect !== undefined && placement !== undefined) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.invalidBuilderInput,
        retryable: false,
        operation: PdfOperationValue.placeholder,
        reason: "Signature appearance accepts either widgetRect or placement, not both.",
      }),
    );
  }
  const hasPlacementPageSelector =
    placement?.pageIndex !== undefined ||
    (placement?.kind === "auto" && placement.page !== undefined);
  if (appearance.pageIndex !== undefined && hasPlacementPageSelector) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.invalidBuilderInput,
        retryable: false,
        operation: PdfOperationValue.placeholder,
        reason: "Signature appearance accepts exactly one page selector.",
      }),
    );
  }
  if (
    placement?.kind === "auto" &&
    placement.page !== undefined &&
    placement.pageIndex !== undefined
  ) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.invalidBuilderInput,
        retryable: false,
        operation: PdfOperationValue.placeholder,
        reason: "Automatic signature placement accepts either page or pageIndex, not both.",
      }),
    );
  }
  const placementPage = placement?.kind === "auto" ? (placement.page ?? "last") : undefined;
  const requestedPageIndex = placement?.pageIndex ?? appearance.pageIndex;

  return resolvedPageIndex(document.pages.length, requestedPageIndex, placementPage).pipe(
    Effect.flatMap((pageIndex): Effect.Effect<ResolvedPdfSignaturePlacement, PdfError, PdfCore> => {
      if (placement?.kind === "manual") {
        return resolvedVisibleWidgetPlacement(pageIndex, placement.widgetRect);
      }
      if (placement?.kind === "invisible") {
        return Effect.succeed({ pageIndex, widgetRect: [0, 0, 0, 0], invisible: true });
      }
      if (placement?.kind === "auto") {
        return resolveAutoPlacement(pdf, document, pageIndex, appearance);
      }
      if (appearance.widgetRect === undefined) {
        return Effect.succeed({ pageIndex, widgetRect: [0, 0, 0, 0], invisible: true });
      }

      return resolvedVisibleWidgetPlacement(pageIndex, appearance.widgetRect);
    }),
    Effect.withSpan("pdf.placement.resolve", {
      attributes: {
        "signature_kit.pdf.page_count": document.pages.length,
        "signature_kit.pdf.placement_kind": placement?.kind ?? "widget",
      },
    }),
  );
};

export const resolveSignatureWidgetPlacement = (
  pdf: Uint8Array,
  appearance: PdfSignatureAppearance,
): Effect.Effect<ResolvedPdfSignaturePlacement, PdfError, PdfCore> =>
  describePdf(pdf, {}).pipe(
    Effect.flatMap((document) => resolvePlacementForDocument(pdf, document, appearance)),
  );
