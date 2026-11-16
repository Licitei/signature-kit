import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import type { PdfCoreTextOptions } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore } from "../dist/pdf-core.js";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const encoder = new TextEncoder();

const buildPdf = (contents: ReadonlyArray<string>): Uint8Array => {
  const firstPage = 10;
  const objects = new Map<number, string>([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [
      2,
      `<< /Type /Pages /Kids [${contents.map((_, index) => `${firstPage + index * 2} 0 R`).join(" ")}] /Count ${contents.length} >>`,
    ],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"],
  ]);
  contents.forEach((content, index) => {
    const number = firstPage + index * 2;
    objects.set(
      number,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents ${number + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    objects.set(number + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let pdf = "%PDF-1.7\n";
  const offsets = new Map<number, number>();
  for (const [number, body] of objects) {
    offsets.set(number, encoder.encode(pdf).byteLength);
    pdf += `${number} 0 obj\n${body}\nendobj\n`;
  }
  const xref = encoder.encode(pdf).byteLength;
  const max = Math.max(...objects.keys());
  pdf += `xref\n0 ${max + 1}\n`;
  for (let number = 0; number <= max; number += 1) {
    const offset = offsets.get(number);
    pdf +=
      offset === undefined
        ? "0000000000 65535 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(pdf);
};

const show = (x: number, y: number, value: string): string =>
  `BT /F1 10 Tf 1 0 0 1 ${x} ${y} Tm (${value}) Tj ET\n`;

const line = (x0: number, y0: number, x1: number, y1: number): string =>
  `0.5 w ${x0} ${y0} m ${x1} ${y1} l S\n`;

const priceTable = (top: number): string => {
  const rows = [top, top - 20, top - 40, top - 60];
  const columns = [50, 200, 350];
  let out = "";
  for (const y of rows) out += line(50, y, 350, y);
  for (const x of columns) out += line(x, top - 60, x, top);
  const body: ReadonlyArray<readonly [string, string]> = [
    ["Item | tipo", "Valor"],
    ["Cimento", "12,50"],
    ["Areia", "8,00"],
  ];
  body.forEach(([left, right], index) => {
    out += show(55, top - 12 - index * 20, left);
    out += show(205, top - 12 - index * 20, right);
  });
  return out;
};

const page = (index: number): string =>
  `${show(50, 770, "Prefeitura Municipal de Marilac")}${show(50, 600, `Corpo da pagina ${index}`)}${priceTable(700)}`;

const document = buildPdf([page(1), page(2), page(3)]);

describe("PdfCore.tables", () => {
  it.effect("returns structured cells with spans, boxes and text", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const tables = yield* core.tables(document);
      expect(tables).toHaveLength(3);
      expect(tables.map((table) => table.pageIndex)).toEqual([0, 1, 2]);
      const [first] = tables;
      expect(first?.rows).toBe(3);
      expect(first?.cols).toBe(2);
      expect(first?.bbox).toEqual([50, 640, 350, 700]);
      expect(first?.cells).toHaveLength(6);
      expect(first?.cells[0]).toEqual({
        row: 0,
        col: 0,
        rowSpan: 1,
        colSpan: 1,
        bbox: [50, 680, 200, 700],
        text: "Item | tipo",
      });
      expect(first?.cells[5]?.text).toBe("8,00");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("selects pages by index and validates input", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const second = yield* core.tables(document, { pageIndexes: [1] });
      expect(second.map((table) => table.pageIndex)).toEqual([1]);
      const outOfRange = yield* Effect.flip(core.tables(document, { pageIndexes: [7] }));
      expect(outOfRange.code).toBe(PdfCoreErrorCodeValue.invalidPdf);
      expect(outOfRange.operation).toBe("pdfCore.tables");
      const invalid = yield* Effect.flip(core.tables(document, { pageIndexes: [-1] }));
      expect(invalid.code).toBe(PdfCoreErrorCodeValue.invalidOptions);
      expect(invalid.schemaName).toBe("PdfCoreTablesOptions");
      const broken = yield* Effect.flip(core.tables(encoder.encode("not a pdf")));
      expect(broken.code).toBe(PdfCoreErrorCodeValue.invalidPdf);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns no tables for documents without rulings or alignment", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const prose = buildPdf([show(50, 700, "Somente um paragrafo de texto corrido.")]);
      expect(yield* core.tables(prose)).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("PdfCore.text formats", () => {
  it.effect("keeps the plain format as the default", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pages = yield* core.text(document, { dropRunningHeaders: false });
      expect(pages[0]).toBe(
        "Prefeitura Municipal de Marilac\n\nItem | tipo Valor\nCimento 12,50\nAreia 8,00\n\nCorpo da pagina 1",
      );
      expect(yield* core.text(document, { format: "text", dropRunningHeaders: false })).toEqual(
        pages,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("renders detected tables as GFM tables in markdown", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pages = yield* core.text(document, { format: "markdown" });
      expect(pages[0]).toBe(
        "Prefeitura Municipal de Marilac\n\n| Item \\| tipo | Valor |\n| --- | --- |\n| Cimento | 12,50 |\n| Areia | 8,00 |\n\nCorpo da pagina 1",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("drops repeated running headers unless asked to keep them", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const dropped = yield* core.text(document);
      expect(dropped[0]).toContain("Prefeitura Municipal de Marilac");
      expect(dropped[1]).not.toContain("Prefeitura");
      expect(dropped[2]).toBe("Item | tipo Valor\nCimento 12,50\nAreia 8,00\n\nCorpo da pagina 3");
      const kept = yield* core.text(document, { dropRunningHeaders: false });
      expect(kept[2]).toContain("Prefeitura Municipal de Marilac");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects unknown formats", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const options: PdfCoreTextOptions = JSON.parse('{"format":"html"}');
      const error = yield* Effect.flip(core.text(document, options));
      expect(error.code).toBe(PdfCoreErrorCodeValue.invalidOptions);
      expect(error.schemaName).toBe("PdfCoreTextOptions");
    }).pipe(Effect.provide(layer)),
  );
});
