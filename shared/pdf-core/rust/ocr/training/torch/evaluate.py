import argparse
from collections import Counter, defaultdict
from functools import partial
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import time
import unicodedata

import numpy as np
import torch

from data import pgm, raster, record_text, records
from model import LOGIT_UNIT, Recognizer, normalize
from model_v5 import Recognizer as RecognizerV5, normalize as normalize_v5
from train import raw_metrics


def packet(gray, table):
    height, width = gray.shape
    return struct.pack("<III", width, height, len(table)) + table + gray.tobytes()


def prepare_fixture(gray, model, normalize_line):
    normalized = normalize_line(gray)
    features = torch.from_numpy(normalized.T.astype(np.float32))[None, ...]
    with torch.inference_mode():
        logits = model(features, torch.tensor([len(normalized)]), "int8")
    scores = (logits.squeeze(0).T * LOGIT_UNIT).numpy().astype("<i4")
    return struct.pack("<I", normalized.nbytes) + normalized.tobytes() + scores.tobytes()


def crops(archive, directory):
    directory.mkdir(parents=True, exist_ok=False)
    with archive.open("rb") as file:
        for index, line in enumerate(records(archive)):
            file.seek(line.offset)
            pixels = raster(file, line)
            sample_id = f"line-{index:05}"
            (directory / f"{sample_id}.pgm").write_bytes(
                f"P5\n{line.width} {line.height}\n255\n".encode() + pixels.tobytes()
            )
            label = dict(id=sample_id, text=record_text(line.text), dpi=300, width=line.width,
                         height=line.height, source=archive.name, degradation={}, words=[])
            (directory / f"{sample_id}.json").write_text(json.dumps(label, ensure_ascii=False) + "\n")


def fixture(args):
    table = args.table.read_bytes()
    magic, version, architecture, manifest, commit, seed, _ = struct.unpack_from("<4sHH32s20sQH", table)
    normalize_line = partial(normalize_v5, robust=version >= 2) if magic == b"OCR5" else normalize
    model = (RecognizerV5(architecture) if magic == b"OCR5" else Recognizer()).eval()
    state = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    if "ema" in state:
        state = {key.removeprefix("module."): value for key, value in state["ema"].items()
                 if key.startswith("module.")}
    model.load_state_dict(state)
    export = partial(model.table, version=version) if magic == b"OCR5" else model.table
    if export(manifest.hex(), commit.hex(), seed) != table:
        raise ValueError("checkpoint and exported table differ")
    paths = sorted(args.archive.glob("*.pgm")) if args.archive.is_dir() else None
    cases = paths if paths is not None else list(records(args.archive))
    if len(cases) < 128:
        raise ValueError("parity requires at least 128 source lines")
    with tempfile.TemporaryDirectory(prefix="ocr-fixtures-") as temporary:
        directory = Path(temporary)
        digest = hashlib.sha256()
        for index in range(128):
            line = cases[index * len(cases) // 128]
            if paths is not None:
                gray = pgm(line)
            else:
                with args.archive.open("rb") as file:
                    file.seek(line.offset)
                    gray = raster(file, line)
            source = directory / f"{index:03}.packet"
            source.write_bytes(packet(gray, table))
            expected = prepare_fixture(gray, model, normalize_line)
            actual = subprocess.check_output([args.native, "fixture", source])
            if expected != actual:
                difference = next((i for i, pair in enumerate(zip(expected, actual)) if pair[0] != pair[1]), None)
                raise ValueError(f"native parity mismatch in line {index}, byte {difference}")
            source.with_suffix(".expected").write_bytes(expected)
            digest.update(expected)
        print(f"native parity: 128 exact normalized rasters and logit matrices, sha256={digest.hexdigest()}", flush=True)
        subprocess.run(["bun", Path(__file__).with_name("wasm.mjs"), "fixture",
                        args.scalar, args.simd, directory], check=True)


def evaluate_native(args):
    if args.pages and args.beam:
        raise ValueError("beam comparison is only available for line crops")
    pairs = []
    times = []
    table = args.table.read_bytes()
    with tempfile.TemporaryDirectory(prefix="ocr-evaluate-") as temporary:
        source = Path(temporary) / "line.packet"
        for label in sorted(args.dataset.glob("*.json")):
            metadata = json.loads(label.read_text())
            reference = unicodedata.normalize("NFC", metadata["text"])
            image = label.with_suffix(".pgm")
            if not args.pages:
                source.write_bytes(packet(pgm(image), table))
            start = time.perf_counter()
            if args.pages:
                predicted = subprocess.check_output([
                    args.native, image, "--dpi", str(metadata["dpi"]), "--ctc-model", args.table,
                ], text=True)
                observed = json.loads(predicted)["text"]
            else:
                reference = record_text(reference)
                mode = "text-beam" if args.beam else "text"
                observed = subprocess.check_output([args.native, mode, source], text=True)
            times.append(time.perf_counter() - start)
            pairs.append((reference, unicodedata.normalize("NFC", observed).strip()))
    report(pairs, sum(times))


def report(pairs, seconds):
    if not pairs:
        raise ValueError("empty evaluation dataset")
    def metrics(samples):
        result = raw_metrics(samples)
        hits = 0
        total = 0
        for reference, predicted in samples:
            expected, actual = Counter(reference.split()), Counter(predicted.split())
            hits += (expected & actual).total()
            total += expected.total() + actual.total()
        result["cer"] = result["character_edits"] / max(1, result["characters"])
        result["wer"] = result["word_edits"] / max(1, result["words"])
        result["bag_f1"] = 2 * hits / max(1, total)
        return result

    normalized = [(record_text(ref).lower(), record_text(guess).lower()) for ref, guess in pairs]
    print(json.dumps(dict(raw=metrics(pairs), normalized=metrics(normalized),
                          wall_ms_per_image=seconds * 1000 / len(pairs))))


def evaluate_tesseract(args):
    groups = defaultdict(list)
    for label in sorted(args.dataset.glob("*.json")):
        data = json.loads(label.read_text())
        groups[data["dpi"]].append((label.with_suffix(".pgm").name, record_text(data["text"])))
    pairs = []
    seconds = 0.0
    with tempfile.TemporaryDirectory(prefix="ocr-tesseract-") as temporary:
        images = Path(temporary) / "images.txt"
        for dpi, entries in sorted(groups.items()):
            images.write_text("".join(f"/dataset/{path}\n" for path, _ in entries))
            start = time.perf_counter()
            command = [
                "docker", "run", "--rm", "--network", "none", "--cpuset-cpus", str(args.cpu),
                "-e", "OMP_THREAD_LIMIT=1",
                "--mount", f"type=bind,source={args.dataset.resolve()},target=/dataset,readonly",
                "--mount", f"type=bind,source={images},target=/images.txt,readonly",
                "signature-kit-ocr-bench:5.3.0", "tesseract", "/images.txt", "stdout",
                "--tessdata-dir", f"/models/{args.model}", "-l", "por",
                "--dpi", str(dpi), "--oem", "1", "--psm", "7",
            ]
            output = subprocess.run(command, check=True, capture_output=True, text=True)
            seconds += time.perf_counter() - start
            texts = output.stdout.removesuffix("\f").split("\f")
            pairs.extend((reference, unicodedata.normalize("NFC", text).strip())
                         for (_, reference), text in zip(entries, texts, strict=True))
    report(pairs, seconds)


if __name__ == "__main__":
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("crops")
    export.add_argument("archive", type=Path)
    export.add_argument("directory", type=Path)
    parity = commands.add_parser("fixture")
    for option in ("checkpoint", "table", "archive", "native", "scalar", "simd"):
        parity.add_argument(option, type=Path)
    native = commands.add_parser("native")
    for option in ("table", "dataset", "native"):
        native.add_argument(option, type=Path)
    native.add_argument("--pages", action="store_true")
    native.add_argument("--beam", action="store_true")
    baseline = commands.add_parser("tesseract")
    baseline.add_argument("model", choices=("standard", "fast"))
    baseline.add_argument("dataset", type=Path)
    baseline.add_argument("--cpu", type=int, default=5)
    payload = commands.add_parser("packet")
    for option in ("table", "pgm", "output"):
        payload.add_argument(option, type=Path)
    args = parser.parse_args()
    if args.command == "crops":
        crops(args.archive, args.directory)
    elif args.command == "fixture":
        fixture(args)
    elif args.command == "native":
        evaluate_native(args)
    elif args.command == "tesseract":
        evaluate_tesseract(args)
    else:
        args.output.write_bytes(packet(pgm(args.pgm), args.table.read_bytes()))
