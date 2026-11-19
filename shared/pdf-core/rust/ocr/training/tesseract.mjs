import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function editCount(reference, output) {
  const characters = Array.from(output);
  let prior = Array.from({ length: characters.length + 1 }, (_, index) => index);
  for (const left of reference) {
    const row = [prior[0] + 1];
    for (const [index, right] of characters.entries()) {
      row.push(
        Math.min(prior[index] + Number(left !== right), row[index] + 1, prior[index + 1] + 1),
      );
    }
    prior = row;
  }
  return prior.at(-1);
}

const normalize = (text) => text.normalize("NFC").replace(/\s/gu, "");

async function load(archive, directory) {
  const bytes = await readFile(archive);
  if (bytes.toString("ascii", 0, 4) !== "OCRT") throw new Error("Invalid OCR archive");
  let position = 4;
  function number() {
    const value = bytes.readUInt32LE(position);
    position += 4;
    return value;
  }
  const lines = number();
  const expected = [];
  const images = [];
  for (let line = 0; line < lines; line += 1) {
    const width = number();
    const height = number();
    position += 8;
    const words = number();
    const glyphs = number();
    const image = bytes
      .subarray(position, position + width * height)
      .map((ink) => (ink === 0 ? 255 : 0));
    position += image.length;
    const transcript = [];
    for (let label = 0; label < words + glyphs; label += 1) {
      position += 16;
      const size = number();
      if (label < words) transcript.push(bytes.toString("utf8", position, position + size));
      position += size;
    }
    const file = join(directory, `${line}.pgm`);
    await Bun.write(file, new Blob([`P5\n${width} ${height}\n255\n`, image]));
    images.push(file);
    expected.push(normalize(transcript.join("")));
  }
  if (lines === 0 || position !== bytes.length) throw new Error("Invalid or empty OCR archive");
  const list = join(directory, "images.txt");
  await writeFile(list, `${images.join("\n")}\n`);
  return { list, expected };
}

async function compare(archive, executable, directory) {
  const { list, expected } = await load(archive, directory);
  const start = performance.now();
  const child = Bun.spawn([executable, list, "stdout", "-l", "por", "--oem", "1", "--psm", "7"], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, OMP_THREAD_LIMIT: "1" },
  });
  const [text, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const elapsed = performance.now() - start;
  if (status !== 0) throw new Error(`Tesseract exited with status ${status}`);
  const output = text.replace(/\f$/, "").split("\f");
  if (output.length !== expected.length)
    throw new Error("Tesseract output does not match the input line count");
  let edits = 0;
  let characters = 0;
  for (const [index, reference] of expected.entries()) {
    edits += editCount(reference, normalize(output[index]));
    characters += Array.from(reference).length;
  }
  console.log(
    JSON.stringify({
      lines: expected.length,
      edits,
      characters,
      accuracy: 1 - edits / characters,
      msPer50Lines: (elapsed * 50) / expected.length,
    }),
  );
}

const [archive, executable = "tesseract"] = process.argv.slice(2);
const directory = await mkdtemp(join(tmpdir(), "ocr-tesseract-"));
await compare(archive, executable, directory).finally(() => rm(directory, { recursive: true }));
