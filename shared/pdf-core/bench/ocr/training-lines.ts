import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { parsePgm } from "./degradation";
import type { Raster } from "./degradation";
import { ReferenceSchema } from "./metrics";

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
const background = 255;

function mix(value: number) {
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function augment(
  raster: Raster,
  left: number,
  top: number,
  right: number,
  bottom: number,
  label: Uint8Array,
  sampleSeed: number,
) {
  let state = mix(sampleSeed) || 1;
  const strength = (state & 15) / 15;
  const slope = (((state >>> 4) % 31) - 15) / 1000;
  const scale = (22 + ((state >>> 9) & 7)) / (bottom - top);
  const innerWidth = Math.max(1, Math.min(1024, Math.round((right - left) * scale)));
  const innerHeight = Math.round((bottom - top) * scale);
  const marginY = Math.ceil((Math.abs(slope) * innerWidth) / 2) + 2;
  const width = innerWidth + 8;
  const height = innerHeight + 2 * marginY;
  const record = new Uint8Array(8 + width * height + label.length);
  const header = new DataView(record.buffer, 0, 8);
  header.setUint16(0, width, true);
  header.setUint16(2, height, true);
  header.setUint32(4, label.length, true);
  record.set(label, 8 + width * height);
  const gain = 0.8 + strength * 0.3;
  const offset = ((state >>> 13) % 19) - 13;
  const blur = (state >>> 18) & 1;
  const bilevel = ((state >>> 19) & 7) === 0;
  const xScale = (right - left) / innerWidth;
  const yScale = (bottom - top) / innerHeight;
  const columns = Int32Array.from({ length: width }, (_, x) =>
    x < 4 || x >= width - 4 ? -1 : left + Math.floor((x - 3.5) * xScale),
  );
  const shifts = Int32Array.from({ length: width }, (_, x) =>
    Math.round((x - width / 2) * slope * yScale),
  );
  let target = 8;
  for (let y = 0; y < height; y += 1) {
    const sourceY = top + Math.floor((y - marginY + 0.5) * yScale);
    for (let x = 0; x < width; x += 1) {
      const sourceX = columns[x] ?? -1;
      const shiftedY = sourceY - (shifts[x] ?? 0);
      let value = background;
      if (sourceX >= left && shiftedY >= top && shiftedY < bottom) {
        const source = shiftedY * raster.width + sourceX;
        value = raster.pixels[source] ?? background;
        if (blur !== 0) {
          value =
            (2 * value +
              (raster.pixels[Math.max(source - 1, shiftedY * raster.width)] ?? background) +
              (raster.pixels[sourceX + 1 < raster.width ? source + 1 : source] ?? background)) /
            4;
        }
      }
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      value = (value - 128) * gain + 128 + offset + ((state & 7) - 3) * strength;
      record[target] = bilevel ? (value >= 165 ? 255 : 0) : clamp(Math.round(value), 0, 255);
      target += 1;
    }
  }
  return record;
}

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
  writer.write("OCRL\x01\x00\x00\x00");
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
