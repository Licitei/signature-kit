/**
 * Memory guard for pdf-core wasm hill-climbing.
 * One child process per (wasm, pdf, mode) so linear memory and RSS start cold;
 * `memory.buffer.byteLength` after the call is the peak because wasm memory never shrinks.
 *
 * Usage:
 *   MEM_WASMS=a.wasm,b.wasm MEM_PDFS=x.pdf,y.pdf [MEM_MODES=text,markdown,tables,lazy,render] \
 *     bun shared/pdf-core/bench/measure-memory.ts
 */
import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";

import { pdfCoreNodeSource } from "../dist/node.js";
import { createPdfCoreClient } from "../dist/promise.js";

const MODES = ["load", "text", "markdown", "tables", "lazy", "render"];
const MIB = 1048576;

const pagesOf = async (
  core: Awaited<ReturnType<typeof createPdfCoreClient>>,
  pdfPath: string,
  mode: string,
) => {
  if (mode === "load") {
    return 0;
  }
  const bytes = new Uint8Array(await readFile(pdfPath));
  if (mode === "text") {
    return (await core.text(bytes)).length;
  }
  if (mode === "markdown") {
    return (await core.text(bytes, { format: "markdown" })).length;
  }
  if (mode === "tables") {
    return (await core.tables(bytes)).length;
  }
  if (mode === "render") {
    return (await core.renderPages(bytes, { pageIndexes: [0, 1, 2, 3, 4, 5, 6, 7] })).length;
  }
  await using file = await open(pdfPath);
  const { size } = await file.stat();
  await using document = await core.openLazy(pdfCoreNodeSource(file, size));
  return (await document.text({ format: "markdown" })).length;
};

const probe = async (wasmPath: string, pdfPath: string, mode: string) => {
  const core = await createPdfCoreClient(await WebAssembly.compile(await readFile(wasmPath)));
  const started = performance.now();
  const pages = await pagesOf(core, pdfPath, mode);
  const ms = performance.now() - started;
  const wasmBytes = await core.wasmMemoryBytes();
  const rssBytes = process.resourceUsage().maxRSS * 1024;
  process.stdout.write(`${wasmBytes} ${rssBytes} ${ms} ${pages}\n`);
};

const [wasmPath, pdfPath, mode] = process.argv.slice(2);
if (wasmPath !== undefined && pdfPath !== undefined && mode !== undefined) {
  if (!MODES.includes(mode)) {
    process.stderr.write(`mode must be one of ${MODES.join(", ")}\n`);
    process.exit(2);
  }
  await probe(wasmPath, pdfPath, mode);
} else {
  const list = (name: string, fallback: string) =>
    (process.env[name] ?? fallback).split(",").filter((entry) => entry !== "");
  const wasms = list("MEM_WASMS", "");
  const pdfs = list("MEM_PDFS", "");
  const modes = list("MEM_MODES", "text,markdown,tables,lazy,render");
  const pad = (value: number) => (value / MIB).toFixed(0).padStart(5);
  for (const pdf of pdfs) {
    for (const modeName of modes) {
      const cells = wasms.map((wasm) => {
        const child = Bun.spawnSync([process.execPath, import.meta.path, wasm, pdf, modeName]);
        const [wasmBytes = 0, rssBytes = 0, ms = 0, pages = 0] = child.stdout
          .toString()
          .trim()
          .split(" ")
          .map(Number);
        return child.exitCode === 0
          ? `wasm ${pad(wasmBytes)} MiB rss ${pad(rssBytes)} MiB ${(ms / Math.max(pages, 1)).toFixed(2)} ms/p`
          : `FAIL ${child.stderr.toString().trim().slice(0, 80)}`;
      });
      console.log(
        `${basename(pdf).slice(0, 18).padEnd(18)} ${modeName.padEnd(8)} ${cells.join(" | ")}`,
      );
    }
  }
}
