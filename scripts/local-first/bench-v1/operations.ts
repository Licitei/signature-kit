import {
  a1SignaturesLayer,
  createA1SignerAdapter,
  loadA1SignerAdapter,
  parseA1CertificateProfile,
} from "@signature-kit/a1/signer";
import { parseCertificate } from "@signature-kit/certificates";
import { IcpBrasilPadesPolicy } from "@signature-kit/cms/icp-brasil";
import { inspectDetachedSignedData } from "@signature-kit/cms/inspect";
import { createDetachedSignedData } from "@signature-kit/cms/sign";
import { verifyDetachedSignedData } from "@signature-kit/cms/verify";
import { parsePkcs12 } from "@signature-kit/crypto/pkcs12";
import { PdfCore, pdfCoreBytesSource } from "@signature-kit/pdf-core/pdf-core";
import { findPdfTextAnchors } from "@signature-kit/pdf/anchors";
import { createPdfSignatureTemplate } from "@signature-kit/pdf/builder";
import { bestGuessPdfSignatureFieldPlacement } from "@signature-kit/pdf/builder-store";
import { preparePdfByteRange } from "@signature-kit/pdf/byte-range";
import { PdfErrorCodeValue } from "@signature-kit/pdf/config";
import { extractPdfPages, mergePdfs } from "@signature-kit/pdf/merge";
import { signPdf } from "@signature-kit/pdf/sign";
import {
  rubricPageIndexesExcludingSignature,
  stampPdfRubricOnPages,
  stampPdfVisibleSignature,
  visiblePdfPageSizeFromGeometry,
} from "@signature-kit/pdf/stamp";
import { verifyPdf } from "@signature-kit/pdf/verify";
import { prepareAndSignPdf, preparePdfVisualPreview } from "@signature-kit/pdf/workflow";
import { Signatures } from "@signature-kit/signatures";
import { xmlRuntimeLayer } from "@signature-kit/xml/runtime";
import { signXml } from "@signature-kit/xml/sign";
import { verifyXml } from "@signature-kit/xml/verify";
import { Effect, Layer, Redacted, Result, Tracer } from "effect";
import { expect } from "vitest";
import { addSignaturePlaceholder } from "../../../formats/pdf/dist/placeholder.js";
import { largePdf, syntheticPdf, tablePdf } from "./corpus";
import type { Recorder } from "./measure";

export const fixturePassword = "changeit";
const password = Redacted.make(fixturePassword);
const now = new Date("2026-11-25T12:00:00Z");
const stamp = { pageIndex: 0, x: 32, y: 28, width: 160, height: 40 };
const lines = ["Signed locally"];
const signing = { signatureLength: 16384, signingTime: now };
export const pdfInput = (pdf: Uint8Array) => ({ pdf, stampRects: [stamp], lines, signing });

class CopySpan extends Tracer.NativeSpan {
  override attribute(key: string, value: unknown): void {
    if (
      (key === "signature_kit.wasm.input_bytes" || key === "signature_kit.wasm.output_bytes") &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      super.attribute(key, value);
  }

  override event(): void {}
}

const copyCounts = async <A, E>(operation: Effect.Effect<A, E>) => {
  const spans: CopySpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new CopySpan(options);
      if (span.name === "pdfCore.wasm.copyIn" || span.name === "bench.v1.wasm.copyOut")
        spans.push(span);
      return span;
    },
  });
  await Effect.runPromise(operation.pipe(Effect.withTracer(tracer)));
  const sizes = (name: string, attribute: string) =>
    spans
      .filter((span) => span.name === name)
      .map((span) => {
        const bytes = span.attributes.get(attribute);
        expect(typeof bytes).toBe("number");
        return typeof bytes === "number" ? bytes : 0;
      });
  const inputs = sizes("pdfCore.wasm.copyIn", "signature_kit.wasm.input_bytes");
  const outputs = sizes("bench.v1.wasm.copyOut", "signature_kit.wasm.output_bytes");
  const inputBytes = inputs.reduce((sum, bytes) => sum + bytes, 0);
  const outputBytes = outputs.reduce((sum, bytes) => sum + bytes, 0);
  return {
    inputCopies: inputs.length,
    inputBytes,
    outputCopies: outputs.length,
    outputBytes,
    totalCopies: inputs.length + outputs.length,
    totalBytes: inputBytes + outputBytes,
  };
};

export const runOperations = async (
  record: Recorder,
  coreLayer: Layer.Layer<PdfCore, unknown>,
  pfxs: Record<"ecpf" | "ecnpj", Uint8Array>,
  pdfs: Record<string, Uint8Array>,
  fallbackSignedXml?: (corpus: string) => Promise<string>,
) => {
  const copies = [];
  const signedXml: Record<string, string> = {};
  const unavailable: Array<{ id: string; corpus: string; reason: string }> = [];
  const [coreContext, xmlContext] = await Effect.runPromise(
    Effect.scoped(Effect.all([Layer.build(coreLayer), Layer.build(xmlRuntimeLayer)])),
  );
  const core = await Effect.runPromise(PdfCore.pipe(Effect.provideContext(coreContext)));
  const resolvePdf = <A, E>(operation: Effect.Effect<A, E, PdfCore>) =>
    operation.pipe(Effect.provideContext(coreContext));
  for (const [corpus, pfx] of Object.entries(pfxs)) {
    const entry = { corpus, bytes: pfx.byteLength, pages: null };
    const options = { pfx, password };
    const certificate = await Effect.runPromise(parseCertificate(pfx, password));
    const tasks: ReadonlyArray<readonly [string, Effect.Effect<unknown, unknown>]> = [
      ["crypto.pkcs12.parse", parsePkcs12(pfx, password)],
      ["certificates.parse", parseCertificate(pfx, password)],
      ["a1.profile.parse", parseA1CertificateProfile(options)],
      ["a1.adapter.load", loadA1SignerAdapter(options)],
      ["a1.adapter.create", Effect.sync(() => createA1SignerAdapter(certificate))],
      [
        "a1.webcrypto.import-key",
        Effect.suspend(() => createA1SignerAdapter(certificate).importSigningKey("rsa-sha256")),
      ],
    ];
    for (const [id, operation] of tasks) {
      await record(
        { id, ...entry, ...(id === "a1.adapter.create" ? { iterations: 101 } : {}) },
        () => Effect.runPromise(operation),
      );
    }
  }

  const options = { pfx: pfxs.ecpf, password };
  const adapter = await Effect.runPromise(loadA1SignerAdapter(options));
  const certificate = await Effect.runPromise(adapter.certificate());
  const signingKey = await Effect.runPromise(adapter.importSigningKey("rsa-sha256"));
  const content = new TextEncoder().encode("SignatureKit detached benchmark content");
  for (const corpus of ["pades-ades", "icp-brasil-ad-rb-v11"]) {
    const makeCms = createDetachedSignedData({
      content,
      signingKey,
      certificateDer: certificate.certificateDer,
      chainDer: certificate.intermediateCertificates,
      ...(corpus === "icp-brasil-ad-rb-v11" ? { icpBrasil: IcpBrasilPadesPolicy.adRbV11 } : {}),
    });
    const cms = await Effect.runPromise(makeCms);
    const verification = verifyDetachedSignedData({ cms, content });
    await record(
      { id: "cms.detached.create", corpus, bytes: content.byteLength, pages: null },
      () => Effect.runPromise(makeCms),
    );
    await record({ id: "cms.detached.inspect", corpus, bytes: cms.byteLength, pages: null }, () =>
      Effect.runPromise(inspectDetachedSignedData({ cms })),
    );
    expect((await Effect.runPromise(verification)).valid).toBe(true);
    await record(
      {
        id: "cms.detached.verify",
        corpus,
        bytes: cms.byteLength + content.byteLength,
        pages: null,
      },
      () => Effect.runPromise(verification),
    );
  }

  for (const [corpus, length] of [
    ["xml-small", 24],
    ["xml-1mib", 1024 * 1024],
  ] satisfies Array<[string, number]>) {
    const xml = `<record Id="data"><body>${"x".repeat(length)}</body></record>`;
    const sign = signXml({ xml, referenceId: "data" }).pipe(
      Effect.provideService(Signatures, adapter),
      Effect.provideContext(xmlContext),
    );
    const result = await Effect.runPromise(Effect.result(sign));
    if (Result.isFailure(result)) {
      if (fallbackSignedXml === undefined) expect.fail("Node XML signing failed");
      expect(result.failure.code).toBe("xml.SIGN_FAILED");
      unavailable.push({ id: "xml.sign", corpus, reason: result.failure.code });
    } else {
      signedXml[corpus] = result.success;
      await record({ id: "xml.sign", corpus, bytes: xml.length, pages: null }, () =>
        Effect.runPromise(sign),
      );
    }
    const signed = Result.isSuccess(result) ? result.success : await fallbackSignedXml?.(corpus);
    if (signed === undefined) continue;
    const verify = verifyXml({ xml: signed, publicKeyDer: certificate.publicKeyDer }).pipe(
      Effect.provideContext(xmlContext),
    );
    const verified = await Effect.runPromise(Effect.result(verify));
    if (Result.isSuccess(verified) && verified.success.valid === true) {
      await record({ id: "xml.verify", corpus, bytes: signed.length, pages: null }, () =>
        Effect.runPromise(verify),
      );
    } else if (fallbackSignedXml !== undefined) {
      unavailable.push({
        id: "xml.verify",
        corpus,
        reason: Result.isFailure(verified) ? verified.failure.code : "invalid XML signature",
      });
    } else {
      expect.fail("Node XML verification failed");
    }
  }

  const table = await Effect.runPromise(resolvePdf(tablePdf));
  const findTables = core.tables(table);
  expect((await Effect.runPromise(findTables)).length).toBe(1);
  await record(
    { id: "pdf-core.tables", corpus: "synthetic-ruled-table", bytes: table.byteLength, pages: 1 },
    () => Effect.runPromise(findTables),
  );

  const documents = { ...pdfs };
  for (const count of [1, 20, 200])
    documents[`synthetic-${count}`] = await Effect.runPromise(resolvePdf(syntheticPdf(count)));
  documents["synthetic-21mib"] = await Effect.runPromise(resolvePdf(largePdf));
  const cores = [];
  for (const [corpus, pdf] of Object.entries(documents)) {
    if (corpus === "real-encrypted-locked") {
      await record(
        { id: "pdf.extract.encrypted-rejection", corpus, bytes: pdf.byteLength, pages: null },
        async () => {
          const error = await Effect.runPromise(resolvePdf(Effect.flip(extractPdfPages(pdf, [0]))));
          expect(error.code).toBe(PdfErrorCodeValue.encryptedPdf);
        },
      );
      continue;
    }

    const inspect = core.inspect(pdf, { text: false, links: false });
    const inspection = await Effect.runPromise(inspect);
    const pageDimensions = inspection.pages.map((page, index) => ({
      index,
      ...visiblePdfPageSizeFromGeometry(page),
    }));
    const pages = pageDimensions.length;
    const entry = { corpus, bytes: pdf.byteLength, pages };
    expect(pages).toBeGreaterThan(0);
    cores.push({ ...entry, pdf });
    const run = <A, E>(
      id: string,
      effect: Effect.Effect<A, E, PdfCore>,
      bytes = pdf.byteLength,
      count = pages,
    ) => record({ id, ...entry, bytes, pages: count }, () => Effect.runPromise(resolvePdf(effect)));
    const lazy = Effect.scoped(
      Effect.gen(function* () {
        const doc = yield* core.openLazy(pdfCoreBytesSource(pdf));
        return yield* doc.text({ pageIndexes: [0], format: "markdown" });
      }),
    );
    await run("pdf-core.inspect", inspect);
    await run("pdf-core.text", core.text(pdf));
    await run("pdf-core.tables", core.tables(pdf));
    await run("pdf-core.lazy.first-page", lazy);
    await run("pdf-core.signatures.scan", core.signatures(pdf, "scan"));

    if (corpus === "real-encrypted-signed" || corpus === "real-broken-xref") continue;

    const input = pdfInput(pdf);
    const anchorText =
      corpus === "real-helvetica-winansi"
        ? "corpus SignatureKit"
        : corpus === "real-habilitacao-150"
          ? "habilitação"
          : "Synthetic contract";
    const anchor = findPdfTextAnchors({ pdf, matchers: [{ text: anchorText }], stampSize: stamp });
    if (corpus !== "real-habilitacao-150") {
      expect((await Effect.runPromise(resolvePdf(anchor))).length).toBeGreaterThan(0);
    }
    await run("pdf.text-anchor", anchor);
    const template = await Effect.runPromise(
      createPdfSignatureTemplate({
        id: "benchmark",
        name: "Benchmark",
        documents: [
          { id: "document", name: "Document", source: { type: "uploaded" }, pages: pageDimensions },
        ],
        roles: [{ id: "signer", label: "Signer" }],
        fields: [],
      }),
    );
    await run(
      "pdf.best-guess-placement",
      bestGuessPdfSignatureFieldPlacement({
        template,
        documentId: "document",
        page: "first",
        draft: {
          id: "signature",
          roleId: "signer",
          type: "signature",
          width: stamp.width,
          height: stamp.height,
        },
      }),
    );
    await run("pdf.preview", preparePdfVisualPreview(input));
    await run("pdf.stamp", stampPdfVisibleSignature({ pdf, pageIndex: 0, rect: stamp, lines }));
    if (pages > 1) {
      await run(
        "pdf.rubric",
        stampPdfRubricOnPages({
          pdf,
          pageDimensions,
          pages: rubricPageIndexesExcludingSignature(pageDimensions, 0),
          initials: "SK",
        }),
      );
    }

    const placeholder = addSignaturePlaceholder({ pdf, ...signing });
    await run(
      "pdf.placeholder-and-byte-range",
      placeholder.pipe(Effect.flatMap(preparePdfByteRange)),
    );
    const signedInput = { pdf, signing };
    const warm = prepareAndSignPdf(signedInput).pipe(Effect.provideService(Signatures, adapter));
    const fresh = prepareAndSignPdf(signedInput).pipe(Effect.provide(a1SignaturesLayer(options)));
    const signed = await Effect.runPromise(resolvePdf(warm));
    const secondSigner = await Effect.runPromise(
      loadA1SignerAdapter({ pfx: pfxs.ecnpj, password }),
    );
    const coSign = signPdf({ pdf: signed, ...signing }).pipe(
      Effect.provideService(Signatures, secondSigner),
    );
    const twice = await Effect.runPromise(resolvePdf(coSign));
    const verifyOnce = verifyPdf({ pdf: signed });
    const verifyTwice = verifyPdf({ pdf: twice });
    expect(await Effect.runPromise(resolvePdf(verifyOnce))).toMatchObject({
      valid: true,
      signatureCount: 1,
    });
    expect(await Effect.runPromise(resolvePdf(verifyTwice))).toMatchObject({
      valid: true,
      signatureCount: 2,
    });
    await run("pdf.sign.fresh-a1", fresh);
    await run("pdf.sign.warm-a1", warm);
    await run("pdf.cosign", coSign, signed.byteLength);
    await run("pdf.verify.1", verifyOnce, signed.byteLength);
    await run("pdf.verify.2", verifyTwice, twice.byteLength);
    await run(
      "pdf-core.signatures.scan.signed",
      core.signatures(signed, "scan"),
      signed.byteLength,
    );
    await run("pdf.merge", mergePdfs([pdf, pdf]), pdf.byteLength * 2, pages * 2);
    await run("pdf.extract-first-page", extractPdfPages(pdf, [0]));
    if (corpus.startsWith("synthetic")) {
      copies.push({
        ...entry,
        sign: await copyCounts(resolvePdf(warm)),
        verify: await copyCounts(resolvePdf(verifyOnce)),
      });
    }
  }
  return { copies, cores, signedXml, unavailable };
};
