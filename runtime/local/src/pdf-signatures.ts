import { unpadSignedData } from "@signature-kit/cms/inspect";
import { IcpBrasilPadesPolicy } from "@signature-kit/cms/icp-brasil";
import { createDetachedSignedDataFromDigest } from "@signature-kit/cms/sign";
import { verifyDetachedSignedData } from "@signature-kit/cms/verify";
import { MAX_PDF_CORE_SIGNATURE_CONTENTS } from "@signature-kit/pdf-core/config";
import type {
  PdfCorePrepareSignatureRequest,
  PdfCorePreparedSignature,
  PdfCoreSignatureFields,
} from "@signature-kit/pdf-core/config";
import { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { Clock, Context, Effect, HashMap, Layer, Ref, Schema, Semaphore } from "effect";
import { sha256Hex } from "./a1-certificate.js";
import type { A1Hash } from "./a1-certificate.js";
import { A1Sessions, Documents, PdfEngine } from "./engine.js";
import {
  decodeSignatureContents,
  embedPreparedSignature,
  signatureContents,
  signedBytes,
} from "./pdf-contents.js";
import { LocalError, PdfPrepareOptionsSchema, PreparationId } from "./protocol.js";
import type {
  PdfPreparation,
  PdfPrepareOptions,
  PdfReceipt,
  PdfVerificationReport,
  PdfVerifyOptions,
  PdfWidget,
  RevisionRef,
} from "./protocol.js";
import { verifyPdfRevision } from "./pdf-verification.js";

export class PdfSignatures extends Context.Service<
  PdfSignatures,
  {
    readonly fields: (revision: RevisionRef) => Effect.Effect<PdfCoreSignatureFields, LocalError>;
    readonly prepare: (
      revision: RevisionRef,
      options: PdfPrepareOptions,
    ) => Effect.Effect<PdfPreparation, LocalError>;
    readonly confirm: (preparationId: PreparationId) => Effect.Effect<PdfReceipt, LocalError>;
    readonly release: (preparationId: PreparationId) => Effect.Effect<void>;
    readonly verify: (
      revision: RevisionRef,
      options?: PdfVerifyOptions,
    ) => Effect.Effect<PdfVerificationReport, LocalError>;
  }
>()("@signature-kit/local/PdfSignatures") {}

type Preparation = {
  readonly binding: PdfPreparation["binding"];
  readonly source: Uint8Array<ArrayBuffer>;
  readonly prepared: PdfCorePreparedSignature;
  readonly digest: Uint8Array;
};

type Entry = {
  readonly lock: Semaphore.Semaphore;
  readonly state: Ref.Ref<Preparation | PdfReceipt | undefined>;
};

const webCryptoHash = {
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
} satisfies Record<A1Hash, "sha256" | "sha384" | "sha512">;

const resolveWidget = Effect.fnUntraced(function* (
  report: PdfCoreSignatureFields,
  { field, appearance }: PdfPrepareOptions,
): Effect.fn.Return<PdfWidget, LocalError> {
  if (
    report.docMdp === 1 ||
    report.fields.some(({ signed, lock }) => {
      if (!signed || lock === undefined) return false;
      const listed = lock.fields.some(
        (name) => field.name === name || field.name.startsWith(name + "."),
      );
      return (
        lock.action === "All" ||
        (lock.action === "Include" && listed) ||
        (lock.action === "Exclude" && !listed)
      );
    })
  )
    return yield* new LocalError({ code: "documentLocked" });

  const matching = report.fields.filter(({ name }) => name === field.name);
  const selected = matching[0];
  if (matching.length > 1) return yield* new LocalError({ code: "fieldAmbiguous" });
  if (selected?.signed === true) return yield* new LocalError({ code: "fieldSigned" });
  if (field.kind === "create") {
    if (selected !== undefined) return yield* new LocalError({ code: "fieldAmbiguous" });
    return appearance.kind === "none"
      ? { kind: "invisible" }
      : { kind: "visible", page: field.page, rect: field.rect };
  }
  if (selected === undefined) return yield* new LocalError({ code: "fieldNotFound" });
  if (appearance.kind === "none") return { kind: "invisible" };
  const [widget] = selected.widgets;
  if (selected.widgets.length !== 1 || widget?.page === undefined || widget.rect === undefined) {
    return yield* new LocalError({ code: "fieldAmbiguous" });
  }
  return { kind: "visible", page: widget.page, rect: widget.rect };
});

const appearanceFor = (
  widget: PdfWidget,
  lines: readonly string[],
): PdfCorePrepareSignatureRequest["appearance"] => {
  if (widget.kind === "invisible") return { kind: "none" };
  const [left, bottom, right, top] = widget.rect;
  const width = right - left;
  const height = top - bottom;
  const size = Math.max(
    1,
    Math.min(
      10,
      (height - 4) / Math.max(lines.length, 1) / 1.2,
      (width - 4) / Math.max(...lines.map((line) => line.length), 1),
    ),
  );
  return {
    kind: "visible",
    lines: lines.map((text, index) => ({
      text,
      font: index === 0 ? "Helvetica-Bold" : "Helvetica",
      size,
      position: [2, Math.max(0, height - 2 - size * (1 + index * 1.2))],
      color: [0],
    })),
  };
};

const expectedChanges = new Set(["signature", "signatureField", "widgetAppearance", "acroForm"]);

const selfVerify = Effect.fn("local.pdf.selfVerify")(function* (
  core: typeof PdfCore.Service,
  { prepared, source }: Preparation,
  signed: Uint8Array,
) {
  const { contentsStart, contentsEnd, byteRange } = prepared;
  const [start, firstLength, secondStart, secondLength] = byteRange;
  yield* Effect.annotateCurrentSpan("byteLength", signed.byteLength);
  yield* Effect.gen(function* () {
    if (
      start !== 0 ||
      firstLength !== contentsStart - 1 ||
      secondStart !== contentsEnd + 1 ||
      secondStart + secondLength !== signed.byteLength ||
      contentsStart <= source.byteLength ||
      signed.byteLength <= source.byteLength
    )
      return yield* new LocalError({ code: "selfVerificationFailed" });
  }).pipe(Effect.withSpan("local.pdf.checkCoverage"));

  yield* Effect.gen(function* () {
    for (let index = 0; index < source.byteLength; index += 1) {
      if (signed[index] !== source[index]) {
        return yield* new LocalError({ code: "selfVerificationFailed" });
      }
    }
  }).pipe(Effect.withSpan("local.pdf.checkPrefix"));

  const report = yield* core.signatures(signed, "verification").pipe(
    Effect.mapError(() => new LocalError({ code: "selfVerificationFailed" })),
    Effect.withSpan("local.pdf.findSignature"),
  );
  const signature = report.dictionaries.find(
    (dictionary) =>
      dictionary.kind === "signature" &&
      dictionary.contents?.valueStart === firstLength &&
      dictionary.contents.valueEnd === secondStart &&
      dictionary.byteRangeValues?.every((value, index) => value === byteRange[index]),
  );
  if (report.failure !== undefined || signature === undefined) {
    return yield* new LocalError({ code: "selfVerificationFailed" });
  }
  const result = yield* signatureContents(signed, signature).pipe(
    Effect.flatMap(decodeSignatureContents),
    Effect.flatMap(unpadSignedData),
    Effect.withSpan("local.pdf.decodeContents"),
    Effect.flatMap((cms) =>
      Effect.sync(() => signedBytes(signed, byteRange)).pipe(
        Effect.withSpan("local.pdf.collectByteRange"),
        Effect.flatMap((content) => verifyDetachedSignedData({ cms, content })),
        Effect.withSpan("local.pdf.checkCms"),
      ),
    ),
    Effect.mapError(() => new LocalError({ code: "selfVerificationFailed" })),
  );
  if (!result.valid) return yield* new LocalError({ code: "selfVerificationFailed" });

  const changes = yield* core.revisionChanges(signed, source.byteLength).pipe(
    Effect.mapError(() => new LocalError({ code: "selfVerificationFailed" })),
    Effect.withSpan("local.pdf.checkChanges"),
  );
  if (
    changes.pageContentChanged ||
    changes.changes.some(
      ({ kind, change }) => !expectedChanges.has(kind) || change === "removed",
    ) ||
    !changes.changes.some(
      ({ kind, change, revisionEnd }) =>
        kind === "signature" && change === "added" && revisionEnd === signed.byteLength,
    )
  )
    return yield* new LocalError({ code: "selfVerificationFailed" });
});

export const pdfSignaturesLayer = Layer.effect(
  PdfSignatures,
  Effect.gen(function* () {
    const core = yield* PdfCore;
    const documents = yield* Documents;
    const a1 = yield* A1Sessions;
    const engine = yield* PdfEngine;
    const entries = yield* Ref.make<HashMap.HashMap<PreparationId, Entry> | undefined>(
      HashMap.empty(),
    );
    yield* Effect.addFinalizer(() => Ref.set(entries, undefined));
    const readFields = (pdf: Uint8Array) =>
      core
        .signatureFields(pdf)
        .pipe(Effect.mapError(() => new LocalError({ code: "pdfReadFailed" })));

    return PdfSignatures.of({
      fields: (revision) => engine.withRevision(revision, readFields),
      prepare: Effect.fn("local.pdf.prepare")(function* (revision, input) {
        const options = yield* Schema.decodeUnknownEffect(PdfPrepareOptionsSchema)(input).pipe(
          Effect.mapError(() => new LocalError({ code: "pdfPrepareFailed" })),
        );
        const { session, field, policy, reason, location } = options;
        const certificate = yield* a1.certificate(session);
        const { profile } = certificate;
        yield* Effect.annotateCurrentSpan({
          byteLength: revision.byteLength,
          policy,
          holderKind: profile.holderKind,
        });
        return yield* engine.withRevision(revision, (source) =>
          Effect.gen(function* () {
            const widget = yield* resolveWidget(yield* readFields(source), options);
            const now = new Date(yield* Clock.currentTimeMillis);
            const holderLabel = { "e-cpf": "e-CPF", "e-cnpj": "e-CNPJ", other: "A1" };
            const lines =
              options.appearance.kind === "visible" ? options.appearance.lines : undefined;
            const appearance = appearanceFor(
              widget,
              lines ?? [
                profile.subjectName,
                holderLabel[profile.holderKind],
                now.toISOString().slice(0, 10),
              ],
            );
            const icpBrasil =
              policy === "icpBrasilAdRbV11" ? IcpBrasilPadesPolicy.adRbV11 : undefined;
            const contentsCapacity =
              certificate.certificateDer.byteLength +
              certificate.chainDer.reduce((sum, der) => sum + der.byteLength, 0) +
              certificate.signatureBytes +
              (icpBrasil === undefined
                ? 0
                : icpBrasil.policyHash.byteLength +
                  icpBrasil.policyUri.length +
                  icpBrasil.policyOid.length) +
              1024;
            if (contentsCapacity > MAX_PDF_CORE_SIGNATURE_CONTENTS) {
              return yield* new LocalError({ code: "signatureTooLarge" });
            }

            const prepared = yield* core
              .prepareSignature(source, {
                field,
                appearance,
                date: "D:" + now.toISOString().slice(0, 19).replace(/[-:T]/g, "") + "Z",
                contentsCapacity,
                sha512: certificate.hash === "SHA-512",
                reason,
                location,
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new LocalError({
                      code:
                        error.reason === "DocMDP forbids signing this document"
                          ? "documentLocked"
                          : "pdfPrepareFailed",
                    }),
                ),
              );
            const digest =
              certificate.hash === "SHA-384"
                ? yield* Effect.tryPromise({
                    try: () =>
                      crypto.subtle.digest(
                        "SHA-384",
                        signedBytes(prepared.pdf, prepared.byteRange),
                      ),
                    catch: () => new LocalError({ code: "digestFailed" }),
                  }).pipe(Effect.map((buffer) => new Uint8Array(buffer)))
                : certificate.hash === "SHA-512"
                  ? prepared.sha512
                  : prepared.sha256;
            if (digest === undefined)
              return yield* Effect.die("PDF core omitted the requested digest.");

            return yield* Effect.gen(function* () {
              const previewRevision = yield* documents.open(prepared.pdf);
              const binding = {
                sourceDigest: revision.digest,
                certificateFingerprint: profile.fingerprintSha256,
                session,
                fieldName: field.name,
                policy,
              };
              const preparationId = PreparationId.make(
                yield* sha256Hex(
                  new TextEncoder().encode(
                    JSON.stringify([
                      binding.sourceDigest,
                      binding.certificateFingerprint,
                      session.generation,
                      field.kind === "create"
                        ? [field.kind, field.name, field.page, field.rect]
                        : [field.kind, field.name],
                      appearance,
                      policy,
                      previewRevision.digest,
                    ]),
                  ),
                ).pipe(
                  Effect.tap(() => a1.validate(session)),
                  Effect.onError(() =>
                    documents.release(previewRevision.handle).pipe(Effect.ignore),
                  ),
                ),
              );
              const entry = {
                lock: yield* Semaphore.make(1),
                state: yield* Ref.make<Preparation | PdfReceipt | undefined>({
                  binding,
                  source,
                  prepared,
                  digest,
                }),
              };
              const stored = yield* Ref.modify(entries, (current) =>
                current === undefined
                  ? [false, current]
                  : [
                      true,
                      HashMap.has(current, preparationId)
                        ? current
                        : HashMap.set(current, preparationId, entry),
                    ],
              );
              if (!stored) {
                yield* documents.release(previewRevision.handle).pipe(Effect.ignore);
                return yield* new LocalError({ code: "runtimeClosed" });
              }
              return {
                preparationId,
                previewRevision,
                widget,
                binding: { ...binding, session: { ...session } },
              };
            }).pipe(Effect.uninterruptible);
          }),
        );
      }),
      confirm: Effect.fn("local.pdf.confirm")(function* (preparationId) {
        const current = yield* Ref.get(entries);
        if (current === undefined) return yield* new LocalError({ code: "runtimeClosed" });
        const entry = HashMap.get(current, preparationId);
        if (entry._tag === "None") return yield* new LocalError({ code: "preparationUnknown" });

        return yield* entry.value.lock.withPermit(
          Effect.gen(function* () {
            const preparation = yield* Ref.get(entry.value.state);
            if (preparation === undefined)
              return yield* new LocalError({ code: "preparationUnknown" });
            if ("receiptId" in preparation) {
              return {
                ...preparation,
                signedAt: new Date(preparation.signedAt),
                signedRevision: { ...preparation.signedRevision },
              };
            }
            const { binding, digest, prepared } = preparation;
            const { session, policy } = binding;
            const certificate = yield* a1.certificate(session);
            const signedAt = new Date(yield* Clock.currentTimeMillis);
            if (signedAt > certificate.profile.notAfter) {
              return yield* new LocalError({ code: "certificateExpired" });
            }
            if (signedAt < certificate.profile.notBefore) {
              return yield* new LocalError({ code: "certificateNotYetValid" });
            }
            yield* Effect.annotateCurrentSpan({
              byteLength: prepared.pdf.byteLength,
              policy,
              holderKind: certificate.profile.holderKind,
            });
            const cms = yield* createDetachedSignedDataFromDigest(
              {
                messageDigest: digest,
                certificateDer: certificate.certificateDer,
                chainDer: certificate.chainDer,
                hashAlgorithm: webCryptoHash[certificate.hash],
                signingTime: signedAt,
                icpBrasil: policy === "icpBrasilAdRbV11" ? IcpBrasilPadesPolicy.adRbV11 : undefined,
              },
              (attributes) => a1.sign(session.sessionId, session.generation, attributes),
            ).pipe(
              Effect.catchTag("CmsError", () =>
                Effect.fail(new LocalError({ code: "signFailed" })),
              ),
              Effect.withSpan("local.pdf.cms", { attributes: { policy } }),
            );
            const signed = yield* embedPreparedSignature(prepared, cms).pipe(
              Effect.withSpan("local.pdf.embed"),
            );
            yield* selfVerify(core, preparation, signed);
            const signedRevision = yield* documents.open(signed);
            const receiptId = yield* sha256Hex(
              new TextEncoder().encode(preparationId + signedRevision.digest),
            ).pipe(
              Effect.tap(() => a1.validate(session)),
              Effect.onError(() => documents.release(signedRevision.handle).pipe(Effect.ignore)),
            );
            const receipt = {
              receiptId,
              preparationId,
              sourceDigest: binding.sourceDigest,
              signedRevision,
              signedAt,
              certificateFingerprint: binding.certificateFingerprint,
              fieldName: binding.fieldName,
            };
            yield* Ref.set(entry.value.state, receipt);
            return {
              ...receipt,
              signedAt: new Date(signedAt),
              signedRevision: { ...signedRevision },
            };
          }).pipe(Effect.uninterruptible),
        );
      }),
      release: Effect.fn(function* (preparationId) {
        const current = yield* Ref.get(entries);
        if (current === undefined) return;
        const entry = HashMap.get(current, preparationId);
        if (entry._tag === "None") return;
        yield* entry.value.lock.withPermit(
          Effect.gen(function* () {
            yield* Ref.update(entries, (active) => {
              if (active === undefined) return active;
              const stored = HashMap.get(active, preparationId);
              return stored._tag === "Some" && stored.value === entry.value
                ? HashMap.remove(active, preparationId)
                : active;
            });
            yield* Ref.set(entry.value.state, undefined);
          }).pipe(Effect.uninterruptible),
        );
      }),
      verify: (revision, options) =>
        engine.withRevision(revision, (pdf) => verifyPdfRevision(core, pdf, options)),
    });
  }),
);
