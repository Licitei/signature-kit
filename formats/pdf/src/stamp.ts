import type {
  PdfCoreDocument,
  PdfCoreEditOperation,
  PdfCoreObjectRef,
  PdfCoreWinAnsiFont,
} from "@signature-kit/pdf-core/config";
import { PdfCoreErrorCodeValue } from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import qrcode from "qrcode-generator";
import { Effect, Match, Schema } from "effect";
import { hasPdfByteRange } from "./byte-range.js";
import {
  pdfFillRects,
  pdfImage,
  pdfLine,
  pdfNumber,
  pdfPath,
  pdfStandardFont,
  pdfStrokeRect,
  pdfText,
  pdfTextEncodable,
  pdfTextLines,
  pdfTextWidth,
  pdfTransform,
} from "./content.js";
import type { PdfPathSegment, PdfRgb, PdfStandardFont } from "./content.js";
export type { PdfStandardFont } from "./content.js";
import {
  PdfError,
  PdfErrorCodeValue,
  PdfOperationValue,
  PdfRubricPageStampInputSchema,
  PdfRubricStampSchema,
  PdfSchemaNameValue,
  PdfSignatureBadgeSchema,
  PdfStampPreviewInputSchema,
  PdfVisibleStampQrSchema,
  PdfSignatureRectSchema,
} from "./config.js";
import type {
  PdfCoordinateTuple,
  PdfStampPreviewInput,
  PdfRubricInitialsTheme,
  PdfRubricPageStampInput,
  PdfRubricStamp,
  PdfSignatureBadge,
  PdfSignatureBadgeFooterSegment,
  PdfSignatureBadgeRowItem,
  PdfSignatureBadgeTheme,
  PdfSignaturePage,
  PdfSignatureRect,
  PdfStampSize,
  PdfTextBox,
  PdfVisibleStampQr,
  PdfVisibleStampInput,
} from "./config.js";
export const clampCoordinate = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const PAD = 3;
const FRAME: PdfRgb = [0.45, 0.45, 0.45];
const INK: PdfRgb = [0.1, 0.1, 0.1];
const WHITE: PdfRgb = [1, 1, 1];
const SEPARATOR_INK: PdfRgb = [0.55, 0.55, 0.55];
const MUTED_INK: PdfRgb = [0.25, 0.25, 0.25];
const BLACK: PdfRgb = [0, 0, 0];
const PAGE_TEXT_LINE_HEIGHT = 24;
const RUBRIC_RIGHT_MARGIN_PT = 18;
const RUBRIC_WIDTH_PT = 72;
const RUBRIC_HEIGHT_PT = 32;
const RUBRIC_COLLISION_PADDING_PT = 4;
const RUBRIC_INITIALS_DEFAULT_INK = "#1D4ED8";
const PORTUGUESE_NAME_CONNECTORS = ["de", "da", "do", "dos", "das", "e"];
const QR_QUIET_ZONE_MODULES = 4;
const QR_TEXT_GAP_PT = 6;
const MAX_PNG_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_PNG_PIXELS = 16 * 1024 * 1024;
type PngSignature = readonly [number, number, number, number, number, number, number, number];
type PngChunkType = readonly [number, number, number, number];

const PNG_SIGNATURE: PngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_IHDR_END = 33;
const PNG_IHDR_TYPE: PngChunkType = [73, 72, 68, 82];

type QrMatrix = {
  readonly moduleCount: number;
  readonly darkModules: ReadonlyArray<readonly [row: number, column: number]>;
};

const encodeVisibleStampQr = (qr: PdfVisibleStampQr): Effect.Effect<QrMatrix, PdfError> =>
  Effect.try({
    try: () => {
      const code = qrcode(0, "M");
      code.addData(qr.text);
      code.make();
      const moduleCount = code.getModuleCount();
      const darkModules: Array<readonly [row: number, column: number]> = [];
      for (let row = 0; row < moduleCount; row += 1) {
        for (let column = 0; column < moduleCount; column += 1) {
          if (code.isDark(row, column)) {
            darkModules.push([row, column]);
          }
        }
      }
      return { moduleCount, darkModules };
    },
    catch: () =>
      new PdfError({
        code: PdfErrorCodeValue.stampFailed,
        retryable: false,
        operation: PdfOperationValue.stamp,
        reason: "Failed to encode the visible signature QR code.",
      }),
  });

type BadgeThemeHex = { readonly [Key in keyof PdfSignatureBadgeTheme]-?: string };

const BADGE_DEFAULT_THEME: BadgeThemeHex = {
  borderColor: "#3B5BDB",
  backgroundColor: "#F0F4FF",
  headerColor: "#2F9E44",
  labelColor: "#1F2937",
  valueColor: "#111827",
  footerColor: "#6B7280",
  linkColor: "#2563EB",
  separatorColor: "#CBD5E1",
};

const BADGE_FOOTER_SEPARATOR = " | ";
const BADGE_LINK_ANNOTATION_FLAG_PRINT = 0x04;
const BADGE_HEADER_SIZE_CAP = 13.5;
const BADGE_ROW_SIZE_CAP = 10.5;
const BADGE_FOOTER_SIZE_CAP = 7.5;

type ResolvedBadgeTheme = {
  readonly borderColor: PdfRgb;
  readonly backgroundColor: PdfRgb;
  readonly headerColor: PdfRgb;
  readonly labelColor: PdfRgb;
  readonly valueColor: PdfRgb;
  readonly footerColor: PdfRgb;
  readonly linkColor: PdfRgb;
  readonly separatorColor: PdfRgb;
};

type StampFont = {
  readonly name: string;
  readonly font: PdfStandardFont;
};

type StampImage = {
  readonly name: string;
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
};

type StampLink = {
  readonly rect: PdfCoordinateTuple;
  readonly uri: string;
};

type PageDrawing = {
  readonly content: Array<string>;
  readonly resources: Set<string>;
  readonly links: Array<StampLink>;
};

const pageDrawing = (): PageDrawing => ({ content: [], resources: new Set(), links: [] });

const drawText = (
  page: PageDrawing,
  font: StampFont,
  text: string,
  options: {
    readonly x: number;
    readonly y: number;
    readonly size: number;
    readonly color: PdfRgb;
    readonly maxWidth?: number;
    readonly lineHeight?: number;
  },
): void => {
  page.resources.add(font.name);
  page.content.push(
    pdfText({
      fontName: font.name,
      font: font.font,
      size: options.size,
      x: options.x,
      y: options.y,
      color: options.color,
      lines: pdfTextLines(font.font, text, options.size, options.maxWidth),
      lineHeight: options.lineHeight ?? PAGE_TEXT_LINE_HEIGHT,
    }),
  );
};

const drawImage = (
  page: PageDrawing,
  image: StampImage,
  rect: readonly [x: number, y: number, width: number, height: number],
): void => {
  page.resources.add(image.name);
  page.content.push(pdfImage(image.name, rect));
};

type FooterLineSegment = {
  readonly segment: PdfSignatureBadgeFooterSegment;
  readonly width: number;
};

type FooterLine = {
  readonly segments: ReadonlyArray<FooterLineSegment>;
  readonly width: number;
};

export type PdfSignatureBadgeLayoutRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type PdfSignatureBadgeTextRunLayout = {
  readonly text: string;
  readonly rect: PdfSignatureBadgeLayoutRect;
  readonly baseline: number;
};

export type PdfSignatureBadgeHeaderLayout = {
  readonly rect: PdfSignatureBadgeLayoutRect;
  readonly baseline: number;
  readonly padlock: PdfSignatureBadgeLayoutRect;
  readonly text: PdfSignatureBadgeTextRunLayout;
};

export type PdfSignatureBadgeRowItemLayout = {
  readonly separator: PdfSignatureBadgeTextRunLayout | undefined;
  readonly label: PdfSignatureBadgeTextRunLayout;
  readonly value: PdfSignatureBadgeTextRunLayout;
};

export type PdfSignatureBadgeRowLayout = {
  readonly rect: PdfSignatureBadgeLayoutRect;
  readonly baseline: number;
  readonly items: ReadonlyArray<PdfSignatureBadgeRowItemLayout>;
};

export type PdfSignatureBadgeFooterSegmentLayout = {
  readonly segment: PdfSignatureBadgeFooterSegment;
  readonly separator: PdfSignatureBadgeTextRunLayout | undefined;
  readonly text: PdfSignatureBadgeTextRunLayout;
  readonly underline: PdfSignatureBadgeLayoutRect | undefined;
  readonly annotation: PdfSignatureBadgeLayoutRect | undefined;
};

export type PdfSignatureBadgeFooterLineLayout = {
  readonly rect: PdfSignatureBadgeLayoutRect;
  readonly baseline: number;
  readonly segments: ReadonlyArray<PdfSignatureBadgeFooterSegmentLayout>;
};

export type PdfSignatureBadgeLayout = {
  readonly container: PdfSignatureBadgeLayoutRect;
  readonly padding: number;
  readonly gutter: number;
  readonly radius: number;
  readonly headerSize: number;
  readonly rowSize: number;
  readonly footerSize: number;
  readonly rowLeading: number;
  readonly headerGap: number;
  readonly footerLeading: number;
  readonly separatorGap: number;
  readonly footerGap: number;
  readonly textBlock: PdfSignatureBadgeLayoutRect;
  readonly qr: PdfSignatureBadgeLayoutRect | undefined;
  readonly logo: PdfSignatureBadgeLayoutRect | undefined;
  readonly signature: PdfSignatureBadgeLayoutRect | undefined;
  readonly header: PdfSignatureBadgeHeaderLayout;
  readonly rows: ReadonlyArray<PdfSignatureBadgeRowLayout>;
  readonly separator: PdfSignatureBadgeLayoutRect | undefined;
  readonly footer: {
    readonly rect: PdfSignatureBadgeLayoutRect | undefined;
    readonly lines: ReadonlyArray<PdfSignatureBadgeFooterLineLayout>;
  };
};

const hexToRgb = (hex: string): PdfRgb => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
];

const normalizeInitialsSource = (name: string): string =>
  name.normalize("NFD").replace(/\p{Diacritic}/gu, "");

export const deriveSignerInitials = (name: string): string => {
  const normalized = normalizeInitialsSource(name);
  const words = normalized
    .split(/\s+/u)
    .map((word) => word.replace(/[^A-Za-z0-9]/gu, ""))
    .filter((word) => word.length > 0);
  const meaningful = words.filter(
    (word) => !PORTUGUESE_NAME_CONNECTORS.includes(word.toLocaleLowerCase("pt-BR")),
  );
  const source = meaningful.length > 0 ? meaningful : words;
  const initials = source
    .map((word) => word[0] ?? "")
    .filter((letter) => letter.length > 0)
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase("pt-BR");

  if (initials.length >= 2) return initials;

  const latinFallback = normalized.replace(/[^A-Za-z0-9]/gu, "").slice(0, 2);
  if (latinFallback.length > 0) return latinFallback.toLocaleUpperCase("pt-BR");

  return Array.from(name.trim().replace(/\s+/gu, ""))
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase("pt-BR");
};

const resolveRubricInitialsTheme = (
  theme: PdfRubricInitialsTheme | undefined,
): { readonly ink: PdfRgb; readonly bracket: PdfRgb; readonly background: PdfRgb | undefined } => {
  const inkColor = theme?.inkColor ?? RUBRIC_INITIALS_DEFAULT_INK;
  return {
    ink: hexToRgb(inkColor),
    bracket: hexToRgb(theme?.bracketColor ?? inkColor),
    background: theme?.backgroundColor === undefined ? undefined : hexToRgb(theme.backgroundColor),
  };
};

const drawInitialsRubric = (
  page: PageDrawing,
  font: StampFont,
  left: number,
  bottom: number,
  width: number,
  height: number,
  initials: string,
  theme: PdfRubricInitialsTheme | undefined,
): void => {
  const colors = resolveRubricInitialsTheme(theme);
  if (colors.background !== undefined) {
    page.content.push(pdfFillRects([[left, bottom, width, height]], colors.background));
  }

  const inset = Math.max(2, Math.min(width, height) * 0.14);
  const corner = Math.max(6, Math.min(width, height) * 0.28);
  const thickness = Math.max(0.8, Math.min(width, height) * 0.035);
  const x1 = left + inset;
  const x2 = left + width - inset;
  const y1 = bottom + inset;
  const y2 = bottom + height - inset;
  const drawCorner = (
    horizontalStart: readonly [number, number],
    horizontalEnd: readonly [number, number],
    verticalStart: readonly [number, number],
    verticalEnd: readonly [number, number],
  ): void => {
    page.content.push(
      pdfLine(horizontalStart, horizontalEnd, thickness, colors.bracket),
      pdfLine(verticalStart, verticalEnd, thickness, colors.bracket),
    );
  };

  drawCorner([x1, y2], [x1 + corner, y2], [x1, y2], [x1, y2 - corner]);
  drawCorner([x2, y2], [x2 - corner, y2], [x2, y2], [x2, y2 - corner]);
  drawCorner([x1, y1], [x1 + corner, y1], [x1, y1], [x1, y1 + corner]);
  drawCorner([x2, y1], [x2 - corner, y1], [x2, y1], [x2, y1 + corner]);

  const cleanInitials = deriveSignerInitials(initials);
  const textWidthAtOne = pdfTextWidth(font.font, cleanInitials, 1);
  const size = Math.max(
    6,
    Math.min(height * 0.48, textWidthAtOne > 0 ? (width - inset * 2) / textWidthAtOne : height),
  );
  const textWidth = pdfTextWidth(font.font, cleanInitials, size);
  drawText(page, font, cleanInitials, {
    x: left + (width - textWidth) / 2,
    y: bottom + (height - size) / 2 + size * 0.08,
    size,
    color: colors.ink,
  });
};

const resolveBadgeTheme = (theme: PdfSignatureBadgeTheme | undefined): ResolvedBadgeTheme => ({
  borderColor: hexToRgb(theme?.borderColor ?? BADGE_DEFAULT_THEME.borderColor),
  backgroundColor: hexToRgb(theme?.backgroundColor ?? BADGE_DEFAULT_THEME.backgroundColor),
  headerColor: hexToRgb(theme?.headerColor ?? BADGE_DEFAULT_THEME.headerColor),
  labelColor: hexToRgb(theme?.labelColor ?? BADGE_DEFAULT_THEME.labelColor),
  valueColor: hexToRgb(theme?.valueColor ?? BADGE_DEFAULT_THEME.valueColor),
  footerColor: hexToRgb(theme?.footerColor ?? BADGE_DEFAULT_THEME.footerColor),
  linkColor: hexToRgb(theme?.linkColor ?? BADGE_DEFAULT_THEME.linkColor),
  separatorColor: hexToRgb(theme?.separatorColor ?? BADGE_DEFAULT_THEME.separatorColor),
});

const roundedRectPath = (
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): ReadonlyArray<PdfPathSegment> => [
  ["move", x + radius, y],
  ["line", x + width - radius, y],
  ["curve", x + width, y, x + width, y + radius],
  ["line", x + width, y + height - radius],
  ["curve", x + width, y + height, x + width - radius, y + height],
  ["line", x + radius, y + height],
  ["curve", x, y + height, x, y + height - radius],
  ["line", x, y + radius],
  ["curve", x, y, x + radius, y],
  ["close"],
];

const drawVisibleStampQrMatrix = (
  page: PageDrawing,
  qr: QrMatrix,
  x: number,
  y: number,
  side: number,
): void => {
  const moduleSize = side / (qr.moduleCount + QR_QUIET_ZONE_MODULES * 2);
  page.content.push(
    pdfFillRects([[x, y, side, side]], WHITE),
    pdfFillRects(
      qr.darkModules.map(([row, column]) => [
        x + (column + QR_QUIET_ZONE_MODULES) * moduleSize,
        y + side - (row + QR_QUIET_ZONE_MODULES + 1) * moduleSize,
        moduleSize,
        moduleSize,
      ]),
      INK,
    ),
  );
};

type InkPngTextColumnOptions = {
  readonly page: PageDrawing;
  readonly font: StampFont;
  readonly image: StampImage | undefined;
  readonly lines: ReadonlyArray<string>;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly textColor: PdfRgb;
  readonly imageHeightRatioWithLines: number;
  readonly minTextSize: number;
  readonly textSizeOffset: number;
  readonly textPadding: number;
  readonly leading: "fixed" | "proportional";
  readonly separator: boolean;
};

const drawInkPngTextColumn = ({
  page,
  font,
  image,
  lines,
  x,
  y,
  width,
  height,
  textColor,
  imageHeightRatioWithLines,
  minTextSize,
  textSizeOffset,
  textPadding,
  leading,
  separator,
}: InkPngTextColumnOptions): void => {
  let textTop = y + height - PAD;
  const textX = x + textPadding;
  const textWidth = Math.max(0, width - textPadding * 2);

  if (image !== undefined && width > 0) {
    const maxH = height * (lines.length > 0 ? imageHeightRatioWithLines : 0.92) - PAD;
    const maxW = textWidth;
    const scale = Math.min(maxW / image.width, maxH / image.height);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    drawImage(page, image, [x + (width - drawW) / 2, y + height - drawH - PAD, drawW, drawH]);
    textTop = y + height - drawH - PAD - 1;
  }

  if (separator && image !== undefined && lines.length > 0 && textWidth > 0) {
    page.content.push(pdfLine([textX, textTop], [textX + textWidth, textTop], 0.5, SEPARATOR_INK));
  }

  if (lines.length > 0 && textWidth > 0) {
    const size = Math.max(
      minTextSize,
      Math.min(7, (textTop - y - PAD) / lines.length - textSizeOffset),
    );
    const lineGap = leading === "fixed" ? 1.5 : Math.max(0.8, size * 0.25);
    let ty = textTop - size;
    for (const line of lines) {
      drawText(page, font, line, { x: textX, y: ty, size, color: textColor, maxWidth: textWidth });
      ty -= size + lineGap;
    }
  }
};

const drawBadgePadlock = (
  page: PageDrawing,
  rect: PdfSignatureBadgeLayoutRect,
  color: PdfRgb,
): void => {
  const bodyWidth = rect.width * 0.68;
  const bodyHeight = rect.height * 0.44;
  const bodyX = rect.x + rect.width * 0.16;
  const bodyY = rect.y;
  const bodyTop = bodyY + bodyHeight;
  const shackleTop = rect.y + rect.height;
  const shackleShoulder = rect.y + rect.height * 0.64;
  page.content.push(
    pdfFillRects([[bodyX, bodyY, bodyWidth, bodyHeight]], color),
    pdfPath(
      [
        ["move", rect.x + rect.width * 0.28, bodyTop],
        ["line", rect.x + rect.width * 0.28, shackleShoulder],
        ["curve", rect.x + rect.width * 0.28, shackleTop, rect.x + rect.width * 0.5, shackleTop],
        [
          "curve",
          rect.x + rect.width * 0.72,
          shackleTop,
          rect.x + rect.width * 0.72,
          shackleShoulder,
        ],
        ["line", rect.x + rect.width * 0.72, bodyTop],
      ],
      { stroke: color, lineWidth: Math.max(0.6, rect.height * 0.09) },
    ),
  );
};

const truncateBadgeTextToWidth = (
  text: string,
  font: PdfStandardFont,
  size: number,
  maxWidth: number,
): string => {
  if (maxWidth <= 0) return "";
  if (pdfTextWidth(font, text, size) <= maxWidth) return text;
  const suffix = "...";
  const suffixWidth = pdfTextWidth(font, suffix, size);
  if (suffixWidth > maxWidth) return "";
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (pdfTextWidth(font, characters.slice(0, middle).join(""), size) <= maxWidth - suffixWidth) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${characters.slice(0, low).join("")}${suffix}`;
};

const footerLineSegmentAtSize = (
  segment: PdfSignatureBadgeFooterSegment,
  font: PdfStandardFont,
  size: number,
  maxWidth: number,
): FooterLineSegment => {
  const text = truncateBadgeTextToWidth(segment.text, font, size, maxWidth);
  return {
    segment: text === segment.text ? segment : { ...segment, text },
    width: pdfTextWidth(font, text, size),
  };
};

const footerLinesAtSize = (
  footer: ReadonlyArray<PdfSignatureBadgeFooterSegment>,
  font: PdfStandardFont,
  size: number,
  maxWidth: number,
): ReadonlyArray<FooterLine> => {
  const separatorWidth = pdfTextWidth(font, BADGE_FOOTER_SEPARATOR, size);
  const lines: Array<ReadonlyArray<FooterLineSegment>> = [];
  let current: Array<FooterLineSegment> = [];
  let currentWidth = 0;
  for (const segment of footer) {
    const measured = footerLineSegmentAtSize(segment, font, size, maxWidth);
    const gap = current.length === 0 ? 0 : separatorWidth;
    const projected = currentWidth + gap + measured.width;
    if (current.length > 0 && projected > maxWidth) {
      lines.push(current);
      current = [measured];
      currentWidth = measured.width;
    } else {
      current.push(measured);
      currentWidth = projected;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.map((line) => {
    let width = 0;
    for (let index = 0; index < line.length; index += 1) {
      width += line[index]?.width ?? 0;
      if (index > 0) width += separatorWidth;
    }
    return { segments: line, width };
  });
};

const textRunLayout = (
  text: string,
  x: number,
  baseline: number,
  width: number,
  size: number,
): PdfSignatureBadgeTextRunLayout => ({
  text,
  rect: { x, y: baseline, width, height: size },
  baseline,
});

const badgeTextBlockHeight = (
  rows: ReadonlyArray<ReadonlyArray<PdfSignatureBadgeRowItem>>,
  headerSize: number,
  headerGap: number,
  rowSize: number,
  rowLeading: number,
): number =>
  headerSize + headerGap + rows.length * rowSize + Math.max(0, rows.length - 1) * rowLeading;

const badgeFooterHeight = (
  footerLines: ReadonlyArray<FooterLine>,
  footerSize: number,
  footerLeading: number,
): number =>
  footerLines.length === 0
    ? 0
    : footerLines.length * footerSize + Math.max(0, footerLines.length - 1) * footerLeading;

type BadgeMetrics = {
  readonly headerUnit: number;
  readonly rowUnit: number;
  readonly footerUnit: number;
  readonly headerSize: number;
  readonly rowSize: number;
  readonly footerSize: number;
  readonly rowLeading: number;
  readonly headerGap: number;
  readonly footerLeading: number;
  readonly separatorGap: number;
  readonly footerGap: number;
};

const badgeMetricsAtScale = (containerHeight: number, scale: number): BadgeMetrics => {
  const headerUnit = Math.min(10, containerHeight * 0.066);
  const rowUnit = Math.min(7.4, containerHeight * 0.049);
  const footerUnit = Math.min(5.6, containerHeight * 0.037);
  const headerSize = Math.min(BADGE_HEADER_SIZE_CAP, Math.max(5, headerUnit * scale));
  const rowSize = Math.min(BADGE_ROW_SIZE_CAP, Math.max(4.2, rowUnit * scale));
  const footerSize = Math.min(BADGE_FOOTER_SIZE_CAP, Math.max(3.4, footerUnit * scale));
  return {
    headerUnit,
    rowUnit,
    footerUnit,
    headerSize,
    rowSize,
    footerSize,
    rowLeading: Math.max(1, rowSize * 0.32),
    headerGap: Math.max(1.8, rowSize * 0.55),
    footerLeading: Math.max(0.5, footerSize * 0.22),
    separatorGap: Math.max(4, rowSize * 0.7),
    footerGap: Math.max(3, footerSize * 0.6),
  };
};

const badgeInitialScale = (
  rows: ReadonlyArray<ReadonlyArray<PdfSignatureBadgeRowItem>>,
  footer: ReadonlyArray<PdfSignatureBadgeFooterSegment>,
  containerHeight: number,
  padding: number,
  innerWidth: number,
  regularFont: PdfStandardFont,
): number => {
  const innerHeight = Math.max(0, containerHeight - padding * 2);
  const metrics = badgeMetricsAtScale(containerHeight, 1);
  const footerLines = footerLinesAtSize(footer, regularFont, metrics.footerSize, innerWidth);
  const footerHeight = badgeFooterHeight(footerLines, metrics.footerSize, metrics.footerLeading);
  const separatorHeight = footerLines.length === 0 ? 0 : 0.6;
  const textBlockHeight = badgeTextBlockHeight(
    rows,
    metrics.headerSize,
    metrics.headerGap,
    metrics.rowSize,
    metrics.rowLeading,
  );
  const requiredHeight =
    textBlockHeight +
    (footerLines.length === 0
      ? 0
      : metrics.separatorGap + separatorHeight + metrics.footerGap + footerHeight);
  const headerCapScale = metrics.headerUnit > 0 ? BADGE_HEADER_SIZE_CAP / metrics.headerUnit : 1;
  const rowCapScale = metrics.rowUnit > 0 ? BADGE_ROW_SIZE_CAP / metrics.rowUnit : 1;
  const footerCapScale = metrics.footerUnit > 0 ? BADGE_FOOTER_SIZE_CAP / metrics.footerUnit : 1;
  const capScale = Math.min(headerCapScale, rowCapScale, footerCapScale);

  return requiredHeight > 0 ? Math.max(1, Math.min(innerHeight / requiredHeight, capScale)) : 1;
};
const badgeHeaderLayout = (
  badge: PdfSignatureBadge,
  baseline: number,
  headerSize: number,
  textLeft: number,
  textWidth: number,
  boldFont: PdfStandardFont,
): PdfSignatureBadgeHeaderLayout => {
  const availableWidth = Math.max(0, textWidth);
  const lockSize = Math.min(headerSize * 0.86, availableWidth);
  const gap =
    lockSize === 0
      ? 0
      : Math.min(Math.max(1.8, headerSize * 0.22), Math.max(0, availableWidth - lockSize));
  const textX = textLeft + lockSize + gap;
  const text = truncateBadgeTextToWidth(
    badge.header.text,
    boldFont,
    headerSize,
    Math.max(0, availableWidth - lockSize - gap),
  );
  const textWidthAtSize = pdfTextWidth(boldFont, text, headerSize);
  const textRect = textRunLayout(text, textX, baseline, textWidthAtSize, headerSize);
  const padlock = {
    x: textLeft,
    y: baseline + headerSize * 0.05,
    width: lockSize,
    height: lockSize,
  };
  return {
    rect: {
      x: textLeft,
      y: baseline,
      width: lockSize + gap + textRect.rect.width,
      height: headerSize,
    },
    baseline,
    padlock,
    text: textRect,
  };
};

const badgeRowsLayout = (
  rows: ReadonlyArray<ReadonlyArray<PdfSignatureBadgeRowItem>>,
  firstBaseline: number,
  rowSize: number,
  rowLeading: number,
  textLeft: number,
  textWidth: number,
  boldFont: PdfStandardFont,
  regularFont: PdfStandardFont,
): ReadonlyArray<PdfSignatureBadgeRowLayout> => {
  const rowLayouts: Array<PdfSignatureBadgeRowLayout> = [];
  const textRight = textLeft + Math.max(0, textWidth);
  let baseline = firstBaseline;
  for (const row of rows) {
    let cursor = textLeft;
    const items: Array<PdfSignatureBadgeRowItemLayout> = [];
    for (let index = 0; index < row.length; index += 1) {
      const pair = row[index];
      if (pair !== undefined) {
        let separator: PdfSignatureBadgeTextRunLayout | undefined;
        if (index > 0) {
          const text = truncateBadgeTextToWidth(
            BADGE_FOOTER_SEPARATOR,
            regularFont,
            rowSize,
            Math.max(0, textRight - cursor),
          );
          const width = pdfTextWidth(regularFont, text, rowSize);
          separator =
            text.length === 0 ? undefined : textRunLayout(text, cursor, baseline, width, rowSize);
          cursor += width;
        }
        const label = truncateBadgeTextToWidth(
          `${pair.label}: `,
          boldFont,
          rowSize,
          Math.max(0, textRight - cursor),
        );
        const labelWidth = pdfTextWidth(boldFont, label, rowSize);
        const labelRun = textRunLayout(label, cursor, baseline, labelWidth, rowSize);
        cursor += labelWidth;
        const value = truncateBadgeTextToWidth(
          pair.value,
          regularFont,
          rowSize,
          Math.max(0, textRight - cursor),
        );
        const valueWidth = pdfTextWidth(regularFont, value, rowSize);
        const valueRun = textRunLayout(value, cursor, baseline, valueWidth, rowSize);
        cursor += valueWidth;
        items.push({ separator, label: labelRun, value: valueRun });
      }
    }
    rowLayouts.push({
      rect: {
        x: textLeft,
        y: baseline,
        width: Math.max(0, cursor - textLeft),
        height: rowSize,
      },
      baseline,
      items,
    });
    baseline -= rowSize + rowLeading;
  }
  return rowLayouts;
};

const badgeFooterLayout = (
  footerLines: ReadonlyArray<FooterLine>,
  footerBottom: number,
  footerSize: number,
  footerLeading: number,
  container: PdfSignatureBadgeLayoutRect,
  padding: number,
  regularFont: PdfStandardFont,
): {
  readonly rect: PdfSignatureBadgeLayoutRect | undefined;
  readonly lines: ReadonlyArray<PdfSignatureBadgeFooterLineLayout>;
} => {
  if (footerLines.length === 0) return { rect: undefined, lines: [] };
  const separatorWidth = pdfTextWidth(regularFont, BADGE_FOOTER_SEPARATOR, footerSize);
  const footerHeight = badgeFooterHeight(footerLines, footerSize, footerLeading);
  const lineLayouts: Array<PdfSignatureBadgeFooterLineLayout> = [];
  let baseline = footerBottom + footerHeight - footerSize;
  for (const line of footerLines) {
    let cursor = container.x + (container.width - line.width) / 2;
    const segmentLayouts: Array<PdfSignatureBadgeFooterSegmentLayout> = [];
    for (let index = 0; index < line.segments.length; index += 1) {
      const item = line.segments[index];
      if (item !== undefined) {
        let separator: PdfSignatureBadgeTextRunLayout | undefined;
        if (index > 0) {
          separator = textRunLayout(
            BADGE_FOOTER_SEPARATOR,
            cursor,
            baseline,
            separatorWidth,
            footerSize,
          );
          cursor += separatorWidth;
        }
        const text = textRunLayout(item.segment.text, cursor, baseline, item.width, footerSize);
        const underline =
          item.segment.link === undefined
            ? undefined
            : {
                x: cursor,
                y: baseline - Math.max(0.6, footerSize * 0.12),
                width: item.width,
                height: Math.max(0.3, footerSize * 0.06),
              };
        const annotation =
          item.segment.link === undefined
            ? undefined
            : {
                x: cursor,
                y: baseline - Math.max(1, footerSize * 0.2),
                width: item.width,
                height: footerSize + Math.max(2, footerSize * 0.3),
              };
        segmentLayouts.push({
          segment: item.segment,
          separator,
          text,
          underline,
          annotation,
        });
        cursor += item.width;
      }
    }
    lineLayouts.push({
      rect: {
        x: container.x + padding,
        y: baseline,
        width: Math.max(0, container.width - padding * 2),
        height: footerSize,
      },
      baseline,
      segments: segmentLayouts,
    });
    baseline -= footerSize + footerLeading;
  }
  return {
    rect: {
      x: container.x + padding,
      y: footerBottom,
      width: Math.max(0, container.width - padding * 2),
      height: footerHeight,
    },
    lines: lineLayouts,
  };
};

export const layoutPdfSignatureBadge = (
  badge: PdfSignatureBadge,
  container: PdfSignatureBadgeLayoutRect,
  regularFont: PdfStandardFont,
  boldFont: PdfStandardFont,
): PdfSignatureBadgeLayout => {
  const padding = clampCoordinate(container.height * 0.075, 8, 12);
  const gutter = clampCoordinate(container.width * 0.028, 8, 14);
  const radius = clampCoordinate(container.height * 0.13, 4, 10);
  const innerWidth = Math.max(0, container.width - padding * 2);
  const innerHeight = Math.max(0, container.height - padding * 2);
  let scale = badgeInitialScale(
    badge.rows,
    badge.footer,
    container.height,
    padding,
    innerWidth,
    regularFont,
  );
  let layout: PdfSignatureBadgeLayout;
  let attempt = 0;
  do {
    const {
      headerSize,
      rowSize,
      footerSize,
      rowLeading,
      headerGap,
      footerLeading,
      separatorGap,
      footerGap,
    } = badgeMetricsAtScale(container.height, scale);
    const footerLines = footerLinesAtSize(badge.footer, regularFont, footerSize, innerWidth);
    const footerHeight = badgeFooterHeight(footerLines, footerSize, footerLeading);
    const separatorHeight = footerLines.length === 0 ? 0 : 0.6;
    const signatureHeight = badge.signaturePng === undefined ? 0 : Math.min(24, innerHeight * 0.22);
    const rowsHeight = badgeTextBlockHeight(badge.rows, headerSize, headerGap, rowSize, rowLeading);
    const textBlockHeight = rowsHeight + signatureHeight;
    const requiredHeight =
      textBlockHeight +
      (footerLines.length === 0 ? 0 : separatorGap + separatorHeight + footerGap + footerHeight);
    const textBlockTop = container.y + container.height - padding;
    const textBlockBottom = textBlockTop - textBlockHeight;
    const hasSidebar = badge.qr !== undefined || badge.logoPng !== undefined;
    const sidebarWidth = hasSidebar
      ? Math.max(0, Math.min(textBlockHeight, innerWidth * 0.28, innerHeight))
      : 0;
    const logoHeight =
      badge.logoPng === undefined
        ? 0
        : badge.qr === undefined
          ? sidebarWidth
          : Math.max(0, Math.min(sidebarWidth, (textBlockHeight - gutter) * 0.42));
    const logo =
      badge.logoPng === undefined
        ? undefined
        : {
            x: container.x + padding,
            y: textBlockTop - logoHeight,
            width: sidebarWidth,
            height: logoHeight,
          };
    const qrSide =
      badge.qr === undefined
        ? 0
        : Math.max(
            0,
            Math.min(
              sidebarWidth,
              textBlockHeight - logoHeight - (logo === undefined ? 0 : gutter),
            ),
          );
    const qr =
      badge.qr === undefined || qrSide <= 0
        ? undefined
        : {
            x: container.x + padding + (sidebarWidth - qrSide) / 2,
            y: textBlockBottom,
            width: qrSide,
            height: qrSide,
          };
    const textLeft = container.x + padding + (hasSidebar ? sidebarWidth + gutter : 0);
    const textWidth = Math.max(0, container.x + container.width - padding - textLeft);
    const headerBaseline = textBlockTop - headerSize;
    const header = badgeHeaderLayout(
      badge,
      headerBaseline,
      headerSize,
      textLeft,
      textWidth,
      boldFont,
    );
    const rows = badgeRowsLayout(
      badge.rows,
      headerBaseline - headerGap - rowSize,
      rowSize,
      rowLeading,
      textLeft,
      textWidth,
      boldFont,
      regularFont,
    );
    const footerBottom = container.y + padding;
    const footer = badgeFooterLayout(
      footerLines,
      footerBottom,
      footerSize,
      footerLeading,
      container,
      padding,
      regularFont,
    );
    const separator =
      footer.rect === undefined
        ? undefined
        : {
            x: container.x + padding,
            y: footer.rect.y + footer.rect.height + footerGap,
            width: innerWidth,
            height: separatorHeight,
          };
    layout = {
      container,
      padding,
      gutter,
      radius,
      headerSize,
      rowSize,
      footerSize,
      rowLeading,
      headerGap,
      footerLeading,
      separatorGap,
      footerGap,
      textBlock: {
        x: textLeft,
        y: textBlockBottom,
        width: textWidth,
        height: textBlockHeight,
      },
      qr,
      logo,
      signature:
        badge.signaturePng === undefined
          ? undefined
          : { x: textLeft, y: textBlockBottom, width: textWidth, height: signatureHeight },
      header,
      rows,
      separator,
      footer,
    };
    const footerFits = footerLines.every((line) => line.width <= innerWidth);
    const rowFits = rows.every((row) => row.rect.width <= textWidth);
    const separatorTop = separator === undefined ? undefined : separator.y + separator.height;
    if (
      textWidth > 0 &&
      requiredHeight <= innerHeight &&
      (separatorTop === undefined || textBlockBottom >= separatorTop + separatorGap) &&
      header.rect.width <= textWidth &&
      rowFits &&
      footerFits
    ) {
      return layout;
    }
    scale *= 0.92;
    attempt += 1;
  } while (attempt < 24);
  return layout;
};

const drawBadgeTextRun = (
  page: PageDrawing,
  run: PdfSignatureBadgeTextRunLayout,
  font: StampFont,
  color: PdfRgb,
): void => {
  drawText(page, font, run.text, {
    x: run.rect.x,
    y: run.baseline,
    size: run.rect.height,
    color,
  });
};

export const defaultPdfSignatureRect = (
  page: PdfSignaturePage,
  stampSize: PdfStampSize,
  margin = 24,
): PdfSignatureRect => {
  const width = Math.min(stampSize.width, page.width);
  const height = Math.min(stampSize.height, page.height);
  const maxX = Math.max(0, page.width - width);
  const maxY = Math.max(0, page.height - height);

  return {
    pageIndex: page.index,
    x: clampCoordinate(page.width - margin - width, 0, maxX),
    y: clampCoordinate(page.height - margin - height, 0, maxY),
    width,
    height,
  };
};

const drawBadgeRows = (
  page: PageDrawing,
  layout: PdfSignatureBadgeLayout,
  boldFont: StampFont,
  regularFont: StampFont,
  theme: ResolvedBadgeTheme,
): void => {
  for (const row of layout.rows) {
    for (const item of row.items) {
      if (item.separator !== undefined) {
        drawBadgeTextRun(page, item.separator, regularFont, theme.valueColor);
      }
      drawBadgeTextRun(page, item.label, boldFont, theme.labelColor);
      drawBadgeTextRun(page, item.value, regularFont, theme.valueColor);
    }
  }
};

const drawBadgeFooter = (
  page: PageDrawing,
  layout: PdfSignatureBadgeLayout,
  regularFont: StampFont,
  theme: ResolvedBadgeTheme,
  pageCoordinateSystem: PdfVisiblePageCoordinateSystem,
): void => {
  if (layout.separator !== undefined) {
    const middle = layout.separator.y + layout.separator.height / 2;
    page.content.push(
      pdfLine(
        [layout.separator.x, middle],
        [layout.separator.x + layout.separator.width, middle],
        layout.separator.height,
        theme.separatorColor,
        [4, 4],
      ),
    );
  }
  for (const line of layout.footer.lines) {
    for (const item of line.segments) {
      if (item.separator !== undefined) {
        drawBadgeTextRun(page, item.separator, regularFont, theme.footerColor);
      }
      const color = item.segment.link === undefined ? theme.footerColor : theme.linkColor;
      drawBadgeTextRun(page, item.text, regularFont, color);
      if (item.underline !== undefined) {
        page.content.push(
          pdfLine(
            [item.underline.x, item.underline.y],
            [item.underline.x + item.underline.width, item.underline.y],
            item.underline.height,
            theme.linkColor,
          ),
        );
      }
      if (item.annotation !== undefined && item.segment.link !== undefined) {
        page.links.push({
          rect: pdfCoordinateTupleFromVisibleBottomLeftRect(item.annotation, pageCoordinateSystem),
          uri: item.segment.link,
        });
      }
    }
  }
};

const drawSignatureBadge = (
  page: PageDrawing,
  badge: PdfSignatureBadge,
  layout: PdfSignatureBadgeLayout,
  regularFont: StampFont,
  boldFont: StampFont,
  qr: QrMatrix | undefined,
  pageCoordinateSystem: PdfVisiblePageCoordinateSystem,
  logoImage: StampImage | undefined,
  signatureImage: StampImage | undefined,
): void => {
  const theme = resolveBadgeTheme(badge.theme);
  page.content.push(
    pdfPath(
      roundedRectPath(
        layout.container.x,
        layout.container.y,
        layout.container.width,
        layout.container.height,
        layout.radius,
      ),
      { fill: theme.backgroundColor, stroke: theme.borderColor, lineWidth: 1.5 },
    ),
  );
  if (qr !== undefined && layout.qr !== undefined) {
    drawVisibleStampQrMatrix(page, qr, layout.qr.x, layout.qr.y, layout.qr.width);
  }
  const images: ReadonlyArray<
    readonly [StampImage | undefined, PdfSignatureBadgeLayoutRect | undefined]
  > = [
    [logoImage, layout.logo],
    [signatureImage, layout.signature],
  ];
  for (const [image, rect] of images) {
    if (image !== undefined && rect !== undefined) {
      const scale = Math.min(rect.width / image.width, rect.height / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      drawImage(page, image, [
        rect.x + (rect.width - width) / 2,
        rect.y + (rect.height - height) / 2,
        width,
        height,
      ]);
    }
  }
  drawBadgePadlock(page, layout.header.padlock, theme.headerColor);
  drawBadgeTextRun(page, layout.header.text, boldFont, theme.headerColor);
  drawBadgeRows(page, layout, boldFont, regularFont, theme);
  drawBadgeFooter(page, layout, regularFont, theme, pageCoordinateSystem);
};

export type PdfVisiblePageRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type PdfVisiblePageCoordinateSystem = {
  readonly cropBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly rotation: 0 | 90 | 180 | 270;
  readonly width: number;
  readonly height: number;
  readonly matrix: readonly [number, number, number, number, number, number];
};

const normalizedPageRotation = (rotation: number): 0 | 90 | 180 | 270 => {
  const angle = ((rotation % 360) + 360) % 360;
  if (angle === 90) return 90;
  if (angle === 180) return 180;
  if (angle === 270) return 270;
  return 0;
};

export type PdfPageGeometry = {
  readonly cropBox: PdfCoordinateTuple;
  readonly rotate: number;
};

const visibleCoordinateSystem = (
  cropBox: PdfVisiblePageCoordinateSystem["cropBox"],
  rotation: 0 | 90 | 180 | 270,
): PdfVisiblePageCoordinateSystem => {
  if (rotation === 90) {
    return {
      cropBox,
      rotation,
      width: cropBox.height,
      height: cropBox.width,
      matrix: [0, 1, -1, 0, cropBox.x + cropBox.width, cropBox.y],
    };
  }
  if (rotation === 180) {
    return {
      cropBox,
      rotation,
      width: cropBox.width,
      height: cropBox.height,
      matrix: [-1, 0, 0, -1, cropBox.x + cropBox.width, cropBox.y + cropBox.height],
    };
  }
  if (rotation === 270) {
    return {
      cropBox,
      rotation,
      width: cropBox.height,
      height: cropBox.width,
      matrix: [0, -1, 1, 0, cropBox.x, cropBox.y + cropBox.height],
    };
  }
  return {
    cropBox,
    rotation,
    width: cropBox.width,
    height: cropBox.height,
    matrix: [1, 0, 0, 1, cropBox.x, cropBox.y],
  };
};

const geometryCoordinateSystem = ({
  cropBox: [left, bottom, right, top],
  rotate,
}: PdfPageGeometry): PdfVisiblePageCoordinateSystem =>
  visibleCoordinateSystem(
    { x: left, y: bottom, width: right - left, height: top - bottom },
    normalizedPageRotation(rotate),
  );

export const visiblePdfPageSizeFromGeometry = (
  geometry: PdfPageGeometry,
): { readonly width: number; readonly height: number } => {
  const { width, height } = geometryCoordinateSystem(geometry);
  return { width, height };
};

const isIdentityPageCoordinateSystem = (
  coordinateSystem: PdfVisiblePageCoordinateSystem,
): boolean =>
  coordinateSystem.matrix[0] === 1 &&
  coordinateSystem.matrix[1] === 0 &&
  coordinateSystem.matrix[2] === 0 &&
  coordinateSystem.matrix[3] === 1 &&
  coordinateSystem.matrix[4] === 0 &&
  coordinateSystem.matrix[5] === 0;

const pdfCoordinateTupleFromVisibleBottomLeftRect = (
  rect: PdfVisiblePageRect,
  coordinateSystem: PdfVisiblePageCoordinateSystem,
): PdfCoordinateTuple => {
  const { x, y, width, height } = rect;
  const cropBox = coordinateSystem.cropBox;
  switch (coordinateSystem.rotation) {
    case 90:
      return [
        cropBox.x + cropBox.width - y - height,
        cropBox.y + x,
        cropBox.x + cropBox.width - y,
        cropBox.y + x + width,
      ];
    case 180:
      return [
        cropBox.x + cropBox.width - x - width,
        cropBox.y + cropBox.height - y - height,
        cropBox.x + cropBox.width - x,
        cropBox.y + cropBox.height - y,
      ];
    case 270:
      return [
        cropBox.x + y,
        cropBox.y + cropBox.height - x - width,
        cropBox.x + y + height,
        cropBox.y + cropBox.height - x,
      ];
    case 0:
      return [cropBox.x + x, cropBox.y + y, cropBox.x + x + width, cropBox.y + y + height];
  }
};

export const pdfCoordinateTupleFromPdfPageGeometry = (
  rect: PdfSignatureRect,
  geometry: PdfPageGeometry,
): PdfCoordinateTuple => {
  const coordinateSystem = geometryCoordinateSystem(geometry);
  return pdfCoordinateTupleFromVisibleBottomLeftRect(
    {
      x: rect.x,
      y: coordinateSystem.height - rect.y - rect.height,
      width: rect.width,
      height: rect.height,
    },
    coordinateSystem,
  );
};

const topLeftRectInCoordinateSystem = (
  [left, bottom, right, top]: PdfCoordinateTuple,
  coordinateSystem: PdfVisiblePageCoordinateSystem,
): PdfVisiblePageRect => {
  const cropBox = coordinateSystem.cropBox;
  switch (coordinateSystem.rotation) {
    case 90:
      return {
        x: bottom - cropBox.y,
        y: left - cropBox.x,
        width: top - bottom,
        height: right - left,
      };
    case 180:
      return {
        x: cropBox.x + cropBox.width - right,
        y: bottom - cropBox.y,
        width: right - left,
        height: top - bottom,
      };
    case 270:
      return {
        x: cropBox.y + cropBox.height - top,
        y: cropBox.x + cropBox.width - right,
        width: top - bottom,
        height: right - left,
      };
    case 0:
      return {
        x: left - cropBox.x,
        y: cropBox.y + cropBox.height - top,
        width: right - left,
        height: top - bottom,
      };
  }
};

export const topLeftRectFromPdfPageGeometry = (
  tuple: PdfCoordinateTuple,
  geometry: PdfPageGeometry,
): PdfVisiblePageRect => topLeftRectInCoordinateSystem(tuple, geometryCoordinateSystem(geometry));

export const rubricRectForPage = (
  targetPage: PdfSignaturePage,
  textBoxes: ReadonlyArray<PdfTextBox> = [],
): PdfSignatureRect => {
  const width = Math.min(RUBRIC_WIDTH_PT, targetPage.width);
  const height = Math.min(RUBRIC_HEIGHT_PT, targetPage.height);
  const maxX = Math.max(0, targetPage.width - width);
  const maxY = Math.max(0, targetPage.height - height);
  const x = clampCoordinate(targetPage.width - RUBRIC_RIGHT_MARGIN_PT - width, 0, maxX);
  const preferredY = clampCoordinate((targetPage.height - height) / 2, 0, maxY);
  const left = x - RUBRIC_COLLISION_PADDING_PT;
  const right = x + width + RUBRIC_COLLISION_PADDING_PT;

  const overlapsAt = (y: number): boolean => {
    const top = y - RUBRIC_COLLISION_PADDING_PT;
    const bottom = y + height + RUBRIC_COLLISION_PADDING_PT;
    return textBoxes.some(
      (box) =>
        box.width > 0 &&
        box.height > 0 &&
        box.x < right &&
        box.x + box.width > left &&
        box.y < bottom &&
        box.y + box.height > top,
    );
  };

  const candidates = [
    preferredY,
    0,
    maxY,
    ...textBoxes.flatMap((box) => [
      box.y - RUBRIC_COLLISION_PADDING_PT - height,
      box.y + box.height + RUBRIC_COLLISION_PADDING_PT,
    ]),
  ]
    .map((y) => clampCoordinate(y, 0, maxY))
    .sort((a, b) => Math.abs(a - preferredY) - Math.abs(b - preferredY));

  const y = candidates.find((candidate) => !overlapsAt(candidate)) ?? preferredY;

  return {
    pageIndex: targetPage.index,
    x,
    y,
    width,
    height,
  };
};

export const rubricPageIndexesExcludingSignature = (
  pageDimensions: ReadonlyArray<PdfSignaturePage>,
  signaturePageIndex: number,
): ReadonlyArray<number> =>
  pageDimensions.flatMap((page) => (page.index === signaturePageIndex ? [] : [page.index]));

type PdfVisibleSignatureTarget = {
  readonly pageIndex: number;
  readonly rect: PdfSignatureRect;
};

type PdfVisibleSignatureBatch = Omit<PdfVisibleStampInput, "pageIndex" | "rect"> & {
  readonly stamps: readonly [PdfVisibleSignatureTarget, ...PdfVisibleSignatureTarget[]];
};

const PdfVisibleSignatureTargetSchema = Schema.Struct({
  pageIndex: Schema.Finite,
  rect: PdfSignatureRectSchema,
}).check(
  Schema.makeFilter((target) =>
    target.pageIndex !== target.rect.pageIndex
      ? {
          path: ["pageIndex"],
          issue: "Visible stamp pageIndex must match rect.pageIndex.",
        }
      : undefined,
  ),
);

const PdfVisibleSignatureBatchSchema = Schema.Struct({
  pdf: Schema.Uint8Array,
  stamps: Schema.NonEmptyArray(PdfVisibleSignatureTargetSchema),
  inkPng: Schema.optional(Schema.Uint8Array),
  lines: Schema.optional(Schema.Array(Schema.String)),
  badge: Schema.optional(PdfSignatureBadgeSchema),
  border: Schema.optional(Schema.Boolean),
  qr: Schema.optional(PdfVisibleStampQrSchema),
}).check(
  Schema.makeFilter((input) => {
    if (
      input.badge !== undefined &&
      (input.lines !== undefined ||
        input.inkPng !== undefined ||
        input.qr !== undefined ||
        input.border !== undefined)
    ) {
      return {
        path: ["badge"],
        issue: "Visible stamp badge cannot be combined with lines, inkPng, qr, or border.",
      };
    }
    if (
      input.badge === undefined &&
      input.lines === undefined &&
      input.inkPng === undefined &&
      input.qr === undefined
    ) {
      return {
        path: ["lines"],
        issue: "Visible stamp requires lines, a badge, inkPng, or qr.",
      };
    }
    return undefined;
  }),
);

type PdfRubricTarget =
  | {
      readonly coordinateSpace: "pdf";
      readonly pages: PdfRubricStamp["pages"];
      readonly rect: PdfCoordinateTuple;
    }
  | {
      readonly coordinateSpace: "visible";
      readonly pageIndex: number;
      readonly rect: PdfVisiblePageRect;
    };

type ResolvedPdfRubricTarget =
  | {
      readonly coordinateSpace: "pdf";
      readonly pageIndex: number;
      readonly rect: PdfCoordinateTuple;
    }
  | {
      readonly coordinateSpace: "visible";
      readonly pageIndex: number;
      readonly rect: PdfVisiblePageRect;
    };

const isPageOutOfRange = (pageIndex: number, pageCount: number): boolean =>
  !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount;

const hasValidVisibleRect = (rect: PdfVisiblePageRect): boolean =>
  [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.width > 0 &&
  rect.height > 0;

const visibleRectFitsPage = (
  rect: PdfVisiblePageRect,
  coordinateSystem: PdfVisiblePageCoordinateSystem,
): boolean => {
  if (!hasValidVisibleRect(rect)) return false;
  const { width, height } = coordinateSystem;
  return (
    rect.width <= width &&
    rect.height <= height &&
    rect.x <= width - rect.width &&
    rect.y <= height - rect.height
  );
};

const hasValidPdfCoordinateTuple = ([left, bottom, right, top]: PdfCoordinateTuple): boolean =>
  [left, bottom, right, top].every(Number.isFinite) && left < right && bottom < top;

const pdfCoordinateTupleFitsPage = (
  rect: PdfCoordinateTuple,
  { cropBox }: PdfVisiblePageCoordinateSystem,
): boolean => {
  if (!hasValidPdfCoordinateTuple(rect)) return false;
  const [left, bottom, right, top] = rect;
  return (
    left >= cropBox.x &&
    bottom >= cropBox.y &&
    right <= cropBox.x + cropBox.width &&
    top <= cropBox.y + cropBox.height
  );
};

const drawInVisibleCoordinateSystem = (
  page: PageDrawing,
  coordinateSystem: PdfVisiblePageCoordinateSystem,
  draw: (target: PageDrawing) => void,
): void => {
  if (isIdentityPageCoordinateSystem(coordinateSystem)) {
    draw(page);
    return;
  }
  const body: Array<string> = [];
  draw({ content: body, resources: page.resources, links: page.links });
  page.content.push(...pdfTransform(coordinateSystem.matrix, body));
};

const STAMP_REGULAR_FONT = "SigKitHelvetica";
const STAMP_BOLD_FONT = "SigKitHelveticaBold";

const stampResourceName = (document: PdfCoreDocument, name: string): string =>
  `${name}${document.nextObjectNumber}`;

export const loadPdfStandardFont = (
  baseFont: PdfCoreWinAnsiFont,
): Effect.Effect<PdfStandardFont, PdfError, PdfCore> =>
  PdfCore.pipe(
    Effect.flatMap((core) => core.fontMetrics(baseFont)),
    Effect.map(pdfStandardFont),
    Effect.mapError(
      (error) =>
        new PdfError({
          code: Match.value(error.code).pipe(
            Match.when(PdfCoreErrorCodeValue.limitExceeded, () => PdfErrorCodeValue.limitExceeded),
            Match.orElse(() => PdfErrorCodeValue.stampFailed),
          ),
          retryable: false,
          operation: PdfOperationValue.stamp,
          reason: error.reason ?? "Failed to load the standard font metrics for stamping.",
        }),
    ),
  );

const loadStampFont = (
  name: string,
  baseFont: PdfCoreWinAnsiFont,
): Effect.Effect<StampFont, PdfError, PdfCore> =>
  loadPdfStandardFont(baseFont).pipe(Effect.map((font) => ({ name, font })));

const loadStampDocument = (
  pdf: Uint8Array,
  reason: string,
): Effect.Effect<
  {
    readonly document: PdfCoreDocument;
    readonly coordinateSystems: ReadonlyArray<PdfVisiblePageCoordinateSystem>;
  },
  PdfError,
  PdfCore
> =>
  PdfCore.pipe(
    Effect.flatMap((core) => core.document(pdf)),
    Effect.map((document) => ({
      document,
      coordinateSystems: document.pages.map((page) =>
        geometryCoordinateSystem({ cropBox: page.cropBox, rotate: page.rotate }),
      ),
    })),
    Effect.mapError(
      (error) =>
        new PdfError({
          code: Match.value(error.code).pipe(
            Match.when(PdfCoreErrorCodeValue.encryptedPdf, () => PdfErrorCodeValue.encryptedPdf),
            Match.when(PdfCoreErrorCodeValue.limitExceeded, () => PdfErrorCodeValue.limitExceeded),
            Match.orElse(() => PdfErrorCodeValue.stampFailed),
          ),
          retryable: false,
          operation: PdfOperationValue.stamp,
          reason: error.reason ?? reason,
        }),
    ),
  );

const pdfLinkUri = (uri: string): string =>
  /^[\x20-\x7e]*$/u.test(uri)
    ? `<${Array.from(uri, (character) => (character.codePointAt(0) ?? 0).toString(16).padStart(2, "0")).join("")}>`
    : `<FEFF${Array.from({ length: uri.length }, (_, index) =>
        uri.charCodeAt(index).toString(16).padStart(4, "0"),
      ).join("")}>`;

const contentEncoder = new TextEncoder();

const commitPageDrawings = (
  pdf: Uint8Array,
  document: PdfCoreDocument,
  fonts: ReadonlyArray<StampFont>,
  images: ReadonlyArray<StampImage>,
  drawings: ReadonlyMap<number, PageDrawing>,
  forIncrementalUpdate: boolean,
  reason: string,
): Effect.Effect<Uint8Array, PdfError, PdfCore> => {
  let nextObjectNumber = document.nextObjectNumber;
  const allocate = (): PdfCoreObjectRef => ({ number: nextObjectNumber++, generation: 0 });
  const used = new Set<string>();
  for (const drawing of drawings.values()) {
    for (const name of drawing.resources) used.add(name);
  }
  const operations: Array<PdfCoreEditOperation> = [];
  const refs = new Map<string, PdfCoreObjectRef>();
  for (const font of fonts) {
    if (!used.has(font.name)) continue;
    const ref = allocate();
    refs.set(font.name, ref);
    operations.push({ op: "standardFont", ref, baseFont: font.font.baseFont });
  }
  for (const image of images) {
    if (!used.has(image.name)) continue;
    const ref = allocate();
    refs.set(image.name, ref);
    operations.push({ op: "png", ref, softMaskRef: allocate(), png: image.png });
  }
  for (const [pageIndex, drawing] of drawings) {
    for (const name of drawing.resources) {
      const ref = refs.get(name);
      if (ref === undefined) continue;
      operations.push({
        op: "addResource",
        pageIndex,
        category: fonts.some((font) => font.name === name) ? "Font" : "XObject",
        name,
        value: `${ref.number} ${ref.generation} R`,
      });
    }
    if (drawing.content.length > 0) {
      operations.push({
        op: "appendContent",
        pageIndex,
        ref: allocate(),
        wrapRef: allocate(),
        data: contentEncoder.encode(drawing.content.join("\n")),
        compress: true,
      });
    }
    for (const link of drawing.links) {
      const ref = allocate();
      operations.push(
        {
          op: "setObject",
          ref,
          value: `<< /Type /Annot /Subtype /Link /Rect [${link.rect.map(pdfNumber).join(" ")}] /Border [0 0 0] /F ${BADGE_LINK_ANNOTATION_FLAG_PRINT} /A << /Type /Action /S /URI /URI ${pdfLinkUri(link.uri)} >> >>`,
        },
        {
          op: "append",
          target: { base: { kind: "page", pageIndex } },
          key: "Annots",
          value: `${ref.number} ${ref.generation} R`,
        },
      );
    }
  }
  if (operations.length === 0) return Effect.succeed(pdf);
  return PdfCore.pipe(
    Effect.flatMap((core) =>
      core.edit(pdf, operations, { mode: forIncrementalUpdate ? "incremental" : "auto" }),
    ),
    Effect.mapError(
      (error) =>
        new PdfError({
          code: Match.value(error.code).pipe(
            Match.when(PdfCoreErrorCodeValue.encryptedPdf, () => PdfErrorCodeValue.encryptedPdf),
            Match.when(PdfCoreErrorCodeValue.limitExceeded, () => PdfErrorCodeValue.limitExceeded),
            Match.when(PdfCoreErrorCodeValue.damagedXref, () => PdfErrorCodeValue.damagedSignedPdf),
            Match.orElse(() => PdfErrorCodeValue.stampFailed),
          ),
          retryable: false,
          operation: PdfOperationValue.stamp,
          reason: error.reason ?? reason,
        }),
    ),
  );
};

const hasPositiveQrDrawingArea = (rect: PdfSignatureRect): boolean =>
  rect.width - PAD * 2 > 0 && rect.height - PAD * 2 > 0;

const pngUint32At = (png: Uint8Array, offset: number): number =>
  (png[offset] ?? 0) * 0x1000000 +
  (png[offset + 1] ?? 0) * 0x10000 +
  (png[offset + 2] ?? 0) * 0x100 +
  (png[offset + 3] ?? 0);

const pngHasValidColor = (colorType: number | undefined, bitDepth: number | undefined): boolean =>
  Match.value(colorType).pipe(
    Match.when(0, () => [1, 2, 4, 8, 16].includes(bitDepth ?? 0)),
    Match.when(3, () => [1, 2, 4, 8].includes(bitDepth ?? 0)),
    Match.when(
      (type) => type === 2 || type === 4 || type === 6,
      () => bitDepth === 8 || bitDepth === 16,
    ),
    Match.orElse(() => false),
  );

const pngHeaderSize = (
  png: Uint8Array,
): { readonly width: number; readonly height: number } | undefined => {
  if (png.byteLength < PNG_IHDR_END || png.byteLength > MAX_PNG_INPUT_BYTES) return undefined;
  if (!PNG_SIGNATURE.every((byte, index) => png[index] === byte)) return undefined;
  if (pngUint32At(png, 8) !== 13) return undefined;
  if (!PNG_IHDR_TYPE.every((byte, index) => png[12 + index] === byte)) return undefined;
  const width = pngUint32At(png, 16);
  const height = pngUint32At(png, 20);
  if (
    width === 0 ||
    height === 0 ||
    width > Math.floor(MAX_PNG_PIXELS / height) ||
    !pngHasValidColor(png[25], png[24]) ||
    png[26] !== 0 ||
    png[27] !== 0 ||
    (png[28] !== 0 && png[28] !== 1)
  ) {
    return undefined;
  }
  return { width, height };
};

export const isSafePdfStampPng = (png: Uint8Array): Effect.Effect<boolean, never, PdfCore> =>
  pngHeaderSize(png) === undefined
    ? Effect.succeed(false)
    : PdfCore.pipe(
        Effect.flatMap((core) => core.pngSize(png)),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

const stampImage = (
  name: string,
  png: Uint8Array | undefined,
  reason: string,
): Effect.Effect<StampImage | undefined, PdfError> => {
  if (png === undefined) return Effect.succeed(undefined);
  const size = pngHeaderSize(png);
  return size === undefined
    ? Effect.fail(
        new PdfError({
          code: PdfErrorCodeValue.stampFailed,
          retryable: false,
          operation: PdfOperationValue.stamp,
          reason,
        }),
      )
    : Effect.succeed({ name, png, width: size.width, height: size.height });
};

const encodableStampText = (
  font: StampFont,
  texts: ReadonlyArray<string>,
): Effect.Effect<void, PdfError> =>
  texts.every((text) => pdfTextEncodable(font.font, text))
    ? Effect.void
    : Effect.fail(
        new PdfError({
          code: PdfErrorCodeValue.stampFailed,
          retryable: false,
          operation: PdfOperationValue.stamp,
          reason:
            "Stamp text contains characters that the standard Helvetica font cannot encode (WinAnsi).",
        }),
      );

const hasConflictingRubricModes = (stamp: Omit<PdfRubricStamp, "rect" | "pages">): boolean =>
  stamp.initials !== undefined && (stamp.imagePng !== undefined || (stamp.lines?.length ?? 0) > 0);

const hasDrawableRubricContent = (stamp: Omit<PdfRubricStamp, "rect" | "pages">): boolean =>
  (stamp.border ?? true) ||
  stamp.imagePng !== undefined ||
  stamp.initials !== undefined ||
  (stamp.lines?.length ?? 0) > 0;

const drawRubric = (
  page: PageDrawing,
  font: StampFont,
  image: StampImage | undefined,
  stamp: Omit<PdfRubricStamp, "rect" | "pages">,
  left: number,
  bottom: number,
  width: number,
  height: number,
): void => {
  if (stamp.border ?? true) {
    page.content.push(pdfStrokeRect([left, bottom, width, height], FRAME, 0.6));
  }
  if (stamp.initials !== undefined) {
    drawInitialsRubric(
      page,
      font,
      left,
      bottom,
      width,
      height,
      stamp.initials,
      stamp.initialsTheme,
    );
    return;
  }
  drawInkPngTextColumn({
    page,
    font,
    image,
    lines: stamp.lines ?? [],
    x: left,
    y: bottom,
    width,
    height,
    textColor: INK,
    imageHeightRatioWithLines: 0.58,
    minTextSize: 4.5,
    textSizeOffset: 1,
    textPadding: PAD,
    leading: "fixed",
    separator: false,
  });
};

const resolveRubricTargets = (
  targets: ReadonlyArray<PdfRubricTarget>,
  pageCount: number,
): ReadonlyArray<ResolvedPdfRubricTarget> =>
  targets.flatMap((target) => {
    if (target.coordinateSpace === "visible") return [target];
    const pageIndexes =
      target.pages === undefined || target.pages === "all"
        ? Array.from({ length: pageCount }, (_page, index) => index)
        : target.pages;
    return pageIndexes.map((pageIndex): ResolvedPdfRubricTarget => ({
      coordinateSpace: "pdf",
      pageIndex,
      rect: target.rect,
    }));
  });

const stampPdfRubricTargets = (
  pdf: Uint8Array,
  stamp: Omit<PdfRubricStamp, "rect" | "pages">,
  targets: ReadonlyArray<PdfRubricTarget>,
  forIncrementalUpdate: boolean,
): Effect.Effect<Uint8Array, PdfError, PdfCore> => {
  if (hasConflictingRubricModes(stamp)) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.stampFailed,
        retryable: false,
        operation: PdfOperationValue.stamp,
        reason: "Initials rubrics cannot be combined with image or line content.",
      }),
    );
  }
  if (targets.length === 0 || !hasDrawableRubricContent(stamp)) return Effect.succeed(pdf);
  const invalidTarget = targets.find((target) =>
    target.coordinateSpace === "pdf"
      ? !hasValidPdfCoordinateTuple(target.rect)
      : !hasValidVisibleRect(target.rect),
  );
  if (invalidTarget !== undefined) {
    return Effect.fail(
      new PdfError({
        code: PdfErrorCodeValue.stampFailed,
        retryable: false,
        operation: PdfOperationValue.stamp,
        reason:
          invalidTarget.coordinateSpace === "pdf"
            ? "Rubric stamp rect must contain finite, ordered coordinates."
            : "Visible rubric rect must contain finite, positive coordinates.",
      }),
    );
  }

  return Effect.gen(function* () {
    const { document, coordinateSystems } = yield* loadStampDocument(
      pdf,
      "Failed to load the PDF for rubric stamping.",
    );
    const image = yield* stampImage(
      stampResourceName(document, "SigKitRubricImage"),
      stamp.imagePng,
      "PNG image exceeds supported input or decoded pixel limits.",
    );
    const pageCount = document.pages.length;
    const resolvedTargets = resolveRubricTargets(targets, pageCount);
    if (resolvedTargets.length === 0) return pdf;
    const invalidPage = resolvedTargets.find((target) =>
      isPageOutOfRange(target.pageIndex, pageCount),
    );
    if (invalidPage !== undefined) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.stampFailed,
        retryable: false,
        operation: PdfOperationValue.stamp,
        reason: `Rubric page index ${invalidPage.pageIndex} is out of range (document has ${pageCount} pages).`,
      });
    }
    const outOfBoundsTarget = resolvedTargets.find((target) => {
      const coordinateSystem = coordinateSystems[target.pageIndex];
      if (coordinateSystem === undefined) return true;
      return target.coordinateSpace === "pdf"
        ? !pdfCoordinateTupleFitsPage(target.rect, coordinateSystem)
        : !visibleRectFitsPage(target.rect, coordinateSystem);
    });
    if (outOfBoundsTarget !== undefined) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.stampFailed,
        retryable: false,
        operation: PdfOperationValue.stamp,
        reason:
          outOfBoundsTarget.coordinateSpace === "pdf"
            ? `Rubric stamp rect is outside the visible CropBox on page ${outOfBoundsTarget.pageIndex}.`
            : `Visible rubric rect is outside page ${outOfBoundsTarget.pageIndex}.`,
      });
    }

    const font = yield* loadStampFont(stampResourceName(document, STAMP_REGULAR_FONT), "Helvetica");
    yield* encodableStampText(font, [
      ...(stamp.lines ?? []),
      ...(stamp.initials === undefined ? [] : [deriveSignerInitials(stamp.initials)]),
    ]);
    const drawings = new Map<number, PageDrawing>();
    for (const target of resolvedTargets) {
      const coordinateSystem = coordinateSystems[target.pageIndex];
      if (coordinateSystem === undefined) continue;
      const page = drawings.get(target.pageIndex) ?? pageDrawing();
      drawings.set(target.pageIndex, page);
      if (target.coordinateSpace === "pdf") {
        const [left, bottom, right, top] = target.rect;
        drawRubric(page, font, image, stamp, left, bottom, right - left, top - bottom);
        continue;
      }
      const bottom = coordinateSystem.height - target.rect.y - target.rect.height;
      drawInVisibleCoordinateSystem(page, coordinateSystem, (transformed) =>
        drawRubric(
          transformed,
          font,
          image,
          stamp,
          target.rect.x,
          bottom,
          target.rect.width,
          target.rect.height,
        ),
      );
    }
    return yield* commitPageDrawings(
      pdf,
      document,
      [font],
      image === undefined ? [] : [image],
      drawings,
      forIncrementalUpdate,
      "Failed to draw the rubric stamp.",
    );
  });
};

export const stampPdfRubric = (
  pdf: Uint8Array,
  stamp: PdfRubricStamp,
  forIncrementalUpdate?: boolean,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  forIncrementalUpdate === undefined
    ? hasPdfByteRange(pdf).pipe(
        Effect.flatMap((signed) => stampPdfRubricWithUpdateMode(pdf, stamp, signed)),
      )
    : stampPdfRubricWithUpdateMode(pdf, stamp, forIncrementalUpdate);

const stampPdfRubricWithUpdateMode = (
  pdf: Uint8Array,
  stamp: PdfRubricStamp,
  forIncrementalUpdate: boolean,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  Schema.decodeUnknownEffect(PdfRubricStampSchema)(stamp).pipe(
    Effect.mapError(
      (issue) =>
        new PdfError({
          code: PdfErrorCodeValue.stampFailed,
          retryable: false,
          operation: PdfOperationValue.stamp,
          schemaName: PdfSchemaNameValue.pdfRubricStamp,
          reason: "Rubric stamp input failed schema validation.",
          issueMessage: String(issue),
        }),
    ),
    Effect.flatMap((valid) => {
      if (hasConflictingRubricModes(valid)) {
        return Effect.fail(
          new PdfError({
            code: PdfErrorCodeValue.stampFailed,
            retryable: false,
            operation: PdfOperationValue.stamp,
            reason: "Initials rubrics cannot be combined with image or line content.",
          }),
        );
      }
      if (
        (Array.isArray(valid.pages) && valid.pages.length === 0) ||
        !hasDrawableRubricContent(valid)
      ) {
        return Effect.succeed(pdf);
      }
      return stampPdfRubricTargets(
        pdf,
        valid,
        [{ coordinateSpace: "pdf", pages: valid.pages, rect: valid.rect }],
        forIncrementalUpdate,
      ).pipe(
        Effect.withSpan("pdf.stamp.rubric", {
          attributes: {
            "signature_kit.pdf.bytes": pdf.byteLength,
            ...(Array.isArray(valid.pages)
              ? { "signature_kit.pdf.rubric_pages": valid.pages.length }
              : { "signature_kit.pdf.rubric_all_pages": true }),
            "signature_kit.pdf.incremental": forIncrementalUpdate,
            "signature_kit.pdf.rubric_initials": valid.initials !== undefined,
          },
        }),
      );
    }),
  );
export const stampPdfVisibleSignatures = (
  input: PdfVisibleSignatureBatch,
  forIncrementalUpdate: boolean,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  Schema.decodeUnknownEffect(PdfVisibleSignatureBatchSchema)(input).pipe(
    Effect.mapError(
      (issue) =>
        new PdfError({
          code: PdfErrorCodeValue.stampFailed,
          retryable: false,
          operation: PdfOperationValue.stamp,
          schemaName: PdfSchemaNameValue.pdfVisibleStampInput,
          reason: "Visible PDF stamp input failed schema validation.",
          issueMessage: String(issue),
        }),
    ),
    Effect.flatMap((valid) =>
      Effect.gen(function* () {
        if (
          valid.border === false &&
          valid.badge === undefined &&
          valid.inkPng === undefined &&
          valid.qr === undefined &&
          (valid.lines?.length ?? 0) === 0
        ) {
          return valid.pdf;
        }
        if (
          valid.badge !== undefined &&
          valid.stamps.some(({ rect }) => rect.width <= 16 || rect.height <= 16)
        ) {
          return yield* new PdfError({
            code: PdfErrorCodeValue.stampFailed,
            retryable: false,
            operation: PdfOperationValue.stamp,
            reason:
              "Structured signature badge requires a positive drawing area inside its padding. Increase the stamp width and height beyond 16 points.",
          });
        }
        const { document, coordinateSystems } = yield* loadStampDocument(
          valid.pdf,
          "Failed to load the PDF for visible signature stamping.",
        );
        const badgeImageReason = "Badge PNG image exceeds supported input or decoded pixel limits.";
        const logoImage = yield* stampImage(
          stampResourceName(document, "SigKitBadgeLogo"),
          valid.badge?.logoPng,
          badgeImageReason,
        );
        const signatureImage = yield* stampImage(
          stampResourceName(document, "SigKitBadgeSignature"),
          valid.badge?.signaturePng,
          badgeImageReason,
        );
        const inkImage = yield* stampImage(
          stampResourceName(document, "SigKitInk"),
          valid.badge === undefined ? valid.inkPng : undefined,
          "PNG image exceeds supported input or decoded pixel limits.",
        );
        const invalidPage = valid.stamps.find((stamp) =>
          isPageOutOfRange(stamp.pageIndex, document.pages.length),
        );
        if (invalidPage !== undefined) {
          return yield* new PdfError({
            code: PdfErrorCodeValue.stampFailed,
            retryable: false,
            operation: PdfOperationValue.stamp,
            reason: `Visible stamp page index ${invalidPage.pageIndex} is out of range.`,
          });
        }
        const invalidRect = valid.stamps.find((stamp) => {
          const coordinateSystem = coordinateSystems[stamp.pageIndex];
          return (
            coordinateSystem === undefined || !visibleRectFitsPage(stamp.rect, coordinateSystem)
          );
        });
        if (invalidRect !== undefined) {
          return yield* new PdfError({
            code: PdfErrorCodeValue.stampFailed,
            retryable: false,
            operation: PdfOperationValue.stamp,
            reason: `Visible stamp rect is outside page ${invalidRect.pageIndex}.`,
          });
        }

        const lines = valid.lines ?? [];
        const border = valid.border ?? true;
        const badge = valid.badge;
        const qr = badge === undefined ? valid.qr : badge.qr;
        const invalidQrStamp =
          badge === undefined && qr !== undefined
            ? valid.stamps.find((stamp) => !hasPositiveQrDrawingArea(stamp.rect))
            : undefined;
        if (invalidQrStamp !== undefined) {
          return yield* new PdfError({
            code: PdfErrorCodeValue.stampFailed,
            retryable: false,
            operation: PdfOperationValue.stamp,
            reason: "Visible stamp QR code requires a positive drawing area.",
          });
        }
        const qrMatrix = qr === undefined ? undefined : yield* encodeVisibleStampQr(qr);
        const font = yield* loadStampFont(
          stampResourceName(document, STAMP_REGULAR_FONT),
          "Helvetica",
        );
        const boldFont =
          badge === undefined
            ? font
            : yield* loadStampFont(stampResourceName(document, STAMP_BOLD_FONT), "Helvetica-Bold");
        if (badge === undefined) {
          yield* encodableStampText(font, lines);
        } else {
          yield* encodableStampText(boldFont, [
            badge.header.text,
            ...badge.rows.flatMap((row) => row.map((item) => `${item.label}: `)),
          ]);
          yield* encodableStampText(font, [
            ...badge.rows.flatMap((row) => row.map((item) => item.value)),
            ...badge.footer.map((segment) => segment.text),
          ]);
        }

        const drawings = new Map<number, PageDrawing>();
        for (const stamp of valid.stamps) {
          const coordinateSystem = coordinateSystems[stamp.pageIndex];
          if (coordinateSystem === undefined) continue;
          const page = drawings.get(stamp.pageIndex) ?? pageDrawing();
          drawings.set(stamp.pageIndex, page);
          const { x, y, width, height } = stamp.rect;
          const bottom = coordinateSystem.height - y - height;
          drawInVisibleCoordinateSystem(page, coordinateSystem, (target) => {
            if (badge !== undefined) {
              const layout = layoutPdfSignatureBadge(
                badge,
                { x, y: bottom, width, height },
                font.font,
                boldFont.font,
              );
              drawSignatureBadge(
                target,
                badge,
                layout,
                font,
                boldFont,
                qrMatrix,
                coordinateSystem,
                logoImage,
                signatureImage,
              );
              return;
            }
            if (border) {
              target.content.push(pdfStrokeRect([x, bottom, width, height], FRAME, 0.6));
            }
            if (qrMatrix === undefined) {
              drawInkPngTextColumn({
                page: target,
                font,
                image: inkImage,
                lines,
                x,
                y: bottom,
                width,
                height,
                textColor: border === false ? MUTED_INK : INK,
                imageHeightRatioWithLines: 0.58,
                minTextSize: 4.5,
                textSizeOffset: 1,
                textPadding: PAD,
                leading: "fixed",
                separator: border === false,
              });
              return;
            }
            const qrSide = Math.min(height - PAD * 2, width - PAD * 2);
            const qrX = x + PAD;
            const qrY = bottom + (height - qrSide) / 2;
            drawVisibleStampQrMatrix(target, qrMatrix, qrX, qrY, qrSide);
            const textLeft = qrX + qrSide + QR_TEXT_GAP_PT;
            const textRight = x + width - PAD;
            drawInkPngTextColumn({
              page: target,
              font,
              image: inkImage,
              lines,
              x: textLeft,
              y: bottom,
              width: Math.max(0, textRight - textLeft),
              height,
              textColor: border === false ? MUTED_INK : INK,
              imageHeightRatioWithLines: 0.35,
              minTextSize: 3.5,
              textSizeOffset: 0.75,
              textPadding: 0,
              leading: "proportional",
              separator: border === false,
            });
          });
        }
        return yield* commitPageDrawings(
          valid.pdf,
          document,
          badge === undefined ? [font] : [font, boldFont],
          [logoImage, signatureImage, inkImage].filter((image) => image !== undefined),
          drawings,
          forIncrementalUpdate,
          "Failed to draw the visible signature stamp.",
        );
      }).pipe(
        Effect.withSpan("pdf.stamp.visible", {
          attributes: {
            "signature_kit.pdf.bytes": valid.pdf.byteLength,
            "signature_kit.pdf.stamp_count": valid.stamps.length,
            "signature_kit.pdf.incremental": forIncrementalUpdate,
            "signature_kit.pdf.badge": valid.badge !== undefined,
            "signature_kit.pdf.qr": valid.qr !== undefined,
          },
        }),
      ),
    ),
  );

export const stampPdfVisibleSignature = (
  input: PdfVisibleStampInput,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  hasPdfByteRange(input.pdf).pipe(
    Effect.flatMap((signed) =>
      stampPdfVisibleSignatures(
        {
          pdf: input.pdf,
          stamps: [{ pageIndex: input.pageIndex, rect: input.rect }],
          ...(input.lines === undefined ? {} : { lines: input.lines }),
          ...(input.badge === undefined ? {} : { badge: input.badge }),
          ...(input.inkPng === undefined ? {} : { inkPng: input.inkPng }),
          ...(input.border === undefined ? {} : { border: input.border }),
          ...(input.qr === undefined ? {} : { qr: input.qr }),
        },
        signed,
      ),
    ),
  );

export const stampPdfRubricOnPages = (
  input: PdfRubricPageStampInput,
  forIncrementalUpdate?: boolean,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  forIncrementalUpdate === undefined
    ? hasPdfByteRange(input.pdf).pipe(
        Effect.flatMap((signed) => stampPdfRubricOnPagesWithUpdateMode(input, signed)),
      )
    : stampPdfRubricOnPagesWithUpdateMode(input, forIncrementalUpdate);

const stampPdfRubricOnPagesWithUpdateMode = (
  input: PdfRubricPageStampInput,
  forIncrementalUpdate: boolean,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  Schema.decodeUnknownEffect(PdfRubricPageStampInputSchema)(input).pipe(
    Effect.mapError(
      (issue) =>
        new PdfError({
          code: PdfErrorCodeValue.stampFailed,
          retryable: false,
          operation: PdfOperationValue.stamp,
          schemaName: PdfSchemaNameValue.pdfRubricPageStampInput,
          reason: "Rubric page stamp input failed schema validation.",
          issueMessage: String(issue),
        }),
    ),
    Effect.flatMap((valid) => {
      if (hasConflictingRubricModes(valid)) {
        return Effect.fail(
          new PdfError({
            code: PdfErrorCodeValue.stampFailed,
            retryable: false,
            operation: PdfOperationValue.stamp,
            reason: "Initials rubrics cannot be combined with image or line content.",
          }),
        );
      }
      if (valid.pages.length === 0 || !hasDrawableRubricContent(valid)) {
        return Effect.succeed(valid.pdf);
      }
      const pageDimensions = new Map<number, PdfSignaturePage>();
      for (const page of valid.pageDimensions) {
        if (pageDimensions.has(page.index)) {
          return Effect.fail(
            new PdfError({
              code: PdfErrorCodeValue.stampFailed,
              retryable: false,
              operation: PdfOperationValue.stamp,
              reason: `Rubric page metadata has duplicate index ${page.index}.`,
            }),
          );
        }
        pageDimensions.set(page.index, page);
      }

      const targets: PdfRubricTarget[] = [];
      for (const pageIndex of valid.pages) {
        const page = pageDimensions.get(pageIndex);
        if (page === undefined) {
          return Effect.fail(
            new PdfError({
              code: PdfErrorCodeValue.stampFailed,
              retryable: false,
              operation: PdfOperationValue.stamp,
              reason: `Rubric page index ${pageIndex} has no page dimensions.`,
            }),
          );
        }
        const textBoxes = valid.pageTextBoxes?.[pageIndex] ?? [];
        targets.push({
          coordinateSpace: "visible",
          pageIndex,
          rect: rubricRectForPage(page, textBoxes),
        });
      }
      return stampPdfRubricTargets(valid.pdf, valid, targets, forIncrementalUpdate).pipe(
        Effect.withSpan("pdf.stamp.rubric", {
          attributes: {
            "signature_kit.pdf.bytes": valid.pdf.byteLength,
            "signature_kit.pdf.rubric_pages": targets.length,
            "signature_kit.pdf.incremental": forIncrementalUpdate,
            "signature_kit.pdf.rubric_initials": valid.initials !== undefined,
          },
        }),
      );
    }),
  );

export const createPdfStampPreview = (
  input: PdfStampPreviewInput,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  Schema.decodeUnknownEffect(PdfStampPreviewInputSchema)(input).pipe(
    Effect.mapError(
      (issue) =>
        new PdfError({
          code: PdfErrorCodeValue.stampFailed,
          retryable: false,
          operation: PdfOperationValue.stamp,
          reason: "Invalid stamp preview dimensions or badge.",
          issueMessage: String(issue),
        }),
    ),
    Effect.flatMap((valid) =>
      PdfCore.pipe(
        Effect.flatMap((core) =>
          core.create({ pages: [{ width: valid.width + 4, height: valid.height + 4 }] }),
        ),
        Effect.mapError(
          (error) =>
            new PdfError({
              code: Match.value(error.code).pipe(
                Match.when(
                  PdfCoreErrorCodeValue.limitExceeded,
                  () => PdfErrorCodeValue.limitExceeded,
                ),
                Match.orElse(() => PdfErrorCodeValue.stampFailed),
              ),
              retryable: false,
              operation: PdfOperationValue.stamp,
              reason: error.reason ?? "Failed to create the stamp preview document.",
            }),
        ),
        Effect.flatMap((pdf) =>
          stampPdfVisibleSignatures(
            {
              pdf,
              stamps: [
                {
                  pageIndex: 0,
                  rect: { pageIndex: 0, x: 2, y: 2, width: valid.width, height: valid.height },
                },
              ],
              badge: valid.badge,
            },
            false,
          ),
        ),
      ),
    ),
  );

export const PdfIllustrativeDocumentInputSchema = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  variant: Schema.Literals(["line", "field", "witnessed", "initials"]),
  marked: Schema.Boolean,
  markLabel: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60))),
});

export const createIllustrativePdf = (
  input: unknown,
): Effect.Effect<Uint8Array, PdfError, PdfCore> =>
  Schema.decodeUnknownEffect(PdfIllustrativeDocumentInputSchema)(input).pipe(
    Effect.mapError(
      (issue) =>
        new PdfError({
          code: PdfErrorCodeValue.stampFailed,
          retryable: false,
          operation: PdfOperationValue.stamp,
          reason: "Illustrative document input failed schema validation.",
          schemaName: PdfSchemaNameValue.pdfIllustrativeDocumentInput,
          issueMessage: String(issue),
        }),
    ),
    Effect.flatMap((data) =>
      Effect.gen(function* () {
        const reason = "Failed to create illustrative PDF document.";
        const pdf = yield* PdfCore.pipe(
          Effect.flatMap((core) => core.create({ pages: [{ width: 595, height: 842 }] })),
          Effect.mapError(
            (error) =>
              new PdfError({
                code: Match.value(error.code).pipe(
                  Match.when(
                    PdfCoreErrorCodeValue.limitExceeded,
                    () => PdfErrorCodeValue.limitExceeded,
                  ),
                  Match.orElse(() => PdfErrorCodeValue.stampFailed),
                ),
                retryable: false,
                operation: PdfOperationValue.stamp,
                reason: error.reason ?? reason,
              }),
          ),
        );
        const { document } = yield* loadStampDocument(pdf, reason);
        const font = yield* loadStampFont(
          stampResourceName(document, STAMP_REGULAR_FONT),
          "Helvetica",
        );
        const bold = yield* loadStampFont(
          stampResourceName(document, STAMP_BOLD_FONT),
          "Helvetica-Bold",
        );
        const markLabel = data.markLabel ?? "EXAMPLE";
        yield* encodableStampText(bold, [data.title, ...(data.marked ? [markLabel] : [])]);
        yield* encodableStampText(font, [data.body]);
        const page = pageDrawing();
        drawText(page, bold, data.title, { x: 48, y: 770, size: 20, color: BLACK });
        drawText(page, font, data.body, {
          x: 48,
          y: 720,
          size: 11,
          color: BLACK,
          maxWidth: 499,
          lineHeight: 17,
        });
        drawText(page, bold, "EXEMPLO VISUAL / VISUAL EXAMPLE", {
          x: 48,
          y: 125,
          size: 12,
          color: BLACK,
        });
        drawText(page, font, "NAO E ASSINATURA DIGITAL / NOT A DIGITAL SIGNATURE", {
          x: 48,
          y: 105,
          size: 10,
          color: BLACK,
        });
        page.content.push(pdfLine([48, 190], [300, 190], 1, BLACK));
        Match.value(data.variant).pipe(
          Match.when("line", () => undefined),
          Match.when("field", () => page.content.push(pdfStrokeRect([48, 185, 252, 42], FRAME, 1))),
          Match.when("witnessed", () =>
            page.content.push(pdfLine([330, 190], [545, 190], 1, BLACK)),
          ),
          Match.when("initials", () =>
            page.content.push(pdfStrokeRect([320, 185, 70, 42], FRAME, 1)),
          ),
          Match.exhaustive,
        );
        drawText(page, font, data.variant, { x: 48, y: 170, size: 10, color: BLACK });
        if (data.marked) drawText(page, bold, markLabel, { x: 55, y: 202, size: 16, color: BLACK });
        return yield* commitPageDrawings(
          pdf,
          document,
          [font, bold],
          [],
          new Map([[0, page]]),
          false,
          reason,
        );
      }),
    ),
  );
