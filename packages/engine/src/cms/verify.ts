import * as asn1js from "asn1js";
import { Effect, Option, Schema } from "effect";
import * as pkijs from "pkijs";
import { Hex } from "effect/encoding";
import { embeddedRevocation } from "../validation/revocation.js";
import {
  VerifyDetachedSignedDataEvidenceInputSchema,
  CmsError,
  CmsErrorCodeValue,
  CmsOid,
  CmsOperationValue,
} from "./config.js";
import type {
  CmsVerifyResult,
  VerifyDetachedSignedDataEvidenceInput,
  VerifyDetachedSignedDataInput,
} from "./config.js";

const isUint8Array = (value: unknown): value is Uint8Array =>
  Object.prototype.toString.call(value) === "[object Uint8Array]";

const SignedDataVerifyErrorSchema = Schema.Struct({
  name: Schema.Literals(["SignedDataVerifyError"]),
  code: Schema.Finite,
  signatureVerified: Schema.optional(Schema.NullOr(Schema.Boolean)),
  signerCertificateVerified: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const signerSerialHex = (signed: pkijs.SignedData): string | null => {
  const sid = signed.signerInfos[0]?.sid;
  if (sid === null || typeof sid !== "object") return null;
  const serial = "serialNumber" in sid ? sid.serialNumber : null;
  if (serial === null || typeof serial !== "object") return null;
  const valueBlock = "valueBlock" in serial ? serial.valueBlock : null;
  if (valueBlock === null || typeof valueBlock !== "object") return null;
  const view = "valueHexView" in valueBlock ? valueBlock.valueHexView : null;
  if (!isUint8Array(view)) return null;
  return Hex.encode(view);
};

const verifySignedData = Effect.fn(CmsOperationValue.verify)(function* (
  input: VerifyDetachedSignedDataEvidenceInput,
  checkRevocation: boolean,
) {
  const valid = yield* Schema.decodeUnknownEffect(VerifyDetachedSignedDataEvidenceInputSchema)(
    input,
  ).pipe(
    Effect.mapError(
      (issue) =>
        new CmsError({
          code: CmsErrorCodeValue.verifyError,
          reason: `Invalid CMS verification input: ${String(issue)}`,
          operation: CmsOperationValue.verify,
        }),
    ),
  );

  const contentInfo = yield* Effect.try({
    try: () => pkijs.ContentInfo.fromBER(new Uint8Array(valid.cms).buffer),
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.decodeError,
        reason: "Failed to parse the CMS ContentInfo.",
        operation: CmsOperationValue.verify,
      }),
  });
  if (contentInfo.contentType !== CmsOid.signedData) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.decodeError,
      reason: "CMS ContentInfo is not signedData.",
      operation: CmsOperationValue.verify,
    });
  }

  const signed = yield* Effect.try({
    try: () => new pkijs.SignedData({ schema: contentInfo.content }),
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.decodeError,
        reason: "Failed to parse the CMS SignedData.",
        operation: CmsOperationValue.verify,
      }),
  });
  if (signed.signerInfos.length !== 1) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.decodeError,
      reason: "CMS SignedData must contain exactly one SignerInfo.",
      operation: CmsOperationValue.verify,
    });
  }

  if (signed.encapContentInfo.eContentType !== CmsOid.data) {
    return yield* new CmsError({
      code: CmsErrorCodeValue.decodeError,
      reason: "CMS SignedData eContentType is not id-data.",
      operation: CmsOperationValue.verify,
    });
  }
  if (signed.encapContentInfo.eContent !== undefined) {
    return {
      result: {
        valid: false,
        chainValid: false,
        revocationStatus: "not_checked",
        signerSerialNumber: signerSerialHex(signed),
      } satisfies CmsVerifyResult,
      revocation: { ocsp: [], crls: [] },
      certificatePath: [],
      claimedSigningTime: undefined,
      timestampTokens: [],
      signatureValue: undefined,
    };
  }

  const trustedCerts = yield* Effect.try({
    try: () =>
      (valid.trustedRoots ?? []).map((der) =>
        pkijs.Certificate.fromBER(new Uint8Array(der).buffer),
      ),
    catch: () =>
      new CmsError({
        code: CmsErrorCodeValue.decodeError,
        reason: "Failed to parse a trusted root DER.",
        operation: CmsOperationValue.verify,
      }),
  });

  if (valid.certificates !== undefined && valid.certificates.length > 0) {
    const certificates = yield* Effect.forEach(valid.certificates, (der) =>
      Effect.try({
        try: () => pkijs.Certificate.fromBER(new Uint8Array(der)),
        catch: () =>
          new CmsError({
            code: CmsErrorCodeValue.decodeError,
            reason: "Failed to parse a DSS certificate DER.",
            operation: CmsOperationValue.verify,
          }),
      }).pipe(Effect.option),
    );
    signed.certificates = [...(signed.certificates ?? []), ...certificates.flatMap(Option.toArray)];
  }
  const serial = signerSerialHex(signed);
  const checkChain = trustedCerts.length > 0;
  yield* Effect.annotateCurrentSpan({
    "signature_kit.cms.bytes": valid.cms.byteLength,
    "signature_kit.cms.content_bytes": valid.content.byteLength,
    "signature_kit.cms.certificate_count": signed.certificates?.length ?? 0,
    "signature_kit.cms.trusted_root_count": trustedCerts.length,
    "signature_kit.cms.chain_checked": checkChain,
  });

  const revocation = embeddedRevocation(signed);
  const signer = signed.signerInfos[0];
  const times = signer?.signedAttrs?.attributes.filter(({ type }) => type === CmsOid.signingTime);
  const time =
    times?.length === 1 && times[0]?.values.length === 1 ? times[0].values[0] : undefined;
  const date =
    time instanceof asn1js.UTCTime || time instanceof asn1js.GeneralizedTime
      ? time.toDate()
      : undefined;
  const claimedSigningTime =
    date !== undefined && Number.isFinite(date.getTime()) ? date : undefined;
  const timestampTokens = (signer?.unsignedAttrs?.attributes ?? [])
    .filter(({ type }) => type === CmsOid.timeStampToken)
    .flatMap(({ values }) => values.map((value) => new Uint8Array(value.toBER(false))));
  if (!checkRevocation) {
    delete signed.crls;
    delete signed.ocsps;
  }
  const verification = yield* Effect.promise(() =>
    signed.verify({
      signer: 0,
      data: new Uint8Array(valid.content).buffer,
      checkChain,
      ...(valid.at === undefined ? {} : { checkDate: valid.at }),
      trustedCerts,
      passedWhenNotRevValues: false,
      extendedMode: true,
    }),
  ).pipe(
    Effect.catchDefect((cause) =>
      Schema.decodeUnknownEffect(SignedDataVerifyErrorSchema)(cause).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.die(cause),
          onSuccess: (error) =>
            Effect.succeed({
              certificatePath: [],
              signatureVerified: error.signatureVerified === true,
              signerCertificateVerified: error.signerCertificateVerified === true,
            }),
        }),
      ),
    ),
  );

  const result: CmsVerifyResult = {
    valid: verification.signatureVerified === true,
    chainValid: checkChain ? verification.signerCertificateVerified === true : false,
    revocationStatus:
      checkChain && checkRevocation && revocation.ocsp.length + revocation.crls.length > 0
        ? "checked"
        : "not_checked",
    signerSerialNumber: serial,
  };
  yield* Effect.annotateCurrentSpan({
    "signature_kit.cms.valid": result.valid,
    "signature_kit.cms.chain_valid": result.chainValid,
    "signature_kit.cms.revocation_status": result.revocationStatus,
  });
  return {
    result,
    revocation,
    certificatePath: result.chainValid ? verification.certificatePath : [],
    claimedSigningTime,
    timestampTokens,
    signatureValue: signer?.signature.valueBlock.valueHexView,
  };
});

export const verifyDetachedSignedDataEvidence = (input: VerifyDetachedSignedDataEvidenceInput) =>
  verifySignedData(input, false);

export const verifyDetachedSignedData = (
  input: VerifyDetachedSignedDataInput,
): Effect.Effect<CmsVerifyResult, CmsError> =>
  verifySignedData(input, true).pipe(Effect.map(({ result }) => result));
