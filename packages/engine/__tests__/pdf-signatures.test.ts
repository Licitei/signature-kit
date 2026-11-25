import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { pdfCoreFileLayer } from "@signature-kit/engine/wasm/file";
import { PdfCore } from "@signature-kit/engine/wasm/pdf-core";
import { Clock, Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { readFile } from "node:fs/promises";
import { verifyIndependently } from "../../../tooling/testing/verify-pdf.ts";
import { recordSpans } from "../../../tooling/testing/tracing.ts";
import { A1Sessions, Documents, localRuntimeLayer, pdfEngineLayer } from "../src/engine.js";
import { embedPreparedSignature } from "../src/pdf-contents.js";
import { PdfSignatures, pdfSignaturesLayer } from "../src/pdf-signatures.js";
import type { A1Hash } from "../src/a1-certificate.js";
import type { A1SessionInfo, PdfPrepareOptions } from "../src/rpc.js";

const wasm = pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer));
const signingLayer = (options?: Parameters<typeof localRuntimeLayer>[0]) =>
  pdfSignaturesLayer.pipe(
    Layer.provideMerge(pdfEngineLayer),
    Layer.provideMerge(localRuntimeLayer(options)),
    Layer.provideMerge(wasm),
  );
const layer = signingLayer();
const password = Redacted.make("changeit");
const now = new Date("2027-01-01T00:00:00Z");
const fixture = (name: "ecpf" | "ecnpj") =>
  Effect.promise(async () =>
    Redacted.make(
      new Uint8Array(
        await readFile(
          new URL(`../../../tooling/testing/fixtures/local/${name}.p12`, import.meta.url),
        ),
      ),
    ),
  );
const readPdfFixture = (name = "helvetica-winansi.pdf") =>
  Effect.promise(
    async () =>
      new Uint8Array(
        await readFile(new URL(`../../../crates/pdf/tests/fixtures/pdf/${name}`, import.meta.url)),
      ),
  );
const options = (session: A1SessionInfo, name = "Approval"): PdfPrepareOptions => ({
  session,
  field: { kind: "create", name, page: 0, rect: [32, 28, 192, 76] },
  appearance: { kind: "visible" },
  policy: "icpBrasilAdRbV11",
});

const fingerprint = (bytes: Uint8Array) =>
  Effect.promise(async () =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  );

describe("local PDF signatures", () => {
  it.effect(
    "binds the exact preview, confirms concurrently once, exports, and retains the receipt",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        const documents = yield* Documents;
        const pdf = yield* PdfSignatures;
        const a1 = yield* A1Sessions;
        const pfx = yield* fixture("ecpf");
        const session = yield* a1.open({ pfx, password });
        const { certificateDer } = yield* a1.certificate(session);
        const sourceBytes = yield* readPdfFixture();
        const source = yield* documents.open(sourceBytes);
        expect((yield* pdf.fields(source)).fields).toHaveLength(0);

        const { exit, spans } = yield* recordSpans(
          Effect.gen(function* () {
            const preparation = yield* pdf.prepare(source, options(session));
            expect(preparation.widget).toEqual({
              kind: "visible",
              page: 0,
              rect: [32, 28, 192, 76],
            });
            const preview = yield* documents.export(preparation.previewRevision.handle);
            expect(preparation.previewRevision.digest).toBe(yield* fingerprint(preview));
            const sameOptions = yield* pdf.prepare(source, {
              policy: "icpBrasilAdRbV11",
              appearance: { kind: "visible" },
              field: { name: "Approval", rect: [32, 28, 192, 76], page: 0, kind: "create" },
              session,
            });
            expect(sameOptions.preparationId).toBe(preparation.preparationId);
            yield* documents.release(sameOptions.previewRevision.handle);
            yield* documents.release(source.handle);

            const [receipt, concurrent] = yield* Effect.all(
              [pdf.confirm(preparation.preparationId), pdf.confirm(preparation.preparationId)],
              { concurrency: 2 },
            );
            expect(receipt).toEqual(concurrent);
            expect(receipt).toMatchObject({
              preparationId: preparation.preparationId,
              sourceDigest: source.digest,
              certificateFingerprint: session.profile.fingerprintSha256,
              signedAt: now,
              fieldName: "Approval",
            });
            yield* a1.close();
            expect(yield* pdf.confirm(preparation.preparationId)).toEqual(receipt);
            const signed = yield* documents.export(receipt.signedRevision.handle);
            expect(receipt.signedRevision.digest).toBe(yield* fingerprint(signed));
            expect(signed.subarray(0, sourceBytes.byteLength)).toEqual(sourceBytes);
            expect(yield* documents.export(preparation.previewRevision.handle)).toEqual(preview);

            const [field] = (yield* pdf.fields(receipt.signedRevision)).fields;
            const range = field?.signature?.byteRange;
            if (range === undefined)
              return yield* Effect.die("The signed field requires a byte range.");
            expect(signed.subarray(0, range[1])).toEqual(preview.subarray(0, range[1]));
            expect(signed.subarray(range[2])).toEqual(preview.subarray(range[2]));
            expect(preview.subarray(range[1] + 1, range[2] - 1).every((byte) => byte === 48)).toBe(
              true,
            );
            const report = yield* pdf.verify(receipt.signedRevision);
            expect(report.signatures).toMatchObject([
              {
                fieldName: "Approval",
                integrity: "valid",
                coverage: { kind: "wholeFile", bytesAfter: 0 },
                signer: { holderKind: "e-cpf" },
                trust: "notEvaluated",
                revocation: { kind: "notChecked" },
              },
            ]);
            for (const [at, trust] of [
              [now, "trusted"],
              [new Date(session.profile.notAfter.getTime() + 1), "untrusted"],
            ] satisfies ReadonlyArray<readonly [Date, "trusted" | "untrusted"]>) {
              const evaluated = yield* pdf.verify(receipt.signedRevision, {
                trust: [certificateDer],
                at,
              });
              expect(evaluated.signatures[0]).toMatchObject({
                integrity: "valid",
                trust,
                revocation: { kind: "notChecked" },
              });
            }
            const tampered = signed.slice();
            tampered[7] = 0x36;
            const tamperedRef = yield* documents.open(tampered);
            expect((yield* pdf.verify(tamperedRef)).signatures[0]?.integrity).toBe("invalid");
            const badCms = signed.slice();
            badCms[range[2] - 2] = 0x66;
            const badCmsRef = yield* documents.open(badCms);
            expect((yield* pdf.verify(badCmsRef)).signatures[0]).toMatchObject({
              integrity: "invalid",
              coverage: { kind: "wholeFile", bytesAfter: 0 },
            });
            yield* pdf.release(preparation.preparationId);
            yield* pdf.release(preparation.preparationId);
            expect(yield* Effect.flip(pdf.confirm(preparation.preparationId))).toMatchObject({
              code: "preparationUnknown",
            });
            return signed;
          }),
        );
        const signed = yield* exit;
        expect(spans.filter(({ name }) => name === "local.a1.sign")).toHaveLength(1);
        const pdfSpans = spans.filter(({ name }) => name.startsWith("local.pdf."));
        for (const name of ["prepare", "confirm", "cms", "selfVerify"]) {
          expect(pdfSpans.some((span) => span.name === `local.pdf.${name}`)).toBe(true);
        }
        for (const span of pdfSpans) {
          expect(
            Object.keys(span.attributes)
              .filter((key) => key !== "code.stacktrace")
              .every((key) => ["byteLength", "holderKind", "policy", "outcome"].includes(key)),
          ).toBe(true);
        }
        const telemetry = JSON.stringify(
          spans.map(({ attributes, events, status }) => ({ attributes, events, status })),
        );
        for (const value of [
          "changeit",
          "Approval",
          session.profile.subjectName,
          session.profile.fingerprintSha256,
          source.digest,
        ]) {
          expect(telemetry).not.toContain(value);
        }
        yield* verifyIndependently(signed, 1);
      }).pipe(Effect.provide(layer)),
    30_000,
  );

  it.effect("rejects replaced sessions, and checks expiration at confirmation time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const a1 = yield* A1Sessions;
      const pdf = yield* PdfSignatures;
      const documents = yield* Documents;
      const source = yield* documents.open(yield* readPdfFixture());
      const person = yield* a1.open({ pfx: yield* fixture("ecpf"), password });
      const first = yield* pdf.prepare(source, options(person));
      const company = yield* a1.open({ pfx: yield* fixture("ecnpj"), password });
      expect(yield* Effect.flip(pdf.confirm(first.preparationId))).toMatchObject({
        code: "staleGeneration",
      });
      const second = yield* pdf.prepare(source, options(company));
      expect(first.preparationId).not.toBe(second.preparationId);
      yield* TestClock.setTime(company.profile.notAfter.getTime() + 1);
      expect(yield* Effect.flip(pdf.confirm(second.preparationId))).toMatchObject({
        code: "certificateExpired",
      });
      yield* a1.close();
      expect(yield* Effect.flip(pdf.confirm(second.preparationId))).toMatchObject({
        code: "staleGeneration",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fills an existing widget and rejects missing or already signed fields", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const documents = yield* Documents;
      const pdf = yield* PdfSignatures;
      const a1 = yield* A1Sessions;
      const session = yield* a1.open({ pfx: yield* fixture("ecnpj"), password });
      const core = yield* PdfCore;
      const sourceBytes = yield* readPdfFixture();
      const { nextObjectNumber, pages } = yield* core.document(sourceBytes);
      const page = pages[0]?.ref;
      if (page === undefined) return yield* Effect.die("A fixture page is required.");
      const widget = { number: nextObjectNumber, generation: 0 };
      const widgetRef = `${widget.number} ${widget.generation} R`;
      const unsigned = yield* core.edit(
        sourceBytes,
        [
          {
            op: "setObject",
            ref: widget,
            value: `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Existing) /F 4 /Rect [32 28 192 76] /P ${page.number} ${page.generation} R >>`,
          },
          {
            op: "append",
            target: { base: { kind: "page", pageIndex: 0 } },
            key: "Annots",
            value: widgetRef,
          },
          {
            op: "set",
            target: { base: { kind: "catalog" } },
            key: "AcroForm",
            value: `<< /Fields [${widgetRef}] >>`,
          },
        ],
        { mode: "rewrite" },
      );
      const source = yield* documents.open(unsigned);
      const existing = {
        ...options(session),
        field: { kind: "existing", name: "Existing" },
      } satisfies PdfPrepareOptions;
      expect((yield* pdf.fields(source)).fields).toMatchObject([
        { name: "Existing", signed: false },
      ]);
      expect(
        yield* Effect.flip(
          pdf.prepare(source, {
            ...existing,
            field: { kind: "existing", name: "Missing" },
          }),
        ),
      ).toMatchObject({ code: "fieldNotFound" });
      const prepared = yield* pdf.prepare(source, {
        ...existing,
        appearance: { kind: "visible", lines: ["Approved"] },
      });
      expect(prepared.widget).toEqual({ kind: "visible", page: 0, rect: [32, 28, 192, 76] });
      const receipt = yield* pdf.confirm(prepared.preparationId);
      expect((yield* pdf.verify(receipt.signedRevision)).signatures).toMatchObject([
        { integrity: "valid", signer: { holderKind: "e-cnpj" } },
      ]);
      expect(yield* Effect.flip(pdf.prepare(receipt.signedRevision, existing))).toMatchObject({
        code: "fieldSigned",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "co-signs 1.x and 2.0 revisions and reports the first signature's coverage",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        const documents = yield* Documents;
        const pdf = yield* PdfSignatures;
        const a1 = yield* A1Sessions;
        const pfx = yield* fixture("ecpf");
        const first = yield* a1.open({ pfx, password });
        const source = yield* readPdfFixture();
        const fromV1 = yield* readPdfFixture("icp-signed.pdf");
        const prepared = yield* pdf.prepare(yield* documents.open(source), options(first));
        const receipt = yield* pdf.confirm(prepared.preparationId);
        const fromV2 = yield* documents.export(receipt.signedRevision.handle);
        const second = yield* a1.open({ pfx: yield* fixture("ecnpj"), password });

        for (const original of [fromV1, fromV2]) {
          const preceding = yield* documents.open(original);
          const preparation = yield* pdf.prepare(preceding, options(second, "Co-approval"));
          const cosigned = yield* pdf.confirm(preparation.preparationId);
          const exported = yield* documents.export(cosigned.signedRevision.handle);
          expect(exported.subarray(0, original.byteLength)).toEqual(original);
          const { signatures } = yield* pdf.verify(cosigned.signedRevision);
          expect(signatures).toMatchObject([
            {
              integrity: "valid",
              coverage: { kind: "partial", bytesAfter: exported.byteLength - original.byteLength },
              changes: { unknown: [], pageContentChanged: false },
            },
            { integrity: "valid", coverage: { kind: "wholeFile", bytesAfter: 0 } },
          ]);
          yield* verifyIndependently(exported, 2);
        }
      }).pipe(Effect.provide(layer)),
    30_000,
  );

  it.effect.each(["SHA-384", "SHA-512"] satisfies A1Hash[])(
    "confirms and verifies a PDF with %s",
    (a1Hash) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.getTime());
        const documents = yield* Documents;
        const a1 = yield* A1Sessions;
        const pdf = yield* PdfSignatures;
        const pfx = yield* fixture("ecpf");
        const session = yield* a1.open({ pfx, password });
        const source = yield* documents.open(yield* readPdfFixture());
        const preparation = yield* pdf.prepare(source, options(session));
        const receipt = yield* pdf.confirm(preparation.preparationId);
        expect((yield* pdf.verify(receipt.signedRevision)).signatures).toMatchObject([
          { integrity: "valid", coverage: { kind: "wholeFile" } },
        ]);
        const signed = yield* documents.export(receipt.signedRevision.handle);
        yield* verifyIndependently(signed, 1);
      }).pipe(Effect.provide(signingLayer({ a1Hash }))),
  );

  it.effect("rejects oversize CMS and refuses a valid PDF certified with DocMDP P=1", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.getTime());
      const core = yield* PdfCore;
      const pdf = yield* PdfSignatures;
      const a1 = yield* A1Sessions;
      const documents = yield* Documents;
      const pfx = yield* fixture("ecpf");
      const session = yield* a1.open({ pfx, password });
      const source = yield* readPdfFixture();
      const request = {
        field: { kind: "create", name: "Certifier", page: 0, rect: [0, 0, 0, 0] },
        appearance: { kind: "none" },
        date: "D:20270101000000Z",
        docMdp: 1,
        contentsCapacity: 4096,
      } satisfies Parameters<typeof core.prepareSignature>[1];
      const prepared = yield* core.prepareSignature(source, request);
      const { cms: signer } = yield* a1.certificate(session);
      const bindCms = yield* signer;
      const detached = yield* bindCms({ messageDigest: prepared.sha256 });
      const cms = yield* detached.sign((attributes) =>
        a1.sign(session.sessionId, session.generation, attributes),
      );
      expect(yield* detached.verify(cms)).toBe(true);
      const changedDigest = new Uint8Array(prepared.sha256).map((byte) => byte ^ 1);
      const other = yield* bindCms({ messageDigest: changedDigest });
      expect(yield* other.verify(cms)).toBe(false);
      const invalid = new Uint8Array(cms);
      invalid[invalid.length - 1] = (invalid[invalid.length - 1] ?? 0) ^ 1;
      expect(yield* detached.verify(invalid)).toBe(false);
      const padded = new Uint8Array(cms.length + 1);
      padded.set(cms);
      expect(yield* detached.verify(padded)).toBe(true);
      padded[cms.length] = 1;
      expect(yield* detached.verify(padded)).toBe(false);
      const small = yield* core.prepareSignature(source, { ...request, contentsCapacity: 8 });
      expect(yield* Effect.flip(embedPreparedSignature(small, cms))).toMatchObject({
        code: "signatureTooLarge",
      });
      const signed = yield* embedPreparedSignature(prepared, cms);
      yield* verifyIndependently(signed, 1);
      const certified = yield* documents.open(signed);
      expect((yield* pdf.fields(certified)).docMdp).toBe(1);
      expect(yield* Effect.flip(pdf.prepare(certified, options(session)))).toMatchObject({
        code: "documentLocked",
      });
      expect(yield* Clock.currentTimeMillis).toBe(now.getTime());
    }).pipe(Effect.provide(layer)),
  );
});
