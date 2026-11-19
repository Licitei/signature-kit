# Portuguese real-scan line references

The manifest contains **617 visually checked lines from 61 pages across 16 procurement documents**. It includes body text, headings, table headings and cells, small print, and text beside stamps. The extractable image sample spans 75–301 DPI, with 383 JPEG, 131 CCITT, and 103 other PDF image crops. The six document IDs in `dev-documents.json` designate the calibration and model-selection split. All pages from the other ten documents belong to test.

| Split | Documents | Pages | Lines | Changed Tesseract seeds | Character edits | Reference characters |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dev | 6 | 21 | 186 | 63 | 127 | 7,707 |
| Test | 10 | 40 | 431 | 85 | 174 | 18,077 |
| All | 16 | 61 | 617 | 148 | 301 | 25,784 |

Page indexes and page-local XObject indexes are zero-based. Boxes use the original grayscale page-image pixels, with exclusive right and bottom edges. The SHA-256 covers the complete binary P5 crop. Text is NFC with one space between words. `seedCharacterEdits` is Levenshtein distance in Unicode code points against the trimmed NFC Tesseract seed. No word boxes were annotated, so regenerated dataset labels have an empty `words` array and support text scoring.

The sample comes from dominant page images in the first five pages of the corpus documents. The OCR layout CLI proposed source-space line boxes. Tesseract 5.3.0 seeded the crops with the standard Portuguese model, OEM 1, and PSM 7. Each included crop was compared visually against its seed and corrected where needed. Lines with cut characters, mixed text bands, or ambiguous markings were skipped. The sample favors readable lines and successful segmentation, so the seed edit rate is descriptive and will understate errors across unrestricted scans.

## Regenerate

From the repository root with Poppler 26.10.0 and Pillow 13.0.0:

```sh
b=shared/pdf-core/bench/ocr
c=shared/pdf-core/.cache
corpus=/home/yorizel/Documents/bench-parsers/editais-extra/digitalizados
mkdir -p .cache/t
export TMPDIR="$PWD/.cache/t"
python "$b/real_lines.py" regenerate "$corpus" "$c/ocr-data-v2-real"
```

The command writes `dev` and `test` directories and checks every regenerated PGM against the manifest. Test labels are for evaluation only.

To extend the set, build the native `pdf-core-ocr` CLI, then run `real_lines.py candidates "$corpus" --pages 5` and `real_lines.py seed` through `resource-run`. The latter uses the shared [Tesseract benchmark image](../README.md). Use `real_lines.py sheets PAGE_ID` to inspect candidate crops. Save only reviewed lines as UTF-8 JSONL objects with `id` and `text`. Run `real_lines.py finalize REVIEWS.jsonl` to join provenance and compute edit counts. Preserve the document assignments when extending either split.
