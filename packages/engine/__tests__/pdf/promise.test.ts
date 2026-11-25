import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { PdfCoreErrorCodeValue } from "../../dist/wasm/config.js";
import { loadPdfCoreNode } from "../../dist/wasm/node.js";
import { createPdfCoreClient } from "../../dist/wasm/promise.js";

describe("Promise client", () => {
  it("runs PdfCore operations from Node without Effect", async () => {
    const core = await loadPdfCoreNode();
    const pdf = await core.create({
      pages: [
        { width: 100, height: 100 },
        { width: 200, height: 100 },
        { width: 300, height: 100 },
      ],
    });

    const { pages } = await core.document(pdf);
    const chunk = await core.merge([{ pdf, pageIndexes: [1, 2] }]);
    const extracted = await core.document(chunk);

    expect(pages).toHaveLength(3);
    expect(extracted.pages.map((page) => page.mediaBox)).toStrictEqual([
      [0, 0, 200, 100],
      [0, 0, 300, 100],
    ]);
  });

  it("rejects with the PdfCoreError", async () => {
    const core = await loadPdfCoreNode();
    await expect(core.document(new TextEncoder().encode("not a pdf"))).rejects.toMatchObject({
      _tag: "PdfCoreError",
      code: PdfCoreErrorCodeValue.invalidPdf,
    });
  });

  it("builds a client from a compiled module", async () => {
    const wasm = await readFile(new URL("../../dist/wasm/signature-kit.wasm", import.meta.url));
    const core = await createPdfCoreClient(await WebAssembly.compile(wasm));

    expect(await core.deflate(new Uint8Array(0))).toBeInstanceOf(Uint8Array);
  });
});
