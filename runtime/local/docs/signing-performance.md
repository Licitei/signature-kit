# Warm A1 signing

The four synthetic PDFs come from the 1.x baseline corpus. The timed interval
starts with a loaded document handle and A1 session and ends with the receipt.
It includes preparation, confirmation and self-verification. Cleanup, PDF
generation, session import and final document export run outside that interval.
Each case uses three warm-ups and the median of seven samples. The Node timing
runs with the tracer disabled. Chromium uses the telemetry worker and includes
two RPC round trips. The detailed Node trace is a separate signing cycle.

| Synthetic PDF | 1.x Node (ms) | 2.0 restack Node (ms) | 1.x Chromium (ms) | 2.0 restack Chromium worker (ms) |
| --- | ---: | ---: | ---: | ---: |
| 1 page | 7.10 | 15.30 | 9.70 | 21.90 |
| 20 pages | 8.17 | 14.43 | 7.90 | 18.90 |
| 200 pages | 14.74 | 22.80 | 14.20 | 28.70 |
| 21 MiB | 170.62 | 675.98 | 151.20 | 620.20 |

The historical 1.x measurements are in
[`baseline-v1.json`](../../../docs/local-first/baseline-v1.json). The 1.x
Chromium measurement ran in the page. The 2.0 Chromium measurement includes the
worker transport.

## Restack profile

One instrumented Node sample per file, in milliseconds. Child steps are included
in the enclosing step, so the rows overlap. SHA-256 of the PDF ByteRange is
inside the Rust prepare call. The preview and signed fingerprints separately
hash their entire files with WebCrypto. CMS build time includes its child
WebCrypto signature span.

| Step | 1 page | 20 pages | 200 pages | 21 MiB |
| --- | ---: | ---: | ---: | ---: |
| Prepare total | 9.479 | 4.039 | 8.220 | 312.253 |
| Read signature fields in WASM | 0.230 | 0.357 | 2.083 | 0.519 |
| Write incremental update and digest ByteRange in WASM | 0.349 | 0.624 | 2.825 | 207.188 |
| Hash preview | 2.028 | 0.331 | 0.753 | 80.931 |
| Confirm total | 16.622 | 14.455 | 19.261 | 353.283 |
| Build CMS | 6.303 | 5.250 | 5.120 | 7.890 |
| WebCrypto sign | 2.177 | 2.594 | 2.260 | 3.437 |
| Write /Contents | 0.105 | 0.121 | 0.093 | 2.887 |
| Self-verify total | 8.927 | 8.091 | 12.431 | 254.207 |
| Check coverage | 0.069 | 0.064 | 0.060 | 0.070 |
| Compare source prefix | 0.096 | 0.100 | 0.432 | 139.084 |
| Find reachable signature dictionary and offsets | 1.126 | 0.922 | 1.856 | 3.392 |
| Decode hex and unpad CMS | 1.324 | 1.042 | 1.063 | 1.796 |
| Collect complete signed ByteRange | 0.072 | 0.056 | 0.092 | 3.862 |
| Verify CMS, including ByteRange collection and rehash | 4.552 | 4.196 | 4.609 | 105.057 |
| Verify revision changes | 1.360 | 1.430 | 4.117 | 4.272 |
| Hash signed revision | 0.294 | 0.268 | 0.821 | 81.568 |

Boundary buffer copies per traced cycle, as bytes followed by milliseconds
in parentheses. Signature analysis yields a fourth result, read directly via
WASM memory into JavaScript fields. The three output rows below are the observed
bulk buffer copies.

| Transfer | 1 page | 20 pages | 200 pages | 21 MiB |
| --- | ---: | ---: | ---: | ---: |
| Source → fields | 725 (0.205) | 6,736 (0.093) | 64,692 (0.095) | 22,027,211 (2.758) |
| Fields → JS | 24 (0.186) | 24 (0.056) | 24 (0.065) | 28 (0.120) |
| Source → prepare | 725 (0.303) | 6,736 (0.113) | 64,692 (0.108) | 22,027,211 (2.918) |
| Options → prepare | 187 (0.268) | 187 (0.094) | 187 (0.116) | 187 (0.212) |
| Prepared payload → JS | 6,076 (0.079) | 12,101 (0.073) | 70,071 (0.070) | 22,032,583 (8.095) |
| Signed PDF → scan | 6,004 (0.154) | 12,029 (0.089) | 69,999 (0.092) | 22,032,511 (2.424) |
| Signed PDF → changes | 6,004 (0.162) | 12,029 (0.096) | 69,999 (0.096) | 22,032,511 (2.653) |
| Changes → JS | 136 (0.066) | 136 (0.050) | 136 (0.052) | 136 (0.079) |
