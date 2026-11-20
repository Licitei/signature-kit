import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { documents } from "./generate.mjs";

const [root, output] = process.argv.slice(2);
assert(root && output, "Usage: bun split-audit.mjs CORPUS EXCLUDED_PATHS");

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

const train = [];
const heldOut = new Set();
let heldOutDocuments = 0;
for await (const key of documents(root)) {
  const bucket = createHash("sha256").update(key).digest().readUInt32BE() % 100;
  if (bucket < 80) train.push(key);
  else {
    heldOut.add(await digest(join(root, key)));
    heldOutDocuments++;
  }
}
const scans = "editais-extra/digitalizados";
let scannedDocuments = 0;
for await (const key of documents(join(root, scans))) {
  heldOut.add(await digest(join(root, scans, key)));
  scannedDocuments++;
}
const excluded = [];
for (const key of train) {
  if (heldOut.has(await digest(join(root, key)))) excluded.push(key);
}
await writeFile(output, excluded.length === 0 ? "" : excluded.join("\n") + "\n");
console.log(
  JSON.stringify({
    trainDocuments: train.length,
    heldOutDocuments,
    scannedDocuments,
    excluded: excluded.length,
  }),
);
