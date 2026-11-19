import type { Raster } from "./degradation";

export const trainingLineHeader = "OCRL\x01\x00\x00\x00";
const background = 255;

export function mix(value: number) {
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function augment(
  raster: Raster,
  left: number,
  top: number,
  right: number,
  bottom: number,
  label: Uint8Array,
  sampleSeed: number,
) {
  let state = mix(sampleSeed) || 1;
  const strength = (state & 15) / 15;
  const slope = (((state >>> 4) % 31) - 15) / 1000;
  const scale = (22 + ((state >>> 9) & 7)) / (bottom - top);
  const innerWidth = Math.max(1, Math.min(1024, Math.round((right - left) * scale)));
  const innerHeight = Math.round((bottom - top) * scale);
  const marginY = Math.ceil((Math.abs(slope) * innerWidth) / 2) + 2;
  const width = innerWidth + 8;
  const height = innerHeight + 2 * marginY;
  const record = new Uint8Array(8 + width * height + label.length);
  const header = new DataView(record.buffer, 0, 8);
  header.setUint16(0, width, true);
  header.setUint16(2, height, true);
  header.setUint32(4, label.length, true);
  record.set(label, 8 + width * height);
  const gain = 0.8 + strength * 0.3;
  const offset = ((state >>> 13) % 19) - 13;
  const blur = (state >>> 18) & 1;
  const bilevel = ((state >>> 19) & 7) === 0;
  const xScale = (right - left) / innerWidth;
  const yScale = (bottom - top) / innerHeight;
  const columns = Int32Array.from({ length: width }, (_, x) =>
    x < 4 || x >= width - 4 ? -1 : left + Math.floor((x - 3.5) * xScale),
  );
  const shifts = Int32Array.from({ length: width }, (_, x) =>
    Math.round((x - width / 2) * slope * yScale),
  );
  let target = 8;
  for (let y = 0; y < height; y += 1) {
    const sourceY = top + Math.floor((y - marginY + 0.5) * yScale);
    for (let x = 0; x < width; x += 1) {
      const sourceX = columns[x] ?? -1;
      const shiftedY = sourceY - (shifts[x] ?? 0);
      let value = background;
      if (sourceX >= left && shiftedY >= top && shiftedY < bottom) {
        const source = shiftedY * raster.width + sourceX;
        value = raster.pixels[source] ?? background;
        if (blur !== 0) {
          value =
            (2 * value +
              (raster.pixels[Math.max(source - 1, shiftedY * raster.width)] ?? background) +
              (raster.pixels[sourceX + 1 < raster.width ? source + 1 : source] ?? background)) /
            4;
        }
      }
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      value = (value - 128) * gain + 128 + offset + ((state & 7) - 3) * strength;
      record[target] = bilevel ? (value >= 165 ? 255 : 0) : clamp(Math.round(value), 0, 255);
      target += 1;
    }
  }
  return record;
}
