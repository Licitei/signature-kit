#!/usr/bin/env bun
/**
 * Build (optional) and report raw / gzip -9 / brotli -q 11 sizes for signature-kit.wasm.
 * Usage: bun packages/engine/bench/measure-size.ts [--build] [--label NAME] [--wasm PATH]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const repo = resolve(pkg, "../..");
const defaultWasm = join(pkg, "dist/wasm/signature-kit.wasm");

const args: string[] = process.argv.slice(2);
const doBuild: boolean = args.includes("--build");
const labelIdx = args.indexOf("--label");
const label = labelIdx >= 0 ? (args[labelIdx + 1] ?? "step") : "step";
const wasmIdx = args.indexOf("--wasm");
const wasmPath = resolve(wasmIdx >= 0 ? (args[wasmIdx + 1] ?? defaultWasm) : defaultWasm);

if (doBuild) {
  const result = spawnSync("bash", [join(repo, "crates/wasm/scripts/build-wasm.sh")], {
    cwd: repo,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const bytes = readFileSync(wasmPath);
const raw = bytes.byteLength;
const gzip = gzipSync(bytes, { level: 9 }).byteLength;
const brotli = brotliCompressSync(bytes, {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
}).byteLength;

const row = {
  label,
  path: wasmPath,
  raw,
  gzip,
  brotli,
  rawKb: +(raw / 1024).toFixed(1),
  gzipKb: +(gzip / 1024).toFixed(1),
  brotliKb: +(brotli / 1024).toFixed(1),
};

console.log(JSON.stringify(row));
const logDir = join(repo, ".cache/logs");
mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, "hill-sizes.jsonl");
writeFileSync(logPath, `${JSON.stringify(row)}\n`, { flag: "a" });
