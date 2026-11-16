import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { workspaceModuleUrl } from "./workspace-modules.ts";

const liteParseModule = await import(
  workspaceModuleUrl("formats/pdf/node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm.js"),
);
const initLiteParseWasm = liteParseModule.default;
const LiteParse = liteParseModule.LiteParse;

let initPromise: Promise<void> | undefined;

const liteParseWasmBytes = (): Uint8Array => {
  const wasmPath = workspaceModuleUrl(
    "formats/pdf/node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm_bg.wasm",
  );
  return new Uint8Array(readFileSync(fileURLToPath(wasmPath)));
};

export const ensureLiteParseWasm = (): Promise<void> => {
  initPromise ??= initLiteParseWasm({ module_or_path: liteParseWasmBytes() }).then(() => undefined);
  return initPromise;
};

export const parsePdfWithLiteParse = async (
  pdf: Uint8Array,
  pageCount: number,
): Promise<unknown> => {
  await ensureLiteParseWasm();
  const parser = new LiteParse({
    ocrEnabled: false,
    maxPages: pageCount,
    outputFormat: "json",
    preserveVerySmallText: true,
    quiet: true,
  });
  try {
    return await parser.parse(pdf);
  } finally {
    parser.free();
  }
};

export const liteParsePageCount = async (pdf: Uint8Array): Promise<number> => {
  const { PDFDocument } = await import(
    workspaceModuleUrl("formats/pdf/node_modules/@cantoo/pdf-lib/es/index.js"),
  );
  const document = await PDFDocument.load(pdf, { ignoreEncryption: true });
  return document.getPageCount();
};

export const loadFixtureBytes = (fixturePath: string): Uint8Array =>
  new Uint8Array(readFileSync(fixturePath));

export const fixtureFileUrl = (fixturePath: string): URL => pathToFileURL(fixturePath);