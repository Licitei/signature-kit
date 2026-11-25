import * as asn1js from "asn1js";
import { Effect, Schema } from "effect";
import * as pkijs from "pkijs";
import { buildSignedAttributes, compareDer } from "./attributes.js";
import {
  CmsError,
  CmsErrorCodeValue,
  CmsOid,
  CmsOperationValue,
  DetachedSignatureOptionsSchema,
  DetachedSignerOptionsSchema,
  hashAlgorithmOid,
  webCryptoHashName,
} from "./config.js";
import type { DetachedSignatureOptions, DetachedSignerOptions } from "./config.js";
import { digest } from "./engine.js";

const rsaEncryption = "1.2.840.113549.1.1.1";
const signatureAlgorithm = "RSASSA-PKCS1-v1_5";
const digestLengths = { sha256: 32, sha384: 48, sha512: 64 };

const tagged = (tag: number, values: readonly Uint8Array[]) => {
  const length = values.reduce((sum, value) => sum + value.byteLength, 0);
  const longLength = [];
  if (length >= 128) {
    for (let value = length; value > 0; value = Math.floor(value / 256)) {
      longLength.unshift(value % 256);
    }
  }
  const header =
    longLength.length === 0 ? [tag, length] : [tag, 128 + longLength.length, ...longLength];
  const der = new Uint8Array(header.length + length);
  der.set(header);
  let offset = header.length;
  for (const value of values) {
    der.set(value, offset);
    offset += value.byteLength;
  }
  return der;
};

const oid = (value: string) => new Uint8Array(new asn1js.ObjectIdentifier({ value }).toBER());
const version = Uint8Array.of(0x02, 1, 1);
const contentType = oid(CmsOid.signedData);
const detachedContent = tagged(0x30, [oid(CmsOid.data)]);
const rsa = tagged(0x30, [oid(rsaEncryption), Uint8Array.of(5, 0)]);

export const makeDetachedSigner = Effect.fn(CmsOperationValue.parse)(function* (
  input: DetachedSignerOptions,
) {
  const options = yield* Schema.decodeUnknownEffect(DetachedSignerOptionsSchema)(input).pipe(
    Effect.mapError(
      () =>
        new CmsError({
          code: CmsErrorCodeValue.decodeError,
          operation: CmsOperationValue.parse,
        }),
    ),
  );
  const { hashAlgorithm } = options;
  const certificateDer = new Uint8Array(options.certificateDer);
  const chainDer = options.chainDer.map((der) => new Uint8Array(der));
  const { sid, spki, encodedSigner, certificates } = yield* Effect.try({
    try: () => {
      const certificate = pkijs.Certificate.fromBER(certificateDer);
      const encodedSigner = new Uint8Array(certificate.toSchema().toBER());
      const encodedChain = chainDer.map(
        (der) => new Uint8Array(pkijs.Certificate.fromBER(der).toSchema().toBER()),
      );
      return {
        sid: new Uint8Array(
          new pkijs.IssuerAndSerialNumber({
            issuer: certificate.issuer,
            serialNumber: certificate.serialNumber,
          })
            .toSchema()
            .toBER(),
        ),
        spki: certificate.subjectPublicKeyInfo.toSchema().toBER(),
        encodedSigner,
        certificates: tagged(0xa0, [encodedSigner, ...encodedChain].sort(compareDer)),
      };
    },
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.decodeError,
        reason: "Failed to read the CMS certificates and signer identity.",
        operation: CmsOperationValue.parse,
      }),
  });
  const key = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "spki",
        spki,
        { name: signatureAlgorithm, hash: webCryptoHashName(hashAlgorithm) },
        false,
        ["verify"],
      ),
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.verifyError,
        reason: "Failed to import the CMS signer public key.",
        operation: CmsOperationValue.verify,
      }),
  });
  if (!("modulusLength" in key.algorithm) || typeof key.algorithm.modulusLength !== "number") {
    return yield* new CmsError({
      code: CmsErrorCodeValue.verifyError,
      reason: "The CMS signer public key is not RSA.",
      operation: CmsOperationValue.verify,
    });
  }

  const signatureLength = Math.ceil(key.algorithm.modulusLength / 8);
  const certificateSha256 = yield* digest("sha256", encodedSigner);
  const algorithm = tagged(0x30, [oid(hashAlgorithmOid(hashAlgorithm))]);
  const digestAlgorithms = tagged(0x31, [algorithm]);

  return Effect.fnUntraced(function* (input: DetachedSignatureOptions) {
    const options = yield* Schema.decodeUnknownEffect(DetachedSignatureOptionsSchema)(input).pipe(
      Effect.mapError(
        () =>
          new CmsError({
            code: CmsErrorCodeValue.signError,
            operation: CmsOperationValue.sign,
          }),
      ),
    );
    if (options.messageDigest.byteLength !== digestLengths[hashAlgorithm]) {
      return yield* new CmsError({
        code: CmsErrorCodeValue.signError,
        reason: "The message digest has the wrong length for the selected algorithm.",
        operation: CmsOperationValue.sign,
      });
    }
    const signedAttributes = yield* Effect.try({
      try: () =>
        new Uint8Array(
          new asn1js.Set({
            value: buildSignedAttributes({ ...options, certificateSha256 }).map((attr) =>
              attr.toSchema(),
            ),
          }).toBER(),
        ),
      catch: () =>
        new CmsError({
          code: CmsErrorCodeValue.encodeError,
          reason: "Failed to encode the CMS signed attributes.",
          operation: CmsOperationValue.attributes,
        }),
    });
    const attributesField = new Uint8Array(signedAttributes);
    attributesField[0] = 0xa0;
    const signer = tagged(0x30, [
      version,
      sid,
      algorithm,
      attributesField,
      rsa,
      tagged(0x04, [new Uint8Array(signatureLength)]),
    ]);
    const signed = tagged(0x30, [
      version,
      digestAlgorithms,
      detachedContent,
      certificates,
      tagged(0x31, [signer]),
    ]);
    const template = tagged(0x30, [contentType, tagged(0xa0, [signed])]);
    const signatureOffset = template.length - signatureLength;
    const prefix = template.subarray(0, signatureOffset);

    return {
      sign: <E, R>(sign: (data: Uint8Array) => Effect.Effect<Uint8Array, E, R>) =>
        sign(new Uint8Array(signedAttributes)).pipe(
          Effect.flatMap((signature) => {
            if (signature.byteLength !== signatureLength) {
              return Effect.fail(
                new CmsError({
                  code: CmsErrorCodeValue.signError,
                  reason: "The signature length does not match the CMS signer key.",
                  operation: CmsOperationValue.sign,
                }),
              );
            }
            const cms = new Uint8Array(template);
            cms.set(signature, signatureOffset);
            return Effect.succeed(cms);
          }),
        ),
      verify: Effect.fnUntraced(function* (cms: Uint8Array) {
        if (
          cms.length < template.length ||
          !prefix.every((byte, index) => byte === cms[index]) ||
          cms.subarray(template.length).some((byte) => byte !== 0)
        )
          return false;
        const signature = cms.subarray(signatureOffset, template.length);
        return yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.verify(
              signatureAlgorithm,
              key,
              new Uint8Array(signature),
              signedAttributes,
            ),
          catch: () =>
            new CmsError({
              code: CmsErrorCodeValue.verifyError,
              reason: "Failed to verify the CMS signed attributes.",
              operation: CmsOperationValue.verify,
            }),
        });
      }),
    };
  });
});
