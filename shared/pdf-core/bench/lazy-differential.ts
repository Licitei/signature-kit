import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, FileSystem, Option, Schema } from "effect";

import type { PdfCoreError, PdfCoreTextOptions } from "../dist/config.js";
import { pdfCoreFileSource } from "../dist/file.js";
import { makePdfCore } from "../dist/pdf-core.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const corpus = "/home/yorizel/Documents/bench-parsers";
const wasmPath = fileURLToPath(new URL("../dist/pdf-core.wasm", import.meta.url));
const defaults = [
  join(corpus, "pncp-triage/pdfs"),
  join(corpus, "pdfs"),
  join(corpus, "editais-extra"),
  join(repo, "shared/pdf-core/__tests__/fixtures"),
  join(repo, "formats/pdf/__tests__/fixtures"),
  join(repo, "validators/iti/__tests__/fixtures"),
];
const { values: args, positionals: paths } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: join(repo, ".cache/lazy-differential.jsonl") },
    wasm: { type: "string", default: wasmPath },
    workers: { type: "string", default: "4" },
    worker: { type: "boolean" },
  },
});
const output = resolve(args.out);
const wasm = readFileSync(args.wasm);
const fingerprint = createHash("sha256")
  .update(wasm)
  .update(readFileSync(import.meta.path))
  .digest("hex");

const Api = Schema.Literals(["text", "inspect", "tables", "info", "headings", "renderPages"]);
type Api = typeof Api.Type;
const Issue = Schema.Struct({
  api: Api,
  operation: Schema.String,
  eager: Schema.String,
  lazy: Schema.String,
});
const Measurement = Schema.Struct({
  operation: Schema.String,
  strategy: Schema.Literals(["lazy", "fallback", "unopened"]),
  fallbackReason: Schema.optional(Schema.String),
  fetchedWholeFile: Schema.Boolean,
  bytesRead: Schema.Int,
  rounds: Schema.Int,
  latencyMs: Schema.Finite,
});
const Row = Schema.Struct({
  fingerprint: Schema.String,
  file: Schema.String,
  size: Schema.Int,
  mtimeMs: Schema.Finite,
  issues: Schema.Array(Issue),
  measurements: Schema.Array(Measurement),
});
type Row = typeof Row.Type;
const decodeRow = Schema.decodeUnknownOption(Schema.fromJsonString(Row));
const textModes: ReadonlyArray<PdfCoreTextOptions> = [
  { format: "markdown", dropRunningHeaders: true },
  { format: "markdown", dropRunningHeaders: false },
  { format: "text", dropRunningHeaders: true },
  { format: "text", dropRunningHeaders: false },
];

const errorCode = (cause: Cause.Cause<PdfCoreError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: ({ code }) => code,
    onNone: () => `defect: ${Cause.pretty(cause)}`,
  });

const run = Effect.gen(function* () {
  const files = yield* FileSystem.FileSystem;
  const module = yield* Effect.promise(() => WebAssembly.compile(wasm));
  const core = yield* makePdfCore(module);
  const input = yield* Effect.promise(() => Bun.stdin.text());
  const work = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(Schema.String)),
  )(input);
  for (const file of work) {
    const row = yield* Effect.scoped(
      Effect.gen(function* () {
        const { size, mtimeMs } = statSync(file);
        const bytes = yield* files.readFile(file);
        const source = yield* pdfCoreFileSource(file);
        const issues: Array<typeof Issue.Type> = [];
        const measurements: Array<typeof Measurement.Type> = [];
        const compare = <A>(
          api: Api,
          operation: string,
          eager: Exit.Exit<A, PdfCoreError>,
          lazy: Exit.Exit<A, PdfCoreError>,
        ) => {
          if (Exit.isSuccess(eager) && Exit.isSuccess(lazy)) {
            if (!isDeepStrictEqual(lazy.value, eager.value)) {
              issues.push({ api, operation, eager: "different output", lazy: "different output" });
            }
            return;
          }
          const left = Exit.isSuccess(eager) ? "ok" : errorCode(eager.cause);
          const right = Exit.isSuccess(lazy) ? "ok" : errorCode(lazy.cause);
          if (left !== right || left.startsWith("defect:") || right.startsWith("defect:")) {
            issues.push({ api, operation, eager: left, lazy: right });
          }
        };
        const session = <A>(
          operation: string,
          api: Api,
          eager: Exit.Exit<A, PdfCoreError>,
          runLazy: (
            doc: Effect.Success<ReturnType<typeof core.openLazy>>,
          ) => Effect.Effect<A, PdfCoreError>,
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              const start = performance.now();
              const opened = yield* Effect.exit(core.openLazy(source));
              if (Exit.isFailure(opened)) {
                compare(api, operation, eager, opened);
                measurements.push({
                  operation,
                  strategy: "unopened",
                  fetchedWholeFile: false,
                  bytesRead: 0,
                  rounds: 0,
                  latencyMs: performance.now() - start,
                });
                return;
              }
              const doc = opened.value;
              const lazy = yield* Effect.exit(runLazy(doc));
              const stats = yield* doc.stats;
              measurements.push({
                operation,
                latencyMs: performance.now() - start,
                ...stats,
                fetchedWholeFile: stats.strategy === "fallback",
              });
              compare(api, operation, eager, lazy);
            }),
          );

        const info = yield* Effect.exit(core.info(bytes));
        const inspectAllOptions = { text: true, links: true, runs: true };
        const inspectAll = yield* Effect.exit(core.inspect(bytes, inspectAllOptions));
        yield* session("info", "info", info, (doc) => doc.info);
        const count = Exit.isSuccess(inspectAll)
          ? inspectAll.value.pages.length
          : Exit.isSuccess(info)
            ? info.value.pageCount
            : 0;
        const seed = createHash("sha256").update(file).digest().readUInt32LE(0);
        const selections = [
          { name: "page1", pageIndexes: [0] },
          { name: "page2", pageIndexes: [1] },
          { name: "last", pageIndexes: [Math.max(0, count - 1)] },
          { name: "random", pageIndexes: [seed % Math.max(1, count)] },
          { name: "all" },
        ];
        for (const mode of textModes) {
          const sequence = [];
          const eagerByPages = new Map<string, Exit.Exit<ReadonlyArray<string>, PdfCoreError>>();
          for (const selection of selections) {
            const { name, ...pages } = selection;
            const options = { ...pages, ...mode };
            const operation = `text/${mode.format}/${mode.dropRunningHeaders}/${name}`;
            const key = JSON.stringify(pages);
            const eager = eagerByPages.get(key) ?? (yield* Effect.exit(core.text(bytes, options)));
            eagerByPages.set(key, eager);
            yield* session(operation, "text", eager, (doc) => doc.text(options));
            if (name !== "random") {
              sequence.push({ operation: `${operation}/sequence`, options, eager });
            }
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              const opened = yield* Effect.exit(core.openLazy(source));
              let fetched = false;
              for (const { operation, options, eager } of sequence) {
                const start = performance.now();
                if (Exit.isFailure(opened)) {
                  compare("text", operation, eager, opened);
                  measurements.push({
                    operation,
                    strategy: "unopened",
                    fetchedWholeFile: false,
                    bytesRead: 0,
                    rounds: 0,
                    latencyMs: performance.now() - start,
                  });
                  continue;
                }
                const doc = opened.value;
                const lazy = yield* Effect.exit(doc.text(options));
                const stats = yield* doc.stats;
                measurements.push({
                  operation,
                  latencyMs: performance.now() - start,
                  ...stats,
                  fetchedWholeFile: !fetched && stats.strategy === "fallback",
                });
                fetched ||= stats.strategy === "fallback";
                compare("text", operation, eager, lazy);
              }
            }),
          );
        }

        const page1 = { pageIndexes: [0] };
        const inspectFirstOptions = { ...inspectAllOptions, ...page1 };
        yield* session(
          "inspect/page1",
          "inspect",
          yield* Effect.exit(core.inspect(bytes, inspectFirstOptions)),
          (doc) => doc.inspect(inspectFirstOptions),
        );
        yield* session("inspect/all", "inspect", inspectAll, (doc) =>
          doc.inspect(inspectAllOptions),
        );
        yield* session(
          "tables/page1",
          "tables",
          yield* Effect.exit(core.tables(bytes, page1)),
          (doc) => doc.tables(page1),
        );
        yield* session(
          "headings/page1",
          "headings",
          yield* Effect.exit(core.headings(bytes, page1)),
          (doc) => doc.headings(page1),
        );
        const render = { ...page1, scale: 0.25 };
        yield* session(
          "renderPages/page1",
          "renderPages",
          yield* Effect.exit(core.renderPages(bytes, render)),
          (doc) => doc.renderPages(render),
        );
        return { fingerprint, file, size, mtimeMs, issues, measurements } satisfies Row;
      }),
    );
    appendFileSync(output, `\n${JSON.stringify(row)}\n`);
  }
});

const readRows = () => {
  const rows = new Map<string, Row>();
  if (existsSync(output)) {
    for (const line of readFileSync(output, "utf8").split("\n")) {
      if (line === "") {
        continue;
      }
      const parsed = decodeRow(line);
      if (Option.isSome(parsed) && parsed.value.fingerprint === fingerprint) {
        rows.set(parsed.value.file, parsed.value);
      }
    }
  }
  return rows;
};

const percentile = (values: ReadonlyArray<number>, p: number) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? null;

const summarize = (rows: ReadonlyArray<Row>) => {
  const mismatchByApi: Record<Api, number> = {
    text: 0,
    inspect: 0,
    tables: 0,
    info: 0,
    headings: 0,
    renderPages: 0,
  };
  const fallbackCauses = new Map<string, number>();
  const fallbackFetchesByOperation: Record<string, Record<string, number>> = {};
  let operations = 0;
  let differences = 0;
  let fallbackFetches = 0;
  const ratios = [];
  const latencies = [];
  let page1Fallbacks = 0;
  let fallbackFiles = 0;
  let lazyOnlyFailures = 0;
  let lazyOnlyFailureFiles = 0;
  let mismatchedFiles = 0;
  for (const row of rows) {
    operations += row.measurements.length;
    differences += row.issues.length;
    mismatchedFiles += Number(row.issues.length > 0);
    const lazyFailures = row.issues.filter(({ eager, lazy }) => eager === "ok" && lazy !== "ok");
    lazyOnlyFailures += lazyFailures.length;
    lazyOnlyFailureFiles += Number(lazyFailures.length > 0);
    for (const { api } of row.issues) {
      mismatchByApi[api] += 1;
    }
    const reasons = new Set<string>();
    for (const { fetchedWholeFile, operation, fallbackReason } of row.measurements) {
      if (fetchedWholeFile) {
        const reason = fallbackReason ?? "unreported";
        reasons.add(reason);
        fallbackFetches += 1;
        const counts = (fallbackFetchesByOperation[operation] ??= {});
        counts[reason] = (counts[reason] ?? 0) + 1;
      }
    }
    fallbackFiles += Number(reasons.size > 0);
    for (const reason of reasons) {
      fallbackCauses.set(reason, (fallbackCauses.get(reason) ?? 0) + 1);
    }
    const page1 = row.measurements.find(
      ({ operation }) => operation === "text/markdown/true/page1",
    );
    if (page1 !== undefined && page1.strategy !== "unopened" && row.size > 0) {
      ratios.push(page1.bytesRead / row.size);
      latencies.push(page1.latencyMs);
      page1Fallbacks += Number(page1.strategy === "fallback");
    }
  }
  return {
    completed: rows.length,
    operations,
    differences,
    mismatchedFiles,
    mismatchByApi,
    lazyOnlyFailures,
    lazyOnlyFailureFiles,
    fallbackFiles,
    fallbackFetches,
    fallbackFetchesByOperation,
    fallbackRate: fallbackFiles / rows.length,
    fallbackCauses: Object.fromEntries(fallbackCauses),
    page1: {
      measured: ratios.length,
      fallbackFiles: page1Fallbacks,
      fallbackRate: page1Fallbacks / ratios.length,
      bytesReadRatio: { p50: percentile(ratios, 0.5), p90: percentile(ratios, 0.9) },
      latencyMs: { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9) },
    },
  };
};

const main = Effect.gen(function* () {
  const workers = Number(args.workers);
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 16) {
    return yield* Effect.die("--workers must be an integer between 1 and 16.");
  }
  mkdirSync(dirname(output), { recursive: true });
  const files = [
    ...new Set(
      (paths.length === 0 ? defaults : paths).flatMap((path) => {
        const absolute = resolve(path);
        return statSync(absolute).isFile()
          ? [absolute]
          : readdirSync(absolute, { withFileTypes: true, recursive: true })
              .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
              .map((entry) => join(entry.parentPath, entry.name));
      }),
    ),
  ].sort();
  if (files.length === 0) {
    return yield* Effect.die("No PDFs found.");
  }
  const previous = readRows();
  const current = (row: Row | undefined, file: string) => {
    const stat = statSync(file);
    return row?.size === stat.size && row.mtimeMs === stat.mtimeMs;
  };
  const pending = files.filter((file) => !current(previous.get(file), file));
  console.error(`${files.length} PDFs, ${pending.length} pending, ${workers} workers, ${output}`);
  const batches = Array.from(
    { length: Math.min(workers, pending.length) },
    () => new Array<string>(),
  );
  const sized = pending.map((file) => ({ file, size: statSync(file).size }));
  sized.sort((left, right) => right.size - left.size);
  for (const [index, { file }] of sized.entries()) {
    batches[index % batches.length]?.push(file);
  }
  const exits = yield* Effect.forEach(
    batches,
    (batch) =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          Bun.spawn(
            [
              process.execPath,
              import.meta.path,
              "--worker",
              "--out",
              output,
              "--wasm",
              resolve(args.wasm),
            ],
            { stdin: new Blob([JSON.stringify(batch)]), stdout: "inherit", stderr: "inherit" },
          ),
        ),
        (worker) => Effect.promise(() => worker.exited),
        (worker) =>
          Effect.sync(() => {
            if (worker.exitCode === null) {
              worker.kill();
            }
          }),
      ),
    { concurrency: workers },
  );
  const rows = readRows();
  const complete = files.flatMap((file) => {
    const row = rows.get(file);
    return row !== undefined && current(row, file) ? [row] : [];
  });
  const summary = summarize(complete);
  console.log(JSON.stringify({ expected: files.length, workerExits: exits, ...summary }, null, 2));
  if (
    summary.mismatchedFiles > 0 ||
    complete.length !== files.length ||
    exits.some((code) => code !== 0)
  ) {
    process.exitCode = 1;
  }
});

if (args.worker === true) {
  await Effect.runPromise(run.pipe(Effect.provide(NodeServices.layer)));
} else {
  await Effect.runPromise(main);
}
