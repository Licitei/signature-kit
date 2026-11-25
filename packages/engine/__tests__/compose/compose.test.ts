import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Box,
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
    expect(
      fields.fields.map(({ name, widgets, signed }) => ({
        name,
        signed,
        widgets: widgets.map(({ page, rect }) => ({ page, rect })),
      })),
    ).toEqual([
      {
        name: "assinatura-contratada",
        signed: false,
        widgets: [{ page: 1, rect: [306.6378, 303.4398, 543.2756, 355.4398] }],
      },
      {
        name: "assinatura-contratante",
        signed: false,
        widgets: [{ page: 1, rect: [52, 303.4398, 288.6378, 355.4398] }],
      },
    ]);
    expect(inspection.text[1]?.text).toContain("assinatura-contratada");
    expect(inspection.text[1]?.text).toContain("assinatura-contratante");
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

it.effect.skipIf(!available)("extracts every template page exactly with Poppler", () =>
  Effect.gen(function* () {
    const tmp = yield* directory;
    const templates = {
      contract: contractTemplate(),
      report: evidenceReportTemplate(sampleEvidence),
      receipt: receiptTemplate(),
    };
    for (const [name, document] of Object.entries(templates)) {
      const file = join(tmp, `${name}.pdf`);
      const bytes = yield* compose(document);
      yield* Effect.promise(() => writeFile(file, bytes));
      const output = yield* program("pdftotext", ["-raw", file, "-"]);
      const pages = output.split("\f").filter((page) => page.length > 0);
      expect(pages).toMatchSnapshot(name);
    }
  }).pipe(Effect.provide(layer)),
);

const pageContents = Effect.fn(function* (file: string, page: number) {
  const pages = yield* program("qpdf", ["--show-pages", file]);
  const object = [...pages.matchAll(/content:\n\s+(\d+) \d+ R/g)][page]?.[1];
  expect(object).toBeDefined();
  return yield* program("qpdf", [`--show-object=${object}`, "--filtered-stream-data", file]);
});

it.effect.skipIf(!available)("paints the signature boxes at the widget bounds", () =>
  Effect.gen(function* () {
    const tmp = yield* directory;
    const file = join(tmp, "contract.pdf");
    const bytes = yield* compose(contractTemplate());
    yield* Effect.promise(() => writeFile(file, bytes));
    const content = yield* pageContents(file, 1);
    const core = yield* PdfCore;
    const { fields } = yield* core.signatureFields(bytes);
    expect(fields).toHaveLength(2);
    for (const { widgets } of fields) {
      const rect = widgets[0]?.rect;
      if (rect === undefined) return expect.fail("Missing widget rectangle");
      const [left, bottom, right, top] = rect.map((value) => value.toFixed(4));
      const insetLeft = (rect[0] + 4).toFixed(4);
      const insetRight = (rect[2] - 4).toFixed(4);
      const insetBottom = (rect[1] + 4).toFixed(4);
      const insetTop = (rect[3] - 4).toFixed(4);
      expect(content).toContain(`${insetLeft} ${bottom} m ${insetRight} ${bottom} l`);
      expect(content).toContain(`${right} ${insetTop} l`);
      expect(content).toContain(`${insetLeft} ${top} l`);
      expect(content).toContain(`${left} ${insetBottom} l`);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect.skipIf(!available)("aligns nested, padded text of two sizes to one row baseline", () =>
  Effect.gen(function* () {
    const tmp = yield* directory;
    const file = join(tmp, "baseline.pdf");
    const bytes = yield* compose(
      Document(
        Page([
          Row(
            [
              Text("01", { fontSize: 8, margin: [4, 0, 0, 0] }),
              Box([Text("Heading", { fontSize: 21 })], { padding: [7, 0, 0, 0] }),
            ],
            { align: "baseline" },
          ),
        ]),
      ),
    );
    yield* Effect.promise(() => writeFile(file, bytes));
    const content = yield* pageContents(file, 0);
    const baselinePositions = [...content.matchAll(/ 1 0 0 1 [\d.]+ ([\d.]+) Tm /g)].map(
      ([, y]) => y,
    );
    expect(baselinePositions).toHaveLength(2);
    expect(new Set(baselinePositions).size).toBe(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps verified revocation separate from unassessed evidence", () =>
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const signers = [
      {
        field: "first",
        coverage: { kind: "partial" },
        integrity: "invalid",
        trust: "untrusted",
        revocation: { kind: "verified", status: "revoked" },
      },
      {
        field: "second",
        coverage: { kind: "wholeFile" },
        integrity: "valid",
        trust: "trusted",
        revocation: { kind: "verified", status: "good" },
      },
    ] satisfies typeof sampleEvidence.signers;
    const bytes = yield* compose(evidenceReportTemplate({ ...sampleEvidence, signers }));
    const pages = yield* core.text(bytes);
    const extracted = pages.join("\n");
    for (const label of ["violada", "não confiável", "revogada", "válida", "não avaliadas"]) {
      expect(extracted).toContain(label);
    }
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
    const copied = Document(Page([Image(png.slice(), { width: 100, height: 30 }, "cover")]));
    const [pdf, duplicate] = yield* Effect.all([compose(doc), compose(copied)], {
      concurrency: 2,
    });
    expect(duplicate).toEqual(pdf);
    const core = yield* PdfCore;
    const [page] = yield* core.pageDiagnostics(pdf);
    expect(page?.imageCount).toBe(1);
    png.fill(0);
    const invalid = yield* Effect.flip(compose(doc));
    expect(invalid.code).toBe("composeFailed");
    expect(yield* compose(copied)).toEqual(pdf);
  }).pipe(Effect.provide(layer)),
);
