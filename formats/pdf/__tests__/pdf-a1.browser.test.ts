import { readA1FixtureFromBrowser } from "../../../tooling/testing/fixtures.browser";
import { describe, expect, it } from "vitest";
import { a1SignaturesLayer, parseA1CertificateProfile } from "@signature-kit/a1/signer";
import {
  addPdfSignatureField,
  createPdfSignatureTemplate,
  pdfSignatureFieldFromPlacement,
} from "@signature-kit/pdf/builder";
import { signPdfSignatureField } from "@signature-kit/pdf/workflow";
import { pdfCoreBrowserLayer } from "@signature-kit/pdf-core/browser";
import { findPdfTextAnchors } from "../src/anchors";
import {
  acroFormField,
  createFixturePdf,
  entryRef,
  objectSource,
  pdfStringEntry,
} from "./pdf-fixtures";
import { renderPdfPagesBrowser } from "../src/render-browser";
import { resolveSignatureWidgetPlacement } from "../src/placement";
import { Effect, Redacted, Result } from "effect";

const PASSWORD = Redacted.make("changeit");
const latin1 = new TextDecoder("latin1");

const createPdf = createFixturePdf([
  { text: [{ x: 32, y: 118, size: 14, text: "SignatureKit PDF signing" }] },
]).pipe(Effect.provide(pdfCoreBrowserLayer));

const createTemplate = () =>
  createPdfSignatureTemplate({
    id: "browser-template",
    name: "Browser A1 template",
    documents: [
      {
        id: "uploaded",
        name: "uploaded.pdf",
        source: { type: "uploaded" },
        pages: [{ index: 0, width: 320, height: 180, label: "Página 1" }],
      },
    ],
    roles: [{ id: "signer-1", label: "Cliente", email: "ana@example.com", required: true }],
  });

if (typeof document === "undefined") {
  describe.skip("PDF signing package", () => {
    it("runs only through `bun run test:integration:browser`", () => {});
  });
} else {
  describe("PDF signing package", () => {
    it("loads an A1 certificate and signs a PDF in Chromium", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const pfx = yield* readA1FixtureFromBrowser("ecpf");
          const pdf = yield* createPdf;
          const profile = yield* parseA1CertificateProfile({ pfx, password: PASSWORD });
          const template = yield* createTemplate();
          const field = yield* pdfSignatureFieldFromPlacement({
            documentId: "uploaded",
            pageIndex: 0,
            x: 40,
            y: 110,
            draft: {
              id: "signature-1",
              type: "signature",
              roleId: "signer-1",
              width: 120,
              height: 32,
              label: "Assinatura A1",
              required: true,
            },
          });
          const withField = yield* addPdfSignatureField(template, field);
          const signed = yield* signPdfSignatureField({
            pdf,
            template: withField,
            fieldId: "signature-1",
            reason: "Chromium browser A1 test",
            name: "Pessoa CPF:12345678901",
            location: "BR",
            signatureLength: 16384,
          }).pipe(Effect.provide(a1SignaturesLayer({ pfx, password: PASSWORD })));
          const text = latin1.decode(signed);
          const signatureNumber = entryRef(acroFormField(signed, 0), "V");
          const reason = pdfStringEntry(
            signatureNumber === undefined ? "" : (objectSource(signed, signatureNumber) ?? ""),
            "Reason",
          );

          expect(profile.document).toBe("12345678901");
          expect(signed.byteLength).toBeGreaterThan(pdf.byteLength);
          expect(text).toContain("/ByteRange");
          expect(text).toContain("/SubFilter /adbe.pkcs7.detached");
          expect(reason).toBe("Chromium browser A1 test");
        }).pipe(Effect.provide(pdfCoreBrowserLayer)),
      ));

    it("finds text anchors with the in-house pdf core in Chromium", async () => {
      const pdf = await Effect.runPromise(createPdf);
      const anchors = await Effect.runPromise(
        findPdfTextAnchors({
          pdf,
          matchers: [{ text: "SignatureKit" }],
          stampSize: { width: 80, height: 20 },
          placement: "below",
          offset: 0,
        }).pipe(Effect.provide(pdfCoreBrowserLayer)),
      );

      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.pageIndex).toBe(0);
      expect(anchors[0]?.x).toBeCloseTo(32, 0);
    }, 20_000);

    it("renders every page to PNG thumbnails with the in-house pdf core", async () => {
      const pdf = await Effect.runPromise(createPdf);
      const pages = await Effect.runPromise(
        renderPdfPagesBrowser(pdf).pipe(Effect.provide(pdfCoreBrowserLayer)),
      );
      expect(pages).toHaveLength(1);
      expect(pages[0]?.pageIndex).toBe(0);
      expect(pages[0]?.width).toBe(Math.ceil((320 * 150) / 72));
      expect(pages[0]?.height).toBe(Math.ceil((180 * 150) / 72));
      expect(pages[0]?.image.type).toBe("image/png");
      const bitmap = await createImageBitmap(pages[0]?.image ?? new Blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (context === null) return expect.fail("2D context unavailable");
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let dark = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if ((pixels[index] ?? 255) < 96) dark += 1;
      }
      expect(dark).toBeGreaterThan(200);
      const scaled = await Effect.runPromise(
        renderPdfPagesBrowser(pdf, { pageIndexes: [0], scale: 1 }).pipe(
          Effect.provide(pdfCoreBrowserLayer),
        ),
      );
      expect(scaled[0]?.width).toBe(320);
    }, 20_000);

    it("rejects invalid render options and unreadable PDFs with typed errors", async () => {
      for (const options of [{ scale: 0 }, { scale: 9 }, { pageIndexes: [-1] }]) {
        const result = await Effect.runPromise(
          Effect.result(
            renderPdfPagesBrowser(new Uint8Array([1]), options).pipe(
              Effect.provide(pdfCoreBrowserLayer),
            ),
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe("pdf.INVALID_PDF");
          expect(result.failure.operation).toBe("pdf.page.render");
          expect(result.failure.schemaName).toBe("PdfPageRenderOptions");
        }
      }
      const unreadable = await Effect.runPromise(
        Effect.result(
          renderPdfPagesBrowser(new Uint8Array([1, 2, 3])).pipe(
            Effect.provide(pdfCoreBrowserLayer),
          ),
        ),
      );
      expect(Result.isFailure(unreadable)).toBe(true);
      if (Result.isFailure(unreadable)) {
        expect(unreadable.failure.code).toBe("pdf.INVALID_PDF");
        expect(unreadable.failure.operation).toBe("pdf.page.render");
      }
    }, 20_000);

    it("resolves normal placement and rejects non-advancing automatic grids", async () => {
      const pdf = await Effect.runPromise(
        createFixturePdf().pipe(Effect.provide(pdfCoreBrowserLayer)),
      );
      const normal = await Effect.runPromise(
        resolveSignatureWidgetPlacement(pdf, {
          placement: {
            kind: "auto",
            pageIndex: 0,
            width: 120,
            height: 40,
            margin: 20,
            gap: 8,
            anchor: "bottom-right",
          },
        }).pipe(Effect.provide(pdfCoreBrowserLayer)),
      );
      expect(normal.widgetRect).toEqual([180, 20, 300, 60]);

      const result = await Effect.runPromise(
        Effect.result(
          resolveSignatureWidgetPlacement(pdf, {
            placement: {
              kind: "auto",
              pageIndex: 0,
              width: Number.MIN_VALUE,
              height: 40,
              margin: 20,
              gap: 0,
            },
          }),
        ).pipe(Effect.provide(pdfCoreBrowserLayer)),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe("pdf.SIGNATURE_PLACEMENT_FAILED");
      }

      const denseGridResult = await Effect.runPromise(
        Effect.result(
          resolveSignatureWidgetPlacement(pdf, {
            placement: {
              kind: "auto",
              pageIndex: 0,
              width: Number.MIN_VALUE,
              height: 40,
              margin: 0,
              gap: 0,
            },
          }),
        ).pipe(Effect.provide(pdfCoreBrowserLayer)),
      );
      expect(Result.isFailure(denseGridResult)).toBe(true);
      if (Result.isFailure(denseGridResult)) {
        expect(denseGridResult.failure.code).toBe("pdf.SIGNATURE_PLACEMENT_FAILED");
      }
    });
  });
}
