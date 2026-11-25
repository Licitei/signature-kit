import * as asn1js from "asn1js";
import { Effect, Option, Schema } from "effect";
import * as pkijs from "pkijs";
import {
  CmsError,
  CmsErrorCodeValue,
  CmsHashAlgorithmSchema,
  CmsOid,
  CmsOperationValue,
  hashAlgorithmOid,
  TimeoutMillisSchema,
} from "./config.js";
import { digest } from "./engine.js";
import { EvidenceFetcher } from "../validation/fetcher.js";

const TSA_TST_INFO_CONTENT_TYPE = "1.2.840.113549.1.9.16.1.4";
const TSA_EXTENDED_KEY_USAGE_OID = "2.5.29.37";
const TSA_TIMESTAMPING_KEY_PURPOSE_OID = "1.3.6.1.5.5.7.3.8";
const TSA_SIGNING_CERTIFICATE_OID = "1.2.840.113549.1.9.16.2.12";
const TSA_KEY_USAGE_OID = "2.5.29.15";
const diagnosticTimestampUrl = (url: string): string =>
  url.replace(/^([a-z][a-z\d+.-]*:\/\/)(?:[^/?#]*@)/i, "$1").replace(/[?#].*$/, "");

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

type EssHashAlgorithm = "sha1" | "sha256" | "sha384" | "sha512";

type EssCertIdV2Hash = {
  readonly algorithm: EssHashAlgorithm;
  readonly hash: Uint8Array;
};

const sequenceChildren = (value: unknown): readonly unknown[] | undefined =>
  value instanceof asn1js.Sequence ? value.valueBlock.value : undefined;

const octetStringBytes = (value: unknown): Uint8Array | undefined => {
  if (!(value instanceof asn1js.OctetString)) return undefined;
  return value.valueBlock.valueHexView.byteLength === 0
    ? new Uint8Array(value.getValue())
    : value.valueBlock.valueHexView;
};

const essHashAlgorithmFromOid = (oid: string): EssHashAlgorithm | undefined => {
  switch (oid) {
    case "1.3.14.3.2.26":
      return "sha1";
    case "2.16.840.1.101.3.4.2.1":
      return "sha256";
    case "2.16.840.1.101.3.4.2.2":
      return "sha384";
    case "2.16.840.1.101.3.4.2.3":
      return "sha512";
    default:
      return undefined;
  }
};

const essHashAlgorithmIdentifier = (value: unknown): EssHashAlgorithm | undefined => {
  const fields = sequenceChildren(value);
  if (fields === undefined || fields.length < 1 || fields.length > 2) return undefined;
  const algorithm = fields[0];
  const parameters = fields[1];
  if (!(algorithm instanceof asn1js.ObjectIdentifier)) return undefined;
  if (parameters !== undefined && !(parameters instanceof asn1js.Null)) return undefined;
  return essHashAlgorithmFromOid(algorithm.valueBlock.toString());
};

const essCertIdV2Hash = (value: unknown): EssCertIdV2Hash | undefined => {
  const fields = sequenceChildren(value);
  if (fields === undefined || fields.length === 0 || fields.length > 3) return undefined;
  const defaultHash = octetStringBytes(fields[0]);
  if (defaultHash !== undefined) return { algorithm: "sha256", hash: defaultHash };
  const algorithm = essHashAlgorithmIdentifier(fields[0]);
  const hash = octetStringBytes(fields[1]);
  return algorithm === undefined || hash === undefined ? undefined : { algorithm, hash };
};

const timestampSigningCertificateAttribute = (
  signed: pkijs.SignedData,
): pkijs.Attribute | undefined => {
  const signedAttributes = signed.signerInfos[0]?.signedAttrs;
  if (signedAttributes === undefined || signedAttributes.type !== 0) return undefined;
  const contentTypeAttributes = signedAttributes.attributes.filter(
    (attribute) => attribute.type === CmsOid.contentType,
  );
  const messageDigestAttributes = signedAttributes.attributes.filter(
    (attribute) => attribute.type === CmsOid.messageDigest,
  );
  const contentType = contentTypeAttributes.length === 1 ? contentTypeAttributes[0] : undefined;
  const messageDigest =
    messageDigestAttributes.length === 1 ? messageDigestAttributes[0] : undefined;
  const contentTypeValue = contentType?.values[0];
  const parsedContentType =
    contentTypeValue === undefined
      ? undefined
      : asn1js.fromBER(contentTypeValue.toBER(false)).result;
  if (
    contentType === undefined ||
    contentType.values.length !== 1 ||
    !(parsedContentType instanceof asn1js.ObjectIdentifier) ||
    parsedContentType.valueBlock.toString() !== TSA_TST_INFO_CONTENT_TYPE ||
    messageDigest === undefined ||
    messageDigest.values.length !== 1
  ) {
    return undefined;
  }
  const messageDigestValue = messageDigest.values[0];
  const messageDigestBytes =
    messageDigestValue === undefined
      ? undefined
      : octetStringBytes(asn1js.fromBER(messageDigestValue.toBER(false)).result);
  if (messageDigestBytes === undefined || messageDigestBytes.byteLength === 0) return undefined;
  const signingCertificate = signedAttributes.attributes.filter(
    (attribute) =>
      attribute.type === TSA_SIGNING_CERTIFICATE_OID ||
      attribute.type === CmsOid.signingCertificateV2,
  );
  if (signingCertificate.length !== 1) return undefined;
  const attribute = signingCertificate[0];
  return attribute === undefined || attribute.values.length !== 1 ? undefined : attribute;
};

const isTimestampAuthorityCertificate = (certificate: pkijs.Certificate): boolean => {
  const extendedKeyUsage = certificate.extensions?.filter(
    (extension) => extension.extnID === TSA_EXTENDED_KEY_USAGE_OID,
  );
  const extendedKeyUsageExtension = extendedKeyUsage?.[0];
  const keyUsage = certificate.extensions?.filter(
    (extension) => extension.extnID === TSA_KEY_USAGE_OID,
  );
  const keyUsageExtension = keyUsage?.[0];
  const parsedKeyUsage =
    keyUsageExtension === undefined
      ? undefined
      : asn1js.fromBER(keyUsageExtension.extnValue.valueBlock.valueHexView).result;
  const keyUsagePermitsSigning =
    keyUsage === undefined ||
    keyUsage.length === 0 ||
    (keyUsage.length === 1 &&
      parsedKeyUsage instanceof asn1js.BitString &&
      ((parsedKeyUsage.valueBlock.valueHexView[0] ?? 0) & 0xc0) !== 0);
  return (
    extendedKeyUsage?.length === 1 &&
    extendedKeyUsageExtension?.critical === true &&
    extendedKeyUsageExtension.parsedValue instanceof pkijs.ExtKeyUsage &&
    extendedKeyUsageExtension.parsedValue.keyPurposes.length === 1 &&
    extendedKeyUsageExtension.parsedValue.keyPurposes[0] === TSA_TIMESTAMPING_KEY_PURPOSE_OID &&
    keyUsagePermitsSigning
  );
};

const signingCertificateMatches = (
  attribute: pkijs.Attribute,
  certificateDer: Uint8Array,
): Effect.Effect<boolean, CmsError> =>
  Effect.gen(function* () {
    const value = attribute.values[0];
    if (value === undefined) return false;
    const signingCertificate = sequenceChildren(asn1js.fromBER(value.toBER(false)).result);
    const certificateEntries =
      signingCertificate === undefined ? undefined : sequenceChildren(signingCertificate[0]);
    const certificateEntry = certificateEntries?.[0];
    if (certificateEntry === undefined) return false;
    if (attribute.type === TSA_SIGNING_CERTIFICATE_OID) {
      const certId = sequenceChildren(certificateEntry);
      const hash = certId === undefined ? undefined : octetStringBytes(certId[0]);
      if (hash === undefined) return false;
      const certificateHash = yield* digest("sha1", certificateDer);
      return bytesEqual(hash, certificateHash);
    }
    const hash = essCertIdV2Hash(certificateEntry);
    if (hash === undefined) return false;
    const certificateHash = yield* digest(hash.algorithm, certificateDer);
    return bytesEqual(hash.hash, certificateHash);
  });

const timestampNonce = (): Effect.Effect<Uint8Array<ArrayBuffer>, CmsError> =>
  Effect.try({
    try: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[0] = (bytes[0] ?? 0) & 0x7f;
      return bytes;
    },
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.timestampError,
        reason: "Failed to generate the RFC 3161 timestamp nonce.",
        operation: CmsOperationValue.timestamp,
      }),
  });

const RequestTimestampInputSchema = Schema.Struct({
  data: Schema.Uint8Array,
  tsaUrl: Schema.NonEmptyString,
  trustedRoots: Schema.NonEmptyArray(Schema.Uint8Array),
  hashAlgorithm: CmsHashAlgorithmSchema,
  timeoutMillis: Schema.optional(TimeoutMillisSchema),
});
type RequestTimestampInput = (typeof RequestTimestampInputSchema)["Type"];

const validateTimestampToken = Effect.fn(function* (
  token: pkijs.ContentInfo,
  signed: pkijs.SignedData,
  tstInfo: pkijs.TSTInfo,
  trustedCerts: pkijs.Certificate[],
) {
  if (
    token.contentType !== pkijs.ContentInfo.SIGNED_DATA ||
    signed.encapContentInfo.eContentType !== TSA_TST_INFO_CONTENT_TYPE ||
    signed.signerInfos.length !== 1 ||
    tstInfo.version !== 1 ||
    !Number.isFinite(tstInfo.genTime.getTime())
  ) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "TSA did not return a valid signed RFC 3161 timestamp token.",
      operation: CmsOperationValue.timestamp,
    });
  }

  const signingCertificateAttribute = timestampSigningCertificateAttribute(signed);
  if (signingCertificateAttribute === undefined) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "TSA timestamp token is missing required signed attributes.",
      operation: CmsOperationValue.timestamp,
    });
  }

  const verification = yield* Effect.tryPromise({
    try: () => {
      signed.encapContentInfo.eContentType = pkijs.ContentInfo.DATA;
      delete signed.crls;
      delete signed.ocsps;
      return signed.verify({
        signer: 0,
        checkDate: tstInfo.genTime,
        checkChain: true,
        trustedCerts,
        passedWhenNotRevValues: true,
        extendedMode: true,
      });
    },
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.timestampError,
        reason: "TSA timestamp token signature or certificate chain validation failed.",
        operation: CmsOperationValue.timestamp,
      }),
  });

  if (verification.signatureVerified !== true || verification.signerCertificateVerified !== true) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "TSA timestamp token signature or certificate chain is invalid.",
      operation: CmsOperationValue.timestamp,
    });
  }

  const signerCertificate = verification.signerCertificate;
  if (
    signerCertificate === null ||
    signerCertificate === undefined ||
    !isTimestampAuthorityCertificate(signerCertificate)
  ) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "TSA signer certificate is not a critical timestamping-only certificate.",
      operation: CmsOperationValue.timestamp,
    });
  }

  const signerCertificateDer = yield* Effect.try({
    try: () => new Uint8Array(signerCertificate.toSchema(true).toBER(false)),
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.timestampError,
        reason: "Failed to encode the TSA signer certificate.",
        operation: CmsOperationValue.timestamp,
      }),
  });
  const signingCertificateBound = yield* signingCertificateMatches(
    signingCertificateAttribute,
    signerCertificateDer,
  );
  if (!signingCertificateBound) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "TSA signing-certificate attribute does not bind the signer certificate.",
      operation: CmsOperationValue.timestamp,
    });
  }

  return tstInfo.genTime;
});

const verifyTimestampImprint = Effect.fn(function* (tstInfo: pkijs.TSTInfo, data: Uint8Array) {
  const algorithm = CmsHashAlgorithmSchema.literals.find(
    (hash) => hashAlgorithmOid(hash) === tstInfo.messageImprint.hashAlgorithm.algorithmId,
  );
  if (algorithm === undefined)
    return yield* new CmsError({
      code: CmsErrorCodeValue.unsupportedAlgorithm,
      reason: "The RFC 3161 message imprint algorithm is unsupported.",
      operation: CmsOperationValue.timestamp,
    });
  const imprint = yield* digest(algorithm, data);
  if (!bytesEqual(imprint, tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView)) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "TSA timestamp message imprint does not match the request.",
      operation: CmsOperationValue.timestamp,
    });
  }
});

const decodeTimestampToken = Effect.fn(function* (der: Uint8Array) {
  const parsed = yield* Effect.try({
    try: () => {
      const decoded = asn1js.fromBER(der, { maxDepth: 64, parseEmbedded: false });
      if (decoded.offset !== der.length) return undefined;
      const token = new pkijs.ContentInfo({ schema: decoded.result });
      if (token.contentType !== pkijs.ContentInfo.SIGNED_DATA) return undefined;
      const signed = new pkijs.SignedData({ schema: token.content });
      const content = signed.encapContentInfo.eContent;
      if (
        content === undefined ||
        signed.encapContentInfo.eContentType !== TSA_TST_INFO_CONTENT_TYPE
      ) {
        return undefined;
      }
      const tstInfoDer = new Uint8Array(content.getValue());
      const tstInfo = asn1js.fromBER(tstInfoDer, { maxDepth: 64, parseEmbedded: false });
      if (tstInfo.offset !== tstInfoDer.length) return undefined;
      return { token, signed, tstInfo: new pkijs.TSTInfo({ schema: tstInfo.result }) };
    },
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.timestampError,
        reason: "Failed to parse the RFC 3161 timestamp token.",
        operation: CmsOperationValue.timestamp,
      }),
  });
  if (parsed === undefined)
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "Expected a single RFC 3161 timestamp token with TSTInfo.",
      operation: CmsOperationValue.timestamp,
    });
  return parsed;
});

export const checkTimestampSha256Imprint = Effect.fn(function* (
  der: Uint8Array,
  imprint: Uint8Array,
) {
  const { tstInfo } = yield* decodeTimestampToken(der);
  if (
    tstInfo.messageImprint.hashAlgorithm.algorithmId !== hashAlgorithmOid("sha256") ||
    !bytesEqual(imprint, tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView)
  ) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "The timestamp token does not match the reserved PDF byte range.",
      operation: CmsOperationValue.timestamp,
    });
  }
});

export const verifyTimestampToken = Effect.fn(function* (
  der: Uint8Array,
  data: Uint8Array,
  roots: readonly Uint8Array[],
  at: Date,
) {
  const { token, signed, tstInfo } = yield* decodeTimestampToken(der);
  if (roots.length === 0 || tstInfo.genTime > at)
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason:
        "The RFC 3161 token requires explicit TSA roots and a generation time within the evaluation horizon.",
      operation: CmsOperationValue.timestamp,
    });
  const trustedCerts = yield* Effect.try({
    try: () => roots.map((root) => pkijs.Certificate.fromBER(new Uint8Array(root))),
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.timestampError,
        reason: "Failed to parse a TSA trusted root DER.",
        operation: CmsOperationValue.timestamp,
      }),
  });
  yield* verifyTimestampImprint(tstInfo, data);
  return yield* validateTimestampToken(token, signed, tstInfo, trustedCerts);
});

const TimestampImprintRequest = RequestTimestampInputSchema.mapFields(
  ({ data: _data, ...fields }) => ({
    ...fields,
    imprint: Schema.Uint8Array,
  }),
);
type TimestampImprintRequest = typeof TimestampImprintRequest.Type;

export const requestTimestampForImprint = Effect.fn(CmsOperationValue.timestamp)(function* (
  input: TimestampImprintRequest,
) {
  const valid = yield* Schema.decodeUnknownEffect(TimestampImprintRequest)(input).pipe(
    Effect.mapError(
      (issue) =>
        new CmsError({
          code: CmsErrorCodeValue.timestampError,
          reason: `Invalid RFC 3161 timestamp input: ${String(issue)}`,
          operation: CmsOperationValue.timestamp,
        }),
    ),
  );
  const lengths = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  if (valid.imprint.length !== lengths[valid.hashAlgorithm])
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "The imprint length does not match its hash algorithm.",
      operation: CmsOperationValue.timestamp,
    });
  const trustedCerts = yield* Effect.try({
    try: () => valid.trustedRoots.map((der) => pkijs.Certificate.fromBER(new Uint8Array(der))),
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.timestampError,
        reason: "Failed to parse a TSA trusted root DER.",
        operation: CmsOperationValue.timestamp,
      }),
  });
  const random = yield* timestampNonce();
  const nonce = new asn1js.Integer({ valueHex: random.buffer }).convertToDER();
  const requestDer = yield* Effect.try({
    try: () =>
      new Uint8Array(
        new pkijs.TimeStampReq({
          version: 1,
          messageImprint: new pkijs.MessageImprint({
            hashAlgorithm: new pkijs.AlgorithmIdentifier({
              algorithmId: hashAlgorithmOid(valid.hashAlgorithm),
            }),
            hashedMessage: new asn1js.OctetString({
              valueHex: new Uint8Array(valid.imprint).buffer,
            }),
          }),
          nonce,
          certReq: true,
        })
          .toSchema()
          .toBER(false),
      ),
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.timestampError,
        reason: "Failed to encode the RFC 3161 request.",
        operation: CmsOperationValue.timestamp,
      }),
  });
  const fetcher = yield* Effect.serviceOption(EvidenceFetcher);
  if (Option.isNone(fetcher))
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "An explicit evidence fetcher is required to request an RFC 3161 timestamp.",
      operation: CmsOperationValue.timestamp,
    });
  const diagnosticUrl = diagnosticTimestampUrl(valid.tsaUrl);
  const response = yield* fetcher.value
    .timestamp(valid.tsaUrl, requestDer, valid.timeoutMillis)
    .pipe(
      Effect.mapError(
        ({ code, status }) =>
          new CmsError({
            code: CmsErrorCodeValue.timestampError,
            reason:
              code === "timeout"
                ? `TSA request to ${diagnosticUrl} timed out.`
                : status === undefined
                  ? `TSA request to ${diagnosticUrl} failed.`
                  : `TSA request to ${diagnosticUrl} failed with HTTP ${status}.`,
            operation: CmsOperationValue.timestamp,
          }),
      ),
    );
  const decoded = asn1js.fromBER(response, { maxDepth: 64, parseEmbedded: false });
  if (decoded.offset !== response.length)
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "TSA response contains trailing bytes or malformed DER.",
      operation: CmsOperationValue.timestamp,
    });
  const envelope = yield* Effect.try({
    try: () => new pkijs.TimeStampResp({ schema: decoded.result }),
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.timestampError,
        reason: "Failed to parse the TSA response.",
        operation: CmsOperationValue.timestamp,
      }),
  });
  const status = envelope.status.status;
  if (status !== pkijs.PKIStatus.granted && status !== pkijs.PKIStatus.grantedWithMods) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: `TSA did not grant a timestamp token; PKIStatus=${status}.`,
      operation: CmsOperationValue.timestamp,
    });
  }
  if (envelope.timeStampToken === undefined)
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "TSA response contains no timestamp token.",
      operation: CmsOperationValue.timestamp,
    });
  const der = new Uint8Array(envelope.timeStampToken.toSchema().toBER(false));
  const { token, signed, tstInfo } = yield* decodeTimestampToken(der);
  if (tstInfo.nonce === undefined || !tstInfo.nonce.isEqual(nonce))
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "TSA timestamp nonce does not match the request.",
      operation: CmsOperationValue.timestamp,
    });
  if (
    tstInfo.messageImprint.hashAlgorithm.algorithmId !== hashAlgorithmOid(valid.hashAlgorithm) ||
    !bytesEqual(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView, valid.imprint)
  ) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.timestampError,
      reason: "TSA timestamp message imprint does not match the request.",
      operation: CmsOperationValue.timestamp,
    });
  }
  yield* validateTimestampToken(token, signed, tstInfo, trustedCerts);
  return der;
});

export const requestTimestamp = Effect.fn(function* (input: RequestTimestampInput) {
  const { data, ...valid } = yield* Schema.decodeUnknownEffect(RequestTimestampInputSchema)(
    input,
  ).pipe(
    Effect.mapError(
      (issue) =>
        new CmsError({
          code: CmsErrorCodeValue.timestampError,
          reason: `Invalid RFC 3161 timestamp input: ${String(issue)}`,
          operation: CmsOperationValue.timestamp,
        }),
    ),
  );
  const imprint = yield* digest(valid.hashAlgorithm, data);
  return yield* requestTimestampForImprint({ ...valid, imprint });
});
