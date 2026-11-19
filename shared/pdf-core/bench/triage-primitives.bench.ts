#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

import { Cause, Effect, Exit, Result, Schema } from "effect";

import {
  PdfCoreError,
  PdfCoreErrorCodeValue,
  PdfCoreOperationValue,
  PdfCoreTextOptionsSchema,
} from "../dist/config.js";
import type { PdfCoreInspectOptions, PdfCoreTextOptions } from "../dist/config.js";
import { makePdfCore } from "../dist/pdf-core.js";
import type { PdfCoreLazyDocument, PdfCoreRangeSource, PdfCoreService } from "../dist/pdf-core.js";

const BENCH_ROOT = "/home/yorizel/Documents/bench-parsers";
const DEFAULT_CORPUS = `${BENCH_ROOT}/pncp-triage/pdfs`;
const FAILURE_BASENAME_LIMIT = 20;
const PAGE_ONE = {
  pageIndexes: [0],
  format: "markdown",
} satisfies PdfCoreTextOptions;
const PAGE_TWO = {
  pageIndexes: [1],
  format: "markdown",
} satisfies PdfCoreTextOptions;
const INSPECT_PAGE_ONE = {
  text: true,
  links: false,
  pageIndexes: [0],
} satisfies PdfCoreInspectOptions;
const HEADING_OPTIONS = { pageIndexes: [0] };
const wasmFile = fileURLToPath(new URL("../dist/pdf-core.wasm", import.meta.url));

class BenchFailure extends Schema.TaggedError<BenchFailure, { readonly brand: unique symbol }>()(
  "BenchFailure",
  {
    reason: Schema.String,
  },
) {}

const WorkloadIdSchema = Schema.Literals([
  "text-eager-page1",
  "text-lazy-page1",
  "text-lazy-escalate",
  "inspect-lazy-page1",
  "info-eager",
  "info-lazy",
  "headings-page1",
  "text-bounded-4000",
]);
type WorkloadId = (typeof WorkloadIdSchema)["Type"];

const workloadOrder: ReadonlyArray<WorkloadId> = [
  "text-eager-page1",
  "text-lazy-page1",
  "text-lazy-escalate",
  "inspect-lazy-page1",
  "info-eager",
  "info-lazy",
  "headings-page1",
  "text-bounded-4000",
];

const DistributionSchema = Schema.Struct({
  p50: Schema.Finite,
  p90: Schema.Finite,
  p99: Schema.Finite,
  mean: Schema.Finite,
});
type Distribution = (typeof DistributionSchema)["Type"];

const MeasuredSchema = Schema.Struct({
  p50: Schema.Finite,
  p90: Schema.Finite,
  p99: Schema.Finite,
  mean: Schema.Finite,
  total: Schema.Finite,
});
type Measured = (typeof MeasuredSchema)["Type"];

const WasmMemorySchema = Schema.Struct({
  max: Schema.Finite,
  p90: Schema.Finite,
});
type WasmMemory = (typeof WasmMemorySchema)["Type"];

const WorkloadReportSchema = Schema.Struct({
  id: WorkloadIdSchema,
  status: Schema.Literals(["ok", "n/a"]),
  access: Schema.Literals(["eager", "lazy", "n/a"]),
  reason: Schema.NullOr(Schema.String),
  documents: Schema.Finite,
  successes: Schema.Finite,
  failures: Schema.Finite,
  failuresByCode: Schema.Record(Schema.String, Schema.Finite),
  failureReasons: Schema.Record(Schema.String, Schema.Finite),
  failureBasenames: Schema.Array(Schema.String),
  failureBasenamesTruncated: Schema.Boolean,
  latencyMs: Schema.NullOr(DistributionSchema),
  throughputDocsPerSec: Schema.NullOr(Schema.Finite),
  bytesRead: Schema.NullOr(MeasuredSchema),
  rangeRequests: Schema.NullOr(MeasuredSchema),
  wasmMemoryBytes: Schema.NullOr(WasmMemorySchema),
  elapsedMs: Schema.Finite,
});
type WorkloadReport = (typeof WorkloadReportSchema)["Type"];

const WasmSizeSchema = Schema.Struct({
  raw: Schema.Int,
  gzip: Schema.Int,
  brotli: Schema.Int,
});
type WasmSize = (typeof WasmSizeSchema)["Type"];

const ReportSchema = Schema.Struct({
  version: Schema.Literals([1]),
  commit: Schema.String,
  sample: Schema.Literals(["fisher-yates-mulberry32-then-path-sort"]),
  seed: Schema.Int,
  requested: Schema.Int,
  sampleCount: Schema.Int,
  corpusCount: Schema.Int,
  sampleKey: Schema.String,
  sampleBasenames: Schema.Array(Schema.String),
  corpora: Schema.Array(Schema.String),
  runs: Schema.Int,
  worker: Schema.Literals(["single"]),
  bun: Schema.NullOr(Schema.String),
  wasm: WasmSizeSchema,
  workloads: Schema.Array(WorkloadReportSchema),
  runDetails: Schema.Array(Schema.Array(WorkloadReportSchema)),
});
type Report = (typeof ReportSchema)["Type"];

type EffectMethod = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;

const isEffectMethod = (value: unknown): value is EffectMethod => typeof value === "function";

const MethodSchema = Schema.declare(isEffectMethod, { identifier: "TriageEffectMethod" });

const ServiceProbeSchema = Schema.Struct({
  info: Schema.optional(MethodSchema),
  headings: Schema.optional(MethodSchema),
});
type ServiceProbe = (typeof ServiceProbeSchema)["Type"];

const LazyProbeSchema = Schema.Struct({
  inspect: Schema.optional(MethodSchema),
  info: Schema.optional(MethodSchema),
  headings: Schema.optional(MethodSchema),
});
type LazyProbe = (typeof LazyProbeSchema)["Type"];

type SampleFile = {
  readonly path: string;
  readonly basename: string;
};

type Attempt = {
  readonly ok: boolean;
  readonly code: string | null;
  readonly reason: string | null;
  readonly basename: string;
  readonly latencyMs: number;
  readonly bytesRead: number | null;
  readonly rangeRequests: number | null;
  readonly wasmBytes: number;
};

type Features = {
  readonly service: ServiceProbe;
  readonly lazy: LazyProbe;
  readonly bounded: PdfCoreTextOptions | undefined;
};

type Cli = {
  readonly compare: readonly [string, string] | undefined;
  readonly out: string | undefined;
  readonly n: number;
  readonly runs: number;
  readonly seed: number;
  readonly corpora: readonly string[];
  readonly help: boolean;
};

const usage = `bun shared/pdf-core/bench/triage-primitives.bench.ts --out report.json [--n 400] [--runs 3] [--seed 1] [--corpus DIR]
bun shared/pdf-core/bench/triage-primitives.bench.ts --compare baseline.json candidate.json`;

const parseInteger = (value: string): number | undefined => {
  if (!/^[0-9]+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const parseCli = (argv: ReadonlyArray<string>): Cli | BenchFailure => {
  let compare: readonly [string, string] | undefined;
  let out: string | undefined;
  let n = 400;
  let runs = 3;
  let seed = 1;
  const corpora: Array<string> = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      help = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--compare") {
      const right = argv[index + 2];
      if (
        value === undefined ||
        right === undefined ||
        value.startsWith("--") ||
        right.startsWith("--")
      ) {
        return new BenchFailure({ reason: usage });
      }
      compare = [value, right];
      index += 2;
      continue;
    }
    if (flag === "--corpus") {
      if (value === undefined || value.startsWith("--")) {
        return new BenchFailure({ reason: usage });
      }
      corpora.push(value.endsWith("/") ? value.slice(0, -1) : value);
      index += 1;
      continue;
    }
    if (flag === "--out") {
      if (value === undefined || value.startsWith("--")) {
        return new BenchFailure({ reason: usage });
      }
      out = value;
      index += 1;
      continue;
    }
    if (flag === "--n" || flag === "--runs" || flag === "--seed") {
      if (value === undefined) {
        return new BenchFailure({ reason: usage });
      }
      const parsed = parseInteger(value);
      if (parsed === undefined) {
        return new BenchFailure({ reason: `${flag} expects a non-negative integer.` });
      }
      if (flag === "--n") {
        n = parsed;
      } else if (flag === "--runs") {
        runs = parsed;
      } else {
        seed = parsed;
      }
      index += 1;
      continue;
    }
    return new BenchFailure({ reason: usage });
  }
  if (!help && compare === undefined && out === undefined) {
    return new BenchFailure({ reason: usage });
  }
  if (n < 1 || runs < 1) {
    return new BenchFailure({ reason: "--n and --runs must be at least 1." });
  }
  return {
    compare,
    out,
    n,
    runs,
    seed,
    corpora: corpora.length === 0 ? [DEFAULT_CORPUS] : corpora,
    help,
  };
};

const quantile = (values: ReadonlyArray<number>, ratio: number): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? null;
};

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? null;
  }
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (left === undefined || right === undefined) {
    return null;
  }
  return (left + right) / 2;
};

const medianNumber = (values: ReadonlyArray<number>): number => median(values) ?? 0;

const distribution = (values: ReadonlyArray<number>): Distribution | null => {
  const p50 = quantile(values, 0.5);
  const p90 = quantile(values, 0.9);
  const p99 = quantile(values, 0.99);
  if (p50 === null || p90 === null || p99 === null) {
    return null;
  }
  return {
    p50,
    p90,
    p99,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
};

const measured = (values: ReadonlyArray<number>): Measured | null => {
  const stats = distribution(values);
  if (stats === null) {
    return null;
  }
  return { ...stats, total: values.reduce((sum, value) => sum + value, 0) };
};

const wasmMemory = (values: ReadonlyArray<number>): WasmMemory | null => {
  const p90 = quantile(values, 0.9);
  if (p90 === null) {
    return null;
  }
  return { max: Math.max(...values), p90 };
};

const present = (rows: ReadonlyArray<Distribution | null>): ReadonlyArray<Distribution> =>
  rows.flatMap((row) => (row === null ? [] : [row]));

const medianDistribution = (rows: ReadonlyArray<Distribution | null>): Distribution | null => {
  const values = present(rows);
  const p50 = median(values.map((row) => row.p50));
  const p90 = median(values.map((row) => row.p90));
  const p99 = median(values.map((row) => row.p99));
  const mean = median(values.map((row) => row.mean));
  if (p50 === null || p90 === null || p99 === null || mean === null) {
    return null;
  }
  return { p50, p90, p99, mean };
};

const medianMeasured = (rows: ReadonlyArray<Measured | null>): Measured | null => {
  const stats = medianDistribution(rows);
  const total = median(rows.flatMap((row) => (row === null ? [] : [row.total])));
  if (stats === null || total === null) {
    return null;
  }
  return { ...stats, total };
};

const medianWasm = (rows: ReadonlyArray<WasmMemory | null>): WasmMemory | null => {
  const max = median(rows.flatMap((row) => (row === null ? [] : [row.max])));
  const p90 = median(rows.flatMap((row) => (row === null ? [] : [row.p90])));
  if (max === null || p90 === null) {
    return null;
  }
  return { max, p90 };
};

const medianRecord = (
  maps: ReadonlyArray<Readonly<Record<string, number>>>,
): Record<string, number> => {
  const keys = [...new Set(maps.flatMap((map) => Object.keys(map)))].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  const result: Record<string, number> = {};
  for (const key of keys) {
    const value = median(maps.map((map) => map[key] ?? 0));
    if (value !== null && value > 0) {
      result[key] = value;
    }
  }
  return result;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const samplePaths = (paths: ReadonlyArray<string>, count: number, seed: number): Array<string> => {
  const copy = [...paths];
  const random = mulberry32(seed);
  const limit = Math.min(count, copy.length);
  for (let index = 0; index < limit; index += 1) {
    const swap = index + Math.floor(random() * (copy.length - index));
    const current = copy[index];
    const next = copy[swap];
    if (current === undefined || next === undefined) {
      continue;
    }
    copy[index] = next;
    copy[swap] = current;
  }
  return copy.slice(0, limit).sort((left, right) => left.localeCompare(right, "en"));
};

const corpusLabel = (root: string): string => {
  const prefix = `${BENCH_ROOT}/`;
  return root.startsWith(prefix) ? root.slice(prefix.length) : basename(root);
};

const listPdfs = (root: string): Effect.Effect<ReadonlyArray<string>, BenchFailure> =>
  Effect.try({
    try: () =>
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
        .map((entry) => join(entry.parentPath, entry.name))
        .sort((left, right) => left.localeCompare(right, "en")),
    catch: () => new BenchFailure({ reason: `Could not read corpus ${corpusLabel(root)}.` }),
  });

const readExact = (
  fd: number,
  offset: number,
  length: number,
): Effect.Effect<Uint8Array, PdfCoreError> =>
  Effect.try({
    try: () => {
      const bytes = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const bytesRead = readSync(fd, bytes, total, length - total, offset + total);
        if (bytesRead === 0) {
          break;
        }
        total += bytesRead;
      }
      return total === length ? bytes : bytes.subarray(0, total);
    },
    catch: () =>
      new PdfCoreError({
        code: PdfCoreErrorCodeValue.rangeReadFailed,
        operation: PdfCoreOperationValue.readRange,
        reason: `The PDF source could not read ${length} bytes at offset ${offset}.`,
      }),
  });

const withSource = <A, E>(
  path: string,
  use: (source: PdfCoreRangeSource, size: number) => Effect.Effect<A, E>,
): Effect.Effect<A, BenchFailure | E> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => openSync(path, "r"),
      catch: () => new BenchFailure({ reason: `Could not open ${basename(path)}.` }),
    }),
    (fd) => Effect.sync(() => closeSync(fd)),
  ).pipe(
    Effect.flatMap((fd) =>
      Effect.try({
        try: () => fstatSync(fd).size,
        catch: () => new BenchFailure({ reason: `Could not stat ${basename(path)}.` }),
      }).pipe(
        Effect.flatMap((size) =>
          use({ size, read: (offset, length) => readExact(fd, offset, length) }, size),
        ),
      ),
    ),
    Effect.scoped,
  );

const readAll = (path: string): Effect.Effect<Uint8Array, BenchFailure> =>
  Effect.try({
    try: () => readFileSync(path),
    catch: () => new BenchFailure({ reason: `Could not read ${basename(path)}.` }),
  });

const decodeService = (core: PdfCoreService): Effect.Effect<ServiceProbe, BenchFailure> =>
  Schema.decodeUnknownEffect(ServiceProbeSchema)(core).pipe(
    Effect.mapError(
      () => new BenchFailure({ reason: "Could not feature-detect service methods." }),
    ),
  );

const decodeLazy = (document: object): Effect.Effect<LazyProbe, BenchFailure> =>
  Schema.decodeUnknownEffect(LazyProbeSchema)(document).pipe(
    Effect.mapError(
      () => new BenchFailure({ reason: "Could not feature-detect lazy document methods." }),
    ),
  );

const boundedOptions = (): Effect.Effect<PdfCoreTextOptions | undefined> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.result(
      Schema.decodeUnknownEffect(PdfCoreTextOptionsSchema)({
        pageIndexes: [0],
        format: "markdown",
        maxChars: 4000,
      }),
    );
    if (Result.isFailure(decoded)) {
      return undefined;
    }
    const probe = yield* Effect.result(
      Schema.decodeUnknownEffect(Schema.Struct({ maxChars: Schema.optional(Schema.Finite) }))(
        decoded.success,
      ),
    );
    if (Result.isFailure(probe) || probe.success.maxChars !== 4000) {
      return undefined;
    }
    return decoded.success;
  });

const reasonText = (value: unknown): { readonly code: string; readonly reason: string } => {
  if (Schema.is(PdfCoreError)(value)) {
    return { code: value.code, reason: (value.reason ?? value.code).slice(0, 160) };
  }
  if (Schema.is(BenchFailure)(value)) {
    return { code: "bench", reason: value.reason.slice(0, 160) };
  }
  return { code: "defect", reason: "defect" };
};

const fromExit = (
  file: SampleFile,
  latencyMs: number,
  wasmBytes: number,
  exit: Exit.Exit<unknown, unknown>,
  bytesRead: number | null,
  rangeRequests: number | null,
): Attempt => {
  if (Exit.isSuccess(exit)) {
    return {
      ok: true,
      code: null,
      reason: null,
      basename: file.basename,
      latencyMs,
      bytesRead,
      rangeRequests,
      wasmBytes,
    };
  }
  const classified = reasonText(Cause.squash(exit.cause));
  return {
    ok: false,
    code: classified.code,
    reason: classified.reason,
    basename: file.basename,
    latencyMs,
    bytesRead,
    rangeRequests,
    wasmBytes,
  };
};

const measureEager = (
  core: PdfCoreService,
  file: SampleFile,
  call: (bytes: Uint8Array) => Effect.Effect<unknown, unknown>,
): Effect.Effect<Attempt> =>
  Effect.gen(function* () {
    const started = performance.now();
    const loaded = yield* Effect.exit(readAll(file.path));
    if (Exit.isFailure(loaded)) {
      return fromExit(
        file,
        performance.now() - started,
        yield* core.wasmMemoryBytes(),
        loaded,
        null,
        null,
      );
    }
    const outcome = yield* Effect.exit(call(loaded.value));
    return fromExit(
      file,
      performance.now() - started,
      yield* core.wasmMemoryBytes(),
      outcome,
      loaded.value.byteLength,
      null,
    );
  });

const measureLazy = (
  core: PdfCoreService,
  file: SampleFile,
  call: (document: PdfCoreLazyDocument) => Effect.Effect<Exit.Exit<unknown, unknown>, unknown>,
): Effect.Effect<Attempt, BenchFailure | PdfCoreError> =>
  Effect.gen(function* () {
    const started = performance.now();
    return yield* withSource(file.path, (source) =>
      Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* Effect.exit(core.openLazy(source));
          if (Exit.isFailure(opened)) {
            return fromExit(
              file,
              performance.now() - started,
              yield* core.wasmMemoryBytes(),
              opened,
              null,
              null,
            );
          }
          const called = yield* Effect.exit(call(opened.value));
          const stats = yield* Effect.exit(opened.value.stats);
          const bytesRead = Exit.isSuccess(stats) ? stats.value.bytesRead : null;
          const rangeRequests = Exit.isSuccess(stats) ? stats.value.rounds : null;
          const wasmBytes = yield* core.wasmMemoryBytes();
          const latencyMs = performance.now() - started;
          if (Exit.isFailure(called)) {
            return fromExit(file, latencyMs, wasmBytes, called, bytesRead, rangeRequests);
          }
          return fromExit(file, latencyMs, wasmBytes, called.value, bytesRead, rangeRequests);
        }),
      ),
    );
  });

const lazyMethod = (
  document: object,
  name: "inspect" | "info" | "headings",
): Effect.Effect<EffectMethod, BenchFailure> =>
  decodeLazy(document).pipe(
    Effect.flatMap((methods) => {
      const method = methods[name];
      if (method === undefined) {
        return Effect.fail(new BenchFailure({ reason: `Lazy document has no ${name}.` }));
      }
      return Effect.succeed(method);
    }),
  );

const countMap = (
  attempts: ReadonlyArray<Attempt>,
  select: (attempt: Attempt) => string | null,
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const attempt of attempts) {
    const key = select(attempt);
    if (key === null) {
      continue;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

const failureNames = (
  attempts: ReadonlyArray<Attempt>,
): { readonly names: ReadonlyArray<string>; readonly truncated: boolean } => {
  const names = [
    ...new Set(attempts.flatMap((attempt) => (attempt.ok ? [] : [attempt.basename]))),
  ].sort((left, right) => left.localeCompare(right, "en"));
  return {
    names: names.slice(0, FAILURE_BASENAME_LIMIT),
    truncated: names.length > FAILURE_BASENAME_LIMIT,
  };
};

const summarize = (
  id: WorkloadId,
  access: WorkloadReport["access"],
  attempts: ReadonlyArray<Attempt>,
  elapsedMs: number,
): WorkloadReport => {
  const successes = attempts.flatMap((attempt) => (attempt.ok ? [attempt] : []));
  const names = failureNames(attempts);
  const seconds = elapsedMs / 1000;
  return {
    id,
    status: "ok",
    access,
    reason: null,
    documents: attempts.length,
    successes: successes.length,
    failures: attempts.length - successes.length,
    failuresByCode: countMap(attempts, (attempt) => attempt.code),
    failureReasons: countMap(attempts, (attempt) => (attempt.ok ? null : attempt.reason)),
    failureBasenames: names.names,
    failureBasenamesTruncated: names.truncated,
    latencyMs: distribution(successes.map((attempt) => attempt.latencyMs)),
    throughputDocsPerSec: seconds === 0 ? null : attempts.length / seconds,
    bytesRead: measured(
      attempts.flatMap((attempt) => (attempt.bytesRead === null ? [] : [attempt.bytesRead])),
    ),
    rangeRequests: measured(
      attempts.flatMap((attempt) =>
        attempt.rangeRequests === null ? [] : [attempt.rangeRequests],
      ),
    ),
    wasmMemoryBytes: wasmMemory(attempts.map((attempt) => attempt.wasmBytes)),
    elapsedMs,
  };
};

const unavailable = (id: WorkloadId, reason: string): WorkloadReport => ({
  id,
  status: "n/a",
  access: "n/a",
  reason,
  documents: 0,
  successes: 0,
  failures: 0,
  failuresByCode: {},
  failureReasons: {},
  failureBasenames: [],
  failureBasenamesTruncated: false,
  latencyMs: null,
  throughputDocsPerSec: null,
  bytesRead: null,
  rangeRequests: null,
  wasmMemoryBytes: null,
  elapsedMs: 0,
});

const skipReason = (id: WorkloadId, features: Features): string | undefined => {
  switch (id) {
    case "text-eager-page1":
    case "text-lazy-page1":
    case "text-lazy-escalate":
      return undefined;
    case "inspect-lazy-page1":
      return features.lazy.inspect === undefined
        ? "Lazy document has no inspect method."
        : undefined;
    case "info-eager":
      return features.service.info === undefined ? "Service has no info method." : undefined;
    case "info-lazy":
      return features.lazy.info === undefined ? "Lazy document has no info method." : undefined;
    case "headings-page1":
      return features.service.headings === undefined && features.lazy.headings === undefined
        ? "Neither the service nor the lazy document has headings."
        : undefined;
    case "text-bounded-4000":
      return features.bounded === undefined
        ? "PdfCoreTextOptionsSchema does not keep maxChars: 4000."
        : undefined;
  }
};

const measureAll = (
  id: WorkloadId,
  files: ReadonlyArray<SampleFile>,
  access: WorkloadReport["access"],
  one: (file: SampleFile) => Effect.Effect<Attempt, BenchFailure | PdfCoreError>,
): Effect.Effect<WorkloadReport, BenchFailure | PdfCoreError> =>
  Effect.gen(function* () {
    const started = performance.now();
    const attempts = yield* Effect.forEach(files, (file, index) => {
      if (index % 50 === 0) {
        console.error(`${id} ${index + 1}/${files.length}`);
      }
      return one(file);
    });
    return summarize(id, access, attempts, performance.now() - started);
  });

const runWorkload = (
  id: WorkloadId,
  core: PdfCoreService,
  files: ReadonlyArray<SampleFile>,
  features: Features,
): Effect.Effect<WorkloadReport, BenchFailure | PdfCoreError> =>
  Effect.gen(function* () {
    const skipped = skipReason(id, features);
    if (skipped !== undefined) {
      return unavailable(id, skipped);
    }
    switch (id) {
      case "text-eager-page1":
        return yield* measureAll(id, files, "eager", (file) =>
          measureEager(core, file, (bytes) => core.text(bytes, PAGE_ONE)),
        );
      case "text-lazy-page1":
        return yield* measureAll(id, files, "lazy", (file) =>
          measureLazy(core, file, (document) => Effect.exit(document.text(PAGE_ONE))),
        );
      case "text-lazy-escalate":
        return yield* measureAll(id, files, "lazy", (file) =>
          measureLazy(core, file, (document) =>
            Effect.gen(function* () {
              const first = yield* Effect.exit(document.text(PAGE_ONE));
              if (Exit.isFailure(first)) {
                return first;
              }
              return yield* Effect.exit(document.text(PAGE_TWO));
            }),
          ),
        );
      case "inspect-lazy-page1":
        return yield* measureAll(id, files, "lazy", (file) =>
          measureLazy(core, file, (document) =>
            Effect.gen(function* () {
              const method = yield* lazyMethod(document, "inspect");
              return yield* Effect.exit(method(INSPECT_PAGE_ONE));
            }),
          ),
        );
      case "info-eager": {
        const method = yield* decodeService(core).pipe(
          Effect.flatMap((service) => {
            const info = service.info;
            if (info === undefined) {
              return Effect.fail(new BenchFailure({ reason: "Service has no info method." }));
            }
            return Effect.succeed(info);
          }),
        );
        return yield* measureAll(id, files, "eager", (file) =>
          measureEager(core, file, (bytes) => method(bytes)),
        );
      }
      case "info-lazy":
        return yield* measureAll(id, files, "lazy", (file) =>
          measureLazy(core, file, (document) =>
            Effect.gen(function* () {
              const method = yield* lazyMethod(document, "info");
              return yield* Effect.exit(method());
            }),
          ),
        );
      case "headings-page1":
        if (features.service.headings !== undefined) {
          const method = yield* decodeService(core).pipe(
            Effect.flatMap((service) => {
              const headings = service.headings;
              if (headings === undefined) {
                return Effect.fail(new BenchFailure({ reason: "Service has no headings method." }));
              }
              return Effect.succeed(headings);
            }),
          );
          return yield* measureAll(id, files, "eager", (file) =>
            measureEager(core, file, (bytes) => method(bytes, HEADING_OPTIONS)),
          );
        }
        return yield* measureAll(id, files, "lazy", (file) =>
          measureLazy(core, file, (document) =>
            Effect.gen(function* () {
              const method = yield* lazyMethod(document, "headings");
              return yield* Effect.exit(method(HEADING_OPTIONS));
            }),
          ),
        );
      case "text-bounded-4000": {
        const options = features.bounded;
        if (options === undefined) {
          return unavailable(id, "PdfCoreTextOptionsSchema does not keep maxChars: 4000.");
        }
        return yield* measureAll(id, files, "eager", (file) =>
          measureEager(core, file, (bytes) => core.text(bytes, options)),
        );
      }
    }
  });

const detectFeatures = (
  module: WebAssembly.Module,
  probeFile: SampleFile,
): Effect.Effect<Features, BenchFailure | PdfCoreError> =>
  Effect.gen(function* () {
    const bounded = yield* boundedOptions();
    const core = yield* makePdfCore(module);
    const service = yield* decodeService(core);
    const lazy = yield* withSource(probeFile.path, (source) =>
      Effect.scoped(
        Effect.gen(function* () {
          const document = yield* core.openLazy(source);
          return yield* decodeLazy(document);
        }),
      ),
    );
    return { service, lazy, bounded };
  });

const freshWorkload = (
  module: WebAssembly.Module,
  id: WorkloadId,
  files: ReadonlyArray<SampleFile>,
  features: Features,
): Effect.Effect<WorkloadReport, BenchFailure | PdfCoreError> => {
  const skipped = skipReason(id, features);
  if (skipped !== undefined) {
    console.error(`${id} n/a`);
    return Effect.succeed(unavailable(id, skipped));
  }
  return makePdfCore(module).pipe(Effect.flatMap((core) => runWorkload(id, core, files, features)));
};

const medianReport = (
  rows: ReadonlyArray<WorkloadReport>,
): Effect.Effect<WorkloadReport, BenchFailure> =>
  Effect.gen(function* () {
    const first = rows[0];
    if (first === undefined) {
      return yield* new BenchFailure({ reason: "A workload produced no runs." });
    }
    if (rows.every((row) => row.status === "n/a")) {
      return first;
    }
    const ok = rows.flatMap((row) => (row.status === "ok" ? [row] : []));
    const names = [...new Set(ok.flatMap((row) => [...row.failureBasenames]))].sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    return {
      id: first.id,
      status: "ok",
      access: ok[0]?.access ?? first.access,
      reason: null,
      documents: medianNumber(ok.map((row) => row.documents)),
      successes: medianNumber(ok.map((row) => row.successes)),
      failures: medianNumber(ok.map((row) => row.failures)),
      failuresByCode: medianRecord(ok.map((row) => row.failuresByCode)),
      failureReasons: medianRecord(ok.map((row) => row.failureReasons)),
      failureBasenames: names.slice(0, FAILURE_BASENAME_LIMIT),
      failureBasenamesTruncated:
        names.length > FAILURE_BASENAME_LIMIT || ok.some((row) => row.failureBasenamesTruncated),
      latencyMs: medianDistribution(ok.map((row) => row.latencyMs)),
      throughputDocsPerSec: median(
        ok.flatMap((row) => (row.throughputDocsPerSec === null ? [] : [row.throughputDocsPerSec])),
      ),
      bytesRead: medianMeasured(ok.map((row) => row.bytesRead)),
      rangeRequests: medianMeasured(ok.map((row) => row.rangeRequests)),
      wasmMemoryBytes: medianWasm(ok.map((row) => row.wasmMemoryBytes)),
      elapsedMs: medianNumber(ok.map((row) => row.elapsedMs)),
    };
  });

const fmt = (value: number | null, digits: number): string =>
  value === null ? "n/a" : value.toFixed(digits);

const workloadTable = (rows: ReadonlyArray<WorkloadReport>): string => {
  const header =
    "| workload | status | access | docs | fail | p50 ms | p90 ms | p99 ms | mean ms | docs/s | bytes p50 | rounds p50 | wasm max | wasm p90 |";
  const divider =
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = rows.map(
    (row) =>
      `| ${row.id} | ${row.status} | ${row.access} | ${fmt(row.documents, 0)} | ${fmt(row.failures, 0)} | ${fmt(row.latencyMs?.p50 ?? null, 2)} | ${fmt(row.latencyMs?.p90 ?? null, 2)} | ${fmt(row.latencyMs?.p99 ?? null, 2)} | ${fmt(row.latencyMs?.mean ?? null, 2)} | ${fmt(row.throughputDocsPerSec, 3)} | ${fmt(row.bytesRead?.p50 ?? null, 0)} | ${fmt(row.rangeRequests?.p50 ?? null, 2)} | ${fmt(row.wasmMemoryBytes?.max ?? null, 0)} | ${fmt(row.wasmMemoryBytes?.p90 ?? null, 0)} |`,
  );
  return [header, divider, ...body].join("\n");
};

const failureTable = (rows: ReadonlyArray<WorkloadReport>): string => {
  const lines = rows.flatMap((row) =>
    Object.entries(row.failuresByCode)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([code, count]) => `| ${row.id} | ${code} | ${fmt(count, 0)} |`),
  );
  if (lines.length === 0) {
    return "";
  }
  return ["", "| workload | error code | count |", "| --- | --- | ---: |", ...lines].join("\n");
};

const wasmTable = (wasm: WasmSize): string =>
  [
    "| artifact | raw | gzip -9 | brotli -q 11 |",
    "| --- | ---: | ---: | ---: |",
    `| pdf-core.wasm | ${wasm.raw} | ${wasm.gzip} | ${wasm.brotli} |`,
  ].join("\n");

const reportMarkdown = (report: Report): string =>
  [
    `commit ${report.commit} | sample ${report.sampleCount}/${report.corpusCount} | seed ${report.seed} | runs ${report.runs} median | worker ${report.worker}`,
    "",
    wasmTable(report.wasm),
    "",
    workloadTable(report.workloads),
    failureTable(report.workloads),
    "",
    ...report.workloads.flatMap((row) =>
      row.status === "n/a" && row.reason !== null ? [`n/a ${row.id}: ${row.reason}`] : [],
    ),
  ].join("\n");

const signed = (value: number, digits: number): string => {
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
};

const delta = (next: number | null, previous: number | null, digits: number): string => {
  if (next === null || previous === null) {
    return "n/a";
  }
  const diff = next - previous;
  if (previous === 0) {
    return signed(diff, digits);
  }
  return `${signed(diff, digits)} (${signed((diff / previous) * 100, 1)}%)`;
};

const compareMarkdown = (baseline: Report, candidate: Report): string => {
  const rows = workloadOrder.map((id) => {
    const before = baseline.workloads.find((row) => row.id === id);
    const after = candidate.workloads.find((row) => row.id === id);
    return `| ${id} | ${before?.status ?? "missing"} -> ${after?.status ?? "missing"} | ${delta(after?.latencyMs?.p50 ?? null, before?.latencyMs?.p50 ?? null, 2)} | ${delta(after?.latencyMs?.p90 ?? null, before?.latencyMs?.p90 ?? null, 2)} | ${delta(after?.latencyMs?.p99 ?? null, before?.latencyMs?.p99 ?? null, 2)} | ${delta(after?.latencyMs?.mean ?? null, before?.latencyMs?.mean ?? null, 2)} | ${delta(after?.throughputDocsPerSec ?? null, before?.throughputDocsPerSec ?? null, 3)} | ${delta(after?.bytesRead?.p50 ?? null, before?.bytesRead?.p50 ?? null, 0)} | ${delta(after?.rangeRequests?.p50 ?? null, before?.rangeRequests?.p50 ?? null, 2)} | ${delta(after?.wasmMemoryBytes?.max ?? null, before?.wasmMemoryBytes?.max ?? null, 0)} | ${delta(after?.wasmMemoryBytes?.p90 ?? null, before?.wasmMemoryBytes?.p90 ?? null, 0)} |`;
  });
  return [
    `sample key ${baseline.sampleKey === candidate.sampleKey ? "matches" : "differs"}`,
    `baseline ${baseline.commit} -> candidate ${candidate.commit}`,
    "",
    wasmTable(candidate.wasm),
    `raw ${delta(candidate.wasm.raw, baseline.wasm.raw, 0)} | gzip ${delta(candidate.wasm.gzip, baseline.wasm.gzip, 0)} | brotli ${delta(candidate.wasm.brotli, baseline.wasm.brotli, 0)}`,
    "",
    "| workload | status | p50 ms | p90 ms | p99 ms | mean ms | docs/s | bytes p50 | rounds p50 | wasm max | wasm p90 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
  ].join("\n");
};

const readReport = (path: string): Effect.Effect<Report, BenchFailure> =>
  Effect.try({
    try: () => readFileSync(path, "utf8"),
    catch: () => new BenchFailure({ reason: `Could not read ${basename(path)}.` }),
  }).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(text).pipe(
        Effect.mapError(
          () => new BenchFailure({ reason: `Invalid benchmark report ${basename(path)}.` }),
        ),
      ),
    ),
  );

const compareReports = (paths: readonly [string, string]): Effect.Effect<void, BenchFailure> =>
  Effect.gen(function* () {
    const baseline = yield* readReport(paths[0]);
    const candidate = yield* readReport(paths[1]);
    console.log(compareMarkdown(baseline, candidate));
  });

const loadWasm = (): Effect.Effect<Uint8Array, BenchFailure> =>
  Effect.try({
    try: () => readFileSync(wasmFile),
    catch: () =>
      new BenchFailure({
        reason: "Could not read shared/pdf-core/dist/pdf-core.wasm. Build first.",
      }),
  });

const wasmSize = (bytes: Uint8Array): WasmSize => ({
  raw: bytes.byteLength,
  gzip: gzipSync(bytes, { level: 9 }).byteLength,
  brotli: brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength,
});

const gitCommit = (): Effect.Effect<string, BenchFailure> =>
  Effect.try({
    try: () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    catch: () => new BenchFailure({ reason: "Could not read the git commit." }),
  });

const bunVersion = (): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.result(
      Schema.decodeUnknownEffect(Schema.Struct({ bun: Schema.optional(Schema.String) }))(
        process.versions,
      ),
    );
    if (Result.isFailure(decoded)) {
      return null;
    }
    return decoded.success.bun ?? null;
  });

const benchmark = (cli: Cli): Effect.Effect<void, BenchFailure | PdfCoreError> =>
  Effect.gen(function* () {
    const out = cli.out;
    if (out === undefined) {
      return yield* new BenchFailure({ reason: usage });
    }
    const bytes = yield* loadWasm();
    const module = yield* Effect.tryPromise({
      try: () => WebAssembly.compile(bytes),
      catch: () => new BenchFailure({ reason: "Could not compile pdf-core.wasm." }),
    });
    const listed = yield* Effect.forEach(cli.corpora, listPdfs);
    const all = listed.flat().sort((left, right) => left.localeCompare(right, "en"));
    const chosen = samplePaths(all, cli.n, cli.seed);
    const files = chosen.map((path) => ({ path, basename: basename(path) }));
    const probe = files[0];
    if (probe === undefined) {
      return yield* new BenchFailure({ reason: "No PDFs found in the selected corpora." });
    }
    console.error(
      `sample ${files.length}/${all.length} seed ${cli.seed} runs ${cli.runs} corpora ${cli.corpora.map(corpusLabel).join(", ")}`,
    );
    const features = yield* detectFeatures(module, probe);
    const runDetails = yield* Effect.forEach(
      Array.from({ length: cli.runs }, (_unused, index) => index),
      (run) =>
        Effect.gen(function* () {
          console.error(`run ${run + 1}/${cli.runs}`);
          return yield* Effect.forEach(workloadOrder, (id) =>
            freshWorkload(module, id, files, features),
          );
        }),
    );
    const workloads = yield* Effect.forEach(workloadOrder, (id) =>
      medianReport(runDetails.flatMap((run) => run.filter((row) => row.id === id))),
    );
    const report = yield* Schema.decodeUnknownEffect(ReportSchema)({
      version: 1,
      commit: yield* gitCommit(),
      sample: "fisher-yates-mulberry32-then-path-sort",
      seed: cli.seed,
      requested: cli.n,
      sampleCount: files.length,
      corpusCount: all.length,
      sampleKey: createHash("sha256").update(chosen.join("\n")).digest("hex"),
      sampleBasenames: files.map((file) => file.basename),
      corpora: cli.corpora.map(corpusLabel),
      runs: cli.runs,
      worker: "single",
      bun: yield* bunVersion(),
      wasm: wasmSize(bytes),
      workloads,
      runDetails,
    }).pipe(
      Effect.mapError(
        () => new BenchFailure({ reason: "The benchmark report did not match its schema." }),
      ),
    );
    yield* Effect.sync(() => {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    });
    console.error(`wrote ${out}`);
    console.log(reportMarkdown(report));
  });

const parsed = parseCli(process.argv.slice(2));
if (Schema.is(BenchFailure)(parsed)) {
  console.error(parsed.reason);
  process.exitCode = 1;
} else if (parsed.help) {
  console.log(usage);
} else {
  const finished = await Effect.runPromise(
    Effect.result(
      parsed.compare === undefined ? benchmark(parsed) : compareReports(parsed.compare),
    ),
  );
  if (Result.isFailure(finished)) {
    const error = finished.failure;
    if (Schema.is(BenchFailure)(error)) {
      console.error(error.reason);
    } else if (Schema.is(PdfCoreError)(error)) {
      console.error(error.reason ?? error.code);
    } else {
      console.error("The benchmark failed.");
    }
    process.exitCode = 1;
  }
}
