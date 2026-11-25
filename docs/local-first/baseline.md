# Local-first signing baseline

The baseline exercises visible PDF preparation, A1 signing, and local verification in one Chromium page. A separate worker test exercises the state machine and interruption lifecycle that a later batch can build on.

## Reproduce

Run these commands from the repository root on the shared host.

```sh
/home/yorizel/.local/bin/resource-run --cpu 8 --mem 8G bun install --frozen-lockfile
/home/yorizel/.local/bin/resource-run --cpu 8 --mem 8G bun run build
/home/yorizel/.local/bin/resource-run --cpu 8 --mem 8G bun run --cwd apps/docs foldkit:build
mkdir -p .cache/local-first
/home/yorizel/.local/bin/resource-run --cpu 4 --mem 4G bun scripts/local-first/inventory.ts > .cache/local-first/inventory.md
/home/yorizel/.local/bin/resource-run --cpu 8 --mem 8G bun run test:integration:browser:packages
```

The existing Chromium config discovers both tests through the browser suite glob. It writes the benchmark environment, individual samples, percentiles, and memory readings to the gitignored `.cache/local-first/chromium.json`. The inventory is generated after the package and Foldkit builds. Each package total sums its `dist/` files, including emitted JavaScript, declarations and declaration maps. Gzip totals sum the sizes of individually compressed files at level 9. Cargo target rows reflect the default local Rust build directory when present.

## Current browser signing paths

| Entry point | Execution path |
| --- | --- |
| Published React hooks and shadcn dialog | The registry's `signature-dialog.tsx` uses the A1 React hooks. `formats/react/src/a1.ts` owns UI-facing certificate and signing state. `a1-worker-client.ts` starts `a1.browser.worker.ts`, which runs the Effect RPC handlers in `a1-worker.ts`. `Initialize` loads an A1 certificate profile and signer adapter via separate PKCS#12 parse paths. The shared `core/signatures/src/session.ts` manages the generation and lifetime. Each `Sign` delegates to `prepareAndSignPdf`. `browser-pdf.ts` provides a PDF object URL for React. |
| Foldkit live signing demo | `apps/docs/foldkit/signing-view.ts` uses `signing-runtime.ts` for the batch and worker session. `apps/signing-domain/src/signing.ts` defines the Alchemy Domain aggregate, commands, and events. The page-side runtime coordinates batch transitions and calls the RPC worker in `apps/docs/foldkit/signing.worker.ts`. The worker handles `Initialize`, `Preview`, `Sign`, and `Dispose`. It uses the same shared signature session and PDF workflow, with separate certificate profile and adapter loads during initialization. |
| Package PDF helpers | `formats/pdf/src/workflow.ts` exposes visual preview, prepare-and-sign, and field-based signing. `stamp.ts` writes the appearance using PDF-core WASM. `sign.ts` writes the placeholder and byte range, obtains the key through `Signatures`, and embeds the detached CMS. `verify.ts` checks CMS and byte-range coverage locally. The generic preparation RPC lives in `worker.ts`, `worker-browser.ts`, and `browser.worker.ts`. The render RPC lives in `render-browser.ts` and `render.worker.ts` and produces thumbnails independently of signing. |

The React shadcn viewer in `apps/docs/registry/default/signature-pdf-viewer/signature-pdf-viewer.tsx` imports the docs package's `react-pdf@11.0.0` and sets `pdfjs.GlobalWorkerOptions.workerSrc` to jsDelivr using the library's `pdfjs.version`. The lockfile resolves this to `https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs`. Its generated registry payload carries the same CDN URL. Replacing this viewer with the existing PDF-core renderer would remove that viewer's `react-pdf` dependency and runtime CDN request. The `pdfjs-dist@6.3.289` entry in `formats/pdf/package.json` is a dev dependency used by the text-anchor comparison benchmark. Review the React package's direct `@signature-kit/a1` and `@effect/platform-browser` dependencies when the shared signing worker owns the signer and transport. React currently imports both. The remote signer packages and their Alchemy dependencies belong to separate provider workflows. The Foldkit batch's `@alchemy.run/domain` dependency is a candidate for review when batch ownership moves into the worker.

## Artifact reuse and duplication

- `shared/pdf-core/scripts/build-wasm.sh` takes Cargo's release artifact and uses Binaryen to write the optimized `shared/pdf-core/dist/pdf-core.wasm` shipped on npm. In this build, the two Cargo paths were hard links to the same unoptimized file, and the Foldkit client emitted a byte-identical copy of the optimized package artifact. The build emitted zero WASM files beneath `apps/docs/public`.
- The published React and PDF packages include the transpiled TypeScript worker entry points in `dist/`. Vite bundles worker dependencies at the application boundary. The Foldkit client build emitted a signing worker and two separately named render worker chunks, all referencing the same PDF-core WASM asset. The packed React consumer browser test also checks that its Vite build requests an A1 worker chunk and the WASM asset.
- `apps/docs/scripts/build-registry.ts` embeds the six registry source files under `apps/docs/registry/default` into tracked JSON under `apps/docs/public/r`. The build additionally copies those JSON files and the registry index into `apps/docs/dist-foldkit/client/r`. The embedded sources and emitted JSON copies matched their inputs byte for byte.

## Chromium benchmark

The PDFs are generated in Chromium with the existing `createFixturePdf` helper. The corpus has 1, 20, and 200 pages, each with one synthetic text line, and a fixed stamp rectangle on the first page. The existing synthetic `ecpf.p12` and `ecnpj.p12` fixtures are parsed individually. The signing cases use the eCPF fixture. Each case runs three warmups and 21 sequential samples. The median uses the middle sample and p95 uses nearest rank.

The in-memory Effect tracer times the same spans used by the OpenTelemetry integration. `pdf.workflow.prepare-preview` includes the visible appearance preparation and contains `pdf.stamp.visible`. `localFirst.pdf.signWithA1` includes fresh A1 layer acquisition and `pdf.sign`. The inner `pdf.sign` covers PDF placeholder, byte range, key import, CMS creation, and signature embedding. Each signed result is checked with `pdf.verify` for validity and exactly one signature. The verification sample omits trust roots and revocation lookups.

The collector allowlists the operation names and seven finite numeric keys for byte lengths and counts. Only the selected operation names, durations, and numeric attributes enter the JSON. This keeps document and certificate contents, identifiers, fingerprints, file names, and passwords out of span attributes.

| PKCS#12 fixture | Median / p95 (ms) |
| --- | ---: |
| ecpf | 73.1 / 75.2 |
| ecnpj | 76.2 / 93.1 |

| Pages | Input bytes | Visual prepare (ms) | Stamp only (ms) | Fresh A1 + sign (ms) | PDF sign (ms) | Verify (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 725 | 1.9 / 3.2 | 1.1 / 1.3 | 72.8 / 77.8 | 7.6 / 9.5 | 5.2 / 9.2 |
| 20 | 6,736 | 2.6 / 3.7 | 1.5 / 1.9 | 81.0 / 92.7 | 8.4 / 14.5 | 5.9 / 7.3 |
| 200 | 64,692 | 8.3 / 10.5 | 4.7 / 5.8 | 82.4 / 96.0 | 13.2 / 22.7 | 8.4 / 15.0 |

Each timing cell reports median / p95.

The benchmark ran at `f924c462c53771fc51b231d71624b9239e9ebabd`, based on `origin/main` at `4060a8b`. The host was an Intel Xeon E5-2680 v4 at 2.40 GHz with 14 physical cores, 28 logical CPUs, and 62.6 GiB RAM. It ran Arch Linux 7.3.6-arch1-1 (x86-64), headless Chromium 156.0.8078.4, Bun 1.4.3, and Node 26.13.1. The test command reserved 8 CPUs and 8 GiB on the shared host.

Chromium used `performance.memory.usedJSHeapSize` because the test page did not offer `measureUserAgentSpecificMemory`. The approximate heap readings were 64,000,000 bytes before the workload and 64,000,000 bytes after. These snapshots cover the JavaScript heap after WASM setup. They are subject to Chromium's rounding, update cadence, garbage collection, and renderer sharing. Peak memory and WASM allocations fall outside these heap snapshots.

## Spike result

`@typeonce/effect-machine@0.47.1` publishes the local runtime as `Machine.start`. Its public export is `Machine`. The worker defines its protocol using Effect Schema and `Machine.eventsFromSchemas`. It checks whether a decoded event is enabled with `Machine.can` before invoking `ref.send`. This is necessary for an explicit rejection reply because the runtime ignores disabled events. Exiting the running state interrupts the invoked Effect. The worker uses a deferred gate to complete the running invocation. The Chromium test waits for the invocation's interruption finalizer before asserting `Cancelled`, observes `Done` on the success path, and checks the worker's `DedicatedWorkerGlobalScope` in both cases. Shutdown closes the Effect scope and reports the stopped machine before the worker calls `self.close()`. The page also owns `Worker.terminate()` through scoped cleanup.

The production bundle measurement below builds the worker through Vite with ES module output and default production minification. The spike worker contains the local machine and its transitive Effect code. Every observed transition and cleanup path passed in Chromium. Browser verification of the versioned signing RPC, batch backpressure, and offline co-signing belongs to the later stack.

`bun pm ls --all` reported `@typeonce/effect-machine@0.47.1` and one `effect@4.1.0`. `bun.lock` records the machine's `effect: ^4.0.0` peer and a single Effect package entry at 4.1.0. The peer symlink and the root Effect symlink resolve to the same installation under `node_modules/.bun/effect@4.1.0`.

## Generated inventory

The following tables are the verbatim output of `bun scripts/local-first/inventory.ts`.

### Published packages

| Package | Dist files | Raw bytes | Gzip bytes | Runtime dependencies | Peers |
| --- | --- | --- | --- | --- | --- |
| `@signature-kit/certificates` | 3 | 32912 | 7630 | `@signature-kit/asn1@^0.2.1`, `@signature-kit/crypto@^0.3.0`, `@signature-kit/signatures@^0.4.0`, `effect@4.1.0` | — |
| `@signature-kit/http` | 3 | 18457 | 4367 | `@signature-kit/signatures@^0.4.0`, `effect@4.1.0` | — |
| `@signature-kit/i18n` | 3 | 5377 | 1488 | `effect@4.1.0` | — |
| `@signature-kit/signatures` | 6 | 40537 | 8336 | `effect@4.1.0` | — |
| `@signature-kit/pdf` | 57 | 448362 | 83572 | `@effect/platform-browser@4.1.0`, `@signature-kit/cms@^0.3.0`, `@signature-kit/i18n@^0.1.0`, `@signature-kit/pdf-core@^0.4.0`, `@signature-kit/signatures@^0.4.0`, `effect@4.1.0`, `qrcode-generator@^2.0.4` | — |
| `@signature-kit/react` | 21 | 83436 | 15446 | `@effect/platform-browser@4.1.0`, `@signature-kit/a1@^0.5.0`, `@signature-kit/cms@^0.3.0`, `@signature-kit/pdf@^0.7.0`, `@signature-kit/pdf-core@^0.4.0`, `@signature-kit/signatures@^0.4.0`, `effect@4.1.0` | `react@>=18.3.0 \|\| >=19.0.0` |
| `@signature-kit/xml` | 12 | 75444 | 16943 | `@peculiar/x509@2.2.0`, `@signature-kit/crypto@^0.3.0`, `@signature-kit/i18n@^0.1.0`, `@signature-kit/signatures@^0.4.0`, `@xmldom/xmldom@^0.9.12`, `effect@4.1.0`, `reflect-metadata@^0.2.2`, `xml-core@^1.2.6`, `xmldsigjs@2.8.8` | — |
| `@signature-kit/asn1` | 3 | 19799 | 4533 | `effect@4.1.0` | — |
| `@signature-kit/cms` | 24 | 85869 | 21882 | `@peculiar/asn1-cms@2.11.0`, `@peculiar/asn1-schema@2.11.0`, `@peculiar/asn1-tsp@2.11.0`, `@peculiar/asn1-x509@2.11.0`, `@signature-kit/asn1@^0.2.1`, `asn1js@4.0.0`, `effect@4.1.0`, `pkijs@3.4.3` | — |
| `@signature-kit/crypto` | 39 | 97117 | 28190 | `@signature-kit/asn1@^0.2.1`, `effect@4.1.0` | — |
| `@signature-kit/pdf-core` | 22 | 1233162 | 474850 | `effect@4.1.0` | — |
| `@signature-kit/a1` | 6 | 15956 | 4345 | `@signature-kit/certificates@^0.4.0`, `@signature-kit/crypto@^0.3.0`, `@signature-kit/http@^0.2.0`, `@signature-kit/signatures@^0.4.0`, `effect@4.1.0` | — |
| `@signature-kit/assinafy` | 3 | 34448 | 6712 | `@signature-kit/crypto@^0.3.0`, `@signature-kit/http@^0.2.0`, `@signature-kit/signatures@^0.4.0`, `alchemy@2.0.0-beta.85`, `effect@4.1.0` | — |
| `@signature-kit/clicksign` | 3 | 37436 | 6977 | `@signature-kit/crypto@^0.3.0`, `@signature-kit/http@^0.2.0`, `@signature-kit/signatures@^0.4.0`, `alchemy@2.0.0-beta.85`, `effect@4.1.0` | — |
| `@signature-kit/documenso` | 3 | 35325 | 6607 | `@signature-kit/crypto@^0.3.0`, `@signature-kit/http@^0.2.0`, `@signature-kit/signatures@^0.4.0`, `alchemy@2.0.0-beta.85`, `effect@4.1.0` | — |
| `@signature-kit/docuseal` | 3 | 34131 | 6534 | `@signature-kit/crypto@^0.3.0`, `@signature-kit/http@^0.2.0`, `@signature-kit/signatures@^0.4.0`, `alchemy@2.0.0-beta.85`, `effect@4.1.0` | — |
| `@signature-kit/zapsign` | 3 | 33168 | 6628 | `@signature-kit/crypto@^0.3.0`, `@signature-kit/http@^0.2.0`, `@signature-kit/signatures@^0.4.0`, `alchemy@2.0.0-beta.85`, `effect@4.1.0` | — |
| `@signature-kit/iti` | 6 | 60856 | 9704 | `@peculiar/asn1-ess@2.11.0`, `@peculiar/asn1-schema@2.11.0`, `@signature-kit/cms@^0.3.0`, `@signature-kit/http@^0.2.0`, `@signature-kit/pdf@^0.7.0`, `@signature-kit/pdf-core@^0.4.0`, `@signature-kit/signatures@^0.4.0`, `asn1js@4.0.0`, `effect@4.1.0`, `pkijs@3.4.3` | — |

### Published export subpaths

| Specifier | Published target | Workspace source or build script |
| --- | --- | --- |
| `@signature-kit/certificates` | `core/certificates/dist/index.js` | `core/certificates/src/index.ts` |
| `@signature-kit/http` | `core/http/dist/http.js` | `core/http/src/http.ts` |
| `@signature-kit/i18n` | `core/i18n/dist/i18n.js` | `core/i18n/src/i18n.ts` |
| `@signature-kit/signatures` | `core/signatures/dist/signatures.js` | `core/signatures/src/signatures.ts` |
| `@signature-kit/signatures/session` | `core/signatures/dist/session.js` | `core/signatures/src/session.ts` |
| `@signature-kit/pdf/config` | `formats/pdf/dist/config.js` | `formats/pdf/src/config.ts` |
| `@signature-kit/pdf/builder` | `formats/pdf/dist/builder.js` | `formats/pdf/src/builder.ts` |
| `@signature-kit/pdf/builder-store` | `formats/pdf/dist/builder-store.js` | `formats/pdf/src/builder-store.ts` |
| `@signature-kit/pdf/workflow` | `formats/pdf/dist/workflow.js` | `formats/pdf/src/workflow.ts` |
| `@signature-kit/pdf/sign` | `formats/pdf/dist/sign.js` | `formats/pdf/src/sign.ts` |
| `@signature-kit/pdf/stamp` | `formats/pdf/dist/stamp.js` | `formats/pdf/src/stamp.ts` |
| `@signature-kit/pdf/anchors` | `formats/pdf/dist/anchors.js` | `formats/pdf/src/anchors.ts` |
| `@signature-kit/pdf/merge` | `formats/pdf/dist/merge.js` | `formats/pdf/src/merge.ts` |
| `@signature-kit/pdf/render-browser` | `formats/pdf/dist/render-browser.js` | `formats/pdf/src/render-browser.ts` |
| `@signature-kit/pdf/verify` | `formats/pdf/dist/verify.js` | `formats/pdf/src/verify.ts` |
| `@signature-kit/pdf/byte-range` | `formats/pdf/dist/byte-range.js` | `formats/pdf/src/byte-range.ts` |
| `@signature-kit/pdf/worker` | `formats/pdf/dist/worker.js` | `formats/pdf/src/worker.ts` |
| `@signature-kit/pdf/worker-browser` | `formats/pdf/dist/worker-browser.js` | `formats/pdf/src/worker-browser.ts` |
| `@signature-kit/react/a1` | `formats/react/dist/a1.js` | `formats/react/src/a1.ts` |
| `@signature-kit/react/config` | `formats/react/dist/config.js` | `formats/react/src/config.ts` |
| `@signature-kit/react/sync-store` | `formats/react/dist/sync-store.js` | `formats/react/src/sync-store.ts` |
| `@signature-kit/react/browser-pdf` | `formats/react/dist/browser-pdf.js` | `formats/react/src/browser-pdf.ts` |
| `@signature-kit/xml/config` | `formats/xml/dist/config.js` | `formats/xml/src/config.ts` |
| `@signature-kit/xml/sign` | `formats/xml/dist/sign.js` | `formats/xml/src/sign.ts` |
| `@signature-kit/xml/verify` | `formats/xml/dist/verify.js` | `formats/xml/src/verify.ts` |
| `@signature-kit/xml/runtime` | `formats/xml/dist/runtime.js` | `formats/xml/src/runtime.ts` |
| `@signature-kit/asn1` | `shared/asn1/dist/asn1.js` | `shared/asn1/src/asn1.ts` |
| `@signature-kit/cms/config` | `shared/cms/dist/config.js` | `shared/cms/src/config.ts` |
| `@signature-kit/cms/icp-brasil` | `shared/cms/dist/icp-brasil.js` | `shared/cms/src/icp-brasil.ts` |
| `@signature-kit/cms/sign` | `shared/cms/dist/sign.js` | `shared/cms/src/sign.ts` |
| `@signature-kit/cms/verify` | `shared/cms/dist/verify.js` | `shared/cms/src/verify.ts` |
| `@signature-kit/cms/inspect` | `shared/cms/dist/inspect.js` | `shared/cms/src/inspect.ts` |
| `@signature-kit/crypto/base64` | `shared/crypto/dist/base64.js` | `shared/crypto/src/base64.ts` |
| `@signature-kit/crypto/config` | `shared/crypto/dist/config.js` | `shared/crypto/src/config.ts` |
| `@signature-kit/crypto/pem` | `shared/crypto/dist/pem.js` | `shared/crypto/src/pem.ts` |
| `@signature-kit/crypto/pkcs12` | `shared/crypto/dist/pkcs12.js` | `shared/crypto/src/pkcs12.ts` |
| `@signature-kit/pdf-core/config` | `shared/pdf-core/dist/config.js` | `shared/pdf-core/src/config.ts` |
| `@signature-kit/pdf-core/pdf-core` | `shared/pdf-core/dist/pdf-core.js` | `shared/pdf-core/src/pdf-core.ts` |
| `@signature-kit/pdf-core/browser` | `shared/pdf-core/dist/browser.js` | `shared/pdf-core/src/browser.ts` |
| `@signature-kit/pdf-core/file` | `shared/pdf-core/dist/file.js` | `shared/pdf-core/src/file.ts` |
| `@signature-kit/pdf-core/promise` | `shared/pdf-core/dist/promise.js` | `shared/pdf-core/src/promise.ts` |
| `@signature-kit/pdf-core/node` | `shared/pdf-core/dist/node.js` | `shared/pdf-core/src/node.ts` |
| `@signature-kit/pdf-core/canvas` | `shared/pdf-core/dist/canvas.js` | `shared/pdf-core/src/canvas.ts` |
| `@signature-kit/pdf-core/pdf-core.wasm` | `shared/pdf-core/dist/pdf-core.wasm` | `shared/pdf-core/scripts/build-wasm.sh` |
| `@signature-kit/a1/config` | `signers/a1/dist/config.js` | `signers/a1/src/config.ts` |
| `@signature-kit/a1/signer` | `signers/a1/dist/signer.js` | `signers/a1/src/signer.ts` |
| `@signature-kit/assinafy` | `signers/assinafy/dist/index.js` | `signers/assinafy/src/index.ts` |
| `@signature-kit/clicksign` | `signers/clicksign/dist/index.js` | `signers/clicksign/src/index.ts` |
| `@signature-kit/documenso` | `signers/documenso/dist/index.js` | `signers/documenso/src/index.ts` |
| `@signature-kit/docuseal` | `signers/docuseal/dist/index.js` | `signers/docuseal/src/index.ts` |
| `@signature-kit/zapsign` | `signers/zapsign/dist/index.js` | `signers/zapsign/src/index.ts` |
| `@signature-kit/iti/conformance` | `validators/iti/dist/conformance.js` | `validators/iti/src/conformance.ts` |
| `@signature-kit/iti/remote` | `validators/iti/dist/remote.js` | `validators/iti/src/remote.ts` |

### WASM files

| Path | Raw bytes | Gzip bytes | SHA-256 |
| --- | --- | --- | --- |
| `apps/docs/dist-foldkit/client/assets/pdf-core-BUPX4Lg_.wasm` | 1030833 | 438260 | `a98bf859872d1f3026f09507970e74958de764c9421b8a28fdb843d2c6649abf` |
| `shared/pdf-core/dist/pdf-core.wasm` | 1030833 | 438260 | `a98bf859872d1f3026f09507970e74958de764c9421b8a28fdb843d2c6649abf` |
| `shared/pdf-core/rust/target/wasm32-unknown-unknown/release/deps/signature_kit_pdf_core.wasm` | 1132650 | 445437 | `33f33b8b99119f0ecdaa01f432aa50c274d87641d00b50d13ea95760262bb0f0` |
| `shared/pdf-core/rust/target/wasm32-unknown-unknown/release/signature_kit_pdf_core.wasm` | 1132650 | 445437 | `33f33b8b99119f0ecdaa01f432aa50c274d87641d00b50d13ea95760262bb0f0` |

### Existing worker entries and emitted chunks

| Path | Raw bytes | Gzip bytes |
| --- | --- | --- |
| `apps/docs/dist-foldkit/client/assets/render.worker-BtqOMON-.js` | 230402 | 70923 |
| `apps/docs/dist-foldkit/client/assets/render.worker-CCBX-6Tb.js` | 230416 | 71086 |
| `apps/docs/dist-foldkit/client/assets/signing.worker-UyhI76iC.js` | 1050138 | 275952 |
| `formats/pdf/dist/browser.worker.js` | 947 | 371 |
| `formats/pdf/dist/render.worker.js` | 665 | 276 |
| `formats/react/dist/a1.browser.worker.js` | 959 | 346 |

### Embedded registry source

| Source | Generated payload | Exact match |
| --- | --- | --- |
| `apps/docs/registry/default/certificate-upload-form/certificate-upload-form.tsx` | `apps/docs/public/r/certificate-upload-form.json` | Yes |
| `apps/docs/registry/default/pdf-signature-anchor/pdf-signature-anchor.tsx` | `apps/docs/public/r/pdf-signature-anchor.json` | Yes |
| `apps/docs/registry/default/signature-certificate-form/signature-certificate-form.tsx` | `apps/docs/public/r/signature-certificate-form.json` | Yes |
| `apps/docs/registry/default/signature-dialog/signature-dialog.tsx` | `apps/docs/public/r/signature-dialog.json` | Yes |
| `apps/docs/registry/default/signature-pdf-viewer/signature-pdf-viewer.tsx` | `apps/docs/public/r/signature-pdf-viewer.json` | Yes |
| `apps/docs/registry/default/signing-progress-list/signing-progress-list.tsx` | `apps/docs/public/r/signing-progress-list.json` | Yes |

### Spike production worker

| Vite chunk | Raw bytes | Gzip bytes |
| --- | --- | --- |
| `assets/local-machine.worker-CQ6lx77Q.js` | 280116 | 81529 |
