import argparse
from collections import defaultdict
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
from train import raw_metrics


def packet(gray, table):
    height, width = gray.shape
    return struct.pack("<III", width, height, len(table)) + table + gray.tobytes()


def prepare_fixture(gray, model):
    normalized = normalize(gray)
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
    model = Recognizer().eval()
    model.load_state_dict(torch.load(args.checkpoint, map_location="cpu", weights_only=True))
    table = args.table.read_bytes()
    table_header = struct.unpack_from("<4sHH32s20sQH", table)
    _, _, _, manifest, commit, seed, _ = table_header
    if model.table(manifest.hex(), commit.hex(), seed) != table:
        raise ValueError("checkpoint and exported table differ")
    cases = list(records(args.archive))
    if len(cases) < 128:
        raise ValueError("parity requires at least 128 source lines")
    with tempfile.TemporaryDirectory(prefix="ocr-v4-fixtures-") as temporary, args.archive.open("rb") as file:
        directory = Path(temporary)
        digest = hashlib.sha256()
        for index in range(128):
            line = cases[index * len(cases) // 128]
            file.seek(line.offset)
            gray = raster(file, line)
            source = directory / f"{index:03}.packet"
            source.write_bytes(packet(gray, table))
            expected = prepare_fixture(gray, model)
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
    pairs = []
    times = []
    table = args.table.read_bytes()
    with tempfile.TemporaryDirectory(prefix="ocr-v4-evaluate-") as temporary:
        source = Path(temporary) / "line.packet"
        for label in sorted(args.dataset.glob("*.json")):
            reference = record_text(json.loads(label.read_text())["text"])
            source.write_bytes(packet(pgm(label.with_suffix(".pgm")), table))
            start = time.perf_counter()
            observed = subprocess.check_output([args.native, "text", source], text=True)
            times.append(time.perf_counter() - start)
            pairs.append((reference, unicodedata.normalize("NFC", observed).strip()))
    report(pairs, sum(times))


def report(pairs, seconds):
    if not pairs:
        raise ValueError("empty evaluation dataset")
    raw = raw_metrics(pairs)
    normalized = raw_metrics([(record_text(reference).lower(), record_text(observed).lower())
                              for reference, observed in pairs])
    for result in (raw, normalized):
        result["cer"] = result["character_edits"] / result["characters"]
        result["wer"] = result["word_edits"] / result["words"]
    print(json.dumps(dict(raw=raw, normalized=normalized, wall_ms_per_line=seconds * 1000 / len(pairs))))


def evaluate_tesseract(args):
    groups = defaultdict(list)
    for label in sorted(args.dataset.glob("*.json")):
        data = json.loads(label.read_text())
        groups[data["dpi"]].append((label.with_suffix(".pgm").name, record_text(data["text"])))
    pairs = []
    seconds = 0.0
    with tempfile.TemporaryDirectory(prefix="ocr-v4-tesseract-") as temporary:
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
