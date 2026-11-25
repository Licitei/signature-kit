import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    bundledWorkerUrl: string;
    bundledSigningWorkerUrl: string;
    bundleSizes: string;
    benchmarkWorkers: number;
  }
}

const root = path.resolve(import.meta.dirname, "../..");
const output = path.join(root, ".cache/bench-v2/worker-bundle");

const files = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) =>
      entry.isDirectory()
        ? files(path.join(directory, entry.name))
        : [path.join(directory, entry.name)],
    ),
  );
  return nested.flat();
};

const bundle = async (entry: string) => {
  const outDir = path.join(output, entry);
  await build({
    root,
    base: "./",
    configFile: false,
    logLevel: "error",
    build: {
      outDir,
      emptyOutDir: true,
      target: "chrome111",
      minify: true,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: path.join(root, `packages/browser/dist/${entry}.js`),
        output: { format: "es", entryFileNames: "worker.js" },
        preserveEntrySignatures: false,
      },
    },
  });
  const sizes = await Promise.all(
    (await files(outDir)).map(async (file) => [
      path.relative(outDir, file).replace(/-[\w-]{8}\./, "."),
      (await stat(file)).size,
    ]),
  );
  return Object.fromEntries(
    sizes.sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
};

export default async function setup(project: TestProject) {
  await rm(output, { recursive: true, force: true });
  const sizes = {
    worker: await bundle("worker"),
    "signing-worker": await bundle("signing-worker"),
  };
  project.provide("bundledWorkerUrl", `/@fs${output}/worker/worker.js`);
  project.provide("bundledSigningWorkerUrl", `/@fs${output}/signing-worker/worker.js`);
  project.provide("bundleSizes", JSON.stringify(sizes));
  project.provide("benchmarkWorkers", Number(process.env.SIGNATURE_KIT_BENCH_WORKERS ?? "7"));
  return () => rm(output, { recursive: true, force: true });
}
