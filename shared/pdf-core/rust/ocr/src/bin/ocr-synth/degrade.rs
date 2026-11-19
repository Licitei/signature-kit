use core::array;
use core::f64::consts::TAU;

use super::Raster;

#[derive(Debug)]
pub(super) struct Params {
    pub(super) angle: f64,
    pub(super) blur: f64,
    pub(super) brightness: f64,
    pub(super) contrast: f64,
    pub(super) gamma: f64,
    pub(super) impulse: f64,
    pub(super) morph: i8,
    pub(super) noise: f64,
    pub(super) seed: u32,
    pub(super) shade: f64,
    pub(super) threshold: u8,
    pub(super) warp: f64,
}

struct Random(u32);

impl Random {
    fn unit(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(self.0 >> 8_u8) / 16_777_216.0_f64
    }
}

#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "sampling clamps unsigned coordinates and intensities first"
)]
const fn index(value: f64) -> usize {
    value as usize
}

fn scalar(value: usize) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

fn tone(value: f64) -> u8 {
    u8::try_from(index(value.round().clamp(0.0_f64, 255.0_f64))).unwrap_or(255)
}

fn resample(raster: &Raster, x: f64, y: f64) -> u8 {
    if x < 0.0_f64
        || y < 0.0_f64
        || x > scalar(raster.width) - 1.0_f64
        || y > scalar(raster.height) - 1.0_f64
    {
        return 255;
    }
    let left = index(x);
    let top = index(y);
    let right = left.saturating_add(1);
    let bottom = top.saturating_add(1);
    let x_mix = x.fract();
    let y_mix = y.fract();
    let mix =
        |first: u8, second: u8| f64::from(first) * (1.0_f64 - x_mix) + f64::from(second) * x_mix;
    tone(
        mix(raster.nearest(left, top), raster.nearest(right, top)) * (1.0_f64 - y_mix)
            + mix(raster.nearest(left, bottom), raster.nearest(right, bottom)) * y_mix,
    )
}

fn warp(raster: &mut Raster, angle: f64, wave: f64) {
    let (sine, cosine) = angle.to_radians().sin_cos();
    let cx = (scalar(raster.width) - 1.0_f64) * 0.5_f64;
    let cy = (scalar(raster.height) - 1.0_f64) * 0.5_f64;
    let mut pixels = vec![255; raster.pixels.len()];
    for (y, row) in pixels.chunks_exact_mut(raster.width).enumerate() {
        let py = scalar(y) - cy;
        let shift = wave * (scalar(y) / scalar(raster.height) * TAU).sin();
        for (x, slot) in row.iter_mut().enumerate() {
            let px = scalar(x) - cx - shift;
            *slot = resample(
                raster,
                cosine * px + sine * py + cx,
                -sine * px + cosine * py + cy,
            );
        }
    }
    raster.pixels = pixels;
}

fn gaussian(raster: &mut Raster, sigma: f64) {
    let radius = index((3.0_f64 * sigma).ceil());
    let kernel: Vec<f64> = (0..=radius)
        .map(|at| {
            let offset = scalar(at);
            (-offset * offset / (2.0_f64 * sigma * sigma)).exp()
        })
        .collect();
    let center = kernel.first().copied().unwrap_or(1.0_f64);
    let total = center + 2.0_f64 * kernel.iter().skip(1).sum::<f64>();
    for vertical in [false, true] {
        let mut pixels = vec![255; raster.pixels.len()];
        for (y, row) in pixels.chunks_exact_mut(raster.width).enumerate() {
            for (x, slot) in row.iter_mut().enumerate() {
                let mut sample = f64::from(raster.nearest(x, y)) * center;
                for (offset, weight) in kernel.iter().copied().enumerate().skip(1) {
                    let (first, second) = if vertical {
                        (
                            raster.nearest(x, y.saturating_sub(offset)),
                            raster.nearest(x, y.saturating_add(offset)),
                        )
                    } else {
                        (
                            raster.nearest(x.saturating_sub(offset), y),
                            raster.nearest(x.saturating_add(offset), y),
                        )
                    };
                    sample += (f64::from(first) + f64::from(second)) * weight;
                }
                *slot = tone(sample / total);
            }
        }
        raster.pixels = pixels;
    }
}

fn morphology(raster: &mut Raster, ink: i8) {
    let mut pixels = vec![255; raster.pixels.len()];
    for (y, row) in pixels.chunks_exact_mut(raster.width).enumerate() {
        for (x, slot) in row.iter_mut().enumerate() {
            let values = [
                raster.nearest(x, y),
                raster.nearest(x.saturating_sub(1), y),
                raster.nearest(x.saturating_add(1), y),
                raster.nearest(x, y.saturating_sub(1)),
                raster.nearest(x, y.saturating_add(1)),
            ];
            let extreme = if ink > 0 {
                values.into_iter().min()
            } else {
                values.into_iter().max()
            };
            *slot = extreme.unwrap_or(255);
        }
    }
    raster.pixels = pixels;
}

fn expose(raster: &mut Raster, params: &Params) {
    let mut random = Random(params.seed);
    let weights: Vec<f64> = (0..raster.width)
        .map(|x| (scalar(x) / scalar(raster.width) * TAU).cos())
        .collect();
    let response: [u8; 256] = array::from_fn(|idx| {
        tone(
            ((scalar(idx) / 255.0_f64).powf(params.gamma) - 0.5_f64) * 255.0_f64 * params.contrast
                + 127.5_f64
                + params.brightness,
        )
    });
    for (y, row) in raster.pixels.chunks_exact_mut(raster.width).enumerate() {
        let slope = scalar(y) / scalar(raster.height) - 0.5_f64;
        for (slot, &weight) in row.iter_mut().zip(&weights) {
            let signal = f64::from(response.get(usize::from(*slot)).copied().unwrap_or(255));
            let jitter = (random.unit() + random.unit() + random.unit() + random.unit() - 2.0_f64)
                * 1.732_f64
                * params.noise;
            let impulse = random.unit();
            let exposed = if impulse < params.impulse * 0.5_f64 {
                0
            } else if impulse < params.impulse {
                255
            } else {
                tone(signal + params.shade * (slope + weight * 0.5_f64) + jitter)
            };
            *slot = if params.threshold == 0 {
                exposed
            } else {
                u8::from(exposed >= params.threshold).saturating_mul(255)
            };
        }
    }
}

pub(super) fn apply(raster: &mut Raster, params: &Params) {
    if params.angle.abs() > f64::EPSILON || params.warp.abs() > f64::EPSILON {
        warp(raster, params.angle, params.warp);
    }
    if params.morph != 0 {
        morphology(raster, params.morph);
    }
    if params.blur > 0.05_f64 {
        gaussian(raster, params.blur);
    }
    expose(raster, params);
}
