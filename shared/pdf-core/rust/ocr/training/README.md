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
CTC `simd128` instructions are still enabled. The benchmark checks exact
transcripts before comparing page times with one Tesseract process per
dataset. CTC weights are passed as input to the probe.

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
| 16-channel CTC, Liberation, six warm epochs                |         33.83% |            28.63% |                   100.75 / 96.97 |       7,568 |
| 32-channel CTC, mixed documents, twelve warm epochs        |         73.20% |            66.15% |                  169.87 / 173.19 |      17,448 |
| Tesseract 5.5.4 Portuguese LSTM                            |         99.46% |            99.27% |              3,579.49 / 3,401.72 |  15,336,931 |
| Tesseract 5.5.4 LSTM with `tessdata_fast`                  |         99.29% |            98.68% |              2,214.10 / 1,965.71 |   1,982,756 |

The 16-channel CTC probe produced identical scalar and SIMD transcripts on
twenty held-out pages. With 10 clean pages at 300 DPI the means were
319.14 ms scalar, 178.82 ms SIMD and 2,413.44 ms for Tesseract fast
(13.50×). With 10 scan-degraded pages at 200 DPI they were 223.78 ms scalar,
141.50 ms SIMD and 1,911.18 ms for Tesseract fast (13.51×). These means cover
page preparation and recognition. Accuracy remains well below the LSTM
reference. On the eight real-scan lines the 16-channel probe scored 5.71%,
the 32-channel probe scored 17.96%, and Tesseract LSTM scored 72.24% with
the standard Portuguese model and 82.86% with `tessdata_fast`.

The 32-channel run sampled up to 1,600 lines per epoch for 50 epochs. Its
input pool contained 30,451 entries, including four repetitions of the
792 Liberation lines. Its first twelve epochs used the alignment targets
where matching glyph boxes were available. The fitted table is available at
`../data/sequence-wide.bin` for the `ctc-probe,ctc-wide` benchmark.

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
