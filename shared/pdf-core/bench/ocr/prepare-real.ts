import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { BenchmarkError, runCommand } from "./engines.ts";
import { ReferenceSchema } from "./metrics.ts";

const [root, output] = process.argv.slice(2);
const references = join(import.meta.dir, "reference");
const decodeReference = Schema.decodeUnknownEffect(Schema.fromJsonString(ReferenceSchema));

const prepare = Effect.scoped(
  Effect.gen(function* () {
    if (root === undefined || root.length === 0 || output === undefined || output.length === 0) {
      return yield* new BenchmarkError({
        reason: "Usage: bun prepare-real.ts CORPUS_DIGITALIZADOS OUTPUT_DIR",
      });
    }
    const destination: string = resolve(output);
    const sourceRoot: string = resolve(root);
    if (destination === sourceRoot || destination.startsWith(`${sourceRoot}/`)) {
      return yield* new BenchmarkError({ reason: "Choose an output directory outside the corpus" });
    }
    mkdirSync(destination, { recursive: true });
    const scratch = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "pdf-core-ocr-extract-"))),
      (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
    );
    const files = readdirSync(references)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const file of files) {
      const referencePath = join(references, file);
      const reference = yield* decodeReference(readFileSync(referencePath, "utf8"));
      const location = /^([a-z0-9_-]+)\/edital\.pdf#page=([1-9]\d*)$/u.exec(reference.source);
      const directory = location?.[1];
      const page = location?.[2];
      if (directory === undefined || page === undefined || reference.imageSha256 === undefined) {
        return yield* new BenchmarkError({
          reason: `Incomplete scan provenance for ${reference.id}`,
        });
      }
      const pdf = join(sourceRoot, directory, "edital.pdf");
      const prefix = join(scratch, reference.id);
      yield* runCommand(["pdfimages", "-f", page, "-l", page, "-j", pdf, prefix]);
      const images = readdirSync(scratch).filter((name) => name.startsWith(`${reference.id}-`));
      const [image] = images;
      if (images.length !== 1 || image === undefined) {
        return yield* new BenchmarkError({
          reason: `Expected one XObject image for ${reference.id}`,
        });
      }
      const pgm = `${prefix}.pgm`;
      yield* runCommand([
        "magick",
        join(scratch, image),
        "-colorspace",
        "Gray",
        "-depth",
        "8",
        pgm,
      ]);
      const digest = createHash("sha256").update(readFileSync(pgm)).digest("hex");
      if (digest !== reference.imageSha256) {
        return yield* new BenchmarkError({
          reason: `Extracted image hash mismatch for ${reference.id}`,
        });
      }
      copyFileSync(pgm, join(destination, `${reference.id}.pgm`));
      copyFileSync(referencePath, join(destination, `${reference.id}.json`));
    }
    console.log(`Prepared ${files.length} hash-verified images in ${destination}`);
  }),
);

await Effect.runPromise(prepare);
