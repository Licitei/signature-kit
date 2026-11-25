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
          integrity: dictionary.kind === "signature" ? "invalid" : "unsupported",
          coverage: { kind: "invalid" },
          trust: roots === undefined ? "notEvaluated" : "untrusted",
          revocation: { kind: "notChecked" },
          timestampEvidence: dictionary.kind === "documentTimestamp" ? "present" : "absent",
        } satisfies PdfSignatureVerification;
        if (range === undefined) return initial;
        const revisionEnd = range[2] + range[3];
        const contents = yield* signatureContents(pdf, dictionary).pipe(Effect.option);
        if (Option.isNone(contents) || range[0] !== 0) return initial;
        const changes = yield* signing.changes(revisionEnd).pipe(Effect.option);
        if (Option.isNone(changes)) return initial;
        const covered = {
          ...initial,
          coverage: {
            kind: revisionEnd === pdf.byteLength ? "wholeFile" : "partial",
            revisionEnd,
            bytesAfter: pdf.byteLength - revisionEnd,
          },
          changes: reportChanges(changes.value),
        } satisfies PdfSignatureVerification;
        if (dictionary.kind !== "signature") return covered;
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
        const cms = { cms: der.value, content: signedBytes(pdf, range) };
        const verification = yield* verifyDetachedSignedDataEvidence(cms).pipe(Effect.option);
        if (Option.isNone(verification)) return covered;

        const { result, revocation, timestampPresent, claimedSigningTime } = verification.value;
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
        const trust =
          roots === undefined || !result.valid
            ? initial.trust
            : yield* verifyDetachedSignedDataEvidence({
                ...cms,
                trustedRoots: roots,
                at,
              }).pipe(
                Effect.map(({ result }): PdfSignatureVerification["trust"] =>
                  result.chainValid && result.valid ? "trusted" : "untrusted",
                ),
                Effect.orElseSucceed((): PdfSignatureVerification["trust"] => "untrusted"),
              );
        return {
          ...covered,
          integrity: result.valid ? "valid" : "invalid",
          signer,
          claimedSigningTime,
          timestampEvidence: timestampPresent ? "present" : "absent",
          trust,
          revocation:
            revocation.ocspCount + revocation.crlCount > 0
              ? { kind: "embeddedEvidence", ...revocation }
              : { kind: "notChecked" },
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

const signingChanges = new Set(["signature", "signatureField", "widgetAppearance", "acroForm"]);

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
  const invalid = allSignatures.some(({ integrity }) => integrity !== "valid");
  const pageContentChanged = changes?.pageContentChanged ?? false;
  const unexpected =
    changes?.recognised.some(
      ({ kind, change, revisionEnd }) =>
        change === "removed" ||
        (kind !== "dss" && (!signingChanges.has(kind) || !signedEnds.has(revisionEnd))),
    ) ?? false;
  const unknown = (changes?.unknownObjectCount ?? 0) > 0;
  const untrusted = signatures.some(({ trust }) => trust === "untrusted");
  const reasons: ComparisonReport["reasons"][number][] = [];
  if (!sentPreserved) reasons.push("sentRevisionMissing");
  if (invalid) reasons.push("invalidSignature");
  if (pageContentChanged) reasons.push("pageContentChanged");
  if (unexpected) reasons.push("unexpectedChange");
  if (trailingBytes) reasons.push("trailingUnparsedBytes");
  if (unknown) reasons.push("unknownObjects");
  if (untrusted) reasons.push("untrustedSignature");
  if (signatures.length === 0) reasons.push("noNewSignatures");

  return {
    sentPreserved,
    sentRevisionIndex: sentPreserved ? baseline.value.fromRevisionIndex : undefined,
    signatures,
    changes,
    verdict: !sentPreserved
      ? "differentDocument"
      : invalid
        ? "integrityFailure"
        : pageContentChanged || unexpected || trailingBytes
          ? "modifiedAfterSigning"
          : unknown
            ? "unknownChanges"
            : untrusted
              ? "untrustedSignatures"
              : signatures.length === 0
                ? "noSignatures"
                : "signedAsExpected",
    reasons,
  };
});
