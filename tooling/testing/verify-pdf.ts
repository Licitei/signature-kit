import { Effect } from "effect";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const verifyIndependently = (pdf: Uint8Array, count: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "signature-kit-v2-"))),
        (path) => Effect.promise(() => rm(path, { force: true, recursive: true })),
      );
      const file = join(dir, "signed.pdf");
      yield* Effect.promise(() => writeFile(file, pdf));
      yield* Effect.promise(() => run("qpdf", ["--check", file]));
      const { stdout } = yield* Effect.promise(() => run("pdfsig", ["-nocert", file]));
      assert.equal(stdout.match(/Signature Validation: Signature is Valid\./g)?.length, count);

      const ranges = [...stdout.matchAll(/Signed Ranges: \[0 - (\d+)\], \[(\d+) - (\d+)\]/g)];
      assert.equal(ranges.length, count);
      yield* Effect.promise(() => run("pdfsig", ["-dump", file], { cwd: dir }));
      for (const [index, [, firstEnd, secondStart, secondEnd]] of ranges.entries()) {
        const signatureFile = join(dir, `signed.pdf.sig${index}`);
        const contentsFile = join(dir, "signed-data");
        yield* Effect.promise(() =>
          writeFile(
            contentsFile,
            Buffer.concat([
              pdf.subarray(0, Number(firstEnd)),
              pdf.subarray(Number(secondStart), Number(secondEnd)),
            ]),
          ),
        );
        yield* Effect.promise(() =>
          run("openssl", [
            "cms",
            "-verify",
            "-binary",
            "-inform",
            "DER",
            "-in",
            signatureFile,
            "-content",
            contentsFile,
            "-noverify",
            "-out",
            join(dir, "verified-data"),
          ]),
        );
      }
    }),
  );
