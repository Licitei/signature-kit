import type { CmsError, CmsHashAlgorithm } from "@signature-kit/cms/config";
import { IcpBrasilPadesPolicy } from "@signature-kit/cms/icp-brasil";
import { createDetachedSignedData } from "@signature-kit/cms/sign";
import type { PdfCore } from "@signature-kit/pdf-core/pdf-core";
import { signatures } from "@signature-kit/signatures";
import type { Signatures, SignatureAlgorithm, SignatureKitError } from "@signature-kit/signatures";
import { Effect, Match, Schema } from "effect";
import {
  PdfError,
  PdfErrorCodeValue,
  PdfOperationValue,
  PdfSigningRequestSchema,
} from "./config.js";
import type { PdfSigningRequest } from "./config.js";
import { bytesToHex, encodeAscii, replaceRange } from "./bytes.js";
import { preparePdfByteRange } from "./byte-range.js";
import { addSignaturePlaceholder } from "./placeholder.js";

const rsaSha1SignatureAlgorithm: SignatureAlgorithm = "rsa-sha1";
const rsaSha256SignatureAlgorithm: SignatureAlgorithm = "rsa-sha256";
const rsaSha512SignatureAlgorithm: SignatureAlgorithm = "rsa-sha512";

const signatureAlgorithmForHash = (
  hashAlgorithm: CmsHashAlgorithm,
): Effect.Effect<SignatureAlgorithm, PdfError> =>
  Match.value(hashAlgorithm).pipe(
    Match.when("sha1", () => Effect.succeed(rsaSha1SignatureAlgorithm)),
    Match.when("sha256", () => Effect.succeed(rsaSha256SignatureAlgorithm)),
    Match.when("sha512", () => Effect.succeed(rsaSha512SignatureAlgorithm)),
    Match.when("sha384", () =>
      Effect.fail(
        new PdfError({
          code: PdfErrorCodeValue.signFailed,
          retryable: false,
          reason: `PDF signing does not support ${hashAlgorithm} with the current signer backend.`,
          operation: PdfOperationValue.sign,
        }),
      ),
    ),
    Match.exhaustive,
  );

export const signPdf = (
  input: PdfSigningRequest,
): Effect.Effect<Uint8Array, PdfError | CmsError | SignatureKitError, Signatures | PdfCore> =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(PdfSigningRequestSchema)(input).pipe(
      Effect.mapError(
        (issue) =>
          new PdfError({
            code: PdfErrorCodeValue.invalidBuilderInput,
            retryable: false,
            reason: "PDF signing request failed schema validation.",
            operation: PdfOperationValue.sign,
            issueMessage: String(issue),
          }),
      ),
    );
    const hashAlgorithm = request.hashAlgorithm ?? "sha256";
    const signatureAlgorithm = yield* signatureAlgorithmForHash(hashAlgorithm);
    yield* Effect.annotateCurrentSpan({
      "signature_kit.pdf.bytes": request.pdf.byteLength,
      "signature_kit.hash.algorithm": hashAlgorithm,
      "signature_kit.signature.policy": request.policy ?? "pades-ades",
      "signature_kit.signature.timestamped": request.timestamp !== undefined,
    });
    const placeholderPdf = yield* addSignaturePlaceholder(request);
    const prepared = yield* preparePdfByteRange(placeholderPdf).pipe(
      Effect.withSpan("pdf.byteRange.prepare", {
        attributes: { "signature_kit.pdf.bytes": placeholderPdf.byteLength },
      }),
    );
    const [certificate, signingKey] = yield* Effect.all(
      [signatures.certificate(), signatures.importSigningKey(signatureAlgorithm)],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.withSpan("pdf.signer.load", {
        attributes: { "signature_kit.signature.algorithm": signatureAlgorithm },
      }),
    );
    const icpBrasil =
      request.icpBrasil ??
      (request.policy === "pades-icp-brasil" ? IcpBrasilPadesPolicy.adRbV11 : undefined);
    const cms = yield* createDetachedSignedData({
      content: prepared.signedData,
      signingKey,
      certificateDer: certificate.certificateDer,
      chainDer: certificate.intermediateCertificates,
      hashAlgorithm,
      icpBrasil,
      timestamp: request.timestamp,
    }).pipe(
      Effect.withSpan("pdf.cms.create", {
        attributes: {
          "signature_kit.hash.algorithm": hashAlgorithm,
          "signature_kit.pdf.signed_bytes": prepared.signedData.byteLength,
          "signature_kit.signature.icp_brasil": icpBrasil !== undefined,
        },
      }),
    );
    const signatureHex = bytesToHex(cms);
    if (signatureHex.length > prepared.placeholderLength) {
      return yield* new PdfError({
        code: PdfErrorCodeValue.signatureTooLarge,
        retryable: false,
        reason: `CMS signature exceeds PDF placeholder length: ${signatureHex.length} > ${prepared.placeholderLength}.`,
        operation: PdfOperationValue.sign,
      });
    }

    const paddedSignature = `<${signatureHex}${"0".repeat(prepared.placeholderLength - signatureHex.length)}>`;
    const signed = yield* Effect.sync(() =>
      replaceRange(
        prepared.pdf,
        prepared.contentsStart,
        prepared.contentsEnd + 1,
        encodeAscii(paddedSignature),
      ),
    ).pipe(
      Effect.withSpan("pdf.contents.embed", {
        attributes: {
          "signature_kit.pdf.contents_bytes": prepared.placeholderLength,
          "signature_kit.pdf.cms_bytes": cms.byteLength,
        },
      }),
    );
    yield* Effect.annotateCurrentSpan("signature_kit.pdf.output_bytes", signed.byteLength);
    return signed;
  }).pipe(Effect.withSpan(PdfOperationValue.sign));
