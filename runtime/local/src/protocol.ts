import {
  PdfCoreBoxSchema,
  PdfCorePrepareSignatureRequestSchema,
  PdfCoreRevisionChangesSchema,
  PdfCoreSignatureFieldsSchema,
} from "@signature-kit/pdf-core/config";
import { Schema } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Transferable from "effect/workers/Transferable";

export const PROTOCOL_VERSION = 2;
export const InstanceId = Schema.String.check(Schema.isUUID());
export type InstanceId = (typeof InstanceId)["Type"];

export const Handle = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
  ),
).pipe(Schema.brand("LocalDocumentHandle"));
export type Handle = (typeof Handle)["Type"];

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const RevisionRef = Schema.Struct({
  handle: Handle,
  digest: Sha256,
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

export const PdfPrepareOptionsSchema = Schema.Struct({
  session: A1SessionBinding,
  field: PdfCorePrepareSignatureRequestSchema.fields.field,
  appearance: PdfAppearance,
  policy: PdfSigningPolicy,
  reason: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
});
export type PdfPrepareOptions = (typeof PdfPrepareOptionsSchema)["Type"];

const PdfWidget = Schema.Union([
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
    sourceDigest: Sha256,
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
  sourceDigest: Sha256,
  signedRevision: RevisionRef,
  signedAt: Schema.Date,
  certificateFingerprint: Sha256,
  fieldName: Schema.String,
});
export type PdfReceipt = (typeof PdfReceipt)["Type"];

export const PdfVerifyOptionsSchema = Schema.Struct({
  trust: Schema.optional(Schema.NonEmptyArray(Schema.Uint8Array)),
  at: Schema.optional(Schema.Date),
});
export type PdfVerifyOptions = (typeof PdfVerifyOptionsSchema)["Type"];

const PdfSignatureVerification = Schema.Struct({
  fieldName: Schema.optional(Schema.String),
  integrity: Schema.Literals(["valid", "invalid", "unsupported"]),
  coverage: Schema.Struct({
    kind: Schema.Literals(["wholeFile", "partial", "invalid"]),
    bytesAfter: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  signer: Schema.optional(
    Schema.Struct({
      subject: A1Profile.fields.subjectName,
      holderKind: A1Profile.fields.holderKind,
    }),
  ),
  changes: Schema.optional(
    Schema.Struct({
      recognised: PdfCoreRevisionChangesSchema.fields.changes,
      unknown: PdfCoreRevisionChangesSchema.fields.changes,
      pageContentChanged: Schema.Boolean,
    }),
  ),
  trust: Schema.Literals(["notEvaluated", "trusted", "untrusted"]),
  revocation: Schema.Literals(["notChecked", "embeddedEvidence"]),
});
export type PdfSignatureVerification = (typeof PdfSignatureVerification)["Type"];
export const PdfVerificationReport = Schema.Struct({
  signatures: Schema.Array(PdfSignatureVerification),
});
export type PdfVerificationReport = (typeof PdfVerificationReport)["Type"];

export const LocalErrorCode = Schema.Literals([
  "staleHandle",
  "unknownHandle",
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
  "fieldNotFound",
  "fieldAmbiguous",
  "fieldSigned",
  "documentLocked",
  "preparationUnknown",
  "preparationStale",
  "certificateExpired",
  "certificateNotYetValid",
  "signatureTooLarge",
  "selfVerificationFailed",
]);
export type LocalErrorCode = (typeof LocalErrorCode)["Type"];

export const localErrorMessages = {
  staleHandle: "The document handle belongs to another runtime instance.",
  unknownHandle: "The document handle is no longer available.",
  invalidPkcs12: "The PKCS#12 file could not be read.",
  wrongPassword: "The PKCS#12 password is incorrect.",
  sessionClosed: "The A1 session is closed.",
  staleGeneration: "The A1 session changed.",
  protocolMismatch: "The local runtime protocol versions do not match.",
  workerUnavailable: "The local worker failed to respond.",
  runtimeClosed: "The local runtime is closed.",
  digestFailed: "The SHA-256 digest could not be computed.",
  keyImportFailed: "The A1 signing key could not be imported.",
  signFailed: "The A1 signing operation failed.",
  pdfReadFailed: "The PDF signature data could not be read.",
  pdfPrepareFailed: "The PDF could not be prepared for signing.",
  fieldNotFound: "The PDF signature field was not found.",
  fieldAmbiguous: "The PDF signature field or widget is ambiguous.",
  fieldSigned: "The PDF signature field is already signed.",
  documentLocked: "The PDF certification or a field lock forbids signing.",
  preparationUnknown: "The PDF signature preparation is no longer available.",
  preparationStale: "The PDF revision does not match the supplied revision reference.",
  certificateExpired: "The signing certificate has expired.",
  certificateNotYetValid: "The signing certificate is not yet valid.",
  signatureTooLarge: "The CMS signature exceeds the reserved PDF contents capacity.",
  selfVerificationFailed: "The signed PDF failed verification before export.",
} satisfies Record<LocalErrorCode, string>;

export class LocalError extends Schema.TaggedError<LocalError, { readonly brand: unique symbol }>()(
  "LocalError",
  { code: LocalErrorCode },
) {
  get message(): string {
    return localErrorMessages[this.code];
  }
}

const Version = Schema.Int.check(Schema.isGreaterThan(0));

export const LocalRpcs = RpcGroup.make(
  Rpc.make("Hello", {
    payload: { version: Version },
    success: Schema.Struct({ instanceId: InstanceId, version: Version }),
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
  Rpc.make("DocumentsRelease", {
    payload: { handle: Handle },
    error: LocalError,
  }),
  Rpc.make("A1Open", {
    payload: A1OpenInputSchema,
    success: A1SessionInfo,
    error: LocalError,
  }),
  Rpc.make("A1Close", { error: LocalError }),
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
);
