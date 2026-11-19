extern crate alloc;

use alloc::collections::BTreeMap;
use core::{hint, iter, mem, str};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write as _};
use std::path::Path;
use std::process;
use std::time::Instant;

use crate::model::{
    Features, MAGIC, Metrics, Model, PROTOTYPE_BYTES, TRANSITION_BYTES, coordinate, distance,
    features, model,
};
use crate::network::{INPUTS, Shape, inputs};
use crate::neural_training;
use crate::raster::Bits;
use crate::recognize::{ink_box, recognize_line_with_model};
use crate::segment::{Line, WordBox};

const ARCHIVE_MAGIC: &[u8; 4] = b"OCRT";
const PROTOTYPES_PER_LABEL: usize = 12;
const MAX_PIXELS: usize = 32_000_000;
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;

#[derive(Debug)]
struct Label<'text> {
    bbox: [u32; 4],
    text: &'text str,
}

#[derive(Debug)]
struct Sample<'text> {
    glyphs: Vec<Label<'text>>,
    line: Line,
    page: Bits,
    words: Vec<Label<'text>>,
}

#[derive(Debug)]
struct Archive<'data> {
    data: &'data [u8],
    remaining: u32,
}

#[derive(Debug, Default)]
struct Evidence {
    bigrams: BTreeMap<(char, char), u32>,
    glyphs: BTreeMap<char, Vec<Features>>,
}

impl<'data> Archive<'data> {
    fn label(&mut self, width: u32, height: u32) -> Option<Label<'data>> {
        let left = self.number()?;
        let top = self.number()?;
        let right = self.number()?;
        let bottom = self.number()?;
        if left >= right || top >= bottom || right > width || bottom > height {
            return None;
        }
        let len = usize::try_from(self.number()?).ok()?;
        let text = str::from_utf8(self.take(len)?).ok()?;
        Some(Label {
            bbox: [left, top, right, bottom],
            text,
        })
    }

    fn new(bytes: &'data [u8]) -> Option<Self> {
        let data = bytes.strip_prefix(ARCHIVE_MAGIC)?;
        let mut archive = Self { data, remaining: 0 };
        archive.remaining = archive.number()?;
        Some(archive)
    }

    fn number(&mut self) -> Option<u32> {
        let (bytes, tail) = self.data.split_first_chunk()?;
        self.data = tail;
        Some(u32::from_le_bytes(*bytes))
    }

    fn sample(&mut self) -> Option<Sample<'data>> {
        let width = self.number()?;
        let height = self.number()?;
        let baseline = f32::from_bits(self.number()?);
        let x_height = f32::from_bits(self.number()?);
        let word_count = usize::try_from(self.number()?).ok()?;
        let glyph_count = usize::try_from(self.number()?).ok()?;
        let pixels = usize::try_from(width.checked_mul(height)?).ok()?;
        if pixels == 0
            || pixels > MAX_PIXELS
            || !baseline.is_finite()
            || !x_height.is_finite()
            || x_height <= 0.0
        {
            return None;
        }
        let page = pack(width, height, self.take(pixels)?)?;
        let words = iter::repeat_with(|| self.label(width, height))
            .take(word_count)
            .collect::<Option<Vec<_>>>()?;
        let glyphs = iter::repeat_with(|| self.label(width, height))
            .take(glyph_count)
            .collect::<Option<Vec<_>>>()?;
        let line = Line {
            baseline,
            bbox: [0, 0, width, height],
            block: 0,
            words: words
                .iter()
                .map(|label| WordBox { bbox: label.bbox })
                .collect(),
            x_height,
        };
        Some(Sample {
            glyphs,
            line,
            page,
            words,
        })
    }

    fn samples(mut self) -> io::Result<Vec<Sample<'data>>> {
        let remaining = usize::try_from(self.remaining).unwrap_or(usize::MAX);
        let samples = iter::repeat_with(|| {
            self.sample().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "malformed OCR training sample")
            })
        })
        .take(remaining)
        .collect::<io::Result<Vec<_>>>()?;
        if !self.data.is_empty() || samples.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "empty archive or trailing data",
            ));
        }
        Ok(samples)
    }
    fn take(&mut self, len: usize) -> Option<&'data [u8]> {
        let (bytes, tail) = self.data.split_at_checked(len)?;
        self.data = tail;
        Some(bytes)
    }
}

impl Evidence {
    fn add_word(&mut self, text: &str) {
        let mut previous = '\0';
        for label in text.chars() {
            if label.is_alphabetic() {
                let count = self.bigrams.entry((previous, label)).or_default();
                *count = count.saturating_add(1);
                previous = label;
            } else {
                previous = '\0';
            }
        }
    }

    fn collect(samples: &[Sample<'_>], corpus: &str) -> Self {
        let mut evidence = Self::default();
        for sample in samples {
            let metrics = Metrics {
                baseline: sample.line.baseline,
                x_height: sample.line.x_height,
            };
            for glyph in &sample.glyphs {
                let mut chars = glyph.text.chars();
                if let (Some(label), None) = (chars.next(), chars.next())
                    && let Some(bbox) = ink_box(&sample.page, glyph.bbox)
                {
                    evidence.glyphs.entry(label).or_default().push(features(
                        &sample.page,
                        bbox,
                        metrics,
                    ));
                }
            }
            for word in &sample.words {
                evidence.add_word(word.text);
            }
        }
        for word in corpus.split_whitespace() {
            evidence.add_word(word);
        }
        evidence
    }

    fn encode(self, seed: u64, hash: u64) -> Option<Vec<u8>> {
        let mut result = Vec::new();
        result.extend(MAGIC);
        result.extend(hash.to_le_bytes());
        result.extend(seed.to_le_bytes());
        let glyphs = self.glyphs;
        let count: usize = glyphs
            .values()
            .map(|group| PROTOTYPES_PER_LABEL.min(group.len()))
            .sum();
        result.extend(u32::try_from(count).ok()?.to_le_bytes());
        result.reserve(
            count
                .saturating_mul(PROTOTYPE_BYTES)
                .saturating_add(self.bigrams.len().saturating_mul(TRANSITION_BYTES)),
        );
        for (label, group) in glyphs {
            for sample in prototypes(&group, seed ^ u64::from(u32::from(label)))? {
                for word in sample.shape {
                    result.extend(word.to_le_bytes());
                }
                for value in sample.geometry {
                    result.extend(value.to_le_bytes());
                }
                result.extend(u32::from(label).to_le_bytes());
            }
        }
        Self::encode_transitions(self.bigrams, &mut result)?;
        Some(result)
    }

    fn encode_transitions(
        bigrams: BTreeMap<(char, char), u32>,
        result: &mut Vec<u8>,
    ) -> Option<()> {
        let mut contexts = BTreeMap::<char, u32>::new();
        for (&(previous, _), &frequency) in &bigrams {
            let total = contexts.entry(previous).or_default();
            *total = total.saturating_add(frequency);
        }
        for ((previous, label), frequency) in bigrams {
            if frequency < 3 {
                continue;
            }
            let total = contexts.get(&previous).copied()?;
            let probability = u32_ratio(frequency, total);
            let weight = (64.0 * probability).ln_1p().min(4.0) * 1.25;
            result.extend(u32::from(previous).to_le_bytes());
            result.extend(u32::from(label).to_le_bytes());
            result.extend(weight.to_le_bytes());
        }
        Some(())
    }
}

fn u32_ratio(part: u32, total: u32) -> f32 {
    let wide = |value| {
        let high = u16::try_from(value >> 16_u32).unwrap_or_default();
        let low = u16::try_from(value & 0xffff).unwrap_or_default();
        f32::from(high) * 65_536.0 + f32::from(low)
    };
    wide(part) / wide(total)
}

fn network_samples(
    samples: &[Sample<'_>],
    shape: Shape,
    glyphs: &mut neural_training::Samples,
    evidence: &mut Evidence,
    add_rejections: bool,
) {
    for sample in samples {
        let metrics = Metrics {
            baseline: sample.line.baseline,
            x_height: sample.line.x_height,
        };
        for glyph in &sample.glyphs {
            let mut chars = glyph.text.chars();
            if let (Some(label), None) = (chars.next(), chars.next())
                && !label.is_whitespace()
                && !label.is_control()
                && let Some(bounds) = ink_box(&sample.page, glyph.bbox)
            {
                glyphs
                    .entry(label)
                    .or_default()
                    .push(inputs(&sample.page, bounds, metrics, shape));
            }
        }
        if add_rejections {
            rejection_samples(sample, metrics, shape, glyphs.entry('\0').or_default());
        }
        for word in &sample.words {
            evidence.add_word(word.text);
        }
    }
}

fn rejection_samples(
    sample: &Sample<'_>,
    metrics: Metrics,
    shape: Shape,
    output: &mut Vec<[u8; INPUTS]>,
) {
    let mut words = sample.words.iter().peekable();
    for (index, pair) in sample.glyphs.windows(2).enumerate() {
        let [first, second] = pair else { continue };
        let [left, upper, right, lower] = first.bbox;
        let [next_left, next_top, next_right, next_bottom] = second.bbox;
        while words.peek().is_some_and(|word| {
            let [_, _, end, _] = word.bbox;
            end <= left
        }) {
            let _word = words.next();
        }
        let same_word = words.peek().is_some_and(|word| {
            let [start, _, end, _] = word.bbox;
            start <= left && next_right <= end
        });
        if !same_word
            || right > next_right
            || next_left < left
            || coordinate(next_left.saturating_sub(right)) > metrics.x_height * 0.24
        {
            continue;
        }
        let outcome = index.wrapping_add(usize::try_from(left).unwrap_or_default()) & 31;
        let region = match outcome {
            0 => [
                left,
                upper.min(next_top),
                next_right,
                lower.max(next_bottom),
            ],
            1 if right.saturating_sub(left) >= 4 => {
                [left, upper, u32::midpoint(left, right), lower]
            }
            _ => continue,
        };
        if let Some(bounds) = ink_box(&sample.page, region) {
            output.push(inputs(&sample.page, bounds, metrics, shape));
        }
    }
}

fn train_network(
    output: &Path,
    seed_arg: &OsString,
    shape_arg: &OsString,
    corpus: &Path,
    archives: &[OsString],
) -> io::Result<()> {
    let seed = seed_arg
        .to_str()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid seed"))?;
    let shape = match shape_arg.to_str() {
        Some("glyph") => Shape::Glyph,
        Some("line") => Shape::Line,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "shape must be glyph or line",
            ));
        }
    };
    let (add_rejections, inputs) = match archives {
        [first, rest @ ..] if first == "--reject" => (true, rest),
        _ => (false, archives),
    };
    let started = Instant::now();
    let mut evidence = Evidence::default();
    let mut glyphs = neural_training::Samples::new();
    let mut hash = FNV_OFFSET;
    for archive in inputs {
        let bytes = fs::read(archive)?;
        hash = digest(&bytes, hash);
        network_samples(
            &load(&bytes)?,
            shape,
            &mut glyphs,
            &mut evidence,
            add_rejections,
        );
        writeln!(
            io::stdout().lock(),
            "{}: {} glyphs",
            Path::new(archive).display(),
            glyphs.values().map(Vec::len).sum::<usize>()
        )?;
    }
    let corpus_text = fs::read_to_string(corpus)?;
    hash = digest(corpus_text.as_bytes(), hash);
    for word in corpus_text.split_whitespace() {
        evidence.add_word(word);
    }
    glyphs.retain(|_, examples| examples.len() >= 24);
    if glyphs.len() < 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "insufficient labeled glyphs",
        ));
    }
    let mut weights = neural_training::train(&glyphs, shape, seed, hash)
        .ok_or_else(|| io::Error::other("could not train neural classifier"))?;
    Evidence::encode_transitions(evidence.bigrams, &mut weights)
        .ok_or_else(|| io::Error::other("could not encode transition counts"))?;
    write_model(output, &weights)?;
    writeln!(
        io::stdout().lock(),
        "labels={} glyphs={} hash={hash:016x} seed={seed} bytes={} train_s={:.2}",
        glyphs.len(),
        glyphs.values().map(Vec::len).sum::<usize>(),
        weights.len(),
        started.elapsed().as_secs_f64()
    )
}

fn pack(width: u32, height: u32, bytes: &[u8]) -> Option<Bits> {
    let stride_words = usize::try_from(width.div_ceil(64)).ok()?;
    let mut words = Vec::new();
    for row in bytes.chunks(usize::try_from(width).ok()?) {
        words.extend(row.chunks(64).map(|chunk| {
            chunk
                .iter()
                .enumerate()
                .fold(0_u64, |packed, (index, &val)| {
                    packed | (u64::from(val != 0) << index)
                })
        }));
    }
    Some(Bits {
        height,
        stride_words,
        width,
        words,
    })
}

fn prototypes(group: &[Features], seed: u64) -> Option<Vec<Features>> {
    let limit = PROTOTYPES_PER_LABEL.min(group.len());
    let hash = seed.wrapping_mul(FNV_PRIME);
    let start = usize::try_from(hash.checked_rem(u64::try_from(group.len()).ok()?)?).ok()?;
    let mut selected = vec![false; group.len()];
    *selected.get_mut(start)? = true;
    let mut centers = vec![*group.get(start)?];
    let mut distances = vec![f32::INFINITY; group.len()];
    while centers.len() < limit {
        let center = centers.last()?;
        for (sample, nearest) in group.iter().zip(&mut distances) {
            *nearest = nearest.min(distance(sample, center));
        }
        let index = distances
            .iter()
            .zip(&selected)
            .enumerate()
            .filter(|(_, (_, chosen))| !**chosen)
            .max_by(|(_, (left, _)), (_, (right, _))| left.total_cmp(right))?
            .0;
        *selected.get_mut(index)? = true;
        centers.push(*group.get(index)?);
    }
    medoids(group, &mut centers)?;
    Some(centers)
}

fn medoids(group: &[Features], centers: &mut [Features]) -> Option<()> {
    let mut clusters = vec![Vec::new(); centers.len()];
    for sample in group {
        let (index, _) = centers
            .iter()
            .enumerate()
            .map(|(index, center)| (index, distance(sample, center)))
            .min_by(|(_, left), (_, right)| left.total_cmp(right))?;
        clusters.get_mut(index)?.push(sample);
    }
    for (center, members) in centers.iter_mut().zip(clusters) {
        if let Some(best) = members
            .iter()
            .map(|candidate| {
                let cost: f32 = members
                    .iter()
                    .map(|sample| distance(candidate, sample))
                    .sum();
                (candidate, cost)
            })
            .min_by(|(_, left), (_, right)| left.total_cmp(right))
        {
            *center = **best.0;
        }
    }
    Some(())
}

fn digest(bytes: &[u8], hash: u64) -> u64 {
    bytes.iter().fold(hash, |value, &byte| {
        (value ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    })
}

fn train(
    input: &Path,
    output: &Path,
    seed_arg: &OsString,
    corpus: Option<&OsString>,
) -> io::Result<()> {
    let seed = seed_arg
        .to_str()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "seed must be an unsigned integer",
            )
        })?;
    let started = Instant::now();
    let data = fs::read(input)?;
    let samples = load(&data)?;
    let corpus_text = corpus.map_or_else(|| Ok(String::new()), fs::read_to_string)?;
    let hash = digest(corpus_text.as_bytes(), digest(&data, FNV_OFFSET));
    let evidence = Evidence::collect(&samples, &corpus_text);
    let glyphs = evidence.glyphs.len();
    if glyphs == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "training archive has no labeled glyphs",
        ));
    }
    let model = evidence
        .encode(seed, hash)
        .ok_or_else(|| io::Error::other("could not derive prototypes"))?;
    write_model(output, &model)?;
    writeln!(
        io::stdout().lock(),
        "lines={} labels={glyphs} hash={hash:016x} seed={seed} bytes={} train_ms={:.2}",
        samples.len(),
        model.len(),
        started.elapsed().as_secs_f64() * 1000.0_f64
    )
}

fn write_model(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "model output must name a file")
    })?;
    let mut staging_name = name.to_os_string();
    staging_name.push(format!(".{}.tmp", process::id()));
    let staging = path.with_file_name(staging_name);
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&staging)?;
    let written = file.write_all(bytes);
    drop(file);
    let result = written.and_then(|()| fs::rename(&staging, path));
    if result.is_err() {
        let _cleanup = fs::remove_file(&staging);
    }
    result
}

fn load(data: &[u8]) -> io::Result<Vec<Sample<'_>>> {
    Archive::new(data)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid OCR training archive header",
            )
        })?
        .samples()
}

fn evaluate(input: &Path, model: Model<'_>) -> io::Result<()> {
    let data = fs::read(input)?;
    let samples = load(&data)?;
    let mut counts: BTreeMap<(char, char), usize> = BTreeMap::new();
    let mut characters = 0_usize;
    let mut line_edits = 0_usize;
    let mut exact_words = 0_usize;
    let mut total_words = 0_usize;
    for sample in &samples {
        let words = recognize_line_with_model(&sample.page, &sample.line, model);
        let reference_line: String = sample
            .words
            .iter()
            .flat_map(|word| word.text.chars())
            .filter(|label| !label.is_whitespace())
            .collect();
        let prediction: String = words
            .iter()
            .flat_map(|word| word.text.chars())
            .filter(|label| !label.is_whitespace())
            .collect();
        line_edits = line_edits.saturating_add(
            edit_distances(
                &reference_line.chars().collect::<Vec<_>>(),
                &prediction.chars().collect::<Vec<_>>(),
            )
            .last()
            .and_then(|row| row.last())
            .copied()
            .unwrap_or_default(),
        );
        let mut results = words.iter().peekable();
        for reference in &sample.words {
            let predicted = if results
                .peek()
                .is_some_and(|word| word.bbox == reference.bbox)
            {
                results.next().map_or("", |word| word.text.as_str())
            } else {
                ""
            };
            total_words = total_words.saturating_add(1);
            exact_words = exact_words.saturating_add(usize::from(predicted == reference.text));
            characters = characters.saturating_add(reference.text.chars().count());
            confusions(reference.text, predicted, &mut counts);
        }
    }
    let repetitions = 20_u32;
    let started = Instant::now();
    for _ in 0..repetitions {
        for sample in &samples {
            drop(hint::black_box(recognize_line_with_model(
                &sample.page,
                &sample.line,
                model,
            )));
        }
    }
    let elapsed = started.elapsed().as_secs_f64() * 1000.0_f64;
    let sample_count = u32::try_from(samples.len()).unwrap_or(u32::MAX);
    let line_ms = elapsed / (f64::from(repetitions) * f64::from(sample_count));
    let mut ranked: Vec<_> = counts.into_iter().collect();
    ranked.sort_unstable_by(|(pair_a, left), (pair_b, right)| {
        right.cmp(left).then_with(|| pair_a.cmp(pair_b))
    });
    let edits: usize = ranked.iter().map(|(_, count)| count).sum();
    let accuracy = 1.0_f64
        - f64::from(u32::try_from(edits).unwrap_or(u32::MAX))
            / f64::from(u32::try_from(characters.max(1)).unwrap_or(u32::MAX));
    let mut out = io::stdout().lock();
    writeln!(
        out,
        "lines={sample_count} characters={characters} edits={edits} accuracy={accuracy:.4} words={exact_words}/{total_words} ms_per_line={line_ms:.3} ms_per_50_lines={:.2}",
        line_ms * 50.0_f64
    )?;
    let line_accuracy = 1.0
        - u32_ratio(
            u32::try_from(line_edits).unwrap_or(u32::MAX),
            u32::try_from(characters.max(1)).unwrap_or(u32::MAX),
        );
    writeln!(
        out,
        "line_edits={line_edits} line_accuracy={line_accuracy:.4}"
    )?;
    let (matched_glyphs, total_glyphs) = oracle_glyphs(&samples, model);
    writeln!(
        out,
        "with_labeled_glyph_boxes={matched_glyphs}/{total_glyphs}"
    )?;
    let (timed, per_glyph_us) = classifier_timing(&samples, model);
    writeln!(
        out,
        "model_timed_glyphs={timed} model_us_per_glyph={per_glyph_us:.3}"
    )?;
    for ((expected, predicted), count) in ranked.into_iter().take(20) {
        writeln!(
            out,
            "{} -> {}: {count}",
            expected.escape_default(),
            predicted.escape_default()
        )?;
    }
    Ok(())
}

fn classifier_timing(samples: &[Sample<'_>], model: Model<'_>) -> (usize, f64) {
    let mut glyphs = Vec::new();
    for sample in samples {
        let metrics = Metrics {
            baseline: sample.line.baseline,
            x_height: sample.line.x_height,
        };
        for glyph in &sample.glyphs {
            if let Some(bounds) = ink_box(&sample.page, glyph.bbox) {
                glyphs.push((&sample.page, bounds, metrics));
            }
        }
    }
    let started = Instant::now();
    for _ in 0..5 {
        for &(page, bounds, metrics) in &glyphs {
            let _choices = hint::black_box(model.classify(page, bounds, metrics));
        }
    }
    let per_glyph_us = started.elapsed().as_secs_f64() * 200_000.0
        / f64::from(u32::try_from(glyphs.len().max(1)).unwrap_or(u32::MAX));
    (glyphs.len(), per_glyph_us)
}

fn oracle_glyphs(samples: &[Sample<'_>], model: Model<'_>) -> (usize, usize) {
    let mut matched = 0_usize;
    let mut total = 0_usize;
    for sample in samples {
        let metrics = Metrics {
            baseline: sample.line.baseline,
            x_height: sample.line.x_height,
        };
        for glyph in &sample.glyphs {
            let mut letters = glyph.text.chars();
            let (Some(expected), None) = (letters.next(), letters.next()) else {
                continue;
            };
            total = total.saturating_add(1);
            let Some(bbox) = ink_box(&sample.page, glyph.bbox) else {
                continue;
            };
            let choices = model.classify(&sample.page, bbox, metrics);
            if choices
                .first()
                .is_some_and(|choice| choice.label == expected)
            {
                matched = matched.saturating_add(1);
            }
        }
    }
    (matched, total)
}

fn inspect(input: &Path, output: &Path, model: Model<'_>) -> io::Result<()> {
    let bytes = fs::read(input)?;
    let samples = load(&bytes)?;
    fs::create_dir_all(output)?;
    let mut classes = BTreeMap::<char, (usize, usize)>::new();
    let mut sizes = BTreeMap::<u32, (usize, usize)>::new();
    let mut failures = 0_usize;
    for sample in &samples {
        let metrics = Metrics {
            baseline: sample.line.baseline,
            x_height: sample.line.x_height,
        };
        for glyph in &sample.glyphs {
            let (Some(label), None) = (glyph.text.chars().next(), glyph.text.chars().nth(1)) else {
                continue;
            };
            let Some(bounds) = ink_box(&sample.page, glyph.bbox) else {
                continue;
            };
            let [choice, ..] = model.classify(&sample.page, bounds, metrics);
            let correct = usize::from(choice.label == label);
            let [_, top, _, bottom] = bounds;
            let height_band = bottom.saturating_sub(top) >> 2_u32;
            for (matched, total) in [
                classes.entry(label).or_default(),
                sizes.entry(height_band).or_default(),
            ] {
                *matched = matched.saturating_add(correct);
                *total = total.saturating_add(1);
            }
            if correct == 0 && failures < 48 {
                let name = format!(
                    "{failures:03}-{:04x}-{:04x}.pgm",
                    u32::from(label),
                    u32::from(choice.label)
                );
                save_crop(&sample.page, bounds, &output.join(name))?;
                failures = failures.saturating_add(1);
            }
        }
    }
    let mut stdout = io::stdout().lock();
    for (label, (matched, total)) in classes {
        writeln!(
            stdout,
            "class={} matches={matched}/{total}",
            label.escape_default()
        )?;
    }
    for (height, (matched, total)) in sizes {
        writeln!(
            stdout,
            "glyph_height={}..{} matches={matched}/{total}",
            height << 2_u32,
            height.saturating_add(1) << 2_u32
        )?;
    }
    Ok(())
}

fn save_crop(page: &Bits, [left, top, right, bottom]: [u32; 4], path: &Path) -> io::Result<()> {
    let width = right.saturating_sub(left);
    let height = bottom.saturating_sub(top);
    let mut data = format!("P5\n{width} {height}\n255\n").into_bytes();
    for row in top..bottom {
        for column in left..right {
            data.push(if page.get(column, row) { 0 } else { 255 });
        }
    }
    fs::write(path, data)
}

fn confusions(expected: &str, predicted: &str, counts: &mut BTreeMap<(char, char), usize>) {
    let reference: Vec<_> = expected.chars().collect();
    let output: Vec<_> = predicted.chars().collect();
    let distances = edit_distances(&reference, &output);
    let mut row = reference.len();
    let mut col = output.len();
    while let Some(cost) = distances
        .get(row)
        .and_then(|values| values.get(col))
        .copied()
    {
        if cost == 0 {
            break;
        }
        let previous_row = row.saturating_sub(1);
        let previous_col = col.saturating_sub(1);
        let expected_char = reference.get(previous_row).copied().filter(|_| row > 0);
        let output_char = output.get(previous_col).copied().filter(|_| col > 0);
        let pair = match (expected_char, output_char) {
            (Some(left), Some(right))
                if cell(&distances, previous_row, previous_col)
                    .saturating_add(usize::from(left != right))
                    == cost =>
            {
                row = previous_row;
                col = previous_col;
                (left, right)
            }
            (Some(left), _) if cell(&distances, previous_row, col).saturating_add(1) == cost => {
                row = previous_row;
                (left, '\0')
            }
            (_, Some(right)) => {
                col = previous_col;
                ('\0', right)
            }
            (_, None) => break,
        };
        if pair.0 != pair.1 {
            let count = counts.entry(pair).or_default();
            *count = count.saturating_add(1);
        }
    }
}

fn edit_distances(reference: &[char], output: &[char]) -> Vec<Vec<usize>> {
    let mut previous: Vec<usize> = (0..=output.len()).collect();
    let mut distances = Vec::new();
    for (index, &left) in reference.iter().enumerate() {
        let mut row = vec![index.saturating_add(1)];
        for (&right, prior) in output.iter().zip(previous.windows(2)) {
            let [diagonal, above] = prior else {
                continue;
            };
            let deletion = above.saturating_add(1);
            let insertion = row.last().copied().unwrap_or(0).saturating_add(1);
            let substitution = diagonal.saturating_add(usize::from(left != right));
            row.push(deletion.min(insertion).min(substitution));
        }
        distances.push(mem::replace(&mut previous, row));
    }
    distances.push(previous);
    distances
}

fn cell(distances: &[Vec<usize>], row: usize, col: usize) -> usize {
    distances
        .get(row)
        .and_then(|items| items.get(col))
        .copied()
        .unwrap_or(usize::MAX)
}

fn valid_model(candidate: Option<Model<'_>>) -> io::Result<Model<'_>> {
    candidate.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "malformed OCR recognition table",
        )
    })
}

/// # Errors
/// Returns an I/O error for invalid arguments, malformed archives or failed file operations.
#[inline]
pub fn run(arguments: &[OsString]) -> io::Result<()> {
    match arguments {
        [command, output, seed, shape, corpus, archives @ ..] if command == "train-network" => {
            train_network(Path::new(output), seed, shape, Path::new(corpus), archives)
        }
        [command, archive, output, seed] if command == "train" => {
            train(Path::new(archive), Path::new(output), seed, None)
        }
        [command, archive, output, seed, corpus] if command == "train" => {
            train(Path::new(archive), Path::new(output), seed, Some(corpus))
        }
        [command, archive, output] if command == "inspect" => {
            inspect(Path::new(archive), Path::new(output), valid_model(model())?)
        }
        [command, archive, output, weights] if command == "inspect" => inspect(
            Path::new(archive),
            Path::new(output),
            valid_model(Model::decode(&fs::read(weights)?))?,
        ),
        [command, archive] if command == "evaluate" => {
            evaluate(Path::new(archive), valid_model(model())?)
        }
        [command, archive, weights] if command == "evaluate" => evaluate(
            Path::new(archive),
            valid_model(Model::decode(&fs::read(weights)?))?,
        ),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: pdf-core-ocr-train train-network <model.bin> <seed> <glyph|line> <corpus.txt> [--reject] <samples.ocrt>... | evaluate <samples.ocrt> [model.bin] | inspect <samples.ocrt> <crops-dir> [model.bin]",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_truncated_archive() {
        assert_eq!(
            load(b"OCRT\x01\x00\x00\x00").unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(run(&[]).unwrap_err().kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn counts_unicode_substitutions_insertions_and_deletions() {
        let mut counts = BTreeMap::new();
        confusions("a\u{e7}", "ac", &mut counts);
        confusions("a", "ax", &mut counts);
        confusions("bc", "b", &mut counts);
        assert_eq!(
            counts,
            BTreeMap::from([(('\u{e7}', 'c'), 1), (('\0', 'x'), 1), (('c', '\0'), 1)])
        );
    }
}
