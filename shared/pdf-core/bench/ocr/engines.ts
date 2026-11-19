import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { RecognitionSchema } from "./metrics.ts";
import type { Recognition, Reference } from "./metrics.ts";

export const tesseractImage = "signature-kit-ocr-bench:5.3.0";

const tesseractModes = {
  "tesseract-lstm": { model: "standard", oem: "1" },
  "tesseract-legacy": { model: "standard", oem: "0" },
  "tesseract-fast": { model: "fast", oem: "1" },
};

export const EngineSchema = Schema.Literals([
  "ours-native",
  "ours-wasm",
  "tesseract-lstm",
  "tesseract-legacy",
  "tesseract-fast",
]);
export type Engine = typeof EngineSchema.Type;

type Trial = { elapsedMs: number; rssKiB: number; output: Recognition };

export class BenchmarkError extends Schema.TaggedError<
  BenchmarkError,
  { readonly brand: unique symbol }
>()("BenchmarkError", { reason: Schema.String }) {}

export function runCommand(command: string[]) {
  return Effect.gen(function* () {
    const result = yield* Effect.try({
      try: () =>
        Bun.spawnSync(command, {
          env: { ...process.env, LC_ALL: "C", OMP_THREAD_LIMIT: "1" },
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: (cause) =>
        new BenchmarkError({ reason: `Could not start ${command[0]}: ${String(cause)}` }),
    });
    if (result.success !== true) {
      return yield* new BenchmarkError({
        reason: `${command[0]} exited ${result.exitCode}: ${result.stderr.toString().trim()}`,
      });
    }
    return result.stdout.toString();
  });
}

function peakRss(time: string) {
  const rss = /Maximum resident set size \(kbytes\):\s+(\d+)/u.exec(time)?.[1];
  return rss === undefined
    ? Effect.fail(new BenchmarkError({ reason: "Missing GNU time maximum RSS" }))
    : Effect.succeed(Number(rss));
}

export function decodeTsv(tsv: string, width: number, height: number) {
  return Effect.gen(function* () {
    const rows = tsv.trimEnd().split("\n");
    if (
      rows.shift() !==
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"
    ) {
      return yield* new BenchmarkError({ reason: "Missing Tesseract TSV header" });
    }
    const lines = new Map<string, number>();
    const words = rows.flatMap((row) => {
      const [
        level,
        page,
        block,
        paragraph,
        line,
        ,
        left,
        top,
        boxWidth,
        boxHeight,
        conf,
        ...fields
      ] = row.split("\t");
      const text = fields.join("\t").trim();
      if (level !== "5" || text.length === 0) {
        return [];
      }
      const key = [page, block, paragraph, line].join("/");
      const lineIndex = lines.get(key) ?? lines.size;
      lines.set(key, lineIndex);
      const x = Number(left);
      const y = Number(top);
      return [
        {
          text,
          box: [x, y, x + Number(boxWidth), y + Number(boxHeight)],
          confidence: Number(conf) / 100,
          line: lineIndex,
        },
      ];
    });
    const textLines = Array.from({ length: lines.size }, (): string[] => []);
    for (const word of words) {
      textLines[word.line]?.push(word.text);
    }
    return yield* Schema.decodeUnknownEffect(RecognitionSchema)({
      width,
      height,
      words,
      text: textLines.map((line) => line.join(" ")).join("\n"),
    });
  });
}

const decodeRecognitionJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RecognitionSchema));

export function benchmarkEngine(
  engine: Engine,
  pages: readonly Reference[],
  options: { dataset: string; psm: string; repeats: number; cpu: string },
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const output = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "pdf-core-ocr-"))),
        (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
      );
      const results = new Map<string, Trial[]>();
      if (engine === "ours-native" || engine === "ours-wasm") {
        const native =
          process.env.OCR_BENCH_NATIVE ??
          join(import.meta.dir, "../../rust/target/release/pdf-core-ocr");
        const wasm = process.env.OCR_BENCH_WASM_DRIVER;
        const time = process.env.OCR_BENCH_TIME ?? "/usr/bin/time";
        if (engine === "ours-wasm" && (wasm === undefined || wasm.length === 0)) {
          return yield* new BenchmarkError({
            reason: "Set OCR_BENCH_WASM_DRIVER to a Bun OCR service driver",
          });
        }
        for (const page of pages) {
          const input = join(options.dataset, `${page.id}.pgm`);
          const measured = join(output, "page.time");
          const args =
            engine === "ours-wasm"
              ? [process.execPath, "run", wasm ?? "", input, "--json"]
              : [native, input, "--dpi", String(page.dpi)];
          const model = process.env.OCR_BENCH_CTC_MODEL;
          if (engine === "ours-native" && model !== undefined && model.length > 0) {
            args.push("--ctc-model", model);
          }
          const trials: Trial[] = [];
          for (let trial = 0; trial < options.repeats; trial += 1) {
            const started = performance.now();
            const json = yield* runCommand([
              "taskset",
              "-c",
              options.cpu,
              time,
              "-v",
              "-o",
              measured,
              ...args,
            ]);
            const elapsedMs = performance.now() - started;
            const result = yield* decodeRecognitionJson(json);
            const rssKiB = yield* peakRss(readFileSync(measured, "utf8"));
            trials.push({ elapsedMs, rssKiB, output: result });
          }
          results.set(page.id, trials);
        }
        return results;
      }

      const { model, oem } = tesseractModes[engine];
      const log = yield* runCommand([
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--cpuset-cpus",
        options.cpu,
        "--user",
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        "--mount",
        `type=bind,source=${options.dataset},target=/dataset,readonly`,
        "--mount",
        `type=bind,source=${output},target=/output`,
        "--mount",
        `type=bind,source=${join(import.meta.dir, "tesseract.sh")},target=/bench.sh,readonly`,
        tesseractImage,
        "bash",
        "/bench.sh",
        model,
        oem,
        options.psm,
        String(options.repeats),
        ...pages.map((page) => `${page.id}:${page.dpi}`),
      ]);
      const durations = new Map(
        log
          .trim()
          .split("\n")
          .map((row) => {
            const [id, trial, ns] = row.split("\t");
            return [`${id}.${trial}`, Number(ns) / 1e6];
          }),
      );
      for (const page of pages) {
        const trials: Trial[] = [];
        for (let trial = 1; trial <= options.repeats; trial += 1) {
          const name = `${page.id}.${trial}`;
          const elapsedMs = durations.get(name);
          if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
            return yield* new BenchmarkError({
              reason: `Missing or invalid Tesseract timing for ${name}`,
            });
          }
          const result = yield* decodeTsv(
            readFileSync(join(output, `${name}.tsv`), "utf8"),
            page.width,
            page.height,
          );
          const rssKiB = yield* peakRss(readFileSync(join(output, `${name}.time`), "utf8"));
          trials.push({ elapsedMs, rssKiB, output: result });
        }
        results.set(page.id, trials);
      }
      return results;
    }),
  );
}

export function median(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return (
    ((sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) +
      (sorted[Math.floor(sorted.length / 2)] ?? 0)) /
    2
  );
}

export type { Trial };
