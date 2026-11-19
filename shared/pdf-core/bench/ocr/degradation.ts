import { createHash } from "node:crypto";
import { join } from "node:path";

export type Box = [number, number, number, number];
export type Raster = { width: number; height: number; pixels: Uint8Array<ArrayBuffer> };

export const presets = ["clean", "scan", "photocopy", "jpeg", "fax"];

export function degradation(preset: string, seed: string, id: string) {
  const hash = createHash("sha256")
    .update(JSON.stringify([seed, id, preset]))
    .digest();
  const fraction = (offset: number) => hash.readUInt32LE(offset) / 2 ** 32;
  const photocopy = preset === "photocopy";
  const scan = preset === "scan" || photocopy || preset === "fax";
  return {
    preset,
    seed: hash.readUInt32LE(0),
    skewDegrees: scan ? 6 * fraction(4) - 3 : 0,
    warpPixels: scan ? 3 * fraction(8) : 0,
    blurSigma: scan ? 0.35 + 0.65 * fraction(12) : 0,
    sensorNoise: photocopy ? 11 : scan ? 3 : 0,
    saltAndPepper: photocopy ? 0.012 : scan ? 0.002 : 0,
    brightness: photocopy ? -12 : scan ? 4 : 0,
    contrast: photocopy ? 1.3 : scan ? 0.95 : 1,
    gamma: photocopy ? 1.35 : scan ? 0.9 : 1,
    illumination: photocopy ? 32 : scan ? 12 : 0,
    inkMorphology: photocopy ? (fraction(16) < 0.5 ? -1 : 1) : 0,
    bilevelThreshold: preset === "fax" ? 156 + Math.floor(38 * fraction(20)) : 0,
    jpegQuality: preset === "jpeg" || photocopy ? 30 + Math.floor(61 * fraction(24)) : 0,
  };
}

type Parameters = ReturnType<typeof degradation>;

export function pgm({ width, height, pixels }: Raster): Blob {
  return new Blob([new TextEncoder().encode(`P5\n${width} ${height}\n255\n`), pixels]);
}

export function parsePgm(bytes: Uint8Array<ArrayBuffer>): Raster | undefined {
  const header = /^P5\s+(\d+)\s+(\d+)\s+255\n/.exec(
    new TextDecoder().decode(bytes.subarray(0, 80)),
  );
  if (header === null) return undefined;
  const width = Number(header[1]);
  const height = Number(header[2]);
  const pixels = bytes.subarray(header[0].length);
  if (width < 1 || height < 1 || width * height !== pixels.length) return undefined;
  return { width, height, pixels };
}

export function mapDegradedBox(
  [left, top, right, bottom]: Box,
  raster: Raster,
  params: Parameters,
): Box {
  if (params.skewDegrees === 0 && params.warpPixels === 0) return [left, top, right, bottom];
  const angle = (params.skewDegrees * Math.PI) / 180;
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  const cx = raster.width / 2;
  const cy = raster.height / 2;
  const corners = [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ].map(([x = 0, y = 0]) => {
    const row = sine * (x - cx) + cosine * (y - cy) + cy;
    const shift = params.warpPixels * Math.sin(((row - 0.5) / raster.height) * 2 * Math.PI);
    return { x: cosine * (x - cx) - sine * (y - cy) + cx + shift, y: row };
  });
  const minY = Math.min(...corners.map(({ y }) => y));
  const maxY = Math.max(...corners.map(({ y }) => y));
  const padding = (2 * Math.PI * Math.abs(params.warpPixels) * (maxY - minY)) / raster.height;
  return [
    Math.max(0, Math.floor(Math.min(...corners.map(({ x }) => x)) - padding)),
    Math.max(0, Math.floor(minY)),
    Math.min(raster.width, Math.ceil(Math.max(...corners.map(({ x }) => x)) + padding)),
    Math.min(raster.height, Math.ceil(maxY)),
  ];
}

export async function degrade(raster: Raster, params: Parameters) {
  const binary = join(import.meta.dir, "../../rust/target/release/pdf-core-ocr-synth");
  const argv = [
    params.seed,
    params.skewDegrees,
    params.warpPixels,
    params.blurSigma,
    params.sensorNoise,
    params.saltAndPepper,
    params.brightness,
    params.contrast,
    params.gamma,
    params.illumination,
    params.inkMorphology,
    params.bilevelThreshold,
    params.jpegQuality,
  ].map(String);
  const subprocess = Bun.spawn([binary, ...argv], {
    stdin: pgm(raster),
    stdout: "pipe",
    stderr: "inherit",
  });
  const [bytes, exitCode] = await Promise.all([
    new Response(subprocess.stdout).bytes(),
    subprocess.exited,
  ]);
  if (exitCode !== 0 || bytes.length < 4) return undefined;
  const end = 4 + new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (end > bytes.length || (params.jpegQuality !== 0 && end === bytes.length)) return undefined;
  return {
    pgm: bytes.subarray(4, end),
    jpeg: params.jpegQuality === 0 ? undefined : bytes.subarray(end),
  };
}
