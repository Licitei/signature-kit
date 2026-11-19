# OCR datasets

Run the native PDF bootstrap dataset generator with Bun and Poppler
(`pdftotext` with `-tsv`, and `pdftoppm`).

```sh
bun shared/pdf-core/bench/ocr/generate-dataset.ts /home/yorizel/Documents/bench-parsers \
  --dpi 300 --mode pages --max-docs 20 --max-pages 1
bun shared/pdf-core/bench/ocr/generate-dataset.ts /home/yorizel/Documents/bench-parsers \
  --dpi 200 --mode lines --split train
```

By default the output goes to `shared/pdf-core/.cache/ocr-dataset/`. Each sample
consists of a binary P5 grayscale image and a JSON label with pixel boxes in
top-left coordinates. Word boxes use exclusive right and bottom edges. Page
indexes and line numbers are zero-based. Line samples use crop-local boxes.
Directories named `digitalizados` are excluded. Poppler supplies word boxes in
reading order. This bootstrap supports word and line labels and clean images.

The split hashes the UTF-8 source path relative to the input directory (or the
file's containing directory for a file input), with forward slashes, using
SHA-256. The first eight hex digits interpreted as an integer modulo 100 assign
buckets 0–79 to train, 80–89 to validation, and 90–99 to test. All pages, crops,
and DPI variants in one document share a split. Keep the input directory stable
across runs and reserve the test split for benchmark use.
