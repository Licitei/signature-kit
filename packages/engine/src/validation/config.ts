import { Schema } from "effect";

export const RevocationReason = Schema.Literals([
  "untrustedIssuer",
  "malformedEvidence",
  "invalidSignature",
  "unauthorizedResponder",
  "outsideValidity",
  "certificateMismatch",
  "unsupportedScope",
]);
export const RevocationVerdict = Schema.Union([
  Schema.Struct({ status: Schema.Literal("good") }),
  Schema.Struct({ status: Schema.Literal("unknown") }),
  Schema.Struct({
    status: Schema.Literal("revoked"),
    at: Schema.Date,
    reason: Schema.optional(Schema.Int),
  }),
]);
export const RevocationReport = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("notChecked") }),
  Schema.Struct({
    kind: Schema.Literal("embeddedEvidence"),
    ocspCount: Schema.Int,
    crlCount: Schema.Int,
    reasons: Schema.Array(RevocationReason),
  }),
  Schema.Struct({
    kind: Schema.Literal("verified"),
    source: Schema.Literals(["ocsp", "crl"]),
    result: RevocationVerdict,
  }),
]);
export type RevocationReport = typeof RevocationReport.Type;

export class RevocationError extends Schema.TaggedError<
  RevocationError,
  { readonly brand: unique symbol }
>()("RevocationError", {
  code: RevocationReason,
}) {}
