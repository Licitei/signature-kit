import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compose,
  Document,
  Image,
  Link,
  Row,
  Page,
  PageNumber,
  Stack,
  Table,
  Text,
  TotalPages,
} from "../../dist/compose.js";
import {
  contractTemplate,
  evidenceReportTemplate,
  receiptTemplate,
  sampleEvidence,
} from "../../dist/templates.js";
import { composeFileLayer } from "../../dist/wasm/compose.js";
import { pdfCoreFileLayer } from "../../dist/wasm/file.js";
import { PdfCore } from "../../dist/wasm/pdf-core.js";

const layer = Layer.merge(composeFileLayer, pdfCoreFileLayer).pipe(
  Layer.provide(NodeServices.layer),
);
const program = (name: string, args: string[]) =>
  Effect.sync(() => {
    const result = spawnSync(name, args, { encoding: "utf8", timeout: 20000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  });
const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "signature-kit-compose-test-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true })),
);
const available = ["qpdf", "pdffonts", "pdftotext"].every(
  (name) => spawnSync(name, [name === "qpdf" ? "--version" : "-v"]).status === 0,
);

it.effect.skipIf(!available)(
  "embeds subsets with exact UTF-8 extraction and produces identical bytes twice",
  () =>
    Effect.gen(function* () {
      const message = "Ação pública: revisão, conformidade e São João.";
      const document = Document(Page([Text(message)]));
      const pdf = yield* compose(document);
      expect(yield* compose(document)).toEqual(pdf);
      const core = yield* PdfCore;
      expect(yield* core.text(pdf)).toEqual([message]);
      const tmp = yield* directory;
      const file = join(tmp, "text.pdf");
      yield* Effect.promise(() => writeFile(file, pdf));
      yield* program("qpdf", ["--check", file]);
      const fonts = yield* program("pdffonts", [file]);
      expect(fonts).toMatch(/CID TrueType\s+Identity-H\s+yes\s+yes\s+yes/);
      expect(yield* program("pdftotext", ["-nopgbrk", file, "-"])).toBe(`${message}\n\n`);
    }).pipe(Effect.provide(layer)),
);

it.effect.skipIf(!available)("embeds a CID-keyed CFF subset with portable extraction", () =>
  Effect.gen(function* () {
    const message = "Condições de prestação e execução.";
    const pdf = yield* compose(Document(Page([Text(message, { fontStyle: "italic" })])));
    const core = yield* PdfCore;
    expect(yield* core.text(pdf)).toEqual([message]);
    const tmp = yield* directory;
    const file = join(tmp, "cff.pdf");
    yield* Effect.promise(() => writeFile(file, pdf));
    yield* program("qpdf", ["--check", file]);
    expect(yield* program("pdffonts", [file])).toMatch(
      /CID Type 0C\s+Identity-H\s+yes\s+yes\s+yes/,
    );
    expect(yield* program("pdftotext", ["-nopgbrk", file, "-"])).toBe(`${message}\n\n`);
  }).pipe(Effect.provide(layer)),
);

it.effect("produces all three templates with expected page geometry, anchors and links", () =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const contract = yield* compose(contractTemplate());
    const inspection = yield* core.inspect(contract, { text: true, runs: true, links: false });
    expect(inspection.pages).toHaveLength(2);
    const fields = yield* core.signatureFields(contract);
    expect(new Set(fields.fields.map(({ name }) => name))).toEqual(
      new Set(["assinatura-contratada", "assinatura-contratante"]),
    );
    for (const field of fields.fields) {
      const widget = field.widgets[0];
      expect(widget?.page).toBe(1);
      expect(field.signed).toBe(false);
      const page = inspection.text[1];
      if (page === undefined || widget?.rect === undefined)
        return expect.fail("Missing signature geometry");
      const offsets = Array.from(page.offsets);
      const item = offsets.findIndex(
        (offset, index) => page.text.slice(offset, offsets[index + 1]).trim() === field.name,
      );
      expect(item).toBeGreaterThanOrEqual(0);
      const [left] = page.rects.slice(item * 5, item * 5 + 4);
      expect(left).toBeCloseTo(widget.rect[0], 0);
    }
    expect(yield* core.text(yield* compose(evidenceReportTemplate(sampleEvidence)))).toHaveLength(
      1,
    );
    const receipt = yield* core.inspect(yield* compose(receiptTemplate()), {
      links: true,
      text: false,
    });
    expect(receipt.pages).toHaveLength(1);
    expect(receipt.links).toMatchObject([{ uri: "https://signaturekit.dev", pageIndex: 0 }]);
  }).pipe(Effect.provide(layer)),
);

it.effect("repeats table headers at automatic breaks and validates style keys", () =>
  Effect.gen(function* () {
    const document = Document(
      Page(
        [
          Table(
            [Text("Cabeçalho")],
            Array.from({ length: 10 }, (_, index) => Text(`Linha ${index + 1}`, { height: 26 })),
          ),
        ],
        {
          size: [240, 140],
          margins: 12,
          footer: Stack([Text([PageNumber(), "/", TotalPages()])]),
        },
      ),
    );
    const core = yield* PdfCore;
    const pages = yield* core.text(yield* compose(document));
    expect(pages).toHaveLength(4);
    for (const page of pages) expect(page).toContain("Cabeçalho");
    const unsupported = { fontSize: 10, italicize: true };
    const invalid = Document(Page([Text("estilo", unsupported)]));
    const failure = yield* Effect.flip(compose(invalid));
    expect(failure).toMatchObject({ code: "invalidDocument" });
    expect(failure.reason).toContain("italicize");
  }).pipe(Effect.provide(layer)),
);

it.effect("resolves horizontal wrapping and vertical flex bases and growth", () =>
  Effect.gen(function* () {
    const link = (name: string, style: Parameters<typeof Link>[2]) =>
      Link(`https://signaturekit.dev/${name}`, [Text(name)], style);
    const pdf = yield* compose(
      Document(
        Page(
          [
            Stack([link("first", { basis: 20, grow: 1 }), link("second", { basis: 20, grow: 3 })], {
              height: 100,
            }),
            Row([link("left", { basis: 100 }), link("right", { basis: 100 })], {
              width: 170,
              gap: 8,
              wrap: true,
            }),
          ],
          { margins: 20 },
        ),
      ),
    );
    const core = yield* PdfCore;
    const { links } = yield* core.inspect(pdf, { links: true, text: false });
    const [first, second, left, right] = links;
    if (first === undefined || second === undefined || left === undefined || right === undefined) {
      return expect.fail("Missing URI annotations");
    }
    expect(first.rect[3] - first.rect[1]).toBeCloseTo(35);
    expect(second.rect[3] - second.rect[1]).toBeCloseTo(65);
    expect(left.rect[0]).toBeCloseTo(right.rect[0]);
    expect(left.rect[1]).toBeGreaterThan(right.rect[3]);
  }).pipe(Effect.provide(layer)),
);

it.effect("embeds a PNG alpha channel and rejects a damaged image", () =>
  Effect.gen(function* () {
    const png = Uint8Array.fromBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPjfAAACgwGALqKZRAAAAABJRU5ErkJggg==",
    );
    const doc = Document(Page([Image(png, { width: 100, height: 30 }, "cover")]));
    const pdf = yield* compose(doc);
    const core = yield* PdfCore;
    const [page] = yield* core.pageDiagnostics(pdf);
    expect(page?.imageCount).toBe(1);
    const invalid = yield* Effect.flip(compose(Document(Page([Image(png.slice(0, 8))]))));
    expect(invalid.code).toBe("composeFailed");
  }).pipe(Effect.provide(layer)),
);
