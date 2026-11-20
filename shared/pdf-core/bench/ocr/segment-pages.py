import argparse
from collections import Counter, defaultdict
from hashlib import sha256
from itertools import combinations
import json
from math import radians, tan
import os
from pathlib import Path
from statistics import median
import subprocess
from tempfile import TemporaryDirectory
from unicodedata import normalize

from PIL import Image, ImageOps

from real_lines import DEV_DOCUMENTS, MANIFEST, SEGMENTER, pgm, read_jsonl


def bounds(boxes):
    left, top, right, bottom = zip(*boxes, strict=True)
    return min(left), min(top), max(right), max(bottom)


def area(box):
    left, top, right, bottom = box
    return (right - left) * (bottom - top)


def intersection(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))


def geometry(reference, predicted):
    overlaps = []
    for ri, expected in enumerate(reference):
        for pi, actual in enumerate(predicted):
            common = intersection(expected, actual)
            if common:
                overlaps.append((common / (area(expected) + area(actual) - common), ri, pi,
                                 common / area(expected), common / area(actual)))
    pairs = {}
    used = set()
    for iou, ri, pi, _, _ in sorted(overlaps, key=lambda pair: (-pair[0], pair[1], pair[2])):
        if iou >= 0.5 and ri not in pairs and pi not in used:
            pairs[ri] = pi
            used.add(pi)
    ref_coverage = Counter(ri for _, ri, _, ref, pred in overlaps if ref >= 0.15 and pred >= 0.15)
    pred_coverage = Counter(pi for _, _, pi, ref, pred in overlaps if ref >= 0.15 and pred >= 0.15)
    return {
        "reference": len(reference), "predicted": len(predicted), "matched": len(pairs),
        "withoutOverlap": len(predicted) - len(pred_coverage),
        "missed": len(reference) - len(ref_coverage),
        "split": sum(count > 1 for count in ref_coverage.values()),
        "merged": sum(count > 1 for count in pred_coverage.values()),
        "inversions": sum(first > second for first, second in combinations(
            (pairs[ri] for ri in sorted(pairs)), 2)),
    }


def distance(reference, candidate):
    if not reference:
        return len(candidate)
    masks = defaultdict(int)
    for index, token in enumerate(reference):
        masks[token] |= 1 << index
    positive, negative, score = -1, 0, len(reference)
    high = 1 << (score - 1)
    for token in candidate:
        equal = masks[token]
        vertical = equal | negative
        horizontal = (((equal & positive) + positive) ^ positive) | equal
        plus = negative | ~(horizontal | positive)
        minus = positive & horizontal
        score += bool(plus & high) - bool(minus & high)
        plus, minus = (plus << 1) | 1, minus << 1
        positive, negative = minus | ~(vertical | plus), plus & vertical
    return score


def text_counts(expected, actual):
    expected, actual = (normalize("NFC", text.strip()) for text in (expected, actual))
    return {"characters": len(expected), "characterEdits": distance(expected, actual),
            "words": len(expected.split()), "wordEdits": distance(expected.split(), actual.split())}


def page_layout(segmenter, path, dpi, repeats):
    milliseconds = []
    for _ in range(repeats):
        result = subprocess.run([segmenter, path, "--dpi", str(dpi), "--layout-only", "--timings"],
                                capture_output=True, check=True, text=True)
        stages = {stage: float(ms) for stage, ms, _ in (row.split() for row in result.stderr.splitlines())}
        milliseconds.append(sum(stages[name] for name in ("Binarize", "Deskew", "Clean", "Segment")))
    return json.loads(result.stdout), median(milliseconds)


def recognize(image, inputs, output, tasks, jobs):
    if not tasks:
        return
    manifest = inputs / "jobs"
    manifest.write_text("".join(f"{path} {dpi} {mode}\n" for path, dpi, mode in tasks))
    script = """
xargs -r -n3 -P "$1" sh -ec '
  input=$1
  name=${input##*/}
  format=txt
  [ "$3" != 3 ] || format=tsv
  tesseract "/inputs/$input" "/output/${name%.pgm}" --tessdata-dir /models/standard \
    -l por --dpi "$2" --oem 1 --psm "$3" "$format"
' sh < /inputs/jobs
"""
    subprocess.run(["docker", "run", "--rm", "--network", "none", "--cpus", str(jobs),
                    "--user", f"{os.getuid()}:{os.getgid()}", "-v", f"{inputs}:/inputs:ro",
                    "-v", f"{output}:/output", image, "sh", "-ec", script, "sh", str(jobs)], check=True)


def rectified_crop(image, box, slope, margin):
    left, top, right, bottom = box
    left, top = max(0, left - margin), top - margin
    right, bottom = min(image.width, right + margin), bottom + margin
    return image.transform(
        (right - left, bottom - top), Image.Transform.AFFINE,
        (1, 0, left, slope, 1, top + (left - image.width // 2) * slope),
        resample=Image.Resampling.BILINEAR, fillcolor=255,
    )


def page_reference(tsv):
    lines = defaultdict(list)
    for row in tsv.splitlines()[1:]:
        fields = row.split("\t", 11)
        if len(fields) == 12 and fields[0] == "5" and fields[11].strip():
            left, top, width, height = map(int, fields[6:10])
            lines[tuple(fields[1:5])].append((fields[11].strip(), (left, top, left + width, top + height)))
    return ("\n".join(" ".join(word for word, _ in words) for words in lines.values()),
            [bounds(box for _, box in words) for words in lines.values()])


def samples(args):
    reviewed = defaultdict(list)
    if args.reviewed_pages:
        for row in read_jsonl(MANIFEST):
            if row["split"] == args.split:
                reviewed[row["id"].rsplit("-l", 1)[0]].append(row)
        for page_id, lines in sorted(reviewed.items()):
            with Image.open(args.dataset / f"{page_id}.pgm") as image:
                for line in lines:
                    if sha256(pgm(image.crop(line["box"]))).hexdigest() != line["imageSha256"]:
                        raise ValueError(f"Image hash mismatch: {line['id']}")
            yield page_id, lines[0]["dpi"], None, [line["box"] for line in lines]
        return
    dev = set(json.loads(DEV_DOCUMENTS.read_text()))
    for label in sorted(args.dataset.glob("*.json")):
        reference = json.loads(label.read_text())
        if args.split == "dev":
            raise ValueError("Use --reviewed-pages to evaluate the real dev geometry")
        if args.split == "test" and reference.get("imageSha256"):
            doc = sha256(reference["source"].split("#")[0].encode()).hexdigest()[:12]
            if doc in dev:
                continue
        groups = defaultdict(list)
        for word in reference.get("words", []):
            groups[word["line"]].append(word["box"])
        yield label.stem, reference["dpi"], reference, [bounds(group) for group in groups.values()]


def run(args, scratch):
    tasks, pages = [], []
    args.psm3_cache.mkdir(parents=True, exist_ok=True)
    transcripts = scratch / "transcripts"
    transcripts.mkdir()
    for page_index, (identifier, dpi, reference, annotated) in enumerate(samples(args)):
        if not args.only or identifier in args.only:
            path = args.dataset / f"{identifier}.pgm"
            if reference and reference.get("imageSha256"):
                if sha256(path.read_bytes()).hexdigest() != reference["imageSha256"]:
                    raise ValueError(f"Image hash mismatch: {identifier}")
            layout, timing = page_layout(args.segmenter, path, dpi, args.repeats)
            lines = [line["sourceBox"] for line in layout["lines"]]
            names = []
            if not args.geometry_only:
                with Image.open(path) as image:
                    turns = layout["quarterTurns"] if args.rectify else 0
                    if turns:
                        rotation = {1: Image.Transpose.ROTATE_270, 2: Image.Transpose.ROTATE_180,
                                    3: Image.Transpose.ROTATE_90}
                        image = image.transpose(rotation[turns])
                    slope = tan(radians(layout["skewDegrees"]))
                    for i, line in enumerate(layout["lines"]):
                        name = f"line-{page_index}-{i}"
                        crop = (rectified_crop(image, line["box"], slope, max(1, round(dpi / 150))) if args.rectify
                                else image.crop(line["sourceBox"]))
                        crop = ImageOps.expand(crop, border=max(3, round(dpi / 30)), fill=255)
                        (scratch / f"{name}.pgm").write_bytes(pgm(crop))
                        names.append(name)
                        tasks.append((f"{name}.pgm", dpi, 7))
                    (scratch / f"page-{page_index}.pgm").write_bytes(path.read_bytes())
            pages.append((identifier, dpi, reference, annotated, lines, timing, names, layout,
                          sha256(path.read_bytes()).hexdigest(), page_index))
    if not pages:
        raise ValueError("No pages selected")
    image_id = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}",
                                        args.image], text=True).strip() if not args.geometry_only else None
    for _, dpi, _, _, _, _, _, _, digest, index in pages:
        key = sha256(f"{image_id}:{dpi}:{digest}".encode()).hexdigest()
        if not args.geometry_only and not (args.psm3_cache / f"{key}.tsv").exists():
            tasks.append((f"page-{index}.pgm", dpi, 3))
    recognize(args.image, scratch, transcripts, tasks, args.jobs)
    rows = []
    for identifier, dpi, reference, annotated, lines, timing, names, layout, digest, index in pages:
        row = {"id": identifier, "dpi": dpi, "preprocessMs": timing, "layout": layout}
        if not args.geometry_only:
            key = sha256(f"{image_id}:{dpi}:{digest}".encode()).hexdigest()
            cache = args.psm3_cache / f"{key}.tsv"
            output = transcripts / f"page-{index}.tsv"
            if output.exists():
                output.replace(cache)
            page_text, page_boxes = page_reference(cache.read_text())
            crops = [(transcripts / f"{name}.txt").read_text().strip() for name in names]
            row.update(psm3Text=page_text, psm7Crops=crops, psm3Boxes=page_boxes,
                       psm3Geometry=geometry(page_boxes, lines))
            if reference:
                row["psm3"] = text_counts(reference["text"], page_text)
                row["psm7"] = text_counts(reference["text"], "\n".join(text for text in crops if text))
        if annotated:
            row["referenceGeometry"] = geometry(annotated, lines)
        rows.append(row)
    return {"tesseractImage": image_id, "rectifiedCrops": args.rectify, "pages": rows}


def summarize(report):
    rows = report["pages"]
    summary = {"pages": len(rows), "meanPreprocessMs": sum(row["preprocessMs"] for row in rows) / len(rows)}
    for field in ("psm3Geometry", "referenceGeometry", "psm3", "psm7"):
        totals = Counter()
        for row in rows:
            totals.update(row.get(field, {}))
        if totals:
            summary[field] = dict(totals)
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("report", type=Path)
    parser.add_argument("--segmenter", type=Path, default=SEGMENTER)
    parser.add_argument("--image", default="signature-kit-ocr-bench:5.3.0")
    parser.add_argument("--split", choices=("all", "dev", "test"), default="all")
    parser.add_argument("--reviewed-pages", action="store_true")
    parser.add_argument("--geometry-only", action="store_true")
    parser.add_argument("--rectify", action="store_true")
    parser.add_argument("--only", action="append")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if args.jobs < 1 or args.repeats < 1 or args.reviewed_pages and args.split == "all":
        parser.error("Use positive job and repeat counts and select a split for reviewed pages")
    args.report = args.report.resolve()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.psm3_cache = args.report.parent / "psm3"
    with TemporaryDirectory(dir=args.report.parent) as temporary:
        report = run(args, Path(temporary))
    report["summary"] = summarize(report)
    args.report.write_text(json.dumps(report, ensure_ascii=False) + "\n")
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
