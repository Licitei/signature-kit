import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { Effect } from "effect";
import { build } from "vite";

const run = promisify(execFile);
const baseline = process.argv[2] ?? "origin/v2-02-local-runtime";
const root = resolve(import.meta.dirname, "../../..");
const cache = resolve(root, "runtime/local/.cache");
const baselineFiles = ["a1-certificate.ts", "engine.ts", "protocol.ts", "worker.ts"];

const measure = (directory: string, worker: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      writeFile(
        resolve(directory, "index.html"),
        `<script type="module">import LocalWorker from "${worker}?worker"; new LocalWorker();</script>`,
      ),
    );
    yield* Effect.promise(() =>
      build({ root: directory, configFile: false, build: { assetsInlineLimit: 0 } }),
    );
    const assets = resolve(directory, "dist/assets");
    const filenames = yield* Effect.promise(() => readdir(assets));
    return yield* Effect.forEach(
      filenames.filter((name) => name.startsWith("worker-") || name.endsWith(".wasm")),
      (name) =>
        Effect.promise(async () => {
          const file = await readFile(resolve(assets, name));
          return { name, bytes: file.byteLength, gzipBytes: gzipSync(file).byteLength };
        }),
    );
  });

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(cache, { recursive: true }));
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(resolve(cache, "viewer-bundle-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const beforeDir = resolve(directory, "before");
      const afterDir = resolve(directory, "after");
      yield* Effect.promise(() => mkdir(beforeDir));
      yield* Effect.promise(() => mkdir(afterDir));
      yield* Effect.forEach(
        baselineFiles,
        (filename) =>
          Effect.promise(async (signal) => {
            const { stdout } = await run(
              "git",
              ["show", `${baseline}:runtime/local/src/${filename}`],
              { cwd: root, signal },
            );
            await writeFile(resolve(beforeDir, filename), stdout);
          }),
        { discard: true },
      );
      const before = yield* measure(beforeDir, "./worker.ts");
      const after = yield* measure(afterDir, "@signature-kit/local/worker");
      console.info(JSON.stringify({ baseline, before, after }, null, 2));
    }),
  ),
);
