import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

import { loadPdfCoreNode } from "../../dist/node.js";
import type { Sample } from "./canvas-reference";
import { loadRasterizer, renderPayload } from "./raster-payload";

const directory = process.argv[2];
const count = Number(process.argv[3] ?? 20);

if (directory === undefined || !Number.isSafeInteger(count) || count < 1) {
  console.error("Usage: bun compare-raster.ts <directory of native PDFs> [page count]");
  process.exit(2);
}

const source = resolve(directory);
const pdfs = (await readdir(source))
  .filter((file) => file.toLowerCase().endsWith(".pdf"))
  .sort()
  .slice(0, count);
const wasm = Bun.file(
  join(
    import.meta.dir,
    "../../rust/target/wasm32-unknown-unknown/release/signature_kit_pdf_core_ocr.wasm",
  ),
);
const rasterize = await loadRasterizer(await wasm.arrayBuffer());
const core = await loadPdfCoreNode();
const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "canvas-reference.ts")],
  target: "browser",
  format: "esm",
});
const browserSource = await bundle.outputs[0]?.text();
if (bundle.success !== true || browserSource === undefined || rasterize === undefined)
  process.exit(1);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(browserSource).toString("base64")}`;
  let pixels = 0;
  let absolute = 0;
  let squared = 0;
  const timings: number[] = [];
  const scale = Math.round((300 / 72) * 1000) / 1000;
  for (const file of pdfs) {
    const [list] = await core.renderPages(await Bun.file(join(source, file)).bytes(), {
      pageIndexes: [0],
      scale,
    });
    if (list === undefined) {
      console.error(`Could not build a display list for ${file}`);
      continue;
    }
    const raster = rasterize(renderPayload(list), scale);
    if (raster === undefined) {
      console.error(`Could not rasterize ${file}`);
      continue;
    }
    const { ops, blobs, ...metadata } = list;
    const sample: Sample = {
      list: metadata,
      ops: Buffer.from(ops).toString("base64"),
      blobs: blobs.map((blob) => Buffer.from(blob).toString("base64")),
      gray: Buffer.from(raster.pixels).toString("base64"),
      width: raster.width,
      height: raster.height,
    };
    const result = await page.evaluate(
      async ({ url, input }) => {
        const reference: {
          compare: (
            sample: Sample,
          ) => Promise<{ pixels: number; absolute: number; squared: number }>;
        } = await import(url);
        return reference.compare(input);
      },
      { url: moduleUrl, input: sample },
    );
    pixels += result.pixels;
    absolute += result.absolute;
    squared += result.squared;
    timings.push(raster.ms);
  }
  const sorted = timings.toSorted((a, b) => a - b);
  console.log(
    JSON.stringify({
      pages: timings.length,
      wasmBytes: wasm.size,
      rasterMeanMs: timings.reduce((a, b) => a + b, 0) / timings.length,
      rasterMedianMs:
        sorted.length === 0
          ? null
          : ((sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) +
              (sorted[Math.floor(sorted.length / 2)] ?? 0)) /
            2,
      meanAbsoluteDifference: absolute / pixels,
      psnrDb: 10 * Math.log10((255 ** 2 * pixels) / squared),
    }),
  );
  if (timings.length !== count) process.exitCode = 1;
} finally {
  await browser.close();
}
