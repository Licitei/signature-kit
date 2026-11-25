# SignatureKit 2.0

SignatureKit is Effect-native digital signature infrastructure maintained by Licitei. The 2.0 rebuild begins with a local PDF runtime. A dedicated browser worker owns immutable document revisions and A1 certificate sessions, and loads the Rust/WebAssembly PDF engine for offline inspection and rendering.

See the [2.0 architecture](docs/v2/ARCHITECTURE.md) for the prepare, preview, confirm and verification contracts and the delivery order. SignatureKit 1.x was removed from this branch. The [recorded 1.x baseline](docs/local-first/baseline.md) remains available for comparisons.

## Packages

| Package | Responsibility |
| --- | --- |
| [@signature-kit/local](runtime/local/README.md) | Local RPC, document revisions, A1 sessions, offline viewer and optional telemetry |
| [@signature-kit/pdf-core](shared/pdf-core/README.md) | Rust/WASM PDF parsing, editing, inspection and rendering |
| [@signature-kit/certificates](core/certificates/README.md) | PKCS#12 and X.509 certificate parsing |
| [@signature-kit/cms](shared/cms/README.md) | CMS/PKCS#7 signing, verification and timestamping primitives |
| [@signature-kit/crypto](shared/crypto/README.md) | Cryptographic and PKCS#12 primitives |
| [@signature-kit/asn1](shared/asn1/README.md) | ASN.1 DER codec |

## Development

Use the repository's pinned Bun and Rust toolchains. Build the packages before running tests that import their generated entry points.

```sh
bun install --frozen-lockfile
bun run build
bun run check
bun run test
bunx playwright install chromium
bun run test:integration:browser
bun run site:build
```

Use `bun run site:dev` to work on the documentation site. `bun run pack:npm` checks package tarballs. Tegami owns package versions and npm trusted publishing.

## License

[MIT](LICENSE).
