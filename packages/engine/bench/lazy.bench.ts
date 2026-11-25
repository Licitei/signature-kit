import { open, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import type { PdfCoreLazyOptions } from "../dist/config.js";
import { pdfCoreNodeSource } from "../dist/node.js";
import { createPdfCoreClient } from "../dist/promise.js";
import type { PdfCoreClient, PdfCorePromiseRangeSource } from "../dist/promise.js";

const RTT_MS = 40;
const HTTP_SAMPLE_SIZE = 12;
const wasmUrl = new URL("../dist/pdf-core.wasm", import.meta.url);
const { PDF_PROBE_BYTES, PDF_GAP_BYTES, PDF_MAX_ROUND_BYTES } = process.env;
const tuning: PdfCoreLazyOptions = {
  ...(PDF_PROBE_BYTES === undefined ? {} : { probeBytes: Number(PDF_PROBE_BYTES) }),
  ...(PDF_GAP_BYTES === undefined ? {} : { gapBytes: Number(PDF_GAP_BYTES) }),
  ...(PDF_MAX_ROUND_BYTES === undefined ? {} : { maxRoundBytes: Number(PDF_MAX_ROUND_BYTES) }),
};

const pdfs = async (dir: string) => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
};

const measure = async (
  core: PdfCoreClient,
  source: PdfCorePromiseRangeSource,
  download: () => Promise<Uint8Array>,
  lazy: boolean,
) => {
  const options = { pageIndexes: [0], format: "markdown" } satisfies Parameters<
    typeof core.text
  >[1];
  const started = performance.now();
  const result = await (async () => {
    if (lazy) {
      await using doc = await core.openLazy(source, tuning);
      const markdown = await doc.text(options);
      return { markdown, ...(await doc.stats()) };
    }
    const bytes = await download();
    const markdown = await core.text(bytes, options);
    return { markdown, bytesRead: bytes.byteLength, rounds: 1, strategy: "full" };
  })();
  const latencyMs = performance.now() - started;
  return {
    ...result,
    size: source.size,
    latencyMs,
    wasmBytes: await core.wasmMemoryBytes(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
};

type Measurement = Awaited<ReturnType<typeof measure>>;

const local = async (path: string, core: PdfCoreClient, lazy: boolean, rtt = 0) => {
  await using file = await open(path);
  const size = (await file.stat()).size;
  const source = pdfCoreNodeSource(file, size);
  return await measure(
    core,
    rtt === 0
      ? source
      : {
          size,
          read: async (offset, length) => {
            await Bun.sleep(rtt);
            return source.read(offset, length);
          },
        },
    async () => {
      if (rtt > 0) {
        await Bun.sleep(rtt);
      }
      return file.readFile();
    },
    lazy,
  );
};

const worker = async (path: string, lazy: boolean, wasm: Uint8Array): Promise<Measurement> => {
  const child = Bun.spawn([process.execPath, import.meta.path, lazy ? "--lazy" : "--full", path], {
    stdin: wasm,
    stdout: "pipe",
    stderr: "inherit",
  });
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (status !== 0) {
    throw new Error(`Benchmark worker exited with status ${status}.`);
  }
  return JSON.parse(output);
};

const median = (rows: Array<Measurement>) => {
  rows.sort((left, right) => left.latencyMs - right.latencyMs);
  const row = rows[Math.floor(rows.length / 2)];
  if (row === undefined) {
    throw new Error("No benchmark trials.");
  }
  return row;
};

const percentiles = (values: Array<number>) => {
  values.sort((left, right) => left - right);
  return {
    p50: values[Math.ceil(values.length * 0.5) - 1],
    p90: values[Math.ceil(values.length * 0.9) - 1],
    max: values.at(-1),
  };
};

const summary = (rows: ReadonlyArray<Measurement>) => {
  const total = (select: (row: Measurement) => number) =>
    rows.reduce((sum, row) => sum + select(row), 0);
  return {
    latencyMs: percentiles(rows.map((row) => row.latencyMs)),
    rounds: percentiles(rows.map((row) => row.rounds)),
    bytesReadRatio: total((row) => row.bytesRead) / total((row) => row.size),
    peakWasmBytes: Math.max(...rows.map((row) => row.wasmBytes)),
    peakRssBytes: Math.max(...rows.map((row) => row.peakRssBytes)),
    fallbacks: rows.filter((row) => row.strategy === "fallback").length,
  };
};

const rangeServer = (files: ReadonlyArray<string>) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = files[Number(new URL(request.url).pathname.slice(1))];
      if (path === undefined) {
        return new Response(null, { status: 404 });
      }
      const file = Bun.file(path);
      const header = request.headers.get("Range");
      if (header === null) {
        return new Response(file);
      }
      const match = /^bytes=(\d+)-(\d+)$/u.exec(header);
      const start = Number(match?.[1]);
      const end = Number(match?.[2]);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        end >= file.size
      ) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${file.size}` },
        });
      }
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${file.size}`,
        },
      });
    },
  });

const http = (core: PdfCoreClient, url: URL, size: number, lazy: boolean) =>
  measure(
    core,
    {
      size,
      read: async (offset, length) => {
        const range = `${offset}-${offset + length - 1}`;
        const response = await fetch(url, { headers: { Range: `bytes=${range}` } });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (
          response.status !== 206 ||
          response.headers.get("Content-Range") !== `bytes ${range}/${size}`
        ) {
          throw new Error(`Invalid HTTP response for requested range ${range}.`);
        }
        return bytes;
      },
    },
    async () => {
      const response = await fetch(url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.status !== 200 || bytes.byteLength !== size) {
        throw new Error("Invalid HTTP response for full download.");
      }
      return bytes;
    },
    lazy,
  );

const run = async (corpus: string, mode: string | undefined) => {
  const wasm = await readFile(wasmUrl);
  const paths = await pdfs(corpus);
  const files =
    mode === "--http" && paths.length > HTTP_SAMPLE_SIZE
      ? Array.from(
          { length: HTTP_SAMPLE_SIZE },
          (_, index) => paths[Math.floor((index * (paths.length - 1)) / (HTTP_SAMPLE_SIZE - 1))],
        ).filter((path) => path !== undefined)
      : paths;
  using server = mode === "--http" ? rangeServer(files) : undefined;
  const [lazyCore, fullCore] = await Promise.all(
    [0, 1].map(async () => createPdfCoreClient(await WebAssembly.compile(wasm))),
  );
  if (lazyCore === undefined || fullCore === undefined) {
    throw new Error("Could not initialize benchmark instances.");
  }

  const lazy: Array<Measurement> = [];
  const full: Array<Measurement> = [];
  let mismatches = 0;
  let failures = 0;
  for (const [index, path] of files.entries()) {
    const file = relative(corpus, path);
    const trial = (core: PdfCoreClient, partial: boolean) => {
      if (server !== undefined) {
        return http(core, new URL(String(index), server.url), Bun.file(path).size, partial);
      }
      if (mode === "--warm" || mode === "--rtt") {
        return local(path, core, partial, mode === "--rtt" ? RTT_MS : 0);
      }
      return worker(path, partial, wasm);
    };
    try {
      const partialTrials: Array<Measurement> = [];
      const completeTrials: Array<Measurement> = [];
      if (mode === "--warm" || mode === "--rtt" || mode === "--http") {
        await local(path, lazyCore, true);
        await local(path, fullCore, false);
      }
      const trials = mode === "--warm" || mode === "--http" ? 3 : 1;
      for (let index = 0; index < trials; index += 1) {
        partialTrials.push(await trial(lazyCore, true));
        completeTrials.push(await trial(fullCore, false));
      }
      const partial = median(partialTrials);
      const complete = median(completeTrials);
      const { markdown: left, ...partialStats } = partial;
      const { markdown: right, ...completeStats } = complete;
      const equal =
        left.length === right.length && left.every((page, index) => page === right[index]);
      mismatches += equal ? 0 : 1;
      console.log(
        JSON.stringify({
          file,
          equal,
          lazy: partialStats,
          full: completeStats,
          lazySamples: partialTrials.map((trial) => trial.latencyMs),
          fullSamples: completeTrials.map((trial) => trial.latencyMs),
        }),
      );
      lazy.push(partial);
      full.push(complete);
    } catch (cause) {
      failures += 1;
      console.error(file, cause);
    }
  }
  console.log(
    JSON.stringify({
      mode: mode ?? "fresh",
      files: files.length,
      mismatches,
      failures,
      wasmSize: wasm.byteLength,
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
  const core = await createPdfCoreClient(await WebAssembly.compile(await Bun.stdin.arrayBuffer()));
  console.log(JSON.stringify(await local(document, core, mode === "--lazy")));
} else if (
  corpus !== undefined &&
  (mode === undefined || ["--warm", "--rtt", "--http"].includes(mode))
) {
  await run(corpus, mode);
} else {
  console.error("Set PDF_CORPUS and choose an optional --warm, --rtt or --http mode.");
  process.exitCode = 1;
}
