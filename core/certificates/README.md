# @signature-kit/certificates

Effect-safe PKCS#12 and X.509 parsing for certificate profiles, validity checks, Brazilian CPF/CNPJ extraction.

## Install

```sh
bun add @signature-kit/certificates effect
```

`effect` is a direct runtime dependency. PKCS#12 password values stay `Redacted` until parsing.

## Public surface

- `@signature-kit/certificates` — `X509InfoSchema`, `CertificateSourceSchema`, `parseCertificate`, `parseX509`, `extractBrazilianFields`, `isCertificateValid`, `daysUntilExpiry`, `inspectCertificateValidity`, `CertificateValidityStatusSchema`, and `CertificateValidityInspectionSchema`.

`CertificateSource` accepts an `ArrayBuffer` or `ArrayBufferView` of raw PKCS#12 bytes, or a `string`. A `string` source is treated as raw latin-1-encoded PKCS#12 bytes, not PEM text — PEM input is rejected and fails with `INVALID_FORMAT`. `parseCertificate(source, password)` returns the normalized `Certificate` contract; `parseX509(der)` returns X.509 metadata without requiring a private key.

## Example

```ts
import { daysUntilExpiry, parseCertificate } from "@signature-kit/certificates";
import { Effect, Redacted } from "effect";

declare const pfx: Uint8Array;

const program = Effect.gen(function* () {
  const certificate = yield* parseCertificate(pfx, Redacted.make("secret"));

  return {
    subject: certificate.subject,
    expiresInDays: daysUntilExpiry(certificate),
  };
});
```

## Inspect validity with the Effect clock

`inspectCertificateValidity` reports `notYetValid`, `valid`, or `expired`, the evaluation time, remaining milliseconds, and whole days until expiry. Both validity boundaries are inclusive. It rejects invalid dates and reversed intervals as `CertificateError`. Use the remaining duration to choose an expiry-warning threshold in your application. This checks the validity interval; trust-chain and revocation verification remain separate operations. `parseCertificate` uses the same Effect clock for its `isValid` snapshot.

```ts
import { inspectCertificateValidity } from "@signature-kit/certificates";

declare const notBefore: Date;
declare const notAfter: Date;

const inspection = inspectCertificateValidity({ notBefore, notAfter });
```

## Errors

Parsing and validity failures use `CertificateError` and the package's
`certificateErrorMessages` catalog.

## License

MIT. See `LICENSE`.
