# pdf-core benches

`triage-primitives.bench.ts` measures page-level triage workloads against a seeded PDF sample. It is the harness for comparing `@signature-kit/pdf-core` branches on latency, throughput, lazy I/O, Wasm linear memory, and Wasm size. Run it from the repository root after `bun run build` so `shared/pdf-core/dist/pdf-core.wasm` exists.

```sh
mkdir -p .cache/t
export TMPDIR="$PWD/.cache/t"
run="$HOME/.local/bin/resource-run"
"$run" --cpu 2 --mem 4G taskset -c 0 bun shared/pdf-core/bench/triage-primitives.bench.ts \
  --out shared/pdf-core/bench/baselines/main-b2cf7c3.json \
  --n 400 \
  --runs 3 \
  --seed 1
"$run" --cpu 2 --mem 4G bun shared/pdf-core/bench/triage-primitives.bench.ts \
  --compare shared/pdf-core/bench/baselines/main-b2cf7c3.json candidate.json
```

`taskset -c 0` pins the single sequential worker to one CPU. The script never measures workloads in parallel. Each workload gets a new `makePdfCore` instance, so linear-memory growth does not carry from one workload to the next.

The default corpus is `/home/yorizel/Documents/bench-parsers/pncp-triage/pdfs`. Repeat `--corpus DIR` to replace that default. Optional extra roots are `/home/yorizel/Documents/bench-parsers/pdfs` and `/home/yorizel/Documents/bench-parsers/editais-extra`.

Stdout is a Markdown table of the median run. Stderr is progress. The JSON path is `--out`. `--compare a.json b.json` prints candidate-minus-baseline deltas and does not measure.

## Sampling and runs

PDFs are listed recursively, sorted by full path with locale `en`, then sampled without replacement by mulberry32 (`seed`, default `1`). The chosen set is sorted by path again before measurement. `--n` defaults to 400. If the corpus is smaller, every PDF is used.

`--runs` defaults to 3. Each run uses one process and one Wasm instance per workload. Instances are not reused across workloads. Headline numbers are the median of the per-run aggregates. `runDetails` keeps each run. `sampleKey` is the SHA-256 of the sorted absolute paths and is not a file listing. `sampleBasenames` stores basenames only.

## Workloads

A missing method or option is `n/a` with a reason. Detection reads the service object and one lazy document from `makePdfCore`. Optional methods must be enumerable functions that return an `Effect`.

| id                   | call                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `text-eager-page1`   | `service.text(pdf, { pageIndexes: [0], format: "markdown" })`                                      |
| `text-lazy-page1`    | `openLazy` then `document.text({ pageIndexes: [0], format: "markdown" })`                          |
| `text-lazy-escalate` | the same session, page 0 then page 1                                                               |
| `inspect-lazy-page1` | `document.inspect({ text: true, links: false, pageIndexes: [0] })` when present                    |
| `info-eager`         | `service.info(pdf)` when present                                                                   |
| `info-lazy`          | `document.info()` when present                                                                     |
| `headings-page1`     | `service.headings(pdf, { pageIndexes: [0] })`, otherwise `document.headings({ pageIndexes: [0] })` |
| `text-bounded-4000`  | eager `text` when `PdfCoreTextOptionsSchema` keeps `maxChars: 4000` together with page 0 markdown  |

Page indexes are zero-based, so page 1 in the product is index 0 and escalation to page 2 is index 1. A one-page PDF fails that second call. The failure is counted. It is not rewritten into success.

## Metrics

Latency percentiles use nearest rank on successful documents only. The clock includes the file read. Throughput is attempted documents divided by the workload wall clock, including failures. Eager `bytesRead` is the file size and `rangeRequests` is `n/a`. Lazy `bytesRead` is `stats.bytesRead` and `rangeRequests` is `stats.rounds`. `wasmMemoryBytes()` is read after every document, including failures. The report gives the max and p90 of those per-document sizes. Wasm size is the built `dist/pdf-core.wasm` plus gzip level 9 and brotli quality 11.

Failure counts are grouped by `PdfCoreError` code. Other failures use `bench` or `defect`. Reasons are truncated to 160 characters. At most 20 failure basenames are stored.
