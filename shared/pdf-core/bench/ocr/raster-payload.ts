import { Schema } from "effect";

import type { PdfCoreDisplayList } from "../../dist/config.js";

const aligned = (length: number) => Math.ceil(length / 8) * 8;

export function renderPayload(list: PdfCoreDisplayList) {
  const opsAt = 72;
  const tableAt = opsAt + aligned(list.ops.length);
  const blobsAt = tableAt + list.blobs.length * 8;
  const length = blobsAt + list.blobs.reduce((total, blob) => total + aligned(blob.length), 0);
  const binary = new Uint8Array(length);
  const view = new DataView(binary.buffer);
  const word = (offset: number, value: number) => view.setUint32(offset, value, true);
  word(0, 0x4c524450);
  word(4, 1);
  word(8, 1);
  word(16, list.pageIndex);
  view.setInt32(20, list.rotate, true);
  word(24, list.ops.length);
  word(28, list.blobs.length);
  for (const [index, coordinate] of list.view.entries()) {
    view.setFloat64(32 + index * 8, coordinate, true);
  }
  word(64, length - 16);
  binary.set(list.ops, opsAt);
  let offset = 0;
  for (const [index, blob] of list.blobs.entries()) {
    word(tableAt + index * 8, offset);
    word(tableAt + index * 8 + 4, blob.length);
    binary.set(blob, blobsAt + offset);
    offset += aligned(blob.length);
  }
  return binary;
}

export async function loadRasterizer(bytes: ArrayBuffer) {
  const { instance } = await WebAssembly.instantiate(bytes);
  const {
    memory,
    pdf_core_ocr_raster_alloc: allocate,
    pdf_core_ocr_raster_free: free,
    pdf_core_ocr_rasterize: rasterize,
  } = instance.exports;
  if (
    !Schema.is(Schema.instanceOf(WebAssembly.Memory))(memory) ||
    typeof allocate !== "function" ||
    typeof free !== "function" ||
    typeof rasterize !== "function"
  ) {
    return undefined;
  }
  return (payload: Uint8Array, scale: number) => {
    const input = Number(allocate(payload.length));
    if (!input) return undefined;
    new Uint8Array(memory.buffer, input, payload.length).set(payload);
    const started = performance.now();
    const output = Number(rasterize(input, payload.length, Math.round(scale * 1000)));
    const ms = performance.now() - started;
    free(input, payload.length);
    if (!output) return undefined;
    const view = new DataView(memory.buffer, output, 8);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const pixels = new Uint8Array(memory.buffer, output + 8, width * height).slice();
    free(output, 8 + pixels.length);
    return { width, height, pixels, ms };
  };
}
