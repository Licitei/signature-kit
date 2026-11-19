import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Schema } from "effect";
import {
  BenchmarkError,
  EngineSchema,
  benchmarkEngine,
  median,
  runCommand,
  tesseractImage,
} from "./engines.ts";
import { ReferenceSchema, scorePage, summarizeScores } from "./metrics.ts";
import type { Engine, Trial } from "./engines.ts";
import type { Reference } from "./metrics.ts";

const { values } = parseArgs({
  options: {
    engines: { type: "string", default: "tesseract-lstm,tesseract-legacy,tesseract-fast" },
    dataset: { type: "string" },
    limit: { type: "string" },
    repeats: { type: "string", default: "3" },
    psm: { type: "string", default: "3" },
  },
});

function buckets(page: Reference) {
  const degradation = page.degradation;
  const labels = new Set([`dpi-${page.dpi}`]);
  if (degradation.real === true) {
    labels.add("real");
  } else if (Object.keys(degradation).length === 0) {
    labels.add("clean");
  }
  const variants = {
    blur: ["blur", "blurSigma"],
    noise: ["noise", "sensorNoise", "saltAndPepper"],
    skew: ["skew", "skewDegrees"],
    bilevel: ["bilevel", "bilevelThreshold"],
  };
  for (const [label, fields] of Object.entries(variants)) {
    if (fields.some((field) => Boolean(degradation[field]))) {
      labels.add(label);
    }
  }
  const quality = degradation.jpegQuality ?? degradation.jpeg;
  if (typeof quality === "number" && quality > 0) {
    labels.add(`jpeg-q${quality}`);
  }
  if (typeof degradation.kind === "string") {
    labels.add(degradation.kind);
  }
  if (typeof degradation.preset === "string") {
    labels.add(degradation.preset);
  }
  return [...labels];
}

function summarize(pages: ReturnType<typeof pageResult>[]) {
  const times = pages.map((page) => page.elapsedMs).sort((a, b) => a - b);
  const totalMs = times.reduce((sum, time) => sum + time, 0);
  return {
    pages: times.length,
    ...summarizeScores(pages.map((page) => page.score)),
    meanMs: totalMs / times.length,
    p50Ms: median(times),
    p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    pagesPerSecond: (1000 * times.length) / totalMs,
    peakRssKiB: Math.max(...pages.map((page) => page.peakRssKiB)),
  };
}

function pageResult(page: Reference, first: Trial, trials: readonly Trial[]) {
  return {
    id: page.id,
    buckets: buckets(page),
    elapsedMs: median(trials.map((trial) => trial.elapsedMs)),
    peakRssKiB: Math.max(...trials.map((trial) => trial.rssKiB)),
    trials: trials.map(({ elapsedMs, rssKiB }) => ({ elapsedMs, rssKiB })),
    distinctOutputs: new Set(trials.map((trial) => JSON.stringify(trial.output))).size,
    score: scorePage(page, first.output),
  };
}

function percent(rate: number | null | undefined) {
  return rate == null ? "—" : `${(100 * rate).toFixed(2)}%`;
}

function tables(summaries: ReturnType<typeof summarizeEngine>[]) {
  const rows = [
    "| Engine | Bucket | N | CER raw | WER raw | CER norm | WER norm | Bag F1 | Box P/R/F1 | Box+text P/R/F1 | Mean ms | P50 ms | P95 ms | Pages/s | Peak RSS KiB |",
    "|---|---|---:|---:|---:|---:|---:|---:|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const { engine, groups } of summaries) {
    for (const { bucket, metrics } of groups) {
      const boxes = [metrics.boxes, metrics.boxesWithText].map((box) =>
        box === null ? "—" : [box.precision, box.recall, box.f1].map(percent).join(" / "),
      );
      rows.push(
        `| ${engine} | ${bucket} | ${metrics.pages} | ${percent(metrics.raw.cer)} | ${percent(metrics.raw.wer)} | ${percent(metrics.normalized.cer)} | ${percent(metrics.normalized.wer)} | ${percent(metrics.bag?.f1)} | ${boxes.join(" | ")} | ${metrics.meanMs.toFixed(2)} | ${metrics.p50Ms.toFixed(2)} | ${metrics.p95Ms?.toFixed(2)} | ${metrics.pagesPerSecond.toFixed(2)} | ${metrics.peakRssKiB} |`,
      );
    }
  }
  return rows.join("\n");
}

function summarizeEngine(engine: Engine, pages: ReturnType<typeof pageResult>[]) {
  const labels = [...new Set(pages.flatMap((page) => page.buckets))].sort();
  return {
    engine,
    groups: [
      { bucket: "all", metrics: summarize(pages) },
      ...labels.map((bucket) => ({
        bucket,
        metrics: summarize(pages.filter((page) => page.buckets.includes(bucket))),
      })),
    ],
    pages,
  };
}

const decodeReference = Schema.decodeUnknownEffect(Schema.fromJsonString(ReferenceSchema));

const program = Effect.gen(function* () {
  const repeats = Number(values.repeats);
  const limit = Number(values.limit ?? Number.MAX_SAFE_INTEGER);
  const psm = values.psm ?? "3";
  if (
    values.dataset === undefined ||
    values.dataset.length === 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(repeats) ||
    repeats < 3 ||
    !["3", "6", "7"].includes(psm)
  ) {
    return yield* new BenchmarkError({
      reason:
        "Usage: bun run.ts --dataset DIR [--engines NAME,...] [--limit N] [--repeats N>=3] [--psm 3|6|7]",
    });
  }
  const engines = yield* Schema.decodeUnknownEffect(Schema.Array(EngineSchema))([
    ...new Set(values.engines?.split(",") ?? []),
  ]);
  const dataset = resolve(values.dataset);
  const names = readdirSync(dataset)
    .filter(
      (name) => name.endsWith(".json") && existsSync(join(dataset, `${name.slice(0, -5)}.pgm`)),
    )
    .sort()
    .slice(0, limit);
  if (names.length === 0) {
    return yield* new BenchmarkError({ reason: `No paired JSON and PGM files in ${dataset}` });
  }
  const pages = [];
  for (const name of names) {
    const reference = yield* decodeReference(readFileSync(join(dataset, name), "utf8"));
    if (name !== `${reference.id}.json`) {
      return yield* new BenchmarkError({
        reason: `Filename ${name} disagrees with reference id ${reference.id}`,
      });
    }
    const imageBytes = readFileSync(join(dataset, `${reference.id}.pgm`));
    const pgmHeader = /^P5\s+(?:#.*\n\s*)*(\d+)\s+(\d+)\s+255\n/u.exec(
      imageBytes.subarray(0, 1024).toString("utf8"),
    );
    if (
      pgmHeader === null ||
      Number(pgmHeader[1]) !== reference.width ||
      Number(pgmHeader[2]) !== reference.height ||
      imageBytes.byteLength - Buffer.byteLength(pgmHeader[0]) !== reference.width * reference.height
    ) {
      return yield* new BenchmarkError({
        reason: `Image ${reference.id} must be 8-bit P5 with the reference dimensions`,
      });
    }
    const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
    if (reference.imageSha256 !== undefined && reference.imageSha256 !== imageSha256) {
      return yield* new BenchmarkError({ reason: `Image hash mismatch for ${reference.id}` });
    }
    pages.push({ ...reference, imageSha256 });
  }
  const affinity = yield* runCommand(["taskset", "-pc", String(process.pid)]);
  const cpu = /:\s*(\d+)/u.exec(affinity)?.[1];
  if (cpu === undefined) {
    return yield* new BenchmarkError({
      reason: `Could not determine CPU affinity: ${affinity.trim()}`,
    });
  }
  const cpuDetails = yield* runCommand(["lscpu"]);
  const cpuModel = /^Model name:\s*(.*)$/mu.exec(cpuDetails)?.[1] ?? "unknown";
  const imageId = engines.some((engine) => engine.startsWith("tesseract"))
    ? (yield* runCommand([
        "docker",
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        tesseractImage,
      ])).trim()
    : null;
  const skipped = [];
  const summaries = [];
  for (const engine of engines) {
    const native =
      process.env.OCR_BENCH_NATIVE ??
      join(import.meta.dir, "../../rust/target/release/pdf-core-ocr");
    if (engine === "ours-native" && existsSync(native) === false) {
      skipped.push({ engine, reason: `CLI missing at ${native}` });
      continue;
    }
    if (engine === "ours-wasm" && (process.env.OCR_BENCH_WASM_DRIVER?.length ?? 0) === 0) {
      skipped.push({ engine, reason: "OCR_BENCH_WASM_DRIVER is unset" });
      continue;
    }
    console.error(`Running ${engine} on ${pages.length} pages × ${repeats} trials`);
    const results = yield* benchmarkEngine(engine, pages, { dataset, psm, repeats, cpu });
    const scored = [];
    for (const page of pages) {
      const trials = results.get(page.id) ?? [];
      const first = trials[0];
      if (
        first === undefined ||
        trials.length !== repeats ||
        trials.some(({ output }) => output.width !== page.width || output.height !== page.height)
      ) {
        return yield* new BenchmarkError({
          reason: `Invalid number of trials or dimensions for ${engine} on ${page.id}`,
        });
      }
      scored.push(pageResult(page, first, trials));
    }
    summaries.push(summarizeEngine(engine, scored));
  }
  if (summaries.length === 0) {
    return yield* new BenchmarkError({
      reason: skipped.map(({ engine, reason }) => `${engine}: ${reason}`).join("\n"),
    });
  }

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const directory = join(import.meta.dir, "../../.cache/ocr-report", timestamp);
  mkdirSync(directory, { recursive: true });
  const metadata = {
    dataset,
    repeats,
    psm,
    cpu,
    cpuModel,
    imageId,
    skipped,
    samples: pages.map(({ id, imageSha256, dpi, degradation }) => ({
      id,
      imageSha256,
      dpi,
      degradation,
    })),
  };
  yield* Effect.promise(() =>
    Bun.write(
      join(directory, "report.json"),
      `${JSON.stringify({ metadata, summaries }, null, 2)}\n`,
    ),
  );
  yield* Effect.promise(() =>
    Bun.write(
      join(directory, "report.md"),
      [
        "# OCR benchmark",
        "",
        `Dataset \`${dataset}\``,
        "",
        `${cpuModel}, logical CPU ${cpu}. ${repeats} trials per page. Tesseract PSM ${psm}.`,
        "",
        ...(imageId === null ? [] : [`Tesseract image digest \`${imageId}\`.`, ""]),
        ...skipped.flatMap(({ engine, reason }) => [`Skipped ${engine}. ${reason}.`, ""]),
        tables(summaries),
        "",
        "Accuracy uses the first trial. Latencies summarize the median of each page’s trials. Peak RSS is the maximum across all trials.",
        "",
      ].join("\n"),
    ),
  );
  console.log(directory);
});

await Effect.runPromise(program);
