from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import random
import struct
import unicodedata

import numpy as np
import torch

from model import CLASS, HEIGHT, PADDING, STRIDE, normalize


@dataclass(frozen=True, slots=True)
class Line:
    offset: int
    width: int
    height: int
    text: str
    glyphs: tuple = ()
    binary: bool = False


def read_exact(file, length):
    data = file.read(length)
    if len(data) != length:
        raise ValueError(f"truncated record in {file.name}")
    return data


def records(path, align=False):
    with path.open("rb") as file:
        magic = read_exact(file, 4)
        if magic == b"OCRL":
            if read_exact(file, 4) != b"\x01\0\0\0":
                raise ValueError(f"unknown OCRL version in {path}")
            while header := file.read(8):
                width, height, text_size = struct.unpack("<HHI", header)
                if not (0 < width <= 4096 and 0 < height <= 512 and 0 < text_size <= 65536):
                    raise ValueError(f"invalid OCRL record in {path}")
                offset = file.tell()
                file.seek(width * height, 1)
                yield Line(offset, width, height, read_exact(file, text_size).decode("utf-8"))
        elif magic == b"OCRT":
            count, = struct.unpack("<I", read_exact(file, 4))
            for _ in range(count):
                width, height, _, _, words, glyphs = struct.unpack("<IIffII", read_exact(file, 24))
                offset = file.tell()
                file.seek(width * height, 1)
                labels = []
                positions = []
                for index in range(words + glyphs):
                    left, _, right, _, length = struct.unpack("<IIIII", read_exact(file, 20))
                    label = read_exact(file, length)
                    if index < words:
                        labels.append(label.decode("utf-8"))
                    elif align:
                        positions.append(((left + right) // 2, label.decode("utf-8")))
                yield Line(offset, width, height, " ".join(labels), tuple(positions), binary=True)
            if file.read(1):
                raise ValueError(f"trailing OCRT record in {path}")
        else:
            raise ValueError(f"unknown archive in {path}")


def record_text(text):
    return " ".join(unicodedata.normalize("NFC", text).split())


def manifest(files):
    result = hashlib.sha256()
    for source, paths in files:
        for path in paths:
            with path.open("rb") as file:
                digest = hashlib.file_digest(file, "sha256").digest()
            result.update(source.encode("ascii") + b"\0" + digest)
    return result.hexdigest()


class Archive:
    def __init__(self, paths, training=False, align=False):
        self.paths = paths
        self.training = training
        self.align = align
        self.samples = []
        self.files = OrderedDict()
        self.rejected = 0
        for source, path in enumerate(paths):
            for line in records(path, align):
                text = record_text(line.text)
                if training and (not text or any(char not in CLASS for char in text)):
                    self.rejected += 1
                    continue
                if align and "".join(label for _, label in line.glyphs) != text.replace(" ", ""):
                    self.rejected += 1
                    continue
                self.samples.append((source, Line(line.offset, line.width, line.height, text,
                                                  line.glyphs, line.binary)))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, request):
        index, seed, strength = request
        source, line = self.samples[index]
        file = self.files.get(source)
        if file is None:
            if len(self.files) == 24:
                _, oldest = self.files.popitem(last=False)
                oldest.close()
            file = self.paths[source].open("rb")
            self.files[source] = file
        self.files.move_to_end(source)
        file.seek(line.offset)
        image = raster(file, line)
        if strength:
            image = augment(image, np.random.default_rng(seed), strength)
        if self.align:
            frames, geometry = normalize(image, geometry=True)
            alignment = aligned_targets(line, frames, geometry)
        else:
            frames = normalize(image)
            alignment = None
        target = [CLASS[char] for char in line.text] if self.training else []
        if self.training and len(target) + sum(a == b for a, b in zip(target, target[1:])) > len(frames):
            return None
        return frames, target, line.text, alignment


def raster(file, line):
    image = np.frombuffer(read_exact(file, line.width * line.height), dtype=np.uint8).reshape(
        line.height, line.width
    )
    return np.where(image != 0, 0, 255).astype(np.uint8) if line.binary else image


def aligned_targets(line, frames, geometry):
    labels = np.zeros(len(frames), dtype=np.int64)
    if geometry is None:
        return labels
    left, width, scaled = geometry
    glyphs = iter(line.glyphs)
    previous = left
    following = next(glyphs)
    for char in line.text:
        if char == " ":
            x = (previous + following[0]) // 2
        else:
            x = following[0]
            previous = x
            following = next(glyphs, following)
        column = PADDING + (x - left) * scaled // width
        index = max(0, min(len(labels) - 1, column // STRIDE))
        if char != " " or labels[index] == 0:
            labels[index] = CLASS[char]
    return labels


class Crops:
    def __init__(self, directory):
        self.paths = sorted(directory.glob("*.json"))

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, request):
        index, _, _ = request
        path = self.paths[index]
        label = json.loads(path.read_text())
        return normalize(pgm(path.with_suffix(".pgm"))), [], record_text(label["text"]), None


def pgm(path):
    data = path.read_bytes()
    cursor = 0
    tokens = []
    while len(tokens) < 4:
        while cursor < len(data) and data[cursor] in b" \t\r\n":
            cursor += 1
        if data[cursor:cursor + 1] == b"#":
            cursor = data.index(b"\n", cursor) + 1
            continue
        start = cursor
        while cursor < len(data) and data[cursor] not in b" \t\r\n":
            cursor += 1
        if cursor == start:
            raise ValueError(f"invalid PGM header in {path}")
        tokens.append(data[start:cursor])
    magic, width, height, maximum = tokens
    if magic != b"P5" or maximum != b"255" or cursor == len(data):
        raise ValueError(f"unsupported PGM in {path}")
    cursor += 2 if data[cursor:cursor + 2] == b"\r\n" else 1
    return np.frombuffer(data, dtype=np.uint8, offset=cursor).reshape(int(height), int(width))


def augment(gray, rng, strength):
    values = gray.astype(np.float32)
    if rng.random() < 0.4 * strength:
        padded = np.pad(values, ((0, 0), (1, 1)), mode="edge")
        blend = rng.uniform(0.07, 0.23) * strength
        values = (1 - 2 * blend) * values + blend * (padded[:, :-2] + padded[:, 2:])
    values = (values - 255) * rng.uniform(1 - 0.18 * strength, 1 + 0.23 * strength) + 255
    values += rng.normal(0, 1.2 * strength, size=values.shape)
    if rng.random() < 0.25 * strength:
        return np.where(values < rng.integers(112, 161), 0, 255).astype(np.uint8)
    return values.clip(0, 255).astype(np.uint8)


def batches(dataset, batch_size, seed, strength, limit=0, epoch=0):
    order = list(range(len(dataset)))
    if limit:
        count = limit * batch_size
        offset = (epoch * count) % len(order)
        random.Random(seed).shuffle(order)
        order = (order[offset:] + order[:offset])[:count]
    else:
        random.Random(seed + epoch).shuffle(order)
    rng = random.Random(seed + epoch)
    for start in range(0, len(order), batch_size * 16):
        block = order[start:start + batch_size * 16]
        if isinstance(dataset, Archive):
            block.sort(key=lambda index: dataset.samples[index][1].width * 32 //
                       dataset.samples[index][1].height)
        groups = [block[i:i + batch_size] for i in range(0, len(block), batch_size)]
        rng.shuffle(groups)
        for group in groups:
            yield [(index, rng.getrandbits(64), strength) for index in group]


def collate(samples):
    usable = [sample for sample in samples if sample is not None]
    if not usable:
        return None
    lengths = [len(frames) for frames, _, _, _ in usable]
    features = np.zeros((len(usable), HEIGHT * STRIDE, max(lengths)), dtype=np.float32)
    alignments = np.full((len(usable), max(lengths)), -100, dtype=np.int64)
    for index, (frames, _, _, alignment) in enumerate(usable):
        features[index, :, :len(frames)] = frames.T
        if alignment is not None:
            alignments[index, :len(frames)] = alignment
    return (
        torch.from_numpy(features),
        torch.tensor(lengths, dtype=torch.int32),
        torch.tensor([char for _, target, _, _ in usable for char in target], dtype=torch.int32),
        torch.tensor([len(target) for _, target, _, _ in usable], dtype=torch.int32),
        [text for _, _, text, _ in usable],
        torch.from_numpy(alignments),
    )


def dataset(path):
    return Crops(path) if path.is_dir() else Archive([path])
