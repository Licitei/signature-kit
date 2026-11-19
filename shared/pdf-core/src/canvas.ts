import { Effect, Option, Schema } from "effect";
import type { Scope } from "effect";

import {
  PDF_CORE_DEFAULT_PAGE_IMAGE_TYPE,
  PdfCoreError,
  PdfCoreErrorCodeValue,
  PdfCoreOperationValue,
  PdfCorePaintOptionsSchema,
  PdfCoreSchemaNameValue,
} from "./config.js";
import type { PdfCoreDisplayList, PdfCoreOcrRaster, PdfCorePaintOptions } from "./config.js";

export type PdfCoreCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type PdfCoreImageSource = ImageBitmap | OffscreenCanvas;
export type PdfCoreDisplayListImages = ReadonlyMap<number, PdfCoreImageSource>;
export type PdfCorePageImage = {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly image: Blob;
};

type Matrix = readonly [number, number, number, number, number, number];

type GradientSpec = {
  readonly radial: boolean;
  readonly extendStart: boolean;
  readonly extendEnd: boolean;
  readonly coords: readonly [number, number, number, number, number, number];
  readonly stops: ReadonlyArray<readonly [number, string]>;
};
type PatternPaint = { readonly gradient: GradientSpec; readonly matrix: Matrix };
type PaintState = {
  ctm: Matrix;
  lineWidth: number;
  fillPattern: PatternPaint | undefined;
  strokePattern: PatternPaint | undefined;
  fillColor: string;
};
type ImageOp = {
  readonly jpeg: boolean;
  readonly maskJpeg: boolean;
  readonly interpolate: boolean;
  readonly matte: readonly [number, number, number] | undefined;
  readonly blob: number;
  readonly width: number;
  readonly height: number;
  readonly mask: number;
  readonly maskWidth: number;
  readonly maskHeight: number;
};

const OP_SAVE = 1;
const OP_RESTORE = 2;
const OP_TRANSFORM = 3;
const OP_PATH = 4;
const OP_FILL = 5;
const OP_STROKE = 6;
const OP_CLIP = 7;
const OP_FILL_COLOR = 8;
const OP_STROKE_COLOR = 9;
const OP_LINE_WIDTH = 10;
const OP_LINE_CAP = 11;
const OP_LINE_JOIN = 12;
const OP_MITER = 13;
const OP_DASH = 14;
const OP_BLEND = 15;
const OP_GLYPH_DEFINE = 16;
const OP_GLYPH = 17;
const OP_TEXT_CLIP = 18;
const OP_TEXT = 19;
const OP_IMAGE = 20;
const OP_SHADE = 21;
const OP_FILL_GRADIENT = 22;
const OP_STROKE_GRADIENT = 23;

const VERB_MOVE = 0;
const VERB_LINE = 1;
const VERB_CUBIC = 2;
const VERB_CLOSE = 3;
const VERB_QUAD = 4;

const NO_BLOB = 0xffff_ffff;
const GLYPH_FILL = 1;
const GLYPH_STROKE = 2;
const GLYPH_CLIP = 4;
const TEXT_SERIF = 1;
const TEXT_MONO = 2;
const TEXT_BOLD = 4;
const TEXT_ITALIC = 8;
const TEXT_FILL = 16;
const TEXT_STROKE = 32;
const TEXT_SIZE = 100;
const MAX_CANVAS_SIDE = 16_384;
const MAX_CANVAS_AREA = 16_384 * 16_384;

const CAPS: ReadonlyArray<CanvasLineCap> = ["butt", "round", "square"];
const JOINS: ReadonlyArray<CanvasLineJoin> = ["miter", "round", "bevel"];
const BLENDS: ReadonlyArray<GlobalCompositeOperation> = [
  "source-over",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];
const FAMILIES = [
  '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif',
  '"Times New Roman", Times, "Liberation Serif", serif',
  '"Courier New", Courier, "Liberation Mono", monospace',
];

const utf8 = new TextDecoder();

const multiply = (first: Matrix, second: Matrix): Matrix => [
  first[0] * second[0] + first[1] * second[2],
  first[0] * second[1] + first[1] * second[3],
  first[2] * second[0] + first[3] * second[2],
  first[2] * second[1] + first[3] * second[3],
  first[4] * second[0] + first[5] * second[2] + second[4],
  first[4] * second[1] + first[5] * second[3] + second[5],
];

const invert = (matrix: Matrix): Matrix | undefined => {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (determinant === 0 || !Number.isFinite(determinant)) return undefined;
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
};

const deviceScale = (matrix: Matrix): number =>
  Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]));

const rgba = (red: number, green: number, blue: number, alpha: number): string =>
  `rgba(${red},${green},${blue},${alpha / 255})`;

export const displayListViewport = (
  list: PdfCoreDisplayList,
  scale: number = list.scale,
): { readonly width: number; readonly height: number; readonly transform: Matrix } => {
  const [x0, y0, x1, y1] = list.view;
  const rotate = ((list.rotate % 360) + 360) % 360;
  const pageWidth = (x1 - x0) * scale;
  const pageHeight = (y1 - y0) * scale;
  const sideways = rotate === 90 || rotate === 270;
  const transform: Matrix =
    rotate === 90
      ? [0, scale, scale, 0, -y0 * scale, -x0 * scale]
      : rotate === 180
        ? [-scale, 0, 0, scale, x1 * scale, -y0 * scale]
        : rotate === 270
          ? [0, -scale, -scale, 0, y1 * scale, x1 * scale]
          : [scale, 0, 0, -scale, -x0 * scale, y1 * scale];
  return {
    width: Math.max(1, Math.ceil(sideways ? pageHeight : pageWidth)),
    height: Math.max(1, Math.ceil(sideways ? pageWidth : pageHeight)),
    transform,
  };
};

const VERB_COORDS = [2, 2, 6, 0, 4];

class OpReader {
  readonly view: DataView;
  offset = 0;
  failed = false;

  constructor(readonly ops: Uint8Array) {
    this.view = new DataView(ops.buffer, ops.byteOffset, ops.byteLength);
  }

  get done(): boolean {
    return this.failed || this.offset >= this.ops.byteLength;
  }

  claim(length: number): number | undefined {
    const at = this.offset;
    if (this.failed || length < 0 || at + length > this.ops.byteLength) {
      this.failed = true;
      this.offset = this.ops.byteLength;
      return undefined;
    }
    this.offset = at + length;
    return at;
  }

  u8(): number {
    const at = this.claim(1);
    return at === undefined ? 0 : this.view.getUint8(at);
  }

  u32(): number {
    const at = this.claim(4);
    return at === undefined ? 0 : this.view.getUint32(at, true);
  }

  f32(): number {
    const at = this.claim(4);
    return at === undefined ? 0 : this.view.getFloat32(at, true);
  }

  matrix(): Matrix {
    return [this.f32(), this.f32(), this.f32(), this.f32(), this.f32(), this.f32()];
  }

  path(target: CanvasPath | undefined): void {
    const verbCount = this.u32();
    const verbsAt = this.claim(verbCount);
    const coordCount = this.u32();
    const coordsAt = this.claim(coordCount * 4);
    if (verbsAt === undefined || coordsAt === undefined) return;
    let cursor = coordsAt;
    const end = coordsAt + coordCount * 4;
    const next = (): number => {
      const value = this.view.getFloat32(cursor, true);
      cursor += 4;
      return value;
    };
    for (let index = 0; index < verbCount; index += 1) {
      const verb = this.view.getUint8(verbsAt + index);
      const needed = VERB_COORDS[verb];
      if (needed === undefined || cursor + needed * 4 > end) {
        this.failed = true;
        return;
      }
      if (target === undefined) {
        cursor += needed * 4;
        continue;
      }
      switch (verb) {
        case VERB_MOVE:
          target.moveTo(next(), next());
          break;
        case VERB_LINE:
          target.lineTo(next(), next());
          break;
        case VERB_CUBIC:
          target.bezierCurveTo(next(), next(), next(), next(), next(), next());
          break;
        case VERB_QUAD:
          target.quadraticCurveTo(next(), next(), next(), next());
          break;
        case VERB_CLOSE:
          target.closePath();
          break;
      }
    }
  }

  skipPath(): void {
    this.path(undefined);
  }

  gradient(withMatrix: boolean): PatternPaint {
    const flags = this.u8();
    const coords: GradientSpec["coords"] = [
      this.f32(),
      this.f32(),
      this.f32(),
      this.f32(),
      this.f32(),
      this.f32(),
    ];
    const matrix: Matrix = withMatrix ? this.matrix() : [1, 0, 0, 1, 0, 0];
    const count = this.u32();
    const stops: Array<readonly [number, string]> = [];
    for (let index = 0; index < count; index += 1) {
      const offset = this.f32();
      const red = this.u8();
      const green = this.u8();
      const blue = this.u8();
      const alpha = this.u8();
      stops.push([
        Number.isFinite(offset) ? Math.min(1, Math.max(0, offset)) : 0,
        rgba(red, green, blue, alpha),
      ]);
    }
    return {
      gradient: {
        radial: (flags & 1) !== 0,
        extendStart: (flags & 2) !== 0,
        extendEnd: (flags & 4) !== 0,
        coords,
        stops,
      },
      matrix,
    };
  }

  image(): ImageOp & { readonly alpha: number } {
    const flags = this.u8();
    const alpha = this.u8();
    const blob = this.u32();
    const width = this.u32();
    const height = this.u32();
    const mask = this.u32();
    const maskWidth = this.u32();
    const maskHeight = this.u32();
    const matte: readonly [number, number, number] = [this.u8(), this.u8(), this.u8()];
    this.claim(1);
    return {
      jpeg: (flags & 1) !== 0,
      maskJpeg: (flags & 2) !== 0,
      matte: (flags & 4) !== 0 ? matte : undefined,
      interpolate: (flags & 8) !== 0,
      alpha,
      blob,
      width,
      height,
      mask,
      maskWidth,
      maskHeight,
    };
  }

  skipText(): void {
    this.claim(1 + 24 + 4);
    this.claim(this.u32());
  }
}

const canvasGradient = (
  context: PdfCoreCanvasContext,
  spec: GradientSpec,
): CanvasGradient | undefined => {
  const [first, second, third, fourth, fifth, sixth] = spec.coords;
  if (!spec.coords.every(Number.isFinite)) return undefined;
  const gradient = spec.radial
    ? context.createRadialGradient(
        first,
        second,
        Math.max(0, third),
        fourth,
        fifth,
        Math.max(0, sixth),
      )
    : context.createLinearGradient(first, second, third, fourth);
  if (!spec.extendStart) gradient.addColorStop(0, "rgba(0,0,0,0)");
  for (const [offset, color] of spec.stops) gradient.addColorStop(offset, color);
  if (!spec.extendEnd) gradient.addColorStop(1, "rgba(0,0,0,0)");
  return gradient;
};

const middleColor = (spec: GradientSpec): string =>
  spec.stops[Math.floor(spec.stops.length / 2)]?.[1] ?? "rgba(0,0,0,1)";

export const displayListImageBlobs = (list: PdfCoreDisplayList): ReadonlyArray<ImageOp> => {
  const reader = new OpReader(list.ops);
  const images: Array<ImageOp> = [];
  while (!reader.done) {
    const code = reader.u8();
    switch (code) {
      case OP_SAVE:
      case OP_RESTORE:
      case OP_STROKE:
      case OP_TEXT_CLIP:
        break;
      case OP_FILL:
      case OP_CLIP:
      case OP_LINE_CAP:
      case OP_LINE_JOIN:
      case OP_BLEND:
        reader.claim(1);
        break;
      case OP_FILL_COLOR:
      case OP_STROKE_COLOR:
      case OP_LINE_WIDTH:
      case OP_MITER:
        reader.claim(4);
        break;
      case OP_TRANSFORM:
        reader.claim(24);
        break;
      case OP_PATH:
        reader.skipPath();
        break;
      case OP_GLYPH_DEFINE:
        reader.claim(4);
        reader.skipPath();
        break;
      case OP_GLYPH:
        reader.claim(1 + 4 + 24);
        break;
      case OP_DASH:
        reader.claim(reader.u32() * 4 + 4);
        break;
      case OP_TEXT:
        reader.skipText();
        break;
      case OP_IMAGE:
        images.push(reader.image());
        break;
      case OP_SHADE:
        reader.gradient(false);
        break;
      case OP_FILL_GRADIENT:
      case OP_STROKE_GRADIENT:
        reader.gradient(true);
        break;
      default:
        return images;
    }
  }
  return images;
};

export const paintDisplayList = (
  context: PdfCoreCanvasContext,
  list: PdfCoreDisplayList,
  images: PdfCoreDisplayListImages,
  scale: number = list.scale,
): Effect.Effect<void, PdfCoreError> =>
  Effect.try({
    try: () => paintOps(context, list, images, scale),
    catch: () =>
      new PdfCoreError({
        code: PdfCoreErrorCodeValue.paintFailed,
        operation: PdfCoreOperationValue.paint,
        reason: "The page display list could not be painted.",
      }),
  }).pipe(
    Effect.flatMap((complete) =>
      complete
        ? Effect.void
        : Effect.fail(
            new PdfCoreError({
              code: PdfCoreErrorCodeValue.paintFailed,
              operation: PdfCoreOperationValue.paint,
              reason: "The page display list is malformed.",
            }),
          ),
    ),
  );

const paintOps = (
  context: PdfCoreCanvasContext,
  list: PdfCoreDisplayList,
  images: PdfCoreDisplayListImages,
  scale: number,
): boolean => {
  const base = displayListViewport(list, scale).transform;
  const reader = new OpReader(list.ops);
  const glyphs = new Map<number, Path2D>();
  const stack: Array<PaintState> = [];
  let state: PaintState = {
    ctm: [1, 0, 0, 1, 0, 0],
    lineWidth: 1,
    fillPattern: undefined,
    strokePattern: undefined,
    fillColor: "rgba(0,0,0,1)",
  };
  let device: Matrix = base;
  let transformDirty = false;
  let textClip: Path2D | undefined;
  const applyTransform = (): void => {
    if (transformDirty) {
      context.setTransform(device[0], device[1], device[2], device[3], device[4], device[5]);
      transformDirty = false;
    }
  };
  const setDevice = (matrix: Matrix): void => {
    context.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    transformDirty = true;
  };
  const strokeWidth = (matrix: Matrix, width: number): number => {
    const factor = deviceScale(matrix);
    if (factor === 0) return width;
    return Math.max(width, 1 / factor);
  };
  const withPattern = (pattern: PatternPaint, paint: (gradient: CanvasGradient) => void): void => {
    const gradient = canvasGradient(context, pattern.gradient);
    if (gradient === undefined) return;
    context.save();
    const matrix = multiply(pattern.matrix, base);
    context.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    paint(gradient);
    context.restore();
  };
  context.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
  context.lineWidth = 1;
  context.fillStyle = state.fillColor;
  context.strokeStyle = "rgba(0,0,0,1)";
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "medium";
  while (!reader.done) {
    const code = reader.u8();
    switch (code) {
      case OP_SAVE:
        applyTransform();
        context.save();
        stack.push({ ...state });
        break;
      case OP_RESTORE: {
        context.restore();
        const previous = stack.pop();
        if (previous !== undefined) state = previous;
        device = multiply(state.ctm, base);
        transformDirty = false;
        break;
      }
      case OP_TRANSFORM:
        state.ctm = reader.matrix();
        device = multiply(state.ctm, base);
        transformDirty = true;
        break;
      case OP_PATH:
        applyTransform();
        context.beginPath();
        reader.path(context);
        break;
      case OP_FILL: {
        const rule: CanvasFillRule = reader.u8() === 1 ? "evenodd" : "nonzero";
        applyTransform();
        const pattern = state.fillPattern;
        if (pattern === undefined) {
          context.fill(rule);
        } else {
          withPattern(pattern, (gradient) => {
            context.fillStyle = gradient;
            context.fill(rule);
          });
        }
        break;
      }
      case OP_STROKE: {
        applyTransform();
        context.lineWidth = strokeWidth(device, state.lineWidth);
        const pattern = state.strokePattern;
        if (pattern === undefined) {
          context.stroke();
        } else {
          const width = state.lineWidth * deviceScale(device);
          withPattern(pattern, (gradient) => {
            context.strokeStyle = gradient;
            const patternScale = deviceScale(multiply(pattern.matrix, base));
            context.lineWidth = patternScale === 0 ? width : Math.max(1, width) / patternScale;
            context.stroke();
          });
        }
        break;
      }
      case OP_CLIP: {
        const rule: CanvasFillRule = reader.u8() === 1 ? "evenodd" : "nonzero";
        applyTransform();
        context.clip(rule);
        break;
      }
      case OP_FILL_COLOR: {
        const color = rgba(reader.u8(), reader.u8(), reader.u8(), reader.u8());
        context.fillStyle = color;
        state.fillColor = color;
        state.fillPattern = undefined;
        break;
      }
      case OP_STROKE_COLOR:
        context.strokeStyle = rgba(reader.u8(), reader.u8(), reader.u8(), reader.u8());
        state.strokePattern = undefined;
        break;
      case OP_LINE_WIDTH:
        state.lineWidth = reader.f32();
        break;
      case OP_LINE_CAP:
        context.lineCap = CAPS[reader.u8()] ?? "butt";
        break;
      case OP_LINE_JOIN:
        context.lineJoin = JOINS[reader.u8()] ?? "miter";
        break;
      case OP_MITER:
        context.miterLimit = Math.max(1, reader.f32());
        break;
      case OP_DASH: {
        const count = reader.u32();
        const lengths: Array<number> = [];
        for (let index = 0; index < count; index += 1) lengths.push(Math.max(0, reader.f32()));
        const phase = reader.f32();
        const visible = lengths.some((length) => length > 0) && lengths.every(Number.isFinite);
        context.setLineDash(visible ? lengths : []);
        context.lineDashOffset = Number.isFinite(phase) ? phase : 0;
        break;
      }
      case OP_BLEND:
        context.globalCompositeOperation = BLENDS[reader.u8()] ?? "source-over";
        break;
      case OP_GLYPH_DEFINE: {
        const id = reader.u32();
        const path = new Path2D();
        reader.path(path);
        glyphs.set(id, path);
        break;
      }
      case OP_GLYPH: {
        const modes = reader.u8();
        const path = glyphs.get(reader.u32());
        const local = reader.matrix();
        if (path === undefined) break;
        const matrix = multiply(local, device);

        setDevice(matrix);
        if ((modes & GLYPH_FILL) !== 0) {
          if (state.fillPattern !== undefined) {
            context.fillStyle = middleColor(state.fillPattern.gradient);
          }
          context.fill(path);
          if (state.fillPattern !== undefined) context.fillStyle = state.fillColor;
        }
        if ((modes & GLYPH_STROKE) !== 0) {
          const glyphScale = deviceScale(local);
          context.lineWidth =
            glyphScale === 0 ? 1 : strokeWidth(device, state.lineWidth) / glyphScale;
          context.stroke(path);
        }
        if ((modes & GLYPH_CLIP) !== 0) {
          textClip ??= new Path2D();
          textClip.addPath(path, {
            a: matrix[0],
            b: matrix[1],
            c: matrix[2],
            d: matrix[3],
            e: matrix[4],
            f: matrix[5],
          });
        }
        break;
      }
      case OP_TEXT_CLIP:
        if (textClip !== undefined) {
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clip(textClip);
          transformDirty = true;
          textClip = undefined;
        }
        break;
      case OP_TEXT: {
        const flags = reader.u8();
        const local = reader.matrix();
        const width = reader.f32();
        const length = reader.u32();
        const at = reader.claim(length);
        if (at === undefined) break;
        const text = utf8.decode(reader.ops.subarray(at, at + length));
        const family =
          FAMILIES[(flags & TEXT_MONO) !== 0 ? 2 : (flags & TEXT_SERIF) !== 0 ? 1 : 0] ??
          "sans-serif";
        const italic = (flags & TEXT_ITALIC) !== 0 ? "italic " : "";
        const bold = (flags & TEXT_BOLD) !== 0 ? "bold " : "";
        context.font = `${italic}${bold}${TEXT_SIZE}px ${family}`;
        const measured = context.measureText(text).width;
        const target = width * TEXT_SIZE;
        const stretch =
          measured > 0 && target > 0 ? Math.min(4, Math.max(0.25, target / measured)) : 1;
        const matrix = multiply(
          [stretch / TEXT_SIZE, 0, 0, -1 / TEXT_SIZE, 0, 0],
          multiply(local, device),
        );
        setDevice(matrix);
        if ((flags & TEXT_FILL) !== 0) {
          if (state.fillPattern !== undefined) {
            context.fillStyle = middleColor(state.fillPattern.gradient);
          }
          context.fillText(text, 0, 0);
          if (state.fillPattern !== undefined) context.fillStyle = state.fillColor;
        }
        if ((flags & TEXT_STROKE) !== 0) {
          const textScale = deviceScale(matrix);
          context.lineWidth =
            textScale === 0 ? 1 : Math.max(1, state.lineWidth * deviceScale(device)) / textScale;
          context.strokeText(text, 0, 0);
        }
        break;
      }
      case OP_IMAGE: {
        const image = reader.image();
        const source = images.get(image.blob);
        if (source === undefined) break;
        applyTransform();
        context.save();
        context.globalAlpha *= image.alpha / 255;
        context.imageSmoothingEnabled =
          image.interpolate ||
          (Math.hypot(device[0], device[1]) <= image.width &&
            Math.hypot(device[2], device[3]) <= image.height);
        context.transform(1, 0, 0, -1, 0, 1);
        context.drawImage(source, 0, 0, 1, 1);
        context.restore();
        break;
      }
      case OP_SHADE: {
        const pattern = reader.gradient(false);
        const gradient = canvasGradient(context, pattern.gradient);
        const inverse = invert(device);
        if (gradient === undefined || inverse === undefined) break;
        applyTransform();
        const canvas = context.canvas;
        const corners: ReadonlyArray<readonly [number, number]> = [
          [0, 0],
          [canvas.width, 0],
          [canvas.width, canvas.height],
          [0, canvas.height],
        ];
        context.save();
        context.beginPath();
        for (const [x, y] of corners) {
          context.lineTo(
            x * inverse[0] + y * inverse[2] + inverse[4],
            x * inverse[1] + y * inverse[3] + inverse[5],
          );
        }
        context.closePath();
        context.fillStyle = gradient;
        context.fill();
        context.restore();
        break;
      }
      case OP_FILL_GRADIENT:
        state.fillPattern = reader.gradient(true);
        break;
      case OP_STROKE_GRADIENT:
        state.strokePattern = reader.gradient(true);
        break;
      default:
        return false;
    }
  }
  return !reader.failed;
};

const decodeJpeg = (bytes: Uint8Array): Effect.Effect<ImageBitmap, PdfCoreError> =>
  Effect.tryPromise({
    try: () => createImageBitmap(new Blob([bytes.slice()], { type: "image/jpeg" })),
    catch: () =>
      new PdfCoreError({
        code: PdfCoreErrorCodeValue.paintFailed,
        operation: PdfCoreOperationValue.paint,
        reason: "A JPEG image could not be decoded.",
      }),
  });

const offscreen = (
  width: number,
  height: number,
): Effect.Effect<
  { readonly canvas: OffscreenCanvas; readonly context: OffscreenCanvasRenderingContext2D },
  PdfCoreError
> =>
  Effect.gen(function* () {
    const canvas = yield* Effect.try({
      try: () => new OffscreenCanvas(width, height),
      catch: () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.paintFailed,
          operation: PdfCoreOperationValue.paint,
          reason: "An image canvas could not be created.",
        }),
    });
    const context = canvas.getContext("2d");
    if (context === null)
      return yield* new PdfCoreError({
        code: PdfCoreErrorCodeValue.paintFailed,
        operation: PdfCoreOperationValue.paint,
        reason: "An image canvas has no 2D context.",
      });
    return { canvas, context };
  });

const releaseBitmap = (bitmap: Option.Option<ImageBitmap>): Effect.Effect<void> =>
  Effect.sync(() => {
    if (Option.isSome(bitmap)) bitmap.value.close();
  });

const maskAlpha = (
  image: ImageOp,
  bytes: Uint8Array,
): Effect.Effect<Uint8Array | undefined, PdfCoreError> =>
  image.maskJpeg
    ? Effect.acquireUseRelease(
        decodeJpeg(bytes).pipe(Effect.option),
        (bitmap) =>
          Option.isNone(bitmap)
            ? Effect.succeed(undefined)
            : Effect.gen(function* () {
                const { context } = yield* offscreen(bitmap.value.width, bitmap.value.height);
                context.drawImage(bitmap.value, 0, 0);
                const pixels = context.getImageData(0, 0, image.maskWidth, image.maskHeight).data;
                const alpha = new Uint8Array(image.maskWidth * image.maskHeight);
                for (let index = 0; index < alpha.length; index += 1) {
                  alpha[index] = pixels[index * 4] ?? 255;
                }
                return alpha;
              }),
        releaseBitmap,
      )
    : Effect.succeed(bytes);

const maskedImage = (
  bitmap: ImageBitmap,
  image: ImageOp,
  mask: Uint8Array,
): Effect.Effect<PdfCoreImageSource, PdfCoreError> =>
  Effect.gen(function* () {
    const { canvas, context } = yield* offscreen(bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = pixels.data;
    const matte = image.matte;
    for (let y = 0; y < canvas.height; y += 1) {
      const row = Math.floor((y * image.maskHeight) / canvas.height) * image.maskWidth;
      for (let x = 0; x < canvas.width; x += 1) {
        const alpha = mask[row + Math.floor((x * image.maskWidth) / canvas.width)] ?? 255;
        const at = (y * canvas.width + x) * 4;
        if (matte !== undefined && alpha > 0 && alpha < 255) {
          for (let channel = 0; channel < 3; channel += 1) {
            const base = matte[channel] ?? 0;
            data[at + channel] = base + (((data[at + channel] ?? 0) - base) * 255) / alpha;
          }
        }
        data[at + 3] = ((data[at + 3] ?? 255) * alpha) / 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  });

const decodeImage = (
  image: ImageOp,
  bytes: Uint8Array,
): Effect.Effect<Option.Option<ImageBitmap>, PdfCoreError> =>
  image.jpeg
    ? decodeJpeg(bytes).pipe(Effect.option)
    : Effect.tryPromise({
        try: () =>
          createImageBitmap(new ImageData(new Uint8ClampedArray(bytes), image.width, image.height)),
        catch: () =>
          new PdfCoreError({
            code: PdfCoreErrorCodeValue.paintFailed,
            operation: PdfCoreOperationValue.paint,
            reason: "A decoded image could not be uploaded.",
          }),
      }).pipe(Effect.asSome);

export const prepareDisplayListImages = (
  list: PdfCoreDisplayList,
): Effect.Effect<ReadonlyMap<number, PdfCoreImageSource>, PdfCoreError, Scope.Scope> =>
  Effect.gen(function* () {
    const prepared = new Map<number, PdfCoreImageSource>();
    for (const image of displayListImageBlobs(list)) {
      if (prepared.has(image.blob)) continue;
      const bytes = list.blobs[image.blob];
      if (bytes === undefined || image.width === 0 || image.height === 0) continue;
      if (!image.jpeg && bytes.byteLength !== image.width * image.height * 4) continue;
      const maskBytes = image.mask === NO_BLOB ? undefined : list.blobs[image.mask];
      const alpha = maskBytes === undefined ? undefined : yield* maskAlpha(image, maskBytes);
      if (alpha === undefined || alpha.byteLength < image.maskWidth * image.maskHeight) {
        const bitmap = yield* Effect.acquireRelease(decodeImage(image, bytes), releaseBitmap);
        if (Option.isSome(bitmap)) prepared.set(image.blob, bitmap.value);
        continue;
      }
      const masked = yield* Effect.acquireUseRelease(
        decodeImage(image, bytes),
        (bitmap) =>
          Option.isNone(bitmap)
            ? Effect.succeed(Option.none<PdfCoreImageSource>())
            : maskedImage(bitmap.value, image, alpha).pipe(Effect.asSome),
        releaseBitmap,
      );
      if (Option.isSome(masked)) prepared.set(image.blob, masked.value);
    }
    return prepared;
  });

const fitScale = (list: PdfCoreDisplayList, scale: number): number => {
  const fits = (candidate: number): boolean => {
    const viewport = displayListViewport(list, candidate);
    return (
      viewport.width <= MAX_CANVAS_SIDE &&
      viewport.height <= MAX_CANVAS_SIDE &&
      viewport.width * viewport.height <= MAX_CANVAS_AREA
    );
  };
  if (fits(scale)) return scale;
  const viewport = displayListViewport(list, scale);
  let fitted =
    scale *
    Math.min(
      MAX_CANVAS_SIDE / viewport.width,
      MAX_CANVAS_SIDE / viewport.height,
      Math.sqrt(MAX_CANVAS_AREA / (viewport.width * viewport.height)),
    );
  for (let attempt = 0; attempt < 16 && !fits(fitted); attempt += 1) fitted *= 0.999;
  return fitted;
};

export const renderDisplayListImage = (
  list: PdfCoreDisplayList,
  rawOptions: PdfCorePaintOptions = {},
): Effect.Effect<PdfCorePageImage, PdfCoreError> =>
  Effect.gen(function* () {
    const options = yield* Schema.decodeUnknownEffect(PdfCorePaintOptionsSchema)(rawOptions).pipe(
      Effect.mapError(
        (issue) =>
          new PdfCoreError({
            code: PdfCoreErrorCodeValue.invalidOptions,
            operation: PdfCoreOperationValue.paint,
            schemaName: PdfCoreSchemaNameValue.paintOptions,
            issueMessage: String(issue),
          }),
      ),
    );
    const scale = fitScale(list, options.scale ?? list.scale);
    const viewport = displayListViewport(list, scale);
    const images = yield* prepareDisplayListImages(list);
    const canvas = yield* Effect.try({
      try: () => new OffscreenCanvas(viewport.width, viewport.height),
      catch: () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.paintFailed,
          operation: PdfCoreOperationValue.paint,
          reason: "The page canvas could not be created.",
        }),
    });
    const context = canvas.getContext("2d");
    if (context === null) {
      return yield* new PdfCoreError({
        code: PdfCoreErrorCodeValue.paintFailed,
        operation: PdfCoreOperationValue.paint,
        reason: "The page canvas has no 2D context.",
      });
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, viewport.width, viewport.height);
    yield* paintDisplayList(context, list, images, scale);
    const type = options.type ?? PDF_CORE_DEFAULT_PAGE_IMAGE_TYPE;
    const image = yield* Effect.tryPromise({
      try: () =>
        canvas.convertToBlob(
          options.quality === undefined ? { type } : { type, quality: options.quality },
        ),
      catch: () =>
        new PdfCoreError({
          code: PdfCoreErrorCodeValue.paintFailed,
          operation: PdfCoreOperationValue.paint,
          reason: "The page image could not be encoded.",
        }),
    });
    return {
      pageIndex: list.pageIndex,
      width: viewport.width,
      height: viewport.height,
      image,
    };
  }).pipe(Effect.scoped);

export const renderOcrPage = Effect.fn(function* (
  list: PdfCoreDisplayList,
): Effect.fn.Return<PdfCoreOcrRaster, PdfCoreError> {
  const scale = fitScale(list, list.scale);
  const { width, height, image } = yield* renderDisplayListImage(list, { scale });
  const { transform } = displayListViewport(list, scale);
  const inverse = invert(transform);
  if (inverse === undefined) {
    return yield* new PdfCoreError({
      code: PdfCoreErrorCodeValue.paintFailed,
      operation: PdfCoreOperationValue.paint,
      pageIndex: list.pageIndex,
      reason: "The page viewport has no inverse transform.",
    });
  }
  const [a, b, c, d, e, f] = inverse;
  const bytes = yield* Effect.tryPromise({
    try: async () => new Uint8Array(await image.arrayBuffer()),
    catch: () =>
      new PdfCoreError({
        code: PdfCoreErrorCodeValue.paintFailed,
        operation: PdfCoreOperationValue.paint,
        pageIndex: list.pageIndex,
        reason: "The rendered OCR image could not be read.",
      }),
  });
  return {
    mediaType: PDF_CORE_DEFAULT_PAGE_IMAGE_TYPE,
    bytes,
    width,
    height,
    dpiX: scale * 72,
    dpiY: scale * 72,
    placement: [a * width, b * width, -c * height, -d * height, e + c * height, f + d * height],
  };
});
