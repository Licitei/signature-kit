#!/usr/bin/env bun
/**
 * Speed guard for pdf-core wasm hill-climbing.
 * Measures median of 3 runs:
 *   - wasm text ms/page on the 30 editais (PDF_CORE worktree)
 *   - wasm renderPages ms/page on 5 editais
 *   - signatures() + document() on habilitacao-150 and a ~30 MB edital
 *
 * Usage: bun packages/engine/bench/measure-speed.ts [--label NAME] [--quick]
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const repo = resolve(pkg, "../..");
const args: string[] = process.argv.slice(2);
const labelIdx = args.indexOf("--label");
const label = labelIdx >= 0 ? (args[labelIdx + 1] ?? "step") : "step";
const quick: boolean = args.includes("--quick");

const pdfDir = process.env.PDF_CORPUS ?? join(repo, ".cache/bench/pdfs");
const fixtureDir = join(repo, "crates/pdf/tests/fixtures/pdf");

async function loadCore() {
  const effectUrl = pathToFileURL(join(repo, "node_modules/effect/dist/index.js")).href;
  const nodeUrl = pathToFileURL(
    join(repo, "node_modules/@effect/platform-node/dist/NodeServices.js"),
  ).href;
  const coreUrl = pathToFileURL(join(pkg, "dist/wasm/pdf-core.js")).href;
  const fileUrl = pathToFileURL(join(pkg, "dist/wasm/file.js")).href;
  const { Effect, Layer } = await import(effectUrl);
  const NodeServices = await import(nodeUrl);
  const { PdfCore } = await import(coreUrl);
  const { pdfCoreFileLayer } = await import(fileUrl);
  const core = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* PdfCore;
    }).pipe(Effect.provide(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer)))),
  );
  return { Effect, core };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const left = sorted[mid - 1] ?? 0;
  const right = sorted[mid] ?? 0;
  return sorted.length % 2 === 0 ? (left + right) / 2 : right;
}

function pagesInName(name: string): number {
  const match = /^(\d+)p_/.exec(name);
  return match === null ? 1 : Number(match[1]);
}

function listEditais(): string[] {
  return readdirSync(pdfDir)
    .filter((name) => name.endsWith(".pdf"))
    .sort()
    .map((name) => join(pdfDir, name));
}

async function timeText(
  Effect: { runPromise: (effect: unknown) => Promise<unknown> },
  core: { text: (bytes: Uint8Array) => unknown },
  files: string[],
): Promise<{ msPerPage: number; totalMs: number; pages: number; ok: number }> {
  let totalMs = 0;
  let pages = 0;
  let ok = 0;
  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file));
    const pageCount = pagesInName(basename(file));
    const t0 = performance.now();
    await Effect.runPromise(core.text(bytes));
    totalMs += performance.now() - t0;
    pages += pageCount;
    ok += 1;
  }
  return { msPerPage: totalMs / pages, totalMs, pages, ok };
}

async function timeRender(
  Effect: { runPromise: (effect: unknown) => Promise<unknown> },
  core: {
    renderPages: (
      bytes: Uint8Array,
      options?: { pageIndexes?: number[]; scale?: number },
    ) => unknown;
  },
  files: string[],
): Promise<{ msPerPage: number; totalMs: number; pages: number }> {
  let totalMs = 0;
  let pages = 0;
  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file));
    const pageCount = Math.min(pagesInName(basename(file)), 8);
    const indexes = Array.from({ length: pageCount }, (_, i) => i);
    const t0 = performance.now();
    await Effect.runPromise(core.renderPages(bytes, { pageIndexes: indexes, scale: 1 }));
    totalMs += performance.now() - t0;
    pages += pageCount;
  }
  return { msPerPage: totalMs / pages, totalMs, pages };
}

async function timeSignatures(
  Effect: { runPromise: (effect: unknown) => Promise<unknown> },
  core: {
    signatures: (bytes: Uint8Array, mode: string) => unknown;
    document: (bytes: Uint8Array, options?: { annotationPages?: number[] }) => unknown;
    text: (bytes: Uint8Array) => unknown;
  },
  file: string,
): Promise<{ signScanMs: number; documentMs: number; textMs: number; bytes: number }> {
  const bytes = new Uint8Array(readFileSync(file));
  const t0 = performance.now();
  await Effect.runPromise(core.signatures(bytes, "scan"));
  const signScanMs = performance.now() - t0;
  const t1 = performance.now();
  await Effect.runPromise(core.document(bytes, { annotationPages: [0] }));
  const documentMs = performance.now() - t1;
  const t2 = performance.now();
  await Effect.runPromise(core.text(bytes));
  const textMs = performance.now() - t2;
  return { signScanMs, documentMs, textMs, bytes: bytes.byteLength };
}

const { Effect, core } = await loadCore();
const editais = listEditais();
const textFiles = quick ? editais.slice(0, 5) : editais;
const renderFiles = editais
  .slice()
  .sort((a, b) => statSync(a).size - statSync(b).size)
  .slice(0, 5);
const habilitacao = join(fixtureDir, "habilitacao-150.pdf");
const largestEdital = editais.slice().sort((a, b) => statSync(b).size - statSync(a).size)[0];
const largeEdital =
  editais.find((f) => basename(f).startsWith("0559p_")) ?? largestEdital ?? habilitacao;
const warmText = textFiles[0] ?? habilitacao;
const warmRender = renderFiles[0] ?? warmText;

const runs = quick ? 5 : 5;
const textRuns: number[] = [];
const renderRuns: number[] = [];
const habRuns: Awaited<ReturnType<typeof timeSignatures>>[] = [];
const largeRuns: Awaited<ReturnType<typeof timeSignatures>>[] = [];

for (let warm = 0; warm < 3; warm += 1) {
  await Effect.runPromise(core.text(new Uint8Array(readFileSync(warmText))));
  await Effect.runPromise(
    core.renderPages(new Uint8Array(readFileSync(warmRender)), {
      pageIndexes: [0, 1, 2],
      scale: 1,
    }),
  );
  await Effect.runPromise(core.signatures(new Uint8Array(readFileSync(habilitacao)), "scan"));
}

for (let i = 0; i < runs; i += 1) {
  const text = await timeText(Effect, core, textFiles);
  textRuns.push(text.msPerPage);
  const render = await timeRender(Effect, core, renderFiles);
  renderRuns.push(render.msPerPage);
  habRuns.push(await timeSignatures(Effect, core, habilitacao));
  if (!quick) largeRuns.push(await timeSignatures(Effect, core, largeEdital));
}

const result = {
  label,
  quick,
  textMsPerPage: median(textRuns),
  textMsPerPageRuns: textRuns,
  textNoisePct:
    textRuns.length > 1
      ? (100 * (Math.max(...textRuns) - Math.min(...textRuns))) / median(textRuns)
      : 0,
  renderMsPerPage: median(renderRuns),
  renderMsPerPageRuns: renderRuns,
  renderNoisePct:
    renderRuns.length > 1
      ? (100 * (Math.max(...renderRuns) - Math.min(...renderRuns))) / median(renderRuns)
      : 0,
  habilitacao: {
    signScanMs: median(habRuns.map((r) => r.signScanMs)),
    documentMs: median(habRuns.map((r) => r.documentMs)),
    textMs: median(habRuns.map((r) => r.textMs)),
    bytes: habRuns[0]?.bytes ?? 0,
    samples: habRuns,
  },
  largeEdital: quick
    ? null
    : {
        file: basename(largeEdital),
        signScanMs: median(largeRuns.map((r) => r.signScanMs)),
        documentMs: median(largeRuns.map((r) => r.documentMs)),
        textMs: median(largeRuns.map((r) => r.textMs)),
        bytes: largeRuns[0]?.bytes ?? 0,
        samples: largeRuns,
      },
};

console.log(JSON.stringify(result, null, 2));
const logDir = join(repo, ".cache/logs");
mkdirSync(logDir, { recursive: true });
writeFileSync(join(logDir, "hill-speeds.jsonl"), `${JSON.stringify(result)}\n`, { flag: "a" });
