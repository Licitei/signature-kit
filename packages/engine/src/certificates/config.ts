import { Schema } from "effect";
import type { Redacted } from "effect";

const cnpjDigits = Schema.String.check(Schema.isPattern(/^\d{14}$/));
const cpfDigits = Schema.String.check(Schema.isPattern(/^\d{11}$/));
const sha256Hex: Schema.ConstraintDecoder<string> = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
);
const certificatePem: Schema.ConstraintDecoder<string> = Schema.String.check(
  Schema.isPattern(/-----BEGIN CERTIFICATE-----/),
);
const redactedPrivateKeyPem: Schema.ConstraintDecoder<Redacted.Redacted<string>> =
  Schema.RedactedFromValue(
    Schema.String.check(Schema.isPattern(/-----BEGIN (RSA )?PRIVATE KEY-----/)),
    { label: "signature-kit-private-key", disallowEncode: true },
  );

export const CertificateSubjectSchema = Schema.Struct({
  commonName: Schema.NullOr(Schema.String),
  organization: Schema.NullOr(Schema.String),
  organizationalUnit: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
  locality: Schema.NullOr(Schema.String),
  raw: Schema.String,
});
export type CertificateSubject = (typeof CertificateSubjectSchema)["Type"];

export const CertificateIssuerSchema = Schema.Struct({
  commonName: Schema.NullOr(Schema.String),
  organization: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
  raw: Schema.String,
});
export type CertificateIssuer = (typeof CertificateIssuerSchema)["Type"];

export const CertificateValiditySchema = Schema.Struct({
  notBefore: Schema.Date,
  notAfter: Schema.Date,
});
export type CertificateValidity = (typeof CertificateValiditySchema)["Type"];

export const BrazilianFieldsSchema = Schema.Struct({
  cnpj: Schema.NullOr(cnpjDigits),
  cpf: Schema.NullOr(cpfDigits),
});
export type BrazilianFields = (typeof BrazilianFieldsSchema)["Type"];

export const CertificateSchema = Schema.Struct({
  serialNumber: Schema.NonEmptyString,
  subject: CertificateSubjectSchema,
  issuer: CertificateIssuerSchema,
  validity: CertificateValiditySchema,
  fingerprint: sha256Hex,
  subjectAltName: Schema.NullOr(Schema.String),
  isValid: Schema.Boolean,
  brazilian: BrazilianFieldsSchema,
  certPem: certificatePem,
  certificateDer: Schema.Uint8Array,
  intermediateCertificates: Schema.Array(Schema.Uint8Array),
  publicKeyDer: Schema.Uint8Array,
  privateKeyPem: redactedPrivateKeyPem,
});
export type Certificate = (typeof CertificateSchema)["Type"];

export const CertificateErrorCodeSchema = Schema.Literals([
  "certificates.X509_PARSE_FAILED",
  "certificates.EMPTY_FILE",
  "certificates.INVALID_FORMAT",
  "certificates.INVALID_INPUT",
  "certificates.WRONG_PASSWORD",
  "certificates.UNSUPPORTED_ALGORITHM",
  "certificates.NO_CERTIFICATE",
  "certificates.NO_PRIVATE_KEY",
  "certificates.CORRUPTED_FILE",
  "certificates.DIGEST_FAILED",
  "certificates.UNKNOWN",
]);
export type CertificateErrorCode = typeof CertificateErrorCodeSchema.Type;
export const CertificateErrorCodeValue = {
  x509ParseFailed: "certificates.X509_PARSE_FAILED",
  emptyFile: "certificates.EMPTY_FILE",
  invalidFormat: "certificates.INVALID_FORMAT",
  invalidInput: "certificates.INVALID_INPUT",
  wrongPassword: "certificates.WRONG_PASSWORD",
  unsupportedAlgorithm: "certificates.UNSUPPORTED_ALGORITHM",
  noCertificate: "certificates.NO_CERTIFICATE",
  noPrivateKey: "certificates.NO_PRIVATE_KEY",
  corruptedFile: "certificates.CORRUPTED_FILE",
  digestFailed: "certificates.DIGEST_FAILED",
  unknown: "certificates.UNKNOWN",
} satisfies Record<string, CertificateErrorCode>;

export const CertificateOperationSchema = Schema.Literals([
  "pkcs12.parse",
  "x509.parse",
  "crypto.digest",
  "schema.decode",
]);
export type CertificateOperation = typeof CertificateOperationSchema.Type;
export const CertificateOperationValue = {
  pkcs12Parse: "pkcs12.parse",
  x509Parse: "x509.parse",
  cryptoDigest: "crypto.digest",
  schemaDecode: "schema.decode",
} satisfies Record<string, CertificateOperation>;

export const certificateErrorMessages = {
  "en-US": {
    "certificates.X509_PARSE_FAILED": "X.509 parsing failed.",
    "certificates.EMPTY_FILE": "Certificate file is empty (0 bytes).",
    "certificates.INVALID_FORMAT": "The file is not a PKCS#12 (.pfx/.p12) certificate.",
    "certificates.INVALID_INPUT": "Invalid signing input.",
    "certificates.WRONG_PASSWORD": "Wrong certificate password.",
    "certificates.UNSUPPORTED_ALGORITHM":
      "The certificate uses an unsupported encryption algorithm.",
    "certificates.NO_CERTIFICATE": "The file does not contain a certificate.",
    "certificates.NO_PRIVATE_KEY": "The file does not contain a private key.",
    "certificates.CORRUPTED_FILE": "The file is corrupted or not a valid PKCS#12 certificate.",
    "certificates.DIGEST_FAILED": "Failed to compute the certificate digest.",
    "certificates.UNKNOWN": "Unknown SignatureKit failure.",
  },
  "pt-BR": {
    "certificates.X509_PARSE_FAILED": "Não foi possível ler o certificado X.509.",
    "certificates.EMPTY_FILE": "O arquivo do certificado está vazio.",
    "certificates.INVALID_FORMAT": "O arquivo não é um certificado PKCS#12 (.pfx/.p12).",
    "certificates.INVALID_INPUT": "Entrada de assinatura inválida.",
    "certificates.WRONG_PASSWORD": "Senha do certificado incorreta.",
    "certificates.UNSUPPORTED_ALGORITHM":
      "O certificado usa um algoritmo de criptografia não suportado.",
    "certificates.NO_CERTIFICATE": "O arquivo não contém um certificado.",
    "certificates.NO_PRIVATE_KEY": "O arquivo não contém uma chave privada.",
    "certificates.CORRUPTED_FILE":
      "O arquivo está corrompido ou não é um certificado PKCS#12 válido.",
    "certificates.DIGEST_FAILED": "Não foi possível calcular o digest do certificado.",
    "certificates.UNKNOWN": "Falha desconhecida do SignatureKit.",
  },
} satisfies Record<"en-US" | "pt-BR", Record<CertificateErrorCode, string>>;

export class CertificateError extends Schema.TaggedError<
  CertificateError,
  { readonly brand: unique symbol }
>()("CertificateError", {
  code: CertificateErrorCodeSchema,
  reason: Schema.optional(Schema.String),
  operation: Schema.optional(CertificateOperationSchema),
  schemaName: Schema.optional(Schema.String),
  issueMessage: Schema.optional(Schema.String),
}) {
  get message(): string {
    return this.reason ?? certificateErrorMessages["en-US"][this.code];
  }
}
