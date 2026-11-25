import { a1SignaturesLayer, parseA1CertificateProfile } from "@signature-kit/a1/signer";
import { signatures } from "@signature-kit/signatures";
import { xmlRuntimeLayer } from "@signature-kit/xml/runtime";
import { signXml } from "@signature-kit/xml/sign";
import { verifyXml } from "@signature-kit/xml/verify";
import { Effect, Layer, Redacted } from "effect";
import { XmlWorkerRequests } from "./tool-rpc.js";

export const xmlWorkerHandlersLayer = XmlWorkerRequests.toLayer(
  Effect.succeed(
    XmlWorkerRequests.of({
      SignXml: Effect.fn(function* ({ xml, pfx, password, referenceId }) {
        const options = { pfx, password: Redacted.make(password) };
        const profile = yield* parseA1CertificateProfile(options);
        return yield* Effect.gen(function* () {
          const signed = yield* signXml({
            xml,
            ...(referenceId === undefined ? {} : { referenceId }),
          });
          const certificate = yield* signatures.certificate();
          const check = yield* verifyXml({
            xml: signed,
            trustedCertificateDer: certificate.certificateDer,
          });
          return {
            xml: signed,
            signer: profile.subject,
            verified: check.valid,
            signatureCount: check.signatureCount,
            referenceUris: check.referenceUris,
          };
        }).pipe(Effect.provide(Layer.merge(a1SignaturesLayer(options), xmlRuntimeLayer)));
      }),
    }),
  ),
);
