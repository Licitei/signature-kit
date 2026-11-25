import { inspectDetachedSignedData, unpadSignedData } from "@signature-kit/cms/inspect";
import { verifyDetachedSignedDataEvidence } from "@signature-kit/cms/verify";
import type { PdfCoreSigningDocument } from "@signature-kit/pdf-core/pdf-core";
import { Clock, Effect, Schema } from "effect";
import { a1Profile } from "./a1-certificate.js";
import { decodeSignatureContents, signatureContents, signedBytes } from "./pdf-contents.js";
import { LocalError, PdfVerifyOptionsSchema } from "./protocol.js";
import type {
  PdfSignatureVerification,
  PdfVerificationReport,
  PdfVerifyOptions,
} from "./protocol.js";

export const verifyPdfRevision = Effect.fn("local.pdf.verify")(function* (
  signing: PdfCoreSigningDocument,
  pdf: Uint8Array,
  input: PdfVerifyOptions = {},
): Effect.fn.Return<PdfVerificationReport, LocalError> {
  const options = yield* Schema.decodeUnknownEffect(PdfVerifyOptionsSchema)(input).pipe(
    Effect.mapError(() => new LocalError({ code: "pdfReadFailed" })),
  );
  const at = options.at ?? new Date(yield* Clock.currentTimeMillis);
  yield* Effect.annotateCurrentSpan("byteLength", pdf.byteLength);
  const report = yield* signing
    .signatures("verification")
    .pipe(Effect.mapError(() => new LocalError({ code: "pdfReadFailed" })));
  if (report.failure !== undefined) {
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
        const fieldName =
          range === undefined
            ? undefined
            : fields.fields.find(({ signature }) =>
                signature?.byteRange?.every((value, index) => value === range[index]),
              )?.name;
        const initial = {
          fieldName,
          integrity: dictionary.kind === "signature" ? "invalid" : "unsupported",
          coverage: { kind: "invalid" },
          trust: options.trust === undefined ? "notEvaluated" : "untrusted",
          revocation: "notChecked",
        } satisfies PdfSignatureVerification;
        if (range === undefined) return initial;

        const contents = yield* signatureContents(pdf, dictionary).pipe(Effect.option);
        if (contents._tag === "None") return initial;

        const revisionEnd = range[2] + range[3];
        const changeReport =
          range[0] === 0 ? yield* signing.changes(revisionEnd).pipe(Effect.option) : undefined;
        const changes = changeReport?._tag === "Some" ? changeReport.value : undefined;
        const coverage = {
          kind:
            changes === undefined
              ? "invalid"
              : revisionEnd === pdf.byteLength
                ? "wholeFile"
                : "partial",
          bytesAfter: pdf.byteLength - revisionEnd,
        } satisfies PdfSignatureVerification["coverage"];
        const covered = {
          ...initial,
          coverage,
          changes:
            changes === undefined
              ? undefined
              : {
                  recognised: changes.changes.filter(({ kind }) => kind !== "unknown"),
                  unknown: changes.changes.filter(({ kind }) => kind === "unknown"),
                  pageContentChanged: changes.pageContentChanged,
                },
        };
        if (dictionary.kind !== "signature") return covered;

        const der = yield* decodeSignatureContents(contents.value).pipe(
          Effect.flatMap(unpadSignedData),
          Effect.option,
        );
        if (der._tag === "None") return covered;
        const cms = { cms: der.value, content: signedBytes(pdf, range) };
        const verification = yield* verifyDetachedSignedDataEvidence(cms).pipe(Effect.option);
        if (verification._tag === "None") return covered;

        const { result, embeddedRevocation } = verification.value;
        const inspection = yield* inspectDetachedSignedData({ cms: der.value }).pipe(Effect.option);
        const signerCertificate =
          inspection._tag === "Some" ? inspection.value.signerCertificateDer : null;
        const profile =
          signerCertificate === null
            ? undefined
            : yield* a1Profile(signerCertificate).pipe(Effect.option);
        const trust =
          options.trust === undefined || !result.valid
            ? initial.trust
            : yield* verifyDetachedSignedDataEvidence({
                ...cms,
                trustedRoots: options.trust,
                at,
              }).pipe(
                Effect.map(({ result }): PdfSignatureVerification["trust"] =>
                  result.chainValid ? "trusted" : "untrusted",
                ),
                Effect.orElseSucceed((): PdfSignatureVerification["trust"] => "untrusted"),
              );
        return {
          ...covered,
          integrity: result.valid ? "valid" : "invalid",
          signer:
            profile?._tag === "Some"
              ? { subject: profile.value.subjectName, holderKind: profile.value.holderKind }
              : undefined,
          trust,
          revocation: embeddedRevocation ? "embeddedEvidence" : "notChecked",
        };
      }),
  );
  return { signatures };
});
