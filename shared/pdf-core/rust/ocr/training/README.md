# OCR recognition

`recognize_line(&Bits, &Line) -> Vec<Word>` uses the word boxes from the
segmenter. It projects packed ink into columns and scores candidate glyph cuts
with the trained model and a bounded character bigram. Word boxes remain in
source order. The result carries the original box, a confidence heuristic in
`[0, 1]`, and up to three distinct alternate readings.

The deployed table is the line-normalized glyph classifier trained with clean
and degraded document crops. It improved both font test conditions over the
prototype and preserved much more text on scan-degraded PDF lines than the
clean-only model. The decoder uses fixed-width beams and reconstructs strings
after ranking. Confident ink runs reuse their classification and skip redundant
cuts.

The runtime embeds `../data/recognition.bin` in the optional OCR WASM module.
The pdf-core WASM does not load the model. The OCR engine calls this Rust API
through its existing page recognition function. Recognition adds no C ABI
exports.

## Experimental CTC v3

Build the native recognizer and trainer from the repository root.

```sh
mkdir -p "$PWD/.cache/t" "$PWD/shared/pdf-core/.cache/train"
export TMPDIR="$PWD/.cache/t"
runner=/home/yorizel/.local/bin/resource-run
rust="$PWD/shared/pdf-core/rust"
training="$rust/ocr/training"
trainer="$rust/target/release/pdf-core-ocr-train"
native="$rust/target/release/pdf-core-ocr"
bench="$PWD/shared/pdf-core/bench/ocr"
out="$PWD/shared/pdf-core/.cache/train"
corpus=/home/yorizel/Documents/bench-parsers

"$runner" --cpu 4 --mem 8G cargo build --manifest-path "$rust/Cargo.toml" --release \
  -p signature-kit-pdf-core-ocr --features ctc-v3,ctc-probe,synth --bins
```

The v3 table uses `OCRV`, 32 x-height-normalized samples in each input
column, and 288 hidden channels. Three temporal convolutions have kernels
5/3/3 at dilations 1/3/16, for a receptive field of 43 frames. The input
stride is one-eighth of the measured x-height, bounded below by half a
source pixel. The four layers each have per-output-channel int8 weights,
an f32 bias and an f32 scale. The table is supplied to the experimental
CLI with `--ctc-model` or to the development-only wasm probe. Greedy CTC
uses the highest-posterior frame in each emitted run for its x position.
The page engine refines word boxes against segmentation and projects them
back to the original image. The reported word confidence is the lowest
selected frame confidence in the word.

`ctc-beam` enables width-eight Viterbi search over the CTC lattice for page
recognition. It applies the glyph model's corpus character bigram on new
emissions. It retains the blank transition separately to handle repeated
letters. `ocr-lexicon` enables Portuguese word correction at the page
boundary. These are separate experimental build options.

The native trainer uses f32 minibatches with width bucketing, seeded
augmentation, independent gradient workers, deterministic worker reduction,
norm clipping, bias-corrected Adam, warmup and cosine decay. On x86-64 it
probes AVX2 and FMA once and falls back to scalar kernels on unsupported
CPUs. The best int8 table is selected by CER on the validation archive.
The log includes both f32 and int8 validation error counts for each selected
epoch. The `.bin.checkpoint` file records the model, optimizer moments and
progress after each epoch. Pass `--resume` with the original arguments and
same input and hardware. `--initial=MODEL` initializes matching weights
from another v3 table and starts a new optimizer. `--qat=N` uses fake
quantized weights and activations in the final N epochs and completes
the fixed schedule. Ordinary runs support `--patience=N` for early stopping.

The [dataset pipeline](../../../bench/ocr/DATASETS.md) can write clean
train pages from the full native PDF tree. Use one corpus root for train,
validation, and test so document assignment stays stable. Omit the
page and document caps for a full-data build. The trainer consumes
`OCRT` archives and the calibrated `OCRL` line shards from that pipeline.
It reads shards one record at a time, binarizes each crop once, and retains
packed lines that segment as a single line. The following commands create
the bounded corpus used to exercise the shard path.

```sh
"$runner" --cpu 4 --mem 8G bun "$bench/generate-dataset.ts" "$corpus" \
  --labels poppler --mode pages --split train --dpi 150 --max-docs 24 --max-pages 6 \
  --output "$out/clean-train-pages"
"$runner" --cpu 4 --mem 8G bun "$bench/training-lines.ts" generate \
  "$out/clean-train-pages/train" "$out/mixed-shards" 24000 4 137
"$runner" --cpu 2 --mem 4G python "$bench/real_lines.py" regenerate \
  "$corpus/editais-extra/digitalizados" "$out/line-reviews"
for split in dev test; do
  "$runner" --cpu 2 --mem 4G bun "$training/generate.mjs" import \
    "$out/line-reviews/$split" "$out/reviewed-$split.ocrt" --text-only-lines
done
```

Train the bootstrap experiment using the generated Liberation archive and
the distinct GNU FreeFont validation archive described below. Tesseract
compares the same thresholded OCRT images using Portuguese LSTM and PSM 7.
Use the real dev split for model selection and reserve real test crops for evaluation.

```sh
"$runner" --cpu 12 --mem 12G "$trainer" train-sequence "$out/v3-bootstrap.bin" \
  1729 12 24 --warm=6 --patience=6 --validation="$out/bootstrap/val.ocrt" "$out/bootstrap/train.ocrt"
for dataset in "$out/bootstrap/test.ocrt" "$out/bootstrap/test-degraded.ocrt" \
  "$out/real-scans.ocrt" "$out/reviewed-test.ocrt"; do
  "$runner" --cpu 1 --mem 4G "$trainer" evaluate-sequence "$dataset" "$out/v3-bootstrap.bin"
done
```

Use the [page benchmark](../../../bench/ocr/README.md) on the held-out page
datasets. Set `OCR_BENCH_NATIVE="$native"` and `OCR_BENCH_CTC_MODEL` to the
experimental table to route the native benchmark through the full OCR
pipeline. Fit and compare on the dev split before interpreting test scores.

### D3 pilot measurements

Line CER below excludes whitespace and uses identical thresholded OCRT
inputs for each engine. That measurement supplies crop geometry directly
to CTC. The raw grayscale page and single-line benchmarks also exercise
the page preprocessing and segmentation pipeline.

| Model                             | Training pool                                     | Epochs | Training wall time | Parameters | Table bytes | Clean CER | Degraded CER | Reviewed scan CER | Native clean ms/line |
| --------------------------------- | ------------------------------------------------- | -----: | -----------------: | ---------: | ----------: | --------: | -----------: | ----------------: | -------------------: |
| v3 bootstrap                      | 792 Liberation lines                              |     24 |         1,082.20 s |    592,004 |     599,880 |    23.51% |       26.49% |            93.70% |                29.17 |
| v3 mixed, QAT in final two epochs | 54,579 accepted entries before alphabet filtering |      6 |           240.47 s |    593,738 |     601,680 |    21.09% |       26.35% |            76.17% |                31.52 |
| Tesseract LSTM 5.3.0              | Published Portuguese model                        |      — |                  — |          — |  15,336,931 |     0.49% |        0.82% |            12.92% |                96.69 |
| Tesseract fast 5.3.0              | Published Portuguese fast model                   |      — |                  — |          — |   1,982,756 |     0.75% |        1.36% |            13.11% |                61.65 |

The clean and degraded line sets each contain 96 lines and 4,254
non-whitespace characters. The reviewed scan column uses 431 lines and
15,877 non-whitespace characters. Native inference timings use three
repetitions over preloaded archives. Tesseract timings include one process
startup and image decoding for each archive. The hosts shared CPU with
other jobs during these runs.

Bootstrap selected epoch 24 on the independent GNU FreeFont validation
set, with 2,318 int8 and 2,314 f32 edits over 8,100 characters. The mixed
run started from the selected bootstrap table. It mixed 9,504 Liberation
entries, 24,000 clean PDF lines, and 21,075 accepted records from 24,000
augmented OCRL records. The clean PDF archive was a systematic sample of
335,305 complete line labels from a bounded all-page render stopped during
the initial corpus pilot. The OCRL set came from 144 pages across 24 train
documents. The mixed run processed 5,960 lines after CTC filtering and
selected epoch 6 on the degraded font validation and 186 real dev crops,
with 8,043 int8 and 8,003 f32 edits over 14,832 characters. The remaining
int8 gap was 0.27 percentage points. The 431 real test crops were evaluated
after model selection.

The mixed weights are in [sequence-v3-mixed.bin](../data/sequence-v3-mixed.bin)
with SHA-256 `dcae460143972ad7b0f0b25b333b89860cf31ae22b5286e7d65a9cd27fcbb836`.
Use the exported table to reproduce the comparisons directly.

```sh
for dataset in "$out/bootstrap/test.ocrt" "$out/bootstrap/test-degraded.ocrt" "$out/reviewed-test.ocrt"; do
  "$runner" --cpu 3 --mem 6G "$trainer" evaluate-sequence "$dataset" \
    "$rust/ocr/data/sequence-v3-mixed.bin" --repeats=3
done
OCR_BENCH_CTC_MODEL="$rust/ocr/data/sequence-v3-mixed.bin" \
  "$runner" --cpu 3 --mem 6G bun "$bench/run.ts" \
  --dataset "$out/line-reviews/test" --engines ours-native --psm 7
"$runner" --cpu 2 --mem 4G bun "$bench/run.ts" \
  --dataset "$out/line-reviews/test" --engines tesseract-lstm,tesseract-fast --psm 7
```

### Original grayscale test crops

The common page harness scored the same 431 hash-verified grayscale crops
from ten test documents. It ran Tesseract with PSM 7. Both SignatureKit
variants used their full native pipeline. Raw CER retains whitespace and
case. Normalized CER collapses whitespace and lowercases. Each time is
the mean of the per-crop medians over three separate processes.

| Engine                        | Raw CER | Normalized CER | Raw WER | Mean ms/crop |
| ----------------------------- | ------: | -------------: | ------: | -----------: |
| SignatureKit glyph            |  59.78% |         53.51% | 175.64% |        11.65 |
| SignatureKit v3 mixed, greedy |  44.95% |         39.74% | 104.10% |        84.82 |
| Tesseract LSTM 5.3.0          |   0.96% |          0.91% |   5.06% |       498.57 |
| Tesseract fast 5.3.0          |   0.90% |          0.89% |   4.29% |       585.61 |

The real-crop references were seeded by Tesseract and visually reviewed.
They favor legible, successfully segmented lines. The separate 20-page
benchmark measures reading order and page segmentation on less constrained
inputs. During timing, other jobs shared the Xeon E5-2680 v4 host and its
logical CPU 0. Comparisons establish the observed latency in these runs.

### Full-page benchmark

Values are raw CER and mean milliseconds per page from the common harness.
Clean and degraded each use eight held-out 150 DPI native PDF pages.
The real set uses all 20 hash-verified page references. Three CLI trials
were run per page. Tesseract used PSM 3.

| Engine                     |    Clean CER / ms | Degraded CER / ms | Real-page CER / ms |
| -------------------------- | ----------------: | ----------------: | -----------------: |
| SignatureKit glyph         |    12.07% / 66.18 |    28.17% / 81.59 |    192.92% / 62.35 |
| v3 mixed, greedy           | 15.96% / 4,871.54 | 23.40% / 4,852.78 | 107.74% / 5,441.96 |
| v3 mixed, beam and lexicon | 14.25% / 3,593.31 | 21.51% / 1,816.43 | 110.96% / 2,190.77 |
| Tesseract LSTM 5.3.0       |  4.00% / 5,667.12 | 12.98% / 4,441.45 |  11.15% / 2,036.13 |
| Tesseract fast 5.3.0       |  4.03% / 2,973.21 | 13.25% / 2,599.57 |  14.05% / 1,313.85 |

CER can exceed 100% when inserted text outnumbers reference characters.
Against greedy CTC, beam and lexicon lowered clean and degraded CER by
1.71 and 1.89 points and raised real-page CER by 3.22 points. These variants
were timed in separate shared-host windows, with different levels of CPU
contention. The wall times do not isolate decoder overhead.

```sh
for dataset in "$out/clean-pages/test" "$out/scan-pages/test" "$out/real-pages"; do
  OCR_BENCH_CTC_MODEL="$rust/ocr/data/sequence-v3-mixed.bin" \
    "$runner" --cpu 3 --mem 6G bun "$bench/run.ts" --dataset "$dataset" --engines ours-native
  "$runner" --cpu 2 --mem 4G bun "$bench/run.ts" \
    --dataset "$dataset" --engines tesseract-lstm,tesseract-fast
done
```

Build with `ctc-v3,ctc-probe` for greedy inference and
`ctc-v3,ctc-beam,ocr-lexicon` for the second v3 configuration. To generate
the clean and degraded pages, use the corpus root above and
`--labels poppler --mode pages --split test --dpi 150 --max-docs 4
--max-pages 2 --seed d3`, with `--preset clean` and `--preset scan`
respectively. Use `prepare-real.ts` for the 20 real pages.

### WebAssembly measurements

The scalar and SIMD v3 probes were rebuilt with the same flags other than
`simd128`. They returned byte-identical transcripts on 32 evenly spaced
reviewed dev lines and on the real page whose PGM contains a header
comment. Both v3 variants loaded the 601,680-byte mixed table.

| Workload                    | Scalar mean ms | SIMD mean ms | Tesseract fast mean ms |
| --------------------------- | -------------: | -----------: | ---------------------: |
| 32 real dev lines, per line |         176.77 |        62.58 |                 132.18 |
| Commented PGM, per page     |      11,892.44 |     4,823.58 |               5,970.08 |

The SIMD probe was 236,150 bytes. Probe plus table was 837,830 bytes.
The scalar probe was 234,365 bytes. The older bootstrap probe run also
matched scalar and SIMD transcripts on eight clean and eight degraded
test pages. On those page batches SIMD took 11,612.96 and 9,851.10
ms/page, compared with 6,125.20 and 2,957.77 for Tesseract fast. Its scalar
times were 30,571.04 and 29,346.35 ms/page. The page and line results were
measured in different shared-host windows. The probe timer includes
page preparation and OCR. The Tesseract batch infers DPI and measures
one process over the same input files.

The main PDF WASM was rebuilt from the base and this branch using the same
Rust 1.99.1 and Binaryen binaries. Both files were 1,155,988 bytes and
matched SHA-256
`220869496257eae3419cbbc84eb2e4edf32b8447b49a7f04014e4f60d4228b19`.

### Full training corpus

The [streaming generator](../../../bench/ocr/DATASETS.md#stream-the-full-training-corpus)
completed all 4,016 training PDF paths with zero render failures. It
rendered 71,003 pages and wrote 828,361 OCRL records across 3,597 shards.
There were 70,406 pages with at least one usable training line. The
split was audited by SHA-256 of PDF bytes. Thirteen training paths
matched a nominal validation or test PDF. None matched the four evaluated
synthetic source documents or the original real scans. Exclude the shards
for all thirteen paths from the corpus training roster.

## Training and evaluation

From the workspace root, install the repository dependencies and make Bun,
Poppler, `djpeg`, Tesseract 5 with `por.traineddata`, and the Liberation,
GNU FreeFont and Adwaita faces available. The commands write generated inputs
to the ignored worktree cache and read the procurement corpus in place.

```sh
export TMPDIR="$PWD/.cache/t"
mkdir -p "$TMPDIR/recognition"
runner=/home/yorizel/.local/bin/resource-run
rust="$PWD/shared/pdf-core/rust"
training="$rust/ocr/training"
corpus=/home/yorizel/Documents/bench-parsers
out="$TMPDIR/recognition"

"$runner" --cpu 4 --mem 8G bunx nx run @signature-kit/pdf-core:build
(
  cd "$rust"
  "$runner" --cpu 2 --mem 4G cargo build -p signature-kit-pdf-core-ocr --release \
    --features synth --bins
)
"$runner" --cpu 2 --mem 3G bun "$training/generate.mjs" bootstrap \
  shared/pdf-core/dist/pdf-core.wasm "$out" \
  /usr/share/fonts/liberation /usr/share/fonts/gnu-free /usr/share/fonts/Adwaita
"$runner" --cpu 2 --mem 3G bun "$training/generate.mjs" corpus \
  shared/pdf-core/dist/pdf-core.wasm "$corpus" "$out/procurement.txt"
```

Generate document crops using the [dataset split](../../../bench/ocr/README.md).
The same source root and split rule are used for corpus extraction and image
training. Only the training documents and Liberation sheets contribute weights
or language counts. Bootstrap validation uses GNU FreeFont and bootstrap test
uses Adwaita faces. Their reference texts are distinct.

```sh
generate() {
  name=$1
  split=$2
  dpi=$3
  preset=$4
  documents=$5
  "$runner" --cpu 4 --mem 8G bun shared/pdf-core/bench/ocr/generate-dataset.ts \
    "$corpus" --output "$out/$name" --mode pages --split "$split" \
    --dpi "$dpi" --preset "$preset" --seed d2-1729 --max-docs "$documents" --max-pages 1
  shift 5
  "$runner" --cpu 2 --mem 6G bun "$training/generate.mjs" import \
    "$out/$name/$split" "$out/$name.ocrt" "$@"
}
generate native-clean-train train 300 clean 200
generate native-scan-train train 200 scan 120
generate native-fax-train train 150 fax 120
generate native-jpeg-train train 150 jpeg 120 --jpeg
generate native-clean-val val 300 clean 12
generate native-scan-val val 200 scan 12
generate native-clean-test test 300 clean 12
generate native-scan-test test 200 scan 12
```

The native evaluation times recognition on packed lines with reference word
boxes. The character accuracy uses Unicode Levenshtein distance over each
line with whitespace removed. The oracle score classifies reference glyph
boxes individually. The 50-line timing excludes raster decoding, deskew,
word-box segmentation and process startup.

```sh
trainer="$rust/target/release/pdf-core-ocr-train"
"$runner" --cpu 1 --mem 3G "$trainer" evaluate "$out/test.ocrt"
"$runner" --cpu 1 --mem 3G "$trainer" evaluate "$out/test-degraded.ocrt"
"$runner" --cpu 1 --mem 3G "$trainer" inspect "$out/test-degraded.ocrt" "$out/failures"
"$runner" --cpu 1 --mem 2G bun "$training/tesseract.mjs" "$out/test.ocrt"
"$runner" --cpu 1 --mem 2G bun "$training/tesseract.mjs" "$out/test-degraded.ocrt"
```

The Tesseract script uses the same binary pixels and transcriptions as the
native evaluator. Tesseract runs LSTM Portuguese with one line per input
image and one process per archive. Its timing includes process startup and
image decode.

## Train the models

The glyph experiment used a 16 × 16 coverage grid and four geometry values.
The two modes sample height over the ink bounds (`glyph`) or the line baseline
and x-height (`line`). The mixed experiment adds distorted document lines and
a rejection class trained on cropped and merged glyph candidates.

```sh
"$runner" --cpu 2 --mem 4G "$trainer" train-network "$out/native-line.bin" 1729 line \
  "$out/procurement.txt" "$out/train.ocrt" "$out/native-clean-train.ocrt"
"$runner" --cpu 2 --mem 4G "$trainer" train-network "$out/mixed-line.bin" 1729 line \
  "$out/procurement.txt" --reject "$out/train.ocrt" "$out/native-clean-train.ocrt" \
  "$out/native-scan-train.ocrt" "$out/native-fax-train.ocrt" "$out/native-jpeg-train.ocrt"
"$runner" --cpu 2 --mem 4G "$trainer" evaluate "$out/test.ocrt" "$out/mixed-line.bin"
```

The CTC trainer starts with random weights and computes a log-domain CTC
forward/backward pass. Optional warm epochs use the reference glyph coordinates
to train frame alignments. Seeded baseline and scale jitter run inside each
worker. Workers accumulate gradients independently and reduce them in a fixed
order. The seed, worker count, epoch count, options and input order must match
to reproduce a table. Three temporal convolution layers over 32-row input
columns use kernel widths 5, 3 and 3 at dilations 1, 3 and 8. An output
projection scores Unicode classes and CTC blank. The decoder collapses runs by
greedy CTC. The 32-channel variant uses a leaky activation.

```sh
"$runner" --cpu 4 --mem 6G "$trainer" train-sequence "$out/sequence-warm.bin" \
  1729 4 32 --warm=6 "$out/train.ocrt"
"$runner" --cpu 1 --mem 3G "$trainer" evaluate-sequence \
  "$out/test.ocrt" "$out/sequence-warm.bin"
(
  cd "$rust"
  "$runner" --cpu 2 --mem 4G cargo build -p signature-kit-pdf-core-ocr --release \
    --features ctc-wide --bin pdf-core-ocr-train
)
"$runner" --cpu 6 --mem 8G "$trainer" train-sequence "$out/sequence-wide.bin" \
  1729 6 50 --warm=12 --lines=1600 \
  "$out/train.ocrt" "$out/train.ocrt" "$out/train.ocrt" "$out/train.ocrt" \
  "$out/native-clean-train.ocrt" "$out/native-scan-train.ocrt" \
  "$out/native-fax-train.ocrt" "$out/native-jpeg-train.ocrt"
"$runner" --cpu 1 --mem 3G "$trainer" evaluate-sequence \
  "$out/test.ocrt" "$out/sequence-wide.bin"
"$runner" --cpu 1 --mem 2G bun "$training/generate.mjs" scans \
  "$rust/ocr/tests/fixtures" "$training/real-scans.json" "$out/real-scans.ocrt"
```

Use `TESSDATA_PREFIX` to select the Portuguese reference model. The fast
comparison uses the [tessdata_fast Portuguese model](https://github.com/tesseract-ocr/tessdata_fast/blob/87416418657359cb625c412a48b6e1d6d41c29bd/por.traineddata)
and Tesseract 5.5.4 in single-threaded LSTM mode.

## CTC in WebAssembly

The development-only `ctc-probe` feature adds an entry point that runs the
engine's page preparation and then applies an explicit CTC table to each
prepared line. It allocates convolution scratch buffers once per page. The
scalar and SIMD paths use the same signed integer dot products, scales,
labels and decoder. The SIMD dot product consumes contiguous 16-byte blocks.

```sh
(
  cd "$rust"
  for configuration in ctc-probe ctc-probe,ctc-wide; do
    suffix=""
    if [ "$configuration" = ctc-probe,ctc-wide ]; then suffix="-wide"; fi
    "$runner" --cpu 2 --mem 4G cargo build --release --target wasm32-unknown-unknown \
      -p signature-kit-pdf-core-ocr --features "$configuration" --lib
    cp target/wasm32-unknown-unknown/release/signature_kit_pdf_core_ocr.wasm \
      "$out/ctc${suffix}-scalar.wasm"
    RUSTFLAGS="-C target-feature=+simd128 -C no-vectorize-loops -C no-vectorize-slp" \
      "$runner" --cpu 2 --mem 4G cargo build --release --target wasm32-unknown-unknown \
      -p signature-kit-pdf-core-ocr --features "$configuration" --lib
    cp target/wasm32-unknown-unknown/release/signature_kit_pdf_core_ocr.wasm \
      "$out/ctc${suffix}-simd.wasm"
  done
)
"$runner" --cpu 1 --mem 3G bun "$training/ctc-wasm.mjs" \
  "$out/ctc-scalar.wasm" "$out/ctc-simd.wasm" "$out/sequence-warm.bin" \
  "$out/native-clean-test/test"
```

The two autovectorization flags work around an LLVM code-generation failure
in the glyph recognizer when building the combined module. The explicit
CTC `simd128` instructions remain enabled. The production build uses
`simd128` with the glyph coordinate conversion kept out of vectorized loops.

The benchmark checks exact transcripts before comparing page times with one
Tesseract process per dataset. Its `pdf_core_ocr_ctc_probe(ptr, len)` entry
point accepts little-endian width and height (`u32`), DPI (`f32`), table
length (`u32`), then table bytes and gray8 pixels. The output starts with its
total length (`u32`) followed by UTF-8 text. Use the raster allocation
functions to allocate input and free input and output.

## Table formats

The sequence format starts with `OCRS` (16 channels) or `OCRW` (32 channels),
the FNV-1a input digest and seed, then the class count and Unicode labels.
Each of the four layers has a scale followed by bias and signed int8
weight rows. Activations are quantized between layers.

The `OCR2` table starts with a four-byte format identifier, an eight-byte
FNV-1a training-data digest in archive order followed by the corpus, and the
eight-byte seed. A 16-byte header declares vertical normalization, class count
and the two quantization scales. It is followed by 48 hidden biases, a
260 × 48 input-major weight matrix, and one row of output weights, label
and bias per Unicode class. Weights are signed 8-bit values serialized with
a bias of 128. Biases and scales are little-endian `f32`. Inference uses
integer accumulators and a quantized ReLU activation. The last region holds
sorted 12-byte character transition records. The native evaluator accepts
`OCR1` tables for direct comparisons with prior rounds.

## Measured results

The prototype baseline classifies 3,536 of 4,254 reference glyphs on the clean
Adwaita test and 3,443 on the degraded test. With the clean-only
line-normalized model those counts rise to 3,957 and 3,887. Its word-box
decoder has 287 clean edits and 979 degraded edits. The clean oracle is close to the decoder result. The
degraded decoder has 612 more edits than the oracle has misclassified glyphs,
which points to the cost of lost glyphs and difficult cuts. The measures use
different alignment rules, so their difference is diagnostic. With degraded
reference crops the prototype correctly identified 159/306 instances of
`a`, 54/174 of `t` and 23/66 of `O`. The failure crops show touching
strokes, small accents, and aliases between uppercase letters and digits.

The font benchmark has 96 lines and 4,254 non-whitespace characters per
condition. The two native document line datasets cover 300 DPI clean and
200 DPI scan-degraded first pages. The manually transcribed scan check has eight
lines and 245 characters from the two repository JPEG fixtures, approximately
85 DPI. It is a small real-scan sample.

| Model                                                      | Clean accuracy | Degraded accuracy | Clean / degraded ms per 50 lines | Table bytes |
| ---------------------------------------------------------- | -------------: | ----------------: | -------------------------------: | ----------: |
| Round 1 prototypes                                         |         85.43% |            71.79% |                  102.92 / 118.53 |      90,264 |
| 16 × 16 glyph MLP, Liberation only                         |         89.75% |            75.95% |                    83.14 / 95.71 |      47,960 |
| Line-normalized glyph MLP, Liberation only, pruned decoder |         92.76% |            77.15% |                    31.78 / 50.19 |      47,960 |
| Glyph-normalized MLP, Liberation and native clean          |         94.50% |            77.90% |                    37.00 / 55.54 |      48,244 |
| Line-normalized glyph MLP, Liberation and native clean     |         93.25% |            76.99% |                    32.82 / 54.25 |      48,244 |
| Glyph-normalized MLP, mixed scans and rejection            |         82.25% |            80.28% |                    47.49 / 72.93 |      48,668 |
| **Line-normalized glyph MLP, mixed scans and rejection**   |         85.80% |            81.59% |                    42.90 / 62.96 |      48,668 |
| 16-channel CTC, Liberation, six warm epochs                |         33.78% |            28.44% |                  136.27 / 139.76 |       7,568 |
| 32-channel CTC, mixed documents, twelve warm epochs        |         73.20% |            66.15% |                  169.87 / 173.19 |      17,448 |
| Tesseract 5.5.4 Portuguese LSTM                            |         99.46% |            99.27% |              3,579.49 / 3,401.72 |  15,336,931 |
| Tesseract 5.5.4 LSTM with `tessdata_fast`                  |         99.29% |            98.68% |              2,214.10 / 1,965.71 |   1,982,756 |

Both CTC models produced identical scalar and SIMD transcripts on all 20
held-out pages in the final vision integration. Each mean includes page
preparation and recognition.

| CTC model   | Dataset                    | Scalar ms/page | SIMD ms/page | Tesseract fast ms/page | SIMD speedup |
| ----------- | -------------------------- | -------------: | -----------: | ---------------------: | -----------: |
| 16 channels | 10 clean pages, 300 DPI    |         272.56 |       154.23 |               2,597.07 |       16.84× |
| 16 channels | 10 degraded pages, 200 DPI |         282.14 |       139.40 |               1,920.03 |       13.77× |
| 32 channels | 10 clean pages, 300 DPI    |         539.68 |       231.50 |               2,756.66 |       11.91× |
| 32 channels | 10 degraded pages, 200 DPI |         511.78 |       224.80 |               1,844.78 |        8.21× |

On the eight real-scan lines, character accuracy was 31.02% for the shipped
glyph model, 5.71% for CTC at 16 channels and 17.96% at 32 channels. Tesseract
LSTM scored 72.24% with the standard Portuguese model and 82.86% with
`tessdata_fast`. On the native document line crops, the shipped glyph model
scored 93.40% clean and 35.43% degraded. Recognition averaged 43.37 and 48.98
ms per 50 lines. The clean-only line-normalized classifier scored 0.23% on
the degraded crop archive, whose line metrics can be distorted by page skew.

The 32-channel run sampled up to 1,600 lines per epoch for 50 epochs. Its
input pool contained 30,451 entries, including four repetitions of the
792 Liberation lines. Its first twelve epochs used the alignment targets
where matching glyph boxes were available. The fitted table is available at
`../data/sequence-wide.bin` for the `ctc-probe,ctc-wide` benchmark.

The optimized production OCR module is 230,433 bytes. The main PDF module
measures 1,165,797 bytes, up from 1,154,459 bytes at `9fb46f7` after the
glyph inspection changes from the synthesis branch. Both main module builds
fit the 1,144 KiB budget. The optional OCR budget covers the merged JPEG,
raster, layout and recognition modules.

The selected table uses 1,084,145 training samples, including rejection
examples, and 139 output classes. Its training digest is `133a86b966798257`.
The clean-only model used 349,049 labeled glyphs and 134 characters. Only first
pages from the sampled native documents contributed glyph crops. The font
inventory of the full corpus remains untested.

```text
4f8d408303ebab8cbc5ca1f94f8eebb5208592a13923e698ec4495472ab3d9bc  train.ocrt
2671be43cab2c4903820143db49adfdf09cf2bd30555bedcdc172ad17dfd3271  native-clean-train.ocrt
ca22a7d6e72fe247b53fbbb2772722d18101a412346a52a9254d60ec484d7d66  native-scan-train.ocrt
45d206ef6c60836c16a4b7eea799b2a87308a6c791044a9936989f195b9dbcf5  native-fax-train.ocrt
e25eeee6e88348ff11f523ec419e21526ae97c5d838f7dcf9237e124e6f88046  native-jpeg-train.ocrt (decoded JPEG)
47efa6db8eed555586b0e3e6b0a31cd61bb88aba87ec87578b747611872c5f2b  procurement.txt
6b53d33aa7ed9180f441630e21b181cf9b0645395e47213175eb846b08aa584c  native-line.bin
b0d45c9e56239ae1ac651f6332882f461aad533bf0a9ab0013c53313cb17af59  recognition.bin
8e525e511f3315511b5b68b46ee46febcf26b605111af1c78064bcb7ae652d0c  sequence-warm.bin
b0a6f8ba5e2f4fa34015107800897e94d5769a645fcd51204f7dd236b4ea974d  sequence-wide.bin
```
