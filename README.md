# SignatureKit 2.0

SignatureKit is Effect-native digital signature infrastructure maintained by Licitei. The 2.0 rebuild begins with a local PDF runtime. A dedicated browser worker owns immutable document revisions and A1 certificate sessions, and loads the Rust/WebAssembly PDF engine for offline inspection and rendering.

See the [2.0 architecture](docs/v2/ARCHITECTURE.md) for the prepare, preview, confirm and verification contracts and the delivery order. SignatureKit 1.x was removed from this branch. The [recorded 1.x baseline](docs/local-first/baseline.md) remains available for comparisons.

## Packages

| Package | Responsibility |
| --- | --- |
| [@signature-kit/engine](packages/engine/README.md) | Local RPC, document revisions, A1 sessions, codecs and Rust/WASM PDF operations |
| [@signature-kit/browser](packages/browser/README.md) | Browser worker, client, offline viewer and optional OTLP export |

The Cargo workspace contains the PDF engine in `crates/pdf` and the C ABI in
`crates/wasm`. The WASM crate assembles the enabled engines into
`signature-kit.wasm`.

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
