import struct

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from model import (
    ACTIVATION_UNIT, HEIGHT, LABELS, LOGIT_UNIT, STRIDE, integer_layer,
    normalize as pack, quantize,
)


WIDTH = 384
LOCAL = 64
ARCHITECTURES = {1: (8, 64, (1, 2, 4, 8)), 2: (16, 64, (1, 2, 4)), 3: (32, 32, (1, 3))}
SLOPES = (0, -16, 16, -32, 32, -48, 48, -64, 64, -80, 80, -96, 96)


def normalize(gray, *, geometry=False):
    height, width = gray.shape
    samples = gray[::4, ::4].flatten()
    middle = samples.size // 2
    paper = int(np.partition(samples, middle)[middle])
    cutoff = max(72, min(196, paper - 43))
    if width >= 80:
        y, x = np.nonzero(gray[:, 1::4] < cutoff)
        x = 4 * x + 1 - width // 2
        best_score = -1
        best = 0
        if y.size >= 16:
            for slope in SLOPES:
                offsets = x * slope
                levels = y - np.sign(offsets) * ((np.abs(offsets) + 1024) // 2048)
                projection = np.bincount(levels - levels.min())
                score = int(projection @ projection)
                if score > best_score:
                    best_score = score
                    best = slope
        if best:
            offsets = (np.arange(width) - width // 2) * best
            shifts = np.sign(offsets) * ((np.abs(offsets) + 1024) // 2048)
            pad = int(np.abs(shifts).max())
            source = np.arange(-pad, height + pad)[:, None] + shifts
            gray = np.where((source >= 0) & (source < height),
                            gray[source.clip(0, height - 1), np.arange(width)], paper)
    return pack(gray, geometry=geometry, cutoff=cutoff, paper=paper)


class Recognizer(nn.Module):
    def __init__(self, architecture):
        super().__init__()
        self.architecture = architecture
        self.group, self.phase, dilations = ARCHITECTURES[architecture]
        self.stem = nn.Conv1d(HEIGHT * STRIDE, LOCAL, 1)
        self.local = nn.Conv1d(LOCAL, LOCAL, 3, padding=1, groups=4)
        self.down = nn.Conv1d(self.group * self.phase, WIDTH, 1)
        self.temporal = nn.ModuleList(
            nn.ModuleList((
                nn.Conv1d(WIDTH, WIDTH, 3, padding=dilation, dilation=dilation, groups=WIDTH),
                nn.Conv1d(WIDTH, WIDTH, 1),
            ))
            for dilation in dilations
        )
        self.up = nn.Conv1d(WIDTH, self.group * self.phase, 1)
        self.head = nn.Conv1d(LOCAL, len(LABELS), 1)

    def forward(self, frames, lengths, mode="float"):
        def layer(kernel, inputs, input_unit=ACTIVATION_UNIT, output_unit=ACTIVATION_UNIT,
                  activate=True):
            if mode != "int8":
                floating = kernel(inputs)
                if activate:
                    floating = floating.clamp(0, 127 / output_unit)
            if mode == "float":
                return floating
            fixed = integer_layer(kernel, inputs, input_unit, output_unit, activate)
            return fixed if mode == "int8" else fixed.detach() + (floating - floating.detach())

        batch, _, frames_count = frames.shape
        valid = torch.arange(frames_count, device=frames.device)[None, :] < lengths[:, None]
        valid = valid[:, None, :]
        fine = layer(self.stem, frames / 128, input_unit=128) * valid
        fine = (fine + layer(self.local, fine)).clamp(0, 127 / ACTIVATION_UNIT) * valid
        coarse_count = (frames_count + self.group - 1) // self.group
        grouped = F.pad(fine[:, :self.phase].transpose(1, 2), (0, 0, 0, coarse_count * self.group - frames_count))
        grouped = grouped.reshape(batch, coarse_count, self.group * self.phase).transpose(1, 2)
        coarse_valid = valid[:, :, ::self.group]
        coarse = layer(self.down, grouped) * coarse_valid
        for depthwise, mixer in self.temporal:
            context = layer(depthwise, coarse) * coarse_valid
            coarse = (coarse + layer(mixer, context)).clamp(0, 127 / ACTIVATION_UNIT) * coarse_valid
        expanded = layer(self.up, coarse).transpose(1, 2).reshape(batch, -1, self.phase)
        decoded = (fine[:, :self.phase] + expanded[:, :frames_count, :].transpose(1, 2)).clamp(
            0, 127 / ACTIVATION_UNIT
        )
        decoded = torch.cat((decoded, fine[:, self.phase:]), dim=1)
        return layer(self.head, decoded, output_unit=LOGIT_UNIT, activate=False)

    @torch.no_grad()
    def table(self, manifest, commit, seed):
        chunks = [
            struct.pack("<4sHH32s20sQH", b"OCR5", 1, self.architecture, bytes.fromhex(manifest),
                        bytes.fromhex(commit), seed, len(LABELS)),
            struct.pack(f"<{len(LABELS)}I", *map(ord, LABELS)),
        ]
        layers = (self.stem, self.local, self.down, *(layer for block in self.temporal for layer in
                  block), self.up, self.head)
        for layer in layers:
            weights, biases, shifts = quantize(
                layer, 128 if layer is self.stem else ACTIVATION_UNIT,
                LOGIT_UNIT if layer is self.head else ACTIVATION_UNIT,
            )
            for row, bias, shift in zip(weights, biases, shifts, strict=True):
                chunks.append(struct.pack("<hB", int(bias), int(shift)))
                chunks.append(row.transpose(0, 1).contiguous().numpy().astype(np.int8).tobytes())
        return b"".join(chunks)
