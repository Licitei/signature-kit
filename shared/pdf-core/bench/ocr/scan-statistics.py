import argparse
import json
import math
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image, ImageFilter

from real_lines import BENCH, CACHE, SEGMENTER, pgm, read_jsonl

IJG_LUMA = np.array([
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
])
DOCS = BENCH / "reference-lines/dev-documents.json"


def quality(table):
    if table is None:
        return None
    observed = np.asarray(table)
    return min(range(1, 101), key=lambda q: np.mean(np.abs(
        observed - np.clip((IJG_LUMA * (5000 // q if q < 50 else 200 - 2 * q) + 50)
                           // 100, 1, 255))))


def stroke_width(ink):
    lengths = []
    for pixels in (ink, ink.T):
        _, transitions = np.where(np.diff(pixels, prepend=False, append=False))
        widths = transitions[1::2] - transitions[::2]
        lengths.extend(widths[(widths > 0) & (widths <= 20)])
    return float(np.median(lengths)) if lengths else None


def background_texture(pixels, ink):
    s = 32
    frequencies = np.fft.fftfreq(s)
    upper = np.hypot(frequencies[:, None], frequencies[None, :]) >= 0.25
    sample = []
    high = []
    medians = []
    for y in range(0, pixels.shape[0] - s, 64):
        for x in range(0, pixels.shape[1] - s, 64):
            if ink[y:y+s, x:x+s].any():
                continue
            block = pixels[y:y+s, x:x+s].astype(float)
            mean = float(block.mean())
            medians.append(mean)
            centered = block - mean
            energy = np.abs(np.fft.fft2(centered)) ** 2
            sample.append(float(np.sqrt(np.mean(centered ** 2))))
            if energy.sum() > 0:
                high.append(float(energy[upper].sum() / energy.sum()))
    return (
        float(np.median(sample)) if sample else 0,
        float(np.median(high)) if high else None,
        float(np.percentile(medians, 90) - np.percentile(medians, 10)) if medians else 0,
    )


def edge_width(pixels, ink, contrast):
    gradients = []
    for values, mask in ((pixels, ink), (pixels.T, ink.T)):
        transitions = mask[:, 1:] != mask[:, :-1]
        gradients.extend(np.abs(np.diff(values.astype(np.int16), axis=1))[transitions])
    return contrast / max(float(np.percentile(gradients, 75)), 1) if gradients else None


def measure(image, record, table):
    width, height = image.size
    center = image.crop((width // 20, height // 20, width - width // 20, height - height // 20))
    pixels = np.asarray(center)
    white = float(np.percentile(pixels, 90))
    dark = float(np.percentile(pixels, 2))
    contrast = white - dark
    ink = pixels < (white + dark) / 2
    dilated = np.asarray(Image.fromarray(ink).convert("L").filter(ImageFilter.MaxFilter(9))) > 0
    neighbors = np.asarray(Image.fromarray(ink).convert("L").filter(ImageFilter.BoxBlur(1)))
    flat = ~dilated
    faint = flat & (pixels < white - 10) & (pixels >= white - 50)
    rms, spectrum, illumination = background_texture(pixels, ink)
    return {"dpi": record["dpi"], "ccitt": record.get("encoding") == "ccitt",
            "bilevel": bool(np.all((pixels == 0) | (pixels == 255))),
            "jpegQuality": quality(table), "skewDegrees": record["skewDegrees"],
            "strokePx": stroke_width(ink), "backgroundRms": rms, "highFrequencyShare": spectrum,
            "edgeWidthPx": edge_width(pixels, ink, contrast), "contrast": contrast, "paper": white,
            "specklePpm": float((ink & (neighbors <= 29)).mean() * 1e6),
            "faintBackgroundPct": float(faint.sum() / max(flat.sum(), 1) * 100),
            "illuminationRange": illumination}


def profile(stats):
    contrast = stats["contrast"] / 255
    edge = stats["edgeWidthPx"] or 1
    return {
        "dpi": stats["dpi"],
        "skewDegrees": round(stats["skewDegrees"], 3),
        "blurSigma": round(max(0, min(1.3, math.sqrt(max(0, edge ** 2 - 1.5 ** 2)) / 2.56)), 3),
        "sensorNoise": round(min(18, stats["backgroundRms"]), 3),
        "saltAndPepper": round(min(0.02, stats["specklePpm"] / 500000), 6),
        "brightness": round(stats["paper"] - 127.5 * (1 + contrast), 2),
        "contrast": round(max(0.1, contrast), 3),
        "illumination": round(min(65, stats["illuminationRange"]), 2),
        "inkMorphology": 1 if stats["strokePx"] is not None and stats["strokePx"] >= 4 else 0,
        "bilevelThreshold": 160 if stats["bilevel"] else 0,
        "jpegQuality": stats["jpegQuality"] or 0,
    }


def dev(work):
    ids = set(json.loads(DOCS.read_text()))
    stats = []
    for row in read_jsonl(work / "pages.jsonl"):
        if row["id"].split("-")[0] not in ids:
            continue
        with Image.open(work / "pages" / f"{row['id']}.pgm") as source:
            metrics = measure(source, row, row["luminanceQuantization"])
        stats.append({"id": row["id"], **metrics})
    if {row["id"].split("-")[0] for row in stats} != ids:
        raise ValueError("The real sample is missing one or more dev documents")
    return stats


def synthetic(path):
    stats = []
    with TemporaryDirectory() as temporary:
        input_path = Path(temporary) / "input.pgm"
        for label in sorted(path.rglob("*.json")):
            row = json.loads(label.read_text())
            if "degradation" not in row:
                continue
            jpg = label.with_suffix(".jpg")
            with Image.open(jpg if jpg.exists() else label.with_suffix(".pgm")) as source:
                table = source.quantization.get(0) if source.format == "JPEG" else None
                gray = source.convert("L")
            input_path.write_bytes(pgm(gray))
            layout = subprocess.run(
                [SEGMENTER, input_path, "--dpi", str(row["dpi"]), "--layout-only"],
                capture_output=True, check=True,
            )
            row["skewDegrees"] = json.loads(layout.stdout)["skewDegrees"]
            stats.append({"id": row["id"], **measure(gray, row, table)})
    if not stats:
        raise ValueError(f"No synthetic dataset in {path}")
    return stats


def summary(rows):
    output = {}
    for key in rows[0]:
        if key == "id":
            continue
        values = [row[key] for row in rows if row[key] is not None]
        if key in ("ccitt", "bilevel"):
            output[key] = f"{sum(values)}/{len(values)}"
        elif not values:
            output[key] = "—"
        else:
            q10, median, q90 = np.percentile(values, [10, 50, 90])
            output[key] = f"{median:.3g} [{q10:.3g}, {q90:.3g}] (n={len(values)})"
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, default=CACHE / "real-line-review")
    parser.add_argument("--fit", type=Path)
    parser.add_argument("--before", type=Path)
    parser.add_argument("--after", type=Path)
    parser.add_argument("--raw", type=Path)
    args = parser.parse_args()
    real = dev(args.work)
    if args.fit is not None:
        config = {"version": 1, "profiles": [profile(row) for row in real]}
        args.fit.write_text(json.dumps(config, indent=2) + "\n")
    comparisons = {"Real dev": real}
    if args.before is not None:
        comparisons["Synthetic before"] = synthetic(args.before)
    if args.after is not None:
        comparisons["Synthetic after"] = synthetic(args.after)
    if args.raw is not None:
        args.raw.write_text(json.dumps(comparisons, indent=2) + "\n")
    tables = {label: summary(rows) for label, rows in comparisons.items()}
    print("| Measure | " + " | ".join(tables) + " |")
    print("|" + " --- |" * (len(tables) + 1))
    for key in next(iter(tables.values())):
        print(f"| {key} | " + " | ".join(table[key] for table in tables.values()) + " |")


if __name__ == "__main__":
    main()
