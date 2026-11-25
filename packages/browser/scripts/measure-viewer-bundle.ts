import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { Effect } from "effect";
import { build } from "vite";

const root = resolve(import.meta.dirname, "../../..");
const browser = resolve(root, process.argv[2] ?? "packages/browser/dist");
const rpc = resolve(root, process.argv[3] ?? "packages/engine/dist/rpc.js");
const cache = resolve(root, ".cache");

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(cache, { recursive: true }));
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(resolve(cache, "viewer-bundle-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(() =>
        writeFile(
          resolve(directory, "index.html"),
          '<script type="module" src="/entry.js"></script>',
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          resolve(directory, "entry.js"),
          `import Worker from "${resolve(browser, "worker.js")}?worker";
import { LocalClient, localClientLayer } from "${resolve(browser, "client.js")}";
import { LocalRpcs, PROTOCOL_VERSION } from "${rpc}";
Object.assign(globalThis, { LocalClient, LocalRpcs, PROTOCOL_VERSION, layer: localClientLayer(() => new Worker()) });`,
        ),
      );
      yield* Effect.promise(() =>
        build({
          root: directory,
          configFile: false,
          build: { target: "chrome111", assetsInlineLimit: 0 },
        }),
      );
      const assets = resolve(directory, "dist/assets");
      const filenames = yield* Effect.promise(() => readdir(assets));
      const measured = yield* Effect.forEach(filenames.toSorted(), (name) =>
        Effect.promise(async () => {
          const file = await readFile(resolve(assets, name));
          return { name, bytes: file.byteLength, gzipBytes: gzipSync(file).byteLength };
        }),
      );
      console.info(JSON.stringify(measured, null, 2));
    }),
  ),
);
