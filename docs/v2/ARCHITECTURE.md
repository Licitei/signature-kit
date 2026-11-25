# SignatureKit 2.0 — architecture

SignatureKit 2.0 is rebuilt on the `v2` branch with **no backward compatibility**:
no 1.x API, package name, export path, option or error shape is preserved, and
there are no deprecated aliases or migration shims. Shared engines (`pdf-core`
ABI, CMS, crypto, certificates) change freely when 2.0 needs it.

The 1.x implementation and benchmark harness are gone from the 2.0 tree. The
[recorded 1.x baseline](../local-first/baseline.md) and static PDF interoperability
fixtures remain. Format interoperability is still required. Check real-world
documents and signatures with independent tools such as qpdf, poppler
`pdfsig`, OpenSSL, pdf.js and the ITI validator.

Delivery order is fixed:

1. **Local-first.** Everything runs in the browser, offline, with no network
   dependency on the signing or verification path. Network access exists only as
   an explicit, opt-in evidence fetcher (OCSP/CRL/TSA) that the caller provides.
2. **Server.** Same protocol and engine on a server runtime (Effect Workflow /
   Cluster only where durability needs them).
3. **External providers.** Remote signers are rebuilt last on the 2.0 contracts.

## Ownership

| Owner | Responsibility |
| --- | --- |
| `crates/pdf` | PDF structure, rendering, revision analysis, AcroForm fields, appearance streams, incremental writes and ByteRange digests. |
| `crates/wasm` | C ABI around the enabled Rust engines. Each call performs a complete operation. |
| `packages/engine/src/{asn1,crypto,cms,certificates}` | Internal TypeScript implementations of ASN.1, PKCS#12, CMS/CAdES and X.509. In-house codec replacements use independent oracle tests. |
| WebCrypto | Private-key operations. A1 keys are imported once per session as non-extractable `CryptoKey`s and remain in the worker. |
| `packages/browser` | Browser transport, worker assembly, viewer and optional page-side OTLP export. |

## Packages

- `@signature-kit/engine/rpc` defines the versioned RPC group, Schema contracts
  and typed errors. Page-side code can import it without loading WASM or engine
  services.
- `@signature-kit/engine/engine` owns `Documents`, `A1Sessions` and `PdfEngine`
  services. The signing and verification services below are planned.
- Engine subpaths under `/wasm/` load and call `signature-kit.wasm`. The Cargo
  workspace builds that asset from the `crates/wasm` cdylib with its `pdf` feature
  enabled by default. `crates/pdf` is an rlib.
- `@signature-kit/browser/worker` assembles the worker RPC server from the public
  engine subpaths. `/client` provides the page-side client layer and `/viewer`
  paints pages and transforms between PDF user space and canvas pixels.

## Core model

- **Document and revision are immutable.** `documents.open(bytes)` returns a
  `RevisionRef { handle, digest, byteLength }`. The digest (SHA-256) identifies
  content across machines; the handle identifies a worker-owned buffer within one
  runtime instance. Every mutation (field creation, signing) yields a new revision;
  the previous one is never touched. `documents.release(handle)` is idempotent.
  Handles carry the runtime instance id, so a handle from a dead worker fails with
  a typed `staleHandle` error instead of resolving to the wrong buffer.
- **A1 session.** `a1.open({ pfx, password })` parses the PKCS#12 exactly once,
  imports the key into WebCrypto, derives the certificate profile (holder kind
  e-CPF / e-CNPJ, validity, issuer chain) and returns `{ sessionId, generation,
  profile }`. Password and PFX bytes stay `Redacted` and are dropped after import.
  Closing or replacing the session bumps the generation; anything bound to an
  older generation is rejected.
- **Preparation is a real operation.** `pdf.prepare(revision, { session, field,
  appearance, policy })` resolves the field, writes the `/AP` widget appearance,
  reserves `/Contents`, writes one incremental update and computes the `ByteRange`
  digest — once. The result is an immutable `Preparation` whose id is the hash of
  (revision digest, certificate fingerprint, session generation, field, appearance,
  policy, prepared-bytes digest).
- **Preview and confirmation are bound to the preparation.** `pdf.preview`
  renders the prepared bytes (the exact bytes that will be signed). `pdf.confirm
  (preparationId)` re-checks the session generation and certificate validity at
  confirmation time, signs the stored digest, embeds the CMS in place and
  **self-verifies** (integrity, coverage, previous revisions byte-identical) before
  returning a `Receipt`. Confirming the same preparation again returns the retained
  receipt (idempotent) without signing again. Any change (field, page, certificate,
  appearance, policy) requires a new preparation and preview.
- **Verification is first class.** `pdf.verify(revision, { trust, at })` and
  `pdf.compare(sent, returned, { trust })` report separately: integrity, coverage,
  signer identity, trust (explicit roots only), changes after each signature
  (recognised vs unknown), timestamp evidence and revocation. Revocation has three
  distinct states: `notChecked`, `embeddedEvidence` (OCSP/CRL present but not
  evaluated) and `verified { good | revoked }`. Present evidence is never reported
  as verified.

## Runtime

- Web Worker is the reference runtime; Node runs the same engine for tests.
- RPC is Effect `RpcGroup` with Schema-encoded requests, typed errors and a
  protocol version handshake. Abrupt worker death surfaces as a typed failure;
  orderly shutdown drains in-flight work.
- Batches use `@typeonce/effect-machine` (`Machine.start`, local runtime) for the
  batch state machine, `Queue.bounded` for admission with a separate byte budget,
  and a `Stream` of `{ snapshot, seq }` events per observer.
- Telemetry: Effect spans across UI → RPC → worker → queue → WASM → crypto, with
  an attribute allowlist (no document bytes, file names, CPF/CNPJ, fingerprints,
  PFX or password), a bounded offline buffer and an optional OTel exporter.

## Evidence discipline

Every PR states which evidence it carries and keeps them apart: local (developer
host), CI, Chromium, other browsers, independent readers/validators (OpenSSL,
pdf.js, ITI), and performance against the 1.x baseline.
