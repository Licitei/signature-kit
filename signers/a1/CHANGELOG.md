## @signature-kit/a1@0.4.2

### Faster selected-page and Markdown PDF extraction

The PDF core opens selected pages without materializing the whole page tree, defers unused XObjects, and accepts complete streams before the next cross-reference offset. Markdown rendering reuses buffers and the number parser uses bounded accumulation for common operands. Page resources share the resolved dictionary across readers, and the JavaScript bindings share result-block validation and disposal.

The pdf-core README documents the procurement corpus results, evidence audit, Wasm size, and an isolated benchmark against LiteParse and PDF Inspector. This release also refreshes all public SignatureKit packages.

## @signature-kit/a1@0.4.1

### Publish the worker signing runtime

Publish `@signature-kit/signatures/session`, which `@signature-kit/react` 0.1.2 imports to sign A1 documents in a Domain RPC worker. Without it, bundlers fail to resolve the react worker entry.

A1 signing makes the WebCrypto sign step uninterruptible. CMS builds the signing-certificate-v2 attribute directly with asn1js. All packages move to Effect 4.1.0 so applications load a single Effect runtime.

## @signature-kit/a1@0.4.0

### Publish A1 with Node-resolvable imports

Release the fully specified relative imports already in source, so `@signature-kit/a1/signer` loads under native Node ESM instead of failing with `ERR_MODULE_NOT_FOUND`.

This release also removes the unused `A1Signer` service and `a1SignerLayer`; use `a1SignaturesLayer` or `loadA1SignerAdapter`.

# Changelog

## Unreleased

- Remove the unused `A1Signer` service and `a1SignerLayer`; use `a1SignaturesLayer` or `loadA1SignerAdapter`.
- Share one validated remote-certificate loader between URL-backed signing and profile APIs.

## 0.3.0

- Emit distinct `SignatureKitError` codes for expired, not-yet-valid, and
  missing Brazilian CPF/CNPJ certificate profile failures.

- Report A1 schema decode names as local strings after the core schema-name
  catalog removal; public A1 signing behavior is unchanged.

## 0.2.0

- Redact presigned-URL credentials from error messages when fetching remote PKCS#12 material.

## 0.1.0

- Initial npm-ready release for `@signature-kit/a1`.
- Published package metadata, MIT license, README, and package-local changelog.
- Ships local A1 / PKCS#12 signer adapter that exposes signing power through the core SignerAdapter contract.
