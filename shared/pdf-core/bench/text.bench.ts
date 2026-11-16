import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PDFDocument } from "@cantoo/pdf-lib";
import initPdfInspector, { detectPdf, extractText } from "@firecrawl/pdf-inspector-wasm";
import initLiteParseWasm, { LiteParse } from "@llamaindex/liteparse-wasm";
import { Effect } from "effect";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

import { makePdfCore } from "../src/pdf-core.ts";
import { listCommittedCorpusFixtures, PDF_CORE_FIXTURES_DIR } from "../__tests__/corpus.ts";

type BenchRow = {
  readonly fixture: string;
  readonly adapter: string;
  readonly coldMs: number;
  readonly warmP50Ms: number;
  readonly warmP95Ms: number;
  readonly pages: number;
  readonly items: number;
};

type TextExtractionSummary = {
  readonly pages: number;
  readonly items: number;
};

type TextExtractionAdapter = (pdf: Uint8Array) => Promise<TextExtractionSummary>;

const benchDirectory = dirname(fileURLToPath(import.meta.url));
const resultsDirectory = join(benchDirectory, "results");
const warmIterations = 10;
const require = createRequire(import.meta.url);

const percentile = (values: ReadonlyArray<number>, ratio: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
};

const wasmBytes = (specifier: string): Uint8Array =>
  new Uint8Array(readFileSync(require.resolve(specifier)));

const pdfJsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const pdfCoreWasmPath = join(benchDirectory, "../dist/pdf-core.wasm");

const initLiteParse = (): Promise<unknown> =>
  initLiteParseWasm({
    module_or_path: wasmBytes("@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm"),
  });

const initInspector = (): Promise<unknown> =>
  initPdfInspector({
    module_or_path: wasmBytes("@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm"),
  });

const configurePdfJs = (): void => {
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    join(pdfJsRoot, "legacy/build/pdf.worker.mjs"),
  ).href;
};

const compilePdfCore = async () =>
  Effect.runPromise(
    makePdfCore(await WebAssembly.compile(new Uint8Array(readFileSync(pdfCoreWasmPath)))),
  );

const createLiteParseAdapter = async (): Promise<TextExtractionAdapter> => {
  await initLiteParse();
  return async (pdf) => {
    const document = await PDFDocument.load(pdf, { ignoreEncryption: true });
    const parser = new LiteParse({
      ocrEnabled: false,
      maxPages: document.getPageCount(),
      outputFormat: "json",
      preserveVerySmallText: true,
      quiet: true,
    });
    const parsed = await parser.parse(pdf).finally(() => parser.free());
    const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];
    const items = pages.reduce(
      (total, page) => total + (Array.isArray(page?.textItems) ? page.textItems.length : 0),
      0,
    );
    return { pages: pages.length, items };
  };
};

const createPdfJsAdapter = async (): Promise<TextExtractionAdapter> => {
  configurePdfJs();
  const standardFontDataUrl = `${join(pdfJsRoot, "standard_fonts")}/`;
  return async (pdf) => {
    const task = getDocument({
      data: new Uint8Array(pdf),
      disableFontFace: true,
      isEvalSupported: false,
      standardFontDataUrl,
    });
    const document = await task.promise;
    let items = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      items += (await page.getTextContent()).items.length;
      await page.getAnnotations();
      page.cleanup();
    }
    const pages = document.numPages;
    await task.destroy();
    return { pages, items };
  };
};

const createPdfInspectorAdapter = async (): Promise<TextExtractionAdapter> => {
  await initInspector();
  return async (pdf) => {
    const detected = detectPdf(pdf);
    const text = extractText(pdf);
    return { pages: detected.pageCount, items: text.split(/\S+/u).filter(Boolean).length };
  };
};

const createPdfCoreAdapter = async (): Promise<TextExtractionAdapter> => {
  const core = await compilePdfCore();
  return async (pdf) => {
    const inspection = await Effect.runPromise(core.inspect(pdf, { text: true, links: true }));
    return {
      pages: inspection.pages.length,
      items: inspection.text.reduce((total, page) => total + page.rects.length / 5, 0),
    };
  };
};

const measure = async (
  fixture: string,
  adapter: string,
  run: TextExtractionAdapter,
  pdf: Uint8Array,
  cold: () => Promise<unknown>,
): Promise<BenchRow> => {
  const coldStart = performance.now();
  await cold();
  const coldMs = performance.now() - coldStart;
  const warm: number[] = [];
  let summary: TextExtractionSummary = { pages: 0, items: 0 };
  for (let iteration = 0; iteration < warmIterations; iteration += 1) {
    const start = performance.now();
    summary = await run(pdf);
    warm.push(performance.now() - start);
  }
  return {
    fixture,
    adapter,
    coldMs,
    warmP50Ms: percentile(warm, 0.5),
    warmP95Ms: percentile(warm, 0.95),
    pages: summary.pages,
    items: summary.items,
  };
};

const fixturesToRun = (): ReadonlyArray<{ readonly label: string; readonly path: string }> => {
  const committed = listCommittedCorpusFixtures().map((name) => ({
    label: name,
    path: join(PDF_CORE_FIXTURES_DIR, name),
  }));
  const corpusDirectory = process.env.SIGNATURE_KIT_PDF_CORPUS_DIR;
  if (corpusDirectory === undefined || corpusDirectory.length === 0) {
    return committed;
  }
  const known = new Set(committed.map((fixture) => fixture.label));
  const extra = readdirSync(corpusDirectory)
    .filter((entry) => entry.endsWith(".pdf") && !known.has(entry))
    .map((entry) => ({ label: entry, path: join(corpusDirectory, entry) }));
  return [...committed, ...extra];
};

const markdownTable = (rows: ReadonlyArray<BenchRow>): string => {
  const header = "| fixture | adapter | cold ms | warm p50 ms | warm p95 ms | pages | items |";
  const divider = "| --- | --- | ---: | ---: | ---: | ---: | ---: |";
  const body = rows.map(
    (row) =>
      `| ${row.fixture} | ${row.adapter} | ${row.coldMs.toFixed(1)} | ${row.warmP50Ms.toFixed(1)} | ${row.warmP95Ms.toFixed(1)} | ${row.pages} | ${row.items} |`,
  );
  return [header, divider, ...body].join("\n");
};

mkdirSync(resultsDirectory, { recursive: true });
const adapters: ReadonlyArray<{
  readonly name: string;
  readonly run: TextExtractionAdapter;
  readonly cold: () => Promise<unknown>;
}> = [
  { name: "liteparse", run: await createLiteParseAdapter(), cold: initLiteParse },
  { name: "pdfjs", run: await createPdfJsAdapter(), cold: () => Promise.resolve(configurePdfJs()) },
  { name: "pdf-inspector", run: await createPdfInspectorAdapter(), cold: initInspector },
  { name: "pdf-core", run: await createPdfCoreAdapter(), cold: compilePdfCore },
];

const rows: BenchRow[] = [];
for (const fixture of fixturesToRun()) {
  const pdf = new Uint8Array(readFileSync(fixture.path));
  for (const adapter of adapters) {
    rows.push(await measure(fixture.label, adapter.name, adapter.run, pdf, adapter.cold));
  }
}

console.log(markdownTable(rows));
writeFileSync(
  join(resultsDirectory, "latest.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`,
);
