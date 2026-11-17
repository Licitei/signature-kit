#!/usr/bin/env bun
/**
 * Build (optional) and report raw / gzip -9 / brotli -q 11 sizes for pdf-core.wasm.
 * Usage: bun shared/pdf-core/__tests__/bench/measure-size.ts [--build] [--label NAME] [--wasm PATH]
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../..");
const repo = resolve(pkg, "../..");
const defaultWasm = join(pkg, "dist/pdf-core.wasm");
const cargoTarget = process.env.CARGO_TARGET_DIR ?? join(pkg, "rust/target");
const builtWasm = join(cargoTarget, "wasm32-unknown-unknown/release/signature_kit_pdf_core.wasm");

const args: string[] = process.argv.slice(2);
const doBuild: boolean = args.includes("--build");
const labelIdx = args.indexOf("--label");
const label = labelIdx >= 0 ? (args[labelIdx + 1] ?? "step") : "step";
const wasmIdx = args.indexOf("--wasm");
const wasmPath = resolve(wasmIdx >= 0 ? (args[wasmIdx + 1] ?? defaultWasm) : defaultWasm);

if (doBuild) {
  const env = { ...process.env, TMPDIR: process.env.TMPDIR ?? join(repo, ".cache/t") };
  const result = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--manifest-path",
      join(pkg, "rust/Cargo.toml"),
    ],
    { cwd: pkg, env, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  mkdirSync(dirname(defaultWasm), { recursive: true });
  copyFileSync(builtWasm, defaultWasm);
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
