import { inspectCertificateValidity, parseCertificate } from "@signature-kit/certificates";
import { Effect, Redacted } from "effect";
import { CertificateWorkerRequests } from "./tool-rpc.js";

export const certificateWorkerHandlersLayer = CertificateWorkerRequests.toLayer(
  Effect.succeed(
    CertificateWorkerRequests.of({
      ReadCertificate: Effect.fn(function* ({ pfx, password }) {
        const certificate = yield* parseCertificate(pfx, Redacted.make(password));
        const validity = yield* inspectCertificateValidity(certificate.validity);
        return {
          holder: certificate.subject.commonName ?? certificate.subject.raw,
          cpf: certificate.brazilian.cpf,
          cnpj: certificate.brazilian.cnpj,
          organization: certificate.subject.organization,
          issuer: certificate.issuer.commonName ?? certificate.issuer.raw,
          issuerOrganization: certificate.issuer.organization,
          serialNumber: certificate.serialNumber,
          fingerprint: certificate.fingerprint,
          validFrom: certificate.validity.notBefore.getTime(),
          validTo: certificate.validity.notAfter.getTime(),
          status: validity.status,
          daysUntilExpiry: validity.daysUntilExpiry,
          elapsed: Math.min(
            1,
            Math.max(
              0,
              (validity.evaluatedAt.getTime() - certificate.validity.notBefore.getTime()) /
                Math.max(
                  1,
                  certificate.validity.notAfter.getTime() -
                    certificate.validity.notBefore.getTime(),
                ),
            ),
          ),
          chainLength: certificate.intermediateCertificates.length,
        };
      }),
    }),
  ),
);
