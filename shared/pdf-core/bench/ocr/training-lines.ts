import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { parsePgm } from "./degradation";
import { ReferenceSchema } from "./metrics";
import { augment, mix, trainingLineHeader } from "./training-raster";

const [mode, input, output, countArg, workersArg, seedArg, shardArg] = process.argv.slice(2);
const count = Number(countArg);
const workers = Number(workersArg);
const seed = Number(seedArg);
const shard = Number(shardArg);

if (
  (mode !== "generate" && mode !== "worker") ||
  input === undefined ||
  output === undefined ||
  basename(resolve(input)) !== "train" ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  count > 0xffffffff ||
  !Number.isSafeInteger(workers) ||
  workers < 1 ||
  workers > 8 ||
  !Number.isSafeInteger(seed) ||
  seed < 0 ||
  seed > 0xffffffff ||
  (mode === "worker" && (!Number.isInteger(shard) || shard < 0 || shard >= workers))
) {
  console.error(
    "Usage: bun training-lines.ts generate CLEAN_DATASET/train OUTPUT LINES WORKERS SEED",
  );
  process.exit(2);
}

const decodePage = Schema.decodeUnknownEffect(Schema.fromJsonString(ReferenceSchema));
const encoder = new TextEncoder();

if (mode === "generate") {
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const started = performance.now();
  const processes = Array.from({ length: workers }, (_, index) =>
    Bun.spawn(
      [
        process.execPath,
        import.meta.path,
        "worker",
        input,
        output,
        String(count),
        String(workers),
        String(seed),
        String(index),
      ],
      { stdout: "inherit", stderr: "inherit" },
    ),
  );
  const exits: number[] = await Promise.all(processes.map(({ exited }) => exited));
  const seconds = (performance.now() - started) / 1000;
  if (exits.some((status) => status !== 0)) {
    await rm(output, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(JSON.stringify({ count, workers, seconds, linesPerSecond: count / seconds }));
} else {
  const pages = (await readdir(input)).filter((file) => file.endsWith(".json")).sort();
  if (pages.length === 0) {
    console.error("The training cache is empty");
    process.exit(1);
  }
  const ranges = [];
  let total = 0;
  for (const filename of pages) {
    const jsonPath = join(input, filename);
    const page = await Effect.runPromise(decodePage(await Bun.file(jsonPath).text()));
    const words = page.words ?? [];
    if (page.degradation.preset !== "clean" || words.length === 0) {
      console.error(`Expected a clean full-page label with words: ${jsonPath}`);
      process.exit(1);
    }
    const lines = new Map<
      number,
      { left: number; top: number; right: number; bottom: number; words: string[] }
    >();
    for (const {
      line,
      text,
      box: [left, top, right, bottom],
    } of words) {
      const entry = lines.get(line);
      if (entry === undefined) {
        lines.set(line, { left, top, right, bottom, words: [text] });
      } else {
        entry.left = Math.min(left, entry.left);
        entry.top = Math.min(top, entry.top);
        entry.right = Math.max(right, entry.right);
        entry.bottom = Math.max(bottom, entry.bottom);
        entry.words.push(text);
      }
    }
    const labels = [...lines.values()]
      .map(({ left, top, right, bottom, words }) => ({
        left: Math.max(0, left - 2),
        top: Math.max(0, top - 1),
        right: Math.min(page.width, right + 2),
        bottom: Math.min(page.height, bottom + 1),
        text: encoder.encode(words.join(" ").normalize("NFC")),
      }))
      .filter(({ left, right, top, bottom }) => right > left && bottom > top);
    if (labels.length === 0) continue;
    ranges.push({
      path: jsonPath.replace(/\.json$/u, ".pgm"),
      width: page.width,
      height: page.height,
      labels,
      first: total,
    });
    total += labels.length;
  }
  if (total === 0) {
    console.error("No usable training lines");
    process.exit(1);
  }

  const start = Math.floor((shard * count) / workers);
  const end = Math.floor(((shard + 1) * count) / workers);
  const writer = Bun.file(join(output, `lines-${shard.toString().padStart(3, "0")}.ocrl`)).writer({
    highWaterMark: 1024 * 1024,
  });
  writer.write(trainingLineHeader);
  let position = start;
  while (position < end) {
    const cycle = Math.floor(position / total);
    for (const page of ranges) {
      const first = cycle * total + page.first;
      const left = Math.max(first, position);
      const right = Math.min(first + page.labels.length, end);
      if (left >= right) continue;
      const raster = parsePgm(await Bun.file(page.path).bytes());
      if (raster === undefined || raster.width !== page.width || raster.height !== page.height) {
        await writer.end();
        console.error(`Invalid page raster: ${page.path}`);
        process.exit(1);
      }
      for (const [index, label] of page.labels.slice(left - first, right - first).entries()) {
        writer.write(
          augment(
            raster,
            label.left,
            label.top,
            label.right,
            label.bottom,
            label.text,
            mix(seed ^ (left + index)),
          ),
        );
      }
      position = right;
    }
  }
  await writer.end();
}
