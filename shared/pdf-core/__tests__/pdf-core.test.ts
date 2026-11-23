import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result } from "effect";

import { PdfCoreError, PdfCoreErrorCodeValue } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore, makePdfCore } from "../dist/pdf-core.js";
import {
  CORPUS_FIXTURE_NAMES,
  LINK_FIXTURE_URIS,
  PDF_CORE_FIXTURES_DIR,
  type CorpusFixtureName,
} from "./corpus.ts";

const MAX_WASM_BYTES = 1144 * 1024;
const wasmUrl = new URL("../dist/pdf-core.wasm", import.meta.url);
const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const readFixture = (name: CorpusFixtureName): Uint8Array =>
  new Uint8Array(readFileSync(join(PDF_CORE_FIXTURES_DIR, name)));

const LITEPARSE_DIMS: Readonly<Record<CorpusFixtureName, readonly [number, number]>> = {
  "links.pdf": [612, 792],
  "helvetica-winansi.pdf": [612, 792],
  "react-pdf-declaration.pdf": [595.28, 841.89],
  "takumi-declaration.pdf": [595.276, 841.89],
  "rotated-cropped.pdf": [612, 792],
  "object-streams.pdf": [612, 792],
  "incremental-update.pdf": [612, 792],
  "broken-xref.pdf": [612, 792],
  "icp-signed.pdf": [300, 200],
  "habilitacao-150.pdf": [612, 792],
};

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

const manyItemsFixture = (pageCount: number, itemsPerPage: number): Uint8Array => {
  const lines = ["BT /F1 10 Tf"];
  for (let index = 0; index < itemsPerPage; index += 1) {
    lines.push(`1 0 0 1 ${Math.floor(index / 700) * 30} ${(index % 700) + 20} Tm (a) Tj`);
  }
  lines.push("ET");
  const content = lines.join("\n");
  const kids = Array.from({ length: pageCount }, (_, index) => `${index + 5} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...Array.from(
      { length: pageCount },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
    ),
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: Array<number> = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

const styledFixture = (): Uint8Array => {
  const pages = [
    [
      "BT /F2 9 Tf 1 0 0 1 28 700 Tm (17/06/2026 15:39:26) Tj ET",
      "BT /F2 9 Tf 1 0 0 1 111.9 700 Tm (    ) Tj ET",
      "BT /F2 9 Tf 1 0 0 1 122 700 Tm (MENSAGEM) Tj ET",
      "BT /F1 9 Tf 1 0 0 1 28 680 Tm (Marca: ) Tj /F2 9 Tf (ACME) Tj ET",
      "BT /F3 9 Tf 1 0 0 1 28 660 Tm (Nota) Tj ET",
    ].join("\n"),
    "",
    [
      "BT /F2 12 Tf 1 0 0 1 272 700 Tm (LOTE ) Tj ET",
      "BT /F2 12 Tf 1 0 0 1 307.6 700 Tm (50) Tj ET",
      "BT /F1 9 Tf 1 0 0 1 28 680 Tm (AB) Tj ET",
      "BT /F1 9 Tf 1 0 0 1 40.006 680 Tm (CD) Tj ET",
    ].join("\n"),
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [6 0 R 8 0 R 10 0 R] /Count 3 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>",
    ...pages.flatMap((content, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents ${index * 2 + 7} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ]),
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: Array<number> = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

const textItems = (page: { text: string; offsets: Uint32Array; styles: Uint8Array }) =>
  Array.from({ length: page.offsets.length - 1 }, (_, index) => ({
    text: page.text.slice(page.offsets[index], page.offsets[index + 1]),
    style: page.styles[index],
  }));

describe("PdfCore", () => {
  it.effect("inspects page geometry, links and text of the corpus", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const inspection = yield* core.inspect(readFixture("links.pdf"), { text: true, links: true });
      expect(inspection.pages).toHaveLength(1);
      const [width, height] = LITEPARSE_DIMS["links.pdf"];
      const media = inspection.pages[0]?.mediaBox;
      expect((media?.[2] ?? Number.NaN) - (media?.[0] ?? Number.NaN)).toBeCloseTo(width, 0);
      expect((media?.[3] ?? Number.NaN) - (media?.[1] ?? Number.NaN)).toBeCloseTo(height, 0);
      expect(inspection.pages[0]?.rotate).toBe(0);
      expect(inspection.links).toHaveLength(3);
      const uris = inspection.links.map((link) => link.uri);
      expect(uris).toContain(LINK_FIXTURE_URIS.primary);
      expect(uris).toContain(LINK_FIXTURE_URIS.secondary);
      expect(uris).toContain(LINK_FIXTURE_URIS.indirect);
      for (const link of inspection.links) {
        expect(link.rect).toHaveLength(4);
        expect(link.pageIndex).toBe(0);
      }
      expect(inspection.text).toHaveLength(1);
      expect(inspection.text[0]?.pageIndex).toBe(0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("matches corpus fixture page counts and media boxes", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      for (const name of CORPUS_FIXTURE_NAMES) {
        const inspection = yield* core.inspect(readFixture(name), { text: false, links: false });
        const expectedCount =
          name === "habilitacao-150.pdf"
            ? 150
            : name === "rotated-cropped.pdf"
              ? 2
              : name === "takumi-declaration.pdf"
                ? 3
                : 1;
        expect(inspection.pages).toHaveLength(expectedCount);
        const [width, height] = LITEPARSE_DIMS[name];
        const media = inspection.pages[0]?.mediaBox;
        expect((media?.[2] ?? Number.NaN) - (media?.[0] ?? Number.NaN)).toBeCloseTo(width, 0);
        expect((media?.[3] ?? Number.NaN) - (media?.[1] ?? Number.NaN)).toBeCloseTo(height, 0);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns rotated page metadata and rotated link uri", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const inspection = yield* core.inspect(readFixture("rotated-cropped.pdf"), {
        text: false,
        links: true,
      });
      expect(inspection.pages).toHaveLength(2);
      expect(inspection.pages[0]?.rotate).toBe(90);
      expect(inspection.pages[1]?.rotate).toBe(270);
      expect(inspection.links.every((link) => link.uri === LINK_FIXTURE_URIS.rotated)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips links and text unless requested", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const inspection = yield* core.inspect(readFixture("links.pdf"), {
        text: false,
        links: false,
      });
      expect(inspection.pages).toHaveLength(1);
      expect(inspection.links).toHaveLength(0);
      expect(inspection.text).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("restricts text to the requested page indexes", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const inspection = yield* core.inspect(readFixture("rotated-cropped.pdf"), {
        text: true,
        links: false,
        pageIndexes: [0],
      });
      expect(inspection.text).toHaveLength(1);
      expect(inspection.text[0]?.pageIndex).toBe(0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns arrays that survive later calls", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const first = yield* core.inspect(readFixture("links.pdf"), { text: true, links: true });
      const snapshot = first.text.map((page) => [...page.rects]);
      yield* Effect.forEach(CORPUS_FIXTURE_NAMES.slice(0, 4), (name) =>
        core.inspect(readFixture(name), { text: true, links: true }),
      );
      expect(first.text.map((page) => [...page.rects])).toEqual(snapshot);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("inspects text of every page of the largest corpus fixture", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const inspection = yield* core.inspect(readFixture("habilitacao-150.pdf"), {
        text: true,
        links: true,
      });
      expect(inspection.text).toHaveLength(inspection.pages.length);
      expect(inspection.text.every((page) => page.offsets.length > 1)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("inspects documents beyond the default item limits like text extraction", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const inspection = yield* core.inspect(manyItemsFixture(9, 12_000), {
        text: true,
        links: false,
      });
      expect(inspection.text).toHaveLength(9);
      expect(inspection.text.every((page) => page.offsets.length === 12_001)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("splits runs by position and style and reports bold and italic per item", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = styledFixture();
      const runs = yield* core.inspect(pdf, { text: true, links: false, runs: true });
      expect(runs.text.map(textItems)).toEqual([
        [
          { text: "17/06/2026 15:39:26", style: 1 },
          { text: "MENSAGEM", style: 1 },
          { text: "Marca:", style: 0 },
          { text: "ACME", style: 1 },
          { text: "Nota", style: 2 },
        ],
        [],
        [
          { text: "LOTE", style: 1 },
          { text: "50", style: 1 },
          { text: "ABCD", style: 0 },
        ],
      ]);
      expect(Array.from(runs.text[0]?.rects.slice(5, 6) ?? [])).toEqual([122]);

      const merged = yield* core.inspect(pdf, { text: true, links: false });
      const lines = merged.text.map(textItems);
      expect(lines[0]?.map((item) => item.text)).toEqual([
        "17/06/2026 15:39:26    MENSAGEM",
        "Marca: ACME",
        "Nota",
      ]);
      expect(lines[0]?.map((item) => item.style)).toEqual([1, 0, 2]);
      expect(merged.text.every((page) => page.styles.length === page.offsets.length - 1)).toBe(
        true,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports limit violations of a single page as limitExceeded", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const error = yield* Effect.flip(
        core.inspect(manyItemsFixture(1, 250_001), { text: true, links: false }),
      );
      expect(error.code).toBe(PdfCoreErrorCodeValue.limitExceeded);
      expect(error.status).toBe(3);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns UTF-16 item offsets that slice non-ASCII text directly", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const content =
        "BT /F1 10 Tf 1 0 0 1 20 700 Tm (a\\347\\343o) Tj 1 0 0 1 20 650 Tm (\\200 fim) Tj ET";
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
      ];
      let source = "%PDF-1.7\n";
      const offsets: Array<number> = [];
      objects.forEach((body, index) => {
        offsets.push(source.length);
        source += `${index + 1} 0 obj\n${body}\nendobj\n`;
      });
      const xref = source.length;
      source += `xref\n0 6\n0000000000 65535 f \n`;
      source += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
      source += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      const inspection = yield* core.inspect(new TextEncoder().encode(source), {
        text: true,
        links: false,
      });
      const page = inspection.text[0];
      expect(page).toBeDefined();
      if (page === undefined) return;
      const items = Array.from({ length: page.offsets.length - 1 }, (_, index) =>
        page.text.slice(page.offsets[index], page.offsets[index + 1]),
      );
      expect(items).toEqual(["ação", "€ fim"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects malformed input with a typed error", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const result = yield* Effect.result(
        core.inspect(new TextEncoder().encode("this is not a pdf"), { text: true, links: true }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(PdfCoreError);
        expect(result.failure.code).toBe(PdfCoreErrorCodeValue.invalidPdf);
        expect(result.failure.status).toBe(1);
        expect(result.failure.message.length).toBeGreaterThan(0);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects encrypted input with a typed error", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const error = yield* Effect.flip(
        core.inspect(encryptedFixture(), { text: false, links: false }),
      );
      expect(error.code).toBe(PdfCoreErrorCodeValue.encryptedPdf);
      expect(error.status).toBe(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects empty input with a typed error", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const error = yield* Effect.flip(
        core.inspect(new Uint8Array(0), { text: false, links: false }),
      );
      expect(error.code).toBe(PdfCoreErrorCodeValue.invalidPdf);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects invalid options before touching the module", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const error = yield* Effect.flip(
        core.inspect(readFixture("links.pdf"), { text: true, links: true, pageIndexes: [-1] }),
      );
      expect(error.code).toBe(PdfCoreErrorCodeValue.invalidOptions);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("serves concurrent inspections", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const results = yield* Effect.all(
        Array.from({ length: 16 }, () =>
          core.inspect(readFixture("links.pdf"), { text: true, links: true }),
        ),
        { concurrency: "unbounded" },
      );
      expect(results.every((inspection) => inspection.pages.length === 1)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "frees every wasm buffer on success and failure paths",
    () =>
      Effect.gen(function* () {
        const core = yield* PdfCore;
        const bulk = new Uint8Array(48 * 1024 * 1024);
        bulk.set(new TextEncoder().encode("%PDF-1.4\n"));
        const outcomes = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          (index) =>
            core
              .inspect(index % 10 === 9 ? readFixture("links.pdf") : bulk, {
                text: true,
                links: true,
              })
              .pipe(Effect.result),
        );
        const exhausted = outcomes.filter(
          (outcome) =>
            Result.isFailure(outcome) &&
            outcome.failure.code === PdfCoreErrorCodeValue.limitExceeded,
        );
        expect(exhausted).toHaveLength(0);
        const after = yield* core.inspect(readFixture("links.pdf"), { text: false, links: false });
        expect(after.pages).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    60_000,
  );

  it.effect("keeps the wasm module within the size budget", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bytes = yield* fileSystem.readFile(wasmUrl.pathname);
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(bytes.byteLength).toBeLessThanOrEqual(MAX_WASM_BYTES);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with a typed error when the module lacks the expected exports", () =>
    Effect.gen(function* () {
      const emptyModule = yield* Effect.promise(() =>
        WebAssembly.compile(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])),
      );
      const error = yield* Effect.flip(makePdfCore(emptyModule));
      expect(error.code).toBe(PdfCoreErrorCodeValue.wasmLoadFailed);
      expect(error.schemaName).toBe("PdfCoreExports");
    }),
  );
});
