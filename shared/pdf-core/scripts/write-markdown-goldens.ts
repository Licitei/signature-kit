import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { PDF_CORE_FIXTURES_DIR } from "../__tests__/corpus.ts";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore } from "../dist/pdf-core.js";

const fixtures: ReadonlyArray<{
  readonly pdf: string;
  readonly dropRunningHeaders: boolean;
}> = [
  { pdf: "markdown-basics.pdf", dropRunningHeaders: false },
  { pdf: "markdown-hyphenation.pdf", dropRunningHeaders: false },
  { pdf: "markdown-page-continue.pdf", dropRunningHeaders: true },
  { pdf: "markdown-nested-lists.pdf", dropRunningHeaders: false },
  { pdf: "markdown-two-column.pdf", dropRunningHeaders: false },
  { pdf: "markdown-headings-react.pdf", dropRunningHeaders: false },
];

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

await Effect.gen(function* () {
  const core = yield* PdfCore;
  for (const fixture of fixtures) {
    const bytes = new Uint8Array(readFileSync(join(PDF_CORE_FIXTURES_DIR, fixture.pdf)));
    const pages = yield* core.text(bytes, {
      dropRunningHeaders: fixture.dropRunningHeaders,
      format: "markdown",
    });
    const golden = fixture.pdf.replace(/\.pdf$/, ".md");
    writeFileSync(join(PDF_CORE_FIXTURES_DIR, golden), `${pages.join("\n\n---\n\n")}\n`);
    process.stdout.write(`wrote ${golden}\n`);
  }
}).pipe(Effect.provide(layer), Effect.runPromise);
