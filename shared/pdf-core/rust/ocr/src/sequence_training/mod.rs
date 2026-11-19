#[cfg(target_arch = "x86_64")]
mod avx2;

use alloc::collections::BTreeMap;
use core::cmp::Reverse;
use core::f32::consts::PI;
use core::{array, iter, mem};
use std::fs;
use std::io::{self, Write as _};
use std::path::Path;
use std::thread;
use std::time::Instant;

use crate::ctc;
use crate::model::coordinate;
use crate::network::{nearest, quantize};
use crate::raster::Bits;
use crate::sequence::{
    CHANNELS, CHANNELWISE, Frame, Geometry, INPUT, KERNELS, MAGIC, NEGATIVE_SLOPE, SCALES, Scratch,
    Sequence, activate, frames, pixels, tap,
};
use crate::training::write_model;

const BATCH: usize = 24;
const PORTUGUESE_SYMBOLS: &str = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u{a2}\u{a3}\u{a7}\u{aa}\u{ab}\u{b0}\u{b1}\u{b2}\u{b3}\u{ba}\u{bb}\u{c0}\u{c1}\u{c2}\u{c3}\u{c4}\u{c7}\u{c8}\u{c9}\u{ca}\u{cb}\u{cc}\u{cd}\u{ce}\u{cf}\u{d1}\u{d2}\u{d3}\u{d4}\u{d5}\u{d6}\u{d9}\u{da}\u{db}\u{dc}\u{e0}\u{e1}\u{e2}\u{e3}\u{e4}\u{e7}\u{e8}\u{e9}\u{ea}\u{eb}\u{ec}\u{ed}\u{ee}\u{ef}\u{f1}\u{f2}\u{f3}\u{f4}\u{f5}\u{f6}\u{f9}\u{fa}\u{fb}\u{fc}\u{2013}\u{2014}\u{2018}\u{2019}\u{201c}\u{201d}\u{2022}\u{2026}\u{20ac}";
const DROPOUT_SCALE: f32 = if CHANNELWISE { 1.0 / 0.95 } else { 1.0 };

type Accumulate = fn(&mut [f32], &mut [f32], &[f32], &[f32], f32);

pub(crate) struct Example {
    pub(crate) alignment: Vec<u32>,
    pub(crate) geometry: Geometry,
    pub(crate) page: Bits,
    pub(crate) text: Vec<char>,
}

#[derive(Clone, Copy)]
pub(crate) struct Training {
    pub(crate) epochs: usize,
    pub(crate) lines_per_epoch: usize,
    pub(crate) patience: usize,
    pub(crate) resume: bool,
    pub(crate) seed: u64,
    pub(crate) warm_epochs: usize,
    pub(crate) workers: usize,
}

#[derive(Debug)]
struct Layer {
    dilation: usize,
    kernel: usize,
    values: Vec<f32>,
    width: usize,
}

impl Layer {
    fn apply(&self, kernels: Kernels, input: &[Vec<f32>]) -> Vec<Vec<f32>> {
        let record = self.record();
        input
            .iter()
            .enumerate()
            .map(|(frame, _)| {
                self.values
                    .chunks_exact(record)
                    .map(|row| {
                        let Some((&bias, weights)) = row.split_first() else {
                            return 0.0;
                        };
                        let mut value = bias;
                        for (tap_index, kernel) in weights.chunks_exact(self.width).enumerate() {
                            if let Some(window) = tap(frame, tap_index, self.kernel, self.dilation)
                                .and_then(|index| input.get(index))
                            {
                                value += (kernels.dot)(window, kernel);
                            }
                        }
                        value
                    })
                    .collect()
            })
            .collect()
    }

    fn backprop(
        &self,
        kernels: Kernels,
        input: &[Vec<f32>],
        gradient: &[Vec<f32>],
        parameter_gradient: &mut [f32],
    ) -> Vec<Vec<f32>> {
        let record = self.record();
        let mut input_gradient = vec![vec![0.0_f32; self.width]; input.len()];
        for (frame, signals) in gradient.iter().enumerate() {
            for ((&signal, row), row_gradient) in signals
                .iter()
                .zip(self.values.chunks_exact(record))
                .zip(parameter_gradient.chunks_exact_mut(record))
            {
                if signal.abs() <= f32::EPSILON {
                    continue;
                }
                let Some((bias_gradient, weight_gradient)) = row_gradient.split_first_mut() else {
                    continue;
                };
                *bias_gradient += signal;
                let Some((_, weights)) = row.split_first() else {
                    continue;
                };
                for (tap_index, (kernel, updates)) in weights
                    .chunks_exact(self.width)
                    .zip(weight_gradient.chunks_exact_mut(self.width))
                    .enumerate()
                {
                    if let Some((window, deltas)) =
                        tap(frame, tap_index, self.kernel, self.dilation)
                            .and_then(|index| input.get(index).zip(input_gradient.get_mut(index)))
                    {
                        (kernels.accumulate)(deltas, updates, window, kernel, signal);
                    }
                }
            }
        }
        input_gradient
    }

    fn encode(&self, output: &mut Vec<u8>, unit: f32) {
        let record = self.record();
        let layer_scale = if CHANNELWISE {
            1.0
        } else {
            let scale = weight_scale(
                self.values
                    .chunks_exact(record)
                    .flat_map(|row| row.iter().skip(1)),
            );
            output.extend((scale / unit).to_le_bytes());
            scale
        };
        for row in self.values.chunks_exact(record) {
            let Some((&bias, weights)) = row.split_first() else {
                continue;
            };
            output.extend(bias.to_le_bytes());
            let scale = if CHANNELWISE {
                let scale = weight_scale(weights);
                output.extend((scale / unit).to_le_bytes());
                scale
            } else {
                layer_scale
            };
            for weight in weights {
                let shifted = (*weight / scale).round() + 128.0;
                let byte = u8::try_from(quantize(shifted, 1.0)).unwrap_or(128);
                output.push(byte.wrapping_sub(128));
            }
        }
    }

    fn new(
        width: usize,
        outputs: usize,
        (kernel, dilation): (usize, usize),
        random: &mut Random,
    ) -> Self {
        let mut result = Self {
            width,
            kernel,
            dilation,
            values: Vec::new(),
        };
        let fan_in = width.saturating_mul(kernel);
        let size = result.record().saturating_mul(outputs);
        let spread = (6.0 / f32::from(u16::try_from(fan_in).unwrap_or(u16::MAX))).sqrt();
        result.values.reserve(size);
        for _ in 0..outputs {
            result.values.push(0.02);
            result
                .values
                .extend(iter::repeat_with(|| random.value() * spread).take(fan_in));
        }
        result
    }

    const fn record(&self) -> usize {
        self.width.saturating_mul(self.kernel).saturating_add(1)
    }
}

struct Parameters {
    kernels: Kernels,
    layers: [Layer; 4],
}

impl Parameters {
    fn encode(&self, labels: &[char], seed: u64, hash: u64) -> Option<Vec<u8>> {
        let mut output = Vec::new();
        output.extend(MAGIC);
        output.extend(hash.to_le_bytes());
        output.extend(seed.to_le_bytes());
        output.extend(u32::try_from(labels.len()).ok()?.to_le_bytes());
        for &label in labels {
            output.extend(u32::from(label).to_le_bytes());
        }
        for (layer, unit) in self.layers.iter().zip(SCALES) {
            layer.encode(&mut output, unit);
        }
        Some(output)
    }

    fn gradient(
        &self,
        example: &Example,
        labels: &[usize],
        key: u64,
        warm: bool,
        result: &mut Worker,
    ) -> Option<f32> {
        let mut geometry = example.geometry;
        let mut random = Random(key.max(1));
        geometry.metrics.baseline += random.value() * 0.085 * geometry.metrics.x_height;
        geometry.metrics.x_height *= 1.0 + random.value() * 0.14;
        let variant = if CHANNELWISE {
            random.next().wrapping_rem(5)
        } else {
            0
        };
        frames(geometry, &mut result.frames);
        if result.frames.len() < labels.len() || result.frames.len() > 2_400 {
            return None;
        }
        let [left, _, right, _] = geometry.bbox;
        let center = coordinate(u32::midpoint(left, right));
        let skew = if CHANNELWISE && random.value() > 0.6 {
            random.value() * 0.0349
        } else {
            0.0
        };
        let source: Vec<Vec<f32>> = result
            .frames
            .iter()
            .map(|&frame| {
                let mut sampled = geometry;
                sampled.metrics.baseline += (coordinate(frame.position()) - center) * skew;
                let coverage = pixels(&example.page, sampled, frame);
                coverage
                    .into_iter()
                    .map(|value| {
                        let level = f32::from(value) / 64.0;
                        match variant {
                            1 => (level * 1.65 - 0.65).max(0.0),
                            2 => (level * 1.6).min(1.0),
                            3 => (level * 0.85 + 0.08 * random.value()).clamp(0.0, 1.0),
                            4 => {
                                if level >= 0.5 {
                                    1.0
                                } else {
                                    0.0
                                }
                            }
                            _ => level,
                        }
                    })
                    .collect()
            })
            .collect();
        let [first, second, third, output] = &self.layers;
        let kernels = self.kernels;
        let first_activation = relu(first.apply(kernels, &source), &mut random);
        let second_activation = relu(second.apply(kernels, &first_activation), &mut random);
        let third_activation = relu(third.apply(kernels, &second_activation), &mut random);
        let mut probability = output.apply(kernels, &third_activation);
        log_softmax(&mut probability);
        let (gradient, loss) = if warm && example.alignment.len() == labels.len() {
            aligned_gradient(&probability, &result.frames, &example.alignment, labels)?
        } else {
            ctc::gradients(&probability, labels)?
        };
        let [
            first_gradient,
            second_gradient,
            third_gradient,
            output_gradient,
        ] = &mut result.gradient;
        let signal_third = output.backprop(kernels, &third_activation, &gradient, output_gradient);
        let signal_second = third.backprop(
            kernels,
            &second_activation,
            &relu_gradient(signal_third, &third_activation),
            third_gradient,
        );
        let signal_first = second.backprop(
            kernels,
            &first_activation,
            &relu_gradient(signal_second, &second_activation),
            second_gradient,
        );
        drop(first.backprop(
            kernels,
            &source,
            &relu_gradient(signal_first, &first_activation),
            first_gradient,
        ));
        Some(loss)
    }

    fn new(labels: usize, rng: &mut Random) -> Self {
        let [first, second, third, output] = KERNELS;
        Self {
            kernels: Kernels::detect(),
            layers: [
                Layer::new(INPUT, CHANNELS, first, rng),
                Layer::new(CHANNELS, CHANNELS, second, rng),
                Layer::new(CHANNELS, CHANNELS, third, rng),
                Layer::new(CHANNELS, labels, output, rng),
            ],
        }
    }

    fn predict<Observe>(
        &self,
        example: &Example,
        labels: &[char],
        samples: &mut Vec<Frame>,
        mut observe: Observe,
    ) where
        Observe: FnMut(char),
    {
        frames(example.geometry, samples);
        let mut values: Vec<_> = samples
            .iter()
            .map(|&frame| {
                pixels(&example.page, example.geometry, frame)
                    .into_iter()
                    .map(|value| f32::from(value) / 64.0)
                    .collect()
            })
            .collect();
        let [first, second, third, output] = &self.layers;
        for layer in [first, second, third] {
            values = layer.apply(self.kernels, &values);
            for value in values.iter_mut().flatten() {
                *value = activate(*value);
            }
        }
        let mut previous = '\0';
        for row in output.apply(self.kernels, &values) {
            let winner = labels
                .iter()
                .copied()
                .zip(row)
                .reduce(|left, right| if left.1 >= right.1 { left } else { right })
                .map_or('\0', |(label, _)| label);
            if winner != '\0' && winner != previous {
                observe(winner);
            }
            previous = winner;
        }
    }

    fn zeros(&self) -> [Vec<f32>; 4] {
        self.layers
            .each_ref()
            .map(|layer| vec![0.0; layer.values.len()])
    }
}

struct Random(u64);

impl Random {
    const fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13_u32;
        self.0 ^= self.0 >> 7_u32;
        self.0 ^= self.0 << 17_u32;
        self.0
    }

    fn value(&mut self) -> f32 {
        let portion = u16::try_from(self.next() >> 48_u32).unwrap_or_default();
        f32::from(portion) / 32_768.0 - 1.0
    }
}

struct Optimizer {
    bias1: f32,
    bias2: f32,
    momentum: [Vec<f32>; 4],
    variance: [Vec<f32>; 4],
}

impl Optimizer {
    fn update(
        &mut self,
        model: &mut Parameters,
        gradient: &[Vec<f32>; 4],
        batch_size: usize,
        rate: f32,
    ) {
        let average = f32::from(u16::try_from(batch_size.max(1)).unwrap_or(u16::MAX)).recip();
        let norm = gradient
            .iter()
            .flatten()
            .map(|signal| (signal * average).powi(2))
            .sum::<f32>()
            .sqrt();
        let factor = average * (5.0 / norm.max(5.0));
        self.bias1 *= 0.9;
        self.bias2 *= 0.999;
        let mean_scale = rate / (1.0 - self.bias1);
        let variance_scale = (1.0 - self.bias2).sqrt().recip();
        for (((layer, gradients), momentum), variance) in model
            .layers
            .iter_mut()
            .zip(gradient)
            .zip(&mut self.momentum)
            .zip(&mut self.variance)
        {
            for (((value, &signal), mean), square) in layer
                .values
                .iter_mut()
                .zip(gradients)
                .zip(momentum)
                .zip(variance)
            {
                let delta = signal * factor;
                *mean = 0.9 * *mean + 0.1 * delta;
                *square = 0.999 * *square + 0.001 * delta * delta;
                *value -= mean_scale * *mean / (square.sqrt() * variance_scale + 0.000_01);
            }
        }
    }
}

struct Worker {
    frames: Vec<Frame>,
    gradient: [Vec<f32>; 4],
    lines: usize,
    loss: f32,
}

#[derive(Clone, Copy)]
struct Kernels {
    accumulate: Accumulate,
    dot: fn(&[f32], &[f32]) -> f32,
}

impl Kernels {
    fn detect() -> Self {
        #[cfg(target_arch = "x86_64")]
        if CHANNELWISE
            && std::is_x86_feature_detected!("avx2")
            && std::is_x86_feature_detected!("fma")
        {
            return avx2::kernels();
        }
        Self { accumulate, dot }
    }
}

#[derive(Debug, Clone, Copy)]
struct Progress {
    best_edits: usize,
    epoch: usize,
    stale: usize,
}

fn weight_scale<'weight, Weights>(weights: Weights) -> f32
where
    Weights: IntoIterator<Item = &'weight f32>,
{
    weights
        .into_iter()
        .fold(f32::EPSILON, |peak, weight| peak.max(weight.abs()))
        / 127.0
}

fn accumulate(
    deltas: &mut [f32],
    updates: &mut [f32],
    window: &[f32],
    kernel: &[f32],
    signal: f32,
) {
    for (((delta, update), &feature), &weight) in
        deltas.iter_mut().zip(updates).zip(window).zip(kernel)
    {
        *delta += signal * weight;
        *update += signal * feature;
    }
}

fn dot(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(feature, weight)| feature * weight)
        .sum()
}

fn relu(mut values: Vec<Vec<f32>>, random: &mut Random) -> Vec<Vec<f32>> {
    let mask: [bool; CHANNELS] = array::from_fn(|_| !CHANNELWISE || random.value() >= -0.9);
    for row in &mut values {
        for (value, keep) in row.iter_mut().zip(mask) {
            *value = if keep {
                activate(*value) * DROPOUT_SCALE
            } else {
                0.0
            };
        }
    }
    values
}

fn relu_gradient(mut values: Vec<Vec<f32>>, activations: &[Vec<f32>]) -> Vec<Vec<f32>> {
    for (delta, activation) in values
        .iter_mut()
        .flatten()
        .zip(activations.iter().flatten())
    {
        if activation.abs() >= 7.9 * DROPOUT_SCALE || (CHANNELWISE && *activation == 0.0) {
            *delta = 0.0;
        } else if *activation <= 0.0 {
            *delta *= NEGATIVE_SLOPE * DROPOUT_SCALE;
        } else {
            *delta *= DROPOUT_SCALE;
        }
    }
    values
}

fn log_softmax(values: &mut [Vec<f32>]) {
    for row in values {
        let peak = row.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let normalizer = peak
            + row
                .iter()
                .map(|value| (*value - peak).exp())
                .sum::<f32>()
                .ln();
        for value in row {
            *value -= normalizer;
        }
    }
}

fn aligned_gradient(
    log_probability: &[Vec<f32>],
    frames: &[Frame],
    alignment: &[u32],
    labels: &[usize],
) -> Option<(Vec<Vec<f32>>, f32)> {
    let mut frame_labels = vec![0_usize; frames.len()];
    let mut start = 0_usize;
    for (&position, &label) in alignment.iter().zip(labels) {
        let (best, _) = frames
            .iter()
            .enumerate()
            .skip(start)
            .min_by_key(|(_, frame)| frame.position().abs_diff(position))?;
        *frame_labels.get_mut(best)? = label;
        start = best.saturating_add(1);
    }
    let mut gradient = Vec::with_capacity(frames.len());
    let mut loss = 0.0;
    for (row, label) in log_probability.iter().zip(frame_labels) {
        let weight = if label == 0 { 0.25 } else { 1.0 };
        loss -= row.get(label)? * weight;
        let mut delta: Vec<_> = row.iter().map(|value| value.exp() * weight).collect();
        *delta.get_mut(label)? -= weight;
        gradient.push(delta);
    }
    Some((gradient, loss))
}

fn alphabet(examples: &[Example]) -> Vec<char> {
    let mut counts = BTreeMap::<char, usize>::new();
    for label in examples.iter().flat_map(|example| example.text.iter()) {
        let entry = counts.entry(*label).or_default();
        *entry = entry.saturating_add(1);
    }
    let mandatory = if CHANNELWISE { PORTUGUESE_SYMBOLS } else { "" };
    let mut observed: Vec<_> = counts
        .into_iter()
        .filter(|&(label, count)| count >= 16 && !label.is_control() && !mandatory.contains(label))
        .collect();
    observed.sort_unstable_by_key(|&(label, count)| (Reverse(count), label));
    let mut alphabet: Vec<_> = iter::once('\0')
        .chain(mandatory.chars())
        .chain(observed.into_iter().map(|(label, _)| label))
        .take(512)
        .collect();
    alphabet.sort_unstable();
    alphabet
}

fn collect_batch(
    model: &Parameters,
    batch: &[&(&Example, Vec<usize>)],
    workers: usize,
    seed: u64,
    warm: bool,
) -> Option<Worker> {
    thread::scope(|scope| {
        let size = batch.len().div_ceil(workers);
        let handles: Vec<_> = batch
            .chunks(size)
            .enumerate()
            .map(|(index, job)| {
                scope.spawn(move || {
                    let mut worker = Worker {
                        frames: Vec::new(),
                        gradient: model.zeros(),
                        lines: 0,
                        loss: 0.0,
                    };
                    let mut rng = Random(
                        seed.wrapping_add(u64::try_from(index).unwrap_or_default())
                            .max(1),
                    );
                    for (example, labels) in job {
                        if let Some(loss) =
                            model.gradient(example, labels, rng.next(), warm, &mut worker)
                        {
                            worker.lines = worker.lines.saturating_add(1);
                            worker.loss += loss;
                        }
                    }
                    worker
                })
            })
            .collect();
        let mut total = Worker {
            frames: Vec::new(),
            gradient: model.zeros(),
            lines: 0,
            loss: 0.0,
        };
        for handle in handles {
            let worker = handle.join().ok()?;
            total.loss += worker.loss;
            total.lines = total.lines.saturating_add(worker.lines);
            for (target, part) in total
                .gradient
                .iter_mut()
                .flatten()
                .zip(worker.gradient.iter().flatten())
            {
                *target += *part;
            }
        }
        Some(total)
    })
}

fn checkpoint_values<'state>(
    model: &'state mut Parameters,
    optimizer: &'state mut Optimizer,
) -> impl Iterator<Item = &'state mut f32> {
    model
        .layers
        .iter_mut()
        .flat_map(|layer| &mut layer.values)
        .chain(optimizer.momentum.iter_mut().flatten())
        .chain(optimizer.variance.iter_mut().flatten())
        .chain([&mut optimizer.bias1, &mut optimizer.bias2])
}

fn checkpoint_state(
    bytes: &[u8],
    contract: &[u8],
    model: &mut Parameters,
    optimizer: &mut Optimizer,
) -> Option<Progress> {
    let (header, rest) = bytes.strip_prefix(contract)?.split_first_chunk::<24>()?;
    let ([epoch, best, stale], []) = header.as_chunks::<8>() else {
        return None;
    };
    let mut values = checkpoint_values(model, optimizer);
    let (floats, []) = rest.as_chunks::<4>() else {
        return None;
    };
    for encoded in floats {
        let value = f32::from_le_bytes(*encoded);
        if !value.is_finite() {
            return None;
        }
        *values.next()? = value;
    }
    if values.next().is_some() {
        return None;
    }
    Some(Progress {
        epoch: usize::try_from(u64::from_le_bytes(*epoch)).ok()?,
        best_edits: usize::try_from(u64::from_le_bytes(*best)).ok()?,
        stale: usize::try_from(u64::from_le_bytes(*stale)).ok()?,
    })
}

fn save_checkpoint(
    checkpoint: &Path,
    contract: &[u8],
    progress: Progress,
    model: &mut Parameters,
    optimizer: &mut Optimizer,
) -> io::Result<()> {
    let mut bytes = contract.to_vec();
    for value in [progress.epoch, progress.best_edits, progress.stale] {
        bytes.extend(u64::try_from(value).unwrap_or(u64::MAX).to_le_bytes());
    }
    for value in checkpoint_values(model, optimizer) {
        bytes.extend(value.to_le_bytes());
    }
    write_model(checkpoint, &bytes)
}

fn validation_errors<Predict>(validation: &[Example], mut predict: Predict) -> (usize, usize)
where
    Predict: FnMut(&Example, &mut Vec<char>),
{
    let mut predicted = Vec::new();
    let mut previous = Vec::new();
    let mut row = Vec::new();
    let mut edits = 0_usize;
    let mut characters = 0_usize;
    for example in validation {
        predicted.clear();
        predict(example, &mut predicted);
        predicted.retain(|label| !label.is_whitespace());
        previous.clear();
        previous.extend(0..=predicted.len());
        for (index, expected) in example
            .text
            .iter()
            .filter(|label| !label.is_whitespace())
            .enumerate()
        {
            row.clear();
            row.push(index.saturating_add(1));
            for ((&above, &diagonal), actual) in
                previous.iter().skip(1).zip(&previous).zip(&predicted)
            {
                let insertion = row.last().copied().unwrap_or_default().saturating_add(1);
                row.push(
                    insertion
                        .min(above.saturating_add(1))
                        .min(diagonal.saturating_add(usize::from(actual != expected))),
                );
            }
            mem::swap(&mut previous, &mut row);
        }
        edits = edits.saturating_add(previous.last().copied().unwrap_or_default());
        characters = characters.saturating_add(
            example
                .text
                .iter()
                .filter(|label| !label.is_whitespace())
                .count(),
        );
    }
    (edits, characters)
}

fn learning_rate(epoch: usize, epochs: usize) -> f32 {
    let epoch_number = f32::from(u16::try_from(epoch.saturating_add(1)).unwrap_or(u16::MAX));
    let total = f32::from(u16::try_from(epochs).unwrap_or(u16::MAX));
    let warmup = total.min(3.0);
    let phase = ((epoch_number - warmup) / (total - warmup).max(1.0)).max(0.0);
    0.0012 * (epoch_number / warmup).min(1.0) * (0.1 + 0.45 * (1.0 + (phase * PI).cos()))
}

fn checkpoint_contract(training: Training, hash: u64) -> Vec<u8> {
    let mut contract = b"OCC1".to_vec();
    contract.extend(MAGIC);
    contract.extend(hash.to_le_bytes());
    contract.extend(training.seed.to_le_bytes());
    for value in [
        training.epochs,
        training.lines_per_epoch,
        training.warm_epochs,
        training.workers,
        training.patience,
    ] {
        contract.extend(u64::try_from(value).unwrap_or(u64::MAX).to_le_bytes());
    }
    contract
}

fn training_dataset<'data>(
    examples: &'data [Example],
    labels: &[char],
) -> Vec<(&'data Example, Vec<usize>)> {
    examples
        .iter()
        .filter_map(|example| {
            let keys = example
                .text
                .iter()
                .map(|label| labels.binary_search(label).ok())
                .collect::<Option<Vec<_>>>()?;
            (!keys.is_empty()).then_some((example, keys))
        })
        .collect()
}

pub(crate) fn train(
    examples: &[Example],
    validation: &[Example],
    training: Training,
    hash: u64,
    output: &Path,
) -> io::Result<()> {
    let labels = alphabet(examples);
    let dataset = training_dataset(examples, &labels);
    if dataset.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "no trainable CTC lines",
        ));
    }
    let mut model = Parameters::new(labels.len(), &mut Random(training.seed.max(1)));
    let mut optimizer = Optimizer {
        bias1: 1.0,
        bias2: 1.0,
        momentum: model.zeros(),
        variance: model.zeros(),
    };
    let contract = checkpoint_contract(training, hash);
    let mut checkpoint_name = output.as_os_str().to_os_string();
    checkpoint_name.push(".checkpoint");
    let checkpoint = Path::new(&checkpoint_name);
    let mut progress = if training.resume {
        checkpoint_state(
            &fs::read(checkpoint)?,
            &contract,
            &mut model,
            &mut optimizer,
        )
        .filter(|state| state.epoch <= training.epochs && output.is_file())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "checkpoint does not match the run",
            )
        })?
    } else {
        Progress {
            epoch: 0,
            best_edits: usize::MAX,
            stale: 0,
        }
    };
    for epoch in progress.epoch..training.epochs {
        if progress.stale >= training.patience {
            break;
        }
        let mut rng = Random(
            training
                .seed
                .wrapping_add(
                    u64::try_from(epoch)
                        .unwrap_or_default()
                        .wrapping_mul(0x9E37_79B9_7F4A_7C15),
                )
                .max(1),
        );
        let started = Instant::now();
        let (total_lines, loss) = train_epoch(
            &mut model,
            &mut optimizer,
            &dataset,
            training,
            epoch,
            &mut rng,
        )?;
        if total_lines == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "no CTC paths survived training",
            ));
        }
        let table = model
            .encode(&labels, training.seed, hash)
            .ok_or_else(|| io::Error::other("could not encode the CTC model"))?;
        let sequence = Sequence::decode(&table)
            .ok_or_else(|| io::Error::other("nonfinite parameters in CTC model"))?;
        let mut scratch = Scratch::default();
        let (edits, characters) = validation_errors(validation, |example, predicted| {
            sequence.predict(
                &example.page,
                example.geometry,
                &mut scratch,
                |_, label, _| predicted.push(label),
            );
        });
        if characters == 0 || edits < progress.best_edits {
            if characters > 0 {
                let mut samples = Vec::new();
                let (float_edits, _) = validation_errors(validation, |example, predicted| {
                    model.predict(example, &labels, &mut samples, |label| {
                        predicted.push(label);
                    });
                });
                writeln!(
                    io::stdout().lock(),
                    "selected_epoch={} int8_edits={edits} f32_edits={float_edits} characters={characters}",
                    epoch.saturating_add(1)
                )?;
            }
            write_model(output, &table)?;
            progress.best_edits = edits;
            progress.stale = 0;
        } else {
            progress.stale = progress.stale.saturating_add(1);
        }
        progress.epoch = epoch.saturating_add(1);
        save_checkpoint(checkpoint, &contract, progress, &mut model, &mut optimizer)?;
        writeln!(
            io::stdout().lock(),
            "epoch={} lines={total_lines} loss={loss:.2} validation_edits={edits}/{characters} seconds={:.2}",
            progress.epoch,
            started.elapsed().as_secs_f64()
        )?;
    }
    Ok(())
}

fn train_epoch(
    model: &mut Parameters,
    optimizer: &mut Optimizer,
    dataset: &[(&Example, Vec<usize>)],
    training: Training,
    epoch: usize,
    rng: &mut Random,
) -> io::Result<(usize, f32)> {
    let mut order: Vec<_> = dataset.iter().collect();
    for index in (1..order.len()).rev() {
        let limit = u64::try_from(index.saturating_add(1)).unwrap_or(u64::MAX);
        let pick =
            usize::try_from(rng.next().checked_rem(limit).unwrap_or_default()).unwrap_or_default();
        order.swap(index, pick);
    }
    order.truncate(training.lines_per_epoch);
    let rate = learning_rate(epoch, training.epochs);
    let mut loss = 0.0_f32;
    let mut total_lines = 0_usize;
    let size = BATCH.max(training.workers);
    for bucket in order.chunks_mut(size.saturating_mul(8)) {
        bucket.sort_by_cached_key(|(example, _)| normalized_width(example));
        for batch in bucket.chunks(size) {
            let gradients = collect_batch(
                model,
                batch,
                training.workers,
                rng.next(),
                epoch < training.warm_epochs,
            )
            .ok_or_else(|| io::Error::other("a CTC gradient worker failed"))?;
            if gradients.lines == 0 {
                continue;
            }
            optimizer.update(model, &gradients.gradient, gradients.lines, rate);
            loss += gradients.loss;
            total_lines = total_lines.saturating_add(gradients.lines);
        }
    }
    Ok((total_lines, loss))
}

fn normalized_width(example: &Example) -> u32 {
    let [left, _, right, _] = example.geometry.bbox;
    nearest(coordinate(right.saturating_sub(left)) / example.geometry.metrics.x_height.max(1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exported_weights_decode_and_reject_trailing_data() {
        let labels = ['\0', ' ', 'a', '\u{e7}'];
        let model = Parameters::new(labels.len(), &mut Random(1729));
        let mut table = model.encode(&labels, 1729, 0xabcd).unwrap();
        assert!(Sequence::decode(&table).is_some());
        table.push(0);
        assert!(Sequence::decode(&table).is_none());
    }

    #[test]
    fn checkpoint_restores_parameters_and_adam_moments() {
        let labels = 4;
        let mut model = Parameters::new(labels, &mut Random(1729));
        let mut optimizer = Optimizer {
            bias1: 0.9,
            bias2: 0.999,
            momentum: model.zeros(),
            variance: model.zeros(),
        };
        let expected: Vec<_> = checkpoint_values(&mut model, &mut optimizer)
            .map(|value| *value)
            .collect();
        let contract = b"OCC1";
        let mut checkpoint = contract.to_vec();
        for field in [4_u64, 12, 2] {
            checkpoint.extend(field.to_le_bytes());
        }
        for &value in &expected {
            checkpoint.extend(value.to_le_bytes());
        }
        let mut fresh = Parameters::new(labels, &mut Random(2048));
        let mut moments = Optimizer {
            bias1: 1.0,
            bias2: 1.0,
            momentum: fresh.zeros(),
            variance: fresh.zeros(),
        };
        assert!(checkpoint_state(&checkpoint, b"other", &mut fresh, &mut moments).is_none());
        let restored = checkpoint_state(&checkpoint, contract, &mut fresh, &mut moments).unwrap();
        assert_eq!(
            (restored.epoch, restored.best_edits, restored.stale),
            (4, 12, 2)
        );
        assert!(
            checkpoint_values(&mut fresh, &mut moments)
                .zip(expected)
                .all(|(restored, original)| restored.to_bits() == original.to_bits())
        );
    }
}
