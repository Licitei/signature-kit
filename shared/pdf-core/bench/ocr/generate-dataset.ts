import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import {
  degradation,
  degrade,
  mapDegradedBox,
  parsePgm,
  pgm,
  presets,
  scanProfile,
} from "./degradation";
import type { Box, Raster } from "./degradation";
import type { Glyph } from "./glyph-labels";
import { augment, mix, trainingLineHeader } from "./training-raster";
type Word = Glyph & { line: number; glyphs?: Glyph[] };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string", default: join(import.meta.dir, "../../.cache/ocr-dataset") },
    preset: { type: "string", default: "clean" },
    labels: { type: "string", default: "pdf-core" },
    seed: { type: "string", default: "0" },
    dpi: { type: "string", default: "300" },
    mode: { type: "string", default: "pages" },
    split: { type: "string", default: "all" },
    partition: { type: "string", default: "0/1" },
    "max-docs": { type: "string" },
    "max-pages": { type: "string" },
  },
});

const source = positionals[0];
const requestedDpi = Number(values.dpi);
const mode = values.mode;
const preset = values.preset;
const labelSource = values.labels;
const seed = values.seed;
const selectedSplit = values.split;
const maxDocs = Number(values["max-docs"] ?? Number.MAX_SAFE_INTEGER);
const maxPages = Number(values["max-pages"] ?? Number.MAX_SAFE_INTEGER);
const [partition, partitions] = (values.partition ?? "").split("/").map(Number);
const trainingShards = mode === "training-shards";

if (
  positionals.length !== 1 ||
  source === undefined ||
  (![150, 200, 300].includes(requestedDpi) &&
    !(values.dpi === "calibrated" && preset === "calibrated")) ||
  preset === undefined ||
  !presets.includes(preset) ||
  seed === undefined ||
  (labelSource !== "pdf-core" && labelSource !== "poppler") ||
  (mode !== "pages" && mode !== "lines" && !trainingShards) ||
  (trainingShards &&
    (labelSource !== "poppler" ||
      selectedSplit !== "train" ||
      !["clean", "calibrated"].includes(preset))) ||
  !/^\d+\/\d+$/u.test(values.partition ?? "") ||
  partition === undefined ||
  partitions === undefined ||
  !Number.isSafeInteger(partition) ||
  !Number.isSafeInteger(partitions) ||
  partitions < 1 ||
  partition >= partitions ||
  (!trainingShards && partitions !== 1) ||
  !["all", "train", "val", "test"].includes(selectedSplit ?? "") ||
  ![maxDocs, maxPages].every((count) => Number.isSafeInteger(count) && count >= 1)
) {
  console.error(
    "Usage: bun generate-dataset.ts <PDF or directory> [--output DIR] [--dpi 150|200|300|calibrated] [--mode pages|lines|training-shards] [--preset clean|scan|photocopy|jpeg|fax|calibrated] [--seed SEED] [--labels pdf-core|poppler] [--split all|train|val|test] [--max-docs N] [--max-pages N] [--partition INDEX/COUNT]",
  );
  process.exit(2);
}

const pdfRoot = resolve(source);
const output = resolve(values.output);
const root = (await stat(pdfRoot)).isDirectory() ? pdfRoot : resolve(pdfRoot, "..");
const labeler = labelSource === "pdf-core" ? await import("./glyph-labels") : undefined;
const pdfCore =
  labeler === undefined
    ? undefined
    : await import("../../dist/node.js").then(({ loadPdfCoreNode }) => loadPdfCoreNode());

async function* pdfFiles(path: string): AsyncGenerator<string> {
  if (path.split(sep).includes("digitalizados")) return;
  const info = await stat(path);
  if (info.isFile()) {
    if (path.toLowerCase().endsWith(".pdf")) yield path;
    return;
  }
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : Number(left.name !== right.name)));
  for (const entry of entries) {
    if (entry.isDirectory()) yield* pdfFiles(join(path, entry.name));
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) yield join(path, entry.name);
  }
}

async function run(argv: string[]): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const subprocess = Bun.spawn(argv, { stdout: "pipe", stderr: "inherit" });
  const [bytes, exitCode] = await Promise.all([
    new Response(subprocess.stdout).bytes(),
    subprocess.exited,
  ]);
  return exitCode === 0 ? bytes : undefined;
}

function parsePages(tsv: string): Map<number, Word[]> {
  const pages = new Map<number, Word[]>();
  let words: Word[] | undefined;
  let line = -1;
  for (const row of tsv.split("\n")) {
    const [level, page, , , , , left, top, width, height, , ...fields] = row.split("\t");
    if (level === "1") {
      words = [];
      pages.set(Number(page), words);
      line = -1;
    }
    if (level === "4") line += 1;
    if (level !== "5" || words === undefined || line < 0) continue;
    const text = fields.join("\t").trim();
    const x = Number(left);
    const y = Number(top);
    const right = x + Number(width);
    const bottom = y + Number(height);
    if (
      text.length > 0 &&
      [x, y, right, bottom].every(Number.isFinite) &&
      x < right &&
      y < bottom
    ) {
      words.push({
        text,
        box: [Math.floor(x), Math.floor(y), Math.ceil(right), Math.ceil(bottom)],
        line,
      });
    }
  }
  return pages;
}

function crop(raster: Raster, [x0, y0, x1, y1]: Box, pad: number): Raster {
  const width = x1 - x0 + 2 * pad;
  const height = y1 - y0 + 2 * pad;
  const pixels = new Uint8Array(width * height).fill(255);
  for (let y = y0; y < y1; y += 1) {
    const row = y * raster.width;
    pixels.set(raster.pixels.subarray(row + x0, row + x1), (y - y0 + pad) * width + pad);
  }
  return { width, height, pixels };
}

function enclosingBox(items: readonly Glyph[], raster: Raster, padding = 0): Box {
  const bounds: Box = [raster.width, raster.height, 0, 0];
  for (const {
    box: [x0, y0, x1, y1],
  } of items) {
    bounds[0] = Math.min(bounds[0], x0);
    bounds[1] = Math.min(bounds[1], y0);
    bounds[2] = Math.max(bounds[2], x1);
    bounds[3] = Math.max(bounds[3], y1);
  }
  return [
    Math.max(0, bounds[0] - padding),
    Math.max(0, bounds[1] - padding),
    Math.min(raster.width, bounds[2] + padding),
    Math.min(raster.height, bounds[3] + padding),
  ];
}

async function writeSample(
  directory: string,
  base: string,
  raster: Raster,
  origin: string,
  lines: ReadonlyArray<readonly Word[]>,
  preset: string,
  seed: string,
  dpi: number,
  profile: ReturnType<typeof scanProfile>,
) {
  const { width, height } = raster;
  const params = degradation(preset, seed, base, profile);
  const id = preset === "clean" ? base : `${base}-${preset}-${params.seed.toString(16)}`;
  const labels = lines
    .map((line) =>
      line.flatMap((word) => {
        const box = mapDegradedBox(word.box, raster, params);
        return box[0] < box[2] && box[1] < box[3] ? [{ ...word, box }] : [];
      }),
    )
    .filter((line) => line.length > 0);
  if (labels.length === 0) return false;
  const words = labels.flatMap((line, index) =>
    line.map(({ text, box }) => ({ text, box, line: index })),
  );
  const glyphs = labels.flatMap((line) =>
    line
      .flatMap((word) => word.glyphs ?? [])
      .flatMap(({ text, box }) => {
        const mapped = mapDegradedBox(box, raster, params);
        return mapped[0] < mapped[2] && mapped[1] < mapped[3] ? [{ text, box: mapped }] : [];
      }),
  );
  const text = labels.map((line) => line.map((word) => word.text).join(" ")).join("\n");
  const image =
    preset === "clean" ? { pgm: pgm(raster), jpeg: undefined } : await degrade(raster, params);
  if (image === undefined) return false;
  await Bun.write(join(directory, `${id}.pgm`), image.pgm);
  if (image.jpeg !== undefined) await Bun.write(join(directory, `${id}.jpg`), image.jpeg);
  await Bun.write(
    join(directory, `${id}.json`),
    `${JSON.stringify({ id, dpi, width, height, source: origin, degradation: params, text, words, glyphs: pdfCore === undefined ? undefined : glyphs })}\n`,
  );
  return true;
}

async function* rasterStream(source: ReadableStream<Uint8Array>): AsyncGenerator<Raster> {
  const decoder = new TextDecoder();
  const header = new Uint8Array(96);
  let headerLength = 0;
  let raster: Raster | undefined;
  let filled = 0;
  let newlines = 0;
  for await (const bytes of source) {
    let offset = 0;
    while (offset < bytes.length) {
      if (raster === undefined) {
        const byte = bytes[offset];
        if (byte === undefined || headerLength === header.length) return;
        header[headerLength] = byte;
        headerLength += 1;
        offset += 1;
        if (byte === 10) newlines += 1;
        if (newlines !== 3) continue;
        const match = /^P5\n(\d+) (\d+)\n255\n$/u.exec(
          decoder.decode(header.subarray(0, headerLength)),
        );
        if (match === null) return;
        const width = Number(match[1]);
        const height = Number(match[2]);
        const size = width * height;
        if (!Number.isSafeInteger(size) || size < 1 || size > 32_000_000) return;
        raster = { width, height, pixels: new Uint8Array(size) };
        filled = 0;
        headerLength = 0;
        newlines = 0;
      }
      const count = Math.min(bytes.length - offset, raster.pixels.length - filled);
      raster.pixels.set(bytes.subarray(offset, offset + count), filled);
      offset += count;
      filled += count;
      if (filled === raster.pixels.length) {
        yield raster;
        raster = undefined;
      }
    }
  }
}

async function streamTrainingDocument(
  file: string,
  target: string,
  dpi: number,
  labels: Map<number, Word[]>,
  seed: number,
) {
  let lastPage = 0;
  for (const page of labels.keys()) lastPage = Math.max(page, lastPage);
  const child = Bun.spawn(
    ["pdftoppm", "-q", "-cropbox", "-gray", "-r", String(dpi), "-l", String(lastPage), file],
    { stdout: "pipe", stderr: "inherit" },
  );
  const temporary = `${target}.${process.pid}.partial`;
  const writer = Bun.file(temporary).writer({ highWaterMark: 1024 * 1024 });
  const encoder = new TextEncoder();
  let page = 0;
  let pages = 0;
  let samples = 0;
  let words = 0;
  let closed = false;
  try {
    writer.write(trainingLineHeader);
    for await (const raster of rasterStream(child.stdout)) {
      page += 1;
      const groups = Map.groupBy(labels.get(page) ?? [], (word) => word.line);
      if (groups.size === 0) continue;
      pages += 1;
      for (const [line, items] of groups) {
        const [left, top, right, bottom] = enclosingBox(items, raster);
        const text = items
          .map((word) => word.text.replace(/\p{Cc}/gu, " "))
          .join(" ")
          .normalize("NFC")
          .trim();
        if (left >= right || top >= bottom || text.length === 0) continue;
        writer.write(
          augment(
            raster,
            Math.max(0, left - 2),
            Math.max(0, top - 1),
            Math.min(raster.width, right + 2),
            Math.min(raster.height, bottom + 1),
            encoder.encode(text),
            mix(seed ^ mix(page) ^ mix(line)),
          ),
        );
        samples += 1;
        words += items.length;
      }
    }
    if (page !== lastPage) child.kill();
    const status = await child.exited;
    await writer.end();
    closed = true;
    if (status !== 0 || page !== lastPage) return undefined;
    if (samples > 0) await rename(temporary, target);
    return { pages, samples, words };
  } finally {
    if (!closed) {
      child.kill();
      await writer.end();
    }
    await rm(temporary, { force: true });
  }
}

const started = performance.now();
let documents = 0;
let pages = 0;
let samples = 0;
let failed = 0;
let sourceWords = 0;
let matchedWords = 0;
let resumedDocuments = 0;
if (trainingShards) await mkdir(join(output, "train"), { recursive: true });

for await (const file of pdfFiles(pdfRoot)) {
  const key = relative(root, file).split(sep).join("/");
  const digest = createHash("sha256").update(key).digest("hex");
  const profile = preset === "calibrated" ? scanProfile(seed, key) : undefined;
  const dpi = values.dpi === "calibrated" ? (profile?.dpi ?? requestedDpi) : requestedDpi;
  if (preset === "calibrated" && profile === undefined) {
    console.error("Missing calibrated scan profile");
    process.exit(1);
  }
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 100;
  const split = bucket < 80 ? "train" : bucket < 90 ? "val" : "test";
  if (selectedSplit !== "all" && selectedSplit !== split) continue;
  if (Number.parseInt(digest.slice(8, 16), 16) % partitions !== partition) continue;
  if (documents >= maxDocs) break;
  documents += 1;
  const directory = join(output, split);
  const shardId = createHash("sha256")
    .update(JSON.stringify({ key, seed, dpi, maxPages, preset }))
    .digest("hex");
  const target = join(directory, `${shardId}.ocrl`);
  if (trainingShards && (await Bun.file(target).exists())) {
    resumedDocuments += 1;
    continue;
  }
  const pagesArgs = maxPages === Number.MAX_SAFE_INTEGER ? [] : ["-l", String(maxPages)];
  const extracted = await run([
    "pdftotext",
    "-q",
    "-cropbox",
    "-tsv",
    "-r",
    String(dpi),
    ...pagesArgs,
    file,
    "-",
  ]);
  if (extracted === undefined) {
    failed += 1;
    console.error(`Could not extract labels from ${file}`);
    continue;
  }
  const labelsByPage = parsePages(new TextDecoder().decode(extracted));
  if (trainingShards) {
    if (![...labelsByPage.values()].some((words) => words.length > 0)) continue;
    const result = await streamTrainingDocument(
      file,
      target,
      dpi,
      labelsByPage,
      Number.parseInt(shardId.slice(0, 8), 16),
    );
    if (result === undefined) {
      failed += 1;
      console.error(`Could not stream training pages from ${file}`);
    } else {
      samples += result.samples;
      pages += result.pages;
      sourceWords += result.words;
      matchedWords += result.words;
      console.log(JSON.stringify({ partition, documents, pages, samples, failed }));
    }
    continue;
  }
  const input = pdfCore === undefined ? undefined : await Bun.file(file).bytes();
  for (const [page, words] of labelsByPage) {
    if (words.length === 0) continue;
    const bytes = await run([
      "pdftoppm",
      "-q",
      "-cropbox",
      "-gray",
      "-r",
      String(dpi),
      "-f",
      String(page),
      "-l",
      String(page),
      "-singlefile",
      file,
    ]);
    const raster = bytes === undefined ? undefined : parsePgm(bytes);
    if (raster === undefined) {
      failed += 1;
      console.error(`Could not render ${file} page ${page}`);
      continue;
    }
    let glyphs: ReturnType<NonNullable<typeof labeler>["indexGlyphs"]> | undefined;
    if (input !== undefined && pdfCore !== undefined && labeler !== undefined) {
      const labels = await labeler
        .glyphLabels(pdfCore, input, page - 1, dpi)
        .catch((cause: unknown) => {
          console.error(`Could not inspect glyphs in ${file} page ${page}: ${String(cause)}`);
          return undefined;
        });
      if (labels === undefined) {
        failed += 1;
        continue;
      }
      glyphs = labeler.indexGlyphs(labels, raster);
    }
    const lines = new Map<number, Word[]>();
    for (const word of words) {
      const [x0, y0, x1, y1] = word.box;
      const box: Box = [
        Math.max(0, x0),
        Math.max(0, y0),
        Math.min(raster.width, x1),
        Math.min(raster.height, y1),
      ];
      if (box[0] >= box[2] || box[1] >= box[3]) continue;
      sourceWords += 1;
      const matching = glyphs?.({ text: word.text, box });
      if (matching?.length === 0) continue;
      matchedWords += 1;
      const line = lines.get(word.line) ?? [];
      line.push(
        matching === undefined
          ? { ...word, box }
          : { ...word, box: enclosingBox(matching, raster), glyphs: matching },
      );
      lines.set(word.line, line);
    }
    if (lines.size === 0) continue;
    await mkdir(directory, { recursive: true });
    const origin = `${file}#page=${page - 1}`;
    const id = `${digest.slice(0, 20)}-p${page - 1}-${dpi}${labelSource === "poppler" ? "-poppler" : ""}`;
    if (mode === "pages") {
      if (
        await writeSample(
          directory,
          id,
          raster,
          origin,
          [...lines.values()],
          preset,
          seed,
          dpi,
          profile,
        )
      )
        samples += 1;
      else failed += 1;
    } else {
      for (const [line, items] of lines) {
        const box = enclosingBox(items, raster, 4);
        const [left, top, right] = box;
        const padding = preset === "clean" ? 0 : Math.ceil((right - left) * 0.027) + 4;
        const relocate = ([x0, y0, x1, y1]: Box): Box => [
          x0 - left + padding,
          y0 - top + padding,
          x1 - left + padding,
          y1 - top + padding,
        ];
        const labels = items.map(({ text, line: index, box, glyphs }): Word => ({
          text,
          line: index,
          box: relocate(box),
          ...(glyphs === undefined
            ? {}
            : { glyphs: glyphs.map(({ text, box }) => ({ text, box: relocate(box) })) }),
        }));
        if (
          await writeSample(
            directory,
            `${id}-l${line}`,
            crop(raster, box, padding),
            origin,
            [labels],
            preset,
            seed,
            dpi,
            profile,
          )
        )
          samples += 1;
        else failed += 1;
      }
    }
    pages += 1;
  }
}

console.log(
  JSON.stringify({
    documents,
    resumedDocuments,
    pages,
    samples,
    failed,
    sourceWords,
    matchedWords,
    seconds: (performance.now() - started) / 1000,
    output,
  }),
);
if ((samples === 0 && resumedDocuments === 0) || failed > 0) process.exitCode = 1;
