use core::{iter, mem};

const IMPOSSIBLE: f32 = f32::NEG_INFINITY;

pub(crate) fn gradients(
    log_probability: &[Vec<f32>],
    labels: &[usize],
) -> Option<(Vec<Vec<f32>>, f32)> {
    let sequence: Vec<_> = iter::once(0)
        .chain(labels.iter().flat_map(|&label| [label, 0]))
        .collect();
    let (alpha, log_mass) = forward(log_probability, &sequence)?;
    let mut gradient = log_probability
        .iter()
        .map(|row| row.iter().map(|value| value.exp()).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let mut backward = vec![IMPOSSIBLE; sequence.len()];
    for value in backward.iter_mut().rev().take(2) {
        *value = 0.0;
    }
    let mut next = vec![IMPOSSIBLE; sequence.len()];
    for ((score, row), deltas) in log_probability
        .iter()
        .zip(alpha.iter())
        .zip(&mut gradient)
        .rev()
    {
        for ((&left, &right), &label) in row.iter().zip(&backward).zip(&sequence) {
            *deltas.get_mut(label)? -= (left + right - log_mass).min(0.0).exp();
        }
        for (state, target) in next.iter_mut().enumerate() {
            let future = |step: usize| {
                let index = state.saturating_add(step);
                backward
                    .get(index)
                    .zip(sequence.get(index))
                    .and_then(|(&value, &label)| score.get(label).map(|logit| value + logit))
                    .unwrap_or(IMPOSSIBLE)
            };
            let direct = add(future(0), future(1));
            *target = if skip(&sequence, state) {
                add(direct, future(2))
            } else {
                direct
            };
        }
        mem::swap(&mut backward, &mut next);
    }
    Some((gradient, -log_mass))
}

fn add(left: f32, right: f32) -> f32 {
    let peak = left.max(right);
    if peak.is_finite() {
        peak + (left.min(right) - peak).exp().ln_1p()
    } else {
        IMPOSSIBLE
    }
}

fn forward(log_probability: &[Vec<f32>], sequence: &[usize]) -> Option<(Vec<Vec<f32>>, f32)> {
    let mut output = Vec::with_capacity(log_probability.len());
    let mut initial = vec![IMPOSSIBLE; sequence.len()];
    *initial.first_mut()? = 0.0;
    for frame in log_probability {
        let previous = output.last().unwrap_or(&initial);
        let mut next = Vec::with_capacity(sequence.len());
        for (state, &label) in sequence.iter().enumerate() {
            let value = |step| {
                state
                    .checked_sub(step)
                    .and_then(|index| previous.get(index).copied())
                    .unwrap_or(IMPOSSIBLE)
            };
            let direct = add(value(0), value(1));
            let total = if state >= 2 && skip(sequence, state.saturating_sub(2)) {
                add(direct, value(2))
            } else {
                direct
            };
            next.push(total + frame.get(label)?);
        }
        output.push(next);
    }
    let complete = output
        .last()?
        .iter()
        .rev()
        .take(2)
        .copied()
        .fold(IMPOSSIBLE, add);
    complete.is_finite().then_some((output, complete))
}

fn skip(sequence: &[usize], source: usize) -> bool {
    sequence
        .get(source)
        .zip(sequence.get(source.saturating_add(2)))
        .is_some_and(|(&old, &new)| new != 0 && old != new)
}

#[cfg(test)]
mod tests {
    use super::gradients;

    #[test]
    fn repeated_letters_require_a_blank() {
        let low = 0.1_f32.ln();
        let high = 0.9_f32.ln();
        let frames = vec![vec![low, high], vec![high, low], vec![low, high]];
        let (gradient, loss) = gradients(&frames, &[1, 1]).unwrap();
        let [left, middle, right] = gradient.as_slice() else {
            panic!("three frames required")
        };
        assert!((loss + 0.729_f32.ln()).abs() < 0.000_01);
        assert!(left.last().is_some_and(|value| *value < 0.0));
        assert!(middle.first().is_some_and(|value| *value < 0.0));
        assert!(right.last().is_some_and(|value| *value < 0.0));
        assert!(gradients(&frames[..2], &[1, 1]).is_none());
    }

    #[test]
    fn improbable_long_paths_remain_finite() {
        let frames = vec![vec![0.0, -100.0]; 500];
        let labels = vec![1; 40];
        let (gradient, loss) = gradients(&frames, &labels).unwrap();
        assert!(loss > 3_000.0);
        assert!(gradient.iter().flatten().all(|value| value.is_finite()));
    }
}
