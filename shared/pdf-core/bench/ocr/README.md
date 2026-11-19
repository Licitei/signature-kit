# Portuguese OCR benchmark

See [OCR datasets and rasterizer](DATASETS.md) for the current generator and WASM raster ABI.

The runner compares OCR engines on the same 8-bit grayscale P5 images. Tesseract runs in Docker and is used only as a benchmark reference. The scripts and reference JSON are outside the published package.

[Baseline tables](BASELINES.md) cover clean and degraded synthetic inputs, real scans, and a PSM 6 check on single-line crops.

## Tesseract baselines

| Engine             | Tesseract options              | Portuguese model SHA-256                                           |
| ------------------ | ------------------------------ | ------------------------------------------------------------------ |
| `tesseract-lstm`   | `--oem 1`, tessdata 4.1.0      | `016c6a371bb1e4c48fe521908cf3ba3d751fade0ab846ad5d4086b563f5c528c` |
| `tesseract-legacy` | `--oem 0`, tessdata 4.1.0      | `016c6a371bb1e4c48fe521908cf3ba3d751fade0ab846ad5d4086b563f5c528c` |
| `tesseract-fast`   | `--oem 1`, tessdata_fast 4.1.0 | `c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb` |

The measured linux/amd64 image digest was `sha256:4930dd205f0507c4c353a3465a4da49f8705e3a1fa33af216ae60ed026653653` (platform manifest `sha256:5bc48c0f040272d758ef465706d8bd1394d8015ec04612b6a03616af36e8060e`). It contains Tesseract 5.3.0 (`5.3.0-2`), Leptonica 1.82.0 (`1.82.0-3+b3`), the Debian OSD model (`1:4.1.0-2`), and GNU time 1.9 (`1.9-0.2`). The Dockerfile pins the base digest and OCR executable version, downloads model files by commit hash, and verifies their checksums. Apt transitive dependencies and BuildKit metadata can change the digest of a rebuild. The report records the actual local image digest.

## Reproduce

From the repository root on Linux, with Bun, Docker, Poppler (`pdfimages`, `pdftotext`, `pdftoppm`), ImageMagick (`magick`), `taskset`, and `lscpu` available. The reference image hashes were produced with Poppler 26.10.0 and ImageMagick 7.1.2-35 Q16-HDRI.

```bash
mkdir -p .cache/t
export TMPDIR="$PWD/.cache/t"
resource="$HOME/.local/bin/resource-run"
bench=shared/pdf-core/bench/ocr
cache=shared/pdf-core/.cache
corpus="$HOME/Documents/bench-parsers/editais-extra"
engines=ours-native,ours-wasm,tesseract-lstm,tesseract-legacy,tesseract-fast

"$resource" --cpu 4 --mem 8G bun install --frozen-lockfile
"$resource" --cpu 2 --mem 8G docker build -t signature-kit-ocr-bench:5.3.0 "$bench"

git fetch origin ocr/synth
git show 84f31bd:shared/pdf-core/bench/ocr/generate-dataset.ts > "$TMPDIR/generate-dataset.ts"
for dpi in 150 200 300; do
  "$resource" --cpu 2 --mem 8G bun "$TMPDIR/generate-dataset.ts" "$corpus" \
    --split test --max-docs 4 --max-pages 2 --dpi "$dpi" --output "$cache/ocr-synthetic"
done

"$resource" --cpu 2 --mem 8G bun "$bench/prepare-real.ts" "$corpus/digitalizados" "$cache/ocr-real"

"$resource" --cpu 2 --mem 8G taskset -c 2 bun "$bench/run.ts" \
  --dataset "$cache/ocr-synthetic/test" --engines "$engines"
"$resource" --cpu 2 --mem 8G taskset -c 3 bun "$bench/run.ts" \
  --dataset "$cache/ocr-real" --engines "$engines"

"$resource" --cpu 2 --mem 8G bun "$TMPDIR/generate-dataset.ts" "$corpus" \
  --split test --mode lines --max-docs 1 --max-pages 1 --dpi 150 --output "$cache/ocr-block"
"$resource" --cpu 2 --mem 8G taskset -c 4 bun "$bench/run.ts" \
  --dataset "$cache/ocr-block/test" --limit 6 --psm 6
```

Adjust the logical CPU IDs for the local CPU affinity. The runner writes `report.json` and `report.md` to the timestamped directory it prints under `shared/pdf-core/.cache/ocr-report/`. Use `--limit N` for a small run in filename order, `--repeats N` for more trials (minimum three), or `--psm 6` for suites that use a single block of text. The default page segmentation mode is 3.

`ours-native` calls `shared/pdf-core/rust/target/release/pdf-core-ocr IMAGE --json`. Set `OCR_BENCH_NATIVE` to point to another build of that executable. `ours-wasm` calls `bun run "$OCR_BENCH_WASM_DRIVER" IMAGE --json`. The Bun driver should load the optional WASM and call the `@signature-kit/pdf-core/ocr` service, then write the shared output JSON to stdout. Both adapters validate the recognition contract and image dimensions. Both use GNU `/usr/bin/time -v` on the host (`OCR_BENCH_TIME` can point to another installation). A missing CLI or unset WASM driver is listed as skipped in the report. A selected engine that starts but fails aborts the run.

### Degraded variants

Use the same variables from above. This run measures variants of one held-out 150 DPI page. The scan and fax presets combine effects, so their blur, noise, and skew buckets overlap. The JPEG runs score the decoded JPEG pixels.

```bash
(
  set -euo pipefail
  cache="$PWD/$cache"
  synth=$(mktemp -d "$TMPDIR/ocr-synth.XXXXXX")
  trap 'rm -rf "$synth"' EXIT
  git archive 8bde487 shared/pdf-core/rust "$bench" | tar -x -C "$synth"
  export CARGO_TARGET_DIR="$PWD/shared/pdf-core/rust/target"
  ln -s "$CARGO_TARGET_DIR" "$synth/shared/pdf-core/rust/target"
  "$resource" --cpu 2 --mem 8G cargo build --manifest-path "$synth/shared/pdf-core/rust/Cargo.toml" \
    --release -p signature-kit-pdf-core-ocr --features synth --bin pdf-core-ocr-synth
  mkdir -p "$cache/ocr-degraded"
  base=845f081078df5855d4cc-p0-150-poppler
  for scenario in scan:bench-0 fax:bench-0 jpeg:bench-3 jpeg:bench-116 jpeg:bench-14; do
    preset=${scenario%:*}
    seed=${scenario#*:}
    output="$synth/generated/$preset-$seed"
    "$resource" --cpu 2 --mem 8G bun "$synth/$bench/generate-dataset.ts" "$corpus" \
      --split test --labels poppler --max-docs 4 --max-pages 1 --dpi 150 \
      --preset "$preset" --seed "$seed" --output "$output"
    for reference in "$output/test/$base"-*.json; do
      cp "$reference" "$cache/ocr-degraded/"
      id=$(basename "$reference" .json)
      if [[ -f "$output/test/$id.jpg" ]]; then
        magick "$output/test/$id.jpg" -colorspace Gray -depth 8 "$cache/ocr-degraded/$id.pgm"
      else
        cp "$output/test/$id.pgm" "$cache/ocr-degraded/"
      fi
    done
  done
  "$resource" --cpu 2 --mem 8G taskset -c 5 bun "$bench/run.ts" --dataset "$cache/ocr-degraded"
)
```

## Images and references

- **Synthetic.** The pinned `ocr/synth` generator renders the held-out test split with Poppler and derives text and boxes from the PDF text layer. This run uses eight source pages, each at 150, 200, and 300 DPI. It exercises clean input at three scales. The runner also categorizes pages by populated `blur`, `noise`, `skew`, and `bilevel` fields and numeric `jpegQuality` or `jpeg` fields in `degradation`. Supply degraded pixels in each variant's `<id>.pgm` so the benchmark can read the same pixels for every engine. Optional JPEG, PNG, and TIFF files may accompany the lossless master.
- **Real scans.** The 20 references span 15 documents. This convenience sample favors legible single-image pages and includes covers, closing pages, and a budget table. `prepare-real.ts` extracts the selected image XObject with `pdfimages -j`, converts it to P5 grayscale, and checks the committed SHA-256. Page numbers in the references are one-based. Images stay in the local cache.
- **Review.** Each real scan started from standard-model LSTM text (`por --oem 1 --psm 3`), and the printed lines were checked and corrected against the raster. The JSON includes `reviewed: "model-assisted"`, line-level text, and `seedCharacterEdits`. Across the 20 pages there were **2,129** NFC code point insertions, deletions, or substitutions after trimming seed lines and removing blank seed lines. This count includes layout and punctuation changes. Readable printed headers and footers are included. Handwriting, graphical seals, watermarks, leader dots and form rules are omitted. Some small or faded lettering is uncertain. The reference is biased toward Tesseract's segmentation, especially for tables and complex reading order. Real-scan box metrics are unavailable because the sample has no manual word-box annotations.

## Scoring and timing

- CER uses Unicode code points after NFC. WER tokenizes on whitespace. The normalized scores additionally collapse whitespace and lowercase text. Both variants retain diacritics and punctuation. Scores are micro-averages over reference counts. Empty denominators are shown as unavailable.
- Geometry uses greedy, one-to-one, descending-IoU matching at `IoU ≥ 0.5`. Box+text applies the same match with exact NFC text equality. Bag F1 is the multiset overlap of normalized tokens and ignores reading order.
- Each engine runs on one logical CPU. Tesseract additionally uses `OMP_THREAD_LIMIT=1` and one container per engine and dataset. Each page uses a fresh process. The timer inside the container includes CLI and model startup, input reading, OCR, and TSV writing. It excludes container startup and harness scoring. Native timings include process startup and stdout capture. WASM driver timings include Bun startup and service initialization.
- Latency summaries use the median of three elapsed times for each page. P95 is nearest-rank, and pages/s is the reciprocal of mean seconds per page. Peak RSS is the maximum GNU time high-water mark from all runs in the bucket, in KiB. Accuracy is scored on trial one, and the JSON reports the count of distinct outputs across trials. This shared-host run uses affinity and a resource reservation. Other host processes can still affect wall-clock timings.
