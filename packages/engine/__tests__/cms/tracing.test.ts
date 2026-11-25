import { describe, expect, it } from "@effect/vitest";
import * as asn1js from "asn1js";
import { Effect, Exit } from "effect";
import * as pkijs from "pkijs";

import { CmsOperationValue } from "../src/config";
import { inspectDetachedSignedData } from "../src/inspect";
import { createDetachedSignedData } from "../src/sign";
import { verifyDetachedSignedData } from "../src/verify";
import { localHttpServer } from "../../../tooling/testing/local-http";
import { childSpans, recordSpans, spanNamed } from "../../../tooling/testing/tracing.ts";

const SIGNER_NAME = "Tracing Signer Person";

const selfSignedCertificate = Effect.promise(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber.valueBlock.valueDec = 7;
  const name = pkijs.AttributeTypeAndValue.fromBER(
    new asn1js.Sequence({
      value: [
        new asn1js.ObjectIdentifier({ value: "2.5.4.3" }),
        new asn1js.Utf8String({ value: SIGNER_NAME }),
      ],
    }).toBER(false),
  );
  certificate.issuer.typesAndValues.push(name);
  certificate.subject.typesAndValues.push(name);
  certificate.notBefore.value = new Date("2020-01-01T00:00:00.000Z");
  certificate.notAfter.value = new Date("2040-01-01T00:00:00.000Z");
  await certificate.subjectPublicKeyInfo.importKey(keyPair.publicKey);
  await certificate.sign(keyPair.privateKey, "SHA-256");
  return {
    certificateDer: new Uint8Array(certificate.toSchema().toBER(false)),
    signingKey: keyPair.privateKey,
  };
});

describe("CMS tracing", () => {
  it.effect("records sign, verify and inspect spans without signer identity", () =>
    Effect.gen(function* () {
      const signer = yield* selfSignedCertificate;
      const content = new TextEncoder().encode("detached CMS tracing content");
      const { exit, spans } = yield* recordSpans(
        Effect.gen(function* () {
          const cms = yield* createDetachedSignedData({ content, ...signer });
          yield* verifyDetachedSignedData({ cms, content });
          return yield* inspectDetachedSignedData({ cms });
        }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);

      const sign = spanNamed(spans, CmsOperationValue.sign);
      expect(sign?.attributes).toMatchObject({
        "signature_kit.cms.content_bytes": content.byteLength,
        "signature_kit.hash.algorithm": "sha256",
        "signature_kit.cms.certificate_count": 1,
        "signature_kit.timestamp.requested": false,
      });
      expect(sign?.attributes["signature_kit.cms.output_bytes"]).toBeGreaterThan(0);
      expect(childSpans(spans, sign).map((span) => span.name)).toEqual([
        "cms.digest",
        "cms.signature",
      ]);
      expect(spanNamed(spans, CmsOperationValue.verify)?.attributes).toMatchObject({
        "signature_kit.cms.valid": true,
        "signature_kit.cms.chain_checked": false,
        "signature_kit.cms.revocation_status": "not_checked",
      });
      expect(spanNamed(spans, CmsOperationValue.parse)?.attributes).toMatchObject({
        "signature_kit.cms.signer_count": 1,
        "signature_kit.cms.certificate_count": 1,
      });
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(SIGNER_NAME);
    }),
  );

  it.effect("records the TSA client span and marks a failed timestamp as an error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const signer = yield* selfSignedCertificate;
        const local = yield* localHttpServer(async () => ({ status: 503, body: "busy" }));
        const { exit, spans } = yield* recordSpans(
          createDetachedSignedData({
            content: new Uint8Array([1, 2, 3]),
            ...signer,
            timestamp: {
              tsaUrl: `${local.baseUrl}/tsa?token=secret-token`,
              trustedRoots: [signer.certificateDer],
            },
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const timestamp = spanNamed(spans, CmsOperationValue.timestamp);
        expect(timestamp?.status.code).toBe(2);
        const client = childSpans(spans, timestamp).find((span) => span.name === "POST");
        expect(client?.kind).toBe(2);
        expect(client?.attributes).toMatchObject({
          "http.request.method": "POST",
          "http.response.status_code": 503,
          "server.address": new URL(local.baseUrl).hostname,
        });
        expect(spanNamed(spans, CmsOperationValue.sign)?.status.code).toBe(2);
        expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("secret-token");
      }),
    ),
  );
});
