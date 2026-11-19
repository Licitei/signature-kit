use core::array;

use crate::model::{Metrics, coordinate};
use crate::network::{nearest, quantize};
use crate::raster::Bits;

#[cfg(not(feature = "ctc-wide"))]
pub(crate) const MAGIC: &[u8; 4] = b"OCRS";
#[cfg(feature = "ctc-wide")]
pub(crate) const MAGIC: &[u8; 4] = b"OCRW";
pub(crate) const INPUT: usize = 32;
#[cfg(not(feature = "ctc-wide"))]
pub(crate) const CHANNELS: usize = 16;
#[cfg(feature = "ctc-wide")]
pub(crate) const CHANNELS: usize = 32;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) const SCALES: [f32; 4] = [64.0, 16.0, 16.0, 16.0];
#[cfg(not(feature = "ctc-wide"))]
pub(crate) const NEGATIVE_SLOPE: f32 = 0.0;
#[cfg(feature = "ctc-wide")]
pub(crate) const NEGATIVE_SLOPE: f32 = 0.125;
pub(crate) const KERNELS: [(usize, usize); 4] = [(5, 1), (3, 3), (3, 8), (1, 1)];

#[derive(Clone, Copy)]
pub(crate) struct Geometry {
    pub(crate) bbox: [u32; 4],
    pub(crate) metrics: Metrics,
}

#[derive(Clone, Copy)]
pub(crate) struct Frame {
    center: f32,
    stretch: f32,
}

impl Frame {
    pub(crate) fn position(self) -> u32 {
        nearest(self.center)
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Layer<'model> {
    bias_and_weights: &'model [u8],
    scale: f32,
}

#[derive(Clone, Copy)]
pub(crate) struct Sequence<'model> {
    classes: &'model [[u8; 4]],
    layers: [Layer<'model>; 4],
}

#[derive(Default)]
pub(crate) struct Scratch {
    features: Vec<[i8; INPUT]>,
    first: Vec<[i8; CHANNELS]>,
    frames: Vec<Frame>,
    second: Vec<[i8; CHANNELS]>,
    third: Vec<[i8; CHANNELS]>,
}

#[cfg(all(target_arch = "wasm32", feature = "ctc-probe"))]
impl Scratch {
    pub(crate) fn for_page(width: u32) -> Self {
        let capacity = usize::try_from(width.saturating_mul(2).min(0x8000)).unwrap_or_default();
        Self {
            features: Vec::with_capacity(capacity),
            first: Vec::with_capacity(capacity),
            frames: Vec::with_capacity(capacity),
            second: Vec::with_capacity(capacity),
            third: Vec::with_capacity(capacity),
        }
    }
}

impl<'model> Sequence<'model> {
    pub(crate) fn decode(bytes: &'model [u8]) -> Option<Self> {
        let header = bytes.strip_prefix(MAGIC)?.get(16..)?;
        let (count_bytes, tail) = header.split_first_chunk::<4>()?;
        let count = usize::try_from(u32::from_le_bytes(*count_bytes)).ok()?;
        if !(2..=512).contains(&count) {
            return None;
        }
        let (labels, layers) = tail.split_at_checked(count.checked_mul(4)?)?;
        let (first, rest) = decode_layer(layers, INPUT, 5, CHANNELS)?;
        let (second, rest_after_second) = decode_layer(rest, CHANNELS, 3, CHANNELS)?;
        let (third, rest_after_third) = decode_layer(rest_after_second, CHANNELS, 3, CHANNELS)?;
        let (output, []) = decode_layer(rest_after_third, CHANNELS, 1, count)? else {
            return None;
        };
        Some(Self {
            classes: labels.as_chunks().0,
            layers: [first, second, third, output],
        })
    }

    pub(crate) fn predict<Observe>(
        self,
        page: &Bits,
        geometry: Geometry,
        scratch: &mut Scratch,
        mut observe: Observe,
    ) where
        Observe: FnMut(u32, char, f32),
    {
        frames(geometry, &mut scratch.frames);
        scratch.features.clear();
        scratch.features.extend(
            scratch
                .frames
                .iter()
                .map(|&frame| pixels(page, geometry, frame)),
        );
        let [first, second, third, output] = self.layers;
        let [first_spec, second_spec, third_spec, _] = KERNELS;
        convolve(first, first_spec, &scratch.features, &mut scratch.first);
        convolve(second, second_spec, &scratch.first, &mut scratch.second);
        convolve(third, third_spec, &scratch.second, &mut scratch.third);
        let mut last = '\0';
        for (&frame, window) in scratch.frames.iter().zip(&scratch.third) {
            let (label, margin) = winner(output, self.classes, window);
            if label != '\0' && label != last {
                observe(frame.position(), label, margin);
            }
            last = label;
        }
    }
}

fn decode_layer(
    bytes: &[u8],
    channels: usize,
    kernel: usize,
    outputs: usize,
) -> Option<(Layer<'_>, &[u8])> {
    let (scale_bytes, data) = bytes.split_first_chunk::<4>()?;
    let scale = f32::from_le_bytes(*scale_bytes);
    let size = channels
        .checked_mul(kernel)?
        .checked_add(4)?
        .checked_mul(outputs)?;
    let (bias_and_weights, rest) = data.split_at_checked(size)?;
    (scale.is_finite() && scale > 0.0).then_some((
        Layer {
            bias_and_weights,
            scale,
        },
        rest,
    ))
}

pub(crate) fn frames(geometry: Geometry, output: &mut Vec<Frame>) {
    output.clear();
    let [left, _, right, _] = geometry.bbox;
    let height = geometry.metrics.x_height.max(1.0);
    let stretch = (height / 12.0).max(0.5);
    let mut center = coordinate(left) + stretch * 0.5;
    while center < coordinate(right) && output.len() < 0x8000 {
        output.push(Frame { center, stretch });
        center += stretch;
    }
}

pub(crate) fn pixels(page: &Bits, geometry: Geometry, frame: Frame) -> [i8; INPUT] {
    let [left, top, right, bottom] = geometry.bbox;
    let height = geometry.metrics.x_height.max(1.0);
    let start = geometry.metrics.baseline - 1.9 * height;
    let vertical_step = 2.4 * height / 32.0;
    array::from_fn(|index| {
        let row = f32::from(u16::try_from(index).unwrap_or_default());
        let yyyy = start + row * vertical_step - 0.5;
        let xxxx = frame.center - 0.5;
        let mut count = 0_i8;
        for y_position in [yyyy + 0.25 * vertical_step, yyyy + 0.75 * vertical_step] {
            let y_pixel = nearest(y_position);
            if !(top..bottom).contains(&y_pixel) {
                continue;
            }
            for position in [xxxx - frame.stretch * 0.25, xxxx + frame.stretch * 0.25] {
                let x_pixel = nearest(position);
                if (left..right).contains(&x_pixel) && page.get(x_pixel, y_pixel) {
                    count = count.saturating_add(16);
                }
            }
        }
        count
    })
}

pub(crate) fn tap(frame: usize, tap_index: usize, size: usize, dilation: usize) -> Option<usize> {
    let offset = tap_index.saturating_mul(dilation);
    frame
        .checked_add(offset)?
        .checked_sub((size >> 1).saturating_mul(dilation))
}

pub(crate) fn activate(value: f32) -> f32 {
    if value < 0.0 {
        (value * NEGATIVE_SLOPE).max(-7.9)
    } else {
        value.min(7.9)
    }
}

fn convolve<const WIDTH: usize>(
    layer: Layer<'_>,
    (size, dilation): (usize, usize),
    input: &[[i8; WIDTH]],
    output: &mut Vec<[i8; CHANNELS]>,
) {
    output.clear();
    let record = WIDTH.saturating_mul(size).saturating_add(4);
    for (frame, _) in input.iter().enumerate() {
        let mut values = [0_i8; CHANNELS];
        for (activation, row) in values
            .iter_mut()
            .zip(layer.bias_and_weights.chunks_exact(record))
        {
            let Some((bias, weights)) = row.split_first_chunk::<4>() else {
                break;
            };
            let mut sum = 0_i32;
            for (tap_index, kernel) in weights.as_chunks::<WIDTH>().0.iter().enumerate() {
                if let Some(window) =
                    tap(frame, tap_index, size, dilation).and_then(|index| input.get(index))
                {
                    sum = sum.wrapping_add(dot(window, kernel));
                }
            }
            let value = signed(sum) * layer.scale + f32::from_le_bytes(*bias);
            let magnitude =
                i8::try_from(quantize(activate(value).abs(), 16.0).min(127)).unwrap_or_default();
            *activation = if value < 0.0 {
                magnitude.saturating_neg()
            } else {
                magnitude
            };
        }
        output.push(values);
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn dot<const WIDTH: usize>(input: &[i8; WIDTH], weights: &[u8; WIDTH]) -> i32 {
    input
        .iter()
        .zip(weights)
        .fold(0_i32, |sum, (&feature, &weight)| {
            let signed_weight = i8::from_le_bytes([weight]);
            sum.wrapping_add(i32::from(feature).wrapping_mul(i32::from(signed_weight)))
        })
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[expect(
    unsafe_code,
    reason = "full 16-byte records are valid unaligned wasm SIMD inputs"
)]
fn dot<const WIDTH: usize>(input: &[i8; WIDTH], weights: &[u8; WIDTH]) -> i32 {
    use core::arch::wasm32::{
        i16x8_extmul_high_i8x16, i16x8_extmul_low_i8x16, i32x4_add, i32x4_extadd_pairwise_i16x8,
        i32x4_extract_lane, i32x4_splat, v128_load,
    };
    let mut sums = i32x4_splat(0);
    for (features, kernel) in input
        .as_chunks::<16>()
        .0
        .iter()
        .zip(weights.as_chunks::<16>().0)
    {
        // SAFETY: Both arguments point to initialized arrays of exactly 16 bytes.
        let lhs = unsafe { v128_load(features.as_ptr().cast()) };
        // SAFETY: The weight table contains an initialized 16-byte record.
        let rhs = unsafe { v128_load(kernel.as_ptr().cast()) };
        let low = i32x4_extadd_pairwise_i16x8(i16x8_extmul_low_i8x16(lhs, rhs));
        let high = i32x4_extadd_pairwise_i16x8(i16x8_extmul_high_i8x16(lhs, rhs));
        sums = i32x4_add(sums, i32x4_add(low, high));
    }
    i32x4_extract_lane::<0>(sums)
        .wrapping_add(i32x4_extract_lane::<1>(sums))
        .wrapping_add(i32x4_extract_lane::<2>(sums))
        .wrapping_add(i32x4_extract_lane::<3>(sums))
}

fn signed(value: i32) -> f32 {
    let absolute = coordinate(value.unsigned_abs());
    if value < 0 { -absolute } else { absolute }
}

fn winner(layer: Layer<'_>, labels: &[[u8; 4]], window: &[i8; CHANNELS]) -> (char, f32) {
    let mut label = '\0';
    let mut first = f32::NEG_INFINITY;
    let mut second = f32::NEG_INFINITY;
    let (rows, _) = layer.bias_and_weights.as_chunks::<{ CHANNELS + 4 }>();
    for (codepoint, row) in labels.iter().zip(rows) {
        let Some((bias, kernel)) = row.split_first_chunk::<4>() else {
            break;
        };
        let Ok(weights) = kernel.try_into() else {
            break;
        };
        let score = signed(dot(window, weights)) * layer.scale + f32::from_le_bytes(*bias);
        if score > first {
            second = first;
            first = score;
            label = char::from_u32(u32::from_le_bytes(*codepoint)).unwrap_or('\0');
        } else if score > second {
            second = score;
        }
    }
    (label, ((first - second) / 6.0).clamp(0.0, 1.0))
}
