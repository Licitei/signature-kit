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
  await writeFile(join(root, "shared/pdf-core/rust/src/edit.rs"), "const EDIT_VERSION: u32 = 1;\n");
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
  "const EDIT_VERSION = 1;",
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
  "### Edit payload (version 1)",
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

  it("accepts a Rust flag written as a shift", async () => {
    const root = await writeWorkspace({ abi: abi.replace("= 32;", "= 1 << 5;"), decoder, readme });
    expect(collectPdfCoreAbiDiagnostics(root)).toEqual([]);
  });

  it.each([
    ["a decoder value that differs", { decoder: decoder.replace("VERSION = 3", "VERSION = 2") }],
    ["a renamed Rust constant", { abi: abi.replace("FLAG_RUNS", "FLAG_SPLIT_RUNS") }],
    [
      "a constant read from edit.rs",
      { decoder: decoder.replace("EDIT_VERSION = 1", "EDIT_VERSION = 2") },
    ],
    [
      "a README version that differs",
      { readme: readme.replace("`version` (`3`)", "`version` (`2`)") },
    ],
    [
      "a README section without its version",
      {
        readme: readme.replace(
          "### Edit payload (version 1)\n",
          "### Edit payload\n\nSee (version 1).\n",
        ),
      },
    ],
    ["an undocumented flag", { readme: readme.replace(", bit 5 = split runs", "") }],
    [
      "a documented bit without a flag",
      { readme: readme.replace("split runs.", "split runs, bit 9 = ghost.") },
    ],
  ])("rejects %s", async (_, change) => {
    const root = await writeWorkspace({ abi, decoder, readme, ...change });
    expect(collectPdfCoreAbiDiagnostics(root)).not.toEqual([]);
  });

  it("rejects a missing decoder", async () => {
    const root = await writeWorkspace({ abi, decoder, readme });
    await rm(join(root, "shared/pdf-core/src/pdf-core.ts"));
    expect(collectPdfCoreAbiDiagnostics(root)).toEqual([
      { path: "shared/pdf-core/src/pdf-core.ts", message: "pdf-core ABI file is missing." },
    ]);
  });
});
