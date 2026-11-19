import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore, pdfCoreBytesSource } from "../dist/pdf-core.js";
import { PDF_CORE_FIXTURES_DIR, type CorpusFixtureName } from "./corpus.ts";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const readFixture = (name: CorpusFixtureName): Uint8Array =>
  new Uint8Array(readFileSync(join(PDF_CORE_FIXTURES_DIR, name)));

const encryptedFixture = (): Uint8Array => {
  const body = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n",
  ].join("");
  const encoder = new TextEncoder();
  let pdf = `%PDF-1.7\n${body}`;
  const xref = encoder.encode(pdf).byteLength;
  pdf += `trailer\n<< /Size 4 /Root 1 0 R /Encrypt << /Filter /Standard >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(pdf);
};

describe("PdfCore.text", () => {
  it.effect("returns reading-order text for every page", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pages = yield* core.text(readFixture("habilitacao-150.pdf"), {
        dropRunningHeaders: false,
      });
      expect(pages).toHaveLength(150);
      expect(pages[0]).toContain("Habilitação — folha 1");
      expect(pages[0]).toContain("Página 1: bloco sobre qualificação técnica");
      expect(pages[149]).toContain("folha 150");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("drops repeated running headers by default", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const bytes = readFixture("habilitacao-150.pdf");
      const pages = yield* core.text(bytes);
      expect(pages[0]).not.toContain("folha 1");
      expect(pages[0]).toContain("Página 1: bloco sobre qualificação técnica");
      expect(pages[1]).not.toContain("folha 2");
      expect(pages[1]).toContain("Página 2: bloco sobre regularidade fiscal");
      expect(pages[149]).not.toContain("folha 150");
      const kept = yield* core.text(bytes, { dropRunningHeaders: false });
      expect(kept[1]).toContain("folha 2");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("decodes accented text and keeps paragraphs apart", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const [page] = yield* core.text(readFixture("helvetica-winansi.pdf"));
      expect(page).toContain("Declaração de habilitação — corpus SignatureKit");
      expect(page).toContain("Ação, coração, situação e à margem do edital.");
      expect(page).toContain("CPF 123.456.789-09 e CNPJ 12.345.678/0001-95.");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads rotated pages in the visible orientation", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pages = yield* core.text(readFixture("rotated-cropped.pdf"));
      expect(pages).toEqual(["Página com rotação 90°", "Página com rotação 270°"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("selects pages by index in the requested order without duplicates", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pages = yield* core.text(readFixture("habilitacao-150.pdf"), {
        pageIndexes: [4, 1, 4],
        dropRunningHeaders: false,
      });
      expect(pages).toHaveLength(2);
      expect(pages[0]).toContain("folha 5");
      expect(pages[1]).toContain("folha 2");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("recovers text when startxref is corrupt but the body is intact", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      expect(yield* core.text(readFixture("broken-xref.pdf"))).toEqual([
        "PDF válido com startxref corrompido.",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects out-of-range page indexes and invalid options", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const outOfRange = yield* Effect.flip(
        core.text(readFixture("links.pdf"), { pageIndexes: [3] }),
      );
      expect(outOfRange.code).toBe(PdfCoreErrorCodeValue.invalidPdf);
      expect(outOfRange.operation).toBe("pdfCore.text");
      const invalid = yield* Effect.flip(
        core.text(readFixture("links.pdf"), { pageIndexes: [-1] }),
      );
      expect(invalid.code).toBe(PdfCoreErrorCodeValue.invalidOptions);
      expect(invalid.schemaName).toBe("PdfCoreTextOptions");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails with typed errors for invalid and encrypted documents", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const invalid = yield* Effect.flip(core.text(new TextEncoder().encode("not a pdf")));
      expect(invalid.code).toBe(PdfCoreErrorCodeValue.invalidPdf);
      const encrypted = yield* Effect.flip(core.text(encryptedFixture()));
      expect(encrypted.code).toBe(PdfCoreErrorCodeValue.encryptedPdf);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("bounds plain text at whole lines and counts Unicode characters and separators", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const pdf = readFixture("helvetica-winansi.pdf");
        const options = { pageIndexes: [0] };
        const [full = ""] = yield* core.text(pdf, options);
        const first = "Declaração de habilitação — corpus SignatureKit";
        expect(yield* core.text(pdf, { ...options, maxBlocks: 1 })).toEqual([first]);
        expect(yield* core.text(pdf, { ...options, maxChars: Array.from(first).length })).toEqual([
          first,
        ]);
        expect(
          yield* core.text(pdf, { ...options, maxChars: Array.from(first).length - 1 }),
        ).toEqual([""]);
        expect(yield* core.text(pdf, { ...options, maxBlocks: 0 })).toEqual([""]);
        const second = "Ação, coração, situação e à margem do edital.";
        const end = full.indexOf(second) + second.length;
        const prefix = full.slice(0, end);
        const maxChars = Array.from(prefix).length;
        expect(yield* core.text(pdf, { ...options, maxChars })).toEqual([prefix]);
        expect(yield* core.text(pdf, { ...options, maxChars: maxChars - 1 })).toEqual([first]);
        expect(yield* core.text(pdf, { ...options, maxChars, maxBlocks: 1 })).toEqual([first]);
        const lazy = yield* core.openLazy(pdfCoreBytesSource(pdf));
        expect(yield* lazy.text({ ...options, maxChars })).toEqual([prefix]);
        const invalid = yield* Effect.flip(lazy.text({ ...options, maxBlocks: -1 }));
        expect(invalid.code).toBe(PdfCoreErrorCodeValue.invalidOptions);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("bounds complete markdown blocks after applying the normal layout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const pdf = readFixture("helvetica-winansi.pdf");
        const options = { pageIndexes: [0], format: "markdown" } satisfies Parameters<
          typeof core.text
        >[1];
        const [full = ""] = yield* core.text(pdf, options);
        const [heading = ""] = full.split("\n\n");
        expect(heading).toContain("Declaração de habilitação");
        expect(heading).not.toBe(full);
        const lazy = yield* core.openLazy(pdfCoreBytesSource(pdf));
        expect(yield* core.text(pdf, { ...options, maxBlocks: 1 })).toEqual([heading]);
        expect(yield* lazy.text({ ...options, maxChars: Array.from(heading).length })).toEqual([
          heading,
        ]);
        expect(yield* lazy.text({ ...options, maxChars: Array.from(heading).length - 1 })).toEqual([
          "",
        ]);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("stays usable after repeated calls", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const bytes = readFixture("habilitacao-150.pdf");
      const first = yield* core.text(bytes);
      for (let round = 0; round < 20; round += 1) {
        expect(yield* core.text(bytes)).toEqual(first);
      }
    }).pipe(Effect.provide(layer)),
  );
});
