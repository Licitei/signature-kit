import { Effect } from "effect";
import { LocalClient } from "./client.js";
import { LocalError } from "@signature-kit/engine/rpc";
import type { PdfRenderInput, PdfViewport } from "@signature-kit/engine/rpc";

type Rectangle = readonly [number, number, number, number];

const transformRectangle = (rectangle: Rectangle, matrix: DOMMatrixReadOnly): Rectangle => {
  const [x0, y0, x1, y1] = rectangle;
  const corners = [
    matrix.transformPoint({ x: x0, y: y0 }),
    matrix.transformPoint({ x: x0, y: y1 }),
    matrix.transformPoint({ x: x1, y: y0 }),
    matrix.transformPoint({ x: x1, y: y1 }),
  ];
  const x = corners.map((point) => point.x);
  const y = corners.map((point) => point.y);
  return [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)];
};

export const pdfToCanvasRect = (viewport: PdfViewport, rectangle: Rectangle): Rectangle =>
  transformRectangle(rectangle, new DOMMatrixReadOnly([...viewport.transform]));

export const canvasToPdfRect = (viewport: PdfViewport, rectangle: Rectangle): Rectangle =>
  transformRectangle(rectangle, new DOMMatrixReadOnly([...viewport.transform]).inverse());

export const paintPage = (
  canvas: HTMLCanvasElement | OffscreenCanvas,
  input: PdfRenderInput,
): Effect.Effect<PdfViewport, LocalError, LocalClient> =>
  Effect.gen(function* () {
    const client = yield* LocalClient;
    const { width, height, transform, pixels } = yield* client.renderPage(input);
    const context = yield* Effect.try({
      try: () => canvas.getContext("2d"),
      catch: () => new LocalError({ code: "canvasUnavailable" }),
    });
    if (context === null) return yield* new LocalError({ code: "canvasUnavailable" });

    yield* Effect.try({
      try: () => {
        canvas.width = width;
        canvas.height = height;
        const rgba = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        context.putImageData(new ImageData(rgba, width, height), 0, 0);
      },
      catch: () => new LocalError({ code: "canvasUnavailable" }),
    });
    return { width, height, transform };
  });
