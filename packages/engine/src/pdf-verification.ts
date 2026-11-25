import { verifyTimestampToken } from "./cms/timestamp.js";
import { evaluateRevocation } from "./validation/revocation.js";
import { inspectDetachedSignedData, unpadSignedData } from "./cms/inspect.js";
import { verifyDetachedSignedDataEvidence } from "./cms/verify.js";
import type { PdfCoreSigningSession } from "./wasm/pdf-core.js";
import type { PdfCoreRevisionChanges } from "./wasm/config.js";
import { Clock, Effect, Option, Schema } from "effect";
import { icpBrasilIdentity } from "./a1-certificate.js";
import { parseX509 } from "./certificates/certificate.js";
import { decodeSignatureContents, signatureContents, signedBytes } from "./pdf-contents.js";
import { LocalError, PdfVerifyOptionsSchema } from "./rpc.js";
import type {
  ComparisonReport,
  PdfLtvLevel,
  PdfSignatureVerification,
  PdfVerificationReport,
  PdfVerifyOptions,
} from "./rpc.js";

const countObjects = (changes: PdfCoreRevisionChanges["changes"]) =>
  new Set(changes.map(({ ref }) => ref.number)).size;

const reportChanges = ({ changes, pageContentChanged }: PdfCoreRevisionChanges) => {
  const recognised = changes.filter(({ kind }) => kind !== "unknown");
  const unknown = changes.filter(({ kind }) => kind === "unknown");
  return {
    recognised,
    unknown,
    recognisedObjectCount: countObjects(recognised),
    unknownObjectCount: countObjects(unknown),
    pageContentChanged,
  };
};

const signingChanges = new Set(["signature", "signatureField", "widgetAppearance", "acroForm"]);

const reportPolicy = (
  policy: PdfCoreRevisionChanges["policies"][number],
  { changes, pageContentChanged }: PdfCoreRevisionChanges,
): PdfSignatureVerification["mdp"] => {
  const { docMdp, fieldLocks } = policy;
  if (docMdp === undefined && fieldLocks.length === 0) return undefined;
  const permittedChanges = [];
  const violations = [];
  const signingEnds = new Set(
    changes
      .filter(
        ({ kind, change, fieldNames }) =>
          kind === "signature" && change === "added" && fieldNames.length > 0,
      )
      .map(({ revisionEnd }) => revisionEnd),
  );
  const timestampEnds = new Set(
    changes
      .filter(({ kind, change }) => kind === "docTimeStamp" && change === "added")
      .map(({ revisionEnd }) => revisionEnd),
  );
  for (const change of changes) {
    const { kind, fieldNames, revisionEnd } = change;
    const preservation =
      change.change !== "removed" &&
      (kind === "dss" ||
        ((kind === "docTimeStamp" || signingChanges.has(kind)) && timestampEnds.has(revisionEnd)));
    if (preservation) {
      permittedChanges.push(change);
      continue;
    }
    const fieldViolation = fieldLocks.some(({ action, fields }) =>
      fieldNames.some((name) => {
        const listed = fields.some((field) => name === field || name.startsWith(`${field}.`));
        if (action === "Include") return fields.length === 0 || listed;
        if (action === "Exclude") return !listed;
        return true;
      }),
    );
    const docPermits =
      docMdp === undefined ||
      (docMdp > 1 &&
        ((kind === "formValue" && change.change === "modified") ||
          (kind === "widgetAppearance" && fieldNames.length > 0 && change.change !== "removed") ||
          (signingChanges.has(kind) &&
            signingEnds.has(revisionEnd) &&
            change.change !== "removed") ||
          (docMdp === 3 && kind === "annotation")));
    if (fieldViolation || !docPermits) violations.push(change);
    else permittedChanges.push(change);
  }
  return {
    docMdp,
    fieldLocks,
    permittedChanges,
    violations,
    pageContentViolation: docMdp !== undefined && pageContentChanged,
  };
};

const readTimestamp = Effect.fn(function* (
  tokens: readonly Uint8Array[],
  data: Uint8Array,
  roots: readonly Uint8Array[],
  at: Date,
): Effect.fn.Return<PdfSignatureVerification["timestampEvidence"]> {
  if (tokens.length === 0) return { kind: "absent" };
  if (roots.length === 0) return { kind: "unverified", reason: "tsaTrustMissing" };
  const times = yield* Effect.forEach(tokens, (token) =>
    verifyTimestampToken(token, data, roots, at).pipe(Effect.option),
  );
  const genTime = times.flatMap(Option.toArray).sort((a, b) => a.getTime() - b.getTime())[0];
  return genTime === undefined
    ? { kind: "unverified", reason: "invalidToken" }
    : { kind: "verified", genTime };
});

const readVerification = Effect.fn("local.pdf.verify")(function* (
  signing: PdfCoreSigningSession,
  pdf: Uint8Array,
  input: PdfVerifyOptions = {},
): Effect.fn.Return<
  PdfVerificationReport & {
    readonly revisions: readonly number[];
  },
  LocalError
> {
  const options = yield* Schema.decodeUnknownEffect(PdfVerifyOptionsSchema)(input).pipe(
    Effect.mapError(() => new LocalError({ code: "pdfReadFailed" })),
  );
  const at = options.at ?? new Date(yield* Clock.currentTimeMillis);
  const evaluationTime = {
    at,
    source: options.at === undefined ? "clock" : "caller",
  } satisfies PdfSignatureVerification["evaluationTime"];
  const tsaTrust = options.tsaTrust ?? [];
  const roots = (options.trust?.length ?? 0) > 0 ? options.trust : undefined;
  yield* Effect.annotateCurrentSpan("byteLength", pdf.byteLength);
  const report = yield* signing
    .signatures("verification")
    .pipe(Effect.mapError(() => new LocalError({ code: "pdfReadFailed" })));
  if (report.failure !== undefined && report.failure !== "invalidByteRange") {
    return yield* new LocalError({ code: "pdfReadFailed" });
  }
  const fields = yield* signing.fields.pipe(
    Effect.mapError(() => new LocalError({ code: "pdfReadFailed" })),
  );
  const dss = yield* signing.validationData.pipe(Effect.option);
  const validationData = Option.getOrUndefined(dss);
  const documentTimestamps = yield* Effect.forEach(
    report.dictionaries.filter(({ kind }) => kind === "documentTimestamp"),
    (dictionary) =>
      Effect.gen(function* () {
        const range = dictionary.byteRangeValues;
        if (range === undefined || range[0] !== 0 || dictionary.subFilter !== "ETSI.RFC3161") {
          return undefined;
        }
        const changes = yield* signing.changes(range[2] + range[3]).pipe(Effect.option);
        if (Option.isNone(changes)) return undefined;
        const token = yield* signatureContents(pdf, dictionary).pipe(
          Effect.flatMap(decodeSignatureContents),
          Effect.flatMap(unpadSignedData),
          Effect.option,
        );
        if (Option.isNone(token)) return undefined;
        return {
          offset: range[1],
          revisionEnd: range[2] + range[3],
          timestampEvidence: yield* readTimestamp(
            [token.value],
            signedBytes(pdf, range),
            tsaTrust,
            at,
          ),
        };
      }),
  );
  const signatures = yield* Effect.forEach(
    report.dictionaries,
    (dictionary): Effect.Effect<PdfSignatureVerification> =>
      Effect.gen(function* () {
        const range = dictionary.byteRangeValues;
        const field =
          range === undefined
            ? undefined
            : fields.fields.find(({ signature }) =>
                signature?.byteRange?.every((value, index) => value === range[index]),
              );
        const initial = {
          fieldName: field?.name,
          kind: dictionary.kind,
          integrity: "invalid",
          coverage: { kind: "invalid" },
          trust: roots === undefined ? "notEvaluated" : "untrusted",
          revocation: { kind: "notChecked" },
          timestampEvidence:
            dictionary.kind === "documentTimestamp"
              ? { kind: "unverified", reason: "invalidToken" }
              : { kind: "absent" },
          evaluationTime,
        } satisfies PdfSignatureVerification;
        if (range === undefined) return initial;
        const revisionEnd = range[2] + range[3];
        const contents = yield* signatureContents(pdf, dictionary).pipe(Effect.option);
        if (Option.isNone(contents) || range[0] !== 0) return initial;
        const changes = yield* signing.changes(revisionEnd).pipe(Effect.option);
        if (Option.isNone(changes)) return initial;
        const policy = changes.value.policies.find(({ byteRange }) =>
          byteRange.every((value, index) => value === range[index]),
        );
        const covered = {
          ...initial,
          coverage: {
            kind: revisionEnd === pdf.byteLength ? "wholeFile" : "partial",
            revisionEnd,
            bytesAfter: pdf.byteLength - revisionEnd,
          },
          changes: reportChanges(changes.value),
          fieldName: policy?.fieldName ?? initial.fieldName,
          mdp: policy === undefined ? undefined : reportPolicy(policy, changes.value),
        } satisfies PdfSignatureVerification;
        if (dictionary.kind === "documentTimestamp") {
          const timestamp = documentTimestamps.find((entry) => entry?.offset === range[1]);
          const evidence = timestamp?.timestampEvidence;
          if (evidence === undefined) return covered;
          if (evidence.kind === "verified")
            return {
              ...covered,
              integrity: "valid",
              trust: "trusted",
              timestampEvidence: evidence,
              evaluationTime: { at: evidence.genTime, source: "documentTimestamp" },
            };
          return {
            ...covered,
            timestampEvidence: evidence,
            trust: tsaTrust.length === 0 ? "notEvaluated" : "untrusted",
            integrity:
              evidence.kind === "unverified" && evidence.reason === "tsaTrustMissing"
                ? "unsupported"
                : "invalid",
          };
        }
        if (
          dictionary.subFilter !== "ETSI.CAdES.detached" &&
          dictionary.subFilter !== "adbe.pkcs7.detached"
        ) {
          return { ...covered, integrity: "unsupported" };
        }

        const der = yield* decodeSignatureContents(contents.value).pipe(
          Effect.flatMap(unpadSignedData),
          Effect.option,
        );
        if (Option.isNone(der)) return covered;
        const cms = {
          cms: der.value,
          content: signedBytes(pdf, range),
          certificates: validationData?.certificates,
        };
        const verification = yield* verifyDetachedSignedDataEvidence(cms).pipe(Effect.option);
        if (Option.isNone(verification)) return covered;

        const { result, revocation, timestampTokens, signatureValue, claimedSigningTime } =
          verification.value;
        const timestampEvidence =
          result.valid && signatureValue !== undefined
            ? yield* readTimestamp(timestampTokens, signatureValue, tsaTrust, at)
            : covered.timestampEvidence;
        const documentTime = documentTimestamps
          .flatMap((entry) =>
            entry !== undefined &&
            entry.offset >= revisionEnd &&
            entry.timestampEvidence.kind === "verified"
              ? [entry.timestampEvidence.genTime]
              : [],
          )
          .sort((a, b) => a.getTime() - b.getTime())[0];
        const effectiveTime: PdfSignatureVerification["evaluationTime"] =
          timestampEvidence.kind === "verified"
            ? { at: timestampEvidence.genTime, source: "signatureTimestamp" }
            : documentTime !== undefined
              ? { at: documentTime, source: "documentTimestamp" }
              : evaluationTime;
        const inspection = yield* inspectDetachedSignedData({ cms: der.value }).pipe(Effect.option);
        const signerCertificate = Option.getOrUndefined(inspection)?.signerCertificateDer;
        const signer =
          signerCertificate == null
            ? undefined
            : yield* Effect.all([
                parseX509(signerCertificate),
                icpBrasilIdentity(signerCertificate),
              ]).pipe(
                Effect.map(([certificate, identity]) => ({
                  commonName: certificate.subject.commonName,
                  ...identity,
                })),
                Effect.orElseSucceed(() => undefined),
              );
        const trusted =
          roots === undefined || !result.valid
            ? undefined
            : yield* verifyDetachedSignedDataEvidence({
                ...cms,
                trustedRoots: roots,
                at: effectiveTime.at,
              }).pipe(Effect.orElseSucceed(() => undefined));
        const trustedPath =
          trusted !== undefined && trusted.result.valid && trusted.result.chainValid
            ? trusted.certificatePath
            : [];
        const trust =
          roots === undefined ? "notEvaluated" : trustedPath.length > 0 ? "trusted" : "untrusted";
        const revocationReport = yield* evaluateRevocation(
          {
            ocsp: [...revocation.ocsp, ...(validationData?.ocsp ?? [])],
            crls: [...revocation.crls, ...(validationData?.crls ?? [])],
          },
          trustedPath,
          effectiveTime.at,
        );
        const validationDataEnd = Math.max(
          revisionEnd,
          ...changes.value.changes
            .filter(({ kind }) => kind === "dss")
            .map(({ revisionEnd: end }) => end),
        );
        const archived = documentTimestamps.some(
          (entry) =>
            entry !== undefined &&
            entry.timestampEvidence.kind === "verified" &&
            entry.revisionEnd > validationDataEnd,
        );
        const ltvLevel: PdfLtvLevel | undefined = !result.valid
          ? undefined
          : effectiveTime.source !== "signatureTimestamp" &&
              effectiveTime.source !== "documentTimestamp"
            ? "B-B"
            : revocationReport.kind !== "verified" || revocationReport.result.status !== "good"
              ? "B-T"
              : archived
                ? "B-LTA"
                : "B-LT";
        return {
          ...covered,
          integrity: result.valid ? "valid" : "invalid",
          signer,
          claimedSigningTime,
          timestampEvidence,
          evaluationTime: effectiveTime,
          trust,
          revocation: revocationReport,
          ltvLevel,
        };
      }),
  );
  return { signatures, revisions: fields.revisions };
});

export const verifyPdfRevision = (
  signing: PdfCoreSigningSession,
  pdf: Uint8Array,
  options?: PdfVerifyOptions,
) => Effect.map(readVerification(signing, pdf, options), ({ signatures }) => ({ signatures }));

export const comparePdfRevisions = Effect.fn("local.pdf.compare")(function* (
  signing: PdfCoreSigningSession,
  sent: Uint8Array,
  returned: Uint8Array,
  options?: PdfVerifyOptions,
): Effect.fn.Return<ComparisonReport, LocalError> {
  const prefix =
    sent.length <= returned.length && sent.every((byte, index) => byte === returned[index]);
  const baseline = prefix
    ? yield* signing.changes(sent.length).pipe(
        Effect.asSome,
        Effect.catch((error) =>
          error.reason === "fromRevisionEnd does not identify a complete PDF revision"
            ? Effect.succeedNone
            : Effect.fail(new LocalError({ code: "pdfReadFailed", pdfCode: error.code })),
        ),
      )
    : Option.none();
  const sentPreserved = Option.isSome(baseline);
  const changes = sentPreserved ? reportChanges(baseline.value) : undefined;
  const { signatures: allSignatures, revisions } = yield* readVerification(
    signing,
    returned,
    options,
  );
  const lastRevisionEnd = revisions.at(-1) ?? 0;
  const trailingBytes = returned
    .subarray(lastRevisionEnd)
    .some(
      (byte) =>
        byte !== 0 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13 && byte !== 32,
    );
  const signatures = sentPreserved
    ? allSignatures.filter(
        ({ coverage }) => coverage.revisionEnd === undefined || coverage.revisionEnd > sent.length,
      )
    : allSignatures;
  const signedEnds = new Set(signatures.map(({ coverage }) => coverage.revisionEnd));
  const timestampEnds = new Set(
    signatures
      .filter(({ kind, integrity }) => kind === "documentTimestamp" && integrity === "valid")
      .map(({ coverage }) => coverage.revisionEnd),
  );
  const invalid = allSignatures.some(
    ({ kind, integrity }) =>
      integrity === "invalid" || (kind === "signature" && integrity !== "valid"),
  );
  const hasNewSignature = signatures.some(({ kind }) => kind === "signature");
  const pageContentChanged = changes?.pageContentChanged ?? false;
  const unexpected =
    changes?.recognised.some(
      ({ kind, change, revisionEnd }) =>
        change === "removed" ||
        (kind !== "dss" &&
          !(kind === "docTimeStamp" && timestampEnds.has(revisionEnd)) &&
          !(signingChanges.has(kind) && signedEnds.has(revisionEnd))),
    ) ?? false;
  const mdpViolation = allSignatures.some(
    ({ mdp }) => mdp !== undefined && (mdp.pageContentViolation || mdp.violations.length > 0),
  );
  const unknown = (changes?.unknownObjectCount ?? 0) > 0;
  const untrusted = signatures.some(({ trust }) => trust === "untrusted");
  const revoked = allSignatures.some(
    ({ revocation }) => revocation.kind === "verified" && revocation.result.status === "revoked",
  );
  const reasons: ComparisonReport["reasons"][number][] = [];
  if (!sentPreserved) reasons.push("sentRevisionMissing");
  if (invalid) reasons.push("invalidSignature");
  if (pageContentChanged) reasons.push("pageContentChanged");
  if (unexpected) reasons.push("unexpectedChange");
  if (mdpViolation) reasons.push("mdpViolation");
  if (trailingBytes) reasons.push("trailingUnparsedBytes");
  if (unknown) reasons.push("unknownObjects");
  if (untrusted) reasons.push("untrustedSignature");
  if (revoked) reasons.push("revokedSignature");
  if (!hasNewSignature) reasons.push("noNewSignatures");

  return {
    sentPreserved,
    sentRevisionIndex: sentPreserved ? baseline.value.fromRevisionIndex : undefined,
    signatures,
    changes,
    verdict: !sentPreserved
      ? "differentDocument"
      : invalid
        ? "integrityFailure"
        : pageContentChanged || unexpected || mdpViolation || trailingBytes
          ? "modifiedAfterSigning"
          : unknown
            ? "unknownChanges"
            : untrusted || revoked
              ? "untrustedSignatures"
              : !hasNewSignature
                ? "noSignatures"
                : "signedAsExpected",
    reasons,
  };
});
