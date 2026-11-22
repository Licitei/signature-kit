import { readFile } from "node:fs/promises";

import { describe, expect, it } from "@effect/vitest";
import { SignatureHttpClient, signatureHttpClientLive } from "@signature-kit/http";
import { Effect, Exit, Layer } from "effect";

import { ItiOperation, validatePdfConformance } from "../src/conformance";
import { validatePdfWithIti } from "../src/remote";
import { localHttpServer } from "../../../tooling/testing/local-http";
import { childSpans, recordSpans, spanNamed } from "../../../tooling/testing/tracing.ts";
import { pdfCoreTestLayer } from "./pdf-core-layer";

const ITI_ORIGIN = "https://validar.iti.gov.br";

const readSignedFixture = Effect.promise(
  async () =>
    new Uint8Array(
      await readFile(new URL("./fixtures/icp-brasil-ad-rb-signed.pdf", import.meta.url)),
    ),
);

const localItiClient = (baseUrl: string) =>
  Layer.effect(
    SignatureHttpClient,
    SignatureHttpClient.use((live) =>
      Effect.succeed({
        requestJson: (request, schema, schemaName) =>
          live.requestJson(
            { ...request, url: request.url.replace(ITI_ORIGIN, baseUrl) },
            schema,
            schemaName,
          ),
        requestJsonResponse: (request, schema, schemaName) =>
          live.requestJsonResponse(
            { ...request, url: request.url.replace(ITI_ORIGIN, baseUrl) },
            schema,
            schemaName,
          ),
        requestBytes: live.requestBytes,
        requestVoid: live.requestVoid,
      }),
    ),
  ).pipe(Layer.provide(signatureHttpClientLive));

describe("ITI tracing", () => {
  it.effect("records local conformance with per-signature spans and no signer identity", () =>
    Effect.gen(function* () {
      const pdf = yield* readSignedFixture;
      const { exit, spans } = yield* recordSpans(
        validatePdfConformance({ pdf }).pipe(Effect.provide(pdfCoreTestLayer)),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      const report = Exit.isSuccess(exit) ? exit.value : undefined;
      const conformance = spanNamed(spans, ItiOperation.conformance);
      expect(conformance?.attributes).toMatchObject({
        "signature_kit.pdf.bytes": pdf.byteLength,
        "signature_kit.pdf.signature_count": 1,
        "signature_kit.iti.outcome": report?.outcome,
      });
      const signature = childSpans(spans, conformance).find(
        (span) => span.name === "iti.conformance.signature",
      );
      expect(signature?.attributes["signature_kit.pdf.signature_index"]).toBe(0);
      expect(childSpans(spans, signature).map((span) => span.name)).toContain("cms.verify");
      const commonName = report?.signatures[0]?.signerCommonName;
      expect(typeof commonName).toBe("string");
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(
        commonName ?? "unreachable",
      );
    }),
  );

  it.effect("records the remote validation around the HTTP client span", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pdf = yield* readSignedFixture;
        const local = yield* localHttpServer(async () => ({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ verifierReport: { status: "APROVADO" } }),
        }));
        const { exit, spans } = yield* recordSpans(
          validatePdfWithIti({ source: { pdf } }).pipe(
            Effect.provide(Layer.merge(localItiClient(local.baseUrl), pdfCoreTestLayer)),
          ),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        const remote = spanNamed(spans, ItiOperation.remote);
        expect(remote?.attributes).toMatchObject({
          "signature_kit.iti.source": "bytes",
          "signature_kit.iti.remote_status": 200,
          "signature_kit.iti.outcome": "approved",
          "signature_kit.iti.approved": true,
        });
        const children = childSpans(spans, remote).map((span) => span.name);
        expect(children).toContain(ItiOperation.conformance);
        expect(children).toContain("POST");
      }),
    ),
  );
});
