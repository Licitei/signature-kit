import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore } from "../dist/pdf-core.js";
import { PDF_CORE_FIXTURES_DIR } from "./corpus.ts";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const MARKDOWN_FIXTURES = [
  {
    pdf: "markdown-basics.pdf",
    dropRunningHeaders: false,
  },
  {
    pdf: "markdown-hyphenation.pdf",
    dropRunningHeaders: false,
  },
  {
    pdf: "markdown-page-continue.pdf",
    dropRunningHeaders: true,
  },
  {
    pdf: "markdown-nested-lists.pdf",
    dropRunningHeaders: false,
  },
  {
    pdf: "markdown-two-column.pdf",
    dropRunningHeaders: false,
  },
  {
    pdf: "markdown-headings-react.pdf",
    dropRunningHeaders: false,
  },
];

const readGolden = (name: string): string =>
  readFileSync(join(PDF_CORE_FIXTURES_DIR, name), "utf8").trimEnd();

describe("PdfCore markdown", () => {
  for (const fixture of MARKDOWN_FIXTURES) {
    it.effect(`matches golden for ${fixture.pdf}`, () =>
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const bytes = new Uint8Array(readFileSync(join(PDF_CORE_FIXTURES_DIR, fixture.pdf)));
        const pages = yield* core.text(bytes, {
          dropRunningHeaders: fixture.dropRunningHeaders,
          format: "markdown",
        });
        const golden = readGolden(fixture.pdf.replace(/\.pdf$/, ".md"));
        const actual = pages.filter((page) => page !== "").join("\n\n");
        expect(actual).toBe(golden);
      }).pipe(Effect.provide(layer)),
    );
  }

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
