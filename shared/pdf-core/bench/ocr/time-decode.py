#!/usr/bin/env python3
"""Median JPEG decode time from `pdf-core-ocr --timings --layout-only`.

Usage: time-decode.py <pdf-core-ocr> <jpeg-or-directory> [runs]
"""

import sys
from pathlib import Path
from subprocess import run


def decode_ms(binary: Path, image: Path) -> float:
    result = run(
        [str(binary), str(image), "--timings", "--layout-only"],
        check=True,
        capture_output=True,
        text=True,
    )
    for line in result.stderr.splitlines():
        if line.startswith("Decode "):
            return float(line.split()[1])
    message = f"no Decode timing for {image}"
    raise SystemExit(message)


def images(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    found = sorted(path.glob("*.jpg")) + sorted(path.glob("*.jpeg"))
    if not found:
        message = f"no JPEG files in {path}"
        raise SystemExit(message)
    return found


def main() -> None:
    if len(sys.argv) not in (3, 4):
        message = "Usage: time-decode.py <pdf-core-ocr> <jpeg-or-directory> [runs]"
        raise SystemExit(message)
    binary = Path(sys.argv[1])
    runs = int(sys.argv[3]) if len(sys.argv) == 4 else 5
    if runs < 1:
        message = "runs must be at least 1"
        raise SystemExit(message)
    midpoint = runs // 2
    for image in images(Path(sys.argv[2])):
        samples = sorted(decode_ms(binary, image) for _ in range(runs))
        median = samples[midpoint]
        print(
            f"{median:8.3f} ms  min {samples[0]:.3f} max {samples[-1]:.3f}  {image.name}",
            flush=True,
        )


if __name__ == "__main__":
    main()
