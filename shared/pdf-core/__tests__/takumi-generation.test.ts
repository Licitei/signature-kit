import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore } from "../dist/pdf-core.js";
import { PDF_CORE_FIXTURES_DIR } from "./corpus.ts";
import { renderTakumiDeclarationPdf } from "../scripts/takumi-declaration-document.ts";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

describe("takumi PDF generation", () => {
  it.effect("renders multi-page Portuguese copy with text and link markers", () =>
    Effect.gen(function* () {
      const pdf = yield* Effect.promise(() => renderTakumiDeclarationPdf());
      expect(pdf.byteLength).toBeGreaterThan(10_000);
      const committed = new Uint8Array(
        readFileSync(join(PDF_CORE_FIXTURES_DIR, "takumi-declaration.pdf")),
      );
      expect(pdf).toEqual(committed);
      const core = yield* PdfCore;
      const inspection = yield* core.inspect(pdf, { text: true, links: true });
      expect(inspection.pages).toHaveLength(3);
      const textBlob = inspection.text.map((page) => page.text).join(" ");
      expect(textBlob).toContain("[[licitei-assinatura]]");
      expect(textBlob).toContain("âncora de assinatura");
    }).pipe(Effect.provide(layer)),
  );
});
