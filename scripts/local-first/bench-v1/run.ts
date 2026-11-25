import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { Option, Schema } from "effect";
import { measureBundles } from "./bundle.ts";
import { output, root } from "./config.ts";
import { statistics } from "./measure.ts";

const config = "scripts/local-first/bench-v1/vitest.config.ts";
const corpus = resolve(output, "corpus");
const bench = "shared/pdf-core/bench";
const wasm = "shared/pdf-core/dist/pdf-core.wasm";
const large = "0020p_synthetic-21mib.pdf";
const hab = "shared/pdf-core/__tests__/fixtures/habilitacao-150.pdf";
const write = (file: string, payload: unknown) =>
  writeFile(resolve(output, file), JSON.stringify(payload, null, 2) + "\n");
const read = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(resolve(output, file), "utf8"));
const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: unknown) =>
  Option.getOrThrow(Schema.decodeUnknownOption(schema)(value));

const capture = async (argv: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn(argv, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
};

const host = async () => {
  const { stdout, exit } = await capture(["ci-status"]);
  const counts = (state: string) =>
    Number(stdout.match(new RegExp(`^${state} \\((\\d+)\\)`, "m"))?.[1] ?? 0);
  return {
    loadAverage: loadavg(),
    running: exit === 0 ? counts("RUNNING") : null,
    queued: exit === 0 ? counts("QUEUED") : null,
    reservation: exit === 0 ? stdout.split("\n")[0] : null,
    runningJobs: [
      ...(stdout.split("\nQUEUED")[0] ?? "").matchAll(
        /^  #(\d+)\s+\S+\s+cpu\s+([\d.]+)\s+mem\s+(\d+)\s*G/gm,
      ),
    ].map(([, job, cpu, gib]) => ({
      job: Number(job),
      cpu: Number(cpu),
      reservedGiB: Number(gib),
    })),
  };
};

const phases: Array<{
  name: string;
  exit: number;
  before: Awaited<ReturnType<typeof host>>;
  after: Awaited<ReturnType<typeof host>>;
}> = [];
const phase = async <A>(name: string, run: () => Promise<{ exit: number; data: A }>) => {
  const before = await host();
  console.info(`bench:v1 ${name}`);
  let exit = 1;
  try {
    const result = await run();
    exit = result.exit;
    return result.data;
  } finally {
    phases.push({ name, exit, before, after: await host() });
    await write("phases.json", phases);
    if (exit !== 0) console.error(`bench:v1 ${name} exited ${exit}`);
  }
};

const runTests = (project: string) =>
  phase(project, async () => {
    const { exit } = await capture([
      "bun",
      "x",
      "vitest",
      "run",
      "--config",
      config,
      "--project",
      project,
    ]);
    return {
      exit,
      data: exit === 0 ? await read(project === "v1-node" ? "node.json" : "chromium.json") : null,
    };
  });

const timing = (
  id: string,
  corpusId: string,
  bytes: number | null,
  pages: number | null,
  samples: ReadonlyArray<number>,
) => ({
  id,
  runtime: "node",
  corpus: corpusId,
  bytes,
  pages,
  samples,
  ...statistics(samples),
  memory: null,
});
const numbers = Schema.Array(Schema.Finite);
const runRow = Schema.Struct({
  signScanMs: Schema.Finite,
  documentMs: Schema.Finite,
  textMs: Schema.Finite,
});
const speedSchema = Schema.Struct({
  textMsPerPageRuns: numbers,
  renderMsPerPageRuns: numbers,
  textNoisePct: Schema.Finite,
  renderNoisePct: Schema.Finite,
  habilitacao: Schema.Struct({ bytes: Schema.Finite, samples: Schema.Array(runRow) }),
  largeEdital: Schema.Struct({ bytes: Schema.Finite, samples: Schema.Array(runRow) }),
});
const lazyMeasure = Schema.Struct({
  bytesRead: Schema.Finite,
  rounds: Schema.Finite,
  size: Schema.Finite,
  latencyMs: Schema.Finite,
  wasmBytes: Schema.Finite,
  peakRssBytes: Schema.Finite,
  strategy: Schema.String,
});
const lazyRowSchema = Schema.Struct({
  file: Schema.String,
  equal: Schema.Boolean,
  lazy: lazyMeasure,
  full: lazyMeasure,
  lazySamples: numbers,
  fullSamples: numbers,
});
const generateSchema = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({
      generator: Schema.String,
      coldMs: Schema.Finite,
      warmSamples: numbers,
      outputBytes: Schema.Finite,
    }),
  ),
});
const wasmSchema = Schema.Struct({
  raw: Schema.Finite,
  gzip: Schema.Finite,
  brotli: Schema.Finite,
});
const caseSchema = Schema.Struct({
  id: Schema.String,
  runtime: Schema.Literals(["node", "chromium"]),
  corpus: Schema.String,
  bytes: Schema.NullOr(Schema.Finite),
  pages: Schema.NullOr(Schema.Finite),
  samples: numbers,
  median: Schema.NullOr(Schema.Finite),
  p95: Schema.NullOr(Schema.Finite),
  min: Schema.NullOr(Schema.Finite),
  max: Schema.NullOr(Schema.Finite),
  memory: Schema.Unknown,
  warmups: Schema.optional(Schema.Finite),
});
const resultSchema = Schema.Struct({ cases: Schema.Array(caseSchema) });
const readCases = (result: unknown) => (result === null ? [] : decode(resultSchema, result).cases);
const normalize = (cases: ReturnType<typeof readCases>) =>
  cases.map(({ samples, ...row }) => ({
    ...row,
    samples: samples.length,
  }));
const jsonLines = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line): unknown => JSON.parse(line));

try {
  await mkdir(corpus, { recursive: true });
  const [{ stdout: gitSha }, { stdout: bun }, { stdout: node }] = await Promise.all([
    capture(["git", "rev-parse", "HEAD"]),
    capture(["bun", "--version"]),
    capture(["node", "--version"]),
  ]);

  await phase("build", async () => {
    const { exit } = await capture(["bun", "run", "build"]);
    return { exit, data: null };
  });
  const repeats: Array<{
    project: string;
    cases: Array<{
      id: string;
      corpus: string;
      initialMedian: number | null;
      initialP95: number | null;
      repeatMedian: number | null;
      repeatP95: number | null;
    }>;
  }> = [];
  const benchmark = async (project: string) => {
    const initial = await runTests(project);
    const load = phases.at(-1);
    const candidates = readCases(initial).filter(
      ({ id, corpus, median, p95 }) =>
        corpus === "synthetic-21mib" &&
        ["pdf.sign.warm-a1", "pdf.verify.2"].includes(id) &&
        median !== null &&
        p95 !== null &&
        p95 > 1.35 * median,
    );
    if (
      candidates.length === 0 ||
      Math.max(load?.before.running ?? 0, load?.after.running ?? 0) < 2
    )
      return initial;
    await write(project + "-first.json", initial);
    const repeated = await runTests(project);
    const second = readCases(repeated);
    repeats.push({
      project,
      cases: candidates.map(({ id, corpus, median, p95 }) => {
        const later = second.find((row) => row.id === id && row.corpus === corpus);
        return {
          id,
          corpus,
          initialMedian: median,
          initialP95: p95,
          repeatMedian: later?.median ?? null,
          repeatP95: later?.p95 ?? null,
        };
      }),
    });
    return repeated ?? initial;
  };

  const nodeResult = await benchmark("v1-node");
  const browserResult = await benchmark("v1-chromium");

  const measurements: Array<ReturnType<typeof timing>> = [];
  const legacy = await phase("pdf-core-bench", async () => {
    if (nodeResult === null) return { exit: 1, data: null };
    await copyFile(resolve(root, hab), resolve(corpus, "0150p_habilitacao.pdf"));
    const env = { PDF_CORPUS: corpus };
    const speed = () => capture(["bun", `${bench}/measure-speed.ts`, "--label", "v1"], env);
    const firstSpeed = await speed();
    if (firstSpeed.exit !== 0) return { exit: firstSpeed.exit, data: null };
    const initialSpeed = decode(speedSchema, JSON.parse(firstSpeed.stdout));
    const repeatSpeed = Math.max(initialSpeed.textNoisePct, initialSpeed.renderNoisePct) > 35;
    const repeatedSpeed = repeatSpeed ? await speed() : firstSpeed;
    if (repeatedSpeed.exit !== 0) return { exit: repeatedSpeed.exit, data: null };
    const speedResult = decode(speedSchema, JSON.parse(repeatedSpeed.stdout));
    const memory = [];
    for (const [path, id] of [
      [hab, "real-habilitacao-150"],
      [resolve(corpus, large), "synthetic-21mib"],
    ] satisfies Array<[string, string]>) {
      for (const mode of ["load", "text", "markdown", "tables", "lazy", "render"]) {
        const { stdout, exit } = await capture([
          "bun",
          `${bench}/measure-memory.ts`,
          wasm,
          path,
          mode,
        ]);
        if (exit !== 0) return { exit, data: null };
        const [wasmBytes, peakRssBytes, milliseconds, rows] = decode(
          numbers,
          stdout.trim().split(/\s+/).map(Number),
        );
        memory.push({ corpus: id, mode, wasmBytes, peakRssBytes, milliseconds, rows });
      }
    }
    const size = await capture(["bun", `${bench}/measure-size.ts`, "--label", "v1"]);
    const generate = await capture(["bun", `${bench}/generate.bench.ts`]);
    const lazy = await capture(["bun", `${bench}/lazy.bench.ts`, "--warm"], env);
    const exit = size.exit || generate.exit || lazy.exit;
    if (exit !== 0) return { exit, data: null };
    const wasmSize = decode(wasmSchema, jsonLines(size.stdout)[0]);
    const lazyRows = jsonLines(lazy.stdout)
      .slice(0, -1)
      .map((row) => decode(lazyRowSchema, row));
    const generators = decode(
      generateSchema,
      await read(`../../${bench}/results/generate-latest.json`),
    ).rows;
    measurements.push(
      timing(
        "pdf-core.speed.text.ms-per-page",
        "two-document-corpus",
        null,
        170,
        speedResult.textMsPerPageRuns,
      ),
      timing(
        "pdf-core.speed.render.ms-per-page",
        "two-document-corpus",
        null,
        16,
        speedResult.renderMsPerPageRuns,
      ),
    );
    for (const [id, pages, data] of [
      ["real-habilitacao-150", 150, speedResult.habilitacao],
      ["synthetic-21mib", 20, speedResult.largeEdital],
    ] satisfies Array<[string, number, typeof speedResult.habilitacao]>) {
      for (const [operation, select] of [
        ["signature-scan", (row: (typeof data.samples)[number]) => row.signScanMs],
        ["document", (row: (typeof data.samples)[number]) => row.documentMs],
        ["text", (row: (typeof data.samples)[number]) => row.textMs],
      ] satisfies Array<[string, (value: (typeof data.samples)[number]) => number]>) {
        measurements.push(
          timing(`pdf-core.speed.${operation}`, id, data.bytes, pages, data.samples.map(select)),
        );
      }
    }
    for (const row of lazyRows) {
      const isLarge = row.file === large;
      const id = isLarge ? "synthetic-21mib" : "real-habilitacao-150";
      measurements.push(
        timing("pdf-core.lazy.range-file", id, row.lazy.size, isLarge ? 20 : 150, row.lazySamples),
        timing("pdf-core.lazy.full-file", id, row.full.size, isLarge ? 20 : 150, row.fullSamples),
      );
    }
    for (const generator of generators) {
      measurements.push(
        timing("pdf-core.generate.cold-setup", generator.generator, null, null, [generator.coldMs]),
        timing(
          "pdf-core.generate.warm",
          generator.generator,
          generator.outputBytes,
          null,
          generator.warmSamples,
        ),
      );
    }
    const data = {
      speed: speedResult,
      speedInitial: repeatSpeed
        ? {
            text: statistics(initialSpeed.textMsPerPageRuns),
            render: statistics(initialSpeed.renderMsPerPageRuns),
            textNoisePct: initialSpeed.textNoisePct,
            renderNoisePct: initialSpeed.renderNoisePct,
          }
        : null,
      memory,
      wasm: wasmSize,
      lazy: lazyRows,
      generators,
    };
    await write("pdf-core.json", data);
    return { exit, data };
  });

  const performanceSuites = await phase("test:performance", async () => {
    const { stdout, stderr, exit } = await capture([
      "bun",
      "run",
      "test:performance",
      "--reporter=default",
    ]);
    const report = stdout + "\n" + stderr;
    const data = {
      exit,
      internal: [...report.matchAll(/bench-v1-internal ([a-z0-9.-]+) ([0-9.]+)/g)].map(
        ([, id, ms]) => ({ id, milliseconds: Number(ms) }),
      ),
      anchors: [...report.matchAll(/^\| ([\w.-]+\.pdf) \| ([0-9.]+) \| ([0-9.]+) \|/gm)].map(
        ([, fixture, core, pdfjs]) => ({
          fixture,
          pdfCoreMedianMs: Number(core),
          pdfJsMedianMs: Number(pdfjs),
        }),
      ),
      suites: [
        ...report.matchAll(
          /(?:✓|×|❯)\s+([\w/.-]+\.performance\.test\.ts)\s+\((\d+) tests?[^)]*\)\s+(\d+)\s?ms/g,
        ),
      ].map(([, file, tests, ms]) => ({ file, tests: Number(tests), milliseconds: Number(ms) })),
    };
    await write("performance.json", data);
    return { exit, data };
  });
  const bundles = await phase("vite-bundles", async () => {
    const data = await measureBundles();
    await write("bundles.json", data);
    return { exit: 0, data };
  });

  const environment = {
    cpu: cpus()[0]?.model,
    logicalCores: cpus().length,
    ramBytes: totalmem(),
    os: `${process.platform} ${release()} ${process.arch}`,
    bun: bun.trim(),
    node: node.trim(),
    ...(browserResult !== null
      ? decode(Schema.Struct({ chromium: Schema.String }), browserResult)
      : {}),
  };

  const extras = (schema: Schema.Struct<{ copies: Schema.Unknown }>, result: unknown) =>
    result === null ? null : decode(schema, result);
  await write("baseline-v1.json", {
    units: {
      timing: "milliseconds except case IDs ending in ms-per-page",
      memory: "bytes",
      size: "bytes",
    },
    environment,
    gitSha: gitSha.trim(),
    phases,
    cases: normalize([
      ...readCases(nodeResult),
      ...readCases(browserResult),
      ...decode(resultSchema, { cases: measurements }).cases,
    ]),
    repeats,
    node: extras(Schema.Struct({ copies: Schema.Unknown }), nodeResult),
    chromium:
      browserResult === null
        ? null
        : decode(
            Schema.Struct({
              copies: Schema.Unknown,
              unavailable: Schema.Unknown,
              workers: Schema.Unknown,
              batches: Schema.Unknown,
            }),
            browserResult,
          ),
    pdfCoreBench: legacy,
    performanceSuites,
    bundles,
  });
} finally {
  await Promise.all(
    [large, "0150p_habilitacao.pdf", "xml-small.xml", "xml-1mib.xml"].map((file) =>
      rm(resolve(corpus, file), { force: true }),
    ),
  );
}
if (phases.some(({ exit }) => exit !== 0)) process.exitCode = 1;
