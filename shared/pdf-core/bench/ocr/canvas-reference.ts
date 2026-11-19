import { Effect } from "effect";

import {
  displayListViewport,
  paintDisplayList,
  prepareDisplayListImages,
} from "../../dist/canvas.js";
import type { PdfCoreDisplayList } from "../../dist/config.js";

export type Sample = {
  list: Omit<PdfCoreDisplayList, "ops" | "blobs">;
  ops: string;
  blobs: string[];
  gray: string;
  width: number;
  height: number;
};

export function compare(sample: Sample) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const list = {
        ...sample.list,
        ops: Uint8Array.fromBase64(sample.ops),
        blobs: sample.blobs.map((blob) => Uint8Array.fromBase64(blob)),
      };
      const { width, height } = displayListViewport(list);
      if (sample.width !== width || sample.height !== height) {
        return yield* Effect.die(
          `Raster size ${sample.width}×${sample.height} differs from canvas ${width}×${height}`,
        );
      }
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (context === null) return yield* Effect.die("2D context unavailable");
      context.fillStyle = "white";
      context.fillRect(0, 0, width, height);
      const images = yield* prepareDisplayListImages(list);
      yield* paintDisplayList(context, list, images);
      const reference = context.getImageData(0, 0, width, height).data;
      const gray = Uint8Array.fromBase64(sample.gray);
      let absolute = 0;
      let squared = 0;
      for (let index = 0; index < gray.length; index += 1) {
        const offset = index * 4;
        const tone = Math.round(
          0.2126 * (reference[offset] ?? 255) +
            0.7152 * (reference[offset + 1] ?? 255) +
            0.0722 * (reference[offset + 2] ?? 255),
        );
        const delta = (gray[index] ?? 255) - tone;
        absolute += Math.abs(delta);
        squared += delta * delta;
      }
      return { absolute, squared, pixels: gray.length };
    }).pipe(Effect.scoped),
  );
}
