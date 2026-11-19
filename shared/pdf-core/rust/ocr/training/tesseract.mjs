import { readFile } from "node:fs/promises";

function editCount(reference, output) {
  const characters = Array.from(output);
  let prior = Array.from({ length: characters.length + 1 }, (_, index) => index);
  for (const left of reference) {
    const row = [prior[0] + 1];
    for (const [index, right] of characters.entries()) {
      row.push(Math.min(prior[index] + Number(left !== right), row[index] + 1, prior[index + 1] + 1));
    }
    prior = row;
  }
  return prior.at(-1);
}

const [archive, executable = "tesseract"] = process.argv.slice(2);
const bytes = await readFile(archive);
if (bytes.toString("ascii", 0, 4) !== "OCRT") {
  throw new Error("Invalid OCR archive");
}
let position = 4;
function number() {
  const value = bytes.readUInt32LE(position);
  position += 4;
  return value;
}
const lines = number();
let edits = 0;
let characters = 0;
let elapsed = 0;
for (let line = 0; line < lines; line += 1) {
  const width = number();
  const height = number();
  position += 8;
  const words = number();
  const glyphs = number();
  const image = bytes.subarray(position, position + width * height).map((ink) => ink === 0 ? 255 : 0);
  position += image.length;
  const transcript = [];
  for (let label = 0; label < words + glyphs; label += 1) {
    position += 16;
    const size = number();
    if (label < words) transcript.push(bytes.toString("utf8", position, position + size));
    position += size;
  }
  const reference = transcript.join("").normalize("NFC").replace(/\s/gu, "");
  const input = new Blob([`P5\n${width} ${height}\n255\n`, image]);
  const start = performance.now();
  const child = Bun.spawn([executable, "stdin", "stdout", "-l", "por", "--oem", "1", "--psm", "7"], {
    stdin: input,
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, OMP_THREAD_LIMIT: "1" },
  });
  const [text, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (status !== 0) throw new Error(`Tesseract exited with status ${status} on line ${line}`);
  elapsed += performance.now() - start;
  edits += editCount(reference, text.normalize("NFC").replace(/\s/gu, ""));
  characters += Array.from(reference).length;
}
if (lines === 0 || position !== bytes.length) throw new Error("Invalid or empty OCR archive");
console.log(JSON.stringify({ lines, edits, characters, accuracy: 1 - edits / characters, msPer50Lines: elapsed * 50 / lines }));
