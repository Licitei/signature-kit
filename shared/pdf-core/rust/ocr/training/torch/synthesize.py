import argparse
from collections import Counter, deque
import json
from pathlib import Path
import random
import struct

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

from data import record_text, records
from model import CLASS


DPI_SIZES = (16, 19, 22, 27, 30, 34, 38, 42, 48, 56)


def candidate_lines(roster):
    counts = Counter()
    unique = {}
    for path in roster:
        for line in records(path):
            text = record_text(line.text)
            if not 8 <= len(text) <= 105 or any(char not in CLASS for char in text):
                continue
            symbols = frozenset(map(ord, text))
            counts.update(symbols)
            unique.setdefault(text, symbols)
    return counts, unique


def coverages(paths):
    for path in paths:
        with TTFont(path, lazy=True, fontNumber=0) as font:
            yield path, set(font.getBestCmap() or ())


def record(font, text):
    left, top, right, bottom = font.getbbox(text)
    image = Image.new("L", (right - left + 8, bottom - top + 8), 255)
    ImageDraw.Draw(image).text((4 - left, 4 - top), text, font=font, fill=0)
    label = text.encode("utf-8")
    return struct.pack("<HHI", image.width, image.height, len(label)) + image.tobytes() + label


def render(args):
    rng = random.Random(args.seed)
    roster = [Path(path) for path in args.shards.read_text().splitlines() if path]
    local_fonts = [Path(path) for path in args.fonts.read_text().splitlines() if path]
    fonts = [(path, cmap) for path, cmap in coverages(dict.fromkeys(local_fonts)) if cmap]
    if not fonts:
        raise ValueError("no usable local fonts")
    counts, lines = candidate_lines(roster)
    order = sorted(lines, key=lambda text: -min(counts[symbol] for symbol in lines[text]) ** 0.3
                   * rng.expovariate(1), reverse=True)

    args.output.mkdir(parents=True, exist_ok=False)
    candidates = deque((text, None) for text in order)

    remaining = args.count
    rendered = []
    cache = {}
    while remaining and candidates:
        shard = args.output / f"rare-{len(rendered):05}.ocrl"
        limit = min(4096, remaining)
        count = 0
        with shard.open("xb") as output:
            output.write(b"OCRL\x01\0\0\0")
            while count < limit and candidates:
                text, choices = candidates.popleft()
                if choices is None:
                    choices = [(path, size) for path, cmap in fonts if lines[text] <= cmap
                               for size in DPI_SIZES]
                    rng.shuffle(choices)
                if not choices:
                    continue
                path, size = choices.pop()
                selected = (path, size)
                if selected not in cache:
                    cache[selected] = ImageFont.truetype(str(path), size)
                output.write(record(cache[selected], text))
                count += 1
                if choices:
                    candidates.append((text, choices))
            remaining -= count
        rendered.append(shard.resolve())
        print(json.dumps(dict(shard=shard.name, lines=count, remaining=remaining)), flush=True)
    if remaining:
        raise ValueError(f"compatible text/font/size combinations exhausted with {remaining} renders left")
    (args.output / "shards.txt").write_text("".join(f"{name}\n" for name in rendered))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--shards", type=Path, required=True)
    parser.add_argument("--fonts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, required=True)
    parser.add_argument("--seed", type=int, default=7291)
    options = parser.parse_args()
    if options.count <= 0:
        parser.error("--count must be positive")
    render(options)
