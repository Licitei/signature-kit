import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function load(path) {
  const { instance } = await WebAssembly.instantiate(await readFile(path));
  return instance.exports;
}

function withPacket(wasm, packet, run) {
  using inputMemory = new DisposableStack();
  const pointer = wasm.pdf_core_ocr_raster_alloc(packet.length);
  assert(pointer, "WASM input allocation failed");
  inputMemory.defer(() => wasm.pdf_core_ocr_raster_free(pointer, packet.length));
  new Uint8Array(wasm.memory.buffer, pointer, packet.length).set(packet);
  return run((fixture) => {
    using outputMemory = new DisposableStack();
    const result = wasm.pdf_core_ocr_v4_line_probe(pointer, packet.length, fixture);
    assert(result, "WASM rejected OCR v4 probe packet");
    const length = new DataView(wasm.memory.buffer).getUint32(result, true);
    outputMemory.defer(() => wasm.pdf_core_ocr_raster_free(result, length));
    return Buffer.from(new Uint8Array(wasm.memory.buffer, result + 4, length - 4));
  });
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
      assert(expected.equals(actual), `WASM ${index} differs on ${name}`);
    }
  }
  console.log(
    `WASM scalar + SIMD parity: ${paths.length} exact normalized rasters and logit matrices`,
  );
} else if (mode === "bench") {
  const packet = await readFile(input);
  const count = Number(repetitions);
  assert(Number.isSafeInteger(count) && count > 0, "Invalid repetition count");
  const outputs = modules.map((wasm, index) =>
    withPacket(wasm, packet, (probe) => {
      for (let warmup = 0; warmup < 20; warmup += 1) probe(0);
      const start = performance.now();
      for (let repeat = 0; repeat < count; repeat += 1) probe(0);
      const elapsed = performance.now() - start;
      console.log(
        `wasm ${index === 0 ? "scalar" : "simd"} ${(elapsed / count).toFixed(6)} ms/line, repeats=${count}`,
      );
      return probe(0);
    }),
  );
  assert(outputs[0].equals(outputs[1]), "WASM greedy transcripts differ");
} else {
  assert.fail("Expected fixture or bench");
}
