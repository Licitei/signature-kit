import { displayListViewport } from "../../dist/canvas.js";
import type { PdfCoreClient } from "../../dist/promise.js";
import type { Box, Raster } from "./degradation";

export type Glyph = { text: string; box: Box };

export async function glyphLabels(
  core: PdfCoreClient,
  input: Uint8Array,
  pageIndex: number,
  dpi: number,
) {
  const inspection = await core.inspect(input, {
    text: true,
    links: false,
    glyphs: true,
    pageIndexes: [pageIndex],
  });
  const page = inspection.pages[pageIndex];
  const text = inspection.text.find((item) => item.pageIndex === pageIndex);
  if (page === undefined || text === undefined) return [];
  const {
    transform: [a, b, c, d, e, f],
    width,
    height,
  } = displayListViewport({
    pageIndex,
    view: page.cropBox,
    rotate: page.rotate,
    scale: dpi / 72,
    ops: new Uint8Array(),
    blobs: [],
  });
  const glyphs: Glyph[] = [];
  for (let index = 0; index + 1 < text.offsets.length; index += 1) {
    const label = text.text.slice(text.offsets[index], text.offsets[index + 1]);
    const [x0, y0, x1, y1] = text.rects.subarray(index * 5, index * 5 + 4);
    if (
      x0 === undefined ||
      y0 === undefined ||
      x1 === undefined ||
      y1 === undefined ||
      label.trim() === ""
    )
      continue;
    const xs = [a * x0 + c * y0 + e, a * x0 + c * y1 + e, a * x1 + c * y0 + e, a * x1 + c * y1 + e];
    const ys = [b * x0 + d * y0 + f, b * x0 + d * y1 + f, b * x1 + d * y0 + f, b * x1 + d * y1 + f];
    const box: Box = [
      Math.max(0, Math.floor(Math.min(...xs))),
      Math.max(0, Math.floor(Math.min(...ys))),
      Math.min(width, Math.ceil(Math.max(...xs))),
      Math.min(height, Math.ceil(Math.max(...ys))),
    ];
    if (box[0] < box[2] && box[1] < box[3]) glyphs.push({ text: label, box });
  }
  return glyphs;
}

function hasInk({ pixels, width, height }: Raster, [x0, y0, x1, y1]: Box) {
  let low = 255;
  let high = 0;
  for (let y = y0; y < Math.min(y1, height); y += 1) {
    for (let x = x0; x < Math.min(x1, width); x += 1) {
      const tone = pixels[y * width + x] ?? 255;
      low = Math.min(low, tone);
      high = Math.max(high, tone);
      if (high - low >= 40) return true;
    }
  }
  return false;
}

export function indexGlyphs(glyphs: readonly Glyph[], raster: Raster) {
  const rows = new Map<number, Glyph[]>();
  for (const glyph of glyphs) {
    if (!hasInk(raster, glyph.box)) continue;
    const row = Math.floor((glyph.box[1] + glyph.box[3]) / 64);
    const group = rows.get(row) ?? [];
    group.push(glyph);
    rows.set(row, group);
  }
  return (word: Glyph) => {
    const [left, top, right, bottom] = word.box;
    const glyphs = [];
    for (let row = Math.floor(top / 32); row <= Math.floor(bottom / 32); row += 1) {
      for (const glyph of rows.get(row) ?? []) {
        const [x0, y0, x1, y1] = glyph.box;
        const x = (x0 + x1) / 2;
        const y = (y0 + y1) / 2;
        if (x >= left && x < right && y >= top && y < bottom) glyphs.push(glyph);
      }
    }
    glyphs.sort((a, b) => a.box[0] - b.box[0]);
    if (
      glyphs
        .map((glyph) => glyph.text)
        .join("")
        .normalize("NFKC") !== word.text.normalize("NFKC")
    )
      return [];
    return glyphs;
  };
}
