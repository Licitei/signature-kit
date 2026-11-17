import { Effect, Option, Schema } from "effect";

import {
  PdfCoreError,
  PdfCoreErrorCodeValue,
  PdfCoreOperationValue,
  PdfCorePaintOptionsSchema,
  PdfCoreSchemaNameValue,
} from "./config.js";
import type { PdfCoreDisplayList, PdfCorePaintOptions } from "./config.js";

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

class OpReader {
  readonly view: DataView;
  offset = 0;

  constructor(readonly ops: Uint8Array) {
    this.view = new DataView(ops.buffer, ops.byteOffset, ops.byteLength);
  }

  get done(): boolean {
    return this.offset >= this.ops.byteLength;
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32(): number {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  matrix(): Matrix {
    return [this.f32(), this.f32(), this.f32(), this.f32(), this.f32(), this.f32()];
  }

  path(target: CanvasPath): void {
    const verbCount = this.u32();
    const verbsAt = this.offset;
    this.offset += verbCount;
    const coordCount = this.u32();
    const coordsAt = this.offset;
    this.offset += coordCount * 4;
    let cursor = coordsAt;
    const next = (): number => {
      const value = this.view.getFloat32(cursor, true);
      cursor += 4;
      return value;
    };
    for (let index = 0; index < verbCount; index += 1) {
      switch (this.view.getUint8(verbsAt + index)) {
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
        default:
          return;
      }
    }
  }

  skipPath(): void {
    const verbCount = this.u32();
    this.offset += verbCount;
    const coordCount = this.u32();
    this.offset += coordCount * 4;
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
      stops.push([Math.min(1, Math.max(0, offset)), rgba(red, green, blue, alpha)]);
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
    this.offset += 1;
    return {
      jpeg: (flags & 1) !== 0,
      maskJpeg: (flags & 2) !== 0,
      matte: (flags & 4) !== 0 ? matte : undefined,
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
    this.offset += 1 + 24 + 4;
    const length = this.u32();
    this.offset += length;
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
        reader.offset += 1;
        break;
      case OP_FILL_COLOR:
      case OP_STROKE_COLOR:
      case OP_LINE_WIDTH:
      case OP_MITER:
        reader.offset += 4;
        break;
      case OP_TRANSFORM:
        reader.offset += 24;
        break;
      case OP_PATH:
        reader.skipPath();
        break;
      case OP_GLYPH_DEFINE:
        reader.offset += 4;
        reader.skipPath();
        break;
      case OP_GLYPH:
        reader.offset += 1 + 4 + 24;
        break;
      case OP_DASH: {
        const count = reader.u32();
        reader.offset += count * 4 + 4;
        break;
      }
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
): void => {
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
        const text = utf8.decode(reader.ops.subarray(reader.offset, reader.offset + length));
        reader.offset += length;
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
        return;
    }
  }
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

const maskAlpha = (
  image: ImageOp,
  bytes: Uint8Array,
): Effect.Effect<Uint8Array | undefined, PdfCoreError> =>
  Effect.gen(function* () {
    if (!image.maskJpeg) return bytes;
    const bitmap = yield* decodeJpeg(bytes).pipe(Effect.option);
    if (Option.isNone(bitmap)) return undefined;
    const { context } = yield* offscreen(bitmap.value.width, bitmap.value.height);
    context.drawImage(bitmap.value, 0, 0);
    bitmap.value.close();
    const pixels = context.getImageData(0, 0, image.maskWidth, image.maskHeight).data;
    const alpha = new Uint8Array(image.maskWidth * image.maskHeight);
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = pixels[index * 4] ?? 255;
    return alpha;
  });

const maskedImage = (
  bitmap: ImageBitmap,
  image: ImageOp,
  mask: Uint8Array,
): Effect.Effect<PdfCoreImageSource, PdfCoreError> =>
  Effect.gen(function* () {
    const { canvas, context } = yield* offscreen(bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
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

export const prepareDisplayListImages = (
  list: PdfCoreDisplayList,
): Effect.Effect<Map<number, PdfCoreImageSource>, PdfCoreError> =>
  Effect.gen(function* () {
    const prepared = new Map<number, PdfCoreImageSource>();
    for (const image of displayListImageBlobs(list)) {
      if (prepared.has(image.blob)) continue;
      const bytes = list.blobs[image.blob];
      if (bytes === undefined || image.width === 0 || image.height === 0) continue;
      if (!image.jpeg && bytes.byteLength !== image.width * image.height * 4) continue;
      const decoded = image.jpeg
        ? yield* decodeJpeg(bytes).pipe(Effect.option)
        : Option.some(
            yield* Effect.tryPromise({
              try: () =>
                createImageBitmap(
                  new ImageData(new Uint8ClampedArray(bytes), image.width, image.height),
                ),
              catch: () =>
                new PdfCoreError({
                  code: PdfCoreErrorCodeValue.paintFailed,
                  operation: PdfCoreOperationValue.paint,
                  reason: "A decoded image could not be uploaded.",
                }),
            }),
          );
      if (Option.isNone(decoded)) continue;
      const maskBytes = image.mask === NO_BLOB ? undefined : list.blobs[image.mask];
      const alpha = maskBytes === undefined ? undefined : yield* maskAlpha(image, maskBytes);
      prepared.set(
        image.blob,
        alpha === undefined || alpha.byteLength < image.maskWidth * image.maskHeight
          ? decoded.value
          : yield* maskedImage(decoded.value, image, alpha),
      );
    }
    return prepared;
  });

const closeImages = (images: PdfCoreDisplayListImages): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const source of images.values()) {
      if ("close" in source) source.close();
    }
  });

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
    const scale = options.scale ?? list.scale;
    const viewport = displayListViewport(list, scale);
    if (
      viewport.width > MAX_CANVAS_SIDE ||
      viewport.height > MAX_CANVAS_SIDE ||
      viewport.width * viewport.height > MAX_CANVAS_AREA
    ) {
      return yield* new PdfCoreError({
        code: PdfCoreErrorCodeValue.limitExceeded,
        operation: PdfCoreOperationValue.paint,
        reason: "The page is too large to paint at this scale.",
      });
    }
    return yield* Effect.acquireUseRelease(
      prepareDisplayListImages(list),
      (images) =>
        Effect.gen(function* () {
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
          yield* Effect.try({
            try: () => paintDisplayList(context, list, images, scale),
            catch: () =>
              new PdfCoreError({
                code: PdfCoreErrorCodeValue.paintFailed,
                operation: PdfCoreOperationValue.paint,
                reason: "The page display list could not be painted.",
              }),
          });
          const image = yield* Effect.tryPromise({
            try: () => canvas.convertToBlob({ type: "image/png" }),
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
        }),
      closeImages,
    );
  });
