import { Effect } from "effect";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import standardFontUrl from "pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url";
import jbig2WasmUrl from "pdfjs-dist/wasm/jbig2.wasm?url";
import { describe, expect, it } from "vitest";

import { pdfCoreBrowserLayer } from "../dist/browser.js";
import {
  displayListViewport,
  paintDisplayList,
  prepareDisplayListImages,
  renderDisplayListImage,
} from "../dist/canvas.js";
import type { PdfCoreImageSource } from "../dist/canvas.js";
import type { PdfCoreDisplayList } from "../dist/config.js";
import { PdfCore } from "../dist/pdf-core.js";

const SCALE = 1;
const INK = 245;
const DIVERGENCE_THRESHOLD = 64;
const TOLERANCES = {
  substitutedFonts: { mean: 40, divergent: 0.1 },
  exact: { mean: 4, divergent: 0.01 },
};
const MIN_REFERENCE_INK = 200;

const fixtures = import.meta.glob<string>(["./fixtures/*.pdf", "./fixtures/render/*.pdf"], {
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

const openReference = (pdf: Uint8Array) =>
  getDocument({
    data: pdf.slice(),
    disableFontFace: true,
    wasmUrl: new URL(".", new URL(jbig2WasmUrl, location.href)).href,
    standardFontDataUrl: new URL(".", new URL(standardFontUrl, location.href)).href,
  });

const referencePixels = async (document: PDFDocumentProxy, pageIndex: number) => {
  const page = await document.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: SCALE });
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height);
};

const renderList = (pdf: Uint8Array) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const core = yield* PdfCore;
      return yield* core.renderPages(pdf, { scale: SCALE });
    }).pipe(Effect.provide(pdfCoreBrowserLayer)),
  );

const paint = (list: PdfCoreDisplayList): Promise<ImageData> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const viewport = displayListViewport(list);
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      const context = canvas.getContext("2d");
      if (context === null) return yield* Effect.die("2D context unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, viewport.width, viewport.height);
      const images = yield* prepareDisplayListImages(list);
      yield* paintDisplayList(context, list, images);
      return context.getImageData(0, 0, viewport.width, viewport.height);
    }).pipe(Effect.scoped),
  );

const isInk = (data: Uint8ClampedArray, at: number): boolean =>
  (data[at] ?? 255) < INK || (data[at + 1] ?? 255) < INK || (data[at + 2] ?? 255) < INK;

const pixelDistance = (
  source: ImageData,
  at: number,
  target: ImageData,
  x: number,
  y: number,
  width: number,
  height: number,
): number => {
  let best = 255;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const other = (ny * target.width + nx) * 4;
      let worst = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        worst = Math.max(
          worst,
          Math.abs((source.data[at + channel] ?? 0) - (target.data[other + channel] ?? 0)),
        );
      }
      best = Math.min(best, worst);
    }
  }
  return best;
};

const compare = (ours: ImageData, reference: ImageData) => {
  const width = Math.min(ours.width, reference.width);
  const height = Math.min(ours.height, reference.height);
  let ink = 0;
  let referenceInk = 0;
  let total = 0;
  let divergent = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const left = (y * ours.width + x) * 4;
      const right = (y * reference.width + x) * 4;
      const referenceHasInk = isInk(reference.data, right);
      if (referenceHasInk) referenceInk += 1;
      if (!referenceHasInk && !isInk(ours.data, left)) continue;
      ink += 1;
      const distance = Math.max(
        pixelDistance(ours, left, reference, x, y, width, height),
        pixelDistance(reference, right, ours, x, y, width, height),
      );
      total += distance;
      if (distance > DIVERGENCE_THRESHOLD) divergent += 1;
    }
  }
  return {
    ink,
    referenceInk,
    mean: ink === 0 ? 0 : total / ink,
    divergent: ink === 0 ? 0 : divergent / ink,
  };
};

const passes = (
  score: ReturnType<typeof compare>,
  tolerance: { readonly mean: number; readonly divergent: number },
): boolean => score.mean < tolerance.mean && score.divergent < tolerance.divergent;

const singlePage = (content: string, mediaBox = "0 0 200 100"): Uint8Array => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: Array<number> = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

describe("pdf-core page rendering", () => {
  const entries = Object.entries(fixtures).sort(([left], [right]) => left.localeCompare(right));

  it("covers the fixture corpus and the generated render fixtures", () => {
    expect(entries.length).toBeGreaterThanOrEqual(24);
    for (const name of [
      "images",
      "masks",
      "ccitt-g4",
      "shadings",
      "type3",
      "embedded-fonts",
      "qr-upscaled",
      "rotated",
      "optional-content",
    ]) {
      expect(fixtures[`./fixtures/render/${name}.pdf`], name).toBeDefined();
    }
  });

  for (const [path, url] of entries) {
    it(`matches pdf.js on every page of ${path}`, async () => {
      const pdf = await fetchBytes(url);
      const lists = await renderList(pdf);
      const task = openReference(pdf);
      const reference = await task.promise;
      expect(lists).toHaveLength(reference.numPages);
      const tolerance = path.startsWith("./fixtures/render/")
        ? TOLERANCES.exact
        : TOLERANCES.substitutedFonts;
      let inked = 0;
      for (const list of lists) {
        const ours = await paint(list);
        const expected = await referencePixels(reference, list.pageIndex);
        if (expected === undefined) return expect.fail("reference render failed");
        expect(Math.abs(expected.width - ours.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(expected.height - ours.height)).toBeLessThanOrEqual(1);
        const score = compare(ours, expected);
        const label = `${path} page ${list.pageIndex}: ${JSON.stringify(score)}`;
        expect(score.mean, label).toBeLessThan(tolerance.mean);
        expect(score.divergent, label).toBeLessThan(tolerance.divergent);
        if (score.referenceInk >= MIN_REFERENCE_INK) {
          inked += 1;
          const blank = new ImageData(ours.width, ours.height);
          blank.data.fill(255);
          expect(
            passes(compare(blank, expected), TOLERANCES.substitutedFonts),
            `blank ${label}`,
          ).toBe(false);
        }
      }
      await task.destroy();
      expect(inked, `${path} has no page with ink`).toBeGreaterThan(0);
    }, 120_000);
  }

  it("keeps upscaled 1-bit images crisp", async () => {
    const url = fixtures["./fixtures/render/qr-upscaled.pdf"];
    if (url === undefined) return expect.fail("qr fixture missing");
    const [list] = await renderList(await fetchBytes(url));
    if (list === undefined) return expect.fail("missing display list");
    const pixels = await paint(list);
    let midtones = 0;
    let inside = 0;
    for (let y = 10; y < 190; y += 1) {
      for (let x = 10; x < 190; x += 1) {
        const value = pixels.data[(y * pixels.width + x) * 4] ?? 0;
        inside += 1;
        if (value > 32 && value < 223) midtones += 1;
      }
    }
    expect(midtones / inside).toBeLessThan(0.02);
  }, 30_000);

  it("releases decoded images when the paint scope closes", async () => {
    const url = fixtures["./fixtures/render/images.pdf"];
    if (url === undefined) return expect.fail("images fixture missing");
    const [list] = await renderList(await fetchBytes(url));
    if (list === undefined) return expect.fail("missing display list");
    const captured: Array<PdfCoreImageSource> = [];
    await Effect.runPromise(
      prepareDisplayListImages(list).pipe(
        Effect.tap((images) => Effect.sync(() => captured.push(...images.values()))),
        Effect.scoped,
      ),
    );
    expect(captured.length).toBeGreaterThanOrEqual(3);
    for (const source of captured) {
      expect(source.width).toBe(0);
      expect(source.height).toBe(0);
    }
  }, 30_000);

  it("fails with a typed error on malformed display lists", async () => {
    const [list] = await renderList(singlePage("0 0 1 rg 10 10 50 50 re f"));
    if (list === undefined) return expect.fail("missing display list");
    const context = new OffscreenCanvas(10, 10).getContext("2d");
    if (context === null) return expect.fail("2D context unavailable");
    for (const ops of [
      list.ops.subarray(0, list.ops.byteLength - 6),
      Uint8Array.from([99]),
      Uint8Array.from([4, 255, 255, 255, 127]),
    ]) {
      const failure = await Effect.runPromise(
        Effect.flip(paintDisplayList(context, { ...list, ops }, new Map())),
      );
      expect(failure.code).toBe("pdfCore.PAINT_FAILED");
      expect(failure.operation).toBe("pdfCore.paint");
    }
    await Effect.runPromise(paintDisplayList(context, list, new Map()));
  }, 30_000);

  it("clamps oversized pages to the canvas limits instead of failing", async () => {
    const [list] = await renderList(singlePage("0 0 1 rg 0 0 14400 14400 re f", "0 0 14400 14400"));
    if (list === undefined) return expect.fail("missing display list");
    const image = await Effect.runPromise(renderDisplayListImage(list, { scale: 2 }));
    expect(image.width).toBeLessThanOrEqual(16_384);
    expect(image.height).toBeLessThanOrEqual(16_384);
    expect(image.width).toBeGreaterThan(8_000);
  }, 60_000);

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
