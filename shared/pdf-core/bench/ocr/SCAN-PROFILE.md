# Calibrated scan degradation v1

`--preset calibrated --dpi calibrated` draws a profile from
`scan-profile-v1.json` using the generator seed and relative document path.
The selected profile keeps DPI, skew, tone, noise, illumination, threshold,
and JPEG quality together. Each page or line retains its own pixel-level
noise seed. The original presets are also available. The JSON labels record
the applied parameters and the profile version.

## Measurement

The real sample uses the first five qualifying page images from each of the
six dev documents. Test documents are excluded. The synthetic comparison uses
the first page of each of ten clean PDFs in the hashed training split and
renders four variants per page for each side of the comparison. The baseline
is a balanced mix of the existing scan, photocopy, JPEG, and fax presets.
The calibrated sample uses four deterministic seeds. The synthetic image
measurements use decoded JPEG pixels when the generator emits a JPEG, and
the P5 master otherwise.

- The displayed summaries are medians with the 10th and 90th percentiles in
  brackets. JPEG quality is the nearest IJG quality by absolute luminance
  quantization-table error. DPI comes from the PDF image placement on real
  pages and the renderer on synthetic images.
- The intensity metrics use the central 90% of each page along both axes.
  Paper and contrast use the 90th and 2nd pixel percentiles. The stroke-width
  proxy is the median horizontal and vertical dark run length, capped at 20
  pixels. The edge-width proxy divides the page contrast by the 75th-percentile
  threshold-crossing gradient.
- Background RMS and spectrum use 32×32 tiles free of thresholded ink.
  The spectrum column is the median share of non-DC power above 0.25
  cycles/pixel. Illumination range uses the 10th-to-90th percentile span of
  tile means. Speckle counts isolated dark pixels per million page pixels.
- Faint background counts pixels 10–50 gray levels darker than paper and
  outside a four-pixel dilation of strong ink. This proxy includes faint
  print, watermarks, compression, and illumination. With front-side images
  alone the sample cannot isolate physical bleed-through, and v1 has no
  reverse-side text model. The synthetic fax-like samples use bilevel P5,
  so the table reports bilevel pixels and the source CCITT codec separately.
- The tilt measurement uses the native segmenter's estimated skew. Stroke
  width and contrast also depend on typeface and ink coverage. The before
  and after runs use the same source pages, but those fonts and page layouts
  differ from the real sample.

## Results

| Measure            | Real dev                   | Synthetic before            | Synthetic after             |
| ------------------ | -------------------------- | --------------------------- | --------------------------- |
| dpi                | 150 [85, 301] (n=30)       | 200 [150, 300] (n=40)       | 150 [85, 301] (n=40)        |
| ccitt              | 10/30                      | 0/40                        | 0/40                        |
| bilevel            | 10/30                      | 10/40                       | 16/40                       |
| jpegQuality        | 70 [40, 79] (n=15)         | 43 [33, 84.3] (n=20)        | 70 [40, 79] (n=18)          |
| skewDegrees        | 0 [-0.336, 0.671] (n=30)   | 0 [-1.92, 1.91] (n=40)      | 0 [-0.336, 0.671] (n=40)    |
| strokePx           | 2.5 [1, 5] (n=30)          | 3 [1, 5] (n=40)             | 3 [2, 6] (n=40)             |
| backgroundRms      | 0 [0, 1.17] (n=30)         | 0 [0, 3.68] (n=40)          | 0 [0, 0.415] (n=40)         |
| highFrequencyShare | 0.246 [0.147, 0.62] (n=20) | 0.728 [0.605, 0.811] (n=25) | 0.21 [0.0943, 0.692] (n=24) |
| edgeWidthPx        | 1.28 [1, 2.1] (n=30)       | 1.2 [0.98, 2.06] (n=40)     | 1.16 [1, 1.82] (n=40)       |
| contrast           | 238 [187, 255] (n=30)      | 219 [124, 255] (n=40)       | 214 [135, 255] (n=40)       |
| paper              | 255 [255, 255] (n=30)      | 255 [254, 255] (n=40)       | 255 [255, 255] (n=40)       |
| specklePpm         | 86.7 [7.97, 397] (n=30)    | 903 [0, 5.06e+03] (n=40)    | 95.8 [12.4, 272] (n=40)     |
| faintBackgroundPct | 0.387 [0, 5.68] (n=30)     | 7.11 [0, 29.1] (n=40)       | 0.0932 [0, 4.06] (n=40)     |
| illuminationRange  | 0.256 [0, 7.46] (n=30)     | 0 [0, 10.1] (n=40)          | 0.156 [0, 5.17] (n=40)      |

DPI, JPEG quality, speckle, noise spectrum, and the skew range moved closer
to the dev sample. Contrast remained too low, stroke widths remained too
large toward the high end, and the edge widths were too narrow. Those
differences limit what this profile can establish about recognition on scans.

## Reproduce

From the workspace root, with Bun, Python, NumPy, Pillow, and Poppler:

```sh
mkdir -p .cache/t
export TMPDIR="$PWD/.cache/t" PYTHONDONTWRITEBYTECODE=1
r=/home/yorizel/.local/bin/resource-run
b=shared/pdf-core/bench/ocr
c=shared/pdf-core/.cache/ocr-data-v2-profile
corpus=/home/yorizel/Documents/bench-parsers

"$r" --cpu 4 --mem 8G cargo build --manifest-path shared/pdf-core/rust/Cargo.toml \
  --release -p signature-kit-pdf-core-ocr --features synth --bins
"$r" --cpu 4 --mem 8G python "$b/real_lines.py" candidates \
  "$corpus/editais-extra/digitalizados" --pages 5
"$r" --cpu 2 --mem 4G python "$b/scan-statistics.py" \
  --fit "$c-fitted-v1.json"

for spec in scan:150 photocopy:200 jpeg:300 fax:200; do
  "$r" --cpu 2 --mem 4G bun "$b/generate-dataset.ts" "$corpus/pdfs" \
    --output "$c/before" --labels poppler --split train --mode pages \
    --preset "${spec%:*}" --dpi "${spec#*:}" --seed v1-comparison --max-docs 10 --max-pages 1
done
for seed in v1-comparison v1-comparison-2 v1-comparison-3 v1-comparison-4; do
  "$r" --cpu 2 --mem 4G bun "$b/generate-dataset.ts" "$corpus/pdfs" \
    --output "$c/after" --labels poppler --split train --mode pages \
    --preset calibrated --dpi calibrated --seed "$seed" --max-docs 10 --max-pages 1
done
"$r" --cpu 2 --mem 4G python "$b/scan-statistics.py" \
  --before "$c/before" --after "$c/after" --raw "$c/statistics.json"
```
