import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore } from "../dist/pdf-core.js";
import { PDF_CORE_FIXTURES_DIR } from "./corpus.ts";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const readGolden = (name: string): string =>
  readFileSync(join(PDF_CORE_FIXTURES_DIR, name), "utf8");

describe("PdfCore markdown", () => {
  it.effect("matches committed goldens for structured fixtures", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const bytes = new Uint8Array(
        readFileSync(join(PDF_CORE_FIXTURES_DIR, "markdown-basics.pdf")),
      );
      const pages = yield* core.text(bytes, {
        dropRunningHeaders: false,
        format: "markdown",
      });
      expect(pages).toHaveLength(1);
      expect(pages[0]).toBe(readGolden("markdown-basics.md"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("plain text output is unchanged for the basics fixture", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const bytes = new Uint8Array(
        readFileSync(join(PDF_CORE_FIXTURES_DIR, "markdown-basics.pdf")),
      );
      const pages = yield* core.text(bytes, { dropRunningHeaders: false });
      expect(pages[0]).toContain("1. INFORMAÇÕES GERAIS");
      expect(pages[0]).toContain("CONCORRÊNCIA");
      expect(pages[0]).toMatch(/\n/);
    }).pipe(Effect.provide(layer)),
  );
});