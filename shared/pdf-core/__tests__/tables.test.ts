import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import type { PdfCoreTextOptions } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore, pdfCoreBytesSource } from "../dist/pdf-core.js";

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
    [4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"],
  ]);
  contents.forEach((content, index) => {
    const number = firstPage + index * 2;
    objects.set(
      number,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents ${number + 1} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`,
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

const show = (x: number, y: number, value: string, font = "F1"): string =>
  `BT /${font} 10 Tf 1 0 0 1 ${x} ${y} Tm (${value}) Tj ET\n`;

const line = (x0: number, y0: number, x1: number, y1: number): string =>
  `0.5 w ${x0} ${y0} m ${x1} ${y1} l S\n`;

type TableRow = readonly [string, string];

const ruledTable = (
  top: number,
  body: ReadonlyArray<TableRow>,
  heights: ReadonlyArray<number> = [],
  emphasizeHeader = false,
): string => {
  let edge = top;
  let grid = line(50, top, 350, top);
  let content = "";
  for (const [index, [left, right]] of body.entries()) {
    const height = heights[index] ?? 20;
    const baseline = edge - Math.min(12, height - 3);
    const font = index === 0 && emphasizeHeader ? "F2" : "F1";
    content += show(55, baseline, left, font) + show(205, baseline, right, font);
    edge -= height;
    grid += line(50, edge, 350, edge);
  }
  for (const x of [50, 200, 350]) grid += line(x, edge, x, top);
  return grid + content;
};

const priceTable = (top: number): string =>
  ruledTable(top, [
    ["Item | tipo", "Valor"],
    ["Cimento", "12,50"],
    ["Areia", "8,00"],
  ]);

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

  it.effect("merges 60 ruled rows across three pages with mixed header repetition", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const header: TableRow = ["Product", "Price"];
      const body = Array.from({ length: 60 }, (_, index): TableRow => [
        `Product ${index + 1}`,
        `${index + 10}.00`,
      ]);
      const pdf = buildPdf([
        ruledTable(490, [header, ...body.slice(0, 20)]),
        ruledTable(750, [header, ...body.slice(20, 52)]),
        ruledTable(750, body.slice(52)),
      ]);
      const options = { mergeAcrossPages: true };
      const perPage = yield* core.tables(pdf);
      expect(perPage.map((table) => table.rows)).toEqual([21, 33, 8]);
      expect(perPage[2]?.cells[0]?.text).toBe("Product 53");

      const merged = yield* core.tables(pdf, options);
      expect(merged).toHaveLength(1);
      const [table] = merged;
      expect(table).toMatchObject({ pageIndex: 0, pages: [0, 1, 2], rows: 61, cols: 2 });
      expect(table?.cells.map((cell) => [cell.row, cell.col, cell.text])).toEqual(
        [header, ...body].flatMap((row, index) => row.map((value, col) => [index, col, value])),
      );
      const markdown = yield* core.text(pdf, { ...options, format: "markdown" });
      expect(markdown).toEqual([
        [
          "| Product | Price |",
          "| --- | --- |",
          ...body.map(([name, price]) => `| ${name} | ${price} |`),
        ].join("\n"),
        "",
        "",
      ]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lazy = yield* core.openLazy(pdfCoreBytesSource(pdf));
          expect(yield* lazy.tables(options)).toEqual(merged);
          expect(yield* lazy.text({ ...options, format: "markdown" })).toEqual(markdown);
          expect((yield* lazy.stats).strategy).toBe("lazy");
        }),
      );
      const skipped = yield* core.tables(pdf, { ...options, pageIndexes: [0, 2] });
      const reversed = yield* core.tables(pdf, { ...options, pageIndexes: [1, 0] });
      expect(skipped.map((item) => item.pageIndex)).toEqual([0, 2]);
      expect(reversed.map((item) => item.pageIndex)).toEqual([1, 0]);
      expect(yield* core.text(pdf, options)).toEqual(yield* core.text(pdf));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("looks past running furniture on a borderless continuation", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const aligned = (top: number, rows: ReadonlyArray<TableRow>): string =>
        rows
          .map(
            ([left, right], index) =>
              show(55, top - index * 18, left) + show(205, top - index * 18, right),
          )
          .join("");
      const furniture = (pageNumber: number, content: string): string =>
        show(50, 783, "Monthly inventory") + content + show(50, 25, `Page ${pageNumber} of 2`);
      const pdf = buildPdf([
        furniture(
          1,
          aligned(145, [
            ["Product", "Price"],
            ["Cement", "12.50"],
            ["Sand", "08.00"],
          ]),
        ),
        furniture(
          2,
          aligned(730, [
            ["Gravel", "18.00"],
            ["Bricks", "10.00"],
            ["Mortar", "15.00"],
          ]),
        ),
      ]);
      const [table, ...rest] = yield* core.tables(pdf, { mergeAcrossPages: true });
      expect(rest).toEqual([]);
      expect(table).toMatchObject({ pages: [0, 1], rows: 6 });
      expect(table?.cells.filter((cell) => cell.col === 0).map((cell) => cell.text)).toEqual([
        "Product",
        "Cement",
        "Sand",
        "Gravel",
        "Bricks",
        "Mortar",
      ]);
      const markdown = yield* core.text(pdf, { format: "markdown", mergeAcrossPages: true });
      expect(markdown[0]).toContain("| Gravel | 18.00 |");
      expect(markdown.join("\n").match(/Monthly inventory/g)).toHaveLength(1);
      expect(markdown.join("\n")).not.toMatch(/Page [12] of 2/);
      const standalone = yield* core.tables(pdf, {
        mergeAcrossPages: true,
        dropRunningHeaders: false,
      });
      expect(standalone).toHaveLength(2);
      const kept = yield* core.text(pdf, {
        format: "markdown",
        mergeAcrossPages: true,
        dropRunningHeaders: false,
      });
      expect(kept[1]).toContain("| Gravel | 18.00 |");
      expect(kept[1]).toContain("Page 2 of 2");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("joins complementary cells in a row cut at a page break", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = buildPdf([
        ruledTable(
          160,
          [
            ["Product", "Price"],
            ["Cement", "12.50"],
            ["Sand", ""],
          ],
          [20, 20, 11],
        ),
        ruledTable(
          750,
          [
            ["", "8.00"],
            ["Gravel", "18.00"],
            ["Bricks", "10.00"],
          ],
          [11, 20, 20],
        ),
      ]);
      const [table] = yield* core.tables(pdf, { mergeAcrossPages: true });
      expect(table).toMatchObject({ pages: [0, 1], rows: 5 });
      expect(table?.cells.filter((cell) => cell.row === 2).map((cell) => cell.text)).toEqual([
        "Sand",
        "8.00",
      ]);
      expect(table?.cells.find((cell) => cell.row === 2 && cell.col === 1)?.pageIndex).toBe(1);
      const markdown = yield* core.text(pdf, { format: "markdown", mergeAcrossPages: true });
      expect(markdown[0]).toContain("| Sand | 8.00 |");
      expect(markdown[1]).toBe("");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("merges a text-only table when the next page omits its header", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = buildPdf([
        ruledTable(160, [
          ["Nome", "Cidade"],
          ["Ana", "Recife"],
          ["Joao", "Natal"],
        ]),
        ruledTable(750, [
          ["Lia", "Manaus"],
          ["Pedro", "Santos"],
          ["Miguel", "Vitoria"],
        ]),
      ]);
      const options = { mergeAcrossPages: true };
      const [table, ...rest] = yield* core.tables(pdf, options);
      expect(rest).toEqual([]);
      expect(table).toMatchObject({ rows: 6, pages: [0, 1] });
      const markdown = yield* core.text(pdf, { format: "markdown", ...options });
      expect(markdown[0]).toContain("| Lia | Manaus |");
      expect(markdown[1]).toBe("");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("allows currency cells and a blank value in an otherwise compatible data row", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = buildPdf([
        ruledTable(160, [
          ["Product", "Price"],
          ["Cement", "R$ 1.234,00"],
          ["Sand", "R$ 8,00"],
        ]),
        ruledTable(750, [
          ["Gravel", ""],
          ["Bricks", "R$ 10,00"],
          ["Mortar", "R$ 15,00"],
        ]),
      ]);
      const [table, ...rest] = yield* core.tables(pdf, { mergeAcrossPages: true });
      expect(rest).toEqual([]);
      expect(table).toMatchObject({ rows: 6, pages: [0, 1] });
      expect(table?.cells.find((cell) => cell.row === 3 && cell.col === 1)?.text).toBe("");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps two full-height rows with complementary empty cells", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = buildPdf([
        ruledTable(160, [
          ["Product", "Price"],
          ["Cement", "12.50"],
          ["Sand", ""],
        ]),
        ruledTable(750, [
          ["Product", "Price"],
          ["", "8.00"],
          ["Gravel", "18.00"],
        ]),
      ]);
      const options = { mergeAcrossPages: true };
      const [table] = yield* core.tables(pdf, options);
      expect(table).toMatchObject({ rows: 5, pages: [0, 1] });
      expect(
        table?.cells.filter((cell) => cell.row === 2 || cell.row === 3).map((cell) => cell.text),
      ).toEqual(["Sand", "", "", "8.00"]);
      const markdown = yield* core.text(pdf, { format: "markdown", ...options });
      expect(markdown[0]).toContain("| Sand |  |\n|  | 8.00 |");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps unrelated edge tables with matching grids and distinct headers", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = buildPdf([
        ruledTable(160, [
          ["Product", "Price"],
          ["Cement", "12.50"],
          ["Sand", "8.00"],
        ]),
        ruledTable(750, [
          ["Department", "Budget"],
          ["Sales", "900"],
          ["Operations", "1100"],
        ]),
      ]);
      const options = { mergeAcrossPages: true };
      const tables = yield* core.tables(pdf, options);
      expect(tables).toEqual(yield* core.tables(pdf));
      const markdown = yield* core.text(pdf, { format: "markdown", ...options });
      expect(markdown[0]).toContain("| Product | Price |");
      expect(markdown[1]).toContain("| Department | Budget |");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a new emphasized header in an unrelated text-only edge table", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = buildPdf([
        ruledTable(160, [
          ["Name", "City"],
          ["Ana", "Recife"],
          ["Joao", "Natal"],
        ]),
        ruledTable(
          750,
          [
            ["Department", "Manager"],
            ["Sales", "Lia"],
            ["Operations", "Pedro"],
          ],
          [],
          true,
        ),
      ]);
      const options = { mergeAcrossPages: true };
      expect(yield* core.tables(pdf, options)).toHaveLength(2);
      const markdown = yield* core.text(pdf, { format: "markdown", ...options });
      expect(markdown[1]).toContain("| Department | Manager |");
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
