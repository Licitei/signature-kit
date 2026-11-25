import { IcpBrasilPadesPolicy } from "./cms/icp-brasil.js";
import type { CmsError } from "./cms/config.js";
import { MAX_PDF_CORE_SIGNATURE_CONTENTS } from "./wasm/config.js";
import type {
  PdfCorePrepareSignatureRequest,
  PdfCorePreparedUpdate,
  PdfCoreSignatureFields,
} from "./wasm/config.js";
import type { PdfCoreSigningSession } from "./wasm/pdf-core.js";
import { Clock, Context, Effect, HashMap, Layer, Ref, Schema, Semaphore } from "effect";
import { sha256 } from "./crypto/primitives/sha256.js";
import { A1Sessions, Documents, PdfEngine } from "./engine.js";
import { decodeSignatureContents, embedPreparedSignature } from "./pdf-contents.js";
import { LocalError, PdfPrepareOptionsSchema, PreparationId } from "./rpc.js";
import type {
  PdfPreparation,
  PdfPrepareOptions,
  PdfReceipt,
  PdfVerificationReport,
  PdfVerifyOptions,
  PdfWidget,
  RevisionRef,
} from "./rpc.js";
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
>()("@signature-kit/engine/PdfSignatures") {}

type Preparation = {
  readonly binding: PdfPreparation["binding"];
  readonly sourceLength: number;
  readonly append: (
    appendix: Uint8Array,
    validate: (document: PdfCoreSigningSession) => Effect.Effect<void, LocalError>,
  ) => Effect.Effect<RevisionRef, LocalError>;
  readonly prepared: PdfCorePreparedUpdate;
  readonly digest: Uint8Array;
};

type Entry = {
  readonly lock: Semaphore.Semaphore;
  readonly state: Ref.Ref<Preparation | PdfReceipt | undefined>;
};

const idDigest = (value: string): string =>
  Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

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
  { prepared, sourceLength }: Preparation,
  verifyCms: (cms: Uint8Array) => Effect.Effect<boolean, CmsError>,
  signed: Uint8Array,
  signing: PdfCoreSigningSession,
) {
  const { contentsStart, contentsEnd, byteRange } = prepared;
  const [start, firstLength, secondStart, secondLength] = byteRange;
  const byteLength = sourceLength + signed.byteLength;
  yield* Effect.annotateCurrentSpan("byteLength", byteLength);
  if (
    start !== 0 ||
    firstLength !== contentsStart - 1 ||
    secondStart !== contentsEnd + 1 ||
    secondStart + secondLength !== byteLength ||
    contentsStart <= sourceLength ||
    contentsEnd <= contentsStart ||
    signed.byteLength !== prepared.appendix.byteLength
  )
    return yield* new LocalError({ code: "selfVerificationFailed" });

  const report = yield* signing
    .signatures("verification")
    .pipe(Effect.mapError(() => new LocalError({ code: "selfVerificationFailed" })));
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
  const holeStart = contentsStart - sourceLength;
  const holeEnd = contentsEnd - sourceLength;
  if (signed[holeStart - 1] !== 0x3c || signed[holeEnd] !== 0x3e) {
    return yield* new LocalError({ code: "selfVerificationFailed" });
  }
  const result = yield* decodeSignatureContents(signed.subarray(holeStart, holeEnd)).pipe(
    Effect.withSpan("local.pdf.decodeContents"),
    Effect.flatMap((cms) => verifyCms(cms).pipe(Effect.withSpan("local.pdf.checkCms"))),
    Effect.mapError(() => new LocalError({ code: "selfVerificationFailed" })),
  );
  if (!result) return yield* new LocalError({ code: "selfVerificationFailed" });

  const changes = yield* signing
    .changes(sourceLength)
    .pipe(Effect.mapError(() => new LocalError({ code: "selfVerificationFailed" })));
  if (
    changes.pageContentChanged ||
    changes.changes.some(
      ({ kind, change }) => !expectedChanges.has(kind) || change === "removed",
    ) ||
    !changes.changes.some(
      ({ kind, change, revisionEnd }) =>
        kind === "signature" && change === "added" && revisionEnd === byteLength,
    )
  )
    return yield* new LocalError({ code: "selfVerificationFailed" });
});

export const pdfSignaturesLayer = Layer.effect(
  PdfSignatures,
  Effect.gen(function* () {
    const documents = yield* Documents;
    const a1 = yield* A1Sessions;
    const engine = yield* PdfEngine;
    const entries = yield* Ref.make<HashMap.HashMap<PreparationId, Entry> | undefined>(
      HashMap.empty(),
    );
    yield* Effect.addFinalizer(() => Ref.set(entries, undefined));
    return PdfSignatures.of({
      fields: (revision) => engine.withRevision(revision, ({ fields }) => fields),
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
            const widget = yield* resolveWidget(yield* source.fields, options);
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

            const signing = yield* source.signing;
            const prepared = yield* signing
              .prepare({
                field,
                appearance,
                date: "D:" + now.toISOString().slice(0, 19).replace(/[-:T]/g, "") + "Z",
                contentsCapacity,
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
            const sourceLength = source.byteLength;
            const { appendix, byteRange, contentsStart, contentsEnd } = prepared;
            const [start, firstLength, secondStart, secondLength] = byteRange;
            if (
              start !== 0 ||
              contentsStart <= sourceLength ||
              contentsEnd <= contentsStart ||
              firstLength !== contentsStart - 1 ||
              secondStart !== contentsEnd + 1 ||
              secondStart + secondLength !== sourceLength + appendix.byteLength
            )
              return yield* new LocalError({ code: "pdfPrepareFailed" });
            const digest = yield* source.digest(
              certificate.hash,
              appendix.subarray(0, firstLength - sourceLength),
              appendix.subarray(secondStart - sourceLength),
            );
            return yield* Effect.gen(function* () {
              const previewRevision = yield* source.append(appendix);
              const binding = {
                sourceDigest: revision.digest,
                certificateFingerprint: profile.fingerprintSha256,
                session,
                fieldName: field.name,
                policy,
              };
              const preparationId = PreparationId.make(
                idDigest(
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
              );
              yield* a1
                .validate(session)
                .pipe(
                  Effect.onError(() =>
                    documents.release(previewRevision.handle).pipe(Effect.ignore),
                  ),
                );
              const entry = {
                lock: yield* Semaphore.make(1),
                state: yield* Ref.make<Preparation | PdfReceipt | undefined>({
                  binding,
                  sourceLength,
                  append: source.append,
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
              byteLength: preparation.sourceLength + prepared.appendix.byteLength,
              policy,
              holderKind: certificate.profile.holderKind,
            });
            const bindCms = yield* certificate.cms;
            const detached = yield* bindCms({
              messageDigest: digest,
              signingTime: signedAt,
              icpBrasil: policy === "icpBrasilAdRbV11" ? IcpBrasilPadesPolicy.adRbV11 : undefined,
            }).pipe(Effect.mapError(() => new LocalError({ code: "signFailed" })));
            const cms = yield* detached
              .sign((attributes) => a1.sign(session.sessionId, session.generation, attributes))
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "LocalError" ? error : new LocalError({ code: "signFailed" }),
                ),
                Effect.withSpan("local.pdf.cms", { attributes: { policy } }),
              );
            const signed = yield* embedPreparedSignature(
              {
                pdf: prepared.appendix,
                contentsStart: prepared.contentsStart - preparation.sourceLength,
                contentsEnd: prepared.contentsEnd - preparation.sourceLength,
              },
              cms,
            ).pipe(Effect.withSpan("local.pdf.embed"));
            const signedRevision = yield* preparation.append(signed, (document) =>
              selfVerify(preparation, detached.verify, signed, document),
            );
            const receiptId = idDigest(preparationId + signedRevision.digest);
            yield* a1
              .validate(session)
              .pipe(
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
        engine.withRevision(revision, (source) =>
          Effect.gen(function* () {
            const bytes = yield* documents.export(revision.handle);
            const signing = yield* source.signing;
            return yield* verifyPdfRevision(signing, bytes, options);
          }),
        ),
    });
  }),
);
