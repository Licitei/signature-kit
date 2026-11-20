import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanLine, mix, trainingLineHeader } from "../../../bench/ocr/training-raster.ts";
import { buildPdf, documents, runPdf, stream } from "./generate.mjs";

const encoder = new TextEncoder();
const sizes = [18, 23, 29, 35, 43];
const sha = (data) => createHash("sha256").update(data).digest();

function fontMetrics(font) {
  if (font.length < 12 || ![0x00010000, 0x74727565].includes(font.readUInt32BE(0))) return;
  const tables = new Map();
  const count = font.readUInt16BE(4);
  if (12 + 16 * count > font.length) return;
  for (let index = 0; index < count; index++) {
    const entry = 12 + 16 * index;
    const offset = font.readUInt32BE(entry + 8);
    const length = font.readUInt32BE(entry + 12);
    if (offset + length > font.length) return;
    tables.set(font.toString("ascii", entry, entry + 4), font.subarray(offset, offset + length));
  }
  const [cmap, head, hhea, hmtx, loca, maxp, glyf] =
    ["cmap", "head", "hhea", "hmtx", "loca", "maxp", "glyf"].map((name) => tables.get(name));
  if (
    cmap?.length < 4 || !cmap || head?.length < 54 || !head || hhea?.length < 36 || !hhea ||
    !hmtx || !loca || maxp?.length < 6 || !maxp || !glyf
  ) return;
  const units = head.readUInt16BE(18);
  const glyphs = maxp.readUInt16BE(4);
  const metrics = hhea.readUInt16BE(34);
  const long = head.readInt16BE(50) === 1;
  if (!units || !metrics || 4 * metrics > hmtx.length || (glyphs + 1) * (long ? 4 : 2) > loca.length)
    return;
  const offset = (gid) => long ? loca.readUInt32BE(4 * gid) : 2 * loca.readUInt16BE(2 * gid);
  const mapping = new Map();
  const cmaps = cmap.readUInt16BE(2);
  if (4 + 8 * cmaps > cmap.length) return;
  const subtables = [];
  for (let index = 0; index < cmaps; index++) {
    const entry = 4 + 8 * index;
    const platform = cmap.readUInt16BE(entry);
    const encoding = cmap.readUInt16BE(entry + 2);
    const start = cmap.readUInt32BE(entry + 4);
    if ((platform === 0 || (platform === 3 && [1, 10].includes(encoding))) &&
        start + 2 <= cmap.length)
      subtables.push(cmap.subarray(start));
  }
  return (char) => {
    if (mapping.has(char)) return mapping.get(char);
    const code = char.codePointAt(0);
    for (const subtable of subtables) {
      const gid = glyphId(subtable, code);
      if (gid <= 0 || gid >= glyphs) continue;
      const position = offset(gid);
      if (char !== " " && (position >= offset(gid + 1) || position >= glyf.length)) continue;
      const width = Math.round(hmtx.readUInt16BE(4 * Math.min(gid, metrics - 1)) * 1000 / units);
      const result = { gid, width };
      mapping.set(char, result);
      return result;
    }
    mapping.set(char, undefined);
  };
}

function glyphId(data, code) {
  const format = data.readUInt16BE(0);
  if (format === 12 && data.length >= 16) {
    let lower = 0;
    let upper = data.readUInt32BE(12);
    if (16 + 12 * upper > data.length) return 0;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      const offset = 16 + 12 * middle;
      const first = data.readUInt32BE(offset);
      const last = data.readUInt32BE(offset + 4);
      if (code < first) upper = middle;
      else if (code > last) lower = middle + 1;
      else return data.readUInt32BE(offset + 8) + code - first;
    }
  }
  if (format === 4 && code <= 0xffff && data.length >= 16) {
    const length = data.readUInt16BE(2);
    const segments = data.readUInt16BE(6) >>> 1;
    if (length > data.length || 16 + 8 * segments > length) return 0;
    let lower = 0;
    let upper = segments;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (data.readUInt16BE(14 + 2 * middle) < code) lower = middle + 1;
      else upper = middle;
    }
    if (lower === segments) return 0;
    const start = data.readUInt16BE(16 + 2 * (segments + lower));
    if (code < start) return 0;
    const delta = data.readInt16BE(16 + 2 * (2 * segments + lower));
    const index = 16 + 2 * (3 * segments + lower);
    const range = data.readUInt16BE(index);
    if (range === 0) return (code + delta) & 0xffff;
    const target = index + range + 2 * (code - start);
    if (target + 2 > length) return 0;
    const gid = data.readUInt16BE(target);
    return gid === 0 ? 0 : (gid + delta) & 0xffff;
  }
  return 0;
}

async function qpdf(args) {
  const process = Bun.spawn(["qpdf", "--warning-exit-0", ...args], {
    stdout: "pipe", stderr: "inherit",
  });
  const [bytes, status] = await Promise.all([
    new Response(process.stdout).arrayBuffer(), process.exited,
  ]);
  return status === 0 ? Buffer.from(bytes) : undefined;
}

async function fontsFromCorpus(root, excluded, alphabet) {
  const candidates = [];
  for await (const key of documents(root)) {
    if (!excluded.has(key) && sha(key).readUInt32BE() % 100 < 80) candidates.push(key);
  }
  candidates.sort((left, right) => sha(left).readUInt32BE(4) - sha(right).readUInt32BE(4));
  const seen = new Set();
  const fonts = [];
  for (const key of candidates.slice(0, 160)) {
    if (fonts.length >= 48) break;
    const path = join(root, key);
    const dictionary = await qpdf(["--json", "--json-key=qpdf", path]);
    if (!dictionary) continue;
    const refs = new Set(Object.values(JSON.parse(dictionary.toString()).qpdf[1]).flatMap((item) => {
      const value = item.value?.["/FontFile2"];
      return typeof value === "string" && /^\d+ \d+ R$/u.test(value) ? [value] : [];
    }));
    for (const ref of refs) {
      const font = await qpdf([`--show-object=${ref.split(" ").slice(0, 2).join(",")}`,
        "--filtered-stream-data", path]);
      if (!font) continue;
      const digest = sha(font).toString("hex");
      if (seen.has(digest)) continue;
      seen.add(digest);
      const glyph = fontMetrics(font);
      if (glyph && [..." zaé0"].filter((char) => glyph(char)).length >= 3) {
        const coverage = new Map([...alphabet].flatMap((char) => {
          const metric = glyph(char);
          return metric ? [[char, metric]] : [];
        }));
        if (coverage.has(" ") && coverage.size >= 40) fonts.push({ font, coverage, key, digest });
      }
    }
  }
  return fonts;
}

async function sentenceCandidates(shards, alphabet) {
  const counts = new Map();
  const candidates = new Map();
  for (const path of shards) {
    const input = Bun.file(path);
    assert.equal(await input.slice(0, 8).text(), trainingLineHeader);
    for (let offset = 8; offset < input.size;) {
      const header = new DataView(await input.slice(offset, offset + 8).arrayBuffer());
      const pixels = header.getUint16(0, true) * header.getUint16(2, true);
      const length = header.getUint32(4, true);
      const start = offset + 8 + pixels;
      offset = start + length;
      assert(offset <= input.size && length > 0 && pixels > 0, "Corrupt OCRL source");
      if (length > 160 || length < 8 || mix(start) % 13 !== 0) continue;
      const text = (await input.slice(start, offset).text()).normalize("NFC").replace(/\s+/gu, " ").trim();
      const chars = new Set(text);
      if (text.length < 8 || text.length > 105 || [...chars].some((char) => !alphabet.has(char)))
        continue;
      for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1);
      candidates.set(text, chars);
    }
  }
  return [...candidates].map(([text, chars]) => ({
    text, chars, rate: Math.min(...[...chars].map((char) => counts.get(char))),
  })).sort((left, right) => left.rate - right.rate ||
    sha(left.text).readUInt32BE() - sha(right.text).readUInt32BE());
}

async function renderSheet(pdf, ocr, font, lines) {
  const widths = new Map();
  const rowHeight = 76;
  const height = rowHeight * lines.length;
  let width = 0;
  const contents = lines.map(({ text, size }, index) => {
    let advance = 0;
    const codes = [...text].map((char) => {
      const { gid, width } = font.coverage.get(char);
      widths.set(gid, width);
      advance += width * size / 1000;
      return gid.toString(16).padStart(4, "0");
    });
    width = Math.max(width, Math.ceil(advance + 24));
    return `/F ${size} Tf 1 0 0 1 10 ${height - index * rowHeight - 52} Tm <${codes.join("")}> Tj`;
  });
  const pdfBytes = await buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F 4 0 R >> >> /Contents 8 0 R >>`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /Corpus /Encoding /Identity-H /DescendantFonts [5 0 R] >>",
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Corpus /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /CIDToGIDMap /Identity /FontDescriptor 6 0 R /W [${[...widths].map(([id, value]) => `${id} [${value}]`).join(" ")}] >>`,
    "<< /Type /FontDescriptor /FontName /Corpus /Flags 32 /FontBBox [-500 -500 1500 1500] /ItalicAngle 0 /Ascent 900 /Descent -270 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>",
    stream(`/Length1 ${font.font.length}`, font.font),
    stream("", encoder.encode(`BT\n${contents.join("\n")}\nET`)),
  ]);
  const { status, payload } = runPdf(pdf, pdfBytes, (input) =>
    pdf.exports.pdf_core_render(input, pdfBytes.length, 0, 0, 0, 1),
  );
  assert.equal(status, 0, "Corpus glyph sheet could not be drawn");
  using storage = new DisposableStack();
  const ptr = ocr.pdf_core_ocr_raster_alloc(payload.length);
  assert(ptr, "Cannot allocate display list");
  storage.defer(() => ocr.pdf_core_ocr_raster_free(ptr, payload.length));
  new Uint8Array(ocr.memory.buffer, ptr, payload.length).set(payload);
  const output = ocr.pdf_core_ocr_rasterize(ptr, payload.length, 1000);
  assert(output, "OCR rasterizer rejected glyph sheet");
  storage.defer(() => ocr.pdf_core_ocr_raster_free(output, pixels.length + 8));
  const view = new DataView(ocr.memory.buffer, output);
  assert.equal(view.getUint32(0, true), width);
  assert.equal(view.getUint32(4, true), height);
  const pixels = new Uint8Array(ocr.memory.buffer, output + 8, width * height);
  return lines.map(({ text }, index) => {
    const top = rowHeight * index;
    const bottom = top + rowHeight;
    let minimumX = width;
    let maximumX = 0;
    let minimumY = bottom;
    let maximumY = top;
    for (let y = top; y < bottom; y++) {
      for (let x = 0; x < width; x++) {
        if (pixels[y * width + x] >= 196) continue;
        minimumX = Math.min(x, minimumX);
        maximumX = Math.max(x + 1, maximumX);
        minimumY = Math.min(y, minimumY);
        maximumY = Math.max(y + 1, maximumY);
      }
    }
    assert(minimumX < maximumX && minimumY < maximumY, "Embedded font produced a blank line");
    return cleanLine({ width, height, pixels }, [minimumX, minimumY, maximumX, maximumY],
      encoder.encode(text));
  });
}

const [corePath, ocrPath, corpus, roster, excludes, output, countArg] = process.argv.slice(2);
const count = Number(countArg);
assert(Number.isSafeInteger(count) && count > 0,
  "Usage: bun rare.mjs PDF_WASM OCR_WASM CORPUS TRAIN_ROSTER EXCLUDED_PATHS OUTPUT COUNT");
const alphabet = new Set((await readFile(join(import.meta.dir, "torch/charset.txt"), "utf8"))
  .trim().split(/\s+/u).map((code) => String.fromCodePoint(Number.parseInt(code, 16))));
const excluded = new Set((await readFile(excludes, "utf8")).trim().split(/\r?\n/u));
const roots = (await readFile(roster, "utf8")).trim().split(/\r?\n/u);
const [fonts, sentences, pdf, ocrWasm] = await Promise.all([
  fontsFromCorpus(corpus, excluded, alphabet),
  sentenceCandidates(roots, alphabet),
  WebAssembly.instantiate(await readFile(corePath)).then(({ instance }) => instance),
  WebAssembly.instantiate(await readFile(ocrPath)).then(({ instance }) => instance.exports),
]);
assert(fonts.length > 0 && sentences.length > 0, "No embedded fonts or eligible corpus sentences");
const lines = fonts.map(() => []);
let selected = 0;
const covered = new Set();
for (const { text, chars } of sentences) {
  if (selected >= count) break;
  const hash = sha(text).readUInt32BE();
  for (const [offset, size] of sizes.entries()) {
    if (selected >= count) break;
    const start = mix(hash ^ offset) % fonts.length;
    for (let attempt = 0; attempt < fonts.length; attempt++) {
      const index = (start + attempt) % fonts.length;
      if (![...chars].every((char) => fonts[index].coverage.has(char))) continue;
      lines[index].push({ text, size });
      selected++;
      for (const char of chars) covered.add(char);
      break;
    }
  }
}
assert.equal(selected, count, "Not enough supported corpus sentence/font combinations");
await mkdir(output, { recursive: false });
const shards = [];
for (const [index, samples] of lines.entries()) {
  if (samples.length === 0) continue;
  const path = resolve(output, `rare-${index.toString().padStart(3, "0")}.ocrl`);
  const partial = path + ".partial";
  const writer = Bun.file(partial).writer();
  try {
    writer.write(trainingLineHeader);
    for (let i = 0; i < samples.length; i += 24) {
      for (const record of await renderSheet(pdf, ocrWasm, fonts[index], samples.slice(i, i + 24)))
        writer.write(record);
    }
    await writer.end();
    await rename(partial, path);
    shards.push(path);
  } finally {
    await writer.end();
    await rm(partial, { force: true });
  }
  console.log(JSON.stringify({ source: fonts[index].key, sha256: fonts[index].digest,
    lines: samples.length }));
}
await writeFile(join(output, "shards.txt"), shards.join("\n") + "\n");
console.log(JSON.stringify({ lines: count, fonts: shards.length, coverage: [...covered].sort().join("") }));
