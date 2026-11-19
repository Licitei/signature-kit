# OCR datasets

The generator reads native PDFs with Bun and Poppler (`pdftotext -tsv` and
`pdftoppm`). Build pdf-core first with `bun run build` at the workspace root.
Build the native degradation tool and the optional OCR WebAssembly library
from `shared/pdf-core/rust`.

```sh
cargo build --release -p signature-kit-pdf-core-ocr --features synth --bin pdf-core-ocr-synth
cargo build --release -p signature-kit-pdf-core-ocr --lib --target wasm32-unknown-unknown
```

Run the generator from the workspace root.

```sh
bun shared/pdf-core/bench/ocr/generate-dataset.ts /home/yorizel/Documents/bench-parsers/pdfs \
  --dpi 300 --mode pages --preset photocopy --seed procurement-1 --max-docs 20 --max-pages 1
bun shared/pdf-core/bench/ocr/generate-dataset.ts /home/yorizel/Documents/bench-parsers/pdfs \
  --dpi 200 --mode lines --split train
```

Use the shared host's `resource-run` wrapper for builds and dataset runs. The
generator writes to `shared/pdf-core/.cache/ocr-dataset/` by default and excludes
directories named `digitalizados`. Each sample consists of a binary P5 grayscale
image and a JSON label. Word and glyph boxes use a top-left origin with exclusive
right and bottom edges. Page indexes and line numbers are zero-based. Line
samples use crop-local boxes.

The default label source calls pdf-core's `inspect({ text: true, links: false, glyphs: true })` to obtain
glyph advance boxes and text. It projects them through the crop box, rotation
and DPI, checks local grayscale contrast, then matches them against Poppler's
word and line ordering. Matching glyph boxes supply each word’s bounding box.
Only words whose glyph text matches appear in these labels. White device colors, nonpainting text modes and fully outside
rectangular clips are filtered by glyph inspection. Other PDF paint effects
can still leave unmatched visible text. Use `--labels poppler` for word-only
bootstrap output without a pdf-core build.

Presets are `clean`, `scan`, `photocopy`, `jpeg`, and `fax`. The JSON records
the actual parameters and per-sample seed derived from the user seed and sample
ID. The scan and photocopy presets apply skew, local warp, Gaussian blur, sensor
and impulse noise, tone changes, and uneven illumination. Photocopy also
applies ink bleed or erosion. JPEG and photocopy emit a grayscale baseline
`.jpg` at quality 30–90 alongside the lossless PGM master. Fax emits a bilevel
PGM with samples of 0 or 255. Geometric changes are also applied to label boxes.

The split hashes the UTF-8 source path relative to the input directory (or the
file's containing directory for a file input), with forward slashes, using
SHA-256. The first eight hex digits interpreted as an integer modulo 100 assign
buckets 0–79 to train, 80–89 to validation, and 90–99 to test. All pages, crops,
and DPI or degradation variants in one document share a split. Keep the input
directory stable across runs and reserve the test split for benchmark use.

## Display-list rasterizer

`pdf_core_ocr_rasterize(ptr, len, scale_x1000)` takes a v1 single-page render
payload from the pdf-core render ABI, beginning at the `PDRL` magic after the
main ABI's 8-byte result header. A successful result contains little-endian
`u32` width and height followed by tightly packed, top-down gray8 pixels.
Invalid payloads return zero. Allocate the input with
`pdf_core_ocr_raster_alloc(len)` and release input and output with
`pdf_core_ocr_raster_free(ptr, len)`, using the exact byte length of each block.
The output length is `8 + width * height`.

The rasterizer handles solid fills, outlines, approximate strokes, clipping,
and nearest-neighbor RGBA images. pdf-core converts decoded indexed, gray and
RGB sources to RGBA before emitting them. Compressed JPEGs are decoded by the OCR vision decoder, including progressive
images. Unsupported or malformed JPEG color sources use mid-gray. Font substitution
(`OP_TEXT`), dash patterns, blend modes and standalone shading are unsupported.
Fill and stroke gradients use the middle stop.

To measure 300 DPI grayscale agreement with the real browser painter, build
both WebAssembly libraries, install Playwright Chromium, and run the first
page of 20 alphabetically sorted native documents.

```sh
bun shared/pdf-core/bench/ocr/compare-raster.ts /home/yorizel/Documents/bench-parsers/pdfs 20
```

See the [v1 scan profile and measurements](SCAN-PROFILE.md) for the calibrated preset.

## Training line shards

Create a cache of clean training pages and labels once. The shard generator
reads each page raster with its word boxes, groups the boxes by line, and
writes augmented line crops. It uses deterministic per-record seeds, up to
eight parallel writers, and at most one page raster per worker at a time.
The fast path uses nearest-neighbor scale and shear, a short horizontal
blur, exposure and noise, and optional thresholding. It targets line
recognizer training. Use the calibrated page generator to model full scans.

```sh
mkdir -p .cache/t
export TMPDIR="$PWD/.cache/t"
r=/home/yorizel/.local/bin/resource-run
b=shared/pdf-core/bench/ocr
c=shared/pdf-core/.cache
corpus=/home/yorizel/Documents/bench-parsers/pdfs

"$r" --cpu 2 --mem 4G bun "$b/generate-dataset.ts" "$corpus" \
  --labels poppler --mode pages --preset clean --split train --dpi 150 \
  --max-docs 10 --max-pages 1 --output "$c/ocr-data-v2-clean"
"$r" --cpu 8 --mem 8G taskset -c 0-7 bun "$b/training-lines.ts" generate \
  "$c/ocr-data-v2-clean/train" "$c/ocr-data-v2-shards-pinned" 24000 8 137
```

The output directory must be new. Use logical CPU IDs corresponding to eight
distinct physical cores on the host. The generator reports wall time and
throughput, including worker startup, reading the cache, augmentation, and
writing the files. It excludes PDF rendering. For the same cache, count, and
seed, reading the numbered shards in order yields the same record sequence
regardless of worker count. The generator cycles through the cached lines
in filename and line order, so a larger count over a small cache augments
the same text several times.

Each numbered `.ocrl` file starts with eight bytes, `4f 43 52 4c 01 00 00 00`.
Read records until EOF. Every record starts with a little-endian `u16` width,
`u16` height, and `u32` UTF-8 byte length. Immediately following are exactly
`width * height` top-down row-major gray8 pixels and the UTF-8 text bytes
in NFC, with no terminator. A truncated record is invalid.
