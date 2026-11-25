import { Effect, Schema } from "effect";
import { decode, encode, oidNode, sequenceNode, setNode } from "../asn1/asn1.js";
import type { Asn1Node } from "../asn1/asn1.js";
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

const oid = (value: string) => oidNode(value).pipe(Effect.map(encode));
const version = Uint8Array.of(0x02, 1, 1);

const certificateError = () =>
  new CmsError({
    code: CmsErrorCodeValue.decodeError,
    reason: "Failed to read the CMS certificates and signer identity.",
    operation: CmsOperationValue.parse,
  });

const signerFields = (certificate: Asn1Node) => {
  const [tbs] = certificate.kind === "constructed" ? certificate.children : [];
  const fields = tbs?.kind === "constructed" ? tbs.children : [];
  const offset = fields[0]?.class === "context" && fields[0].tag === 0 ? 1 : 0;
  const serialNumber = fields[offset];
  const issuer = fields[offset + 2];
  const subjectPublicKeyInfo = fields[offset + 5];
  return serialNumber === undefined || issuer === undefined || subjectPublicKeyInfo === undefined
    ? Effect.fail(certificateError())
    : Effect.succeed({ serialNumber, issuer, subjectPublicKeyInfo });
};

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
  const [signerNode, ...chainNodes] = yield* Effect.forEach([certificateDer, ...chainDer], (der) =>
    decode(der).pipe(Effect.mapError(certificateError)),
  );
  if (signerNode === undefined) return yield* Effect.die("The CMS signer certificate is missing.");
  const signer = yield* signerFields(signerNode);
  const sid = encode(sequenceNode([signer.issuer, signer.serialNumber]));
  const spki = new Uint8Array(encode(signer.subjectPublicKeyInfo));
  const encodedSigner = encode(signerNode);
  const certificates = tagged(0xa0, [encodedSigner, ...chainNodes.map(encode)].sort(compareDer));
  const encodingError = () =>
    new CmsError({
      code: CmsErrorCodeValue.encodeError,
      reason: "Failed to encode the CMS object identifiers.",
      operation: CmsOperationValue.attributes,
    });
  const contentType = yield* oid(CmsOid.signedData).pipe(Effect.mapError(encodingError));
  const detachedContent = tagged(0x30, [
    yield* oid(CmsOid.data).pipe(Effect.mapError(encodingError)),
  ]);
  const rsa = tagged(0x30, [
    yield* oid(rsaEncryption).pipe(Effect.mapError(encodingError)),
    Uint8Array.of(5, 0),
  ]);
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
  const algorithm = tagged(0x30, [
    yield* oid(hashAlgorithmOid(hashAlgorithm)).pipe(Effect.mapError(encodingError)),
  ]);
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
    const signedAttributes = yield* buildSignedAttributes({ ...options, certificateSha256 }).pipe(
      Effect.map(
        (attributes) => new Uint8Array(encode(setNode(attributes.map(({ node }) => node)))),
      ),
      Effect.mapError(
        () =>
          new CmsError({
            code: CmsErrorCodeValue.encodeError,
            reason: "Failed to encode the CMS signed attributes.",
            operation: CmsOperationValue.attributes,
          }),
      ),
    );
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
