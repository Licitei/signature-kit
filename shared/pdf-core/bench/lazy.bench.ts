import { open, readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { pdfCoreNodeSource } from "../dist/node.js";
import { createPdfCoreClient } from "../dist/promise.js";

const pdfs = async (dir: string): Promise<Array<string>> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
};

const measure = async (path: string, lazy: boolean) => {
  const wasm = await Bun.stdin.arrayBuffer();
  const core = await createPdfCoreClient(await WebAssembly.compile(wasm));
  await using file = await open(path);
  const size = (await file.stat()).size;
  const options = { pageIndexes: [0], format: "markdown" } satisfies Parameters<
    typeof core.text
  >[1];
  const start = performance.now();
  const result = await (async () => {
    if (lazy) {
      await using doc = await core.openLazy(pdfCoreNodeSource(file, size));
      const markdown = await doc.text(options);
      return { markdown, ...(await doc.stats()) };
    }
    const bytes = await file.readFile();
    const markdown = await core.text(bytes, options);
    return { markdown, bytesRead: bytes.byteLength, rounds: 1, strategy: "full" };
  })();
  const latencyMs = performance.now() - start;
  const wasmBytes = await core.wasmMemoryBytes();
  return {
    ...result,
    size,
    latencyMs,
    wasmBytes,
    rssBytes: process.memoryUsage.rss(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
};

type Measurement = Awaited<ReturnType<typeof measure>>;

const worker = async (
  path: string,
  lazy: boolean,
  wasm: Uint8Array,
): Promise<Measurement | undefined> => {
  const child = Bun.spawn([process.execPath, import.meta.path, lazy ? "--lazy" : "--full", path], {
    stdin: wasm,
    stdout: "pipe",
    stderr: "inherit",
  });
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (status !== 0) {
    return undefined;
  }
  return JSON.parse(output);
};

const summary = (rows: ReadonlyArray<Measurement>) => {
  const latency = rows.map((row) => row.latencyMs).sort((left, right) => left - right);
  const percentile = (fraction: number) => latency[Math.ceil(latency.length * fraction) - 1];
  const total = (select: (row: Measurement) => number) =>
    rows.reduce((sum, row) => sum + select(row), 0);
  const max = (select: (row: Measurement) => number) =>
    rows.reduce((peak, row) => Math.max(peak, select(row)), 0);
  return {
    p50Ms: percentile(0.5),
    p90Ms: percentile(0.9),
    bytesReadRatio: total((row) => row.bytesRead) / total((row) => row.size),
    peakWasmBytes: max((row) => row.wasmBytes),
    peakRssBytes: max((row) => row.peakRssBytes),
    fallbacks: rows.filter((row) => row.strategy === "fallback").length,
  };
};

const run = async (corpus: string) => {
  const lazy: Array<Measurement> = [];
  const full: Array<Measurement> = [];
  let mismatches = 0;
  let failures = 0;
  const files = await pdfs(corpus);
  const wasm = await readFile(new URL("../dist/pdf-core.wasm", import.meta.url));
  for (const path of files) {
    const pathLabel = relative(corpus, path) || basename(path);
    const partial = await worker(path, true, wasm);
    const complete = await worker(path, false, wasm);
    if (partial === undefined || complete === undefined) {
      failures += 1;
      console.log(
        JSON.stringify({
          file: pathLabel,
          failed: true,
          lazy: partial !== undefined,
          full: complete !== undefined,
        }),
      );
      continue;
    }
    const { markdown: left, ...partialStats } = partial;
    const { markdown: right, ...completeStats } = complete;
    const equal =
      left.length === right.length && left.every((page, index) => page === right[index]);
    mismatches += equal ? 0 : 1;
    console.log(
      JSON.stringify({
        file: pathLabel,
        equal,
        lazy: { ...partialStats, bytesReadRatio: partial.bytesRead / partial.size },
        full: { ...completeStats, bytesReadRatio: complete.bytesRead / complete.size },
      }),
    );
    lazy.push(partial);
    full.push(complete);
  }
  console.log(
    JSON.stringify({
      files: files.length,
      mismatches,
      failures,
      lazy: summary(lazy),
      full: summary(full),
    }),
  );
  if (files.length === 0 || mismatches > 0 || failures > 0) {
    process.exitCode = 1;
  }
};

const [, , mode, document] = process.argv;
const corpus = process.env.PDF_CORPUS;
if ((mode === "--lazy" || mode === "--full") && document !== undefined) {
  console.log(JSON.stringify(await measure(document, mode === "--lazy")));
} else if (corpus !== undefined) {
  await run(corpus);
} else {
  console.error("Set PDF_CORPUS to the directory containing the benchmark PDFs.");
  process.exitCode = 1;
}
