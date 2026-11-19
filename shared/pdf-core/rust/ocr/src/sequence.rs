use core::array;

#[cfg(feature = "ctc-beam")]
use crate::model::model;
use crate::model::{Metrics, coordinate};
use crate::network::{nearest, quantize};
use crate::raster::Bits;
#[cfg(feature = "ctc-probe")]
use crate::recognize::Word;
#[cfg(feature = "ctc-probe")]
use crate::segment::Line;
#[cfg(feature = "ctc-beam")]
use crate::sequence_beam::Decoder;

#[cfg(not(any(feature = "ctc-wide", feature = "ctc-v3")))]
pub(crate) const MAGIC: &[u8; 4] = b"OCRS";
#[cfg(all(feature = "ctc-wide", not(feature = "ctc-v3")))]
pub(crate) const MAGIC: &[u8; 4] = b"OCRW";
#[cfg(feature = "ctc-v3")]
pub(crate) const MAGIC: &[u8; 4] = b"OCRV";
pub(crate) const INPUT: usize = 32;
#[cfg(not(any(feature = "ctc-wide", feature = "ctc-v3")))]
pub(crate) const CHANNELS: usize = 16;
#[cfg(all(feature = "ctc-wide", not(feature = "ctc-v3")))]
pub(crate) const CHANNELS: usize = 32;
#[cfg(feature = "ctc-v3")]
pub(crate) const CHANNELS: usize = 288;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) const SCALES: [f32; 4] = [64.0, 16.0, 16.0, 16.0];
pub(crate) const NEGATIVE_SLOPE: f32 = if cfg!(any(feature = "ctc-wide", feature = "ctc-v3")) {
    0.125
} else {
    0.0
};
pub(crate) const CHANNELWISE: bool = cfg!(feature = "ctc-v3");
const RECORD_HEADER: usize = if CHANNELWISE { 8 } else { 4 };
pub(crate) const KERNELS: [(usize, usize); 4] = [
    (5, 1),
    (3, 3),
    (3, if CHANNELWISE { 16 } else { 8 }),
    (1, 1),
];

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
    #[cfg(feature = "ctc-beam")]
    beam: Decoder,
    features: Vec<[i8; INPUT]>,
    first: Vec<[i8; CHANNELS]>,
    frames: Vec<Frame>,
    second: Vec<[i8; CHANNELS]>,
    third: Vec<[i8; CHANNELS]>,
}

#[cfg(feature = "ctc-probe")]
impl Scratch {
    pub(crate) fn for_page(width: u32) -> Self {
        let capacity = usize::try_from(width.saturating_mul(2).min(0x8000)).unwrap_or_default();
        Self {
            #[cfg(feature = "ctc-beam")]
            beam: Decoder::default(),
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
        let (raw_labels, layers) = tail.split_at_checked(count.checked_mul(4)?)?;
        let (labels, []) = raw_labels.as_chunks::<4>() else {
            return None;
        };
        let (blank, symbols) = labels.split_first()?;
        let mut previous = u32::from_le_bytes(*blank);
        if previous != 0
            || !symbols.iter().all(|encoded| {
                let code = u32::from_le_bytes(*encoded);
                let valid = code > previous
                    && char::from_u32(code).is_some_and(|label| !label.is_control());
                previous = code;
                valid
            })
        {
            return None;
        }
        let (first, rest) = decode_layer(layers, INPUT, 5, CHANNELS)?;
        let (second, rest_after_second) = decode_layer(rest, CHANNELS, 3, CHANNELS)?;
        let (third, rest_after_third) = decode_layer(rest_after_second, CHANNELS, 3, CHANNELS)?;
        let (output, []) = decode_layer(rest_after_third, CHANNELS, 1, count)? else {
            return None;
        };
        Some(Self {
            classes: labels,
            layers: [first, second, third, output],
        })
    }

    fn forward(&self, page: &Bits, geometry: Geometry, scratch: &mut Scratch) -> Layer<'model> {
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
        output
    }

    #[cfg(any(not(target_arch = "wasm32"), not(feature = "ctc-beam")))]
    pub(crate) fn predict<Observe>(
        &self,
        page: &Bits,
        geometry: Geometry,
        scratch: &mut Scratch,
        mut observe: Observe,
    ) where
        Observe: FnMut(u32, char, f32),
    {
        let output = self.forward(page, geometry, scratch);
        let mut active = ('\0', 0, 0.0_f32);
        for (&frame, window) in scratch.frames.iter().zip(&scratch.third) {
            let (label, confidence) = winner(output, self.classes, window);
            if label != active.0 {
                if active.0 != '\0' {
                    observe(active.1, active.0, active.2);
                }
                active = (label, frame.position(), confidence);
            } else if confidence > active.2 {
                active = (label, frame.position(), confidence);
            }
        }
        if active.0 != '\0' {
            observe(active.1, active.0, active.2);
        }
    }

    #[cfg(feature = "ctc-beam")]
    fn predict_beam<Observe>(
        &self,
        page: &Bits,
        geometry: Geometry,
        scratch: &mut Scratch,
        observe: Observe,
    ) where
        Observe: FnMut(u32, char, f32),
    {
        let output = self.forward(page, geometry, scratch);
        let language = model();
        scratch.beam.reset();
        for (&frame, window) in scratch.frames.iter().zip(&scratch.third) {
            scratch.beam.step(
                frame.position(),
                scores(output, self.classes, window),
                language.as_ref(),
            );
        }
        scratch.beam.finish(observe);
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn visit_weights<Restore>(&self, labels: &[char], mut restore: Restore)
    where
        Restore: FnMut(usize, usize, f32, f32, &[u8]),
    {
        for (layer_index, (layer, (inputs, unit))) in self
            .layers
            .iter()
            .zip(
                [INPUT, CHANNELS, CHANNELS, CHANNELS]
                    .into_iter()
                    .zip(SCALES),
            )
            .enumerate()
        {
            let (kernel, _) = KERNELS.get(layer_index).copied().unwrap_or_default();
            let stride = inputs.saturating_mul(kernel).saturating_add(RECORD_HEADER);
            let terminal = layer_index == self.layers.len().saturating_sub(1);
            for (index, row) in layer.bias_and_weights.chunks_exact(stride).enumerate() {
                let target_index = if terminal {
                    self.classes
                        .get(index)
                        .and_then(|encoded| char::from_u32(u32::from_le_bytes(*encoded)))
                        .and_then(|label| labels.binary_search(&label).ok())
                } else {
                    Some(index)
                };
                if let Some(target) = target_index
                    && let Some((bias, scale, weights)) = layer_row(row, layer.scale)
                {
                    restore(layer_index, target, bias, scale * unit, weights);
                }
            }
        }
    }

    #[cfg(feature = "ctc-probe")]
    pub(crate) fn words(&self, page: &Bits, line: &Line, scratch: &mut Scratch) -> Vec<Word> {
        let geometry = Geometry {
            bbox: line.bbox,
            metrics: Metrics {
                baseline: line.baseline,
                x_height: line.x_height,
            },
        };
        let [left, top, right, bottom] = line.bbox;
        let mut words = Vec::<Word>::new();
        let mut starts_word = true;
        self.predict(
            page,
            geometry,
            scratch,
            |position, character, confidence| {
                if character.is_whitespace() {
                    starts_word = true;
                    return;
                }
                let x = position.clamp(left, right.saturating_sub(1).max(left));
                if !starts_word && let Some(word) = words.last_mut() {
                    let [start, _, _, _] = word.bbox;
                    word.bbox = [start, top, x.saturating_add(1), bottom];
                    word.text.push(character);
                    word.confidence = word.confidence.min(confidence);
                    return;
                }
                words.push(Word {
                    alternatives: Vec::new(),
                    bbox: [x, top, x.saturating_add(1), bottom],
                    confidence,
                    text: String::from(character),
                });
                starts_word = false;
            },
        );
        refine_word_boxes(line, &mut words);
        words
    }
}

#[cfg(feature = "ctc-probe")]
fn refine_word_boxes(line: &Line, words: &mut [Word]) {
    let [left, top, right, bottom] = line.bbox;
    let mut boundary = left;
    let mut remaining = words.iter_mut().peekable();
    while let Some(word) = remaining.next() {
        let [start, _, end, _] = word.bbox;
        let limit = remaining.peek().map_or(right, |next| {
            let [next_start, _, _, _] = next.bbox;
            u32::midpoint(end, next_start).max(end)
        });
        let mut bounds = None;
        for candidate in &line.words {
            let [x0, y0, x1, y1] = candidate.bbox;
            if x0 >= end || x1 <= start {
                continue;
            }
            let clipped = [x0.max(boundary).min(start), y0, x1.min(limit).max(end), y1];
            bounds = Some(bounds.map_or(clipped, |[a0, b0, a1, b1]: [u32; 4]| {
                let [cx0, cy0, cx1, cy1] = clipped;
                [a0.min(cx0), b0.min(cy0), a1.max(cx1), b1.max(cy1)]
            }));
        }
        word.bbox = bounds.unwrap_or_else(|| [boundary.min(start), top, limit.max(end), bottom]);
        boundary = limit;
    }
}

fn decode_layer(
    bytes: &[u8],
    channels: usize,
    kernel: usize,
    outputs: usize,
) -> Option<(Layer<'_>, &[u8])> {
    let (scale, data) = if CHANNELWISE {
        (1.0, bytes)
    } else {
        let (scale_bytes, data) = bytes.split_first_chunk::<4>()?;
        (f32::from_le_bytes(*scale_bytes), data)
    };
    let size = channels
        .checked_mul(kernel)?
        .checked_add(RECORD_HEADER)?
        .checked_mul(outputs)?;
    let (bias_and_weights, rest) = data.split_at_checked(size)?;
    if !scale.is_finite()
        || scale <= 0.0
        || !bias_and_weights
            .chunks_exact(
                channels
                    .saturating_mul(kernel)
                    .saturating_add(RECORD_HEADER),
            )
            .all(|row| layer_row(row, scale).is_some())
    {
        return None;
    }
    Some((
        Layer {
            bias_and_weights,
            scale,
        },
        rest,
    ))
}

fn layer_row(row: &[u8], layer_scale: f32) -> Option<(f32, f32, &[u8])> {
    let (encoded_bias, tail) = row.split_first_chunk::<4>()?;
    let bias = f32::from_le_bytes(*encoded_bias);
    let (scale, weights) = if CHANNELWISE {
        let (scaled, weights) = tail.split_first_chunk::<4>()?;
        (f32::from_le_bytes(*scaled), weights)
    } else {
        (layer_scale, tail)
    };
    (bias.abs() <= 1.0e12 && (f32::MIN_POSITIVE..=1.0e12).contains(&scale))
        .then_some((bias, scale, weights))
}

pub(crate) fn frames(geometry: Geometry, output: &mut Vec<Frame>) {
    output.clear();
    let [left, _, right, _] = geometry.bbox;
    let height = geometry.metrics.x_height.max(1.0);
    let stretch = (height / if CHANNELWISE { 8.0 } else { 12.0 }).max(0.5);
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
    let record = WIDTH.saturating_mul(size).saturating_add(RECORD_HEADER);
    for (frame, _) in input.iter().enumerate() {
        let mut values = [0_i8; CHANNELS];
        for (activation, row) in values
            .iter_mut()
            .zip(layer.bias_and_weights.chunks_exact(record))
        {
            let Some((bias, scale, weights)) = layer_row(row, layer.scale) else {
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
            let value = signed(sum) * scale + bias;
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

fn scores<'input>(
    layer: Layer<'input>,
    labels: &'input [[u8; 4]],
    window: &'input [i8; CHANNELS],
) -> impl Iterator<Item = (char, f32)> + 'input {
    let (rows, _) = layer
        .bias_and_weights
        .as_chunks::<{ CHANNELS.saturating_add(RECORD_HEADER) }>();
    labels.iter().zip(rows).filter_map(move |(codepoint, row)| {
        let (bias, scale, kernel) = layer_row(row, layer.scale)?;
        let weights = kernel.try_into().ok()?;
        let score = signed(dot(window, weights)) * scale + bias;
        let label = char::from_u32(u32::from_le_bytes(*codepoint))?;
        Some((label, score))
    })
}

#[cfg(any(not(target_arch = "wasm32"), not(feature = "ctc-beam")))]
fn winner(layer: Layer<'_>, labels: &[[u8; 4]], window: &[i8; CHANNELS]) -> (char, f32) {
    let mut label = '\0';
    let mut first = f32::NEG_INFINITY;
    let mut second = f32::NEG_INFINITY;
    let mut exp_sum = 0.0_f32;
    for (class, score) in scores(layer, labels, window) {
        if CHANNELWISE {
            if score > first {
                exp_sum = 1.0 + exp_sum * (first - score).exp();
            } else {
                exp_sum += (score - first).exp();
            }
        }
        if score > first {
            second = first;
            first = score;
            label = class;
        } else if score > second {
            second = score;
        }
    }
    let confidence = if CHANNELWISE {
        exp_sum.max(1.0).recip()
    } else {
        ((first - second) / 6.0).clamp(0.0, 1.0)
    };
    (label, confidence)
}
