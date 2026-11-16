---
packages:
  "@signature-kit/signatures": minor
  "@signature-kit/a1": patch
  "@signature-kit/cms": patch
  "@signature-kit/certificates": patch
  "@signature-kit/http": patch
  "@signature-kit/i18n": patch
  "@signature-kit/xml": patch
  "@signature-kit/asn1": patch
  "@signature-kit/crypto": patch
  "@signature-kit/assinafy": patch
  "@signature-kit/clicksign": patch
  "@signature-kit/documenso": patch
  "@signature-kit/docuseal": patch
  "@signature-kit/zapsign": patch
---

## Publish the worker signing runtime

Publish `@signature-kit/signatures/session`, which `@signature-kit/react` 0.1.2 imports to sign A1 documents in a Domain RPC worker. Without it, bundlers fail to resolve the react worker entry.

A1 signing makes the WebCrypto sign step uninterruptible. CMS builds the signing-certificate-v2 attribute directly with asn1js. All packages move to Effect 4.1.0 so applications load a single Effect runtime.
