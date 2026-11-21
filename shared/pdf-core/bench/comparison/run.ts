import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  extractPagesMarkdown,
  extractText as inspectorText,
  processPdfAsync,
} from "@firecrawl/pdf-inspector";
import {
  extractText as inspectorWasmText,
  initSync,
  processPdf,
} from "@firecrawl/pdf-inspector-wasm";
import { LiteParse } from "@llamaindex/liteparse";

const root = process.env.SIGNATURE_KIT_ROOT;
if (root === undefined) {
  throw new Error("Set SIGNATURE_KIT_ROOT to the absolute path of the built checkout.");
}

const { createPdfCoreClient } = await import(join(root, "shared/pdf-core/dist/promise.js"));
const wasm = await Bun.file(join(root, "shared/pdf-core/dist/pdf-core.wasm")).bytes();
const core = await createPdfCoreClient(await WebAssembly.compile(wasm));
const inspectorBinary = await Bun.file(
  new URL(import.meta.resolve("@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm")),
).bytes();
const inspectorWasm = initSync({ module: inspectorBinary });
const corpus = process.env.PDF_CORPUS;
const folder =
  corpus === undefined ? join(root, "shared/pdf-core/__tests__/fixtures") : join(corpus, "pdfs");
const files = (await readdir(folder)).filter((name) => name.endsWith(".pdf")).sort();
if (files.length === 0) {
  throw new Error("The benchmark requires at least one PDF.");
}
const trials = Number(process.env.PDF_BENCH_TRIALS ?? (corpus === undefined ? 7 : 1));
if (!Number.isSafeInteger(trials) || trials < 1) {
  throw new Error("PDF_BENCH_TRIALS must be a positive integer.");
}

const median = (ordered: readonly number[]) => ordered[Math.floor(ordered.length / 2)];
const engines = ["pdf-core", "LiteParse", "Inspector native", "Inspector Wasm"];
const modes: ReadonlyArray<"first" | "all" | "text"> = ["first", "all", "text"];
const normalize = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

console.log(
  JSON.stringify({
    type: "environment",
    bun: Bun.version,
    files: files.length,
    trials,
    wasmBytes: { "pdf-core": wasm.length, "Inspector Wasm": inspectorBinary.length },
  }),
);

for (const mode of modes) {
  const pageIndexes = mode === "first" ? [0] : undefined;
  const format = mode === "text" ? "text" : "markdown";
  const comparable = new Map<string, Array<{ medianMs: number; hits: number; total: number }>>();
  const excluded: string[] = [];
  const lite = new LiteParse({
    outputFormat: format,
    targetPages: mode === "first" ? "1" : undefined,
    ocrEnabled: false,
    imageMode: "off",
    quiet: true,
    maxPages: 10000,
  });
  try {
    for (const [fileIndex, file] of files.entries()) {
      const input = Buffer.from(await Bun.file(join(folder, file)).bytes());
      const answerKey =
        corpus === undefined || mode !== "all"
          ? undefined
          : join(corpus, "gabarito", file.replace(/\.pdf$/, ".json"));
      const grade:
        | { readonly gabarito: Record<string, { readonly evidencia?: string }> }
        | undefined =
        answerKey !== undefined && (await Bun.file(answerKey).exists()) === true
          ? await Bun.file(answerKey).json()
          : undefined;
      const evidence =
        grade === undefined
          ? []
          : Object.values(grade.gabarito)
              .map((item) => normalize(item.evidencia ?? ""))
              .filter(Boolean);
      const parse = [
        async () => (await core.text(input, { pageIndexes, format })).join("\n\n"),
        async () => {
          const result = await lite.parse(input);
          if (result.pageErrors.length > 0) {
            throw new Error(JSON.stringify(result.pageErrors));
          }
          return result.text;
        },
        async () => {
          if (mode === "text") return inspectorText(input);
          if (mode === "all" && corpus !== undefined) {
            return (await processPdfAsync(input)).markdown ?? "";
          }
          return extractPagesMarkdown(input, pageIndexes)
            .pages.map((page) => page.markdown)
            .join("\n\n");
        },
        () =>
          mode === "text"
            ? inspectorWasmText(input)
            : (processPdf(input, {
                pages: mode === "first" ? [1] : undefined,
                includeImages: false,
              }).markdown ?? ""),
      ];
      const samples = engines.map((): number[] => []);
      const outputs = new Map<number, string>();
      const errors = new Map<number, string>();
      for (let round = 0; round <= trials; round += 1) {
        for (let step = 0; step < engines.length; step += 1) {
          const index = (fileIndex + round + step) % engines.length;
          const operation = parse[index];
          if (operation === undefined || errors.has(index)) {
            continue;
          }
          try {
            const start = performance.now();
            const output = await operation();
            const duration = performance.now() - start;
            outputs.set(index, output);
            if (round > 0) {
              samples[index]?.push(duration);
            }
          } catch (error) {
            errors.set(index, String(error));
          }
        }
      }
      const common = engines.every(
        (_, index) => !errors.has(index) && (outputs.get(index) ?? "").trim().length > 0,
      );
      if (!common) excluded.push(file);
      for (const [index, engine] of engines.entries()) {
        const output = outputs.get(index) ?? "";
        const times = samples[index] ?? [];
        times.sort((left, right) => left - right);
        const normalized = normalize(output);
        const medianMs = median(times);
        const hits = evidence.filter((snippet) => normalized.includes(snippet)).length;
        if (common && medianMs !== undefined) {
          const entries = comparable.get(engine) ?? [];
          entries.push({ medianMs, hits, total: evidence.length });
          comparable.set(engine, entries);
        }
        const outputHash = createHash("sha256").update(output).digest("hex");
        console.log(
          JSON.stringify({
            type: "measurement",
            file,
            mode,
            engine,
            inputBytes: input.length,
            times,
            medianMs,
            error: errors.get(index),
            empty: output.trim().length === 0,
            outputHash,
            evidence: {
              hits,
              total: evidence.length,
            },
            normalizedHash: createHash("sha256").update(normalized).digest("hex"),
          }),
        );
      }
    }
  } finally {
    lite.close();
  }
  for (const [engine, rows] of comparable) {
    const times = rows.map((row) => row.medianMs).sort((left, right) => left - right);
    console.log(
      JSON.stringify({
        type: "summary",
        mode,
        engine,
        files: rows.length,
        excluded,
        p50: median(times),
        p90: times[Math.ceil(times.length * 0.9) - 1],
        evidence: rows.reduce(
          (score, row) => ({
            hits: score.hits + row.hits,
            total: score.total + row.total,
          }),
          { hits: 0, total: 0 },
        ),
      }),
    );
  }
}
console.log(
  JSON.stringify({
    type: "memory",
    "pdf-core": await core.wasmMemoryBytes(),
    "Inspector Wasm": inspectorWasm.memory.buffer.byteLength,
  }),
);
