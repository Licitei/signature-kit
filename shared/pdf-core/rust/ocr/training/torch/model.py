from pathlib import Path
import struct

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F


HEIGHT = 32
INK_HEIGHT = 26
PADDING = 3
STRIDE = 4
MAX_FRAMES = 1024
CHANNELS = 64
GROUPS = 4
DILATIONS = (1, 3, 9)
ACTIVATION_UNIT = 32
LOGIT_UNIT = 256
LABELS = ("\0",) + tuple(
    chr(int(code, 16)) for code in Path(__file__).with_name("charset.txt").read_text().split()
)
CLASS = {char: index for index, char in enumerate(LABELS)}


def normalize(gray, *, geometry=False, cutoff=128, paper=255):
    ink = gray < cutoff
    rows = np.flatnonzero(ink.any(axis=1))
    cols = np.flatnonzero(ink.any(axis=0))
    if not rows.size:
        blank = np.zeros((1, HEIGHT * STRIDE), dtype=np.int8)
        return (blank, None) if geometry else blank

    source = gray[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    height, width = source.shape
    scaled = min(MAX_FRAMES * STRIDE - 2 * PADDING,
                 max(1, (width * INK_HEIGHT + height // 2) // height))
    frames = (scaled + 2 * PADDING + STRIDE - 1) // STRIDE
    columns = np.zeros((frames * STRIDE, HEIGHT), dtype=np.int8)
    x = (2 * np.arange(scaled) + 1) * width // (2 * scaled)
    y = (2 * np.arange(INK_HEIGHT) + 1) * height // (2 * INK_HEIGHT)
    columns[PADDING:PADDING + scaled, PADDING:PADDING + INK_HEIGHT] = (
        np.maximum(0, paper - source[y[:, None], x[None, :]].T.astype(np.int16)) >> 1
    )
    normalized = columns.reshape(frames, HEIGHT * STRIDE)
    return (normalized, (int(cols[0]), width, scaled)) if geometry else normalized


def shuffle_channels(values):
    batch, _, frames = values.shape
    return values.reshape(batch, GROUPS, CHANNELS // GROUPS, frames).transpose(1, 2).reshape(
        batch, CHANNELS, frames
    )


def quantize(layer, input_unit, output_unit):
    maximum = layer.weight.detach().flatten(1).abs().amax(dim=1)
    weight_exponent = (maximum.clamp_min(2.0 ** -23) / 127).log2().ceil().int()
    unit_shift = (output_unit.bit_length() - input_unit.bit_length())
    shift = (-weight_exponent - unit_shift).clamp(0, 24)
    multiplier = torch.exp2((shift + unit_shift).float())
    weight = (layer.weight * multiplier[:, None, None]).round().clamp(-127, 127)
    bias = (layer.bias * output_unit).round().clamp(-32768, 32767)
    return weight, bias, shift


def integer_layer(layer, features, input_unit, output_unit, activate):
    weight, bias, shift = quantize(layer, input_unit, output_unit)
    integer_input = (features * input_unit).round()
    sums = F.conv1d(integer_input, weight, padding=layer.padding,
                    dilation=layer.dilation, groups=layer.groups)
    divisor = torch.exp2(shift.float())[None, :, None]
    values = sums.div(divisor).add(0.5).floor().add(bias[None, :, None])
    if activate:
        values = values.clamp(0, 127)
    return values / output_unit


class Recognizer(nn.Module):
    def __init__(self):
        super().__init__()
        self.stem = nn.Conv1d(HEIGHT * STRIDE, CHANNELS, 1)
        self.temporal = nn.ModuleList(
            nn.Conv1d(CHANNELS, CHANNELS, 3, padding=dilation, dilation=dilation, groups=GROUPS)
            for dilation in DILATIONS
        )
        self.head = nn.Conv1d(CHANNELS, len(LABELS), 1)

    def forward(self, frames, lengths, mode="float"):
        valid = torch.arange(frames.shape[-1], device=frames.device)[None, :] < lengths[:, None]
        values = frames / 128
        layers = (self.stem, *self.temporal, self.head)
        for index, layer in enumerate(layers):
            activate = index < len(layers) - 1
            if mode != "int8":
                floating = layer(values)
                if activate:
                    floating = floating.clamp(0, 127 / ACTIVATION_UNIT)
            if mode == "float":
                values = floating
            else:
                fixed = integer_layer(layer, values, 128 if index == 0 else ACTIVATION_UNIT,
                                      ACTIVATION_UNIT if activate else LOGIT_UNIT, activate)
                values = fixed if mode == "int8" else fixed.detach() + (floating - floating.detach())
            if activate:
                values = values * valid[:, None, :]
                if index != 0:
                    values = shuffle_channels(values)
        return values

    @torch.no_grad()
    def table(self, manifest, commit, seed):
        chunks = [
            struct.pack("<4sHH32s20sQH", b"OCR4", 1, 1, bytes.fromhex(manifest),
                        bytes.fromhex(commit), seed, len(LABELS)),
            struct.pack(f"<{len(LABELS)}I", *map(ord, LABELS)),
        ]
        layers = (self.stem, *self.temporal, self.head)
        for index, layer in enumerate(layers):
            weight, bias, shift = quantize(layer, 128 if index == 0 else ACTIVATION_UNIT,
                                           LOGIT_UNIT if layer is self.head else ACTIVATION_UNIT)
            for row, offset, right_shift in zip(weight, bias, shift, strict=True):
                chunks.append(struct.pack("<hB", int(offset), int(right_shift)))
                chunks.append(row.transpose(0, 1).contiguous().numpy().astype(np.int8).tobytes())
        return b"".join(chunks)


def transcript(classes):
    output = []
    previous = 0
    for value in classes:
        index = int(value)
        if index and index != previous:
            output.append(LABELS[index])
        previous = index
    return " ".join("".join(output).split())
