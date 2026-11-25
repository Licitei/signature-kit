import { RevocationReport } from "./validation/config.js";
import {
  PdfCoreOperationSchema,
  PdfCoreBoxSchema,
  PdfCoreNewSignatureFieldsSchema,
  PdfCorePrepareSignatureRequestSchema,
  PdfCoreRevisionChangesSchema,
  PdfCoreSignatureFieldsSchema,
  PdfCoreValidationDataSchema,
} from "./wasm/config.js";
import { BrazilianFieldsSchema } from "./certificates/config.js";
import { Context, Schema } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Transferable from "effect/workers/Transferable";
import type { Effect } from "effect";
import { ComposeOptionsSchema, DocumentSchema } from "./composition/config.js";

export const RpcMethod = Schema.Literals([
  "Hello",
  "Prewarm",
  "DocumentsOpen",
  "DocumentsExport",
  "DocumentsDigest",
  "DocumentsRelease",
  "PdfInspect",
  "PdfCompose",
  "PdfRenderPage",
  "A1Open",
  "A1Close",
  "PdfSignatureFields",
  "PdfPrepare",
  "PdfConfirm",
  "PdfRelease",
  "PdfVerify",
  "PdfAddSignatureFields",
  "PdfCompare",
  "BatchPrepare",
  "BatchConfirm",
  "BatchCancel",
  "BatchRetry",
  "BatchSnapshot",
  "BatchEvents",
  "BatchRelease",
  "BatchDelete",
  "PdfAddValidationData",
  "PdfPrepareDocumentTimestamp",
  "PdfAddDocumentTimestamp",
]);
const SpanName = Schema.Union([
  Schema.TemplateLiteral([Schema.Literals(["local.client.", "local.worker."]), RpcMethod]),
  PdfCoreOperationSchema,
  Schema.Literals([
    "local.hello",
    "local.documents.open",
    "local.documents.export",
    "local.documents.release",
    "local.pdf.open",
    "local.pdf.inspect",
    "local.pdf.renderPage",
    "local.pdf.prepare",
    "local.pdf.prewarm",
    "local.pdf.confirm",
    "local.pdf.cms",
    "local.pdf.selfVerify",
    "local.pdf.decodeContents",
    "local.pdf.checkCms",
    "local.pdf.embed",
    "local.pdf.verify",
    "local.pdf.compare",
    "local.viewer.paintPage",
    "local.queue.pdf",
    "local.batch.item.prepare",
    "local.batch.item.confirm",
    "local.queue.raster",
    "local.a1.open",
    "local.a1.close",
    "local.a1.sign",
    "local.a1.parsePkcs12",
    "local.crypto.digest",
    "local.crypto.documentDigest",
    "local.crypto.importKey",
    "local.crypto.sign",
    "pdfCore.wasm.compile",
    "pdfCore.wasm.instantiate",
    "pdfCore.wasm.run",
    "pdfCore.wasm.decode",
    "pdfCore.wasm.copyIn",
    "pdfCore.wasm.copyOut",
    "pdfCore.lazy.supply",
    "pdfCore.lazy.plan",
  ]),
]);
export const Attribute = Schema.Union([
  Schema.Tuple([
    Schema.Literals([
      "byteLength",
      "certificateCount",
      "queueWaitMs",
      "signature_kit.wasm.input_bytes",
      "signature_kit.wasm.output_bytes",
      "signature_kit.wasm.result_bytes",
      "signature_kit.wasm.memory_bytes",
      "signature_kit.pdf.requested_pages",
    ]),
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ]),
  Schema.Tuple([Schema.Literal("policy"), Schema.Literals(["cades", "icpBrasilAdRbV11"])]),
  Schema.Tuple([Schema.Literal("holderKind"), Schema.Literals(["e-cpf", "e-cnpj", "other"])]),
  Schema.Tuple([Schema.Literal("rpc.system.name"), Schema.Literal("effect_rpc")]),
  Schema.Tuple([Schema.Literal("rpc.method"), RpcMethod]),
  Schema.Tuple([Schema.Literal("signature_kit.pdf_core.operation"), PdfCoreOperationSchema]),
]);
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SpanId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/));
const Nanoseconds = Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/));
const Outcome = Schema.Literals(["success", "failure", "interrupted"]);
export const TelemetrySpan = Schema.Struct({
  name: SpanName,
  traceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  spanId: SpanId,
  parentSpanId: Schema.optional(SpanId),
  kind: Schema.Literals(["internal", "server", "client", "producer", "consumer"]),
  startTime: Nanoseconds,
  endTime: Nanoseconds,
  outcome: Outcome,
  attributes: Schema.Array(Attribute).check(Schema.isMaxLength(32)),
  droppedAttributes: Count,
});
export type TelemetrySpan = (typeof TelemetrySpan)["Type"];

export const MAX_SPANS = 4096;
export const TelemetryBatch = Schema.Struct({
  spans: Schema.Array(TelemetrySpan).check(Schema.isMaxLength(MAX_SPANS)),
  bytes: Count,
  droppedSpans: Count,
  droppedAttributes: Count,
});
export type TelemetryBatch = (typeof TelemetryBatch)["Type"];

export class LocalTelemetry extends Context.Service<
  LocalTelemetry,
  {
    readonly snapshot: Effect.Effect<TelemetryBatch>;
    readonly drain: Effect.Effect<TelemetryBatch>;
    readonly receive: (batch: TelemetryBatch) => Effect.Effect<void>;
    readonly restore: (batch: TelemetryBatch) => Effect.Effect<void>;
  }
>()("@signature-kit/engine/LocalTelemetry") {}

export const PROTOCOL_VERSION = 7;
export const InstanceId = Schema.String.check(Schema.isUUID());
export type InstanceId = (typeof InstanceId)["Type"];

export const Handle = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
  ),
).pipe(Schema.brand("LocalDocumentHandle"));
export type Handle = (typeof Handle)["Type"];

export const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const RevisionRef = Schema.Struct({
  handle: Handle,
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type RevisionRef = (typeof RevisionRef)["Type"];

export const A1Profile = Schema.Struct({
  holderKind: Schema.Literals(["e-cpf", "e-cnpj", "other"]),
  subjectName: Schema.String,
  notBefore: Schema.Date,
  notAfter: Schema.Date,
  issuerName: Schema.String,
  fingerprintSha256: Sha256,
});
export type A1Profile = (typeof A1Profile)["Type"];

export const A1SessionInfo = Schema.Struct({
  sessionId: Schema.String.check(Schema.isUUID()),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  profile: A1Profile,
});
export type A1SessionInfo = (typeof A1SessionInfo)["Type"];

export const A1OpenInputSchema = Schema.Struct({
  pfx: Schema.RedactedFromValue(Transferable.Uint8Array),
  password: Schema.RedactedFromValue(Schema.String),
});
export type A1OpenInput = (typeof A1OpenInputSchema)["Type"];

const PageIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PdfRotation = Schema.Literals([0, 90, 180, 270]);
const PdfBox = Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]);
const PixelSize = Schema.Int.check(Schema.isGreaterThan(0));

export const PdfInspection = Schema.Struct({
  pageCount: PageIndex,
  pages: Schema.Array(Schema.Struct({ mediaBox: PdfBox, cropBox: PdfBox, rotate: Schema.Int })),
});
export type PdfInspection = (typeof PdfInspection)["Type"];

export const PdfRenderInputSchema = Schema.Struct({
  handle: Handle,
  pageIndex: PageIndex,
  scale: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(64)),
  rotation: Schema.optional(PdfRotation),
});
export type PdfRenderInput = (typeof PdfRenderInputSchema)["Type"];

export const PdfViewport = Schema.Struct({
  width: PixelSize,
  height: PixelSize,
  transform: Schema.Tuple([
    Schema.Finite,
    Schema.Finite,
    Schema.Finite,
    Schema.Finite,
    Schema.Finite,
    Schema.Finite,
  ]),
});
export type PdfViewport = (typeof PdfViewport)["Type"];

export const PdfPagePixels = Schema.Struct({
  ...PdfViewport.fields,
  pixels: Transferable.Uint8Array,
});
export type PdfPagePixels = (typeof PdfPagePixels)["Type"];

export const A1SessionBinding = A1SessionInfo.mapFields(({ sessionId, generation }) => ({
  sessionId,
  generation,
}));
export type A1SessionBinding = (typeof A1SessionBinding)["Type"];

export const PreparationId = Sha256.pipe(Schema.brand("LocalPdfPreparationId"));
export type PreparationId = (typeof PreparationId)["Type"];

const PdfSigningPolicy = Schema.Literals(["cades", "icpBrasilAdRbV11"]);
const PdfAppearance = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("visible"),
    lines: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(12))),
  }),
]);

export type PdfSignatureFields = (typeof PdfCoreSignatureFieldsSchema)["Type"];
export const PdfValidationDataSchema = PdfCoreValidationDataSchema;
export type PdfValidationData = (typeof PdfValidationDataSchema)["Type"];

export type PdfNewSignatureFields = (typeof PdfCoreNewSignatureFieldsSchema)["Type"];

export const PdfPrepareOptionsSchema = Schema.Struct({
  session: A1SessionBinding,
  field: PdfCorePrepareSignatureRequestSchema.fields.field,
  appearance: PdfAppearance,
  policy: PdfSigningPolicy,
  reason: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  docMdp: PdfCorePrepareSignatureRequestSchema.fields.docMdp,
});
export type PdfPrepareOptions = (typeof PdfPrepareOptionsSchema)["Type"];

export const PdfWidget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("invisible") }),
  Schema.Struct({
    kind: Schema.Literal("visible"),
    page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    rect: PdfCoreBoxSchema,
  }),
]);
export type PdfWidget = (typeof PdfWidget)["Type"];

export const PdfPreparation = Schema.Struct({
  preparationId: PreparationId,
  previewRevision: RevisionRef,
  widget: PdfWidget,
  binding: Schema.Struct({
    certificateFingerprint: Sha256,
    session: A1SessionBinding,
    fieldName: Schema.String,
    policy: PdfSigningPolicy,
  }),
});
export type PdfPreparation = (typeof PdfPreparation)["Type"];

export const PdfReceipt = Schema.Struct({
  receiptId: Sha256,
  preparationId: PreparationId,
  signedRevision: RevisionRef,
  signedAt: Schema.Date,
  certificateFingerprint: Sha256,
  fieldName: Schema.String,
});
export type PdfReceipt = (typeof PdfReceipt)["Type"];

export const PdfVerifyOptionsSchema = Schema.Struct({
  trust: Schema.optional(Schema.Array(Schema.Uint8Array)),
  tsaTrust: Schema.optional(Schema.Array(Schema.Uint8Array)),
  at: Schema.optional(Schema.Date),
});
export type PdfVerifyOptions = (typeof PdfVerifyOptionsSchema)["Type"];

const PdfReportedChanges = Schema.Struct({
  recognised: PdfCoreRevisionChangesSchema.fields.changes,
  unknown: PdfCoreRevisionChangesSchema.fields.changes,
  recognisedObjectCount: Count,
  unknownObjectCount: Count,
  pageContentChanged: Schema.Boolean,
});

export const PdfLtvLevel = Schema.Literals(["B-B", "B-T", "B-LT", "B-LTA"]);
export type PdfLtvLevel = (typeof PdfLtvLevel)["Type"];

const PdfSignatureVerification = Schema.Struct({
  fieldName: Schema.optional(Schema.String),
  kind: Schema.Literals(["signature", "documentTimestamp"]),
  integrity: Schema.Literals(["valid", "invalid", "unsupported"]),
  coverage: Schema.Struct({
    kind: Schema.Literals(["wholeFile", "partial", "invalid"]),
    revisionEnd: Schema.optional(Count),
    bytesAfter: Schema.optional(Count),
  }),
  signer: Schema.optional(
    Schema.Struct({
      commonName: Schema.NullOr(Schema.String),
      brazilian: BrazilianFieldsSchema,
      holderKind: A1Profile.fields.holderKind,
    }),
  ),
  claimedSigningTime: Schema.optional(Schema.Date),
  timestampEvidence: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("absent") }),
    Schema.Struct({
      kind: Schema.Literal("unverified"),
      reason: Schema.Literals(["tsaTrustMissing", "invalidToken"]),
    }),
    Schema.Struct({ kind: Schema.Literal("verified"), genTime: Schema.Date }),
  ]),
  evaluationTime: Schema.Struct({
    at: Schema.Date,
    source: Schema.Literals(["clock", "caller", "signatureTimestamp", "documentTimestamp"]),
  }),
  changes: Schema.optional(PdfReportedChanges),
  mdp: Schema.optional(
    Schema.Struct({
      docMdp: PdfCorePrepareSignatureRequestSchema.fields.docMdp,
      fieldLocks: PdfCoreRevisionChangesSchema.fields.policies.value.fields.fieldLocks,
      permittedChanges: PdfCoreRevisionChangesSchema.fields.changes,
      violations: PdfCoreRevisionChangesSchema.fields.changes,
      pageContentViolation: Schema.Boolean,
    }),
  ),
  trust: Schema.Literals(["notEvaluated", "trusted", "untrusted"]),
  revocation: RevocationReport,
  ltvLevel: Schema.optional(PdfLtvLevel),
});
export type PdfSignatureVerification = (typeof PdfSignatureVerification)["Type"];
const pdfSignatureVerificationCodec: Schema.Codec<PdfSignatureVerification> =
  PdfSignatureVerification;
export const PdfVerificationReport = Schema.Struct({
  signatures: Schema.Array(pdfSignatureVerificationCodec),
});
export type PdfVerificationReport = (typeof PdfVerificationReport)["Type"];

export const ComparisonReport = Schema.Struct({
  sentPreserved: Schema.Boolean,
  sentRevisionIndex: Schema.optional(Count),
  signatures: Schema.Array(pdfSignatureVerificationCodec),
  changes: Schema.optional(PdfReportedChanges),
  verdict: Schema.Literals([
    "signedAsExpected",
    "differentDocument",
    "integrityFailure",
    "modifiedAfterSigning",
    "unknownChanges",
    "untrustedSignatures",
    "noSignatures",
  ]),
  reasons: Schema.Array(
    Schema.Literals([
      "sentRevisionMissing",
      "invalidSignature",
      "pageContentChanged",
      "unexpectedChange",
      "mdpViolation",
      "trailingUnparsedBytes",
      "unknownObjects",
      "untrustedSignature",
      "revokedSignature",
      "noNewSignatures",
    ]),
  ),
});
export type ComparisonReport = (typeof ComparisonReport)["Type"];

export const exportComparisonReport = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(ComparisonReport), { space: 2 }),
);

export const LocalErrorCode = Schema.Literals([
  "staleHandle",
  "unknownHandle",
  "pdfInspectFailed",
  "pdfComposeFailed",
  "pdfRenderFailed",
  "invalidPageIndex",
  "renderTooLarge",
  "canvasUnavailable",
  "invalidPkcs12",
  "wrongPassword",
  "sessionClosed",
  "staleGeneration",
  "protocolMismatch",
  "workerUnavailable",
  "runtimeClosed",
  "digestFailed",
  "keyImportFailed",
  "signFailed",
  "pdfReadFailed",
  "pdfPrepareFailed",
  "validationDataFailed",
  "documentTimestampFailed",
  "fieldNotFound",
  "fieldAmbiguous",
  "fieldSigned",
  "documentLocked",
  "preparationUnknown",
  "preparationStale",
  "certificateExpired",
  "certificateNotYetValid",
  "signatureTooLarge",
  "batchUnknown",
  "batchTransition",
  "batchSelection",
  "itemExceedsBudget",
  "batchBudgetFull",
  "batchResumeUnavailable",
  "batchLocked",
  "batchStorageFailed",
  "batchStorageQuota",
  "batchStorageCorrupt",
  "batchExecutionFailed",
  "batchResumeMismatch",
  "selfVerificationFailed",
]);
export type LocalErrorCode = (typeof LocalErrorCode)["Type"];

export const localErrorMessages = {
  staleHandle: "The document handle belongs to another runtime instance.",
  unknownHandle: "The document handle is no longer available.",
  pdfComposeFailed: "The PDF could not be composed.",
  pdfInspectFailed: "The PDF page geometry could not be read.",
  pdfRenderFailed: "The PDF page could not be rendered.",
  invalidPageIndex: "The PDF page index is outside the document.",
  renderTooLarge: "The PDF page exceeds the raster size limit at this scale.",
  canvasUnavailable: "The page pixels could not be painted into the canvas.",
  invalidPkcs12: "The PKCS#12 file could not be read.",
  wrongPassword: "The PKCS#12 password is incorrect.",
  sessionClosed: "The A1 session is closed.",
  staleGeneration: "The A1 session changed.",
  protocolMismatch: "The local runtime protocol versions do not match.",
  workerUnavailable: "The local worker failed to respond.",
  runtimeClosed: "The local runtime is closed.",
  digestFailed: "The document digest could not be computed.",
  keyImportFailed: "The A1 signing key could not be imported.",
  signFailed: "The A1 signing operation failed.",
  pdfReadFailed: "The PDF signature data could not be read.",
  pdfPrepareFailed: "The PDF could not be prepared for signing.",
  validationDataFailed: "The PDF validation data could not be appended.",
  documentTimestampFailed:
    "The document timestamp could not be prepared or its token does not match.",
  fieldNotFound: "The PDF signature field was not found.",
  fieldAmbiguous: "The PDF signature field or widget is ambiguous.",
  fieldSigned: "The PDF signature field is already signed.",
  documentLocked: "The PDF certification or a field lock forbids signing.",
  preparationUnknown: "The PDF signature preparation is no longer available.",
  preparationStale: "The PDF revision does not match the supplied revision reference.",
  certificateExpired: "The signing certificate has expired.",
  certificateNotYetValid: "The signing certificate is not yet valid.",
  signatureTooLarge: "The CMS signature exceeds the reserved PDF contents capacity.",
  batchUnknown: "The batch is no longer available.",
  batchTransition: "The requested transition is unavailable in the current batch state.",
  batchSelection: "The selection does not match the eligible batch items.",
  itemExceedsBudget: "The item exceeds the total batch byte budget.",
  batchBudgetFull: "The remaining batch byte budget cannot hold this item for review.",
  batchResumeUnavailable: "This worker does not have batch persistence enabled.",
  batchLocked: "Another runtime owns the batch resume record.",
  batchStorageFailed: "The batch resume record could not be read or written.",
  batchStorageQuota: "The browser storage quota was exceeded.",
  batchExecutionFailed: "The batch stopped after an unexpected execution fault.",
  batchStorageCorrupt: "The batch resume record failed integrity validation.",
  batchResumeMismatch: "The supplied documents or template do not match the saved batch.",
  selfVerificationFailed: "The signed PDF failed verification before export.",
} satisfies Record<LocalErrorCode, string>;

export class LocalError extends Schema.TaggedError<LocalError, { readonly brand: unique symbol }>()(
  "LocalError",
  { code: LocalErrorCode, pdfCode: Schema.optional(Schema.String) },
) {
  get message(): string {
    return localErrorMessages[this.code];
  }
}

export const PdfComposeInputSchema = Schema.Struct({
  document: DocumentSchema,
  options: Schema.optional(ComposeOptionsSchema),
});
export type PdfComposeInput = typeof PdfComposeInputSchema.Type;

const NonEmptyText = Schema.String.check(Schema.isMinLength(1));
const PositiveCount = Schema.Int.check(Schema.isGreaterThan(0));
export const BatchId = Schema.String.check(Schema.isUUID());
export const BatchConfigSchema = Schema.Struct({
  concurrency: PositiveCount.check(Schema.isLessThanOrEqualTo(64)),
  queueCapacity: PositiveCount,
  byteBudget: PositiveCount,
  eventCapacity: PositiveCount,
});
export type BatchConfig = typeof BatchConfigSchema.Type;

export const BatchTemplate = Schema.Struct({
  ...PdfPrepareOptionsSchema.fields,
  field: Schema.Union([
    ...PdfPrepareOptionsSchema.fields.field.members,
    Schema.Struct({ kind: Schema.Literal("anchor"), name: NonEmptyText, anchor: NonEmptyText }),
  ]),
}).mapFields(({ session: _session, ...fields }) => fields);
export const BatchDocument = Schema.Struct({
  itemId: NonEmptyText,
  revision: RevisionRef,
  anchors: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ page: PageIndex, rect: PdfCoreBoxSchema })),
  ),
});
export const BatchPrepareInputSchema = Schema.Struct({
  documents: Schema.NonEmptyArray(BatchDocument),
  template: BatchTemplate,
  session: A1SessionBinding,
  resumeId: Schema.optional(BatchId),
});
export type BatchPrepareInput = typeof BatchPrepareInputSchema.Type;

export const BatchSelection = Schema.NonEmptyArray(
  Schema.Struct({ itemId: NonEmptyText, preparationId: PreparationId }),
);
export type BatchSelection = typeof BatchSelection.Type;
export const BatchItemIds = Schema.NonEmptyArray(NonEmptyText);
export type BatchItemIds = typeof BatchItemIds.Type;

export const BatchState = Schema.Literals([
  "preparing",
  "reviewing",
  "confirming",
  "draining",
  "completed",
  "cancelled",
  "failed",
]);
export type BatchState = typeof BatchState.Type;
const BatchItemState = Schema.Literals([
  "pending",
  "ready",
  "needsAttention",
  "queued",
  "signing",
  "signed",
  "failed",
  "cancelled",
  "skipped",
]);
export const BatchItem = Schema.Struct({
  itemId: NonEmptyText,
  state: BatchItemState,
  attemptId: Schema.optional(Schema.String.check(Schema.isUUID())),
  preparation: Schema.optional(PdfPreparation),
  receipt: Schema.optional(PdfReceipt),
  reason: Schema.optional(LocalErrorCode),
});
export type BatchItem = typeof BatchItem.Type;
const BatchProgress = Schema.Struct({
  signed: Count,
  failed: Count,
  cancelled: Count,
  total: Count,
  retainedBytes: Count,
  peakBytes: Count,
});
export type BatchProgress = typeof BatchProgress.Type;
export const BatchSnapshot = Schema.Struct({
  batchId: BatchId,
  seq: Count,
  state: BatchState,
  signingWorkers: Count,
  items: Schema.Array(BatchItem),
  progress: BatchProgress,
  reason: Schema.optional(LocalErrorCode),
});
export type BatchSnapshot = typeof BatchSnapshot.Type;
export const BatchEventSchema = Schema.Union([
  Schema.TaggedStruct("snapshot", { seq: Count, snapshot: BatchSnapshot }),
  Schema.TaggedStruct("itemStateChanged", { seq: Count, item: BatchItem }),
  Schema.TaggedStruct("progress", { seq: Count, progress: BatchProgress }),
  Schema.TaggedStruct("batchStateChanged", {
    seq: Count,
    state: BatchState,
    reason: Schema.optional(LocalErrorCode),
  }),
]);
export type BatchEvent = typeof BatchEventSchema.Type;

const Version = Schema.Int.check(Schema.isGreaterThan(0));

export const LocalRpcs = RpcGroup.make(
  Rpc.make("Hello", {
    payload: { version: Version },
    success: Schema.Struct({ instanceId: InstanceId, version: Version, telemetry: Schema.Boolean }),
    error: LocalError,
  }),
  Rpc.make("DocumentsOpen", {
    payload: { bytes: Transferable.Uint8Array },
    success: RevisionRef,
    error: LocalError,
  }),
  Rpc.make("DocumentsExport", {
    payload: { handle: Handle },
    success: Transferable.Uint8Array,
    error: LocalError,
  }),
  Rpc.make("DocumentsDigest", {
    payload: { revision: RevisionRef },
    success: Sha256,
    error: LocalError,
  }),
  Rpc.make("DocumentsRelease", {
    payload: { handle: Handle },
    error: LocalError,
  }),
  Rpc.make("PdfCompose", {
    payload: PdfComposeInputSchema,
    success: RevisionRef,
    error: LocalError,
  }).annotate(Rpc.ParseOptions, { onExcessProperty: "error" }),
  Rpc.make("PdfInspect", {
    payload: { handle: Handle },
    success: PdfInspection,
    error: LocalError,
  }),
  Rpc.make("PdfRenderPage", {
    payload: PdfRenderInputSchema,
    success: PdfPagePixels,
    error: LocalError,
  }),
  Rpc.make("A1Open", {
    payload: A1OpenInputSchema,
    success: A1SessionInfo,
    error: LocalError,
  }),
  Rpc.make("A1Close", { error: LocalError }),
  Rpc.make("BatchPrepare", {
    payload: BatchPrepareInputSchema,
    success: BatchSnapshot,
    error: LocalError,
  }),
  Rpc.make("BatchConfirm", {
    payload: { batchId: BatchId, selection: BatchSelection },
    success: BatchSnapshot,
    error: LocalError,
  }),
  Rpc.make("BatchCancel", {
    payload: { batchId: BatchId },
    success: BatchSnapshot,
    error: LocalError,
  }),
  Rpc.make("BatchRetry", {
    payload: { batchId: BatchId, itemIds: BatchItemIds },
    success: BatchSnapshot,
    error: LocalError,
  }),
  Rpc.make("BatchSnapshot", {
    payload: { batchId: BatchId },
    success: BatchSnapshot,
    error: LocalError,
  }),
  Rpc.make("BatchEvents", {
    payload: { batchId: BatchId },
    stream: true,
    success: BatchEventSchema,
    error: LocalError,
  }),
  Rpc.make("BatchRelease", {
    payload: { batchId: BatchId },
    success: BatchSnapshot,
    error: LocalError,
  }),
  Rpc.make("BatchDelete", { payload: { batchId: BatchId }, error: LocalError }),
  Rpc.make("TelemetryDrain", { success: TelemetryBatch }),
  Rpc.make("Prewarm", { error: LocalError }),
  Rpc.make("PdfSignatureFields", {
    payload: { revision: RevisionRef },
    success: PdfCoreSignatureFieldsSchema,
    error: LocalError,
  }),
  Rpc.make("PdfPrepare", {
    payload: { revision: RevisionRef, options: PdfPrepareOptionsSchema },
    success: PdfPreparation,
    error: LocalError,
  }),
  Rpc.make("PdfConfirm", {
    payload: { preparationId: PreparationId },
    success: PdfReceipt,
    error: LocalError,
  }),
  Rpc.make("PdfRelease", {
    payload: { preparationId: PreparationId },
    error: LocalError,
  }),
  Rpc.make("PdfVerify", {
    payload: { revision: RevisionRef, options: PdfVerifyOptionsSchema },
    success: PdfVerificationReport,
    error: LocalError,
  }),
  Rpc.make("PdfAddSignatureFields", {
    payload: { revision: RevisionRef, fields: PdfCoreNewSignatureFieldsSchema },
    success: RevisionRef,
    error: LocalError,
  }),
  Rpc.make("PdfAddValidationData", {
    payload: { revision: RevisionRef, evidence: PdfValidationDataSchema },
    success: RevisionRef,
    error: LocalError,
  }),
  Rpc.make("PdfPrepareDocumentTimestamp", {
    payload: { revision: RevisionRef },
    success: Schema.Uint8Array,
    error: LocalError,
  }),
  Rpc.make("PdfAddDocumentTimestamp", {
    payload: { revision: RevisionRef, token: Schema.Uint8Array },
    success: RevisionRef,
    error: LocalError,
  }),
  Rpc.make("PdfCompare", {
    payload: { sent: RevisionRef, returned: RevisionRef, options: PdfVerifyOptionsSchema },
    success: ComparisonReport,
    error: LocalError,
  }),
);
