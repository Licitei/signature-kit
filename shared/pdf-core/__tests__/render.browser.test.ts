import { Effect } from "effect";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import standardFontUrl from "pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url";
import { describe, expect, it } from "vitest";

import { pdfCoreBrowserLayer } from "../dist/browser.js";
import {
  displayListViewport,
  paintDisplayList,
  prepareDisplayListImages,
  renderDisplayListImage,
} from "../dist/canvas.js";
import { PdfCore } from "../dist/pdf-core.js";

const SCALE = 1;
const MAX_MEAN_ABSOLUTE_DIFFERENCE = 2.5;
const MAX_DIVERGENT_PIXELS = 0.02;
const DIVERGENCE_THRESHOLD = 64;

const fixtures = import.meta.glob<string>("./fixtures/*.pdf", {
  query: "?url",
  import: "default",
  eager: true,
});

GlobalWorkerOptions.workerPort = new Worker(
  new URL("../node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
  { type: "module" },
);

const fetchBytes = (url: string): Promise<Uint8Array> =>
  fetch(url).then(async (response) => new Uint8Array(await response.arrayBuffer()));

const referencePixels = async (pdf: Uint8Array, pageIndex: number) => {
  const task = getDocument({
    data: pdf.slice(),
    disableFontFace: true,
    standardFontDataUrl: new URL(".", new URL(standardFontUrl, location.href)).href,
  });
  const document = await task.promise;
  const page = await document.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: SCALE });
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  const context = canvas.getContext("2d");
  const pixels = context?.getImageData(0, 0, canvas.width, canvas.height);
  await task.destroy();
  return pixels;
};

const compare = (ours: ImageData, reference: ImageData) => {
  const width = Math.min(ours.width, reference.width);
  const height = Math.min(ours.height, reference.height);
  let total = 0;
  let divergent = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const left = (y * ours.width + x) * 4;
      const right = (y * reference.width + x) * 4;
      let worst = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs(
          (ours.data[left + channel] ?? 0) - (reference.data[right + channel] ?? 0),
        );
        total += delta / 3;
        worst = Math.max(worst, delta);
      }
      if (worst > DIVERGENCE_THRESHOLD) divergent += 1;
    }
  }
  return { mean: total / (width * height), divergent: divergent / (width * height) };
};

describe("pdf-core page rendering", () => {
  const entries = Object.entries(fixtures).sort(([left], [right]) => left.localeCompare(right));

  it("covers the fixture corpus", () => {
    expect(entries.length).toBeGreaterThanOrEqual(15);
  });

  for (const [path, url] of entries) {
    it(`matches pdf.js within tolerance for ${path}`, async () => {
      const pdf = await fetchBytes(url);
      const lists = await Effect.runPromise(
        Effect.gen(function* () {
          const core = yield* PdfCore;
          return yield* core.renderPages(pdf, { pageIndexes: [0], scale: SCALE });
        }).pipe(Effect.provide(pdfCoreBrowserLayer)),
      );
      const [list] = lists;
      if (list === undefined) return expect.fail("missing display list");
      const viewport = displayListViewport(list);
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      const context = canvas.getContext("2d");
      if (context === null) return expect.fail("2D context unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, viewport.width, viewport.height);
      const images = await Effect.runPromise(prepareDisplayListImages(list));
      paintDisplayList(context, list, images);
      const reference = await referencePixels(pdf, 0);
      if (reference === undefined) return expect.fail("reference render failed");
      expect(Math.abs(reference.width - viewport.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(reference.height - viewport.height)).toBeLessThanOrEqual(1);
      const score = compare(context.getImageData(0, 0, viewport.width, viewport.height), reference);
      expect(score.mean, `${path} mean absolute difference`).toBeLessThan(
        MAX_MEAN_ABSOLUTE_DIFFERENCE,
      );
      expect(score.divergent, `${path} divergent pixel ratio`).toBeLessThan(MAX_DIVERGENT_PIXELS);
    }, 30_000);
  }

  it("encodes a page image as PNG at the requested scale", async () => {
    const url = fixtures["./fixtures/links.pdf"];
    if (url === undefined) return expect.fail("links fixture missing");
    const pdf = await fetchBytes(url);
    const image = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const [list] = yield* core.renderPages(pdf, { pageIndexes: [0] });
        if (list === undefined) return yield* Effect.die("missing display list");
        return yield* renderDisplayListImage(list, { scale: 0.5 });
      }).pipe(Effect.provide(pdfCoreBrowserLayer)),
    );
    expect(image.image.type).toBe("image/png");
    expect(image.width).toBe(306);
    expect(image.height).toBe(396);
    const signature = new Uint8Array(await image.image.slice(0, 4).arrayBuffer());
    expect(Array.from(signature)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 30_000);
});
