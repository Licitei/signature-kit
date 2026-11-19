# OCR recognition model

`recognize_line(&Bits, &Line) -> Vec<Word>` reads the segmenter's word boxes in order. Its search scores proposed character cuts with a 16 × 16 ink pattern, glyph aspect ratio, height relative to line x-height, glyph position relative to baseline, and a bounded Portuguese character bigram bonus. Each result carries the supplied word box, a confidence in `[0, 1]`, and up to three distinct alternatives ranked by score. Alternative scores express relative fit to the best path. Confidence is a ranking heuristic.

## Reproduce the model

From the repository root, with Bun, the repository's Rust toolchain, the
system Liberation, GNU FreeFont and Adwaita font packages, and the read-only
procurement corpus:

```sh
mkdir -p "$PWD/.cache/t/recognition"
export TMPDIR="$PWD/.cache/t"
runner=/home/yorizel/.local/bin/resource-run
rust="$PWD/shared/pdf-core/rust"
training="$rust/ocr/training"
out="$TMPDIR/recognition"
wasm="$rust/target/wasm32-unknown-unknown/release/signature_kit_pdf_core.wasm"

(cd "$rust" && "$runner" --cpu 4 --mem 8G cargo build -p signature-kit-pdf-core \
  --release --target wasm32-unknown-unknown)
"$runner" --cpu 2 --mem 2G bun "$training/generate.mjs" bootstrap "$wasm" "$out" \
  /usr/share/fonts/liberation /usr/share/fonts/gnu-free /usr/share/fonts/Adwaita
"$runner" --cpu 2 --mem 2G bun "$training/generate.mjs" corpus "$wasm" \
  /home/yorizel/Documents/bench-parsers/editais-extra "$out/procurement.txt"
(
  cd "$rust"
  "$runner" --cpu 2 --mem 4G cargo run -p signature-kit-pdf-core-ocr --release \
    --bin pdf-core-ocr-train -- train "$out/train.ocrt" ocr/data/recognition.bin 1729 \
    "$out/procurement.txt"
  "$runner" --cpu 2 --mem 4G cargo build -p signature-kit-pdf-core-ocr --release \
    --bin pdf-core-ocr-train
  "$runner" --cpu 2 --mem 4G bash -ec '
    for split in val val-degraded test test-degraded; do
      target/release/pdf-core-ocr-train evaluate "$1/$split.ocrt"
    done
  ' bash "$out"
)
```

The bootstrap builds PDF glyph sheets from local open font files and uses the
pdf-core WASM renderer to draw their embedded outlines. A scanline fill
rasterizes the paths at several sizes and subpixel phases. Degraded lines vary
the binarization threshold, suppress some pixels and place selected glyphs
without gaps. Training uses Liberation faces, validation GNU FreeFont faces,
and final testing Adwaita faces with separate authored lines. Each archive
contains whole lines with reference word boxes and a known baseline and
x-height. The native timer covers recognition on packed pixels and reports
50-line page equivalents.

The corpus command extracts the first page through pdf-core. It processes native
PDFs in sorted order and uses the OCR benchmark's document split. The first 32
bits of SHA-256 over the relative source path must fall below 80 modulo 100.
Scanned documents under `digitalizados` and validation/test documents are
excluded. Procurement text contributes only character transition counts.

To use a shared dataset split, run
`bun generate.mjs import <split-directory> <samples.ocrt>` with P5 images and
their JSON files. The import groups words by line and uses optional glyph labels
to estimate baseline and x-height. Training requires labeled glyphs. Choose
the document splits before import and use separate output archives for
validation and testing.

## Table layout

`../data/recognition.bin` embeds the model directly. The little-endian header is
the four-byte format/version magic `OCR1`, an eight-byte FNV-1a digest of the
training archive followed by the UTF-8 corpus, an eight-byte trainer seed, and
a four-byte prototype count. Each 48-byte prototype stores four packed 64-bit
shape words, three 32-bit geometry values, and a Unicode scalar. The trainer
chooses a bounded number per scalar by seeded farthest-point initialization
and then replaces each center by a representative observed glyph. The
remaining 12-byte records store two Unicode scalars and an `f32` transition
bonus. Identical input bytes and seed reproduce the table.

The committed table used 792 labeled synthetic lines and text from 175
training documents. Its input and output SHA-256 digests are:

```text
4f8d408303ebab8cbc5ca1f94f8eebb5208592a13923e698ec4495472ab3d9bc  train.ocrt
14ab6e0793243f584dd05a5cb3767f94a755f6648dd47efcc3e05c931f527b42  procurement.txt
b7227bc463e29afc6c9f4fae2a47bdfdfd6de434cecf91bce7d0ab76e54c2d87  recognition.bin
```
