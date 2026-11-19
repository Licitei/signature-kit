use alloc::collections::BTreeMap;
use core::iter;
use std::io::{self, Write as _};
use std::thread;
use std::time::Instant;

use crate::ctc;
use crate::network::quantize;
use crate::raster::Bits;
use crate::sequence::{
    CHANNELS, Frame, Geometry, INPUT, KERNELS, MAGIC, NEGATIVE_SLOPE, SCALES, activate, frames,
    pixels, tap,
};

const BATCH: usize = 24;

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
    fn apply(&self, input: &[Vec<f32>]) -> Vec<Vec<f32>> {
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
                                value += dot(window, kernel);
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
                        for (((delta, update), &feature), &weight) in
                            deltas.iter_mut().zip(updates).zip(window).zip(kernel)
                        {
                            *delta += signal * weight;
                            *update += signal * feature;
                        }
                    }
                }
            }
        }
        input_gradient
    }

    fn encode(&self, output: &mut Vec<u8>, unit: f32) {
        let record = self.record();
        let scale = self
            .values
            .chunks_exact(record)
            .flat_map(|row| row.iter().skip(1))
            .fold(f32::EPSILON, |peak, value| peak.max(value.abs()))
            / 127.0;
        output.extend((scale / unit).to_le_bytes());
        for row in self.values.chunks_exact(record) {
            let Some((&bias, weights)) = row.split_first() else {
                continue;
            };
            output.extend(bias.to_le_bytes());
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
        frames(geometry, &mut result.frames);
        if result.frames.len() < labels.len() || result.frames.len() > 2_400 {
            return None;
        }
        let source: Vec<Vec<f32>> = result
            .frames
            .iter()
            .map(|&frame| {
                pixels(&example.page, geometry, frame)
                    .iter()
                    .map(|&value| f32::from(value) / 64.0)
                    .collect()
            })
            .collect();
        let [first, second, third, output] = &self.layers;
        let first_activation = relu(first.apply(&source));
        let second_activation = relu(second.apply(&first_activation));
        let third_activation = relu(third.apply(&second_activation));
        let mut probability = output.apply(&third_activation);
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
        let signal_third = output.backprop(&third_activation, &gradient, output_gradient);
        let signal_second = third.backprop(
            &second_activation,
            &relu_gradient(signal_third, &third_activation),
            third_gradient,
        );
        let signal_first = second.backprop(
            &first_activation,
            &relu_gradient(signal_second, &second_activation),
            second_gradient,
        );
        drop(first.backprop(
            &source,
            &relu_gradient(signal_first, &first_activation),
            first_gradient,
        ));
        Some(loss)
    }

    fn new(labels: usize, rng: &mut Random) -> Self {
        let [first, second, third, output] = KERNELS;
        Self {
            layers: [
                Layer::new(INPUT, CHANNELS, first, rng),
                Layer::new(CHANNELS, CHANNELS, second, rng),
                Layer::new(CHANNELS, CHANNELS, third, rng),
                Layer::new(CHANNELS, labels, output, rng),
            ],
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
        let factor = f32::from(u16::try_from(batch_size.max(1)).unwrap_or(u16::MAX)).recip();
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
                let delta = (signal * factor).clamp(-20.0, 20.0);
                *mean = 0.9 * *mean + 0.1 * delta;
                *square = 0.999 * *square + 0.001 * delta * delta;
                *value -= rate * *mean / (square.sqrt() + 0.000_01);
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

fn dot(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(feature, weight)| feature * weight)
        .sum()
}

fn relu(mut values: Vec<Vec<f32>>) -> Vec<Vec<f32>> {
    for value in values.iter_mut().flatten() {
        *value = activate(*value);
    }
    values
}

fn relu_gradient(mut values: Vec<Vec<f32>>, activations: &[Vec<f32>]) -> Vec<Vec<f32>> {
    for (delta, activation) in values
        .iter_mut()
        .flatten()
        .zip(activations.iter().flatten())
    {
        if activation.abs() >= 7.9 {
            *delta = 0.0;
        } else if *activation <= 0.0 {
            *delta *= NEGATIVE_SLOPE;
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
    iter::once('\0')
        .chain(counts.into_iter().filter_map(|(label, count)| {
            (label != '\0' && count >= 16 && !label.is_control()).then_some(label)
        }))
        .take(512)
        .collect()
}

fn collect_batch(
    model: &Parameters,
    batch: &[(&Example, Vec<usize>)],
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

pub(crate) fn train(examples: &[Example], training: Training, hash: u64) -> io::Result<Vec<u8>> {
    let Training {
        epochs,
        lines_per_epoch,
        seed,
        warm_epochs,
        workers,
    } = training;
    let labels = alphabet(examples);
    if labels.len() < 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "no trainable CTC labels",
        ));
    }
    let mut dataset: Vec<_> = examples
        .iter()
        .filter_map(|example| {
            let keys = example
                .text
                .iter()
                .map(|label| labels.binary_search(label).ok())
                .collect::<Option<Vec<_>>>()?;
            (!keys.is_empty()).then_some((example, keys))
        })
        .collect();
    let mut rng = Random(seed.max(1));
    let mut model = Parameters::new(labels.len(), &mut rng);
    let mut optimizer = Optimizer {
        momentum: model.zeros(),
        variance: model.zeros(),
    };
    for epoch in 0..epochs {
        for index in (1..dataset.len()).rev() {
            let limit = u64::try_from(index.saturating_add(1)).unwrap_or(u64::MAX);
            let pick = usize::try_from(rng.next().checked_rem(limit).unwrap_or_default())
                .unwrap_or_default();
            dataset.swap(index, pick);
        }
        let started = Instant::now();
        let mut loss = 0.0_f32;
        let mut total_lines = 0_usize;
        let rate = 0.0012 / (1.0 + f32::from(u16::try_from(epoch).unwrap_or(u16::MAX)) * 0.035);
        let training_lines = dataset
            .get(..lines_per_epoch.min(dataset.len()))
            .unwrap_or_default();
        for batch in training_lines.chunks(BATCH.max(workers)) {
            let gradients = collect_batch(&model, batch, workers, rng.next(), epoch < warm_epochs)
                .ok_or_else(|| io::Error::other("a CTC gradient worker failed"))?;
            optimizer.update(&mut model, &gradients.gradient, gradients.lines, rate);
            loss += gradients.loss;
            total_lines = total_lines.saturating_add(gradients.lines);
        }
        if total_lines == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "no CTC paths survived training",
            ));
        }
        writeln!(
            io::stdout().lock(),
            "epoch={} lines={total_lines} loss={loss:.2} seconds={:.2}",
            epoch.saturating_add(1),
            started.elapsed().as_secs_f64()
        )?;
    }
    model
        .encode(&labels, seed, hash)
        .ok_or_else(|| io::Error::other("could not encode the CTC model"))
}
