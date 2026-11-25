import * as asn1 from "asn1js";
import { Effect, Result } from "effect";
import * as pki from "pkijs";
import { CmsHashAlgorithmSchema, hashAlgorithmOid } from "../cms/config.js";
import { digest } from "../cms/engine.js";
import { RevocationError } from "./config.js";
import type { RevocationReason, RevocationReport, RevocationVerdict } from "./config.js";

const ocspType = "1.3.6.1.5.5.7.48.1.1";
const ocspSigning = "1.3.6.1.5.5.7.3.9";
const archivalType = "1.2.840.113583.1.1.8";

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const dateInWindow = (at: Date, start: Date, end: Date | undefined) =>
  end !== undefined && start.getTime() <= at.getTime() && at.getTime() <= end.getTime();

const permitsUsage = (certificate: pki.Certificate, bit: number) => {
  const usage = certificate.extensions?.find(({ extnID }) => extnID === "2.5.29.15");
  if (usage === undefined) return true;
  const parsed = asn1.fromBER(usage.extnValue.valueBlock.valueHexView);
  return (
    parsed.result instanceof asn1.BitString &&
    ((parsed.result.valueBlock.valueHexView[0] ?? 0) & bit) !== 0
  );
};

export const embeddedRevocation = (signed: pki.SignedData) => {
  const ocsp: Uint8Array[] = (signed.ocsps ?? []).map(
    (entry) => new Uint8Array(entry.toSchema().toBER(false)),
  );
  const crls: Uint8Array[] = [];
  for (const entry of signed.crls ?? []) {
    if (entry instanceof pki.CertificateRevocationList) {
      crls.push(new Uint8Array(entry.toSchema().toBER(false)));
    } else if (entry.otherRevInfoFormat === ocspType) {
      ocsp.push(new Uint8Array(entry.otherRevInfo.toBER(false)));
    }
  }
  for (const attribute of [
    ...(signed.signerInfos[0]?.signedAttrs?.attributes ?? []),
    ...(signed.signerInfos[0]?.unsignedAttrs?.attributes ?? []),
  ]) {
    if (attribute.type !== archivalType) continue;
    for (const value of attribute.values) {
      const parsed = asn1.fromBER(value.toBER(false), {
        maxDepth: 64,
        parseEmbedded: false,
      }).result;
      if (!(parsed instanceof asn1.Sequence)) continue;
      for (const field of parsed.valueBlock.value) {
        if (!(field instanceof asn1.Constructed) || field.idBlock.tagClass !== 3) continue;
        const [sequence] = field.valueBlock.value;
        if (!(sequence instanceof asn1.Sequence)) continue;
        const entries = sequence.valueBlock.value.map((item) => new Uint8Array(item.toBER(false)));
        if (field.idBlock.tagNumber === 0) crls.push(...entries);
        if (field.idBlock.tagNumber === 1) ocsp.push(...entries);
      }
    }
  }
  return { ocsp, crls };
};

const verifyOcsp = Effect.fn(function* (
  bytes: Uint8Array,
  signer: pki.Certificate,
  issuer: pki.Certificate,
  at: Date,
): Effect.fn.Return<typeof RevocationVerdict.Type, RevocationError> {
  const response = yield* Effect.try({
    try: () => {
      const parsed = asn1.fromBER(bytes, { maxDepth: 64, parseEmbedded: false });
      if (parsed.offset !== bytes.length || !(parsed.result instanceof asn1.Sequence))
        return undefined;
      if (parsed.result.valueBlock.value[0] instanceof asn1.Enumerated) {
        const envelope = new pki.OCSPResponse({ schema: parsed.result });
        if (
          envelope.responseStatus.valueBlock.valueDec !== 0 ||
          envelope.responseBytes?.responseType !== ocspType
        )
          return undefined;
        const body = envelope.responseBytes.response.valueBlock.valueHexView;
        const basic = asn1.fromBER(body, { maxDepth: 64, parseEmbedded: false });
        return basic.offset === body.length
          ? new pki.BasicOCSPResponse({ schema: basic.result })
          : undefined;
      }
      return new pki.BasicOCSPResponse({ schema: parsed.result });
    },
    catch: () => new RevocationError({ code: "malformedEvidence" }),
  });
  if (response === undefined) return yield* new RevocationError({ code: "malformedEvidence" });

  const { producedAt, responderID, responses, responseExtensions } = response.tbsResponseData;
  if (responseExtensions?.some(({ critical }) => critical) === true) {
    return yield* new RevocationError({ code: "unsupportedScope" });
  }
  const matching = [];
  for (const single of responses) {
    const id = single.certID;
    if (!id.serialNumber.isEqual(signer.serialNumber)) continue;
    const algorithm = CmsHashAlgorithmSchema.literals.find(
      (hash) => hashAlgorithmOid(hash) === id.hashAlgorithm.algorithmId,
    );
    if (algorithm === undefined) continue;
    const hashes = yield* Effect.all([
      digest(algorithm, new Uint8Array(signer.issuer.toSchema().toBER(false))),
      digest(algorithm, issuer.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView),
    ]).pipe(Effect.mapError(() => new RevocationError({ code: "unsupportedScope" })));
    if (
      sameBytes(hashes[0], id.issuerNameHash.valueBlock.valueHexView) &&
      sameBytes(hashes[1], id.issuerKeyHash.valueBlock.valueHexView)
    )
      matching.push(single);
  }
  const single = matching[0];
  if (single === undefined) return yield* new RevocationError({ code: "certificateMismatch" });
  if (matching.length !== 1 || single.singleExtensions?.some(({ critical }) => critical) === true) {
    return yield* new RevocationError({ code: "unsupportedScope" });
  }
  if (
    !dateInWindow(at, single.thisUpdate, single.nextUpdate) ||
    !dateInWindow(producedAt, single.thisUpdate, single.nextUpdate)
  ) {
    return yield* new RevocationError({ code: "outsideValidity" });
  }

  let authorizedResponder = false;
  let authentic = false;
  for (const candidate of [issuer, ...(response.certs ?? [])]) {
    const key = candidate.subjectPublicKeyInfo;
    const keyHash =
      responderID instanceof asn1.OctetString
        ? yield* digest("sha1", key.subjectPublicKey.valueBlock.valueHexView).pipe(
            Effect.mapError(() => new RevocationError({ code: "unsupportedScope" })),
          )
        : undefined;
    const matches =
      responderID instanceof pki.RelativeDistinguishedNames
        ? candidate.subject.isEqual(responderID)
        : responderID instanceof asn1.OctetString &&
          keyHash !== undefined &&
          sameBytes(keyHash, responderID.valueBlock.valueHexView);
    if (
      !matches ||
      !dateInWindow(producedAt, candidate.notBefore.value, candidate.notAfter.value) ||
      !permitsUsage(candidate, 0x80)
    )
      continue;
    if (candidate !== issuer) {
      const usage = candidate.extensions?.find(({ extnID }) => extnID === "2.5.29.37")?.parsedValue;
      if (
        !(usage instanceof pki.ExtKeyUsage) ||
        !usage.keyPurposes.includes(ocspSigning) ||
        !candidate.issuer.isEqual(issuer.subject)
      )
        continue;
      const delegated = yield* Effect.tryPromise({
        try: () => candidate.verify(issuer),
        catch: () => new RevocationError({ code: "unauthorizedResponder" }),
      }).pipe(Effect.orElseSucceed(() => false));
      if (!delegated) continue;
    }
    authorizedResponder = true;
    authentic = yield* Effect.tryPromise({
      try: () =>
        pki
          .getCrypto(true)
          .verifyWithPublicKey(
            new Uint8Array(response.tbsResponseData.tbsView),
            response.signature,
            key,
            response.signatureAlgorithm,
          ),
      catch: () => new RevocationError({ code: "invalidSignature" }),
    }).pipe(Effect.orElseSucceed(() => false));
    if (authentic) break;
  }
  if (!authentic)
    return yield* new RevocationError({
      code: authorizedResponder ? "invalidSignature" : "unauthorizedResponder",
    });

  const status: unknown = single.certStatus;
  if (
    status instanceof asn1.Primitive &&
    status.idBlock.tagClass === 3 &&
    status.valueBlock.valueHexView.length === 0
  ) {
    if (status.idBlock.tagNumber === 0) return { status: "good" };
    if (status.idBlock.tagNumber === 2) return { status: "unknown" };
  }
  if (
    status instanceof asn1.Constructed &&
    status.idBlock.tagClass === 3 &&
    status.idBlock.tagNumber === 1
  ) {
    const [time, entry] = status.valueBlock.value;
    if (time instanceof asn1.GeneralizedTime) {
      const revokedAt = time.toDate();
      if (!Number.isFinite(revokedAt.getTime()) || revokedAt > producedAt) {
        return yield* new RevocationError({ code: "malformedEvidence" });
      }
      if (revokedAt > at) return { status: "unknown" };
      const reason = entry instanceof asn1.Constructed ? entry.valueBlock.value[0] : undefined;
      return {
        status: "revoked",
        at: revokedAt,
        reason: reason instanceof asn1.Enumerated ? reason.valueBlock.valueDec : undefined,
      };
    }
  }
  return yield* new RevocationError({ code: "malformedEvidence" });
});

const verifyCrl = Effect.fn(function* (
  bytes: Uint8Array,
  signer: pki.Certificate,
  issuer: pki.Certificate,
  at: Date,
): Effect.fn.Return<typeof RevocationVerdict.Type, RevocationError> {
  const parsed = asn1.fromBER(bytes, { maxDepth: 64, parseEmbedded: false });
  if (parsed.offset !== bytes.length)
    return yield* new RevocationError({ code: "malformedEvidence" });
  const crl = yield* Effect.try({
    try: () => new pki.CertificateRevocationList({ schema: parsed.result }),
    catch: () => new RevocationError({ code: "malformedEvidence" }),
  });
  if (!crl.issuer.isEqual(issuer.subject))
    return yield* new RevocationError({ code: "certificateMismatch" });
  if (!dateInWindow(at, crl.thisUpdate.value, crl.nextUpdate?.value)) {
    return yield* new RevocationError({ code: "outsideValidity" });
  }
  if (
    crl.crlExtensions?.extensions.some(
      ({ extnID, critical }) => critical || extnID === "2.5.29.27" || extnID === "2.5.29.28",
    ) === true ||
    crl.revokedCertificates?.some(
      ({ crlEntryExtensions }) =>
        crlEntryExtensions?.extensions.some(
          ({ extnID, critical }) => critical || extnID === "2.5.29.29",
        ) === true,
    ) === true
  )
    return yield* new RevocationError({ code: "unsupportedScope" });
  if (!permitsUsage(issuer, 0x02))
    return yield* new RevocationError({ code: "unauthorizedResponder" });
  const authentic = yield* Effect.tryPromise({
    try: () => crl.verify({ issuerCertificate: issuer }),
    catch: () => new RevocationError({ code: "invalidSignature" }),
  });
  if (!authentic) return yield* new RevocationError({ code: "invalidSignature" });
  const revoked = crl.revokedCertificates?.find(({ userCertificate }) =>
    userCertificate.isEqual(signer.serialNumber),
  );
  if (revoked === undefined) return { status: "good" };
  const reason = revoked.crlEntryExtensions?.extensions.find(
    ({ extnID }) => extnID === "2.5.29.21",
  );
  const parsedReason =
    reason === undefined
      ? undefined
      : asn1.fromBER(reason.extnValue.valueBlock.valueHexView).result;
  const revokedAt = revoked.revocationDate.value;
  if (!Number.isFinite(revokedAt.getTime()) || revokedAt > crl.thisUpdate.value) {
    return yield* new RevocationError({ code: "malformedEvidence" });
  }
  if (
    revokedAt > at ||
    (parsedReason instanceof asn1.Enumerated && parsedReason.valueBlock.valueDec === 8)
  ) {
    return { status: "unknown" };
  }
  return {
    status: "revoked",
    at: revokedAt,
    reason: parsedReason instanceof asn1.Enumerated ? parsedReason.valueBlock.valueDec : undefined,
  };
});

export const evaluateRevocation = Effect.fn(function* (
  evidence: ReturnType<typeof embeddedRevocation>,
  path: readonly pki.Certificate[],
  at: Date,
): Effect.fn.Return<RevocationReport> {
  const { ocsp, crls } = evidence;
  if (ocsp.length + crls.length === 0) return { kind: "notChecked" };
  const [signer, issuer] = path;
  if (signer === undefined || issuer === undefined) {
    return {
      kind: "embeddedEvidence",
      ocspCount: ocsp.length,
      crlCount: crls.length,
      reasons: ["untrustedIssuer"],
    };
  }
  const reasons = new Set<typeof RevocationReason.Type>();
  let verified: Extract<RevocationReport, { kind: "verified" }> | undefined;
  for (const [source, entries, verify] of [
    ["ocsp", ocsp, verifyOcsp],
    ["crl", crls, verifyCrl],
  ] satisfies ReadonlyArray<readonly ["ocsp" | "crl", Uint8Array[], typeof verifyOcsp]>) {
    for (const entry of entries) {
      const verdict = yield* Effect.result(verify(entry, signer, issuer, at));
      if (Result.isFailure(verdict)) reasons.add(verdict.failure.code);
      else {
        const result = verdict.success;
        if (result.status === "revoked") return { kind: "verified", source, result };
        if (
          verified === undefined ||
          (verified.result.status === "unknown" && result.status === "good")
        ) {
          verified = { kind: "verified", source, result };
        }
      }
    }
  }
  return (
    verified ?? {
      kind: "embeddedEvidence",
      ocspCount: ocsp.length,
      crlCount: crls.length,
      reasons: [...reasons],
    }
  );
});
