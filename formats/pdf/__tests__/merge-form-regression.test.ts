import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Result } from "effect";
import { readA1Fixture } from "../../../tooling/testing/fixtures";
import { PdfErrorCodeValue, PdfOperationValue } from "../src/config";
import { mergePdfs } from "../src/merge";
import { signPdf } from "../src/sign";
import { verifyPdf } from "../src/verify";
import { pdfCoreTestLayer } from "./pdf-core-layer";
import {
  createFixturePdf,
  editFixturePdf,
  fixtureDocument,
  objectSource,
  pdfSource,
  ref,
} from "./pdf-fixtures";

const PASSWORD = Redacted.make("changeit");

const createPdf = () => createFixturePdf();

const createForwardLengthPdf = (): Uint8Array => {
  const encoder = new TextEncoder();
  const stream = "q\nendstream\nQ\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length 5 0 R >>\nstream\n${stream}endstream\nendobj\n`,
    `5 0 obj\n${encoder.encode(stream).byteLength}\nendobj\n`,
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(encoder.encode(pdf).byteLength);
    pdf += object;
  }
  const xrefOffset = encoder.encode(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdf);
};

const createDocumentTimestampPdf = () =>
  createFixturePdf().pipe(
    Effect.flatMap((pdf) =>
      editFixturePdf(
        pdf,
        ({ next }) => [{ op: "setObject", ref: next(), value: "<< /Type /DocTimeStamp >>" }],
        { incremental: true },
      ),
    ),
  );

const createUnsignedAcroFormPdf = () =>
  createFixturePdf().pipe(
    Effect.flatMap((pdf) =>
      editFixturePdf(pdf, ({ next, page }) => {
        const link = next();
        const field = next();
        const widget = next();
        return [
          {
            op: "setObject",
            ref: link,
            value: `<< /Type /Annot /Subtype /Link /Rect [20 20 120 60] /Border [0 0 0] /A << /S /URI /URI (https://example.com) >> /P ${ref(page(0))} >>`,
          },
          {
            op: "setObject",
            ref: field,
            value: `<< /FT /Sig /T (UnsignedSignature) /Kids [${ref(widget)}] >>`,
          },
          {
            op: "setObject",
            ref: widget,
            value: `<< /Type /Annot /Subtype /Widget /Rect [20 20 120 60] /Parent ${ref(field)} /P ${ref(page(0))} >>`,
          },
          {
            op: "set",
            target: { base: { kind: "page", pageIndex: 0 } },
            key: "Annots",
            value: `[${ref(link)} ${ref(widget)}]`,
          },
          {
            op: "set",
            target: { base: { kind: "catalog" } },
            key: "AcroForm",
            value: `<< /Fields [${ref(field)}] >>`,
          },
        ];
      }),
    ),
  );

const mergedAnnotationState = (pdf: Uint8Array) =>
  fixtureDocument(pdf, [0]).pipe(
    Effect.map((document) => ({
      hasAcroForm: document.acroForm,
      hasSignatureObject: /\/FT\s*\/Sig\b|\/Type\s*\/Sig\b/u.test(pdfSource(pdf)),
      annotations: document.annotations.map((annotation) => ({
        widget: annotation.widget,
        uri: annotation.uri,
      })),
    })),
  );

describe("PDF merge signed and AcroForm boundaries", () => {
  it.effect("rejects a cryptographically signed source before merge", () =>
    Effect.gen(function* () {
      const pfx = yield* readA1Fixture("ecnpj");
      const source = yield* createPdf();
      const signed = yield* signPdf({ pdf: source, policy: "pades-icp-brasil" }).pipe(
        Effect.provide(a1SignaturesLayer({ pfx, password: PASSWORD })),
      );
      const verification = yield* verifyPdf({ pdf: signed });
      const result = yield* Effect.result(mergePdfs([signed]));

      expect(verification.valid).toBe(true);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe(PdfErrorCodeValue.invalidBuilderInput);
        expect(result.failure.operation).toBe(PdfOperationValue.mergeDocuments);
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("rejects a document-timestamp source before merge", () =>
    Effect.gen(function* () {
      const source = yield* createDocumentTimestampPdf();
      const result = yield* Effect.result(mergePdfs([source]));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe(PdfErrorCodeValue.invalidBuilderInput);
        expect(result.failure.operation).toBe(PdfOperationValue.mergeDocuments);
      }
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("merges an unsigned PDF with a forward indirect stream length", () =>
    Effect.gen(function* () {
      const source = createForwardLengthPdf();
      const sourcePageCount = (yield* fixtureDocument(source)).pages.length;
      const merged = yield* mergePdfs([source]);
      const mergedPageCount = (yield* fixtureDocument(merged)).pages.length;

      expect(sourcePageCount).toBe(1);
      expect(mergedPageCount).toBe(1);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect("drops unsigned AcroForm widgets while preserving other annotations", () =>
    Effect.gen(function* () {
      const source = yield* createUnsignedAcroFormPdf();
      const merged = yield* mergePdfs([source]);
      const state = yield* mergedAnnotationState(merged);

      expect(state.annotations).toStrictEqual([{ widget: false, uri: "https://example.com" }]);
      expect(state.hasAcroForm).toBe(false);
      expect(state.hasSignatureObject).toBe(false);
    }).pipe(Effect.provide(pdfCoreTestLayer)),
  );

  it.effect(
    "rewrites copied non-widget annotation page references without changing its properties",
    () =>
      Effect.gen(function* () {
        const source = yield* createUnsignedAcroFormPdf();
        const sourceBeforeMerge = source.slice();
        const merged = yield* mergePdfs([source]);
        const document = yield* fixtureDocument(merged, [0]);
        const pageRef = document.pages[0]?.ref;
        const annotation = document.annotations[0];

        expect(source).toStrictEqual(sourceBeforeMerge);
        expect(pageRef).toBeDefined();
        expect(annotation?.ref).toBeDefined();
        if (pageRef === undefined || annotation?.ref === undefined) return;

        const body = objectSource(merged, annotation.ref.number) ?? "";
        expect(body).toMatch(/\/Type\s*\/Annot\b/u);
        expect(body).toMatch(/\/Subtype\s*\/Link\b/u);
        expect(body).toContain(`/P ${ref(pageRef)}`);
        expect(annotation.rect).toStrictEqual([20, 20, 120, 60]);
        expect(body).toMatch(/\/Border\s*\[0 0 0\]/u);
        expect(body).toMatch(/\/S\s*\/URI\b/u);
        expect(annotation.uri).toBe("https://example.com");
      }).pipe(Effect.provide(pdfCoreTestLayer)),
  );
});
