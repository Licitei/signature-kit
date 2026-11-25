import * as asn1js from "asn1js";
import { Effect, Schema } from "effect";
import * as pkijs from "pkijs";
import { buildSignedAttributes } from "./attributes.js";
import {
  CreateDetachedSignedDataFromDigestInputSchema,
  CreateDetachedSignedDataInputSchema,
  CmsError,
  CmsErrorCodeValue,
  CmsOid,
  CmsOperationValue,
  hashAlgorithmOid,
  webCryptoHashName,
} from "./config.js";
import type {
  CreateDetachedSignedDataFromDigestInput,
  CreateDetachedSignedDataInput,
} from "./config.js";
import { digest } from "./engine.js";
import { requestTimestamp } from "./timestamp.js";

export const createDetachedSignedDataFromDigest = <E, R>(
  input: CreateDetachedSignedDataFromDigestInput,
  sign: (signedAttributesDer: Uint8Array) => Effect.Effect<Uint8Array, E, R>,
): Effect.Effect<Uint8Array, CmsError | E, R> =>
  Effect.gen(function* () {
    const valid = yield* Schema.decodeUnknownEffect(CreateDetachedSignedDataFromDigestInputSchema)(
      input,
    ).pipe(
      Effect.mapError(
        () =>
          new CmsError({ code: CmsErrorCodeValue.signError, operation: CmsOperationValue.sign }),
      ),
    );
    const digestLengths = { sha256: 32, sha384: 48, sha512: 64 };
    if (valid.messageDigest.byteLength !== digestLengths[valid.hashAlgorithm]) {
      return yield* new CmsError({
        code: CmsErrorCodeValue.signError,
        operation: CmsOperationValue.sign,
        reason: "The message digest has the wrong length for the selected algorithm.",
      });
    }

    const [certificate, ...chain] = yield* Effect.try({
      try: () =>
        [valid.certificateDer, ...(valid.chainDer ?? [])].map((der) =>
          pkijs.Certificate.fromBER(new Uint8Array(der).buffer),
        ),
      catch: () =>
        new CmsError({
          code: CmsErrorCodeValue.decodeError,
          operation: CmsOperationValue.parse,
          reason: "Failed to parse the CMS certificates.",
        }),
    });
    if (certificate === undefined) return yield* Effect.die("Missing CMS signer certificate.");

    const certificateSha256 = yield* digest("sha256", valid.certificateDer);
    const { attributes, signedAttributesDer } = yield* Effect.try({
      try: () => {
        const attributes = [...buildSignedAttributes({ ...valid, certificateSha256 })];
        const signedAttributesDer = new Uint8Array(
          new asn1js.Set({ value: attributes.map((attr) => attr.toSchema()) }).toBER(false),
        );
        return { attributes, signedAttributesDer };
      },
      catch: () =>
        new CmsError({
          code: CmsErrorCodeValue.encodeError,
          operation: CmsOperationValue.attributes,
          reason: "Failed to encode the CMS signed attributes.",
        }),
    });
    const signature = yield* sign(signedAttributesDer);

    return yield* Effect.try({
      try: () => {
        const digestAlgorithm = new pkijs.AlgorithmIdentifier({
          algorithmId: hashAlgorithmOid(valid.hashAlgorithm),
        });
        const signer = new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: certificate.issuer,
            serialNumber: certificate.serialNumber,
          }),
          digestAlgorithm,
          signatureAlgorithm: new pkijs.AlgorithmIdentifier({
            algorithmId: "1.2.840.113549.1.1.1",
            algorithmParams: new asn1js.Null(),
          }),
          signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes }),
        });
        signer.signature.valueBlock.valueHexView = new Uint8Array(signature);
        const signed = new pkijs.SignedData({
          version: 1,
          digestAlgorithms: [digestAlgorithm],
          encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: CmsOid.data }),
          signerInfos: [signer],
          certificates: [certificate, ...chain],
        });
        return new Uint8Array(
          new pkijs.ContentInfo({
            contentType: CmsOid.signedData,
            content: signed.toSchema(true),
          })
            .toSchema()
            .toBER(false),
        );
      },
      catch: () =>
        new CmsError({
          code: CmsErrorCodeValue.encodeError,
          operation: CmsOperationValue.encode,
          reason: "Failed to serialize the detached CMS ContentInfo.",
        }),
    });
  });

export const createDetachedSignedData = (
  input: CreateDetachedSignedDataInput,
): Effect.Effect<Uint8Array, CmsError> =>
  Effect.gen(function* () {
    const valid = yield* Schema.decodeUnknownEffect(CreateDetachedSignedDataInputSchema)(
      input,
    ).pipe(
      Effect.mapError(
        (issue) =>
          new CmsError({
            code: CmsErrorCodeValue.signError,
            reason: `Invalid CMS signing input: ${String(issue)}`,
            operation: CmsOperationValue.sign,
          }),
      ),
    );
    const hashAlgorithm = valid.hashAlgorithm ?? "sha256";
    yield* Effect.annotateCurrentSpan({
      "signature_kit.cms.content_bytes": valid.content.byteLength,
      "signature_kit.hash.algorithm": hashAlgorithm,
      "signature_kit.cms.certificate_count": 1 + (valid.chainDer?.length ?? 0),
      "signature_kit.cms.icp_brasil_policy": valid.icpBrasil !== undefined,
      "signature_kit.timestamp.requested": valid.timestamp !== undefined,
    });

    const certificate = yield* Effect.try({
      try: () => pkijs.Certificate.fromBER(new Uint8Array(valid.certificateDer).buffer),
      catch: () =>
        new CmsError({
          code: CmsErrorCodeValue.decodeError,
          reason: "Failed to parse the signer certificate DER.",
          operation: CmsOperationValue.parse,
        }),
    });

    const embeddedCertificateDer = yield* Effect.try({
      try: () => new Uint8Array(certificate.toSchema().toBER(false)),
      catch: () =>
        new CmsError({
          code: CmsErrorCodeValue.encodeError,
          reason: "Failed to serialize the signer certificate for CMS embedding.",
          operation: CmsOperationValue.encode,
        }),
    });

    const chain = yield* Effect.try({
      try: () =>
        (valid.chainDer ?? []).map((der) => pkijs.Certificate.fromBER(new Uint8Array(der).buffer)),
      catch: () =>
        new CmsError({
          code: CmsErrorCodeValue.decodeError,
          reason: "Failed to parse a chain certificate DER.",
          operation: CmsOperationValue.parse,
        }),
    });

    const [messageDigest, certificateSha256] = yield* Effect.all(
      [digest(hashAlgorithm, valid.content), digest("sha256", embeddedCertificateDer)],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.withSpan("cms.digest", {
        attributes: { "signature_kit.hash.algorithm": hashAlgorithm },
      }),
    );

    const signed = yield* Effect.try({
      try: () =>
        new pkijs.SignedData({
          version: 1,
          encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: CmsOid.data }),
          signerInfos: [
            new pkijs.SignerInfo({
              version: 1,
              sid: new pkijs.IssuerAndSerialNumber({
                issuer: certificate.issuer,
                serialNumber: certificate.serialNumber,
              }),
              signedAttrs: new pkijs.SignedAndUnsignedAttributes({
                type: 0,
                attributes: [
                  ...buildSignedAttributes({
                    messageDigest,
                    certificateSha256,
                    icpBrasil: valid.icpBrasil,
                  }),
                ],
              }),
            }),
          ],
          certificates: [certificate, ...chain],
        }),
      catch: () =>
        new CmsError({
          code: CmsErrorCodeValue.encodeError,
          reason: "Failed to assemble the CMS SignedData.",
          operation: CmsOperationValue.encode,
        }),
    });

    yield* Effect.tryPromise({
      try: () =>
        signed.sign(
          valid.signingKey,
          0,
          webCryptoHashName(hashAlgorithm),
          new Uint8Array(valid.content),
        ),
      catch: () =>
        new CmsError({
          code: CmsErrorCodeValue.signError,
          reason: "Web Crypto signing of the CMS attributes failed.",
          operation: CmsOperationValue.sign,
        }),
    }).pipe(Effect.withSpan("cms.signature"));

    if (valid.timestamp !== undefined) {
      const signerInfo = signed.signerInfos[0];
      if (signerInfo === undefined) {
        return yield* new CmsError({
          code: CmsErrorCodeValue.encodeError,
          reason: "CMS SignedData has no signer info for timestamp embedding.",
          operation: CmsOperationValue.encode,
        });
      }
      const signatureValue = signerInfo.signature.valueBlock.valueHexView;
      const tokenDer = yield* requestTimestamp({
        data: signatureValue,
        tsaUrl: valid.timestamp.tsaUrl,
        trustedRoots: valid.timestamp.trustedRoots,
        hashAlgorithm: valid.timestamp.hashAlgorithm ?? "sha256",
        timeoutMillis: valid.timestamp.timeoutMillis,
      });
      yield* Effect.try({
        try: () => {
          signerInfo.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
            type: 1,
            attributes: [
              new pkijs.Attribute({
                type: CmsOid.timeStampToken,
                values: [asn1js.fromBER(new Uint8Array(tokenDer).buffer).result],
              }),
            ],
          });
          return undefined;
        },
        catch: () =>
          new CmsError({
            code: CmsErrorCodeValue.encodeError,
            reason: "Failed to embed the timestamp token.",
            operation: CmsOperationValue.encode,
          }),
      });
    }

    const encoded = yield* Effect.try({
      try: () => {
        const contentInfo = new pkijs.ContentInfo({
          contentType: CmsOid.signedData,
          content: signed.toSchema(true),
        });
        return new Uint8Array(contentInfo.toSchema().toBER(false));
      },
      catch: () =>
        new CmsError({
          code: CmsErrorCodeValue.encodeError,
          reason: "Failed to serialize the CMS ContentInfo.",
          operation: CmsOperationValue.encode,
        }),
    });
    yield* Effect.annotateCurrentSpan("signature_kit.cms.output_bytes", encoded.byteLength);
    return encoded;
  }).pipe(Effect.withSpan(CmsOperationValue.sign));
