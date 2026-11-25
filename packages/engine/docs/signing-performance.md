# Local A1 signing performance

## Previous cut

The four synthetic PDFs come from the 1.x baseline corpus. The timed interval
starts with a loaded document handle and A1 session and ends with the receipt.
It includes preparation, confirmation and self-verification. Cleanup, PDF
generation, session import and final document export run outside that interval.
Each case uses three warm-ups and the median of seven samples. The detailed
Node trace is a separate signing cycle. The two Chromium worker runs include
the two RPC round trips.

| Synthetic PDF | 1.x Node | 2.0 Node before | 2.0 Node after | 1.x Chromium | 2.0 Worker before (telemetry) | 2.0 Worker after (telemetry) | 2.0 Worker after (default) |
| ------------- | -------: | --------------: | -------------: | -----------: | ----------------------------: | ---------------------------: | -------------------------: |
| 1 page        |     7.10 |           15.30 |           6.98 |         9.70 |                         21.90 |                         9.70 |                       8.00 |
| 20 pages      |     8.17 |           14.43 |           6.49 |         7.90 |                         18.90 |                        11.70 |                       7.10 |
| 200 pages     |    14.74 |           22.80 |          10.81 |        14.20 |                         28.70 |                        16.00 |                      12.30 |
| 21 MiB        |   170.62 |          675.98 |          21.25 |       151.20 |                        620.20 |                        26.10 |                      22.00 |

Times are in milliseconds. Historical 1.x measurements are in
[`baseline-v1.json`](../../../docs/local-first/baseline-v1.json). The 1.x
Chromium measurement ran in the page. The default worker has telemetry off.
The after measurements use the same four documents and fixtures.

| First signature on the handle after opening it (ms) |   Node | Default Chromium worker |
| --------------------------------------------------- | -----: | ----------------------: |
| 1 page                                              |  54.26 |                   63.40 |
| 20 pages                                            |   8.15 |                   11.10 |
| 200 pages                                           |  15.33 |                   21.80 |
| 21 MiB                                              | 235.42 |                  296.70 |

The first sample for each handle includes creating its WASM source buffer,
reading fields and computing the SHA-256 prefix checkpoint. The first corpus
also initializes the cached CMS signer for the A1 session. The warm result
uses the same source handle after these one-time costs.

## Restack profile

One instrumented Node sample per file, in milliseconds. Child steps are included
in the enclosing step, so the rows overlap. SHA-256 of the PDF ByteRange is
inside the Rust prepare call. The preview and signed fingerprints separately
hash their entire files with WebCrypto. CMS build time includes its child
WebCrypto signature span.

| Step                                                  | 1 page | 20 pages | 200 pages |  21 MiB |
| ----------------------------------------------------- | -----: | -------: | --------: | ------: |
| Prepare total                                         |  9.479 |    4.039 |     8.220 | 312.253 |
| Read signature fields in WASM                         |  0.230 |    0.357 |     2.083 |   0.519 |
| Write incremental update and digest ByteRange in WASM |  0.349 |    0.624 |     2.825 | 207.188 |
| Hash preview                                          |  2.028 |    0.331 |     0.753 |  80.931 |
| Confirm total                                         | 16.622 |   14.455 |    19.261 | 353.283 |
| Build CMS                                             |  6.303 |    5.250 |     5.120 |   7.890 |
| WebCrypto sign                                        |  2.177 |    2.594 |     2.260 |   3.437 |
| Write /Contents                                       |  0.105 |    0.121 |     0.093 |   2.887 |
| Self-verify total                                     |  8.927 |    8.091 |    12.431 | 254.207 |
| Check coverage                                        |  0.069 |    0.064 |     0.060 |   0.070 |
| Compare source prefix                                 |  0.096 |    0.100 |     0.432 | 139.084 |
| Find reachable signature dictionary and offsets       |  1.126 |    0.922 |     1.856 |   3.392 |
| Decode hex and unpad CMS                              |  1.324 |    1.042 |     1.063 |   1.796 |
| Collect complete signed ByteRange                     |  0.072 |    0.056 |     0.092 |   3.862 |
| Verify CMS, including ByteRange collection and rehash |  4.552 |    4.196 |     4.609 | 105.057 |
| Verify revision changes                               |  1.360 |    1.430 |     4.117 |   4.272 |
| Hash signed revision                                  |  0.294 |    0.268 |     0.821 |  81.568 |

Boundary buffer copies per traced cycle, as bytes followed by milliseconds
in parentheses. Signature analysis yields a fourth result, read directly via
WASM memory into JavaScript fields. The three output rows below are the observed
bulk buffer copies.

| Transfer              |        1 page |       20 pages |      200 pages |             21 MiB |
| --------------------- | ------------: | -------------: | -------------: | -----------------: |
| Source → fields       |   725 (0.205) |  6,736 (0.093) | 64,692 (0.095) | 22,027,211 (2.758) |
| Fields → JS           |    24 (0.186) |     24 (0.056) |     24 (0.065) |         28 (0.120) |
| Source → prepare      |   725 (0.303) |  6,736 (0.113) | 64,692 (0.108) | 22,027,211 (2.918) |
| Options → prepare     |   187 (0.268) |    187 (0.094) |    187 (0.116) |        187 (0.212) |
| Prepared payload → JS | 6,076 (0.079) | 12,101 (0.073) | 70,071 (0.070) | 22,032,583 (8.095) |
| Signed PDF → scan     | 6,004 (0.154) | 12,029 (0.089) | 69,999 (0.092) | 22,032,511 (2.424) |
| Signed PDF → changes  | 6,004 (0.162) | 12,029 (0.096) | 69,999 (0.096) | 22,032,511 (2.653) |
| Changes → JS          |   136 (0.066) |    136 (0.050) |    136 (0.052) |        136 (0.079) |

## Optimized path

`PdfEngine` retains the source allocation and field report for each signing
handle. Rust emits an append-only update with absolute PDF offsets. The engine
concatenates that update with its owned source snapshot. Confirmation copies
the update and writes the CMS only inside the checked hex hole. The PDF prefix
and both covered ranges therefore remain byte-identical to the preparation.
The engine can reuse the prepared ByteRange digest and finish each document's
SHA-256 fingerprint from the same prefix checkpoint. SHA-384 and SHA-512
ByteRanges use one WebCrypto digest at prepare time.

Before publishing the receipt, confirmation uses a single scoped WASM input
to find the new reachable signature and classify revision changes. It checks
that the parsed ByteRange and Contents offsets cover the file exactly. The
CMS verifier checks the DER envelope against the prepared signer, policy and
digest, requires zero padding and uses the session's cached public key to
verify the signature over the actual CMS signed attributes. Generic PDF
verification still checks the digest from the supplied document bytes.

| Warm transfer                       | 1 page | 20 pages | 200 pages |     21 MiB |
| ----------------------------------- | -----: | -------: | --------: | ---------: |
| Options → WASM                      |    187 |      187 |       187 |        187 |
| Prepared appendix and metadata → JS |  5,315 |    5,329 |     5,343 |      5,336 |
| Signed PDF → WASM                   |  6,004 |   12,029 |    69,999 | 22,032,511 |
| Changes → JS                        |    136 |      136 |       136 |        136 |

The warm cycle went from five to two JS-to-WASM buffer copies and three to two
WASM-to-JS buffer copies in both runtimes. The signature metadata is still
decoded directly from WASM. The first cycle includes one additional
JS-to-WASM copy of the source.

For the 21 MiB Node trace, generating the update took 0.52 ms in WASM and
finishing the ByteRange digest from the checkpoint took 0.09 ms. WebCrypto
signing took 3.39 ms and writing the hole took 0.21 ms. Self-verification took
6.09 ms, including 0.15 ms for the coverage check, 1.76 ms to find the
signature, 0.43 ms for hex decoding, 0.68 ms to verify the CMS and 2.42 ms
to classify the revision changes. The signed input copy took 3.18 ms before
self-verification started.

Reproduce with `bunx vitest run --reporter=verbose
packages/engine/__tests__/pdf-signatures.performance.test.ts` and
`bunx vitest run --reporter=verbose --config tooling/vitest/browser.config.ts
packages/browser/__tests__/pdf-signatures.browser.test.ts`.

## First-sign and telemetry profile on the restructured branch

The source snapshot now yields both its SHA-256 fingerprint and a reusable
checkpoint. Derived revisions advance that checkpoint using the incremental
suffix. The SHA-384 and SHA-512 ByteRanges retain their WebCrypto digest path.

A Node trace of the port at Rust opt-level `s` attributed 276.55 ms of the
first 21 MiB prepare to generating the checkpoint, and 2.81 ms to copying the
source into WASM. With the single-pass fingerprint and signed 32-bit SHA-256
arithmetic, the checkpoint took 215.32 ms during open in a separate trace.
The WASM copy remains scoped to the signing handle.

| 21 MiB, opt-level `s` | Open before | Open after | First sign before | First sign after | Open + first before | Open + first after |
| --------------------- | ----------: | ---------: | ----------------: | ---------------: | ------------------: | -----------------: |
| Node                  |       92.72 |     229.03 |            284.81 |            41.15 |              377.54 |             270.18 |
| Chromium worker       |      117.60 |     324.30 |            313.40 |            79.00 |              431.00 |             403.30 |

A first sign on an already-open handle no longer reads the source again for
SHA-256. Opening a large document for inspection alone takes longer with this
change.

A separate warm Chromium signing cycle plus cleanup recorded 42 spans and 43
attributes before the telemetry change. It now records 39 spans with the same
43 attributes. Coverage stays in the self-verification span, and the WASM
operation spans still time signature discovery and revision analysis. Attribute
validation selects the existing tuple schema by key. Worker collection still
validates the batch and transfers it through RPC.

| Chromium, opt-level `s` | Buffered bytes before → after | Collection RPC before → after (ms) | Page drain before → after (ms) |
| ----------------------- | ----------------------------: | ---------------------------------: | -----------------------------: |
| 20 pages                |               13,109 → 12,261 |                        6.30 → 4.20 |                    0.10 → 0.00 |
| 200 pages               |               13,110 → 12,262 |                        6.30 → 5.90 |                    0.00 → 0.10 |

Collection and drain run outside the prepare-to-receipt timing. In a separate
Chromium run at opt-level `2`, encoding the combined page and worker batch
with the RPC schema took 0.70 ms at 20 pages and 1.20 ms at 200 pages. The
collection RPC took 4.60 and 5.70 ms respectively, including transfer and
receipt validation. Both page drains were below the timer's 0.1 ms resolution.
The same run measured warm signing at 9.60 ms and 16.30 ms, respectively,
so the smaller batch does not establish a consistent signing latency at either size.

## WASM optimization comparison

The Rust 1.99.1 builds used the same checkout, Cargo target directory, and
Binaryen 130 `wasm-opt -O3 --converge` pipeline. The only Rust build variable
was `CARGO_PROFILE_RELEASE_OPT_LEVEL`. Raw size is from the optimized WASM.
Gzip size is from `gzip -n -c`. The host was an Intel Xeon E5-2680 v4 with
Bun 1.4.3, Node 26.13.1 and Chromium 156.0.8078.4.

Full `bench:pdf` used 30 edital PDFs, five batches per level, and the first
eight pages of the five smallest PDFs for render. Fixture columns show median
signature scan / document inspection / full text extraction in milliseconds.
The large fixture has 559 pages and 30,395,509 bytes.

| Rust opt-level | Raw bytes | Gzip bytes | Text ms/page | Render ms/page | 150-page fixture (ms) |     Large fixture (ms) |
| -------------- | --------: | ---------: | -----------: | -------------: | --------------------: | ---------------------: |
| `s`            |   918,869 |    412,255 |        2.012 |          1.723 |    1.12 / 1.72 / 8.30 | 18.62 / 16.35 / 998.17 |
| `2`            | 1,198,229 |    494,980 |        1.834 |          1.312 |    0.87 / 1.47 / 6.90 | 14.80 / 14.08 / 853.43 |
| `3`            | 1,249,727 |    508,753 |        1.841 |          1.340 |    0.72 / 1.35 / 7.97 | 14.66 / 14.18 / 836.81 |

Prepare plus confirmation includes self-verification. Each cell is warm median
of seven / first sign on an open handle, in milliseconds. Both measurements
use an already-open A1 session. The first PDF in each run also initializes the
session's cached CMS signer. Chromium timings include both worker RPC calls.

| Runtime                    | Synthetic PDF | `s` warm / first | `2` warm / first | `3` warm / first |
| -------------------------- | ------------- | ---------------: | ---------------: | ---------------: |
| Node                       | 1 page        |     5.98 / 56.73 |     7.10 / 57.70 |     7.12 / 58.55 |
| Node                       | 20 pages      |     8.29 / 10.66 |     7.90 / 10.83 |     8.14 / 10.21 |
| Node                       | 200 pages     |    15.26 / 20.63 |    13.14 / 20.31 |    14.78 / 18.69 |
| Node                       | 21 MiB        |    31.45 / 41.15 |    19.15 / 24.28 |    35.75 / 42.49 |
| Node, telemetry            | 1 page        |     6.86 / 16.75 |     7.41 / 18.70 |     8.94 / 20.29 |
| Node, telemetry            | 20 pages      |      7.28 / 8.92 |      6.84 / 9.51 |     7.99 / 10.07 |
| Node, telemetry            | 200 pages     |    13.94 / 19.16 |    12.35 / 16.21 |    15.11 / 16.00 |
| Node, telemetry            | 21 MiB        |    30.68 / 32.83 |    22.22 / 30.66 |    22.68 / 44.82 |
| Chromium worker            | 1 page        |     7.10 / 52.90 |     8.00 / 63.40 |     7.00 / 56.00 |
| Chromium worker            | 20 pages      |     8.10 / 13.20 |     7.40 / 11.20 |     6.60 / 11.50 |
| Chromium worker            | 200 pages     |    17.90 / 28.40 |    14.10 / 22.10 |    13.60 / 19.80 |
| Chromium worker            | 21 MiB        |    44.30 / 79.00 |    25.00 / 46.10 |    21.50 / 39.10 |
| Chromium worker, telemetry | 1 page        |     8.50 / 37.60 |     8.40 / 43.80 |     9.20 / 42.10 |
| Chromium worker, telemetry | 20 pages      |    12.20 / 28.80 |     8.00 / 13.10 |     8.90 / 23.40 |
| Chromium worker, telemetry | 200 pages     |    19.20 / 30.50 |    11.80 / 20.90 |    14.90 / 27.70 |
| Chromium worker, telemetry | 21 MiB        |    43.30 / 84.80 |    25.00 / 33.60 |    25.30 / 40.70 |

Use Rust `opt-level = 2`. Compared with `s`, text extraction was 8.8% faster per page, rendering was 23.9% faster per page, and the large signature scan was 20.5% faster. Levels `2` and `3` were within the observed run ranges on text and render. Their signing results varied by runtime. Level `2` saves 51,498 raw bytes and 13,773 gzip bytes against `3`. The budget increases from 1144 to 1184 KiB, leaving 14,187 bytes above the measured artifact.

## Final comparison with 1.x and the previous cut

Timings are milliseconds. The 1.x baseline ran Chromium signing in the page.
Its fresh-sign figure includes A1 setup, so it measures a wider interval than
2.0 first sign. The previous cut provided warm telemetry measurements for the
Chromium worker. A dash marks a missing historical measurement.

| Runtime         | PDF       | 1.x warm / fresh | Previous warm / first | Previous telemetry warm | Now warm / first | Now telemetry warm / first |
| --------------- | --------- | ---------------: | --------------------: | ----------------------: | ---------------: | -------------------------: |
| Node            | 1 page    |     7.10 / 71.69 |          6.98 / 54.26 |                       — |     7.10 / 57.70 |               7.41 / 18.70 |
| Node            | 20 pages  |     8.17 / 68.43 |           6.49 / 8.15 |                       — |     7.90 / 10.83 |                6.84 / 9.51 |
| Node            | 200 pages |    14.74 / 63.90 |         10.81 / 15.33 |                       — |    13.14 / 20.31 |              12.35 / 16.21 |
| Node            | 21 MiB    |  170.62 / 200.12 |        21.25 / 235.42 |                       — |    19.15 / 24.28 |              22.22 / 30.66 |
| Chromium worker | 1 page    |     9.70 / 65.40 |          8.00 / 63.40 |                    9.70 |     8.00 / 63.40 |               8.40 / 43.80 |
| Chromium worker | 20 pages  |     7.90 / 48.00 |          7.10 / 11.10 |                   11.70 |     7.40 / 11.20 |               8.00 / 13.10 |
| Chromium worker | 200 pages |    14.20 / 68.10 |         12.30 / 21.80 |                   16.00 |    14.10 / 22.10 |              11.80 / 20.90 |
| Chromium worker | 21 MiB    |  151.20 / 232.40 |        22.00 / 296.70 |                   26.10 |    25.00 / 46.10 |              25.00 / 33.60 |

At 21 MiB, open plus first sign measured 241.31 ms in Node and 334.80 ms in Chromium with telemetry off. The Chromium worker with telemetry took 8.00 ms on 20 pages and 11.80 ms on 200 pages. The default and telemetry variants ran separately, so differences between individual medians can include startup, GC, and host variation.
