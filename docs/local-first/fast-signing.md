# Fast signing benchmark

All numbers on this page are **local host** measurements (Intel Xeon E5-2680 v4, 28 logical
CPUs, shared with other jobs through `resource-run`), not CI. Compare runs only on the same
harness and host.

## Harness

```sh
/home/yorizel/.local/bin/resource-run --cpu 8 --mem 10G bun run build
SIGNATURE_KIT_BENCH_LABEL=<label> /home/yorizel/.local/bin/resource-run --cpu 8 --mem 10G \
  bun run test:performance:browser
bun packages/browser/scripts/compare-signing-benchmark.ts \
  docs/local-first/fast-signing-baseline.json .cache/bench-v2/signing-<label>.json
```

`packages/browser/__tests__/signing.performance.browser.test.ts` runs in headless Chromium through
the Vitest browser provider against the real `@signature-kit/browser` worker. Every signing step
runs with page network requests aborted; only worker boot may fetch its modules and WASM.

- **Cold:** seven fresh workers. Each one boots, opens the A1 session, opens a 1-page composed
  contract, prepares, confirms and exports. Boot is measured from `new Worker` to the protocol
  `Hello` reply, so it includes the Vite dev server serving unbundled worker modules. Three more
  fresh traced workers provide the worker-side stage spans.
- **Warm:** one worker and one A1 session. Each sample opens the fixture, prepares, confirms,
  exports and releases every handle. Composed fixtures use 3 warmups and 21 samples. The 21 MiB
  fixture (`synthetic-21mib` from `tooling/testing/pdf-signing-benchmark.ts`) uses 2 warmups and
  11 samples. Times are page-observed on a worker without telemetry.
- **Stages:** the same samples on a worker with telemetry enabled (at most 11 per fixture). Stage
  times come from the worker spans listed in the stage table; transfer cost is the client span
  minus the worker span. The copy count is the bytes copied into WASM memory
  (`pdfCore.wasm.copyIn`) during prepare and confirm divided by the document size.
- **Batches:** 10, 50 and 200 composed 2–3 page contracts through `BatchPrepare` and
  `BatchConfirm`, after one warm-up batch; 5, 5 and 3 runs. Composition happens before the timer
  starts. Per-item times come from the `local.batch.item.prepare` and `local.batch.item.confirm`
  spans of a separate traced run.
- **Memory:** a 20 ms CDP sampler records the page `JSHeapUsedSize` and, through auto-attached
  worker targets, each worker's `Runtime.getHeapUsage` used size and backing-store size
  (`ArrayBuffer` and WASM memory). Peaks are the largest sample; allocations shorter than the
  sampling interval can be missed. The budget peak is the batch's own byte accounting.
- Percentiles use nearest rank.
- **Pool:** the benchmark workers take the signing-helper count from their Worker `name`
  (`SIGNATURE_KIT_BENCH_WORKERS`, default 7 to match an 8-CPU reservation). A sweep signs 200
  documents with 0, 1, 2, 4 and 7 helpers. From the pool commit on, worker memory sums every
  worker target (coordinator and helpers) through a browser-level CDP session; earlier runs saw
  only the coordinator.
- **Production bundle:** global setup builds `packages/browser/dist/worker.js` with Vite; seven
  fresh bundled workers measure cold boot, and seven more call `LocalClient.prewarm()` first. The
  shipped entry sizes the pool as `navigator.hardwareConcurrency - 1` (27 on this host).
- **Gates:** the test fails when a p50 exceeds its limit (1-page prepare 5 ms, 1-page confirm
  8 ms and 5 ms without the RSA sign span, 100-page total 30 ms, 21 MiB prepare 12 ms, confirm
  15 ms and total 350 ms, batches of 50 and 200 at 400 and 900 ms, bundled cold first signature
  700 ms, cold A1 open 80 ms). Results are written before the gates run.

## Baseline (`v2-12-batch`, before optimization)

| Cold stage | p50 / p95 (ms) |
| --- | ---: |
| Worker boot to Hello (page-observed, Vite dev modules) | 929.70 / 999.90 |
| A1 open (page-observed) | 84.90 / 106.30 |
| Document open and transfer | 3.90 / 5.10 |
| Prepare | 16.30 / 26.90 |
| Confirm | 30.60 / 35.10 |
| Export and transfer back | 2.00 / 3.00 |
| First signature end to end | 1069.00 / 1126.70 |
| WASM compile (worker span) | 13.70 / 15.50 |
| WASM instantiate (worker span) | 0.30 / 0.30 |
| PKCS#12 parse (worker span) | 64.30 / 67.40 |
| WebCrypto key import (worker span) | 0.60 / 0.70 |
| Self-verify (worker span) | 5.40 / 5.80 |
| Confirm without the RSA sign (worker span) | 24.80 / 25.60 |

| Fixture | Bytes | Open | Prepare | Confirm | Export | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| contract-1p | 37505 | 1.20 / 1.40 | 2.80 / 3.30 | 4.60 / 5.60 | 0.60 / 0.80 | 9.20 / 10.80 |
| contract-10p | 54858 | 1.40 / 2.00 | 2.90 / 3.70 | 4.40 / 6.80 | 0.70 / 0.90 | 9.30 / 12.90 |
| report-100p | 207793 | 3.40 / 5.40 | 5.40 / 9.00 | 6.60 / 8.20 | 0.60 / 0.80 | 16.00 / 22.90 |
| synthetic-21mib | 22027211 | 286.50 / 339.00 | 18.40 / 21.20 | 22.30 / 27.00 | 15.90 / 22.40 | 330.20 / 403.10 |

| Stage (p50 ms) | contract-1p | contract-10p | report-100p | synthetic-21mib |
| --- | ---: | ---: | ---: | ---: |
| Transfer in (client − worker) | 0.80 | 0.60 | 0.60 | 0.90 |
| Document open (copy + SHA-256 checkpoint) | 1.00 | 1.10 | 5.10 | 235.30 |
| PDF open (copy into WASM) | 0.30 | 0.20 | 0.40 | 2.50 |
| Field resolve | 1.00 | 1.00 | 3.00 | 0.50 |
| `/AP` + incremental write | 1.90 | 1.40 | 4.90 | 0.90 |
| ByteRange digest | 0.10 | 0.00 | 0.10 | 0.00 |
| Prepare remainder (preview append, ids) | 2.10 | 1.70 | 2.40 | 9.00 |
| Prepare total | 5.40 | 4.60 | 10.80 | 13.30 |
| Signed attributes + CMS build | 0.10 | 0.10 | 0.10 | 0.10 |
| WebCrypto sign | 1.50 | 1.30 | 1.60 | 0.90 |
| CMS embed | 0.10 | 0.00 | 0.10 | 0.00 |
| Self-verify | 3.50 | 2.90 | 7.70 | 5.80 |
| Signed revision append + receipt | 2.40 | 2.10 | 2.50 | 13.90 |
| Confirm total | 7.90 | 6.20 | 12.00 | 21.20 |
| Confirm without sign | 6.40 | 5.10 | 10.40 | 20.40 |
| Transfer back (client − worker) | 0.50 | 0.30 | 0.60 | 0.60 |
| Export copy | 0.10 | 0.10 | 0.20 | 15.20 |
| Document copies into WASM per signature | 2.15 | 2.10 | 2.03 | 2.00 |

| Documents | Prepare | Sign | Total | Item prepare | Item confirm | Budget peak | Page heap | Worker heap | Worker backing store |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 28.60 / 37.20 | 51.80 / 58.50 | 82.70 / 95.70 | 3.40 / 5.90 | 5.50 / 9.20 | 1.5 MiB | 25.5 MiB | 53.7 MiB | 109.7 MiB |
| 50 | 105.80 / 110.60 | 227.90 / 230.30 | 328.40 / 338.10 | 3.00 / 5.50 | 5.10 / 8.90 | 6.7 MiB | 28.7 MiB | 71.9 MiB | 69.9 MiB |
| 200 | 413.90 / 458.30 | 809.50 / 822.90 | 1236.80 / 1267.80 | 2.60 / 7.60 | 4.60 / 6.20 | 26.1 MiB | 41.1 MiB | 86.1 MiB | 94.9 MiB |

1.x reference (Chromium, [baseline-v1.json](baseline-v1.json)): warm sign synthetic-1
9.70 / 10.60 ms, synthetic-21mib 151.20 / 202.80 ms, A1 cold first reply 703.20 ms, A1 worker
sign 15.00 ms, batch of 10 1156.70 ms, batch of 50 1769.50 ms.

## After (`v2-14-fast-signing`)

Same harness and host, measured after the last optimization commit. Raw results:
[fast-signing-after.json](fast-signing-after.json).

### Cold first signature (1-page contract)

| Stage | Before p50 / p95 | After p50 / p95 | Δ p50 |
| --- | ---: | ---: | ---: |
| Worker boot to Hello, dev modules | 929.70 / 999.90 | 899.70 / 1002.50 | -3% |
| A1 open | 84.90 / 106.30 | 46.50 / 62.10 | -45% |
| Document open and transfer | 3.90 / 5.10 | 2.70 / 4.60 | -31% |
| Prepare | 16.30 / 26.90 | 11.60 / 20.40 | -29% |
| Confirm | 30.60 / 35.10 | 14.10 / 23.50 | -54% |
| Export and transfer back | 2.00 / 3.00 | 1.50 / 1.80 | -25% |
| First signature, dev modules | 1069.00 / 1126.70 | 992.20 / 1104.80 | -7% |
| WASM compile span | 13.70 / 15.50 | 14.40 / 16.90 | +5% |
| PKCS#12 parse span | 64.30 / 67.40 | 21.10 / 21.50 | -67% |
| WebCrypto key import span | 0.60 / 0.70 | 0.60 / 0.70 | +0% |
| Confirm without RSA sign (span) | 24.80 / 25.60 | 12.60 / 13.00 | -49% |

Production-bundled worker (after only; the bundle did not exist in the baseline harness):

| Stage | Cold p50 / p95 | Cold after `prewarm()` p50 / p95 |
| --- | ---: | ---: |
| Worker boot to Hello | 297.90 / 1526.90 | 356.10 / 372.60 |
| Prewarm (PDF path + 27 helpers) | — | 861.80 / 1057.80 |
| A1 open | 45.60 / 48.70 | 54.10 / 73.60 |
| Prepare | 11.90 / 12.60 | 8.50 / 10.50 |
| Confirm | 13.80 / 14.60 | 15.70 / 20.10 |
| A1 open + first signature after boot | 75.90 / 80.20 | 80.40 / 104.50 |
| First signature end to end | 366.80 / 1606.00 | 1301.00 / 1405.00 |

### Warm single signature (page-observed)

| Fixture | Metric | Before p50 / p95 | After p50 / p95 | Δ p50 |
| --- | --- | ---: | ---: | ---: |
| contract-1p | openMs | 1.20 / 1.40 | 1.30 / 1.60 | +8% |
| contract-1p | prepareMs | 2.80 / 3.30 | 2.60 / 3.70 | -7% |
| contract-1p | confirmMs | 4.60 / 5.60 | 4.40 / 6.00 | -4% |
| contract-1p | exportMs | 0.60 / 0.80 | 0.60 / 2.50 | +0% |
| contract-1p | totalMs | 9.20 / 10.80 | 8.80 / 14.50 | -4% |
| contract-10p | openMs | 1.40 / 2.00 | 1.30 / 1.60 | -7% |
| contract-10p | prepareMs | 2.90 / 3.70 | 2.50 / 3.20 | -14% |
| contract-10p | confirmMs | 4.40 / 6.80 | 3.70 / 5.00 | -16% |
| contract-10p | exportMs | 0.70 / 0.90 | 0.50 / 0.70 | -29% |
| contract-10p | totalMs | 9.30 / 12.90 | 8.00 / 10.00 | -14% |
| report-100p | openMs | 3.40 / 5.40 | 2.90 / 3.30 | -15% |
| report-100p | prepareMs | 5.40 / 9.00 | 5.10 / 7.90 | -6% |
| report-100p | confirmMs | 6.60 / 8.20 | 6.60 / 9.60 | +0% |
| report-100p | exportMs | 0.60 / 0.80 | 0.70 / 0.80 | +17% |
| report-100p | totalMs | 16.00 / 22.90 | 15.30 / 20.30 | -4% |
| synthetic-21mib | openMs | 286.50 / 339.00 | 221.40 / 240.90 | -23% |
| synthetic-21mib | prepareMs | 18.40 / 21.20 | 5.50 / 10.80 | -70% |
| synthetic-21mib | confirmMs | 22.30 / 27.00 | 6.80 / 7.70 | -70% |
| synthetic-21mib | exportMs | 15.90 / 22.40 | 14.90 / 16.90 | -6% |
| synthetic-21mib | totalMs | 330.20 / 403.10 | 247.80 / 270.50 | -25% |

### Warm stages (worker spans, p50 ms, before → after)

| Stage | contract-1p | contract-10p | report-100p | synthetic-21mib |
| --- | ---: | ---: | ---: | ---: |
| Transfer in | 0.80 → 0.70 | 0.60 → 0.60 | 0.60 → 0.80 | 0.90 → 0.70 |
| Document open (copy + SHA-256 checkpoint) | 1.00 → 1.40 | 1.10 → 1.70 | 5.10 → 4.60 | 235.30 → 222.90 |
| PDF open (copy into WASM) | 0.30 → 0.30 | 0.20 → 0.30 | 0.40 → 0.30 | 2.50 → 2.90 |
| Field resolve | 1.00 → 1.20 | 1.00 → 1.30 | 3.00 → 3.50 | 0.50 → 0.70 |
| `/AP` + incremental write | 1.90 → 1.90 | 1.40 → 2.20 | 4.90 → 5.50 | 0.90 → 1.10 |
| ByteRange digest | 0.10 → 0.10 | 0.00 → 0.10 | 0.10 → 0.10 | 0.00 → 0.00 |
| Prepare remainder | 2.10 → 2.50 | 1.70 → 2.20 | 2.40 → 2.20 | 9.00 → 1.40 |
| Prepare total | 5.40 → 6.20 | 4.60 → 6.00 | 10.80 → 11.80 | 13.30 → 6.20 |
| Signed attributes + CMS build | 0.10 → 0.10 | 0.10 → 0.10 | 0.10 → 0.10 | 0.10 → 0.00 |
| WebCrypto sign | 1.50 → 1.90 | 1.30 → 2.00 | 1.60 → 1.90 | 0.90 → 1.00 |
| CMS embed | 0.10 → 0.10 | 0.00 → 0.10 | 0.10 → 0.10 | 0.00 → 0.10 |
| Self-verify | 3.50 → 4.30 | 2.90 → 4.70 | 7.70 → 8.50 | 5.80 → 5.00 |
| Signed revision + receipt | 2.40 → 3.30 | 2.10 → 3.00 | 2.50 → 2.90 | 13.90 → 1.70 |
| Confirm total | 7.90 → 9.90 | 6.20 → 9.80 | 12.00 → 13.60 | 21.20 → 7.70 |
| Confirm without sign | 6.40 → 7.90 | 5.10 → 7.90 | 10.40 → 11.70 | 20.40 → 6.80 |
| Transfer back | 0.50 → 0.60 | 0.30 → 0.40 | 0.60 → 0.50 | 0.60 → 0.50 |
| Export copy | 0.10 → 0.10 | 0.10 → 0.20 | 0.20 → 0.30 | 15.20 → 7.90 |
| Document copies into WASM | 2.15 → 2.15 | 2.10 → 2.10 | 2.03 → 2.03 | 2.00 → 2.00 |

### Batches (7 signing helpers after)

| Documents | Metric | Before p50 / p95 | After p50 / p95 | Δ p50 |
| ---: | --- | ---: | ---: | ---: |
| 10 | prepareMs | 28.60 / 37.20 | 20.90 / 36.40 | -27% |
| 10 | signMs | 51.80 / 58.50 | 28.80 / 34.70 | -44% |
| 10 | totalMs | 82.70 / 95.70 | 49.50 / 71.10 | -40% |
| 10 | item prepare span | 3.40 / 5.90 | 13.50 / 18.60 | |
| 10 | item confirm span | 5.50 / 9.20 | 15.40 / 24.10 | |
| 10 | budget peak | 1.5 MiB | 2.3 MiB | |
| 10 | page heap peak | 25.5 MiB | 25.7 MiB | |
| 10 | worker heap peak | 53.7 MiB | 345.9 MiB | |
| 10 | worker backing-store peak | 109.7 MiB | 323.7 MiB | |
| 50 | prepareMs | 105.80 / 110.60 | 70.00 / 90.90 | -34% |
| 50 | signMs | 227.90 / 230.30 | 80.10 / 92.40 | -65% |
| 50 | totalMs | 328.40 / 338.10 | 158.00 / 183.30 | -52% |
| 50 | item prepare span | 3.00 / 5.50 | 23.60 / 27.20 | |
| 50 | item confirm span | 5.10 / 8.90 | 27.70 / 39.60 | |
| 50 | budget peak | 6.7 MiB | 7.9 MiB | |
| 50 | page heap peak | 28.7 MiB | 30.4 MiB | |
| 50 | worker heap peak | 71.9 MiB | 366.8 MiB | |
| 50 | worker backing-store peak | 69.9 MiB | 353.0 MiB | |
| 200 | prepareMs | 413.90 / 458.30 | 231.80 / 248.80 | -44% |
| 200 | signMs | 809.50 / 822.90 | 233.00 / 239.00 | -71% |
| 200 | totalMs | 1236.80 / 1267.80 | 464.80 / 475.10 | -62% |
| 200 | item prepare span | 2.60 / 7.60 | 22.70 / 29.80 | |
| 200 | item confirm span | 4.60 / 6.20 | 14.20 / 20.60 | |
| 200 | budget peak | 26.1 MiB | 27.3 MiB | |
| 200 | page heap peak | 41.1 MiB | 40.4 MiB | |
| 200 | worker heap peak | 86.1 MiB | 375.6 MiB | |
| 200 | worker backing-store peak | 94.9 MiB | 373.7 MiB | |

Signing helpers sweep, 200 documents (after):

| Helpers | Prepare | Sign | Total | Worker backing-store peak |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 360.60 / 423.80 | 748.80 / 782.60 | 1109.40 / 1206.40 | 66.2 MiB |
| 1 | 513.10 / 550.90 | 639.70 / 898.40 | 1190.60 / 1411.50 | 129.7 MiB |
| 2 | 306.20 / 315.10 | 412.40 / 434.10 | 727.50 / 740.30 | 168.8 MiB |
| 4 | 243.20 / 313.30 | 295.40 / 324.70 | 538.60 / 638.00 | 247.4 MiB |
| 7 | 284.10 / 351.30 | 270.50 / 289.20 | 573.30 / 621.80 | 364.3 MiB |


### What changed, per commit

| Commit | Change | Measured delta (p50, local host) |
| --- | --- | --- |
| `perf(pdf): hash opened revisions with WASM SHA-256 blocks` | Revision checkpoints hashed by the in-house Rust SHA-256 in 1 MiB chunks; JavaScript below 64 KiB | 21 MiB open 286.5 → 209.9 ms |
| `perf(engine): keep revisions as shared byte segments` | Preview and signed revisions share the source bytes; WASM copies come straight from segments | 21 MiB prepare 18.7 → 5.5 ms, confirm 21.0 → 6.7 ms, backing store 199 → 133 MiB |
| `perf(crypto): derive PKCS#12 keys with WebCrypto` | WebCrypto PBKDF2 and AES-CBC; allocation-free iterated SHA-256 for the MAC KDF | PKCS#12 parse 65.2 → 20.7 ms, A1 open 73.9 → 29.4 ms |
| `feat(browser): sign batches on a worker pool with a prewarm hook` | Helper workers adopt the shared `CryptoKey`; compute phases offloaded; concurrent batch preparation; `prewarm()`; eager CMS signer | Batch of 50 287 → 167 ms, 200 1302 → 531 ms, cold confirm 27.2 → 13.8 ms |
| `perf(browser): keep two batch items in flight per signing helper` | Pool concurrency defaults to twice the helper count | Batch of 200 547 → 465 ms; 2 helpers 1386 → 728 ms |

### Candidates evaluated

- **SHA-256:** for 21 MiB in V8, JavaScript 90 MiB/s, Rust WASM 130–140 MiB/s (a hand-tuned
  variant and SIMD128 did not beat the existing `sha2` rounds), WebCrypto about 190 MiB/s but with
  no resumable midstate. One resumable pass serves the revision digest, the ByteRange digest and
  the digests of preview and signed revisions, so WASM is kept for inputs of 64 KiB and more.
- **ByteRange concatenation:** the digest already continues the stored checkpoint over the two
  appendix parts; no segment is concatenated.
- **Copies:** the preview and signed revisions no longer copy the document; the remaining full
  copies are page → worker transfer, `Documents.open` ownership, one copy into WASM for the
  signing session, one for self-verify, and the export.
- **CMS template:** the per-session signer already precomputes the certificate chain DER; only
  signed attributes and the signature change per document. It is now built at A1 open.
- **Lazy engines:** `compose.wasm` and its fonts already load on first composition. Static checks
  forbid dynamic imports of known modules, so the compose and canvas JavaScript stay in the worker
  bundle.
- **Streaming compile:** the worker already uses `WebAssembly.compileStreaming` when the server
  sends `application/wasm`; compile is about 14 ms.

### Notes and pending

- Single signatures of 1–100 page documents were already within the 5 ms prepare / 5 ms confirm
  (without RSA) targets before this branch; their changes stay within host noise.
- Prewarm on the shipped entry starts `hardwareConcurrency - 1` helpers (27 here) on 8 reserved
  CPUs, which costs about 860 ms and does not shorten the following first signature. Its value is
  having helpers loaded before a batch or before the app goes offline.
- The helper sweep stops improving after 4 helpers under the 8-CPU reservation; scaling across
  more cores was not measured on an unconstrained host.
- Worker memory with 7 helpers is about 330–380 MiB of JavaScript heap in the dev-module harness.
- Module reuse across workers (posting a compiled `WebAssembly.Module` to helpers) was not
  implemented; each helper compiles its own module (about 14 ms, in parallel).

