import { timestampResponse } from "../fixtures/timestamp-response.js";
import type { TimestampSigner } from "../fixtures/timestamp-response.js";
import { describe, expect, it } from "@effect/vitest";
import * as asn1js from "asn1js";
import { Effect, Fiber, Layer, Result, Schema } from "effect";
import * as pkijs from "pkijs";
import { vi } from "vitest";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { localHttpServer } from "../../../../tooling/testing/local-http.js";
import { evidenceFetcherHttpLayer } from "../../src/evidence-fetcher.js";
import { MAX_NATIVE_TIMEOUT_MILLIS, TimestampOptionsSchema } from "../../src/cms/config";
import type { TimestampOptions } from "../../src/cms/config";
import { requestTimestamp } from "../../src/cms/timestamp";

const TSA_TIMESTAMPING_KEY_PURPOSE_OID = "1.3.6.1.5.5.7.3.8";

const invalidTimeoutMillis: ReadonlyArray<number> = [
  Number.NaN,
  Number.NEGATIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  -1,
  0.5,
  2 ** 31,
];
type TsaSignerOptions = {
  readonly keyUsage?: number;
  readonly timestampingEku?: boolean;
};

type RsaHashedKeyAlgorithm = RsaHashedKeyGenParams & {
  hash: Algorithm;
};

const isRsaHashedKeyAlgorithm = (algorithm: object): algorithm is RsaHashedKeyAlgorithm =>
  "name" in algorithm &&
  algorithm.name === "RSASSA-PKCS1-v1_5" &&
  "modulusLength" in algorithm &&
  typeof algorithm.modulusLength === "number" &&
  "publicExponent" in algorithm &&
  algorithm.publicExponent instanceof Uint8Array &&
  algorithm.publicExponent.buffer instanceof ArrayBuffer &&
  "hash" in algorithm &&
  algorithm.hash !== null &&
  typeof algorithm.hash === "object" &&
  "name" in algorithm.hash &&
  typeof algorithm.hash.name === "string";

const createTsaSigner = async ({
  keyUsage,
  timestampingEku = true,
}: TsaSignerOptions = {}): Promise<TimestampSigner> => {
  const cryptoEngine = pkijs.getCrypto(true);
  const parameters = pkijs.getAlgorithmParameters("RSASSA-PKCS1-v1_5", "generateKey");
  const keyAlgorithm: RsaHashedKeyAlgorithm = isRsaHashedKeyAlgorithm(parameters.algorithm)
    ? parameters.algorithm
    : {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array(Uint8Array.of(1, 0, 1)),
        hash: { name: "SHA-256" },
      };
  keyAlgorithm.hash.name = "SHA-256";
  const keyPair = await cryptoEngine.generateKey(keyAlgorithm, true, parameters.usages);
  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber.valueBlock.valueDec = 1;
  certificate.issuer.typesAndValues.push(
    pkijs.AttributeTypeAndValue.fromBER(
      new asn1js.Sequence({
        value: [
          new asn1js.ObjectIdentifier({ value: "2.5.4.3" }),
          new asn1js.BmpString({ value: "SignatureKit Test TSA" }),
        ],
      }).toBER(false),
    ),
  );
  certificate.subject.typesAndValues.push(
    pkijs.AttributeTypeAndValue.fromBER(
      new asn1js.Sequence({
        value: [
          new asn1js.ObjectIdentifier({ value: "2.5.4.3" }),
          new asn1js.BmpString({ value: "SignatureKit Test TSA" }),
        ],
      }).toBER(false),
    ),
  );
  certificate.notBefore.value = new Date("2020-01-01T00:00:00Z");
  certificate.notAfter.value = new Date("2030-01-01T00:00:00Z");
  const basicConstraints = new pkijs.BasicConstraints({ cA: true, pathLenConstraint: 0 });
  const extensions = [
    new pkijs.Extension({
      extnID: "2.5.29.19",
      critical: true,
      extnValue: basicConstraints.toSchema().toBER(false),
      parsedValue: basicConstraints,
    }),
  ];
  if (timestampingEku) {
    const extendedKeyUsage = new pkijs.ExtKeyUsage({
      keyPurposes: [TSA_TIMESTAMPING_KEY_PURPOSE_OID],
    });
    extensions.push(
      new pkijs.Extension({
        extnID: "2.5.29.37",
        critical: true,
        extnValue: extendedKeyUsage.toSchema().toBER(false),
        parsedValue: extendedKeyUsage,
      }),
    );
  }
  if (keyUsage !== undefined) {
    const keyUsageBits = new asn1js.BitString({
      valueHex: new Uint8Array(Uint8Array.of(keyUsage)).buffer,
    });
    extensions.push(
      new pkijs.Extension({
        extnID: "2.5.29.15",
        critical: true,
        extnValue: keyUsageBits.toBER(false),
        parsedValue: keyUsageBits,
      }),
    );
  }
  certificate.extensions = extensions;
  await certificate.subjectPublicKeyInfo.importKey(keyPair.publicKey);
  await certificate.sign(keyPair.privateKey, "SHA-256");

  return {
    certificate,
    certificateDer: new Uint8Array(certificate.toSchema(true).toBER(false)),
    privateKey: keyPair.privateKey,
  };
};

const httpEvidence = evidenceFetcherHttpLayer.pipe(Layer.provide(FetchHttpClient.layer));
const timestampInput = (
  tsaUrl: string,
  signer: TimestampSigner,
): Parameters<typeof requestTimestamp>[0] => ({
  data: new Uint8Array([1, 2, 3]),
  tsaUrl,
  trustedRoots: [signer.certificateDer],
  hashAlgorithm: "sha256",
});

describe("RFC 3161 timestamps", () => {
  it.effect("requires explicit TSA trust anchors in the public schema", () =>
    Effect.gen(function* () {
      const missingTrust = yield* Effect.result(
        Schema.decodeUnknownEffect(TimestampOptionsSchema)({
          tsaUrl: "https://tsa.example.test",
          hashAlgorithm: "sha256",
        }),
      );
      const configured = yield* Schema.decodeUnknownEffect(TimestampOptionsSchema)({
        tsaUrl: "https://tsa.example.test",
        trustedRoots: [new Uint8Array([0x01])],
        hashAlgorithm: "sha256",
      });

      expect(Result.isFailure(missingTrust)).toBe(true);
      expect(configured.trustedRoots).toHaveLength(1);
    }),
  );

  it.effect("accepts only native timer-compatible timeout values in the public schema", () =>
    Effect.gen(function* () {
      const options = {
        tsaUrl: "https://tsa.example.test",
        trustedRoots: [new Uint8Array([0x01])],
        hashAlgorithm: "sha256",
      } satisfies TimestampOptions;

      for (const timeoutMillis of invalidTimeoutMillis) {
        const result = yield* Effect.result(
          Schema.decodeUnknownEffect(TimestampOptionsSchema)({ ...options, timeoutMillis }),
        );
        expect(Result.isFailure(result)).toBe(true);
      }

      const defaults = yield* Schema.decodeUnknownEffect(TimestampOptionsSchema)(options);
      const immediate = yield* Schema.decodeUnknownEffect(TimestampOptionsSchema)({
        ...options,
        timeoutMillis: 0,
      });
      const normal = yield* Schema.decodeUnknownEffect(TimestampOptionsSchema)({
        ...options,
        timeoutMillis: 25,
      });
      const maximum = yield* Schema.decodeUnknownEffect(TimestampOptionsSchema)({
        ...options,
        timeoutMillis: MAX_NATIVE_TIMEOUT_MILLIS,
      });

      expect(defaults.timeoutMillis).toBeUndefined();
      expect(immediate.timeoutMillis).toBe(0);
      expect(normal.timeoutMillis).toBe(25);
      expect(maximum.timeoutMillis).toBe(MAX_NATIVE_TIMEOUT_MILLIS);
    }),
  );

  it.effect("rejects invalid timestamp timeouts before requesting evidence", () =>
    Effect.gen(function* () {
      const local = yield* localHttpServer(async () => ({ status: 500 }));
      const signer = yield* Effect.promise(() => createTsaSigner());
      for (const timeoutMillis of invalidTimeoutMillis) {
        const error = yield* Effect.flip(
          requestTimestamp({
            ...timestampInput(local.baseUrl, signer),
            timeoutMillis,
          }),
        );
        expect(error.code).toBe("cms.TIMESTAMP_ERROR");
      }
      expect(local.requests).toEqual([]);
    }).pipe(Effect.provide(httpEvidence)),
  );

  it.effect("maps timestamp nonce generation failures to CmsError", () =>
    Effect.gen(function* () {
      const signer = yield* Effect.promise(() => createTsaSigner());
      vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
        throw new Error("nonce failure");
      });

      const result = yield* Effect.result(
        requestTimestamp({
          data: new Uint8Array([1, 2, 3]),
          tsaUrl: "https://tsa.example.test",
          trustedRoots: [signer.certificateDer],
          hashAlgorithm: "sha256",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe("cms.TIMESTAMP_ERROR");
        expect(result.failure.operation).toBe("cms.timestamp");
      }
    }).pipe(Effect.ensuring(Effect.sync(() => vi.restoreAllMocks()))),
  );

  it.live("redacts credentials, query, and fragment from timestamp diagnostics", () =>
    Effect.gen(function* () {
      const signer = yield* Effect.promise(() => createTsaSigner());
      const local = yield* localHttpServer(async () => ({ status: 403, body: "denied" }));
      const transport = new URL("/tsa?token=secret#fragment", local.baseUrl);
      const denied = yield* Effect.flip(requestTimestamp(timestampInput(transport.href, signer)));
      expect(denied.reason).toBe(`TSA request to ${local.baseUrl}/tsa failed with HTTP 403.`);
      transport.username = "alice";
      transport.password = "secret";
      const credentials = yield* Effect.flip(
        requestTimestamp(timestampInput(transport.href, signer)),
      );
      expect(credentials.reason).toBe(`TSA request to ${local.baseUrl}/tsa failed.`);
      expect(local.requests).toHaveLength(1);
    }).pipe(Effect.provide(httpEvidence)),
  );

  it.live("accepts an RFC 3161 response from an explicit fetcher", () =>
    Effect.gen(function* () {
      const signer = yield* Effect.promise(() => createTsaSigner());
      const local = yield* localHttpServer(async ({ bodyBytes }) => ({
        status: 200,
        body: await timestampResponse(bodyBytes, signer),
      }));
      const input = timestampInput(local.baseUrl, signer);
      const missing = yield* Effect.flip(requestTimestamp(input));
      expect(missing.reason).toContain("explicit evidence fetcher");
      expect(local.requests).toEqual([]);
      const token = yield* requestTimestamp(input).pipe(Effect.provide(httpEvidence));
      expect(token.byteLength).toBeGreaterThan(0);
      expect(local.requests[0]).toMatchObject({
        method: "POST",
        headers: {
          "content-type": "application/timestamp-query",
          accept: "application/timestamp-reply",
        },
      });
    }),
  );

  it.live.each([
    "unsigned",
    "trailing",
    "noEku",
    "keyUsage",
    "noAttributes",
    "wrongBinding",
    "untrusted",
    "forged",
  ] satisfies Array<
    | "unsigned"
    | "trailing"
    | "noEku"
    | "keyUsage"
    | "noAttributes"
    | "wrongBinding"
    | "untrusted"
    | "forged"
  >)("rejects the %s timestamp response", (variant) =>
    Effect.gen(function* () {
      const signer = yield* Effect.promise(() =>
        createTsaSigner({
          timestampingEku: variant !== "noEku",
          ...(variant === "keyUsage" ? { keyUsage: 0x24 } : {}),
        }),
      );
      const decoy =
        variant === "wrongBinding" || variant === "untrusted"
          ? yield* Effect.promise(() => createTsaSigner())
          : undefined;
      const local = yield* localHttpServer(async ({ bodyBytes }) => {
        const response = await timestampResponse(
          bodyBytes,
          variant === "unsigned" ? undefined : signer,
          {
            includeSignedAttributes: variant !== "noAttributes",
            tamperSignature: variant === "forged",
            ...(variant === "wrongBinding" && decoy !== undefined
              ? { signingCertificateDers: [decoy.certificateDer, signer.certificateDer] }
              : {}),
          },
        );
        if (variant !== "trailing") return { status: 200, body: response };
        const body = new Uint8Array(response.length + 1);
        body.set(response);
        return { status: 200, body };
      });
      const error = yield* Effect.flip(
        requestTimestamp(
          timestampInput(
            local.baseUrl,
            variant === "untrusted" && decoy !== undefined ? decoy : signer,
          ),
        ),
      );
      expect(error.code).toBe("cms.TIMESTAMP_ERROR");
      const reasons = {
        unsigned: "valid signed RFC 3161",
        trailing: "trailing bytes",
        noEku: "critical timestamping-only",
        keyUsage: "critical timestamping-only",
        noAttributes: "signed attributes",
        wrongBinding: "does not bind the signer certificate",
        untrusted: "certificate chain",
        forged: "signature",
      };
      expect(error.reason).toContain(reasons[variant]);
    }).pipe(Effect.provide(httpEvidence)),
  );

  it.live("closes non-success bodies before returning the final classified status", () =>
    Effect.gen(function* () {
      const signer = yield* Effect.promise(() => createTsaSigner());
      const closed = Promise.withResolvers<void>();
      let count = 0;
      const local = yield* localHttpServer(async () => ({
        status: 503,
        body: "busy",
        keepOpen: true,
        onClose: () => {
          count += 1;
          if (count === 3) closed.resolve();
        },
      }));
      const error = yield* Effect.flip(requestTimestamp(timestampInput(local.baseUrl, signer)));
      expect(error.reason).toContain("HTTP 503");
      expect(local.requests).toHaveLength(3);
      yield* Effect.promise(() => closed.promise);
    }).pipe(Effect.provide(httpEvidence)),
  );

  it.effect("times out a hanging response body and closes its connection", () =>
    Effect.gen(function* () {
      const signer = yield* Effect.promise(() => createTsaSigner());
      const started = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const local = yield* localHttpServer(async () => {
        started.resolve();
        return { status: 200, body: "partial", keepOpen: true, onClose: closed.resolve };
      });
      const pending = yield* Effect.forkChild(
        Effect.flip(
          requestTimestamp({
            ...timestampInput(local.baseUrl, signer),
            timeoutMillis: 1000,
          }),
        ),
      );
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(pending);
      expect(error.reason).toContain("timed out");
      yield* Effect.promise(() => closed.promise);
      expect(local.requests).toHaveLength(1);
    }).pipe(Effect.provide(httpEvidence)),
  );
});
