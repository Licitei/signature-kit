import { Schema } from "effect";

const Timestamp = Schema.Finite;

export const ToolId = Schema.Literals(["verify", "certificate", "xml", "pdfcore"]);
export type ToolId = typeof ToolId.Type;

export const PdfSignatureReport = Schema.Struct({
  index: Schema.Int,
  intact: Schema.Boolean,
  coverage: Schema.Boolean,
  coversFileEnd: Schema.Boolean,
  signer: Schema.NullOr(Schema.String),
  cpf: Schema.NullOr(Schema.String),
  cnpj: Schema.NullOr(Schema.String),
  issuer: Schema.NullOr(Schema.String),
  validFrom: Schema.NullOr(Timestamp),
  validTo: Schema.NullOr(Timestamp),
  declaredAt: Schema.NullOr(Timestamp),
  format: Schema.NullOr(Schema.String),
});
export type PdfSignatureReport = typeof PdfSignatureReport.Type;

export const CertificateStatus = Schema.Literals(["notYetValid", "valid", "expired"]);
export const CertificateReport = Schema.Struct({
  holder: Schema.String,
  cpf: Schema.NullOr(Schema.String),
  cnpj: Schema.NullOr(Schema.String),
  organization: Schema.NullOr(Schema.String),
  issuer: Schema.String,
  issuerOrganization: Schema.NullOr(Schema.String),
  serialNumber: Schema.String,
  fingerprint: Schema.String,
  validFrom: Timestamp,
  validTo: Timestamp,
  status: CertificateStatus,
  daysUntilExpiry: Schema.Int,
  elapsed: Schema.Finite,
  chainLength: Schema.Int,
});
export type CertificateReport = typeof CertificateReport.Type;

export const XmlSignReport = Schema.Struct({
  xml: Schema.String,
  signer: Schema.String,
  verified: Schema.Boolean,
  signatureCount: Schema.Int,
  referenceUris: Schema.Array(Schema.String),
});
export type XmlSignReport = typeof XmlSignReport.Type;

const Run = Schema.Int;
export const PdfVerifiedFields = { run: Run, reports: Schema.Array(PdfSignatureReport) };
export const PdfVerified = Schema.TaggedStruct("PdfVerified", PdfVerifiedFields);
export const CertificateReadFields = { run: Run, report: CertificateReport };
export const CertificateRead = Schema.TaggedStruct("CertificateRead", CertificateReadFields);
export const XmlPreviewLine = Schema.Struct({
  id: Schema.String,
  added: Schema.Boolean,
  text: Schema.String,
});
export const TextLine = Schema.Struct({ id: Schema.String, text: Schema.String });
export const PdfExtractReport = Schema.Struct({
  pageCount: Schema.Int,
  characters: Schema.Int,
  extractMillis: Schema.Finite,
  renderMillis: Schema.NullOr(Schema.Finite),
  firstPage: Schema.String,
  image: Schema.NullOr(Schema.Uint8Array),
});
export const PdfExtractedFields = {
  run: Run,
  pageCount: Schema.Int,
  characters: Schema.Int,
  extractMillis: Schema.Finite,
  renderMillis: Schema.NullOr(Schema.Finite),
  lines: Schema.Array(TextLine),
  image: Schema.NullOr(Schema.String),
};
export const PdfExtracted = Schema.TaggedStruct("PdfExtracted", PdfExtractedFields);
export const XmlSignedFields = {
  run: Run,
  preview: Schema.Array(XmlPreviewLine),
  url: Schema.String,
  fileName: Schema.String,
  bytes: Schema.Int,
  signer: Schema.String,
  verified: Schema.Boolean,
  referenceUris: Schema.Array(Schema.String),
};
export const XmlSigned = Schema.TaggedStruct("XmlSigned", XmlSignedFields);
export const ToolFailedFields = { tool: ToolId, run: Run, message: Schema.String };
export const ToolFailed = Schema.TaggedStruct("ToolFailed", ToolFailedFields);
