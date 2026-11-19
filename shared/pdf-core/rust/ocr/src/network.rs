use core::array;

use crate::model::{Choice, Metrics, UNCLASSIFIED, coordinate, retain_choice};
use crate::raster::Bits;

pub(crate) const MAGIC: &[u8; 4] = b"OCR2";
pub(crate) const GRID: usize = 16;
pub(crate) const INPUTS: usize = GRID.saturating_mul(GRID).saturating_add(4);
pub(crate) const HIDDEN: usize = 48;
pub(crate) const OUTPUT_BYTES: usize = HIDDEN.saturating_add(8);
pub(crate) const UNIT: f32 = 64.0;

#[derive(Clone, Copy, Debug)]
pub(crate) enum Shape {
    Glyph,
    Line,
}

#[derive(Clone, Copy)]
pub(crate) struct Network<'model> {
    hidden_bias: &'model [[u8; 4]; HIDDEN],
    hidden_scale: f32,
    hidden_weights: &'model [[u8; HIDDEN]; INPUTS],
    output_scale: f32,
    outputs: &'model [[u8; OUTPUT_BYTES]],
    pub(crate) shape: Shape,
}

impl<'model> Network<'model> {
    pub(crate) fn classify(self, input: &[u8; INPUTS]) -> [Choice; 4] {
        let mut accumulators = [0_i32; HIDDEN];
        for (&sample, weights) in input.iter().zip(self.hidden_weights) {
            if sample == 0 {
                continue;
            }
            for (sum, &weight) in accumulators.iter_mut().zip(weights) {
                *sum = sum.wrapping_add(i32::from(weight).wrapping_mul(i32::from(sample)));
            }
        }
        let offset = input
            .iter()
            .copied()
            .map(i32::from)
            .sum::<i32>()
            .wrapping_mul(128);
        let hidden = array::from_fn(|index| {
            let sum = accumulators.get(index).copied().unwrap_or_default();
            let bias = self
                .hidden_bias
                .get(index)
                .map_or(0.0, |part| f32::from_le_bytes(*part));
            i32::from(quantize(
                signed(sum.wrapping_sub(offset)) * self.hidden_scale + bias,
                UNIT,
            ))
        });
        self.rank(&hidden)
    }

    pub(crate) fn decode(bytes: &'model [u8]) -> Option<(Self, &'model [u8])> {
        let header = bytes.strip_prefix(MAGIC)?.get(16..)?;
        let (flags, parameter_bytes) = header.split_first_chunk::<16>()?;
        let ([mode, classes, hidden_step, output_step], []) = flags.as_chunks::<4>() else {
            return None;
        };
        let shape = match u32::from_le_bytes(*mode) {
            0 => Shape::Glyph,
            1 => Shape::Line,
            _ => return None,
        };
        let hidden_scale = f32::from_le_bytes(*hidden_step);
        let output_scale = f32::from_le_bytes(*output_step);
        let output_len = usize::try_from(u32::from_le_bytes(*classes))
            .ok()?
            .checked_mul(OUTPUT_BYTES)?;
        if output_len == 0
            || !hidden_scale.is_finite()
            || !output_scale.is_finite()
            || hidden_scale <= 0.0
            || output_scale <= 0.0
        {
            return None;
        }
        let (hidden_bias, rest) = parameter_bytes.split_at_checked(HIDDEN.saturating_mul(4))?;
        let (hidden_weights, tail) = rest.split_at_checked(INPUTS.saturating_mul(HIDDEN))?;
        let (outputs, transitions) = tail.split_at_checked(output_len)?;
        Some((
            Self {
                hidden_bias: hidden_bias.as_chunks::<4>().0.try_into().ok()?,
                hidden_weights: hidden_weights.as_chunks::<HIDDEN>().0.try_into().ok()?,
                hidden_scale,
                outputs: outputs.as_chunks::<OUTPUT_BYTES>().0,
                output_scale,
                shape,
            },
            transitions,
        ))
    }
    fn rank(self, hidden: &[i32; HIDDEN]) -> [Choice; 4] {
        let mut choices = [UNCLASSIFIED; 4];
        let mut rejection = f32::INFINITY;
        let offset = hidden.iter().sum::<i32>().wrapping_mul(128);
        for record in self.outputs {
            let Some((weights, label_and_bias)) = record.split_first_chunk::<HIDDEN>() else {
                break;
            };
            let ([codepoint, bias], []) = label_and_bias.as_chunks::<4>() else {
                break;
            };
            let Some(label) = char::from_u32(u32::from_le_bytes(*codepoint)) else {
                continue;
            };
            let sum = hidden
                .iter()
                .zip(weights)
                .fold(0_i32, |acc, (&value, &weight)| {
                    acc.wrapping_add(value.wrapping_mul(i32::from(weight)))
                });
            let logit =
                signed(sum.wrapping_sub(offset)) * self.output_scale + f32::from_le_bytes(*bias);
            if label == '\0' {
                rejection = -logit;
            } else {
                retain_choice(
                    &mut choices,
                    Choice {
                        distance: -logit,
                        label,
                    },
                );
            }
        }
        let [best, second, _, _] = choices;
        let minimum = best.distance.min(rejection);
        let normalizer = ((minimum - best.distance).exp()
            + (minimum - second.distance).exp()
            + (minimum - rejection).exp())
        .ln();
        for choice in &mut choices {
            choice.distance = 12.0 * (choice.distance - minimum + normalizer);
        }
        choices
    }
}

pub(crate) fn quantize(value: f32, scale: f32) -> u16 {
    let rounded = (value * scale).clamp(0.0, 8192.0) + 8_388_608.0;
    u16::try_from(rounded.to_bits().wrapping_sub(8_388_608.0_f32.to_bits())).unwrap_or_default()
}

fn signed(value: i32) -> f32 {
    let magnitude = value.unsigned_abs();
    let high = u16::try_from(magnitude >> 16_u32).unwrap_or_default();
    let low = u16::try_from(magnitude & 0xffff).unwrap_or_default();
    let absolute = f32::from(high) * 65_536.0 + f32::from(low);
    if value < 0 { -absolute } else { absolute }
}

fn pixel(row: &[u64], column: u32) -> bool {
    let index = usize::try_from(column >> 6_u32).unwrap_or(usize::MAX);
    row.get(index)
        .is_some_and(|word| word & (1_u64 << (column & 63)) != 0)
}

fn nearest(value: f32) -> u32 {
    let rounded = value.round();
    if rounded < 1.0 {
        return 0;
    }
    let bits = rounded.to_bits();
    let precision = ((bits >> 23_u32) & 0xff).saturating_sub(127);
    let mantissa = (bits & 0x007f_ffff) | 0x0080_0000;
    if precision <= 23 {
        mantissa >> 23_u32.saturating_sub(precision)
    } else {
        mantissa
            .checked_shl(precision.saturating_sub(23))
            .unwrap_or(u32::MAX)
    }
}

fn axis(low: f32, high: f32) -> [(u32, u32); GRID] {
    let step = (high - low) / 16.0;
    array::from_fn(|index| {
        let position = low + f32::from(u16::try_from(index).unwrap_or_default()) * step;
        let sample = |phase| nearest(position + step * phase);
        (sample(0.25), sample(0.75))
    })
}

pub(crate) fn inputs(
    page: &Bits,
    [left, top, right, bottom]: [u32; 4],
    metrics: Metrics,
    shape: Shape,
) -> [u8; INPUTS] {
    let mut input = [0_u8; INPUTS];
    let x_height = metrics.x_height.max(1.0);
    let (start, end) = match shape {
        Shape::Glyph => (coordinate(top), coordinate(bottom)),
        Shape::Line => (
            metrics.baseline - 1.65 * x_height,
            metrics.baseline + 0.55 * x_height,
        ),
    };
    let x_samples = axis(coordinate(left) - 0.5, coordinate(right) - 0.5);
    let y_samples = axis(start - 0.5, end - 0.5);
    for (target, (upper, lower)) in input.as_chunks_mut::<GRID>().0.iter_mut().zip(y_samples) {
        let row = |value| {
            if (top..bottom).contains(&value) {
                page.row(value)
            } else {
                &[]
            }
        };
        let rows = [row(upper), row(lower)];
        for (cell, &(first, second)) in target.iter_mut().zip(&x_samples) {
            let mut count = 0_u8;
            for row in rows {
                count = count.saturating_add(
                    u8::from(pixel(row, first)).saturating_add(u8::from(pixel(row, second))),
                );
            }
            *cell = count.saturating_mul(16);
        }
    }
    let width = coordinate(right.saturating_sub(left));
    let height = coordinate(bottom.saturating_sub(top));
    let geometry = [
        width / height.max(1.0),
        width / x_height,
        height / x_height,
        (coordinate(bottom) - metrics.baseline) / x_height + 1.0,
    ];
    for (target, value) in input
        .iter_mut()
        .skip(GRID.saturating_mul(GRID))
        .zip(geometry)
    {
        *target = u8::try_from(quantize(value.clamp(0.0, 3.9), UNIT)).unwrap_or_default();
    }
    input
}
