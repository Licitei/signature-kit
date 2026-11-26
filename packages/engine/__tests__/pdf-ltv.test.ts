import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { pdfCoreFileLayer } from "@signature-kit/engine/wasm/file";
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as pki from "pkijs";
import { A1Sessions, Documents, localRuntimeLayer, pdfEngineLayer } from "../src/engine.js";
import type { RevisionRef } from "../src/rpc.js";
import {
  EvidenceFetcher,
  evidenceFetcherHttpLayer,
  requestOcsp,
  requestTimestampForImprint,
} from "../src/evidence-fetcher.js";
import { PdfSignatures, pdfSignaturesLayer } from "../src/pdf-signatures.js";
import { PdfVerification, pdfVerificationLayer } from "../src/pdf-verification.js";
import { reportSignature } from "../src/templates.js";
import { existingField } from "../../../tooling/testing/cosign.js";
import {
  localEvidenceServers,
  validationFixture,
} from "../../../tooling/testing/evidence-servers.js";

const run = promisify(execFile);
const layer = Layer.merge(pdfSignaturesLayer, pdfVerificationLayer).pipe(
  Layer.provideMerge(pdfEngineLayer),
  Layer.provideMerge(localRuntimeLayer()),
  Layer.provideMerge(pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provideMerge(evidenceFetcherHttpLayer.pipe(Layer.provide(FetchHttpClient.layer))),
);

const cosignFixture = (name: string) =>
  Effect.promise(
    async () =>
      new Uint8Array(
        await readFile(
          new URL(`../../../tooling/testing/fixtures/cosign/${name}`, import.meta.url),
        ),
      ),
  );

const producedAt = (response: Uint8Array) => {
  const body = pki.OCSPResponse.fromBER(new Uint8Array(response)).responseBytes?.response.valueBlock
    .valueHexView;
  return body === undefined
    ? Effect.die("Missing OCSP response body.")
    : Effect.succeed(
        pki.BasicOCSPResponse.fromBER(new Uint8Array(body)).tbsResponseData.producedAt,
      );
};

const workspace = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "signature-kit-ltv-"))),
  (path) => Effect.promise(() => rm(path, { force: true, recursive: true })),
);

const signedRevision = Effect.gen(function* () {
  const a1 = yield* A1Sessions;
  const documents = yield* Documents;
  const pdf = yield* PdfSignatures;
  const source = yield* documents.open(yield* cosignFixture("sent.pdf"));
  const session = yield* a1.open({
    pfx: Redacted.make(yield* validationFixture("signer.p12")),
    password: Redacted.make("changeit"),
  });
  const prepared = yield* pdf.prepare(source, existingField(session, "Contratante"));
  return (yield* pdf.confirm(prepared.preparationId)).signedRevision;
});

const documentTimestamp = (revision: RevisionRef, tsaUrl: string) =>
  Effect.gen(function* () {
    const pdf = yield* PdfSignatures;
    const imprint = yield* pdf.prepareDocumentTimestamp(revision);
    const token = yield* requestTimestampForImprint({
      imprint,
      tsaUrl,
      trustedRoots: [yield* validationFixture("ca.der")],
      hashAlgorithm: "sha256",
    });
    return yield* pdf.addDocumentTimestamp(revision, token);
  });

it.live("raises a signature from B-B through B-T and B-LT to B-LTA with fetched evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const servers = yield* localEvidenceServers;
      const pdf = yield* PdfSignatures;
      const verification = yield* PdfVerification;
      const documents = yield* Documents;
      const [ca, signer, tsa] = yield* Effect.all([
        validationFixture("ca.der"),
        validationFixture("signer.der"),
        validationFixture("tsa.der"),
      ]);
      const options = { trust: [ca], tsaTrust: [ca] };
      const signed = yield* signedRevision;
      const at = () => ({ ...options, at: new Date(Date.now() + 60_000) });

      const basic = (yield* verification.verify(signed, at())).signatures[0];
      expect(basic).toMatchObject({
        integrity: "valid",
        trust: "trusted",
        revocation: { kind: "notChecked" },
        timestampEvidence: { kind: "absent" },
        ltvLevel: "B-B",
      });

      const timestamped = yield* documentTimestamp(signed, servers.tsaUrl);
      const [signatureT, timestampT] = (yield* verification.verify(timestamped, at())).signatures;
      expect(signatureT).toMatchObject({
        ltvLevel: "B-T",
        evaluationTime: { source: "documentTimestamp" },
      });
      expect(timestampT).toMatchObject({
        kind: "documentTimestamp",
        integrity: "valid",
        timestampEvidence: { kind: "verified" },
      });

      const ocsp = yield* requestOcsp({ certificate: signer, issuer: ca, url: servers.ocspUrl });
      const tsaOcsp = yield* requestOcsp({ certificate: tsa, issuer: ca, url: servers.ocspUrl });
      const longTerm = yield* pdf.addValidationData(timestamped, {
        certificates: [signer, tsa, ca],
        ocsp: [ocsp, tsaOcsp],
        crls: [],
      });
      const lt = (yield* verification.verify(longTerm, at())).signatures[0];
      expect(lt).toMatchObject({
        revocation: { kind: "verified", source: "ocsp", result: { status: "good" } },
        ltvLevel: "B-LT",
      });

      const archived = yield* documentTimestamp(longTerm, servers.tsaUrl);
      const report = yield* verification.verify(archived, at());
      expect(report.signatures.map(({ kind }) => kind)).toEqual([
        "signature",
        "documentTimestamp",
        "documentTimestamp",
      ]);
      const [lta] = report.signatures;
      expect(lta).toMatchObject({
        integrity: "valid",
        trust: "trusted",
        revocation: { kind: "verified", result: { status: "good" } },
        ltvLevel: "B-LTA",
      });
      if (lta === undefined) return yield* Effect.die("Missing signature report.");
      expect(reportSignature(lta)).toMatchObject({
        revocation: { kind: "verified", status: "good" },
        timestamp: "absent",
        mdp: "none",
        ltvLevel: "B-LTA",
      });
      const comparison = yield* verification.compare(signed, archived, at());
      expect(comparison.reasons).not.toContain("unexpectedChange");
      expect(comparison.reasons).not.toContain("revokedSignature");

      const offline = (yield* verification.verify(
        yield* documents.open(yield* documents.export(archived.handle)),
        at(),
      )).signatures[0];
      expect(offline).toMatchObject({ ltvLevel: "B-LTA" });
      expect(servers.requests.map(({ pathname }) => pathname).sort()).toEqual([
        "/ocsp",
        "/ocsp",
        "/tsa",
        "/tsa",
      ]);

      const bytes = yield* documents.export(archived.handle);
      const dir = yield* workspace;
      const file = join(dir, "lta.pdf");
      yield* Effect.promise(() => writeFile(file, bytes));
      const pdfsig = yield* Effect.promise(() =>
        run("pdfsig", ["-nocert", file]).then(
          ({ stdout, stderr }) => ({ stdout, stderr }),
          (error: { stdout: string; stderr: string }) => ({
            stdout: error.stdout,
            stderr: error.stderr,
          }),
        ),
      );
      expect(pdfsig.stdout.match(/Signature Validation: Signature is Valid\./g)).toHaveLength(1);
      expect(pdfsig.stdout.match(/Signature Field Name: DocTimeStamp-/g)).toHaveLength(2);
      expect(pdfsig.stderr).not.toContain("widget");
      yield* Effect.promise(() => run("qpdf", ["--check", file]));
      const ocspFile = join(dir, "ocsp.der");
      const caFile = join(dir, "ca.der");
      const signerFile = join(dir, "signer.der");
      yield* Effect.promise(async () => {
        await writeFile(file, bytes);
        await writeFile(ocspFile, ocsp);
        await writeFile(caFile, ca);
        await writeFile(signerFile, signer);
        await run("openssl", ["x509", "-inform", "DER", "-in", caFile, "-out", `${caFile}.pem`]);
        await run("openssl", [
          "x509",
          "-inform",
          "DER",
          "-in",
          signerFile,
          "-out",
          `${signerFile}.pem`,
        ]);
      });
      const oracle = yield* Effect.promise(() =>
        run("openssl", [
          "ocsp",
          "-respin",
          ocspFile,
          "-CAfile",
          `${caFile}.pem`,
          "-issuer",
          `${caFile}.pem`,
          "-cert",
          `${signerFile}.pem`,
          "-no_nonce",
        ]),
      );
      expect(oracle.stdout).toContain(": good");
      const timestamps = report.signatures.filter(({ kind }) => kind === "documentTimestamp");
      for (const [index, entry] of timestamps.entries()) {
        const end = entry.coverage.revisionEnd ?? 0;
        const revision = bytes.subarray(0, end);
        const contents = /\/Contents\s*<([0-9A-Fa-f]+)>/g;
        const matches = [...new TextDecoder("latin1").decode(revision).matchAll(contents)];
        const hex = matches.at(-1)?.[1] ?? "";
        const start = matches.at(-1)?.index ?? 0;
        const token = join(dir, `token-${index}.der`);
        const data = join(dir, `data-${index}`);
        const contentsStart = start + (matches.at(-1)?.[0].indexOf("<") ?? 0);
        const contentsEnd = contentsStart + (matches.at(-1)?.[1]?.length ?? 0) + 2;
        yield* Effect.promise(async () => {
          await writeFile(token, Buffer.from(hex, "hex"));
          await writeFile(
            data,
            Buffer.concat([revision.subarray(0, contentsStart), revision.subarray(contentsEnd)]),
          );
        });
        const verified = yield* Effect.promise(() =>
          run("openssl", [
            "ts",
            "-verify",
            "-token_in",
            "-in",
            token,
            "-data",
            data,
            "-CAfile",
            `${caFile}.pem`,
          ]),
        );
        expect(verified.stdout).toContain("Verification: OK");
      }
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "reports revoked, expired, wrong-responder and CRL evidence without upgrading presence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* localEvidenceServers;
        const pdf = yield* PdfSignatures;
        const verification = yield* PdfVerification;
        const fetcher = yield* EvidenceFetcher;
        const [ca, signer, good, revoked, expired, wrong] = yield* Effect.all([
          validationFixture("ca.der"),
          validationFixture("signer.der"),
          validationFixture("good.der"),
          validationFixture("revoked.der"),
          validationFixture("expired.der"),
          validationFixture("wrong-responder.der"),
        ]);
        const signed = yield* signedRevision;
        const crl = yield* fetcher.crl(servers.crlUrl);
        const issued = yield* producedAt(revoked);
        const at = new Date(issued.getTime() + 60_000);
        const later = new Date(issued.getTime() + 2 * 86_400_000);
        const verifyWith = (evidence: { ocsp: Uint8Array[]; crls: Uint8Array[] }, when: Date) =>
          Effect.gen(function* () {
            const revision = yield* pdf.addValidationData(signed, {
              certificates: [signer, ca],
              ...evidence,
            });
            return (yield* verification.verify(revision, { trust: [ca], at: when })).signatures[0];
          });

        expect(yield* verifyWith({ ocsp: [revoked], crls: [] }, at)).toMatchObject({
          revocation: {
            kind: "verified",
            source: "ocsp",
            result: { status: "revoked", reason: 1 },
          },
          ltvLevel: "B-B",
        });
        expect(yield* verifyWith({ ocsp: [], crls: [crl] }, at)).toMatchObject({
          revocation: { kind: "verified", source: "crl", result: { status: "revoked" } },
        });
        expect(yield* verifyWith({ ocsp: [expired], crls: [] }, later)).toMatchObject({
          revocation: { kind: "embeddedEvidence", ocspCount: 1, reasons: ["outsideValidity"] },
        });
        expect(yield* verifyWith({ ocsp: [wrong], crls: [] }, at)).toMatchObject({
          revocation: { kind: "embeddedEvidence", reasons: ["unauthorizedResponder"] },
        });
        const untrusted = yield* pdf.addValidationData(signed, {
          certificates: [signer, ca],
          ocsp: [good],
          crls: [],
        });
        expect((yield* verification.verify(untrusted, { at })).signatures[0]).toMatchObject({
          trust: "notEvaluated",
          revocation: { kind: "embeddedEvidence", reasons: ["untrustedIssuer"] },
        });
        const revokedRevision = yield* pdf.addValidationData(signed, {
          certificates: [signer, ca],
          ocsp: [revoked],
          crls: [],
        });
        const comparison = yield* verification.compare(signed, revokedRevision, {
          trust: [ca],
          at,
        });
        expect(comparison.reasons).toContain("revokedSignature");
        expect(
          yield* Effect.flip(fetcher.ocsp(`${servers.ocspUrl}/missing`, new Uint8Array([1]))),
        ).toMatchObject({ code: "status", operation: "ocsp", status: 404 });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("keeps DSS and document timestamps permitted under a P=1 certification", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const servers = yield* localEvidenceServers;
      const pdf = yield* PdfSignatures;
      const verification = yield* PdfVerification;
      const documents = yield* Documents;
      const a1 = yield* A1Sessions;
      const [ca, signer] = yield* Effect.all([
        validationFixture("ca.der"),
        validationFixture("signer.der"),
      ]);
      const source = yield* documents.open(yield* cosignFixture("sent.pdf"));
      const session = yield* a1.open({
        pfx: Redacted.make(yield* validationFixture("signer.p12")),
        password: Redacted.make("changeit"),
      });
      const prepared = yield* pdf.prepare(source, {
        ...existingField(session, "Contratante"),
        docMdp: 1,
      });
      const certified = (yield* pdf.confirm(prepared.preparationId)).signedRevision;
      const ocsp = yield* requestOcsp({ certificate: signer, issuer: ca, url: servers.ocspUrl });
      const withDss = yield* pdf.addValidationData(certified, {
        certificates: [signer, ca],
        ocsp: [ocsp],
        crls: [],
      });
      const archived = yield* documentTimestamp(withDss, servers.tsaUrl);
      const report = yield* verification.verify(archived, {
        trust: [ca],
        tsaTrust: [ca],
        at: new Date(Date.now() + 60_000),
      });
      const [signature] = report.signatures;
      expect(signature).toMatchObject({
        ltvLevel: "B-LTA",
        mdp: { docMdp: 1, violations: [], pageContentViolation: false },
      });
      expect(signature?.mdp?.permittedChanges.map(({ kind }) => kind)).toEqual(
        expect.arrayContaining(["dss", "docTimeStamp"]),
      );
      if (signature === undefined) return yield* Effect.die("Missing signature report.");
      expect(reportSignature(signature).mdp).toBe("respected");
      const comparison = yield* verification.compare(certified, archived, {
        trust: [ca],
        tsaTrust: [ca],
      });
      expect(comparison.reasons).not.toContain("mdpViolation");
    }),
  ).pipe(Effect.provide(layer)),
);
