import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";

import { PdfCoreErrorCodeValue } from "../dist/config.js";
import { pdfCoreFileLayer } from "../dist/file.js";
import { PdfCore } from "../dist/pdf-core.js";

const layer = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));
const encoder = new TextEncoder();

const buildPdf = (objects: ReadonlyArray<string>): Uint8Array => {
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
  return encoder.encode(pdf);
};

const stream = (content: string): string =>
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;

const twoPages = (): Uint8Array =>
  buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
    stream("BT /F1 12 Tf 20 150 Td (First) Tj ET"),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 7 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
    stream("BT /F1 12 Tf 20 150 Td (Second) Tj ET"),
  ]);

const inflate = (bytes: Uint8Array): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  });

const startsWith = (data: Uint8Array, prefix: Uint8Array): boolean =>
  prefix.every((byte, index) => data[index] === byte);

describe("PdfCore write path", () => {
  it.effect("describes pages, annotations and the next free signature field name", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = twoPages();
      const description = yield* core.document(pdf, {
        annotationPages: [0],
        fieldNamePrefix: "Sig",
      });

      expect(description.nextObjectNumber).toBe(8);
      expect(description.acroForm).toBe(false);
      expect(description.pages.map((page) => page.ref?.number)).toEqual([4, 6]);
      expect(description.pages[0]?.mediaBox).toEqual([0, 0, 300, 200]);
      expect(description.annotations).toEqual([]);
      expect(description.fieldName).toEqual({ _tag: "available", name: "Sig1" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("appends a signature placeholder as an incremental update", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = twoPages();
      const before = yield* core.signatures(pdf, "scan");
      expect(before.dictionaries).toEqual([]);

      const signed = yield* core.edit(pdf, [
        {
          op: "signature",
          ref: { number: 8, generation: 0 },
          contentsLength: 64,
          entries: "<< /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached >>",
        },
        {
          op: "setObject",
          ref: { number: 9, generation: 0 },
          value:
            "<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /V 8 0 R /T (Sig1) /F 4 /P 4 0 R >>",
        },
        {
          op: "append",
          target: { base: { kind: "page", pageIndex: 0 } },
          key: "Annots",
          value: "9 0 R",
        },
        { op: "setObject", ref: { number: 10, generation: 0 }, value: "<< /Fields [] >>" },
        { op: "set", target: { base: { kind: "catalog" } }, key: "AcroForm", value: "10 0 R" },
        {
          op: "append",
          target: { base: { kind: "catalog" }, path: ["AcroForm"] },
          key: "Fields",
          value: "9 0 R",
        },
        {
          op: "setFlags",
          target: { base: { kind: "catalog" }, path: ["AcroForm"] },
          key: "SigFlags",
          flags: 3,
        },
      ]);

      expect(startsWith(signed, pdf)).toBe(true);
      const report = yield* core.signatures(signed, "dictionaries");
      expect(report.failure).toBeUndefined();
      expect(report.dictionaries).toHaveLength(1);
      expect(report.dictionaries[0]?.unsignedPlaceholder).toBe(true);
      expect(report.dictionaries[0]?.kind).toBe("signature");
      expect(yield* core.revisionComplete(signed, pdf.byteLength)).toBe(true);
      expect(yield* core.revisionComplete(signed, signed.byteLength)).toBe(true);
      expect(yield* core.revisionComplete(signed, signed.byteLength - 3)).toBe(false);
      const description = yield* core.document(signed, { annotationPages: [0] });
      expect(description.acroForm).toBe(true);
      expect(description.annotations).toHaveLength(1);
      expect(description.annotations[0]?.widget).toBe(true);
      expect(yield* core.text(signed)).toEqual(yield* core.text(pdf));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("stamps page content with standard fonts and images", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = twoPages();
      const samples = new Uint8Array([255, 0, 0, 128, 0, 255, 0, 255]);
      const stamped = yield* core.edit(pdf, [
        { op: "standardFont", ref: { number: 8, generation: 0 }, baseFont: "Helvetica-Bold" },
        {
          op: "addResource",
          pageIndex: 1,
          category: "Font",
          name: "SK1",
          value: "8 0 R",
        },
        {
          op: "image",
          ref: { number: 9, generation: 0 },
          softMaskRef: { number: 10, generation: 0 },
          width: 2,
          height: 1,
          colorSpace: "rgb",
          alpha: true,
          samples,
        },
        { op: "addResource", pageIndex: 1, category: "XObject", name: "SKI", value: "9 0 R" },
        {
          op: "appendContent",
          pageIndex: 1,
          ref: { number: 11, generation: 0 },
          wrapRef: { number: 12, generation: 0 },
          data: encoder.encode(
            "q 20 0 0 10 10 10 cm /SKI Do Q BT /SK1 10 Tf 20 100 Td (Stamp) Tj ET",
          ),
          compress: true,
        },
      ]);
      const pages = yield* core.text(stamped);

      expect(pages[0]).toBe("First");
      expect(pages[1]).toContain("Second");
      expect(pages[1]).toContain("Stamp");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rewrites with object streams and merges selected pages", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = twoPages();
      const packed = yield* core.edit(pdf, [{ op: "repairCatalog" }], {
        mode: "rewrite",
        objectStreams: true,
      });
      expect(yield* core.text(packed)).toEqual(["First", "Second"]);

      const updated = yield* core.edit(
        packed,
        [{ op: "set", target: { base: { kind: "catalog" } }, key: "Lang", value: "(pt-BR)" }],
        { mode: "incremental" },
      );
      expect(startsWith(updated, packed)).toBe(true);
      expect(yield* core.revisionComplete(updated, packed.byteLength)).toBe(true);

      const merged = yield* core.merge([{ pdf, pageIndexes: [1] }, { pdf: packed }], {
        objectStreams: true,
      });
      expect(yield* core.text(merged)).toEqual(["Second", "First", "Second"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("deflates bytes into a zlib stream", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const data = encoder.encode("0 0 m 100 100 l S\n".repeat(500));
      const compressed = yield* core.deflate(data);

      expect(compressed.byteLength).toBeLessThan(data.byteLength / 10);
      expect(yield* inflate(compressed)).toEqual(data);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects malformed edit operations with typed option errors", () =>
    Effect.gen(function* () {
      const core = yield* PdfCore;
      const pdf = twoPages();
      const syntax = yield* Effect.result(
        core.edit(pdf, [
          { op: "setObject", ref: { number: 8, generation: 0 }, value: "<< /A 1 >> trailing" },
        ]),
      );
      const page = yield* Effect.result(
        core.edit(pdf, [
          {
            op: "append",
            target: { base: { kind: "page", pageIndex: 9 } },
            key: "Annots",
            value: "null",
          },
        ]),
      );
      const incremental = yield* Effect.result(
        core.edit(
          encoder.encode(
            "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n",
          ),
          [],
          {
            mode: "incremental",
          },
        ),
      );

      for (const result of [syntax, page, incremental]) {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe(PdfCoreErrorCodeValue.invalidOptions);
        }
      }
    }).pipe(Effect.provide(layer)),
  );
});
