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
