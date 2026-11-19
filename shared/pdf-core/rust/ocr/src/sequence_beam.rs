use core::mem;

use crate::model::Model;

const BEAM_WIDTH: usize = 8;
const FRAME_LABELS: usize = 8;
const BIGRAM_WEIGHT: f32 = 0.2;

#[derive(Clone, Copy)]
struct Candidate {
    label: char,
    score: f32,
}

#[derive(Clone, Copy)]
struct Emission {
    confidence: f32,
    label: char,
    parent: Option<usize>,
    x: u32,
}

#[derive(Clone, Copy)]
struct Path {
    emission: Option<Emission>,
    last: char,
    node: Option<usize>,
    repeat: bool,
    score: f32,
}

#[derive(Default)]
pub(crate) struct Decoder {
    active: Vec<Path>,
    history: Vec<Emission>,
    pending: Vec<Path>,
    result: Vec<Emission>,
}

impl Decoder {
    pub(crate) fn finish<Observe>(&mut self, mut observe: Observe)
    where
        Observe: FnMut(u32, char, f32),
    {
        self.result.clear();
        let mut tail = self.active.first().and_then(|path| path.node);
        while let Some(emission) = tail.and_then(|index| self.history.get(index)) {
            self.result.push(*emission);
            tail = emission.parent;
        }
        for emission in self.result.iter().rev() {
            observe(emission.x, emission.label, emission.confidence);
        }
    }

    pub(crate) fn reset(&mut self) {
        self.history.clear();
        self.pending.clear();
        self.active.clear();
        self.active.push(Path {
            emission: None,
            last: '\0',
            node: None,
            repeat: false,
            score: 0.0,
        });
    }

    pub(crate) fn step<Scores>(&mut self, x: u32, scores: Scores, language: Option<&Model<'_>>)
    where
        Scores: Iterator<Item = (char, f32)>,
    {
        let (blank, choices, normalization) = candidates(scores);
        self.pending.clear();
        for &path in &self.active {
            for candidate in choices.into_iter().chain([blank]) {
                if !candidate.score.is_finite() {
                    continue;
                }
                let relative = candidate.score - normalization;
                let proposed = advance(path, candidate.label, relative, x, language);
                if let Some(existing) = self
                    .pending
                    .iter_mut()
                    .find(|entry| entry.last == proposed.last && entry.repeat == proposed.repeat)
                {
                    if proposed.score > existing.score {
                        *existing = proposed;
                    }
                } else {
                    self.pending.push(proposed);
                }
            }
        }
        self.pending.sort_unstable_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| left.last.cmp(&right.last))
                .then_with(|| left.repeat.cmp(&right.repeat))
        });
        self.pending.truncate(BEAM_WIDTH);
        let peak = self.pending.first().map_or(0.0, |path| path.score);
        for path in &mut self.pending {
            if let Some(node) = path.emission.take() {
                path.node = Some(self.history.len());
                self.history.push(node);
            }
            path.score -= peak;
        }
        mem::swap(&mut self.active, &mut self.pending);
    }
}

fn candidates<Scores>(scores: Scores) -> (Candidate, [Candidate; FRAME_LABELS], f32)
where
    Scores: Iterator<Item = (char, f32)>,
{
    let empty = Candidate {
        label: '\0',
        score: f32::NEG_INFINITY,
    };
    let mut blank = empty;
    let mut ranked = [empty; FRAME_LABELS];
    let mut peak = f32::NEG_INFINITY;
    let mut mass = 0.0_f32;
    for (label, score) in scores {
        if score > peak {
            mass = 1.0 + mass * (peak - score).exp();
            peak = score;
        } else {
            mass += (score - peak).exp();
        }
        let mut candidate = Candidate { label, score };
        if label == '\0' {
            blank = candidate;
        } else {
            for rank in &mut ranked {
                if candidate.score > rank.score {
                    mem::swap(&mut candidate, rank);
                }
            }
        }
    }
    (blank, ranked, peak + mass.max(1.0).ln())
}

fn advance(path: Path, label: char, score: f32, x: u32, language: Option<&Model<'_>>) -> Path {
    let mut next = path;
    next.score += score;
    next.repeat = label != '\0';
    if next.repeat && (!path.repeat || path.last != label) {
        let left = if path.last.is_whitespace() {
            '\0'
        } else {
            path.last
        };
        let bonus = language.map_or(0.0, |model| model.transition(left, label));
        next.score += bonus * BIGRAM_WEIGHT;
        next.last = label;
        next.emission = Some(Emission {
            confidence: score.exp().clamp(0.0, 1.0),
            label,
            parent: path.node,
            x,
        });
    }
    next
}

#[cfg(test)]
mod tests {
    use super::Decoder;

    #[test]
    fn collapses_repeats_and_keeps_repeated_letters_separated_by_blank() {
        let mut decoder = Decoder::default();
        decoder.reset();
        let letter = [('\0', -12.0), ('a', 0.0)];
        decoder.step(3, letter.into_iter(), None);
        decoder.step(4, letter.into_iter(), None);
        decoder.step(5, [('\0', 0.0), ('a', -12.0)].into_iter(), None);
        decoder.step(6, letter.into_iter(), None);
        let mut letters = Vec::new();
        decoder.finish(|x, label, _| letters.push((x, label)));
        assert_eq!(letters, [(3, 'a'), (6, 'a')]);
    }
}
