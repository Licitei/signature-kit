import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";

import { makePdfCore } from "../dist/pdf-core.js";

type Outcome =
  | { readonly ok: true; readonly ms: number; readonly pages: number; readonly chars: number }
  | { readonly ok: false; readonly ms: number; readonly reason: string };

type Row = {
  readonly file: string;
  readonly group: string;
  readonly outcome: Outcome;
};

const benchDir = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(benchDir, "..", "dist", "pdf-core.wasm");
const SLOW_MS = 10_000;
const TEXTLESS_CHARS = 20;

const parseArguments = (): { root: string; liteparseDir: string | undefined; limit: number } => {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  return {
    root: value("--root") ?? "/home/yorizel/Documents/bench-parsers/editais-extra",
    liteparseDir: value("--liteparse-dir"),
    limit: Number(value("--limit") ?? "0"),
  };
};

const listPdfs = (root: string): ReadonlyArray<string> =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

const percentile = (values: ReadonlyArray<number>, ratio: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))] ?? 0;
};

const nonWhitespace = (text: string): number => text.replace(/\s+/gu, "").length;

type Runner = (file: string) => Effect.Effect<Outcome>;

const pdfCoreRunner = Effect.gen(function* () {
  const module = yield* Effect.promise(() =>
    WebAssembly.compile(new Uint8Array(readFileSync(wasmPath))),
  );
  const core = yield* makePdfCore(module);
  const run: Runner = (file) =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(readFileSync(file));
      const start = performance.now();
      const result = yield* Effect.result(core.text(bytes));
      const ms = performance.now() - start;
      return result._tag === "Success"
        ? {
            ok: true,
            ms,
            pages: result.success.length,
            chars: result.success.reduce((sum, page) => sum + nonWhitespace(page), 0),
          }
        : { ok: false, ms, reason: `${result.failure.code}: ${result.failure.message}` };
    });
  return run;
});

const liteparseRunner = (dir: string) =>
  Effect.gen(function* () {
    const module = yield* Effect.promise(
      () =>
        import(
          pathToFileURL(join(dir, "node_modules", "@llamaindex", "liteparse", "dist", "lib.js"))
            .href
        ),
    );
    const parser = new module.LiteParse({
      outputFormat: "markdown",
      ocrEnabled: false,
      imageMode: "off",
      quiet: true,
    });
    const run: Runner = (file) =>
      Effect.promise(() => {
        const start = performance.now();
        return parser.parse(file).then(
          (parsed: { pages?: ReadonlyArray<unknown>; text?: unknown }): Outcome => ({
            ok: true,
            ms: performance.now() - start,
            pages: Array.isArray(parsed.pages) ? parsed.pages.length : 0,
            chars: nonWhitespace(typeof parsed.text === "string" ? parsed.text : ""),
          }),
          (failure: unknown): Outcome => ({
            ok: false,
            ms: performance.now() - start,
            reason: String(failure).slice(0, 120),
          }),
        );
      });
    return run;
  });

const summarize = (label: string, rows: ReadonlyArray<Row>): void => {
  const groups = [...new Set(rows.map((row) => row.group))].sort();
  console.log(`\n## ${label}\n`);
  console.log("| Group | PDFs | Failures | Textless | Pages | p50 | p90 | max | ms/page |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const group of [...groups, "all"]) {
    const subset = group === "all" ? rows : rows.filter((row) => row.group === group);
    const done = subset.flatMap((row) => (row.outcome.ok ? [row.outcome] : []));
    const failures = subset.length - done.length;
    const textless = done.filter((outcome) => outcome.chars <= TEXTLESS_CHARS).length;
    const pages = done.reduce((sum, outcome) => sum + outcome.pages, 0);
    const seconds = done.map((outcome) => outcome.ms / 1000);
    const total = seconds.reduce((sum, value) => sum + value, 0);
    console.log(
      `| ${group} | ${subset.length} | ${failures} | ${textless} | ${pages} | ${percentile(seconds, 0.5).toFixed(3)} s | ${percentile(seconds, 0.9).toFixed(3)} s | ${Math.max(0, ...seconds).toFixed(3)} s | ${pages === 0 ? "n/a" : ((1000 * total) / pages).toFixed(2)} |`,
    );
  }
  const slowest = rows
    .flatMap((row) => (row.outcome.ok ? [{ row, outcome: row.outcome }] : []))
    .sort((left, right) => right.outcome.ms - left.outcome.ms)
    .slice(0, 5);
  for (const { row, outcome } of slowest) {
    console.log(
      `TOP ${row.file}: ${(outcome.ms / 1000).toFixed(3)} s, ${outcome.pages} pages, ${outcome.chars} chars`,
    );
  }
  for (const row of rows) {
    if (!row.outcome.ok) {
      console.log(`FAILURE ${row.file}: ${row.outcome.reason}`);
    } else if (row.outcome.ms > SLOW_MS) {
      console.log(`SLOW ${row.file}: ${(row.outcome.ms / 1000).toFixed(2)} s`);
    }
  }
};

const options = parseArguments();
const files = listPdfs(options.root);
const selected = options.limit > 0 ? files.slice(0, options.limit) : files;
const groupOf = (file: string): string => relative(options.root, file).split(sep)[0] ?? "";

const runAll = (run: Runner) =>
  Effect.gen(function* () {
    const warm = selected.reduce(
      (smallest, file) => (statSync(file).size < statSync(smallest).size ? file : smallest),
      selected[0] ?? "",
    );
    if (warm !== "") {
      yield* run(warm);
    }
    const rows: Row[] = [];
    for (const file of selected) {
      rows.push({
        file: relative(options.root, file),
        group: groupOf(file),
        outcome: yield* run(file),
      });
    }
    return rows;
  });

const program = Effect.gen(function* () {
  summarize("pdf_core", yield* runAll(yield* pdfCoreRunner));
  if (options.liteparseDir !== undefined) {
    summarize("liteparse", yield* runAll(yield* liteparseRunner(options.liteparseDir)));
  }
});

NodeRuntime.runMain(program);
