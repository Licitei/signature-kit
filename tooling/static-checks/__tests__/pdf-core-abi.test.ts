import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPdfCoreAbiDiagnostics } from "../src/pdf-core-abi";

const temporaryRoots: string[] = [];

const writeWorkspace = async (files: {
  readonly abi: string;
  readonly decoder: string;
  readonly readme: string;
}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "signature-kit-pdf-core-abi-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "shared/pdf-core/rust/src"), { recursive: true });
  await mkdir(join(root, "shared/pdf-core/src"), { recursive: true });
  await writeFile(join(root, "shared/pdf-core/rust/src/abi.rs"), files.abi);
  await writeFile(join(root, "shared/pdf-core/src/pdf-core.ts"), files.decoder);
  await writeFile(join(root, "shared/pdf-core/README.md"), files.readme);
  return root;
};

const abi = [
  "const MAGIC: u32 = 0x4346_4450;",
  "const VERSION: u32 = 3;",
  "const FLAG_TEXT: u32 = 1;",
  "const FLAG_RUNS: u32 = 32;",
  "",
].join("\n");

const decoder = [
  "const FLAG_TEXT = 1;",
  "const FLAG_RUNS = 32;",
  "const MAGIC = 0x4346_4450;",
  "const VERSION = 3;",
  "",
].join("\n");

const readme = [
  "`flags`: bit 0 = extract text, bit 5 = split runs.",
  "",
  "### Payload (version 3)",
  "",
  "Header: `magic`, `version` (`3`).",
  "",
].join("\n");

afterEach(async () => {
  for (const root of temporaryRoots) {
    await rm(root, { recursive: true, force: true });
  }
  temporaryRoots.length = 0;
});

describe("pdf-core ABI lockstep", () => {
  it("accepts the current repository", () => {
    expect(collectPdfCoreAbiDiagnostics()).toEqual([]);
  });

  it("accepts matching constants and documentation", async () => {
    const root = await writeWorkspace({ abi, decoder, readme });
    expect(collectPdfCoreAbiDiagnostics(root)).toEqual([]);
  });

  it("rejects a decoder constant that differs from abi.rs", async () => {
    const root = await writeWorkspace({
      abi,
      decoder: decoder.replace("const VERSION = 3;", "const VERSION = 2;"),
      readme: readme.replaceAll("3", "2"),
    });
    expect(collectPdfCoreAbiDiagnostics(root).map((diagnostic) => diagnostic.message)).toEqual([
      "VERSION is 2 in the decoder but 3 in shared/pdf-core/rust/src.",
    ]);
  });

  it("rejects a README payload version that differs from the decoder", async () => {
    const root = await writeWorkspace({
      abi,
      decoder,
      readme: readme.replace("`version` (`3`)", "`version` (`2`)"),
    });
    expect(collectPdfCoreAbiDiagnostics(root).map((diagnostic) => diagnostic.message)).toEqual([
      '"### Payload (version 3)" documents version 2, but VERSION is 3.',
    ]);
  });

  it("rejects a flag missing from the documented bits", async () => {
    const root = await writeWorkspace({
      abi,
      decoder,
      readme: readme.replace(", bit 5 = split runs", ""),
    });
    expect(collectPdfCoreAbiDiagnostics(root).map((diagnostic) => diagnostic.message)).toEqual([
      "FLAG_RUNS (bit 5) is missing from the documented `flags` bits.",
    ]);
  });
});
