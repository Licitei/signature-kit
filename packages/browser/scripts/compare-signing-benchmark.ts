import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";

const Summary = Schema.Struct({ p50: Schema.Finite, p95: Schema.Finite, n: Schema.Finite });
type Summary = typeof Summary.Type;
const Summaries = Schema.Record(Schema.String, Summary);
const Result = Schema.Struct({
  hardwareConcurrency: Schema.Finite,
  cold: Summaries,
  coldBundled: Schema.optional(Summaries),
  coldPrewarmed: Schema.optional(Summaries),
  coldStages: Summaries,
  warm: Schema.Array(
    Schema.Record(Schema.String, Schema.Union([Summary, Schema.Finite, Schema.String])),
  ),
  stages: Schema.Array(
    Schema.Record(Schema.String, Schema.Union([Summary, Schema.Finite, Schema.String])),
  ),
  batches: Schema.Array(Schema.Record(Schema.String, Schema.Union([Summary, Schema.Finite]))),
  batchItems: Schema.Array(Schema.Record(Schema.String, Schema.Union([Summary, Schema.Finite]))),
});
type Row = Readonly<Record<string, Summary | number | string>>;

const isSummary = Schema.is(Summary);
const load = (file: string) =>
  Effect.promise(() => readFile(file, "utf8")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Result))),
  );
const cell = (value: Summary | number | string | undefined) =>
  value === undefined
    ? "—"
    : isSummary(value)
      ? `${value.p50.toFixed(2)} / ${value.p95.toFixed(2)}`
      : typeof value === "number"
        ? value >= 1024 * 1024
          ? `${(value / 1024 / 1024).toFixed(1)} MiB`
          : String(value)
        : value;
const delta = (before: Row[string] | undefined, after: Row[string] | undefined) =>
  isSummary(before) && isSummary(after) && before.p50 !== 0
    ? `${(((after.p50 - before.p50) / before.p50) * 100).toFixed(0)}%`
    : "";

const table = (
  title: string,
  key: string,
  before: ReadonlyArray<Row>,
  after: ReadonlyArray<Row>,
) => {
  const lines = [
    `### ${title}`,
    "",
    "| Case | Metric | Before p50 / p95 | After p50 / p95 | Δ p50 |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  for (const row of after) {
    const name = row[key];
    const previous = before.find((candidate) => candidate[key] === name);
    for (const [metric, value] of Object.entries(row)) {
      if (metric === key || metric === "n") continue;
      lines.push(
        `| ${cell(name)} | ${metric} | ${cell(previous?.[metric])} | ${cell(value)} | ${delta(previous?.[metric], value)} |`,
      );
    }
  }
  return lines.join("\n");
};

const [beforeFile, afterFile] = process.argv.slice(2);
if (beforeFile === undefined || afterFile === undefined) {
  console.error("usage: compare-signing-benchmark.ts <before.json> <after.json>");
  process.exit(2);
}

await Effect.runPromise(
  Effect.gen(function* () {
    const before = yield* load(beforeFile);
    const after = yield* load(afterFile);
    const cold = (result: typeof Result.Type): Row => ({
      case: "contract-1p",
      ...result.cold,
      ...result.coldStages,
    });
    console.info(
      [
        table("Cold first signature (fresh worker)", "case", [cold(before)], [cold(after)]),
        table(
          "Cold first signature (fresh production-bundled worker)",
          "case",
          [{ case: "contract-1p", ...before.coldBundled }],
          [{ case: "contract-1p", ...after.coldBundled }],
        ),
        table(
          "Cold first signature after prewarm (fresh production-bundled worker)",
          "case",
          [{ case: "contract-1p", ...before.coldPrewarmed }],
          [{ case: "contract-1p", ...after.coldPrewarmed }],
        ),
        table("Warm single signature (page-observed)", "fixture", before.warm, after.warm),
        table(
          "Warm single signature stages (worker spans)",
          "fixture",
          before.stages,
          after.stages,
        ),
        table("Batches", "documents", before.batches, after.batches),
        table("Batch items (worker spans)", "documents", before.batchItems, after.batchItems),
      ].join("\n\n"),
    );
  }),
);
