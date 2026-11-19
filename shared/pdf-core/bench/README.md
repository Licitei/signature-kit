# pdf-core benches

`triage-primitives.bench.ts` measures page-level triage workloads against a seeded PDF sample. It is the harness for comparing `@signature-kit/pdf-core` branches on latency, throughput, lazy I/O, Wasm linear memory, and Wasm size. Run it from the repository root after `bun run build` so `shared/pdf-core/dist/pdf-core.wasm` exists.

```sh
mkdir -p .cache/t
export TMPDIR="$PWD/.cache/t"
run="$HOME/.local/bin/resource-run"
"$run" --cpu 2 --mem 4G taskset -c 0 bun shared/pdf-core/bench/triage-primitives.bench.ts \
  --write-sample shared/pdf-core/bench/baselines/sample-400.json \
  --n 400 \
  --seed 1
"$run" --cpu 2 --mem 4G taskset -c 0 bun shared/pdf-core/bench/triage-primitives.bench.ts \
  --out shared/pdf-core/bench/baselines/main-b2cf7c3.json \
  --sample-file shared/pdf-core/bench/baselines/sample-400.json \
  --runs 3 \
  --memory-per-doc
"$run" --cpu 2 --mem 4G bun shared/pdf-core/bench/triage-primitives.bench.ts \
  --compare shared/pdf-core/bench/baselines/main-b2cf7c3.json candidate.json
```

`taskset -c 0` pins the single sequential worker to one CPU. The script never measures workloads in parallel. Each latency workload keeps one warm `makePdfCore` instance for every document in that run. The next workload gets a new instance. `--memory-per-doc` is a later pass and does not change those latency numbers.

The default corpus is `/home/yorizel/Documents/bench-parsers/pncp-triage/pdfs`. Repeat `--corpus DIR` to replace that default. Optional extra roots are `/home/yorizel/Documents/bench-parsers/pdfs` and `/home/yorizel/Documents/bench-parsers/editais-extra`.

Stdout is a Markdown table of the median run. Stderr is progress. The JSON path is `--out`. The writer then formats that file with the repository oxfmt config so `bun run check` accepts it. `--compare a.json b.json` prints candidate-minus-baseline deltas and does not measure.

## Sampling and runs

PDFs are listed recursively, sorted by full path with locale `en`, then sampled without replacement by mulberry32 (`seed`, default `1`). The chosen set is sorted by path again before measurement. `--n` defaults to 400. If the corpus is smaller, every PDF is used. A seeded sample is not stable once the corpus gains or loses files.

`--write-sample PATH` freezes the seeded sample and exits. The JSON lists each basename, the SHA-256 of its bytes, its byte size, and its page count. Page counts come from one eager `inspect` with text and links off, outside any timed workload. `shared/pdf-core/bench/baselines/sample-400.json` is the original 400 basenames behind `sampleKey` `54ed54fc02f42501f5f1e69e89c9db55b98f940fbba762da8a274abbe999d8a0`. The corpus has grown past the 2655 files that sample was drawn from, so `--write-sample` on the live default corpus draws a different 400. Regenerate this file only from a directory that contains exactly those basenames.

`--sample-file PATH` measures that frozen list instead of drawing a new sample. The bench resolves each basename in the selected corpora. It fails if a basename is missing, appears more than once, or the file's byte size or SHA-256 differs from the list. `--n` does not resize a frozen sample.

`--runs` defaults to 3. Each run uses one process and one warm Wasm instance per workload. Headline numbers are the median of the per-run aggregates. `runDetails` keeps each run. `sampleKey` is the SHA-256 of the sorted absolute paths. `sampleContentKey` is the SHA-256 of `basename`, content SHA-256, and byte size, sorted by basename, so the same files match even when their directories differ. `sampleBasenames` stores basenames only.

## Workloads

A missing method or option is `n/a` with a reason. Detection reads the service object and one lazy document from `makePdfCore`. Optional methods must be enumerable functions that return an `Effect`.

| id                   | call                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `text-eager-page1`   | `service.text(pdf, { pageIndexes: [0], format: "markdown" })`                                      |
| `text-lazy-page1`    | `openLazy` then `document.text({ pageIndexes: [0], format: "markdown" })`                          |
| `text-lazy-escalate` | the same session, page 0, then page 1 only when the document has at least 2 pages                  |
| `inspect-lazy-page1` | `document.inspect({ text: true, links: false, pageIndexes: [0] })` when present                    |
| `info-eager`         | `service.info(pdf)` when present                                                                   |
| `info-lazy`          | `document.info()` when present                                                                     |
| `headings-page1`     | `service.headings(pdf, { pageIndexes: [0] })`, otherwise `document.headings({ pageIndexes: [0] })` |
| `text-bounded-4000`  | eager `text` when `PdfCoreTextOptionsSchema` keeps `maxChars: 4000` together with page 0 markdown  |

Page indexes are zero-based, so page 1 in the product is index 0 and escalation to page 2 is index 1. Escalation calls page 2 only when the document has at least 2 pages. When the service and the lazy document both have `info`, the page count is `lazy.info` inside the timed session. Otherwise the bench uses the page count recorded on the sample, or counts pages once before the timed runs. A one-page document is not a failure. `singlePage` is that count. `text-lazy-escalate` latency percentiles use successful multi-page documents only (`latencyDocuments`). Throughput and elapsed time still include every document, because page 1 is still extracted.

## Metrics

Latency percentiles use nearest rank. The clock includes the file read. For `text-lazy-escalate`, single-page documents are left out of the latency distribution. Throughput is attempted documents divided by the workload wall clock, including failures and single-page documents. Eager `bytesRead` is the file size and `rangeRequests` is `n/a`. Lazy `bytesRead` is `stats.bytesRead` and `rangeRequests` is `stats.rounds`.

Wasm linear memory does not shrink. `wasmMemoryBytes.peak` is the high-water mark of the warm instance after the workload, including failures. It is not a per-document size. `--memory-per-doc` runs after the latency runs, one fresh `makePdfCore` instance per document, and reports p50, p90, and max of those per-document peaks in `perDocWasmMemoryBytes`. The pass collects garbage before each document so the next instance does not inherit the previous linear memory. That pass is not repeated per `--runs` and is omitted from `runDetails`. Latency runs stay on one warm instance. Wasm size is the built `dist/pdf-core.wasm` plus gzip level 9 and brotli quality 11.

Failure counts are grouped by `PdfCoreError` code. Other failures use `bench` or `defect`. Reasons are truncated to 160 characters. At most 20 failure basenames are stored.
