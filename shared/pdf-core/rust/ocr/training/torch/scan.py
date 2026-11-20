import json
import math
from pathlib import Path
import struct
import subprocess

import numpy as np


class Scan:
    def __init__(self, binary):
        self.profile_path = Path(__file__).parents[4] / "bench/ocr/scan-profile-v1.json"
        self.profiles = json.loads(self.profile_path.read_text())["profiles"]
        self.binary = binary
        self.worker = None

    def __call__(self, image, rng, strength):
        if rng.random() >= strength:
            return image
        profile = self.profiles[int(rng.integers(len(self.profiles)))]
        angle = profile["skewDegrees"] * rng.choice((-1, 1))
        height, width = image.shape
        pad = 2 + math.ceil(abs(math.sin(math.radians(angle))) * width / 2)
        image = np.pad(image, ((pad, pad), (2, 2)), constant_values=255)
        height, width = image.shape
        if self.worker is None:
            self.worker = subprocess.Popen([self.binary, "--line-stream"], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE)
        header = struct.pack(
            "<HHI9dbBB", width, height, int(rng.integers(2 ** 32)), angle, 0,
            profile["blurSigma"], profile["sensorNoise"], profile["saltAndPepper"],
            profile["brightness"], profile["contrast"], 1, profile["illumination"],
            profile["inkMorphology"], profile["bilevelThreshold"], profile["jpegQuality"],
        )
        self.worker.stdin.write(header + image.tobytes())
        self.worker.stdin.flush()
        pixels = self.worker.stdout.read(width * height)
        if len(pixels) != width * height:
            raise RuntimeError("scan degradation worker ended before producing a full line")
        return np.frombuffer(pixels, dtype=np.uint8).reshape(height, width)
