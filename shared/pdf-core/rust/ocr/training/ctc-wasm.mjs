import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parsePgm } from "../../../bench/ocr/degradation.ts";

async function loadWasm(path) {
  const { instance } = await WebAssembly.instantiate(await readFile(path));
  return instance.exports;
}

function pageInput(pgm, label, weights) {
  const raster = parsePgm(pgm);
  assert.ok(raster !== undefined, "Expected an 8-bit P5 page");
  const { width, height, pixels } = raster;
  assert.ok(
    label.width === width && label.height === height,
    "Page dimensions do not match the fixtures",
  );
  const input = Buffer.alloc(16 + weights.length + pixels.length);
  input.writeUInt32LE(width, 0);
  input.writeUInt32LE(height, 4);
  input.writeFloatLE(label.dpi, 8);
  input.writeUInt32LE(weights.length, 12);
  weights.copy(input, 16);
  input.set(pixels, 16 + weights.length);
  return input;
}

function recognize(wasm, input) {
  const pointer = wasm.pdf_core_ocr_raster_alloc(input.length);
  assert.notEqual(pointer, 0, "WASM input allocation failed");
  new Uint8Array(wasm.memory.buffer, pointer, input.length).set(input);
  const start = performance.now();
  const output = wasm.pdf_core_ocr_ctc_probe(pointer, input.length);
  const elapsed = performance.now() - start;
  wasm.pdf_core_ocr_raster_free(pointer, input.length);
  assert.notEqual(output, 0, "WASM CTC probe failed");
  const size = new DataView(wasm.memory.buffer, output, 4).getUint32(0, true);
  const text = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, output + 4, size - 4));
  wasm.pdf_core_ocr_raster_free(output, size);
  return { elapsed, text };
}

const [scalarPath, simdPath, modelPath, cases, tess = "tesseract", psm = "3"] =
  process.argv.slice(2);
assert.ok(psm === "3" || psm === "7", "Expected page mode 3 or line mode 7");
const [scalar, simd, model, files] = await Promise.all([
  loadWasm(scalarPath),
  loadWasm(simdPath),
  readFile(modelPath),
  readdir(cases),
]);
const pages = files.filter((name) => name.endsWith(".pgm")).sort();
assert.ok(pages.length > 0, "No held-out pages");
const timings = { scalar: 0, simd: 0 };
let outputs = 0;
for (const name of pages) {
  const pgm = await readFile(join(cases, name));
  const label = JSON.parse(await readFile(join(cases, name.replace(/\.pgm$/u, ".json")), "utf8"));
  const input = pageInput(pgm, label, model);
  const left = recognize(scalar, input);
  const right = recognize(simd, input);
  assert.equal(left.text, right.text, `Scalar and SIMD differ on ${name}`);
  outputs += right.text.length;
  timings.scalar += left.elapsed;
  timings.simd += right.elapsed;
}

async function measureTesseract() {
  if (tess === "none") return undefined;
  const directory = await mkdtemp(join(tmpdir(), "ocr-tesseract-pages-"));
  const [result] = await Promise.allSettled([
    (async () => {
      const list = join(directory, "pages.txt");
      await writeFile(list, `${pages.map((page) => resolve(cases, page)).join("\n")}\n`);
      const clock = performance.now();
      const process = Bun.spawn([tess, list, "stdout", "-l", "por", "--oem", "1", "--psm", psm], {
        stdout: "ignore",
        stderr: "inherit",
        env: { ...globalThis.process.env, OMP_THREAD_LIMIT: "1" },
      });
      const status = await process.exited;
      assert.equal(status, 0, "Tesseract failed");
      return performance.now() - clock;
    })(),
  ]);
  await rm(directory, { recursive: true });
  if (result.status === "rejected") {
    console.error(result.reason);
    process.exit(1);
  }
  return result.value;
}

const tessElapsed = await measureTesseract();
console.log(
  JSON.stringify({
    pages: pages.length,
    identicalOutput: true,
    characters: outputs,
    scalarMsPerPage: timings.scalar / pages.length,
    simdMsPerPage: timings.simd / pages.length,
    tesseractMsPerPage: tessElapsed === undefined ? undefined : tessElapsed / pages.length,
    speedup: tessElapsed === undefined ? undefined : tessElapsed / timings.simd,
  }),
);
