import { createHash } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

type Box = [number, number, number, number];
type Word = { text: string; box: Box; line: number };
type Raster = { width: number; height: number; pixels: Uint8Array };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string", default: join(import.meta.dir, "../../.cache/ocr-dataset") },
    dpi: { type: "string", default: "300" },
    mode: { type: "string", default: "pages" },
    split: { type: "string", default: "all" },
    "max-docs": { type: "string" },
    "max-pages": { type: "string" },
  },
});

const source = positionals[0];
const dpi = Number(values.dpi);
const mode = values.mode;
const selectedSplit = values.split;
const maxDocs = Number(values["max-docs"] ?? Number.MAX_SAFE_INTEGER);
const maxPages = Number(values["max-pages"] ?? Number.MAX_SAFE_INTEGER);

if (
  positionals.length !== 1 || source === undefined ||
  ![150, 200, 300].includes(dpi) ||
  (mode !== "pages" && mode !== "lines") ||
  !["all", "train", "val", "test"].includes(selectedSplit ?? "") ||
  ![maxDocs, maxPages].every((count) => Number.isSafeInteger(count) && count >= 1)
) {
  console.error("Usage: bun generate-dataset.ts <PDF or directory> [--output DIR] [--dpi 150|200|300] [--mode pages|lines] [--split all|train|val|test] [--max-docs N] [--max-pages N]");
  process.exit(2);
}

const pdfRoot = resolve(source);
const output = resolve(values.output);
const root = (await stat(pdfRoot)).isDirectory() ? pdfRoot : resolve(pdfRoot, "..");

async function* pdfFiles(path: string): AsyncGenerator<string> {
  if (path.split(sep).includes("digitalizados")) return;
  const info = await stat(path);
  if (info.isFile()) {
    if (path.toLowerCase().endsWith(".pdf")) yield path;
    return;
  }
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : Number(left.name !== right.name));
  for (const entry of entries) {
    if (entry.isDirectory()) yield* pdfFiles(join(path, entry.name));
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) yield join(path, entry.name);
  }
}

async function run(argv: string[]): Promise<Uint8Array | undefined> {
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
    if (text && [x, y, right, bottom].every(Number.isFinite) && x < right && y < bottom) {
      words.push({ text, box: [Math.floor(x), Math.floor(y), Math.ceil(right), Math.ceil(bottom)], line });
    }
  }
  return pages;
}

function readPgm(bytes: Uint8Array): Raster | undefined {
  const header = /^P5\s+(\d+)\s+(\d+)\s+255\n/.exec(new TextDecoder().decode(bytes.subarray(0, 80)));
  if (header === null) return undefined;
  const width = Number(header[1]);
  const height = Number(header[2]);
  const pixels = bytes.subarray(header[0].length);
  if (width < 1 || height < 1 || width * height !== pixels.length) return undefined;
  return { width, height, pixels };
}

function crop(raster: Raster, [x0, y0, x1, y1]: Box): Raster {
  const width = x1 - x0;
  const height = y1 - y0;
  const pixels = new Uint8Array(width * height);
  for (let y = y0; y < y1; y += 1) {
    const row = y * raster.width;
    pixels.set(raster.pixels.subarray(row + x0, row + x1), (y - y0) * width);
  }
  return { width, height, pixels };
}

function lineBox(words: readonly Word[], raster: Raster): Box {
  const bounds: Box = [raster.width, raster.height, 0, 0];
  for (const { box: [x0, y0, x1, y1] } of words) {
    bounds[0] = Math.min(bounds[0], x0);
    bounds[1] = Math.min(bounds[1], y0);
    bounds[2] = Math.max(bounds[2], x1);
    bounds[3] = Math.max(bounds[3], y1);
  }
  return [
    Math.max(0, bounds[0] - 4), Math.max(0, bounds[1] - 4),
    Math.min(raster.width, bounds[2] + 4), Math.min(raster.height, bounds[3] + 4),
  ];
}

async function writeSample(
  directory: string, id: string, raster: Raster, origin: string, lines: ReadonlyArray<readonly Word[]>,
) {
  const { width, height, pixels } = raster;
  const words = lines.flatMap((line, index) => line.map((word) => ({ ...word, line: index })));
  const text = lines.map((line) => line.map((word) => word.text).join(" ")).join("\n");
  const pgm = new Blob([new TextEncoder().encode(`P5\n${width} ${height}\n255\n`), pixels]);
  await Bun.write(join(directory, `${id}.pgm`), pgm);
  await Bun.write(join(directory, `${id}.json`), `${JSON.stringify({ id, dpi, width, height, source: origin, degradation: {}, text, words })}\n`);
}

const started = performance.now();
let documents = 0;
let pages = 0;
let samples = 0;
let failed = 0;

for await (const file of pdfFiles(pdfRoot)) {
  const key = relative(root, file).split(sep).join("/");
  const digest = createHash("sha256").update(key).digest("hex");
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 100;
  const split = bucket < 80 ? "train" : bucket < 90 ? "val" : "test";
  if (selectedSplit !== "all" && selectedSplit !== split) continue;
  if (documents >= maxDocs) break;
  documents += 1;
  const directory = join(output, split);
  const pagesArgs = maxPages === Number.MAX_SAFE_INTEGER ? [] : ["-l", String(maxPages)];
  const extracted = await run(["pdftotext", "-q", "-cropbox", "-tsv", "-r", String(dpi), ...pagesArgs, file, "-"]);
  if (extracted === undefined) {
    failed += 1;
    console.error(`Could not extract labels from ${file}`);
    continue;
  }
  for (const [page, words] of parsePages(new TextDecoder().decode(extracted))) {
    if (!words.length) continue;
    const bytes = await run(["pdftoppm", "-q", "-cropbox", "-gray", "-r", String(dpi), "-f", String(page), "-l", String(page), "-singlefile", file]);
    const raster = bytes === undefined ? undefined : readPgm(bytes);
    if (raster === undefined) {
      failed += 1;
      console.error(`Could not render ${file} page ${page}`);
      continue;
    }
    const lines = new Map<number, Word[]>();
    for (const word of words) {
      const [x0, y0, x1, y1] = word.box;
      const box: Box = [Math.max(0, x0), Math.max(0, y0), Math.min(raster.width, x1), Math.min(raster.height, y1)];
      if (box[0] >= box[2] || box[1] >= box[3]) continue;
      const line = lines.get(word.line) ?? [];
      line.push({ ...word, box });
      lines.set(word.line, line);
    }
    if (lines.size === 0) continue;
    await mkdir(directory, { recursive: true });
    const origin = `${file}#page=${page - 1}`;
    const id = `${digest.slice(0, 20)}-p${page - 1}-${dpi}`;
    if (mode === "pages") {
      await writeSample(directory, id, raster, origin, [...lines.values()]);
      samples += 1;
    } else {
      for (const [line, items] of lines) {
        const box = lineBox(items, raster);
        const [left, top] = box;
        const labels = items.map(({ text, line: index, box: [x0, y0, x1, y1] }): Word => ({
          text, line: index, box: [x0 - left, y0 - top, x1 - left, y1 - top],
        }));
        await writeSample(directory, `${id}-l${line}`, crop(raster, box), origin, [labels]);
        samples += 1;
      }
    }
    pages += 1;
  }
}

console.log(JSON.stringify({ documents, pages, samples, failed, seconds: (performance.now() - started) / 1000, output }));
if (samples === 0 || failed > 0) process.exitCode = 1;
