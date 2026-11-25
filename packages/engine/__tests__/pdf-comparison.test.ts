import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PdfCore } from "@signature-kit/engine/wasm/pdf-core";
import { pdfCoreFileLayer } from "@signature-kit/engine/wasm/file";
import { Clock, Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { readFile } from "node:fs/promises";
import { existingField, signatories, trustAt } from "../../../tooling/testing/cosign.js";
import { verifyIndependently } from "../../../tooling/testing/verify-pdf.js";
import { recordSpans } from "../../../tooling/testing/tracing.js";
import { A1Sessions, Documents, localRuntimeLayer, pdfEngineLayer } from "../src/engine.js";
import { PdfSignatures, pdfSignaturesLayer } from "../src/pdf-signatures.js";
import { PdfVerification, pdfVerificationLayer } from "../src/pdf-verification.js";
import { exportComparisonReport } from "../src/rpc.js";
import type { ComparisonReport } from "../src/rpc.js";
import type { PdfCoreNewSignatureFields } from "../src/wasm/config.js";

const layer = Layer.merge(pdfSignaturesLayer, pdfVerificationLayer).pipe(
  Layer.provideMerge(pdfEngineLayer),
  Layer.provideMerge(localRuntimeLayer()),
  Layer.provideMerge(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))),
);

const fixture = (name: string) =>
  Effect.promise(
    async () =>
      new Uint8Array(
        await readFile(
          new URL(`../../../tooling/testing/fixtures/cosign/${name}`, import.meta.url),
        ),
      ),
  );

it.effect.each([
  ["cosigned", "signedAsExpected", true],
  ["different", "differentDocument", false],
  ["page-changed", "modifiedAfterSigning", true],
  ["unknown", "unknownChanges", true],
  ["external", "modifiedAfterSigning", true],
  ["integrity-failure", "integrityFailure", true],
] satisfies ReadonlyArray<readonly [string, ComparisonReport["verdict"], boolean]>)(
  "compares the %s PDF",
  ([file, verdict, preserved]) =>
    Effect.gen(function* () {
      const documents = yield* Documents;
      const verification = yield* PdfVerification;
      const sent = yield* documents.open(yield* fixture("sent.pdf"));
      const returnedBytes = yield* fixture(`${file}.pdf`);
      const returned = yield* documents.open(returnedBytes);
      const trust = [yield* fixture("root.der")] satisfies readonly [Uint8Array];
      const report = yield* verification.compare(sent, returned, { trust, at: trustAt });
      expect(report).toMatchObject({ sentPreserved: preserved, verdict });
      if (preserved) expect(report.sentRevisionIndex).toBe(1);
      if (file === "page-changed") {
        expect(report.changes?.pageContentChanged).toBe(true);
        expect(report.signatures.every(({ changes }) => changes?.pageContentChanged)).toBe(true);
      }
      if (verdict === "unknownChanges") {
        expect(report.changes?.unknownObjectCount).toBeGreaterThan(0);
      }
      if (file === "external" || file === "different") {
        expect(report.signatures.every(({ integrity }) => integrity === "valid")).toBe(true);
        yield* verifyIndependently(returnedBytes, file === "external" ? 2 : 1);
      }
      if (file === "integrity-failure") {
        expect(report.signatures.map(({ integrity }) => integrity)).toEqual(["valid", "invalid"]);
      }
      if (file === "cosigned") {
        expect(report.signatures.map(({ trust }) => trust)).toEqual(["trusted", "trusted"]);
        const archived = yield* exportComparisonReport(report);
        expect(archived + "\n").toBe(new TextDecoder().decode(yield* fixture("report.json")));
        const { verdict, signatures, changes, sentRevisionIndex, sentPreserved, reasons } = report;
        expect(
          yield* exportComparisonReport({
            verdict,
            signatures,
            changes,
            sentRevisionIndex,
            sentPreserved,
            reasons,
          }),
        ).toBe(archived);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect("reports only signatures after the sent revision and rejects an invalid ByteRange", () =>
  Effect.gen(function* () {
    const documents = yield* Documents;
    const pdf = yield* PdfSignatures;
    const verification = yield* PdfVerification;
    const original = yield* documents.open(yield* fixture("sent.pdf"));
    const returnedBytes = yield* fixture("cosigned.pdf");
    const returned = yield* documents.open(returnedBytes);
    const [first, second] = (yield* pdf.fields(returned)).fields;
    const end = first?.signature?.revisionEnd;
    const range = second?.signature?.byteRange;
    if (end === undefined || range === undefined)
      return yield* Effect.die("Missing fixture signatures.");
    const sent = yield* documents.open(returnedBytes.subarray(0, end));
    const report = yield* verification.compare(sent, returned, { trust: [] });
    expect(report).toMatchObject({
      sentPreserved: true,
      sentRevisionIndex: 2,
      verdict: "signedAsExpected",
      signatures: [{ fieldName: "Contratada", integrity: "valid", trust: "notEvaluated" }],
    });

    const marker = new TextEncoder().encode("/ByteRange [");
    const start = Buffer.from(returnedBytes).lastIndexOf(marker, range[1]);
    expect(start).toBeGreaterThan(end);
    const fourthNumber = start + marker.length + 3 * 11;
    const malformed = returnedBytes.slice();
    malformed[fourthNumber] = 0x39;
    const damaged = yield* verification.compare(original, yield* documents.open(malformed));
    expect(damaged).toMatchObject({
      sentPreserved: true,
      verdict: "integrityFailure",
      signatures: [
        { fieldName: "Contratante", integrity: "valid" },
        { fieldName: "Contratada", integrity: "invalid", coverage: { kind: "invalid" } },
      ],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("evaluates path signatures and validity against explicit roots", () =>
  Effect.gen(function* () {
    const documents = yield* Documents;
    const verification = yield* PdfVerification;
    const sent = yield* documents.open(yield* fixture("sent.pdf"));
    const returned = yield* documents.open(yield* fixture("cosigned.pdf"));
    const root = yield* fixture("root.der");
    const invalidAt = new Date("2020-01-01T00:00:00Z");
    expect(
      (yield* verification.compare(sent, returned)).signatures.every(
        ({ trust }) => trust === "notEvaluated",
      ),
    ).toBe(true);
    for (const [at, anchor] of [
      [invalidAt, root],
      [trustAt, yield* fixture("unrelated-root.der")],
    ] satisfies ReadonlyArray<readonly [Date, Uint8Array]>) {
      const report = yield* verification.compare(sent, returned, { trust: [anchor], at });
      expect(report.verdict).toBe("untrustedSignatures");
      expect(report.signatures.map(({ trust, integrity }) => [trust, integrity])).toEqual([
        ["untrusted", "valid"],
        ["untrusted", "valid"],
      ]);
    }

    const { exit, spans } = yield* recordSpans(
      verification.compare(sent, returned, { trust: [root], at: trustAt }),
    );
    expect((yield* exit).verdict).toBe("signedAsExpected");
    const telemetry = JSON.stringify(
      spans.map(({ name, attributes, events }) => ({ name, attributes, events })),
    );
    for (const privateValue of [
      "00000000001",
      "00000000000002",
      "SignatureKit Test Person",
      "SignatureKit Test Company",
      "Contratante",
      "Contratada",
    ]) {
      expect(telemetry).not.toContain(privateValue);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("creates empty widgets atomically and respects certification and field locks", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(trustAt.getTime());
    expect(yield* Clock.currentTimeMillis).toBe(trustAt.getTime());
    const documents = yield* Documents;
    const pdf = yield* PdfSignatures;
    const a1 = yield* A1Sessions;
    const contract = yield* fixture("contract.pdf");
    const draft = yield* documents.open(contract);
    const session = yield* a1.open({
      pfx: Redacted.make(yield* fixture("ecpf.p12")),
      password: Redacted.make("changeit"),
    });
    expect(
      yield* Effect.flip(pdf.addFields(draft, [signatories[0], signatories[0]])),
    ).toMatchObject({ code: "fieldAmbiguous" });
    expect((yield* pdf.fields(draft)).fields).toEqual([]);
    const sent = yield* pdf.addFields(draft, signatories);
    expect((yield* pdf.fields(sent)).revisions).toEqual([draft.byteLength, sent.byteLength]);
    expect((yield* documents.export(sent.handle)).subarray(0, draft.byteLength)).toEqual(contract);

    const prepare = existingField(session, "Contratante");
    expect(yield* Effect.flip(pdf.prepare(sent, existingField(session, "Missing")))).toMatchObject({
      code: "fieldNotFound",
    });
    const certified = yield* pdf.prepare(sent, { ...prepare, docMdp: 1 });
    const lockedDocument = (yield* pdf.confirm(certified.preparationId)).signedRevision;
    expect(
      yield* Effect.flip(pdf.prepare(lockedDocument, existingField(session, "Contratada"))),
    ).toMatchObject({ code: "documentLocked" });

    const core = yield* PdfCore;
    const certifiedBytes = yield* documents.export(lockedDocument.handle);
    const withoutPerms = yield* core.edit(
      certifiedBytes,
      [
        {
          op: "remove",
          target: { base: { kind: "catalog" } },
          key: "Perms",
        },
      ],
      { mode: "incremental" },
    );
    const alteredCertification = yield* documents.open(withoutPerms);
    expect((yield* pdf.verify(alteredCertification)).signatures[0]).toMatchObject({
      integrity: "valid",
      mdp: { docMdp: 1, permittedChanges: [], violations: expect.any(Array) },
    });
    expect((yield* pdf.compare(lockedDocument, alteredCertification)).reasons).toContain(
      "mdpViolation",
    );
    expect(
      yield* Effect.flip(pdf.prepare(alteredCertification, existingField(session, "Contratada"))),
    ).toMatchObject({ code: "documentLocked" });

    const lock = [
      { ...signatories[0], lock: { action: "Include", fields: ["Contratada"] } },
      signatories[1],
    ] satisfies PdfCoreNewSignatureFields;
    const fields = yield* pdf.addFields(draft, lock);
    const prepared = yield* pdf.prepare(fields, prepare);
    const signed = (yield* pdf.confirm(prepared.preparationId)).signedRevision;
    expect(new TextDecoder().decode(yield* documents.export(signed.handle))).toContain("/FieldMDP");
    expect(yield* Effect.flip(pdf.prepare(signed, prepare))).toMatchObject({ code: "fieldSigned" });
    expect(
      yield* Effect.flip(pdf.prepare(signed, existingField(session, "Contratada"))),
    ).toMatchObject({ code: "documentLocked" });
    const signedBytes = yield* documents.export(signed.handle);
    const ref = (yield* pdf.fields(signed)).fields[0]?.ref;
    if (ref === undefined) return yield* Effect.die("Missing signed field reference.");
    const withoutLock = yield* core.edit(
      signedBytes,
      [
        { op: "remove", target: { base: { kind: "object", ref } }, key: "Lock" },
        { op: "remove", target: { base: { kind: "object", ref } }, key: "V" },
      ],
      { mode: "incremental" },
    );
    const alteredLock = yield* documents.open(withoutLock);
    expect(
      yield* Effect.flip(pdf.prepare(alteredLock, existingField(session, "Contratada"))),
    ).toMatchObject({ code: "documentLocked" });
  }).pipe(Effect.provide(layer)),
);

it.effect.each([2, 3] satisfies Array<2 | 3>)("enforces certification permission %i", (docMdp) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(trustAt.getTime());
    const documents = yield* Documents;
    const pdf = yield* PdfSignatures;
    const core = yield* PdfCore;
    const a1 = yield* A1Sessions;
    const source = yield* documents.open(yield* fixture("sent.pdf"));
    const session = yield* a1.open({
      pfx: Redacted.make(yield* fixture("ecpf.p12")),
      password: Redacted.make("changeit"),
    });
    const certification = yield* pdf.prepare(source, {
      ...existingField(session, "Contratante"),
      docMdp,
    });
    const signed = (yield* pdf.confirm(certification.preparationId)).signedRevision;
    const approval = yield* pdf.prepare(signed, existingField(session, "Contratada"));
    const cosigned = (yield* pdf.confirm(approval.preparationId)).signedRevision;
    const report = yield* pdf.verify(cosigned);
    expect(report.signatures[0]?.mdp).toMatchObject({
      docMdp,
      violations: [],
      permittedChanges: expect.arrayContaining([expect.objectContaining({ kind: "signature" })]),
    });

    const bytes = yield* documents.export(cosigned.handle);
    const { nextObjectNumber } = yield* core.document(bytes);
    const ref = { number: nextObjectNumber, generation: 0 };
    const annotated = yield* core.edit(
      bytes,
      [
        { op: "setObject", ref, value: "<< /Type /Annot /Subtype /Text /Rect [10 10 20 20] >>" },
        {
          op: "append",
          target: { base: { kind: "page", pageIndex: 0 } },
          key: "Annots",
          value: `${ref.number} 0 R`,
        },
      ],
      { mode: "incremental" },
    );
    const verified = yield* pdf.verify(yield* documents.open(annotated));
    const policy = verified.signatures[0]?.mdp;
    expect(policy?.[docMdp === 2 ? "violations" : "permittedChanges"]).toContainEqual(
      expect.objectContaining({ kind: "annotation", change: "added" }),
    );
    if (docMdp === 3) expect(policy?.violations).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
