# CPU training for OCR v4

[V5 training and evaluation](V5.md) uses the grayscale multirate recognizer.

OCR v4 is an experimental recognizer. Build the optional OCR crate with
`ctc-v4` and pass an OCR4 table to the existing native
`pdf-core-ocr IMAGE --ctc-model TABLE` CLI. The same table can be passed to
`PreparedPage::recognize_sequence` in Rust and to the existing development
wasm page probe. The model uses the segmenter's line crops and projects word
boxes back to original image coordinates. The published OCR build loads the
glyph model. The main PDF module has no OCR runtime dependency.

The network has a 32-row normalized input with four normalized columns per frame.
A dense projection produces 64 channels. Three grouped temporal convolutions
have four groups, three taps, dilations 1/3/9, a channel shuffle and clipped
ReLU. The CTC head scores 195 classes, including blank. The receptive field is
27 frames. The network executes 29,888 multiply-accumulates per frame. The timed
1,510 × 46 crop produced 235 frames, or 7,023,680 multiply-accumulates.

Weights use per-output-channel power-of-two scales and signed int8 bytes.
Input pixels are mapped to integer ink values 0–127. The hidden unit is 32
per floating unit and the head unit is 256. Bias is stored as signed i16 in
the respective output unit. Each row uses i32 accumulation, a right shift
with ties toward positive infinity, and the integer bias. Hidden values
clamp to 0–127 before the next layer. PyTorch QAT uses the same rounding and
saturating operations in its forward pass with a straight-through gradient.
Inference reads weights in place and reuses scratch arrays between lines.
The returned word strings and boxes are owned results.

## Install

Run from the workspace root on the shared host. Model fitting uses CPU-only
PyTorch in a gitignored venv. The Rust workspace keeps empty dependency tables.

```sh
mkdir -p .cache/t shared/pdf-core/.cache/train-v4
export TMPDIR="$PWD/.cache/t"
r=/home/yorizel/.local/bin/resource-run
c=shared/pdf-core/.cache
out="$PWD/$c/train-v4"
rust="$PWD/shared/pdf-core/rust"
t="$rust/ocr/training/torch"
b=shared/pdf-core/bench/ocr
corpus=/home/yorizel/Documents/bench-parsers
py="$PWD/$c/venv/bin/python"

"$r" --cpu 2 --mem 4G uv venv --python 3.13.16 "$c/venv"
"$r" --cpu 2 --mem 4G uv pip install --python "$py" \
  --index https://download.pytorch.org/whl/cpu -r "$t/requirements.txt"
```

## Collect training data

Use the [OCRL shard generator](../../../../bench/ocr/DATASETS.md#stream-the-full-training-corpus)
from the same corpus root for all splits. The roster is one shard path per
line. Use the train-only roster after excluding PDF byte hashes shared with
validation and test. Omit the per-page cap when generating a full corpus.
For the checked benchmark run, the earlier 12-lines-per-page corpus used
3,584 audited shards and 822,467 records after removing shared aliases.
The 71,003 PDF pages came from the corpus renderer using the document fonts.
The optional clean warm start uses the existing
[OCRT font bootstrap](../README.md#training-and-evaluation).

The [corpus-font supplement](V5.md#generate-the-rare-character-supplement)
writes OCRL shards that can also be used by the v4 trainer. Its glyph outlines
come from embedded fonts in training PDFs.

The OCRL images already contain simulated scan effects. DataLoader applies
seeded horizontal blur, exposure, sensor noise and occasional thresholding
on top, with strength increasing across the first three epochs. The additional
transforms use the real development measurements as a guide. JPEG and
geometric scan effects come from the source generator. Native and Python
normalization trim the same ink hull, resize it by sampling pixel centers to
26 rows, add three rows and columns of padding per side, then pack frames.
OCRT stores binary ink flags, which the training loader converts to gray8
before normalization.

## Fit and resume

Use 186 reviewed real development lines and a separate synthetic validation
archive. The real test directory is reserved for the final score. A fresh
model starts with randomly initialized weights. The optional glyph
alignment warm start uses only clean synthetic data. CTC training applies
AdamW, cosine decay, gradient clipping, width bucketing, and an exponential
moving average. Final epochs enable integer simulation in the forward pass.
The trainer selects by the mean of real dev and synthetic validation int8 CER.
It records scores for every epoch and supports early stop after QAT begins.

```sh
"$r" --cpu 12 --mem 16G "$py" -u "$t/train.py" \
  --shards "$train/full-corpus/fit-shards.txt" --clean "$train/bootstrap/train.ocrt" \
  --synthetic-val "$train/bootstrap/val-degraded.ocrt" \
  --real-dev "$train/reviewed-dev.ocrt" --output "$out/expanded" \
  --epochs 12 --steps 2200 --qat 3
```

The command uses at most 2,200 batches per epoch and advances through a
fixed shuffled roster across epochs. Omit `--steps` to traverse all eligible
records each epoch. Re-run with the same options and `--resume` to restore
the saved epoch, model, EMA, optimizer and early-stop state. The output
directory holds `curves.jsonl`, `checkpoint.pt`, `latest.bin`, `best.pt`
and `best.bin`. With `--initial-run` a subsequent stage can continue
training a recognizer produced by this pipeline on a new roster. It takes
a matching `best.pt` and `best.bin` and includes the parent's table hash
in the new training digest. All data and checkpoints stay local. Only a
selected small table belongs under `ocr/data`.

## Check and benchmark

Build native and wasm variants in the Rust workspace using the same target
location. The optimized wasm command matches the flags in the package build.

```sh
(
  cd "$rust"
  "$r" --cpu 3 --mem 6G cargo build --release \
    -p signature-kit-pdf-core-ocr --features ctc-v4,ctc-v3 \
    --bin pdf-core-ocr --bin pdf-core-ocr-v4
  for mode in scalar simd; do
    flags=""
    if [ "$mode" = simd ]; then flags="-C target-feature=+simd128"; fi
    RUSTFLAGS="$flags" "$r" --cpu 3 --mem 6G cargo build --release \
      -p signature-kit-pdf-core-ocr --features ctc-v4 --target wasm32-unknown-unknown --lib
    "$r" --cpu 1 --mem 3G ../node_modules/binaryen/bin/wasm-opt -O3 \
      --enable-simd --enable-bulk-memory --enable-sign-ext \
      --enable-nontrapping-float-to-int --enable-mutable-globals --enable-multivalue \
      --enable-reference-types --strip-debug --strip-producers --converge \
      target/wasm32-unknown-unknown/release/signature_kit_pdf_core_ocr.wasm \
      -o "$out/v4-$mode-opt.wasm"
  done
)
model="$out/rare-fine-tune"
native="$rust/target/release/pdf-core-ocr-v4"
"$r" --cpu 2 --mem 4G "$py" "$t/evaluate.py" fixture \
  "$model/best.pt" "$model/best.bin" "$train/bootstrap/val-degraded.ocrt" \
  "$native" "$out/v4-scalar-opt.wasm" "$out/v4-simd-opt.wasm"

"$r" --cpu 2 --mem 4G python3 "$b/real_lines.py" regenerate \
  "$corpus/editais-extra/digitalizados" "$out/real-lines"
"$r" --cpu 1 --mem 3G "$py" "$t/evaluate.py" packet "$model/best.bin" \
  "$out/real-lines/dev/17d23ec36e25-p002-l008.pgm" "$out/timing.packet"
"$r" --cpu 1 --mem 3G taskset -c 6 "$native" bench "$out/timing.packet" 300
"$r" --cpu 1 --mem 3G taskset -c 6 bun "$t/wasm.mjs" bench \
  "$out/v4-scalar-opt.wasm" "$out/v4-simd-opt.wasm" "$out/timing.packet" 300
```

The fixture check compares every normalized byte and integer logit on 128
synthetic validation lines against PyTorch and against native, wasm scalar,
and wasm SIMD execution. The timed development crop is 1,510 × 46 at
301 DPI. The native timer reuses a loaded table and scratch space. The wasm
line probe accepts little-endian width, height, and table length as three
u32s, followed by table bytes and row-major gray8. Its public development
symbol is `pdf_core_ocr_v4_line_probe(ptr, len, fixture)`. Output starts
with a u32 containing total output length, then either UTF-8 text or, in
fixture mode, a u32 pixel count followed by signed input bytes and
frame-major i32 logits. Use the existing OCR raster allocation and free
functions with the exact buffer lengths. The wasm benchmark includes probe
buffer round trips and loads the table for each call.

Generate the matched test sets with the corpus root above. Tesseract and
the native page engine score the same pixels. For calibrated JPEG variants
replace the generated PGM with the decoded JPEG before benchmarking.

```sh
for preset in clean calibrated; do
  for mode in lines pages; do
    "$r" --cpu 2 --mem 5G bun "$b/generate-dataset.ts" "$corpus" --labels poppler \
      --mode "$mode" --split test --max-docs 4 --max-pages 2 --dpi 150 \
      --preset "$preset" --seed d3 --output "$out/$preset-$mode"
  done
done
for jpg in "$out"/calibrated-{lines,pages}/test/*.jpg; do
  decoded="${jpg%.jpg}.decoded.pgm"
  "$r" --cpu 1 --mem 3G magick "$jpg" -colorspace Gray -depth 8 "$decoded"
  mv "$decoded" "${jpg%.jpg}.pgm"
done
"$r" --cpu 2 --mem 4G bun "$b/prepare-real.ts" \
  "$corpus/editais-extra/digitalizados" "$out/real-pages"
for dataset in real-lines/test clean-lines/test calibrated-lines/test; do
  "$r" --cpu 1 --mem 3G taskset -c 8 "$py" "$t/evaluate.py" native \
    "$model/best.bin" "$out/$dataset" "$native"
  for variant in standard fast; do
    "$r" --cpu 2 --mem 4G taskset -c 7 "$py" "$t/evaluate.py" tesseract "$variant" \
      "$out/$dataset" --cpu 7
  done
done
"$r" --cpu 1 --mem 2G docker run --rm --network none signature-kit-ocr-bench:5.3.0 \
  cat /usr/bin/time > "$out/gnu-time"
chmod u+x "$out/gnu-time"
export OCR_BENCH_TIME="$out/gnu-time"
for dataset in real-pages clean-pages/test calibrated-pages/test real-lines/test; do
  psm=3
  case "$dataset" in real-lines/test) psm=7 ;; esac
  OCR_BENCH_CTC_MODEL="$model/best.bin" "$r" --cpu 2 --mem 4G taskset -c 8 \
    bun "$b/run.ts" --dataset "$out/$dataset" --engines ours-native --psm "$psm"
  "$r" --cpu 2 --mem 4G taskset -c 8 bun "$b/run.ts" --dataset "$out/$dataset" \
    --engines ours-native --psm "$psm"
done
for dataset in real-pages clean-pages/test calibrated-pages/test; do
  "$r" --cpu 2 --mem 4G taskset -c 9 bun "$b/run.ts" --dataset "$out/$dataset" \
    --engines tesseract-lstm,tesseract-fast --psm 3
done
```

The batched Tesseract line evaluator groups by reference DPI and uses PSM 7.
Its time includes one Docker startup per DPI group. The full-page harness
reports per-image process time and uses PSM 3. Keep those timing methods
separate when comparing engines.

The OCR4 table begins with `OCR4`, a u16 format version, a u16 architecture
ID, a 32-byte SHA-256 training-data manifest, a 20-byte Git SHA-1 commit,
a u64 seed and a u16 class count. Classes are ascending Unicode u32
code points with blank first. Weights follow in stem, three temporal
layers and head order. Each row contains the i16 bias, u8 right shift
and the fixed-width int8 weights. Grouped temporal rows are stored in
tap-major order. All scalars use little endian.

## Measured v4 checkpoint

[sequence-v4.bin](../../data/sequence-v4.bin) is 32,091 bytes, with SHA-256
`ad9c5ebebabcc4f9cbbad1466b214a91c12caca8d2c387acc80acd00249bf8c1`.
The header identifies architecture 1, seed 7291, training commit
`81d0b7f8592cf43b6a46c5d4be094482d2117cdc`, and manifest
`2cdc427f5bf24aacb2df1366190ef72974709728a9f7fcecbfb5b54a3e58229d`.
This historical table used a rare-text continuation rendered with the
local Liberation setup, which has since been removed. Given those historical
OCRL shards, the measured continuation was:

```sh
python3 - "$train/full-corpus/fit-shards.txt" "$out/rare-lines/shards.txt" "$out/rare-mix.txt" <<'PY'
from pathlib import Path
from random import Random
import sys

corpus, supplement, mixed = map(Path, sys.argv[1:])
shards = sorted(Random(7301).sample(corpus.read_text().splitlines(), 145))
mixed.write_text("\n".join(shards) + "\n" + supplement.read_text())
PY
"$r" --cpu 12 --mem 16G "$py" -u "$t/train.py" \
  --shards "$out/rare-mix.txt" --initial-run "$out/expanded" \
  --synthetic-val "$train/bootstrap/val-degraded.ocrt" \
  --real-dev "$train/reviewed-dev.ocrt" --output "$out/rare-fine-tune" \
  --epochs 3 --steps 900 --qat 1 --learning-rate 0.0007
model="$out/rare-fine-tune"
```

The original run started at `6b99311`. It resumed at the saved eighth
epoch after the launcher was interrupted. It recorded 830,690 CTC line
visits over the 12 completed epochs, including three QAT epochs, plus the
12 alignment warm-up epochs. The continuation drew from 60,091 eligible
records and recorded 85,099 CTC visits. The 32,768 extra renders were
generated with the 12 installed Liberation faces. The v3 shard archive
was capped at 12 lines per page. This experiment used roughly 0.85 million
eligible line images across the two pools. Visits include repeats after
shuffled rosters wrap.

| Run and epoch | Mode | CTC loss | Real dev CER | Synthetic val CER |
| ------------- | ---- | -------: | -----------: | ----------------: |
| Expanded 1    | FP32 |   2.4550 |       38.72% |            45.93% |
| Expanded 6    | FP32 |   1.1486 |       24.58% |            34.24% |
| Expanded 9    | FP32 |   1.0476 |       23.94% |            33.60% |
| Expanded 12   | QAT  |   1.0081 |       23.07% |            33.54% |
| Rare-text 1   | FP32 |   0.7356 |       25.13% |            26.45% |
| Rare-text 2   | FP32 |   0.6762 |       24.78% |            25.75% |
| Rare-text 3   | QAT  |   0.6842 |       24.65% |            25.38% |

Selection used the mean of the 186 real development and 192 synthetic
validation CERs, 25.02% for the continuation versus 28.30% for expanded.
The real development inputs in this comparison were binary OCRT crops.
In a separate grayscale development run with the round-1 pipeline and
the epoch-8 table, the existing beam plus lexicon improved CER from 27.20%
to 26.22%, with mean per-crop CLI time rising from 7.51 to 53.12 ms.
The v4 runtime uses greedy decoding.

### Matched line crops

The direct gray8 v4 probe and both Tesseract 5.3.0 models saw the same pixels.
The Tesseract scores used the batch CLI above. The calibrated group used
306 decoded JPEGs and 70 lossless PGM crops. The normalized scores collapse
whitespace and lowercase while retaining diacritics and punctuation.

| Cohort           | Engine         | Raw CER | Raw WER | Norm CER | Norm WER |
| ---------------- | -------------- | ------: | ------: | -------: | -------: |
| Real test (431)  | v4             |  18.36% |  48.54% |   17.21% |   47.40% |
|                  | Tesseract LSTM |   0.96% |   5.06% |    0.91% |    4.87% |
|                  | Tesseract fast |   0.91% |   4.29% |    0.89% |    4.22% |
| Clean (376)      | v4             |  10.33% |  32.68% |   10.06% |   32.35% |
|                  | Tesseract LSTM |   0.38% |   1.86% |    0.38% |    1.83% |
|                  | Tesseract fast |   0.37% |   1.78% |    0.37% |    1.78% |
| Calibrated (376) | v4             |  82.49% |  94.20% |   81.49% |   93.85% |
|                  | Tesseract LSTM |   2.43% |   5.02% |    2.39% |    4.94% |
|                  | Tesseract fast |   2.40% |   5.29% |    2.38% |    5.21% |

On the real test crops, the entire v4 native page pipeline scored 39.15% raw
CER and 72.71% raw WER. The glyph pipeline scored 44.93%
and 83.28% on those inputs. Tesseract PSM is a harness setting. The native
pipeline uses its own page preparation and segmentation on the single-line
inputs. The direct probe skips page deskew and adaptive thresholding.

### Pages and runtime

The native CLI used pipeline-v2 round 2 (`ddca535`) for both SignatureKit
recognizers. Page CER and mean milliseconds are measured over per-image
medians of three CLI trials. Tesseract used PSM 3 and the benchmark image
`sha256:4930dd205f0507c4c353a3465a4da49f8705e3a1fa33af216ae60ed026653653`.

| Engine         | Real (20), CER / ms | Clean (8), CER / ms | Calibrated (8), CER / ms |
| -------------- | ------------------: | ------------------: | -----------------------: |
| Glyph          |      62.51% / 60.27 |      13.24% / 76.29 |           25.63% / 90.57 |
| v4             |      43.92% / 47.45 |     10.77% / 100.08 |           17.74% / 93.12 |
| Tesseract LSTM |   11.15% / 2,523.82 |    4.00% / 5,910.75 |         4.51% / 5,022.37 |
| Tesseract fast |   14.05% / 1,709.48 |    4.03% / 3,268.68 |         4.49% / 3,397.17 |

V4 improved raw whole-page CER. The normalized word multiset F1 fell
from 40.10% to 38.95% on real pages, from 70.75% to 67.37% on clean pages,
and from 55.62% to 51.62% on calibrated pages. Clean normalized WER rose
from 33.65% to 35.97%. The published artifact therefore keeps the glyph
default. The accuracy gap suggests improving normalized input robustness
and training on uncapped, calibrated OCRL data before another release
evaluation.

The pinned 1,510 × 46 development crop used 300 repetitions on logical CPU 6.
It took 1.892 ms native, 5.773 ms wasm scalar, and 2.086 ms wasm SIMD per line.
PyTorch, Rust native, and both wasm variants matched every normalized byte
and logit in the 128-line parity run. The fixture results hashed to
`c70750a3fb19745cf771a2694cdd2e046faa48ed1ac04dd9feb60812734e3f2b`.

On CPU 9 the page probe returned identical scalar and SIMD transcripts on
all 36 pages. The scalar/SIMD means were 138.67/64.04 ms on real pages,
312.99/143.62 ms on clean pages, and 306.23/139.95 ms on calibrated pages.
Run it separately from the Tesseract process benchmark:

```sh
for dataset in real-pages clean-pages/test calibrated-pages/test; do
  "$r" --cpu 2 --mem 4G taskset -c 9 bun "$rust/ocr/training/ctc-wasm.mjs" \
    "$out/v4-scalar-opt.wasm" "$out/v4-simd-opt.wasm" \
    "$model/best.bin" "$out/$dataset" none
done
```

These page probe times include preparation and recognition inside wasm.
Separate Tesseract CLI trials include process startup and load the model for
each input. The benchmark passes were timed in different shared-host windows.
The optimized experimental wasm probes were 253,612 bytes scalar and
263,929 bytes SIMD. The SIMD probe plus its separate table was 296,020 bytes.
The shipped glyph OCR wasm was 237,810 bytes. The main PDF wasm was
1,155,988 bytes before and after, with SHA-256
`220869496257eae3419cbbc84eb2e4edf32b8447b49a7f04014e4f60d4228b19`.
