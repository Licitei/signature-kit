import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function load(path) {
  const { instance } = await WebAssembly.instantiate(await readFile(path));
  return instance.exports;
}

function withPacket(wasm, packet, run) {
  const pointer = wasm.pdf_core_ocr_raster_alloc(packet.length);
  if (!pointer) throw new Error("WASM input allocation failed");
  new Uint8Array(wasm.memory.buffer, pointer, packet.length).set(packet);
  try {
    return run((fixture) => {
      const result = wasm.pdf_core_ocr_v4_line_probe(pointer, packet.length, fixture);
      if (!result) throw new Error("WASM rejected OCR v4 probe packet");
      const length = new DataView(wasm.memory.buffer).getUint32(result, true);
      try {
        return Buffer.from(new Uint8Array(wasm.memory.buffer, result + 4, length - 4));
      } finally {
        wasm.pdf_core_ocr_raster_free(result, length);
      }
    });
  } finally {
    wasm.pdf_core_ocr_raster_free(pointer, packet.length);
  }
}

const [mode, scalar, simd, input, repetitions = "100"] = process.argv.slice(2);
const modules = await Promise.all([scalar, simd].map(load));
if (mode === "fixture") {
  const paths = (await readdir(input)).filter((name) => name.endsWith(".packet")).sort();
  for (const name of paths) {
    const [packet, expected] = await Promise.all([
      readFile(join(input, name)),
      readFile(join(input, name.replace(/\.packet$/u, ".expected"))),
    ]);
    for (const [index, wasm] of modules.entries()) {
      const actual = withPacket(wasm, packet, (probe) => probe(1));
      if (!expected.equals(actual)) throw new Error(`WASM ${index} differs on ${name}`);
    }
  }
  console.log(`WASM scalar + SIMD parity: ${paths.length} exact normalized rasters and logit matrices`);
} else if (mode === "bench") {
  const packet = await readFile(input);
  const count = Number(repetitions);
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Invalid repetition count");
  const outputs = modules.map((wasm, index) =>
    withPacket(wasm, packet, (probe) => {
      for (let warmup = 0; warmup < 20; warmup += 1) probe(0);
      const start = performance.now();
      for (let repeat = 0; repeat < count; repeat += 1) probe(0);
      const elapsed = performance.now() - start;
      console.log(`wasm ${index === 0 ? "scalar" : "simd"} ${(elapsed / count).toFixed(6)} ms/line, repeats=${count}`);
      return probe(0);
    }),
  );
  if (!outputs[0].equals(outputs[1])) throw new Error("WASM greedy transcripts differ");
} else {
  throw new Error("Expected fixture or bench");
}
