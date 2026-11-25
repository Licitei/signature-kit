import { Schema } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Transferable from "effect/workers/Transferable";

export const PROTOCOL_VERSION = 1;
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
);
