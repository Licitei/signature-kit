import {
  evidenceFetcherHttpLayer,
  requestOcsp,
  requestTimestampForImprint,
} from "@signature-kit/engine/evidence-fetcher";
import type { PdfVerificationReport } from "@signature-kit/engine/rpc";
import { Effect, Layer, Redacted, Result } from "effect";
import * as Base64 from "effect/encoding/Base64";
import { FetchHttpClient } from "effect/http";
import { existingField } from "../../../tooling/testing/cosign.js";
import { LocalClient, localClientLayer } from "../src/client.js";

const layer = localClientLayer(
  () => new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" }),
);
const evidence = evidenceFetcherHttpLayer.pipe(Layer.provide(FetchHttpClient.layer));
const bytes = (file: string) => new Uint8Array(Result.getOrThrow(Base64.decode(file)));

export type LtvFixtures = {
  readonly pdf: string;
  readonly p12: string;
  readonly ca: string;
  readonly signer: string;
  readonly tsa: string;
};

const summary = ({ signatures }: PdfVerificationReport) =>
  signatures.map(({ kind, integrity, trust, ltvLevel, revocation, evaluationTime }) => ({
    kind,
    integrity,
    trust,
    ltvLevel,
    revocation:
      revocation.kind === "verified"
        ? `${revocation.kind}:${revocation.source}:${revocation.result.status}`
        : revocation.kind,
    timeSource: evaluationTime.source,
  }));

const at = () => new Date(Date.now() + 60_000);

export const archiveWithFetchedEvidence = (
  fixtures: LtvFixtures,
  urls: { readonly ocsp: string; readonly tsa: string },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* LocalClient;
      const [ca, signer, tsa] = [bytes(fixtures.ca), bytes(fixtures.signer), bytes(fixtures.tsa)];
      const source = yield* client.openDocument(bytes(fixtures.pdf));
      const session = yield* client.openA1({
        pfx: Redacted.make(bytes(fixtures.p12)),
        password: Redacted.make("changeit"),
      });
      const prepared = yield* client.preparePdf(source, existingField(session, "Contratante"));
      const signed = (yield* client.confirmPdf(prepared.preparationId)).signedRevision;
      const options = { trust: [ca], tsaTrust: [ca] };
      const basic = summary(yield* client.verifyPdf(signed, { ...options, at: at() }));
      const ocsp = yield* requestOcsp({ certificate: signer, issuer: ca, url: urls.ocsp });
      const tsaOcsp = yield* requestOcsp({ certificate: tsa, issuer: ca, url: urls.ocsp });
      const withDss = yield* client.addPdfValidationData(signed, {
        certificates: [signer, tsa, ca],
        ocsp: [ocsp, tsaOcsp],
        crls: [],
      });
      const imprint = yield* client.preparePdfDocumentTimestamp(withDss);
      const token = yield* requestTimestampForImprint({
        imprint,
        tsaUrl: urls.tsa,
        trustedRoots: [ca],
        hashAlgorithm: "sha256",
      });
      const archived = yield* client.addPdfDocumentTimestamp(withDss, token);
      return {
        basic,
        archived: summary(yield* client.verifyPdf(archived, { ...options, at: at() })),
        pdf: Base64.encode(yield* client.exportDocument(archived.handle)),
      };
    }).pipe(Effect.provide(Layer.merge(layer, evidence))),
  );

export const verifyOffline = (pdf: string, ca: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* LocalClient;
      const document = yield* client.openDocument(bytes(pdf));
      const root = bytes(ca);
      return summary(
        yield* client.verifyPdf(document, { trust: [root], tsaTrust: [root], at: at() }),
      );
    }).pipe(Effect.provide(layer)),
  );
