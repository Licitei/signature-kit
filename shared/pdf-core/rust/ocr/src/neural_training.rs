use alloc::collections::BTreeMap;
use core::{array, iter};

use crate::network::{HIDDEN, INPUTS, MAGIC, Shape, UNIT};

const EPOCHS: usize = 20;
const MIN_EXAMPLES: usize = 512;

pub(crate) type Samples = BTreeMap<char, Vec<[u8; INPUTS]>>;

struct Random(u64);

impl Random {
    const fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13_u32;
        self.0 ^= self.0 >> 7_u32;
        self.0 ^= self.0 << 17_u32;
        let [_, _, _, _, a, b, c, d] = self.0.to_le_bytes();
        u32::from_le_bytes([a, b, c, d])
    }

    fn weight(&mut self, spread: f32) -> f32 {
        let value = u16::try_from(self.next() >> 16_u32).unwrap_or_default();
        (f32::from(value) / 32_768.0 - 1.0) * spread
    }
}

struct Classifier {
    hidden_bias: [f32; HIDDEN],
    hidden_weights: Box<[[f32; HIDDEN]]>,
    output_bias: Vec<f32>,
    outputs: Vec<[f32; HIDDEN]>,
}

impl Classifier {
    fn encode(&self, labels: &[char], shape: Shape, seed: u64, hash: u64) -> Option<Vec<u8>> {
        let mode = match shape {
            Shape::Glyph => 0_u32,
            Shape::Line => 1_u32,
        };
        let hidden_step = step_size(&self.hidden_weights);
        let output_step = step_size(&self.outputs);
        let mut bytes = Vec::new();
        bytes.extend(MAGIC);
        bytes.extend(hash.to_le_bytes());
        bytes.extend(seed.to_le_bytes());
        bytes.extend(mode.to_le_bytes());
        bytes.extend(u32::try_from(labels.len()).ok()?.to_le_bytes());
        bytes.extend((hidden_step / UNIT).to_le_bytes());
        bytes.extend((output_step / UNIT).to_le_bytes());
        for bias in self.hidden_bias {
            bytes.extend(bias.to_le_bytes());
        }
        for row in &self.hidden_weights {
            bytes.extend(row.iter().map(|&weight| weight_byte(weight, hidden_step)));
        }
        for ((weights, &label), &bias) in self.outputs.iter().zip(labels).zip(&self.output_bias) {
            bytes.extend(
                weights
                    .iter()
                    .map(|&weight| weight_byte(weight, output_step)),
            );
            bytes.extend(u32::from(label).to_le_bytes());
            bytes.extend(bias.to_le_bytes());
        }
        Some(bytes)
    }

    fn new(classes: usize, random: &mut Random) -> Self {
        let hidden_weights = iter::repeat_with(|| array::from_fn(|_| random.weight(0.13)))
            .take(INPUTS)
            .collect();
        let outputs = iter::repeat_with(|| array::from_fn(|_| random.weight(0.25)))
            .take(classes)
            .collect();
        Self {
            hidden_weights,
            hidden_bias: [0.05; HIDDEN],
            outputs,
            output_bias: vec![0.0; classes],
        }
    }

    fn step(&mut self, label: usize, sample: &[u8; INPUTS], rate: f32, logits: &mut [f32]) {
        let mut hidden = self.hidden_bias;
        for (&input, weights) in sample.iter().zip(&self.hidden_weights) {
            if input != 0 {
                let value = f32::from(input) / UNIT;
                for (activation, &weight) in hidden.iter_mut().zip(weights) {
                    *activation += value * weight;
                }
            }
        }
        for activation in &mut hidden {
            *activation = activation.max(0.0);
        }
        let mut peak = f32::NEG_INFINITY;
        for ((logit, weights), &bias) in logits.iter_mut().zip(&self.outputs).zip(&self.output_bias)
        {
            *logit = bias
                + weights
                    .iter()
                    .zip(hidden)
                    .map(|(&weight, value)| weight * value)
                    .sum::<f32>();
            peak = peak.max(*logit);
        }
        let mut total = 0.0_f32;
        for logit in &mut *logits {
            *logit = (*logit - peak).exp();
            total += *logit;
        }
        let factor = rate / total;
        let mut gradients = [0.0_f32; HIDDEN];
        for (index, ((weights, bias), &probability)) in self
            .outputs
            .iter_mut()
            .zip(&mut self.output_bias)
            .zip(logits.iter())
            .enumerate()
        {
            let expected = f32::from(u8::from(label == index));
            let delta = expected * rate - probability * factor;
            *bias += delta;
            for ((weight, gradient), value) in weights.iter_mut().zip(&mut gradients).zip(hidden) {
                *gradient += *weight * delta;
                *weight += value * delta;
            }
        }
        for ((gradient, bias), value) in gradients.iter_mut().zip(&mut self.hidden_bias).zip(hidden)
        {
            if value <= 0.0 {
                *gradient = 0.0;
            }
            *bias += *gradient;
        }
        for (&input, weights) in sample.iter().zip(&mut self.hidden_weights) {
            if input != 0 {
                let value = f32::from(input) / UNIT;
                for (weight, gradient) in weights.iter_mut().zip(gradients) {
                    *weight += value * gradient;
                }
            }
        }
    }
}

fn step_size(matrix: &[[f32; HIDDEN]]) -> f32 {
    matrix
        .iter()
        .flatten()
        .fold(0.0_f32, |peak, value| peak.max(value.abs()))
        .max(f32::EPSILON)
        / 127.0
}

fn weight_byte(weight: f32, step: f32) -> u8 {
    let stored = ((weight / step).round() + 128.0) + 8_388_608.0;
    u8::try_from(stored.to_bits().wrapping_sub(8_388_608.0_f32.to_bits())).unwrap_or(128)
}

pub(crate) fn train(samples: &Samples, shape: Shape, seed: u64, hash: u64) -> Option<Vec<u8>> {
    let mut random = Random(seed.max(1));
    let mut classifier = Classifier::new(samples.len(), &mut random);
    let mut logits = vec![0.0; samples.len()];
    let labels: Vec<_> = samples.keys().copied().collect();
    let mut examples = Vec::new();
    for (label, group) in samples.values().enumerate() {
        let count = group.len().max(MIN_EXAMPLES);
        examples.extend(
            group
                .iter()
                .cycle()
                .take(count)
                .map(|sample| (label, sample)),
        );
    }
    for epoch in 0..EPOCHS {
        for stop in (1..examples.len()).rev() {
            let limit = u32::try_from(stop.saturating_add(1)).ok()?;
            let pick = usize::try_from(random.next().checked_rem(limit)?).ok()?;
            examples.swap(stop, pick);
        }
        let phase = f32::from(u16::try_from(epoch).ok()?);
        let rate = 0.023 / (1.0 + phase * 0.19);
        for &(label, sample) in &examples {
            classifier.step(label, sample, rate, &mut logits);
        }
    }
    classifier.encode(&labels, shape, seed, hash)
}
