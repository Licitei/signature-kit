import * as NodeServices from "@effect/platform-node/NodeServices";
import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import { pdfCoreFileLayer } from "@signature-kit/pdf-core/file";
import { signPdf } from "@signature-kit/pdf/sign";
import { Effect, Layer, Redacted, Result } from "effect";
import * as RpcTest from "effect/rpc/RpcTest";
import { expect, it } from "vitest";
import { createPdfFixture, readA1Fixture } from "../../../tooling/testing/fixtures";
import {
  CertificateWorkerRequests,
  PdfCoreWorkerRequests,
  VerifyWorkerRequests,
  XmlWorkerRequests,
} from "./tool-rpc";
import { certificateWorkerHandlersLayer } from "./tool-certificate";
import { declaredSigningTime, verifyWorkerHandlersLayer } from "./tool-verify";
import { xmlWorkerHandlersLayer } from "./tool-xml";
import { pdfCoreWorkerHandlersLayer } from "./tool-pdfcore";
import { textPdf } from "../__tests__/helpers/text-pdf";

const pdfCore = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));

it("reports each signature of a signed PDF and detects tampering", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pfx = yield* readA1Fixture("ecpf");
        const signingTime = new Date("2026-03-04T05:06:07Z");
        const signed = yield* signPdf({
          pdf: createPdfFixture(),
          policy: "pades-icp-brasil",
          signingTime,
        }).pipe(Effect.provide(a1SignaturesLayer({ pfx, password: Redacted.make("changeit") })));
        const client = yield* RpcTest.makeClient(VerifyWorkerRequests);
        const reports = yield* client.VerifyPdf({ pdf: signed });
        expect(reports).toHaveLength(1);
        const report = reports[0];
        expect(report).toMatchObject({
          index: 0,
          intact: true,
          coverage: true,
          coversFileEnd: true,
          declaredAt: signingTime.getTime(),
        });
        expect(report?.signer).toEqual(expect.any(String));
        expect(report?.cpf).toMatch(/^\d{11}$/);
        expect(report?.issuer).toEqual(expect.any(String));
        expect(report?.validTo ?? 0).toBeGreaterThan(report?.validFrom ?? 0);
        expect(report?.format).toContain("ETSI.CAdES.detached");

        const tampered = new Uint8Array(signed);
        const marker = new TextEncoder().encode("MediaBox [0 0 200 200]");
        const at = tampered.findIndex((_, index) =>
          marker.every((byte, offset) => tampered[index + offset] === byte),
        );
        tampered[at + 15] = 0x33;
        const broken = yield* client.VerifyPdf({ pdf: tampered });
        expect(broken.map((item) => item.intact)).toEqual([false]);

        const unsigned = yield* Effect.result(client.VerifyPdf({ pdf: createPdfFixture() }));
        expect(Result.isFailure(unsigned)).toBe(true);
        if (Result.isFailure(unsigned))
          expect(unsigned.failure).toMatchObject({ code: "pdf.PLACEHOLDER_NOT_FOUND" });
      }),
    ).pipe(Effect.provide(verifyWorkerHandlersLayer.pipe(Layer.provideMerge(pdfCore)))),
  );
});

it("reads the declared signing time only from the signature object", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const head =
    "1 0 obj\n<< /M (D:20200101000000Z) >>\nendobj\n5 0 obj\n<< /Type /Sig /M (D:20260304050607-03'00') /Contents <";
  const tail = "> >>\nendobj\n6 0 obj\n<< /M (D:20300101000000Z) >>\nendobj\n";
  const pdf = encode(`${head}00${tail}`);
  expect(declaredSigningTime(pdf, [0, head.length, head.length + 2, tail.length])).toBe(
    Date.UTC(2026, 2, 4, 8, 6, 7),
  );
  const bare = encode(
    "5 0 obj\n<< /Type /Sig /Contents <00> >>\nendobj\n1 0 obj << /M (D:2030) >>",
  );
  expect(declaredSigningTime(bare, [0, 33, 35, 10])).toBeNull();
});

it("reads holder, document and validity from a PKCS#12 file", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(CertificateWorkerRequests);
        const report = yield* client.ReadCertificate({
          pfx: yield* readA1Fixture("ecnpj"),
          password: "changeit",
        });
        expect(report.cnpj).toMatch(/^\d{14}$/);
        expect(report.holder.length).toBeGreaterThan(0);
        expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(report.validTo).toBeGreaterThan(report.validFrom);
        expect(["valid", "expired", "notYetValid"]).toContain(report.status);
        const wrong = yield* Effect.result(
          client.ReadCertificate({ pfx: yield* readA1Fixture("ecnpj"), password: "wrong" }),
        );
        expect(Result.isFailure(wrong)).toBe(true);
      }),
    ).pipe(Effect.provide(certificateWorkerHandlersLayer)),
  );
});

it("signs an XML document with an enveloped XML-DSig signature", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(XmlWorkerRequests);
        const pfx = yield* readA1Fixture("ecpf");
        const whole = yield* client.SignXml({
          xml: '<?xml version="1.0" encoding="UTF-8"?><pedido><item>Ação</item></pedido>',
          pfx,
          password: "changeit",
        });
        expect(whole.verified).toBe(true);
        expect(whole.signatureCount).toBe(1);
        expect(whole.xml).toContain("<ds:Signature");
        expect(whole.xml).toContain("Ação");
        const scoped = yield* client.SignXml({
          xml: '<lote><doc Id="d1"><valor>10</valor></doc></lote>',
          pfx,
          password: "changeit",
          referenceId: "d1",
        });
        expect(scoped.verified).toBe(true);
        expect(scoped.referenceUris).toEqual(["#d1"]);
        const invalid = yield* Effect.result(
          client.SignXml({ xml: "<aberto>", pfx, password: "changeit" }),
        );
        expect(Result.isFailure(invalid)).toBe(true);
      }),
    ).pipe(Effect.provide(xmlWorkerHandlersLayer)),
  );
});

it("extracts page text with timings and tolerates a missing canvas", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pdf = yield* textPdf([
          { width: 300, height: 300, runs: [{ text: "Primeira linha", x: 20, y: 250 }] },
          { width: 300, height: 300, runs: [{ text: "Segunda pagina", x: 20, y: 250 }] },
        ]);
        const client = yield* RpcTest.makeClient(PdfCoreWorkerRequests);
        const report = yield* client.ExtractPdf({ pdf });
        expect(report.pageCount).toBe(2);
        expect(report.firstPage).toContain("Primeira linha");
        expect(report.characters).toBeGreaterThan(20);
        expect(report.extractMillis).toBeGreaterThanOrEqual(0);
        expect(report.image).toBeNull();
        expect(report.renderMillis).toBeNull();
      }),
    ).pipe(Effect.provide(pdfCoreWorkerHandlersLayer.pipe(Layer.provideMerge(pdfCore)))),
  );
});
