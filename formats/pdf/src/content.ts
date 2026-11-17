import type { PdfCoreFontMetrics, PdfCoreWinAnsiFont } from "@signature-kit/pdf-core/config";

export type PdfRgb = readonly [red: number, green: number, blue: number];

export type PdfStandardFont = {
  readonly baseFont: PdfCoreWinAnsiFont;
  readonly codes: ReadonlyMap<number, number>;
  readonly widths: Uint16Array;
};

export type PdfPathSegment =
  | readonly ["move", x: number, y: number]
  | readonly ["line", x: number, y: number]
  | readonly ["curve", controlX: number, controlY: number, x: number, y: number]
  | readonly ["close"];

export type PdfPathPaint = {
  readonly fill?: PdfRgb;
  readonly stroke?: PdfRgb;
  readonly lineWidth?: number;
};

export type PdfTextRun = {
  readonly fontName: string;
  readonly font: PdfStandardFont;
  readonly size: number;
  readonly x: number;
  readonly y: number;
  readonly color: PdfRgb;
  readonly lines: ReadonlyArray<string>;
  readonly lineHeight: number;
};

const TEXT_NEWLINE = /[\n\f\r]/u;
const TEXT_TABS = /\t|\u0085|\u2028|\u2029/gu;
const TEXT_DROPPED = /[\b\v]/gu;
const WORD_BREAK = /[^ \n\f\r]+ ?|[ \n\f\r]/gu;

export const pdfStandardFont = (metrics: PdfCoreFontMetrics): PdfStandardFont => {
  const codes = new Map<number, number>();
  metrics.unicode.forEach((unicode, code) => {
    if (unicode !== 0 && !codes.has(unicode)) codes.set(unicode, code);
  });
  return { baseFont: metrics.baseFont, codes, widths: metrics.widths };
};

const cleanText = (text: string): string =>
  text.replace(TEXT_TABS, "    ").replace(TEXT_DROPPED, "");

export const pdfTextEncodable = (font: PdfStandardFont, text: string): boolean => {
  for (const character of cleanText(text)) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!TEXT_NEWLINE.test(character) && !font.codes.has(codePoint)) return false;
  }
  return true;
};

export const pdfTextWidth = (font: PdfStandardFont, text: string, size: number): number => {
  let units = 0;
  for (const character of text) {
    const code = font.codes.get(character.codePointAt(0) ?? 0);
    units += code === undefined ? 0 : (font.widths[code] ?? 0);
  }
  return (units * size) / 1000;
};

export const pdfTextLines = (
  font: PdfStandardFont,
  text: string,
  size: number,
  maxWidth: number | undefined,
): ReadonlyArray<string> => {
  if (maxWidth === undefined) return cleanText(text).split(TEXT_NEWLINE);
  const lines: Array<string> = [];
  let line = "";
  let width = 0;
  const push = (): void => {
    if (line !== "") lines.push(line);
    line = "";
    width = 0;
  };
  for (const word of cleanText(text).match(WORD_BREAK) ?? []) {
    if (TEXT_NEWLINE.test(word)) {
      push();
      continue;
    }
    const wordWidth = pdfTextWidth(font, word, size);
    if (width + wordWidth > maxWidth) push();
    line += word;
    width += wordWidth;
  }
  push();
  return lines;
};

export const pdfNumber = (value: number): string => {
  if (Number.isInteger(value)) return Object.is(value, -0) ? "0" : String(value);
  const fixed = value.toFixed(4).replace(/\.?0+$/u, "");
  return fixed === "-0" ? "0" : fixed;
};

const numbers = (...values: ReadonlyArray<number>): string => values.map(pdfNumber).join(" ");

const fillColor = ([red, green, blue]: PdfRgb): string => `${numbers(red, green, blue)} rg`;
const strokeColor = ([red, green, blue]: PdfRgb): string => `${numbers(red, green, blue)} RG`;

const hexText = (font: PdfStandardFont, text: string): string => {
  let hex = "";
  for (const character of text) {
    const code = font.codes.get(character.codePointAt(0) ?? 0) ?? 0;
    hex += code.toString(16).padStart(2, "0").toUpperCase();
  }
  return `<${hex}>`;
};

export const pdfFillRects = (
  rects: ReadonlyArray<readonly [x: number, y: number, width: number, height: number]>,
  color: PdfRgb,
): string =>
  rects.length === 0
    ? ""
    : `q ${fillColor(color)} ${rects.map((rect) => `${numbers(...rect)} re`).join(" ")} f Q`;

export const pdfStrokeRect = (
  rect: readonly [x: number, y: number, width: number, height: number],
  color: PdfRgb,
  lineWidth: number,
): string => `q ${strokeColor(color)} ${pdfNumber(lineWidth)} w ${numbers(...rect)} re S Q`;

export const pdfLine = (
  start: readonly [x: number, y: number],
  end: readonly [x: number, y: number],
  lineWidth: number,
  color: PdfRgb,
  dash: ReadonlyArray<number> = [],
): string =>
  `q ${strokeColor(color)} ${pdfNumber(lineWidth)} w [${numbers(...dash)}] 0 d ${numbers(...start)} m ${numbers(...end)} l S Q`;

export const pdfPath = (segments: ReadonlyArray<PdfPathSegment>, paint: PdfPathPaint): string => {
  const operator =
    paint.fill !== undefined && paint.stroke !== undefined
      ? "B"
      : paint.fill !== undefined
        ? "f"
        : "S";
  const path = segments
    .map((segment) => {
      switch (segment[0]) {
        case "move":
          return `${numbers(segment[1], segment[2])} m`;
        case "line":
          return `${numbers(segment[1], segment[2])} l`;
        case "curve":
          return `${numbers(segment[1], segment[2], segment[3], segment[4])} v`;
        case "close":
          return "h";
      }
    })
    .join(" ");
  return [
    "q",
    paint.fill === undefined ? "" : fillColor(paint.fill),
    paint.stroke === undefined ? "" : strokeColor(paint.stroke),
    paint.stroke === undefined ? "" : `${pdfNumber(paint.lineWidth ?? 1)} w`,
    path,
    operator,
    "Q",
  ]
    .filter((part) => part !== "")
    .join(" ");
};

export const pdfText = (run: PdfTextRun): string =>
  [
    "q BT",
    fillColor(run.color),
    `/${run.fontName} ${pdfNumber(run.size)} Tf`,
    `${pdfNumber(run.lineHeight)} TL`,
    `1 0 0 1 ${numbers(run.x, run.y)} Tm`,
    ...run.lines.map((line) => `${hexText(run.font, line)} Tj T*`),
    "ET Q",
  ].join(" ");

export const pdfImage = (
  name: string,
  rect: readonly [x: number, y: number, width: number, height: number],
): string => {
  const [x, y, width, height] = rect;
  return `q ${numbers(width, 0, 0, height, x, y)} cm /${name} Do Q`;
};

export const pdfTransform = (
  matrix: readonly [number, number, number, number, number, number],
  body: ReadonlyArray<string>,
): ReadonlyArray<string> => [`q ${numbers(...matrix)} cm`, ...body, "Q"];
