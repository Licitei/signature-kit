# Local-first signing baseline

The 1.x benchmark harness was removed with SignatureKit 1.x. [baseline-v1.json](baseline-v1.json) records the harness source as `harnessGitSha` ([`19e97bc6682f36ccf8e45d9aaca31b098e117e1b`](https://github.com/Licitei/signature-kit/tree/19e97bc6682f36ccf8e45d9aaca31b098e117e1b)) and the measured product revision separately as `gitSha`. The commands below describe the harness checkout.

This document records the SignatureKit 1.x performance reference for 2.0 and retains the original Chromium signing and worker lifecycle spike.

## SignatureKit 1.x benchmark matrix

Use the same fixtures and operation IDs when comparing 2.0. Run from the repository root with the lockfile installed and Playwright Chromium available.

```sh
/home/yorizel/.local/bin/resource-run --cpu 8 --mem 10G bun run bench:v1
```

The command builds the published entry points, runs the Node and Chromium Vitest matrix sequentially, executes the existing PDF-core probes and performance tests, and builds five standalone Vite consumers. Intermediate outputs are under `.cache/bench-v1/`. The checked-in [baseline-v1.json](baseline-v1.json) records 330 timing cases with the measured Git SHA, environment, sample counts, percentiles, memory and bundle sizes. Raw timing samples are in `node.json`, `chromium.json` and `pdf-core.json` from each run.

### What is timed

- Each operation runs sequentially with three warmups and 21 measured samples. The adapter-construction case collects 101 samples. Foldkit batches use one warmup and five measured batches per size. Median and p95 use nearest rank. The reused PDF adapter already has its Web Crypto signing key from setup. Fresh PDF signing includes PFX parsing and first key import in the same operation.
- The PDF corpus includes the original synthetic 1, 20 and 200 pages, a valid 20-page synthetic PDF with a deterministic 21 MiB stream on the last page, and checked-in real fixtures for xref recovery, WinAnsi text and encryption. Co-signing uses a second test certificate on a PDF created and signed by the same 1.x run. Verification checks signature count, cryptographic integrity and byte coverage without trust roots, TSA or revocation lookups. Protected PDFs exercise the typed rejection. The read-only matrix covers xref recovery and the encrypted signed fixture.
- The renderer measures the first page at scales 0.25 and 1. The timed operation includes the real canvas painter and image encoding. Render-worker startup includes WASM setup and a first thumbnail reply. A1 startup uses the first empty-session `Dispose` round trip. It includes WASM setup and scope shutdown. Repeated empty-session `Dispose` approximates warm A1 RPC overhead. Startup and batch timings include module loading from Vitest's Vite dev server. The profile and adapter paths each parse the PFX once, checked on the real Initialize handler with Effect RPC's in-process test transport.
- Worker byte counts are PDF payload bytes in both directions. The React A1 worker uses a plain byte-array Schema on both sides and the request buffer remains attached after the real call. The measured calls use structured cloning. Wire framing and schema metadata are outside the byte counts.
- Batch totals include opening and initializing a fresh Foldkit worker, running the real in-memory domain state machine, all signing RPCs and disposal. The per-item timings cover each signing RPC. The caller samples page heap at domain transitions as well as around each batch.
- Node samples RSS, JavaScript heap and ArrayBuffers with `process.memoryUsage()`. Chromium samples page JavaScript heap through CDP `Performance.getMetrics` around each operation and uses `performance.memory` at batch item boundaries. Peaks are the largest observed snapshot. Short-lived allocations between snapshots, worker isolates, browser-process RSS and WASM capacity fall outside the Chromium page measurements. The separate PDF-core memory probe reports subprocess peak RSS and WASM linear-memory capacity.
- For sign and verify, the harness counts explicit JS-to-WASM byte writes via `pdfCore.wasm.copyIn` and observes the page-index writes and result-buffer slices in a Vitest-only transform. This covers boundary buffer copies on those paths. Direct numeric reads, UTF-8 decoding, internal WASM allocations and copies entirely within JavaScript are outside that count. The JSON retains only counts and byte lengths.
- The existing PDF-core scripts run under Bun and keep their own sample counts. The speed probe uses five runs and a two-document file corpus. The lazy-file probe uses three warm trials, the generator uses ten warm trials, and the memory probe uses one fresh subprocess per row. The lazy probe is local and its results do not estimate HTTP latency. Vite entry totals sum each emitted chunk or asset once within that entry. Gzip uses level 9 and Brotli uses quality 11.
- Host snapshots record `ci-status` job counts and reservations plus OS load averages before and after each phase. Job counts include the benchmark's reservation. The PDF-core speed probe also repeats once if its first five-run range exceeds 35% of the median. The runner repeats a Node or Chromium phase once if another broker job is present and the 21 MiB warm-sign or verify-two p95 exceeds 1.35 times its median. It retains the initial raw run and reports both medians and p95s. CPU contention between snapshots and non-broker jobs can still affect measurements.

### Recorded results

Product baseline `001975608555ef7026bed5ad3ae94d8140f3d994` ran on Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz, 28 logical CPUs, linux 7.3.6-arch1-1 x64, Node 26.13.1, Chromium 156.0.8078.4 and Bun 1.4.3. Each timing cell reports median / p95 in milliseconds unless the table gives another unit.

#### Certificate, CMS and XML

| Operation | Fixture or policy | Node | Chromium |
| --- | ---: | ---: | ---: |
| PKCS#12 parse | ecpf | 55.58 / 85.01 | 46.60 / 53.50 |
| PKCS#12 parse | ecnpj | 52.49 / 84.04 | 44.50 / 56.50 |
| Certificate parse | ecpf | 56.63 / 90.82 | 46.20 / 64.90 |
| Certificate parse | ecnpj | 59.27 / 84.06 | 48.80 / 57.10 |
| A1 certificate profile | ecpf | 47.49 / 86.82 | 40.70 / 46.40 |
| A1 certificate profile | ecnpj | 44.54 / 81.69 | 43.60 / 54.00 |
| A1 adapter load | ecpf | 45.61 / 83.96 | 41.50 / 49.90 |
| A1 adapter load | ecnpj | 54.33 / 79.05 | 48.90 / 58.10 |
| Web Crypto key import | ecpf | 0.25 / 0.41 | 1.10 / 1.60 |
| Web Crypto key import | ecnpj | 0.33 / 0.39 | 1.10 / 1.20 |
| Detached CMS create | pades-ades | 4.26 / 10.53 | 4.80 / 7.30 |
| Detached CMS create | icp-brasil-ad-rb-v11 | 4.81 / 13.91 | 5.50 / 6.80 |
| Detached CMS verify | pades-ades | 4.12 / 10.35 | 4.30 / 4.80 |
| Detached CMS verify | icp-brasil-ad-rb-v11 | 3.83 / 7.67 | 4.10 / 5.40 |
| Detached CMS inspect | pades-ades | 6.06 / 18.95 | 6.80 / 8.10 |
| Detached CMS inspect | icp-brasil-ad-rb-v11 | 6.06 / 11.64 | 8.40 / 13.90 |
| XML sign | xml-small | 5.71 / 20.00 | — |
| XML sign | xml-1mib | 134.00 / 151.08 | — |
| XML verify | xml-small | 3.23 / 5.32 | 3.50 / 4.60 |
| XML verify | xml-1mib | 106.33 / 133.51 | 96.90 / 106.40 |

Chromium returned `xml.SIGN_FAILED` during serialization for both inputs. The 1.x runtime parses with xmldom while xml-core picks the native Chromium serializer. Chromium verification uses the XML that 1.x signed in Node.

#### PDF signing and verification

| Corpus | Runtime | Fresh sign | Warm sign | Co-sign | Verify one | Verify two |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| synthetic-1 | node | 71.69 / 116.44 | 7.10 / 10.05 | 6.89 / 8.49 | 4.51 / 5.62 | 9.54 / 10.49 |
| synthetic-1 | chromium | 65.40 / 82.10 | 9.70 / 10.60 | 7.10 / 8.10 | 5.30 / 6.00 | 13.20 / 18.20 |
| synthetic-20 | node | 68.43 / 110.92 | 8.17 / 9.83 | 11.03 / 12.76 | 5.81 / 7.06 | 12.20 / 14.60 |
| synthetic-20 | chromium | 48.00 / 59.40 | 7.90 / 12.10 | 6.60 / 7.80 | 5.50 / 6.70 | 11.00 / 12.10 |
| synthetic-200 | node | 63.90 / 115.56 | 14.74 / 23.28 | 15.47 / 17.08 | 8.85 / 9.29 | 13.95 / 14.82 |
| synthetic-200 | chromium | 68.10 / 88.10 | 14.20 / 18.60 | 15.20 / 22.60 | 12.40 / 16.20 | 23.30 / 28.90 |
| synthetic-21mib | node | 200.12 / 240.04 | 170.62 / 211.65 | 154.46 / 186.92 | 111.90 / 128.75 | 200.78 / 250.79 |
| synthetic-21mib | chromium | 232.40 / 314.00 | 151.20 / 202.80 | 143.50 / 170.60 | 115.50 / 123.40 | 199.80 / 213.90 |

#### PDF operations on the 20-page fixture

| Operation | Node | Chromium |
| --- | ---: | ---: |
| Visual preview | 1.97 / 3.19 | 2.70 / 3.20 |
| Visible stamp | 1.35 / 1.64 | 2.30 / 3.60 |
| Vector rubric on 19 pages | 4.28 / 5.17 | 5.10 / 6.10 |
| Text anchor search | 1.47 / 1.58 | 1.60 / 1.80 |
| Best-guess builder placement | 0.08 / 0.10 | 0.10 / 0.20 |
| Placeholder and ByteRange | 1.96 / 2.25 | 2.20 / 2.40 |
| Merge two copies | 1.17 / 1.54 | 2.00 / 2.40 |
| Extract first page | 0.47 / 0.55 | 0.90 / 1.00 |
| Inspect | 0.30 / 0.34 | 0.70 / 0.90 |
| Extract text | 0.73 / 1.11 | 1.70 / 2.00 |
| Extract tables | 0.67 / 0.77 | 1.40 / 1.60 |
| Read first page lazily | 1.48 / 1.53 | 2.20 / 2.40 |
| Scan one signature | 0.25 / 0.27 | 0.40 / 0.60 |
| Paint and encode thumbnail | — | 2.20 / 3.30 |
| Paint and encode full page | — | 3.80 / 4.80 |

The synthetic ruled-table fixture contains one extracted table with three rows and two columns. Table extraction measured 0.58 / 0.81 ms in Node and 0.50 / 0.70 ms in Chromium.

#### Chromium workers and Foldkit batch

| Worker operation | Median / p95 (ms) |
| --- | ---: |
| A1 cold first reply | 703.20 / 808.10 |
| A1 warm empty RPC | 0.60 / 1.10 |
| A1 initialize | 114.70 / 131.30 |
| A1 worker sign | 15.00 / 19.30 |
| Render worker cold thumbnail | 612.50 / 701.90 |
| Render worker warm thumbnail | 3.60 / 5.20 |

| Documents | Batch median / p95 (ms) | Item median / p95 (ms) | Sampled page heap peak (MiB) |
| --- | ---: | ---: | ---: |
| 10 | 1156.70 / 1280.50 | 15.20 / 54.10 | 116.2 |
| 50 | 1769.50 / 1823.50 | 10.40 / 17.10 | 129.0 |

Each measured A1 signing RPC cloned a 725-byte input PDF and a 35,318-byte signed response. Initialization ran the PKCS#12 parser twice.

#### PDF-core byte copies

| Document | Runtime | Sign copies / bytes | Verify copies / bytes |
| --- | ---: | ---: | ---: |
| synthetic-1 | node | 10 / 73,527 | 2 / 69,106 |
| synthetic-20 | node | 10 / 115,639 | 2 / 81,158 |
| synthetic-200 | node | 10 / 521,366 | 2 / 197,100 |
| synthetic-21mib | node | 10 / 154,258,996 | 2 / 44,122,140 |
| synthetic-1 | chromium | 10 / 73,527 | 2 / 69,106 |
| synthetic-20 | chromium | 10 / 115,639 | 2 / 81,158 |
| synthetic-200 | chromium | 10 / 521,366 | 2 / 197,100 |
| synthetic-21mib | chromium | 10 / 154,258,996 | 2 / 44,122,140 |

#### Vite production builds

| Consumer entry | Raw bytes | Gzip bytes | Brotli bytes |
| --- | ---: | ---: | ---: |
| react-a1 | 2,855,782 | 904,999 | 713,899 |
| pdf-sign | 1,819,360 | 632,195 | 498,375 |
| pdf-verify | 1,601,695 | 573,970 | 458,345 |
| xml | 837,348 | 208,430 | 173,014 |
| pdf-viewer | 1,474,484 | 577,185 | 466,322 |
| PDF-core WASM asset | 1,030,833 | 438,260 | 344,071 |

#### Existing benchmark scripts

| Probe | Corpus | Median / p95 |
| --- | ---: | ---: |
| Read text (ms/page) | two-document-corpus | 0.25 / 0.35 |
| Build display lists (ms/page) | two-document-corpus | 0.30 / 0.43 |
| Lazy file read (ms) | synthetic-21mib | 3.74 / 4.88 |
| Full file read (ms) | synthetic-21mib | 21.58 / 24.74 |
| Warm PDF generation (ms) | react-pdf | 37.97 / 171.83 |
| Warm PDF generation (ms) | takumi-pdf | 50.27 / 157.02 |

The speed script repeated after its initial sample spread. Text spread changed from 18.7% to 44.6% of the median and display list spread from 35.0% to 60.9%. The table reports the second run.

| Repeated Vitest phase | Operation | First median / p95 (ms) | Repeat median / p95 (ms) |
| --- | ---: | ---: | ---: |
| v1-node | pdf.sign.warm-a1 | 156.46 / 215.45 | 170.62 / 211.65 |

All 6 tests in 4 existing performance suites passed. The JSON includes internal timings for the four instrumented operations and PDF-core versus pdf.js anchor medians for 10 fixtures.

## Reproduce the original browser spike

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

The React shadcn viewer in `apps/docs/registry/default/signature-pdf-viewer/signature-pdf-viewer.tsx` imports the docs package's `react-pdf@11.0.0` and sets `pdfjs.GlobalWorkerOptions.workerSrc` to jsDelivr using the library's `pdfjs.version`. The lockfile resolves this to `https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs`. Its generated registry payload carries the same CDN URL. Replacing this viewer with the existing PDF-core renderer would remove that viewer's `react-pdf` dependency and runtime CDN request. The `pdfjs-dist@6.3.289` entry in `formats/pdf/package.json` is a dev dependency used by the text-anchor comparison benchmark. Review the React package's direct <code>&#64;signature-kit/a1</code> and `@effect/platform-browser` dependencies when the shared signing worker owns the signer and transport. React currently imports both. The remote signer packages and their Alchemy dependencies belong to separate provider workflows. The Foldkit batch's `@alchemy.run/domain` dependency is a candidate for review when batch ownership moves into the worker.

## Artifact reuse and duplication

- `shared/pdf-core/scripts/build-wasm.sh` takes Cargo's release artifact and uses Binaryen to write the optimized `shared/pdf-core/dist/pdf-core.wasm` shipped on npm. In this build, the two Cargo paths were hard links to the same unoptimized file, and the Foldkit client emitted a byte-identical copy of the optimized package artifact. The build emitted zero WASM files beneath `apps/docs/public`.
- The published React and PDF packages include the transpiled TypeScript worker entry points in `dist/`. Vite bundles worker dependencies at the application boundary. The Foldkit client build emitted a signing worker and two separately named render worker chunks, all referencing the same PDF-core WASM asset. The packed React consumer browser test also checks that its Vite build requests an A1 worker chunk and the WASM asset.
- `apps/docs/scripts/build-registry.ts` embeds the six registry source files under `apps/docs/registry/default` into tracked JSON under `apps/docs/public/r`. The build additionally copies those JSON files and the registry index into `apps/docs/dist-foldkit/client/r`. The embedded sources and emitted JSON copies matched their inputs byte for byte.

## Original Chromium benchmark

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
| `@signature-kit/certificates` | 3 | 32912 | 7630 | `@signature-kit/asn1@^0.2.1`, `@signature-kit/crypto@^0.3.0`, <code>&#64;signature-kit/signatures@^0.4.0</code>, `effect@4.1.0` | — |
| <code>&#64;signature-kit/http</code> | 3 | 18457 | 4367 | <code>&#64;signature-kit/signatures@^0.4.0</code>, `effect@4.1.0` | — |
| <code>&#64;signature-kit/i18n</code> | 3 | 5377 | 1488 | `effect@4.1.0` | — |
| <code>&#64;signature-kit/signatures</code> | 6 | 40537 | 8336 | `effect@4.1.0` | — |
| <code>&#64;signature-kit/pdf</code> | 57 | 448362 | 83572 | `@effect/platform-browser@4.1.0`, `@signature-kit/cms@^0.3.0`, <code>&#64;signature-kit/i18n@^0.1.0</code>, `@signature-kit/pdf-core@^0.4.0`, <code>&#64;signature-kit/signatures@^0.4.0</code>, `effect@4.1.0`, `qrcode-generator@^2.0.4` | — |
| <code>&#64;signature-kit/react</code> | 21 | 83436 | 15446 | `@effect/platform-browser@4.1.0`, <code>&#64;signature-kit/a1@^0.5.0</code>, `@signature-kit/cms@^0.3.0`, <code>&#64;signature-kit/pdf@^0.7.0</code>, `@signature-kit/pdf-core@^0.4.0`, <code>&#64;signature-kit/signatures@^0.4.0</code>, `effect@4.1.0` | `react@>=18.3.0 \|\| >=19.0.0` |
| <code>&#64;signature-kit/xml</code> | 12 | 75444 | 16943 | `@peculiar/x509@2.2.0`, `@signature-kit/crypto@^0.3.0`, <code>&#64;signature-kit/i18n@^0.1.0</code>, <code>&#64;signature-kit/signatures@^0.4.0</code>, `@xmldom/xmldom@^0.9.12`, `effect@4.1.0`, `reflect-metadata@^0.2.2`, `xml-core@^1.2.6`, `xmldsigjs@2.8.8` | — |
| `@signature-kit/asn1` | 3 | 19799 | 4533 | `effect@4.1.0` | — |
| `@signature-kit/cms` | 24 | 85869 | 21882 | `@peculiar/asn1-cms@2.11.0`, `@peculiar/asn1-schema@2.11.0`, `@peculiar/asn1-tsp@2.11.0`, `@peculiar/asn1-x509@2.11.0`, `@signature-kit/asn1@^0.2.1`, `asn1js@4.0.0`, `effect@4.1.0`, `pkijs@3.4.3` | — |
| `@signature-kit/crypto` | 39 | 97117 | 28190 | `@signature-kit/asn1@^0.2.1`, `effect@4.1.0` | — |
| `@signature-kit/pdf-core` | 22 | 1233162 | 474850 | `effect@4.1.0` | — |
| <code>&#64;signature-kit/a1</code> | 6 | 15956 | 4345 | `@signature-kit/certificates@^0.4.0`, `@signature-kit/crypto@^0.3.0`, <code>&#64;signature-kit/http@^0.2.0</code>, <code>&#64;signature-kit/signatures@^0.4.0</code>, `effect@4.1.0` | — |
| <code>&#64;signature-kit/assinafy</code> | 3 | 34448 | 6712 | `@signature-kit/crypto@^0.3.0`, <code>&#64;signature-kit/http@^0.2.0</code>, <code>&#64;signature-kit/signatures@^0.4.0</code>, `alchemy@2.0.0-beta.85`, `effect@4.1.0` | — |
| <code>&#64;signature-kit/clicksign</code> | 3 | 37436 | 6977 | `@signature-kit/crypto@^0.3.0`, <code>&#64;signature-kit/http@^0.2.0</code>, <code>&#64;signature-kit/signatures@^0.4.0</code>, `alchemy@2.0.0-beta.85`, `effect@4.1.0` | — |
| <code>&#64;signature-kit/documenso</code> | 3 | 35325 | 6607 | `@signature-kit/crypto@^0.3.0`, <code>&#64;signature-kit/http@^0.2.0</code>, <code>&#64;signature-kit/signatures@^0.4.0</code>, `alchemy@2.0.0-beta.85`, `effect@4.1.0` | — |
| <code>&#64;signature-kit/docuseal</code> | 3 | 34131 | 6534 | `@signature-kit/crypto@^0.3.0`, <code>&#64;signature-kit/http@^0.2.0</code>, <code>&#64;signature-kit/signatures@^0.4.0</code>, `alchemy@2.0.0-beta.85`, `effect@4.1.0` | — |
| <code>&#64;signature-kit/zapsign</code> | 3 | 33168 | 6628 | `@signature-kit/crypto@^0.3.0`, <code>&#64;signature-kit/http@^0.2.0</code>, <code>&#64;signature-kit/signatures@^0.4.0</code>, `alchemy@2.0.0-beta.85`, `effect@4.1.0` | — |
| <code>&#64;signature-kit/iti</code> | 6 | 60856 | 9704 | `@peculiar/asn1-ess@2.11.0`, `@peculiar/asn1-schema@2.11.0`, `@signature-kit/cms@^0.3.0`, <code>&#64;signature-kit/http@^0.2.0</code>, <code>&#64;signature-kit/pdf@^0.7.0</code>, `@signature-kit/pdf-core@^0.4.0`, <code>&#64;signature-kit/signatures@^0.4.0</code>, `asn1js@4.0.0`, `effect@4.1.0`, `pkijs@3.4.3` | — |

### Published export subpaths

| Specifier | Published target | Workspace source or build script |
| --- | --- | --- |
| `@signature-kit/certificates` | `core/certificates/dist/index.js` | `core/certificates/src/index.ts` |
| <code>&#64;signature-kit/http</code> | `core/http/dist/http.js` | `core/http/src/http.ts` |
| <code>&#64;signature-kit/i18n</code> | `core/i18n/dist/i18n.js` | `core/i18n/src/i18n.ts` |
| <code>&#64;signature-kit/signatures</code> | `core/signatures/dist/signatures.js` | `core/signatures/src/signatures.ts` |
| <code>&#64;signature-kit/signatures/session</code> | `core/signatures/dist/session.js` | `core/signatures/src/session.ts` |
| <code>&#64;signature-kit/pdf/config</code> | `formats/pdf/dist/config.js` | `formats/pdf/src/config.ts` |
| <code>&#64;signature-kit/pdf/builder</code> | `formats/pdf/dist/builder.js` | `formats/pdf/src/builder.ts` |
| <code>&#64;signature-kit/pdf/builder-store</code> | `formats/pdf/dist/builder-store.js` | `formats/pdf/src/builder-store.ts` |
| <code>&#64;signature-kit/pdf/workflow</code> | `formats/pdf/dist/workflow.js` | `formats/pdf/src/workflow.ts` |
| <code>&#64;signature-kit/pdf/sign</code> | `formats/pdf/dist/sign.js` | `formats/pdf/src/sign.ts` |
| <code>&#64;signature-kit/pdf/stamp</code> | `formats/pdf/dist/stamp.js` | `formats/pdf/src/stamp.ts` |
| <code>&#64;signature-kit/pdf/anchors</code> | `formats/pdf/dist/anchors.js` | `formats/pdf/src/anchors.ts` |
| <code>&#64;signature-kit/pdf/merge</code> | `formats/pdf/dist/merge.js` | `formats/pdf/src/merge.ts` |
| <code>&#64;signature-kit/pdf/render-browser</code> | `formats/pdf/dist/render-browser.js` | `formats/pdf/src/render-browser.ts` |
| <code>&#64;signature-kit/pdf/verify</code> | `formats/pdf/dist/verify.js` | `formats/pdf/src/verify.ts` |
| <code>&#64;signature-kit/pdf/byte-range</code> | `formats/pdf/dist/byte-range.js` | `formats/pdf/src/byte-range.ts` |
| <code>&#64;signature-kit/pdf/worker</code> | `formats/pdf/dist/worker.js` | `formats/pdf/src/worker.ts` |
| <code>&#64;signature-kit/pdf/worker-browser</code> | `formats/pdf/dist/worker-browser.js` | `formats/pdf/src/worker-browser.ts` |
| <code>&#64;signature-kit/react/a1</code> | `formats/react/dist/a1.js` | `formats/react/src/a1.ts` |
| <code>&#64;signature-kit/react/config</code> | `formats/react/dist/config.js` | `formats/react/src/config.ts` |
| <code>&#64;signature-kit/react/sync-store</code> | `formats/react/dist/sync-store.js` | `formats/react/src/sync-store.ts` |
| <code>&#64;signature-kit/react/browser-pdf</code> | `formats/react/dist/browser-pdf.js` | `formats/react/src/browser-pdf.ts` |
| <code>&#64;signature-kit/xml/config</code> | `formats/xml/dist/config.js` | `formats/xml/src/config.ts` |
| <code>&#64;signature-kit/xml/sign</code> | `formats/xml/dist/sign.js` | `formats/xml/src/sign.ts` |
| <code>&#64;signature-kit/xml/verify</code> | `formats/xml/dist/verify.js` | `formats/xml/src/verify.ts` |
| <code>&#64;signature-kit/xml/runtime</code> | `formats/xml/dist/runtime.js` | `formats/xml/src/runtime.ts` |
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
| <code>&#64;signature-kit/a1/config</code> | `signers/a1/dist/config.js` | `signers/a1/src/config.ts` |
| <code>&#64;signature-kit/a1/signer</code> | `signers/a1/dist/signer.js` | `signers/a1/src/signer.ts` |
| <code>&#64;signature-kit/assinafy</code> | `signers/assinafy/dist/index.js` | `signers/assinafy/src/index.ts` |
| <code>&#64;signature-kit/clicksign</code> | `signers/clicksign/dist/index.js` | `signers/clicksign/src/index.ts` |
| <code>&#64;signature-kit/documenso</code> | `signers/documenso/dist/index.js` | `signers/documenso/src/index.ts` |
| <code>&#64;signature-kit/docuseal</code> | `signers/docuseal/dist/index.js` | `signers/docuseal/src/index.ts` |
| <code>&#64;signature-kit/zapsign</code> | `signers/zapsign/dist/index.js` | `signers/zapsign/src/index.ts` |
| <code>&#64;signature-kit/iti/conformance</code> | `validators/iti/dist/conformance.js` | `validators/iti/src/conformance.ts` |
| <code>&#64;signature-kit/iti/remote</code> | `validators/iti/dist/remote.js` | `validators/iti/src/remote.ts` |

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
