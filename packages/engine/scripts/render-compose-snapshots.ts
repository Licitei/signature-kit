import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { compose } from "../dist/compose.js";
import {
  contractTemplate,
  evidenceReportTemplate,
  receiptTemplate,
  sampleEvidence,
} from "../dist/templates.js";
import { composeFileLayer } from "../dist/wasm/compose.js";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../__tests__/compose/__snapshots__/", import.meta.url));
const runtime = composeFileLayer.pipe(Layer.provide(NodeServices.layer));

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "signature-kit-compose-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true })),
      );
      for (const [name, document] of [
        ["contract", contractTemplate()],
        ["report", evidenceReportTemplate(sampleEvidence)],
        ["receipt", receiptTemplate()],
      ] satisfies ReadonlyArray<readonly [string, Parameters<typeof compose>[0]]>) {
        const file = join(directory, `${name}.pdf`);
        const bytes = yield* compose(document);
        yield* Effect.promise(() => writeFile(file, bytes));
        for (const [tool, args] of [
          ["qpdf", ["--check", file]],
          ["pdffonts", [file]],
          ["pdftoppm", ["-r", "110", "-png", file, join(output, name)]],
        ] satisfies ReadonlyArray<readonly [string, string[]]>) {
          const result = spawnSync(tool, args, { encoding: "utf8" });
          if (result.status !== 0)
            return yield* Effect.fail(`${tool} failed for ${name}: ${result.stderr}`);
          console.log(`${name} ${tool}\n${result.stdout.trim()}`);
        }
      }
    }),
  ).pipe(Effect.provide(runtime)),
);
