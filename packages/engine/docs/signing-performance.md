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

Collection and drain run outside the prepare-to-receipt timing. This profile
records the volume of attributes and gives a combined time for worker encoding,
transfer, and receipt validation. It does not time each stage separately.
