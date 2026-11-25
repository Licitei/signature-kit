import type { A1Hash } from "./a1-certificate.js";
import { checkTimestampSha256Imprint } from "./cms/timestamp.js";
import { IcpBrasilPadesPolicy } from "./cms/icp-brasil.js";
import { MAX_PDF_CORE_SIGNATURE_CONTENTS } from "./wasm/config.js";
import type {
  PdfCoreNewSignatureFields,
  PdfCorePreparedUpdate,
  PdfCoreSignatureFields,
} from "./wasm/config.js";
import { Clock, Context, Effect, HashMap, Layer, Ref, Schema, Semaphore } from "effect";
import { sha256 } from "./crypto/primitives/sha256.js";
import { A1Sessions, Documents, PdfEngine } from "./engine.js";
import type { PdfRevision } from "./engine.js";
import { decodeSignatureContents, embedPreparedSignature } from "./pdf-contents.js";
import { PdfCore } from "./wasm/pdf-core.js";
import { LocalError, PdfPrepareOptionsSchema, PreparationId } from "./rpc.js";
import type {
  PdfPreparation,
  ComparisonReport,
  PdfPrepareOptions,
  PdfValidationData,
  PdfReceipt,
  PdfVerificationReport,
  PdfVerifyOptions,
  RevisionRef,
} from "./rpc.js";
import { comparePdfRevisions, verifyPdfRevision } from "./pdf-verification.js";
import { makeLocalCompute, prepareErrorCode } from "./signature-compute.js";
import type { SignatureComputeService } from "./signature-compute.js";

const PREPARED_HEADER_BYTES = 36;
const PREWARM_SESSION = "00000000-0000-4000-8000-000000000000";
const digestLengths = { "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 } satisfies Record<
  A1Hash,
  number
>;

type PreparationAllocation = {
  readonly identity: symbol;
  readonly nonce: string;
  readonly compute?: SignatureComputeService | undefined;
  readonly reserve: (sizes: {
    readonly appendixBytes: number;
    readonly digestBytes: number;
    readonly preparedPayloadBytes: number;
    readonly previewBytes: number;
    readonly contentsCapacity: number;
  }) => Effect.Effect<void, LocalError>;
};

export class PdfSignatures extends Context.Service<
  PdfSignatures,
  {
    readonly fields: (revision: RevisionRef) => Effect.Effect<PdfCoreSignatureFields, LocalError>;
    readonly addFields: (
      revision: RevisionRef,
      fields: PdfCoreNewSignatureFields,
    ) => Effect.Effect<RevisionRef, LocalError>;
    readonly addValidationData: (
      revision: RevisionRef,
      evidence: PdfValidationData,
    ) => Effect.Effect<RevisionRef, LocalError>;
    readonly prepareDocumentTimestamp: (
      revision: RevisionRef,
    ) => Effect.Effect<Uint8Array, LocalError>;
    readonly addDocumentTimestamp: (
      revision: RevisionRef,
      token: Uint8Array,
    ) => Effect.Effect<RevisionRef, LocalError>;
    readonly compare: (
      sent: RevisionRef,
      returned: RevisionRef,
      options?: PdfVerifyOptions,
    ) => Effect.Effect<ComparisonReport, LocalError>;
    readonly prepare: (
      revision: RevisionRef,
      options: PdfPrepareOptions,
      allocation?: PreparationAllocation,
    ) => Effect.Effect<PdfPreparation, LocalError>;
    readonly confirm: (
      preparationId: PreparationId,
      owner?: symbol,
    ) => Effect.Effect<PdfReceipt, LocalError>;
    readonly release: (preparationId: PreparationId, owner?: symbol) => Effect.Effect<void>;
    readonly verify: (
      revision: RevisionRef,
      options?: PdfVerifyOptions,
    ) => Effect.Effect<PdfVerificationReport, LocalError>;
    readonly prewarm: Effect.Effect<void, LocalError>;
  }
>()("@signature-kit/engine/PdfSignatures") {}

type Preparation = {
  readonly binding: PdfPreparation["binding"];
  readonly key: string;
  readonly source: PdfRevision;
  readonly compute: SignatureComputeService;
  readonly prepared: PdfCorePreparedUpdate;
  readonly digest: Uint8Array;
};

type Entry = {
  readonly owner?: symbol | undefined;
  readonly lock: Semaphore.Semaphore;
  readonly state: Ref.Ref<Preparation | PdfReceipt | undefined>;
};

const idDigest = (value: string): string =>
  Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const pdfSignaturesLayer = Layer.effect(
  PdfSignatures,
  Effect.gen(function* () {
    const documents = yield* Documents;
    const a1 = yield* A1Sessions;
    const engine = yield* PdfEngine;
    const core = yield* PdfCore;
    const local = makeLocalCompute(a1);
    const entries = yield* Ref.make<HashMap.HashMap<PreparationId, Entry> | undefined>(
      HashMap.empty(),
    );
    yield* Effect.addFinalizer(() => Ref.set(entries, undefined));
    const prepareTimestamp = Effect.fn(function* (source: PdfRevision) {
      const signing = yield* source.signing;
      const {
        appendix,
        byteRange: [start, firstLength, secondStart, secondLength],
        contentsStart,
        contentsEnd,
      } = yield* signing.prepareDocumentTimestamp.pipe(
        Effect.mapError(
          ({ code }) => new LocalError({ code: "documentTimestampFailed", pdfCode: code }),
        ),
      );
      if (
        start !== 0 ||
        contentsStart <= source.byteLength ||
        contentsEnd <= contentsStart ||
        firstLength !== contentsStart - 1 ||
        secondStart !== contentsEnd + 1 ||
        secondStart + secondLength !== source.byteLength + appendix.byteLength
      ) {
        return yield* new LocalError({ code: "documentTimestampFailed" });
      }
      return yield* source.digest(
        "SHA-256",
        appendix.subarray(0, firstLength - source.byteLength),
        appendix.subarray(secondStart - source.byteLength),
      );
    });
    return PdfSignatures.of({
      fields: (revision) => engine.withRevision(revision, ({ fields }) => fields),
      addFields: (revision, fields) =>
        engine.withRevision(revision, (source) =>
          source.signing.pipe(
            Effect.flatMap((signing) =>
              signing
                .addFields(fields)
                .pipe(
                  Effect.mapError(
                    ({ reason, code }) =>
                      new LocalError({ code: prepareErrorCode(reason), pdfCode: code }),
                  ),
                ),
            ),
            Effect.flatMap((appendix) => source.append(appendix)),
          ),
        ),
      addValidationData: (revision, evidence) =>
        engine.withRevision(revision, (source) =>
          Effect.gen(function* () {
            const signing = yield* source.signing;
            const appendix = yield* signing
              .addValidationData(evidence)
              .pipe(
                Effect.mapError(
                  ({ code }) => new LocalError({ code: "validationDataFailed", pdfCode: code }),
                ),
              );
            return appendix.length === 0 ? revision : yield* source.append(appendix);
          }),
        ),
      prepareDocumentTimestamp: (revision) => engine.withRevision(revision, prepareTimestamp),
      addDocumentTimestamp: (revision, token) =>
        engine.withRevision(revision, (source) =>
          Effect.gen(function* () {
            const der = new Uint8Array(token);
            const imprint = yield* prepareTimestamp(source);
            yield* checkTimestampSha256Imprint(der, imprint).pipe(
              Effect.mapError(() => new LocalError({ code: "documentTimestampFailed" })),
            );
            const signing = yield* source.signing;
            const appendix = yield* signing
              .addDocumentTimestamp(der)
              .pipe(
                Effect.mapError(
                  ({ code }) => new LocalError({ code: "documentTimestampFailed", pdfCode: code }),
                ),
              );
            return yield* source.append(appendix);
          }),
        ),
      compare: Effect.fn(function* (sent, returned, options) {
        yield* documents.validate(sent);
        return yield* engine.withRevision(returned, (target) =>
          Effect.gen(function* () {
            const signing = yield* target.signing;
            const sentBytes = yield* documents.export(sent.handle);
            const returnedBytes = yield* documents.export(returned.handle);
            return yield* comparePdfRevisions(signing, sentBytes, returnedBytes, options);
          }),
        );
      }),
      prepare: Effect.fn("local.pdf.prepare")(function* (revision, input, allocation) {
        const options = yield* Schema.decodeUnknownEffect(PdfPrepareOptionsSchema)(input).pipe(
          Effect.mapError(() => new LocalError({ code: "pdfPrepareFailed" })),
        );
        const { session, field, policy } = options;
        const certificate = yield* a1.certificate(session);
        const { profile } = certificate;
        yield* Effect.annotateCurrentSpan({
          byteLength: revision.byteLength,
          policy,
          holderKind: profile.holderKind,
        });
        return yield* engine.withRevision(revision, (source) =>
          Effect.gen(function* () {
            const now = new Date(yield* Clock.currentTimeMillis);
            const holderLabel = { "e-cpf": "e-CPF", "e-cnpj": "e-CNPJ", other: "A1" };
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

            const sourceLength = source.byteLength;
            const compute = allocation?.compute ?? local;
            const key = revision.handle;
            const { widget, appearance, prepared } = yield* compute
              .prepare(
                { key, revision: source },
                {
                  options,
                  defaultLines: [
                    profile.subjectName,
                    holderLabel[profile.holderKind],
                    now.toISOString().slice(0, 10),
                  ],
                  date: "D:" + now.toISOString().slice(0, 19).replace(/[-:T]/g, "") + "Z",
                  contentsCapacity,
                },
              )
              .pipe(
                Effect.tap(({ prepared: { appendix } }) =>
                  allocation === undefined
                    ? Effect.void
                    : allocation.reserve({
                        appendixBytes: appendix.byteLength,
                        digestBytes: digestLengths[certificate.hash],
                        previewBytes: sourceLength + appendix.byteLength,
                        preparedPayloadBytes: appendix.byteLength + PREPARED_HEADER_BYTES,
                        contentsCapacity,
                      }),
                ),
                Effect.onError(() => compute.release(key)),
              );
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
                    ...(allocation === undefined ? [] : [allocation.nonce]),
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
                owner: allocation?.identity,
                lock: yield* Semaphore.make(1),
                state: yield* Ref.make<Preparation | PdfReceipt | undefined>({
                  binding,
                  key,
                  source,
                  compute,
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
      confirm: Effect.fn("local.pdf.confirm")(function* (preparationId, owner) {
        const current = yield* Ref.get(entries);
        if (current === undefined) return yield* new LocalError({ code: "runtimeClosed" });
        const entry = HashMap.get(current, preparationId);
        if (entry._tag === "None" || entry.value.owner !== owner) {
          return yield* new LocalError({ code: "preparationUnknown" });
        }

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
              byteLength: preparation.source.byteLength + prepared.appendix.byteLength,
              policy,
              holderKind: certificate.profile.holderKind,
            });
            const signed = yield* preparation.compute.sign(
              { key: preparation.key, revision: preparation.source },
              { session, policy, signedAt, digest, prepared },
            );
            const signedRevision = yield* preparation.source.append(signed);
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
            yield* preparation.compute.release(preparation.key);
            return {
              ...receipt,
              signedAt: new Date(signedAt),
              signedRevision: { ...signedRevision },
            };
          }).pipe(Effect.uninterruptible),
        );
      }),
      release: Effect.fn(function* (preparationId, owner) {
        const current = yield* Ref.get(entries);
        if (current === undefined) return;
        const entry = HashMap.get(current, preparationId);
        if (entry._tag === "None" || entry.value.owner !== owner) return;
        yield* entry.value.lock.withPermit(
          Effect.gen(function* () {
            yield* Ref.update(entries, (active) => {
              if (active === undefined) return active;
              const stored = HashMap.get(active, preparationId);
              return stored._tag === "Some" && stored.value === entry.value
                ? HashMap.remove(active, preparationId)
                : active;
            });
            const state = yield* Ref.getAndSet(entry.value.state, undefined);
            if (state !== undefined && "compute" in state) yield* state.compute.release(state.key);
          }).pipe(Effect.uninterruptible),
        );
      }),
      prewarm: Effect.gen(function* () {
        const pdf = yield* core
          .create({ pages: [{ width: 240, height: 120 }] })
          .pipe(Effect.mapError(() => new LocalError({ code: "pdfPrepareFailed" })));
        yield* Effect.acquireUseRelease(
          documents.open(pdf),
          (revision) =>
            engine.withRevision(revision, (source) =>
              Effect.gen(function* () {
                const { prepared } = yield* local.prepare(
                  { key: revision.handle, revision: source },
                  {
                    options: {
                      session: { sessionId: PREWARM_SESSION, generation: 1 },
                      field: { kind: "create", name: "Prewarm", page: 0, rect: [12, 12, 132, 60] },
                      appearance: { kind: "visible" },
                      policy: "cades",
                    },
                    defaultLines: ["Prewarm", "e-CPF", "2026-01-01"],
                    date: "D:20260101000000Z",
                    contentsCapacity: 4096,
                  },
                );
                const { appendix, byteRange } = prepared;
                const [, firstLength, secondStart] = byteRange;
                yield* source.digest(
                  "SHA-256",
                  appendix.subarray(0, firstLength - source.byteLength),
                  appendix.subarray(secondStart - source.byteLength),
                );
                yield* source.check(appendix, (document) =>
                  document.signatures("verification").pipe(
                    Effect.andThen(document.changes(source.byteLength)),
                    Effect.mapError(() => new LocalError({ code: "pdfPrepareFailed" })),
                    Effect.asVoid,
                  ),
                );
              }),
            ),
          (revision) => documents.release(revision.handle).pipe(Effect.ignore),
        );
      }).pipe(Effect.withSpan("local.pdf.prewarm")),
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
