import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CORPUS_FIXTURE_NAMES,
  listCommittedCorpusFixtures,
  PDF_CORE_FIXTURES_DIR,
  type CorpusFixtureName,
} from "../__tests__/corpus.ts";
import { bunStorePackageRoot, workspaceModuleUrl } from "../scripts/workspace-modules.ts";

const pdfInspectorModule = await import(
  workspaceModuleUrl("node_modules/@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm.js"),
);
const initPdfInspector = pdfInspectorModule.default;
const detectPdf = pdfInspectorModule.detectPdf;
const extractText = pdfInspectorModule.extractText;

const liteParseModule = await import(
  workspaceModuleUrl("formats/pdf/node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm.js"),
);
const initLiteParseWasm = liteParseModule.default;
const LiteParse = liteParseModule.LiteParse;

const pdfJsModule = await import(
  pathToFileURL(join(bunStorePackageRoot("pdfjs-dist"), "legacy/build/pdf.mjs")).href,
);
const getDocument = pdfJsModule.getDocument;
const GlobalWorkerOptions = pdfJsModule.GlobalWorkerOptions;

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

type PdfCoreBenchAdapter = (pdf: Uint8Array) => Promise<TextExtractionSummary>;

const benchDir = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(benchDir, "results");
const warmIterations = 5;

const percentile = (values: ReadonlyArray<number>, ratio: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
};

const liteParseWasmBytes = (): Uint8Array => {
  return new Uint8Array(
    readFileSync(
      fileURLToPath(
        workspaceModuleUrl(
          "formats/pdf/node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm_bg.wasm",
        ),
      ),
    ),
  );
};

const pdfInspectorWasmBytes = (): Uint8Array =>
  new Uint8Array(
    readFileSync(
      fileURLToPath(
        workspaceModuleUrl("node_modules/@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm"),
      ),
    ),
  );

const pageCountFromPdf = async (pdf: Uint8Array): Promise<number> => {
  const { PDFDocument } = await import(
    workspaceModuleUrl("formats/pdf/node_modules/@cantoo/pdf-lib/es/index.js"),
  );
  return (await PDFDocument.load(pdf, { ignoreEncryption: true })).getPageCount();
};

const createLiteParseAdapter = async (): Promise<(pdf: Uint8Array) => Promise<TextExtractionSummary>> => {
  await initLiteParseWasm({ module_or_path: liteParseWasmBytes() });
  return async (pdf: Uint8Array): Promise<TextExtractionSummary> => {
    const pageCount = await pageCountFromPdf(pdf);
    const parser = new LiteParse({
      ocrEnabled: false,
      maxPages: pageCount,
      outputFormat: "json",
      preserveVerySmallText: true,
      quiet: true,
    });
    try {
      const parsed = await parser.parse(pdf);
      if (typeof parsed !== "object" || parsed === null || !("pages" in parsed)) {
        return { pages: 0, items: 0 };
      }
      const pages = (parsed as { pages: ReadonlyArray<{ textItems?: ReadonlyArray<unknown> }> }).pages;
      const items = pages.reduce((total, page) => total + (page.textItems?.length ?? 0), 0);
      return { pages: pages.length, items };
    } finally {
      parser.free();
    }
  };
};

const createPdfJsAdapter = async (): Promise<(pdf: Uint8Array) => Promise<TextExtractionSummary>> => {
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    join(bunStorePackageRoot("pdfjs-dist"), "legacy/build/pdf.worker.mjs"),
  ).href;
  return async (pdf: Uint8Array): Promise<TextExtractionSummary> => {
    const standardFontDataUrl = pathToFileURL(
      join(bunStorePackageRoot("pdfjs-dist"), "standard_fonts/"),
    ).href;
    const task = getDocument({
      data: new Uint8Array(pdf),
      disableFontFace: true,
      isEvalSupported: false,
      standardFontDataUrl,
    });
    const document = await task.promise;
    const pageCount = document.numPages;
    let items = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      items += text.items.length;
      await page.getAnnotations();
      page.cleanup();
    }
    if (typeof document.cleanup === "function") {
      document.cleanup();
    }
    return { pages: pageCount, items };
  };
};

const createPdfInspectorAdapter = async (): Promise<
  (pdf: Uint8Array) => Promise<TextExtractionSummary>
> => {
  await initPdfInspector({ module_or_path: pdfInspectorWasmBytes() });
  return async (pdf: Uint8Array): Promise<TextExtractionSummary> => {
    const detected = detectPdf(pdf);
    const text = extractText(pdf);
    const items = text.split(/\S+/u).filter((token) => token.length > 0).length;
    return { pages: detected.pageCount, items };
  };
};

const loadPdfCoreAdapter = async (): Promise<PdfCoreBenchAdapter | undefined> => {
  const modulePath = join(benchDir, "../dist/pdf-core.js");
  try {
    const module = (await import(modulePath)) as {
      readonly inspect?: (pdf: Uint8Array) => Promise<TextExtractionSummary>;
    };
    if (typeof module.inspect === "function") {
      return module.inspect;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const measure = async (
  fixture: string,
  adapterName: string,
  run: (pdf: Uint8Array) => Promise<TextExtractionSummary>,
  pdf: Uint8Array,
  cold: () => Promise<void>,
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
    adapter: adapterName,
    coldMs,
    warmP50Ms: percentile(warm, 0.5),
    warmP95Ms: percentile(warm, 0.95),
    pages: summary.pages,
    items: summary.items,
  };
};

const fixturesToRun = (): ReadonlyArray<{ readonly label: string; readonly path: string }> => {
  const committed = listCommittedCorpusFixtures();
  const corpusDir = process.env.SIGNATURE_KIT_PDF_CORPUS_DIR;
  if (corpusDir === undefined || corpusDir.length === 0) {
    return committed.map((name) => ({ label: name, path: join(PDF_CORE_FIXTURES_DIR, name) }));
  }
  const extra = readdirSync(corpusDir)
    .filter((entry) => entry.endsWith(".pdf"))
    .filter((entry) => !CORPUS_FIXTURE_NAMES.includes(entry as CorpusFixtureName))
    .map((entry) => ({ label: entry, path: join(corpusDir, entry) }));
  return [
    ...committed.map((name) => ({ label: name, path: join(PDF_CORE_FIXTURES_DIR, name) })),
    ...extra,
  ];
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

const main = async (): Promise<void> => {
  mkdirSync(resultsDir, { recursive: true });
  const liteParseRun = await createLiteParseAdapter();
  const pdfJsRun = await createPdfJsAdapter();
  const pdfInspectorRun = await createPdfInspectorAdapter();
  const pdfCoreRun = await loadPdfCoreAdapter();
  const rows: BenchRow[] = [];
  for (const fixture of fixturesToRun()) {
    const pdf = new Uint8Array(readFileSync(fixture.path));
    rows.push(
      await measure(fixture.label, "liteparse", liteParseRun, pdf, async () => {
        await initLiteParseWasm({ module_or_path: liteParseWasmBytes() });
      }),
    );
    rows.push(
      await measure(fixture.label, "pdfjs", pdfJsRun, pdf, async () => {
        GlobalWorkerOptions.workerSrc = pathToFileURL(
          join(bunStorePackageRoot("pdfjs-dist"), "legacy/build/pdf.worker.mjs"),
        ).href;
      }),
    );
    rows.push(
      await measure(fixture.label, "pdf-inspector", pdfInspectorRun, pdf, async () => {
        await initPdfInspector({ module_or_path: pdfInspectorWasmBytes() });
      }),
    );
    if (pdfCoreRun !== undefined) {
      rows.push(await measure(fixture.label, "pdf-core", pdfCoreRun, pdf, async () => undefined));
    }
  }
  const table = markdownTable(rows);
  console.log(table);
  writeFileSync(
    join(resultsDir, "latest.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`,
  );
};

await main();