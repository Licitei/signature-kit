import argparse
from collections import defaultdict
from hashlib import sha256
from io import BytesIO
import json
import os
import re
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unicodedata import normalize

from PIL import Image, ImageDraw

BENCH = Path(__file__).resolve().parent
CACHE = BENCH.parent.parent / ".cache"
SEGMENTER = BENCH.parent.parent / "rust/target/release/pdf-core-ocr"
MANIFEST = BENCH / "reference-lines/manifest.jsonl"
DEV_DOCUMENTS = BENCH / "reference-lines/dev-documents.json"


def command(*args):
    return subprocess.check_output(args)


def write_jsonl(path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
                            for row in rows), encoding="utf-8")


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def listed_images(pdf, limit):
    records = defaultdict(list)
    first_index = {}
    for row in command("pdfimages", "-l", str(limit), "-list", pdf).decode().splitlines()[2:]:
        page, index, kind, width, height, _, _, bpc, encoding, _, *columns = row.split()
        first_index.setdefault(page, int(index))
        if kind != "image":
            continue
        x_dpi, y_dpi = map(float, columns[-4:-2])
        if min(x_dpi, y_dpi) <= 0 or int(width) / x_dpi < 5 or int(height) / y_dpi < 7:
            continue
        records[int(page) - 1].append({
            "imageIndex": int(index) - first_index[page], "width": int(width), "height": int(height),
            "dpi": round(y_dpi), "xDpi": round(x_dpi), "encoding": encoding, "bits": int(bpc),
        })
    return {page: max(images, key=lambda image: image["width"] * image["height"])
            for page, images in records.items()}


def extract(pdf, page, index, scratch):
    prefix = scratch / "image"
    command("pdfimages", "-f", str(page + 1), "-l", str(page + 1), "-j", pdf, prefix)
    paths = list(scratch.glob("image-*"))
    path, = (path for path in paths if int(path.stem.removeprefix("image-")) == index)
    with Image.open(path) as source:
        gray = source.convert("L")
        if source.format == "JPEG":
            gray.info["luminanceQuantization"] = source.quantization.get(0)
    for path in paths:
        path.unlink()
    return gray


def pgm(image):
    result = BytesIO()
    image.save(result, format="PPM")
    return result.getvalue()


def crop_bytes(image, box):
    left, top, right, bottom = box
    if not (0 <= left < right <= image.width and 0 <= top < bottom <= image.height):
        raise ValueError(f"Invalid crop {box} for {image.size}")
    return pgm(image.crop(box))


def candidates(root, output, limit):
    if output.resolve().is_relative_to(root):
        raise ValueError("Choose an output directory outside the corpus")
    output.mkdir(parents=True, exist_ok=True)
    (output / "pages").mkdir(exist_ok=True)
    (output / "crops").mkdir(exist_ok=True)
    pages = []
    lines = []
    with TemporaryDirectory() as temporary:
        scratch = Path(temporary)
        for pdf in sorted(root.glob("*/edital.pdf")):
            source = pdf.relative_to(root).as_posix()
            doc = sha256(source.encode()).hexdigest()[:12]
            images = listed_images(pdf, limit)
            for page, record in sorted(images.items()):
                image_index = record["imageIndex"]
                image = extract(pdf, page, image_index, scratch)
                page_id = f"{doc}-p{page:03d}"
                pgm_path = output / "pages" / f"{page_id}.pgm"
                pgm_path.write_bytes(pgm(image))
                layout = json.loads(command(SEGMENTER, pgm_path, "--dpi", str(record["dpi"]),
                                            "--layout-only"))
                pages.append({**record, "id": page_id, "source": source, "pageIndex": page,
                              "skewDegrees": layout["skewDegrees"],
                              "luminanceQuantization": image.info.get("luminanceQuantization")})
                for index, line in enumerate(layout["lines"]):
                    left, top, right, bottom = line["sourceBox"]
                    if right - left < 24 or not 6 <= bottom - top <= 85:
                        continue
                    box = [max(0, left - 2), max(0, top - 1),
                           min(image.width, right + 2), min(image.height, bottom + 1)]
                    identifier = f"{page_id}-l{index:03d}"
                    data = crop_bytes(image, box)
                    (output / "crops" / f"{identifier}.pgm").write_bytes(data)
                    lines.append({"id": identifier, "source": source, "pageIndex": page,
                                  "imageIndex": image_index, "dpi": record["dpi"],
                                  "encoding": record["encoding"], "box": box,
                                  "imageSha256": sha256(data).hexdigest()})
            print(f"{doc} {len(images)} pages {pdf.parent.name}", flush=True)
    write_jsonl(output / "pages.jsonl", pages)
    write_jsonl(output / "candidates.jsonl", lines)
    print(f"{len(pages)} pages, {len(lines)} candidates")


def seeds(output, image):
    crops = output / "crops"
    destination = output / "seeds"
    destination.mkdir(exist_ok=True)
    script = """
find /crops -type f -name '*.pgm' -print0 | sort -z | xargs -0 -r -n1 -P4 sh -ec '
  sample=${0##*/}
  tesseract "$0" "/seeds/${sample%.pgm}" --tessdata-dir /models/standard -l por --oem 1 --psm 7
'
"""
    subprocess.run(["docker", "run", "--rm", "--network", "none", "--cpus", "4",
                    "--user", f"{os.getuid()}:{os.getgid()}",
                    "-v", f"{crops.resolve()}:/crops:ro",
                    "-v", f"{destination.resolve()}:/seeds", image, "sh", "-ec", script], check=True)


def sheets(output, page_id):
    rows = [row for row in read_jsonl(output / "candidates.jsonl")
            if row["id"].startswith(f"{page_id}-l")]
    for batch in range(0, len(rows), 12):
        records = rows[batch:batch + 12]
        images = [Image.open(output / "crops" / f"{row['id']}.pgm").convert("L")
                  for row in records]
        sheet = Image.new("L", (max(image.width for image in images) + 48,
                                sum(image.height + 8 for image in images)), 255)
        draw = ImageDraw.Draw(sheet)
        top = 0
        for row, image in zip(records, images, strict=True):
            draw.text((2, top + 2), row["id"].rsplit("-l", 1)[1], fill=0)
            sheet.paste(image, (48, top))
            top += image.height + 8
        path = output / f"{page_id}-{batch // 12:02d}.png"
        sheet.save(path)
        print(path)


def character_edits(seed, text):
    previous = list(range(len(seed) + 1))
    for i, letter in enumerate(text, 1):
        row = [i]
        for j, other in enumerate(seed, 1):
            row.append(min(previous[j] + 1, row[-1] + 1, previous[j - 1] + (letter != other)))
        previous = row
    return previous[-1]


def finalize(output, reviews, manifest):
    candidates_by_id = {row["id"]: row for row in read_jsonl(output / "candidates.jsonl")}
    rows = []
    seen = set()
    dev = set(json.loads(DEV_DOCUMENTS.read_text()))
    for review in read_jsonl(reviews):
        identifier = review["id"]
        split = "dev" if identifier.split("-")[0] in dev else "test"
        text = normalize("NFC", review["text"].strip())
        row = candidates_by_id[identifier]
        if identifier in seen or not text or "\n" in text:
            raise ValueError(f"Invalid or overlapping review: {identifier}")
        seen.add(identifier)
        seed = normalize("NFC", (output / "seeds" / f"{identifier}.txt").read_text(
            encoding="utf-8").strip())
        rows.append({**row, "split": split, "text": text, "reviewed": "visual",
                     "seedCharacterEdits": character_edits(seed, text)})
    manifest.parent.mkdir(parents=True, exist_ok=True)
    write_jsonl(manifest, sorted(rows, key=lambda row: row["id"]))


def regenerate(root, output, manifest):
    if output.is_relative_to(root):
        raise ValueError("Choose an output directory outside the corpus")
    groups = defaultdict(list)
    seen = set()
    dev = set(json.loads(DEV_DOCUMENTS.read_text()))
    for row in read_jsonl(manifest):
        doc = sha256(row["source"].encode()).hexdigest()[:12]
        split = "dev" if doc in dev else "test"
        page = row["pageIndex"]
        identifier = row["id"]
        if (identifier in seen or not re.fullmatch(rf"{doc}-p{page:03d}-l[0-9]+", identifier)
                or row["split"] != split or row["reviewed"] != "visual"):
            raise ValueError(f"Invalid reviewed line: {identifier}")
        seen.add(identifier)
        groups[row["source"], row["pageIndex"], row["imageIndex"]].append(row)
    for (source, page, index), rows in groups.items():
        pdf = (root / source).resolve()
        if not pdf.is_relative_to(root):
            raise ValueError(f"Unsafe PDF path: {source}")
        with TemporaryDirectory() as temporary:
            image = extract(pdf, page, index, Path(temporary))
        for row in rows:
            data = crop_bytes(image, row["box"])
            if sha256(data).hexdigest() != row["imageSha256"]:
                raise ValueError(f"Image hash mismatch: {row['id']}")
            left, top, right, bottom = row["box"]
            directory = output / row["split"]
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / row["id"]
            path.with_suffix(".pgm").write_bytes(data)
            label = {**row, "width": right - left, "height": bottom - top,
                     "degradation": {"real": True, "encoding": row["encoding"]}, "words": []}
            path.with_suffix(".json").write_text(json.dumps(label, ensure_ascii=False) + "\n",
                                                 encoding="utf-8")
    print(f"Regenerated {sum(map(len, groups.values()))} hash-verified crops")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, default=CACHE / "real-line-review")
    modes = parser.add_subparsers(dest="mode", required=True)
    prepare = modes.add_parser("candidates")
    prepare.add_argument("root", type=Path)
    prepare.add_argument("--pages", type=int, default=4)
    seed = modes.add_parser("seed")
    seed.add_argument("--image", default="signature-kit-ocr-bench:5.3.0")
    sheets_parser = modes.add_parser("sheets")
    sheets_parser.add_argument("page")
    review = modes.add_parser("finalize")
    review.add_argument("reviews", type=Path)
    review.add_argument("--manifest", type=Path, default=MANIFEST)
    regen = modes.add_parser("regenerate")
    regen.add_argument("root", type=Path)
    regen.add_argument("output", type=Path)
    regen.add_argument("--manifest", type=Path, default=MANIFEST)
    args = parser.parse_args()
    if args.mode == "candidates":
        candidates(args.root.resolve(), args.work, args.pages)
    elif args.mode == "seed":
        seeds(args.work, args.image)
    elif args.mode == "sheets":
        sheets(args.work, args.page)
    elif args.mode == "finalize":
        finalize(args.work, args.reviews, args.manifest)
    else:
        regenerate(args.root.resolve(), args.output.resolve(), args.manifest)


if __name__ == "__main__":
    main()
