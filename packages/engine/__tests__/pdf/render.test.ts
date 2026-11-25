import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";

import { displayListImageBlobs, displayListViewport } from "../../dist/wasm/canvas.js";
import { PDF_CORE_DEFAULT_RENDER_SCALE, PdfCoreErrorCodeValue } from "../../dist/wasm/config.js";
import { pdfCoreFileLayer } from "../../dist/wasm/file.js";
import { PdfCore } from "../../dist/wasm/pdf-core.js";
import { CORPUS_FIXTURE_NAMES, PDF_CORE_FIXTURES_DIR } from "./corpus.ts";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

const readFixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(PDF_CORE_FIXTURES_DIR, name)));

const singlePage = (content: string, resources = "<< >>"): Uint8Array => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources ${resources} >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
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

describe("PdfCore.renderPages", () => {
  it.effect("renders every corpus fixture into display lists", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      for (const name of CORPUS_FIXTURE_NAMES) {
        const lists = yield* core.renderPages(readFixture(name));
        expect(lists.length).toBeGreaterThan(0);
        lists.forEach((list, index) => {
          expect(list.pageIndex).toBe(index);
          expect(list.scale).toBeCloseTo(PDF_CORE_DEFAULT_RENDER_SCALE, 10);
          expect(list.view[2]).toBeGreaterThan(list.view[0]);
          expect(list.view[3]).toBeGreaterThan(list.view[1]);
          expect(list.ops.byteLength).toBeGreaterThan(0);
        });
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("honours page indexes, scale and page rotation in the viewport", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const lists = yield* core.renderPages(readFixture("rotated-cropped.pdf"), {
        pageIndexes: [1],
        scale: 2,
      });
      expect(lists).toHaveLength(1);
      const [list] = lists;
      if (list === undefined) return expect.fail("missing display list");
      expect(list.pageIndex).toBe(1);
      expect(list.rotate).toBe(270);
      expect(list.scale).toBe(2);
      const viewport = displayListViewport(list);
      const [x0, y0, x1, y1] = list.view;
      expect(viewport.width).toBe(Math.ceil((y1 - y0) * 2));
      expect(viewport.height).toBe(Math.ceil((x1 - x0) * 2));
      const upright = displayListViewport({ ...list, rotate: 0 }, 1);
      expect(upright.width).toBe(Math.ceil(x1 - x0));
      expect(upright.transform).toEqual([1, 0, 0, -1, -x0, y1]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns decoded images as blobs referenced by image operations", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const [list] = yield* core.renderPages(
        singlePage(
          "q 20 0 0 10 10 10 cm BI /W 2 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff000000ff00> EI Q",
        ),
        { scale: 1 },
      );
      if (list === undefined) return expect.fail("missing display list");
      const images = displayListImageBlobs(list);
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ jpeg: false, width: 2, height: 1 });
      expect(Array.from(list.blobs[images[0]?.blob ?? 0] ?? [])).toEqual([
        255, 0, 0, 255, 0, 255, 0, 255,
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails with typed errors on invalid options, documents and pages", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      for (const options of [{ scale: 0 }, { scale: 65 }, { pageIndexes: [-1] }]) {
        const result = yield* Effect.result(core.renderPages(readFixture("links.pdf"), options));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe(PdfCoreErrorCodeValue.invalidOptions);
          expect(result.failure.operation).toBe("pdfCore.render");
          expect(result.failure.schemaName).toBe("PdfCoreRenderOptions");
        }
      }
      const invalid = yield* Effect.flip(core.renderPages(new Uint8Array([1, 2, 3])));
      expect(invalid.code).toBe(PdfCoreErrorCodeValue.invalidPdf);
      const outOfRange = yield* Effect.flip(
        core.renderPages(readFixture("links.pdf"), { pageIndexes: [4] }),
      );
      expect(outOfRange.code).toBe(PdfCoreErrorCodeValue.invalidPdf);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("survives hostile content and truncated documents", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const hostile = [
        "q q q q Q Q Q Q Q Q Q 1e999 0 0 1 0 0 cm 0 0 10 10 re W* n BT /F9 12 Tf (x) Tj ET",
        "BI /W 99999 /H 99999 /CS /RGB /BPC 8 ID abc EI",
        "/Missing Do /Missing sh 0 0 m 1 1 l 2 2 3 3 4 4 c h B*",
        Array.from({ length: 300 }, () => "q 1 0 0 1 1 1 cm").join(" "),
      ];
      for (const content of hostile) {
        const lists = yield* core.renderPages(singlePage(content));
        expect(lists).toHaveLength(1);
      }
      const fixture = readFixture("react-pdf-declaration.pdf");
      for (const length of [200, 1000, fixture.byteLength >> 1]) {
        const outcome = yield* Effect.result(core.renderPages(fixture.subarray(0, length)));
        if (Result.isFailure(outcome)) {
          expect(outcome.failure._tag).toBe("PdfCoreError");
        }
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("releases wasm memory across repeated renders", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = readFixture("habilitacao-150.pdf");
      for (let round = 0; round < 20; round += 1) {
        const lists = yield* core.renderPages(pdf, { pageIndexes: [round] });
        expect(lists).toHaveLength(1);
      }
      const all = yield* core.renderPages(pdf);
      expect(all).toHaveLength(150);
    }).pipe(Effect.provide(layer)),
  );
});
