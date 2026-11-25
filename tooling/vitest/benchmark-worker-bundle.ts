import { rm } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    bundledWorkerUrl: string;
    benchmarkWorkers: number;
  }
}

const root = path.resolve(import.meta.dirname, "../..");
const output = path.join(root, ".cache/bench-v2/worker-bundle");

export default async function setup(project: TestProject) {
  await rm(output, { recursive: true, force: true });
  await build({
    root,
    base: "./",
    configFile: false,
    logLevel: "error",
    build: {
      outDir: output,
      emptyOutDir: true,
      target: "chrome111",
      minify: true,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: path.join(root, "packages/browser/dist/worker.js"),
        output: { format: "es", entryFileNames: "worker.js" },
        preserveEntrySignatures: false,
      },
    },
  });
  project.provide("bundledWorkerUrl", `/@fs${output}/worker.js`);
  project.provide("benchmarkWorkers", Number(process.env.SIGNATURE_KIT_BENCH_WORKERS ?? "7"));
  return () => rm(output, { recursive: true, force: true });
}
