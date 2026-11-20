# CPU training for OCR v4

OCR v4 is an experimental recognizer. Build the optional OCR crate with
`ctc-v4` and pass an OCR4 table to the existing native
`pdf-core-ocr IMAGE --ctc-model TABLE` CLI. The same table can be passed to
`PreparedPage::recognize_sequence` in Rust and to the existing development
wasm page probe. The model uses the segmenter's line crops and projects word
boxes back to original image coordinates. The published OCR build loads the
glyph model. The main PDF module has no OCR runtime dependency.

The network has a 32-row normalized input with four source columns per frame.
A dense projection produces 64 channels. Three grouped temporal convolutions
have four groups, three taps, dilations 1/3/9, a channel shuffle and clipped
ReLU. The CTC head scores 195 classes, including blank. The receptive field is
27 frames. At 29,888 multiply-accumulates per frame, a 1,510 × 46 crop typically
costs roughly six to seven million multiply-accumulates, depending on its ink bounds.

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
PyTorch in a gitignored venv. The optional rendering packages come from PyPI.
The Rust workspace keeps empty dependency tables.

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

"$r" --cpu 2 --mem 4G uv venv --python 3.13 "$c/venv"
"$r" --cpu 2 --mem 4G uv pip install --python "$py" \
  --index https://download.pytorch.org/whl/cpu -r "$t/requirements.txt"
"$r" --cpu 2 --mem 4G uv pip install --python "$py" -r "$t/requirements-render.txt"
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

Use a local manifest of font paths (one TTF or OTF per line) to render
additional distinct OCRL samples from training-only text. The command
prioritizes text containing rare characters and matches each sentence against
the font cmap. It never renders a text/font/size tuple twice. The output
directory and all its shards belong in the ignored cache. This example uses
the installed Liberation faces for additional training font variation.

```sh
train=/absolute/path/to/the/audited/training/cache
find /usr/share/fonts/liberation -maxdepth 1 -name '*.ttf' | sort > "$out/fonts.txt"
"$r" --cpu 2 --mem 4G "$py" "$t/synthesize.py" \
  --shards "$train/full-corpus/fit-shards.txt" --fonts "$out/fonts.txt" \
  --count 32768 --output "$out/rare-lines"
cat "$train/full-corpus/fit-shards.txt" "$out/rare-lines/shards.txt" > "$out/combined.txt"
```

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
model="$out/expanded"
native="$rust/target/release/pdf-core-ocr-v4"
"$r" --cpu 2 --mem 4G "$py" "$t/evaluate.py" fixture \
  "$model/best.pt" "$model/best.bin" "$train/bootstrap/val-degraded.ocrt" \
  "$native" "$out/v4-scalar-opt.wasm" "$out/v4-simd-opt.wasm"

"$r" --cpu 2 --mem 4G python3 "$b/real_lines.py" regenerate \
  "$corpus/editais-extra/digitalizados" "$out/real-lines"
"$r" --cpu 1 --mem 3G "$py" "$t/evaluate.py" packet "$model/best.bin" \
  "$out/real-lines/dev/17d23ec36e25-p002-l008.pgm" "$out/timing.packet"
"$r" --cpu 1 --mem 3G taskset -c 5 "$native" bench "$out/timing.packet" 300
"$r" --cpu 1 --mem 3G taskset -c 5 bun "$t/wasm.mjs" bench \
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
  "$r" --cpu 1 --mem 3G magick "$jpg" -colorspace Gray -depth 8 "${jpg%.jpg}.pgm"
done
"$r" --cpu 2 --mem 4G bun "$b/prepare-real.ts" \
  "$corpus/editais-extra/digitalizados" "$out/real-pages"
"$r" --cpu 1 --mem 3G taskset -c 5 "$py" "$t/evaluate.py" native \
  "$model/best.bin" "$out/real-lines/test" "$native"
for dataset in real-lines/test clean-lines/test calibrated-lines/test real-pages clean-pages/test calibrated-pages/test; do
  psm=7
  case "$dataset" in *pages*) psm=3 ;; esac
  OCR_BENCH_CTC_MODEL="$model/best.bin" "$r" --cpu 2 --mem 4G taskset -c 5 \
    bun "$b/run.ts" --dataset "$out/$dataset" --engines ours-native --psm "$psm"
  "$r" --cpu 2 --mem 4G taskset -c 5 bun "$b/run.ts" --dataset "$out/$dataset" \
    --engines ours-native,tesseract-lstm,tesseract-fast --psm "$psm"
done
```

The OCR4 table begins with `OCR4`, a u16 format version, a u16 architecture
ID, a 32-byte SHA-256 training-data manifest, a 20-byte Git SHA-1 commit,
a u64 seed and a u16 class count. Classes are ascending Unicode u32
code points with blank first. Weights follow in stem, three temporal
layers and head order. Each row contains the i16 bias, u8 right shift
and the fixed-width int8 weights. Grouped temporal rows are stored in
tap-major order. All scalars use little endian.
