# @signature-kit/pdf

PDF/PAdES document preparation, visible signature placement, stamping, signing, verification, rubric stamping, merge helpers, and browser text-box extraction.

## Install

```sh
bun add @signature-kit/pdf @signature-kit/signatures @signature-kit/cms effect
```

Add a signer backend at the application boundary, for example:

```sh
bun add @signature-kit/a1
```

`effect` is a direct runtime dependency. The package consumes signing power through `@signature-kit/signatures` and the in-house PDF engine through the `PdfCore` service from `@signature-kit/pdf-core`: provide `pdfCoreFileLayer` (with the Node or Bun platform layer) or `pdfCoreBrowserLayer` wherever you sign, verify, stamp, or prepare PDFs.

## Public surface

- `@signature-kit/pdf/config` — PDF schemas, signing/stamping/builder contracts, error catalog, and message catalog.
- `@signature-kit/pdf/sign` — `signPdf` for detached CMS/PAdES signing over a prepared placeholder. The placeholder (signature dictionary, widget, AcroForm field, `/SigFlags`) is appended as an incremental update by the `PdfCore` engine, so the source bytes and every earlier signature stay untouched.
- `@signature-kit/pdf/verify` — `verifyPdf` for ByteRange, CMS, and optional trusted-root chain verification. Revisions and signature dictionaries are read by the `PdfCore` engine.
- `@signature-kit/pdf/stamp` — badge layout, QR/link stamping, visible-signature stamping, initials/rubric helpers, and coordinate conversion.
- `@signature-kit/pdf/anchors` — `findPdfTextAnchors` for text, digit, and link anchor placement. It reads geometry, text, and link annotations through the `PdfCore` service from `@signature-kit/pdf-core`; calls that pass `pages` and `textBoxes` with only `text`/`digits` matchers need no service.
- `@signature-kit/pdf/workflow` — high-level load/template/prepare/sign batch workflows.
- `@signature-kit/pdf/builder` — pure signature-field builder operations.
- `@signature-kit/pdf/builder-store` — external builder store and placement queue helpers.
- `@signature-kit/pdf/byte-range` — placeholder preparation and signature extraction helpers built on `PdfCore.signatures`; `hasPdfByteRange`, `hasPdfSignatureDictionary`, and `isCompletePdfRevision` are Effects that require `PdfCore`.
- `@signature-kit/pdf/merge` — `mergePdfs`; it copies pages only and intentionally drops source AcroForms, outlines, metadata, and attachments.
- `@signature-kit/pdf/liteparse-browser` — browser-only page-image rendering (`renderPdfPagesBrowser`), plus a handwriting service with an explicitly supplied browser font.

`signatureLength` is CMS byte capacity: a value of `n` reserves exactly `n` bytes, represented by `2n` hexadecimal digits in `/Contents`.

Verification coverage semantics: every signature ByteRange must start at byte 0, each signature must cryptographically verify, and the newest signature must cover the file end. Without `trustedRoots`, `verifyPdf` checks coverage and CMS cryptography but does not bind the signer to a trusted chain. Supplying `trustedRoots` makes `chainValid` and the final `valid` verdict require chain validation.

Rubrics never stamp the same page as the full visible signature block. `rubricPageIndexesExcludingSignature(...)` skips the main signature page, and single-page documents receive only the main block.

## Example

```ts
import { NodeServices } from "@effect/platform-node";
import { a1SignaturesLayer } from "@signature-kit/a1/signer";
import { pdfCoreFileLayer } from "@signature-kit/pdf-core/file";
import { prepareAndSignPdf } from "@signature-kit/pdf/workflow";
import { verifyPdf } from "@signature-kit/pdf/verify";
import { Effect, Layer, Redacted } from "effect";

declare const pdf: Uint8Array;
declare const pfx: Uint8Array;
declare const trustedRoots: Uint8Array[];

const program = Effect.gen(function* () {
  const signed = yield* prepareAndSignPdf({
    pdf,
    badge: {
      header: { text: "Assinado digitalmente" },
      rows: [[{ label: "Documento", value: "Contrato" }]],
      footer: [{ text: "Validar no ITI", link: "https://validar.iti.gov.br/" }],
      qr: { text: "https://validar.iti.gov.br/" },
    },
    signing: {
      policy: "pades-icp-brasil",
      reason: "Assinatura digital",
      name: "Maria Silva",
      location: "BR",
    },
  });

  const verification = yield* verifyPdf({ pdf: signed, trustedRoots });
  return { signed, verification };
}).pipe(
  Effect.provide(
    Layer.merge(
      a1SignaturesLayer({ pfx, password: Redacted.make("secret") }),
      pdfCoreFileLayer.pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);
```

## Preview a visible signature

`preparePdfVisualPreview` from `@signature-kit/pdf/workflow` accepts the same input as `prepareAndSignPdf` and returns the stamped PDF before signing. It uses the same badge, placement, and rubric preparation as signing, including excluding signature pages from repeated rubrics. Provide `PdfCore` (`pdfCoreBrowserLayer` in browsers, `pdfCoreFileLayer` on Node/Bun) when running it. In a browser, `renderPdfPagesBrowser` (which still needs `liteParseWorkerBrowserLayer`) renders the resulting PDF to PNG page images. `PdfHandwriting` renders text to PNG using `pdfHandwritingBrowserLayer(font)`; load the chosen font at the application boundary before rendering.

## Inspect each PDF signature

`verifyPdfSignatures` returns signatures in revision order. Each result includes the signer serial number, cryptographic validity, revision coverage, chain validity, revocation status, byte range, and revision end. Earlier signatures can remain valid while `coversFileEnd` is false because later signatures add revisions. Structural failures still fail the Effect. `verifyPdf` retains its aggregate result and verifies every signature through the same implementation. Chain validity is evaluated against the supplied roots; revocation marked `not_checked` is not proof of revocation checking.

```ts
import { verifyPdfSignatures } from "@signature-kit/pdf/verify";

declare const pdf: Uint8Array;
declare const trustedRoots: Uint8Array[];

const verification = verifyPdfSignatures({ pdf, trustedRoots });
```

## Errors and i18n

PDF failures use the `PdfError` code catalog and `pdfErrorMessages`; CMS and signer failures can also surface from signing workflows. Applications can render localized copy through `@signature-kit/i18n` with the catalogs for every package they call.

Docs: <https://signaturekit.dev/en-US/docs/signing/pdf>.

## License

MIT. See `LICENSE`.
