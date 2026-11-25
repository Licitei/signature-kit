import { extractBrazilianFields, parseX509 } from "@signature-kit/certificates";
import { inspectDetachedSignedData } from "@signature-kit/cms/inspect";
import { extractPdfSignatures } from "@signature-kit/pdf/byte-range";
import type { PdfByteRange } from "@signature-kit/pdf/byte-range";
import { verifyPdfSignatures } from "@signature-kit/pdf/verify";
import { Effect, Option } from "effect";
import type { PdfSignatureReport } from "./tool-config.js";
import { VerifyWorkerRequests } from "./tool-rpc.js";

const objectWindow = 8192;
const declaredDate =
  /\/M\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/;

export const declaredSigningTime = (pdf: Uint8Array, byteRange: PdfByteRange): number | null => {
  const decoder = new TextDecoder("latin1");
  const contentsStart = byteRange[0] + byteRange[1];
  const contentsEnd = byteRange[2];
  const before = decoder.decode(
    pdf.subarray(Math.max(0, contentsStart - objectWindow), contentsStart),
  );
  const after = decoder.decode(
    pdf.subarray(contentsEnd, Math.min(pdf.byteLength, contentsEnd + objectWindow)),
  );
  const objectStart = before.lastIndexOf(" obj");
  const objectEnd = after.indexOf("endobj");
  const dictionary = `${objectStart === -1 ? before : before.slice(objectStart)} ${objectEnd === -1 ? after : after.slice(0, objectEnd)}`;
  const match = declaredDate.exec(dictionary);
  if (match === null) return null;
  const part = (index: number, fallback: number) => {
    const value = match[index];
    return value === undefined ? fallback : Number(value);
  };
  const utc = Date.UTC(part(1, 0), part(2, 1) - 1, part(3, 1), part(4, 0), part(5, 0), part(6, 0));
  const offsetMinutes =
    match[8] === undefined ? 0 : (match[8] === "-" ? -1 : 1) * (part(9, 0) * 60 + part(10, 0));
  const time = utc - offsetMinutes * 60_000;
  return Number.isFinite(time) ? time : null;
};

const formatLabel = (subFilter: string | undefined): string | null =>
  subFilter === undefined
    ? null
    : subFilter === "ETSI.CAdES.detached"
      ? "PAdES (ETSI.CAdES.detached)"
      : subFilter === "adbe.pkcs7.detached"
        ? "PKCS#7 (adbe.pkcs7.detached)"
        : subFilter;

export const verifyWorkerHandlersLayer = VerifyWorkerRequests.toLayer(
  Effect.succeed(
    VerifyWorkerRequests.of({
      VerifyPdf: Effect.fn(function* ({ pdf }) {
        const extracted = yield* extractPdfSignatures(pdf);
        const verified = yield* verifyPdfSignatures({ pdf });
        return yield* Effect.forEach(verified, (result, index) =>
          Effect.gen(function* () {
            const signature = extracted[index];
            const certificate =
              signature === undefined
                ? Option.none()
                : yield* inspectDetachedSignedData({ cms: signature.signature }).pipe(
                    Effect.flatMap((inspection) =>
                      inspection.signerCertificateDer === null
                        ? Effect.succeedNone
                        : parseX509(inspection.signerCertificateDer).pipe(Effect.asSome),
                    ),
                    Effect.orElseSucceed(() => Option.none()),
                  );
            const info = Option.getOrUndefined(certificate);
            const brazilian =
              info === undefined
                ? { cpf: null, cnpj: null }
                : extractBrazilianFields(info.subject.raw, info.subjectAltName);
            return {
              index,
              intact: result.cryptographicValid,
              coverage: result.coverageValid,
              coversFileEnd: result.coversFileEnd,
              signer: info?.subject.commonName ?? null,
              cpf: brazilian.cpf,
              cnpj: brazilian.cnpj,
              issuer: info?.issuer.commonName ?? info?.issuer.organization ?? null,
              validFrom: info?.validity.notBefore.getTime() ?? null,
              validTo: info?.validity.notAfter.getTime() ?? null,
              declaredAt: declaredSigningTime(pdf, result.byteRange),
              format: formatLabel(signature?.subFilter),
            } satisfies PdfSignatureReport;
          }),
        );
      }),
    }),
  ),
);
