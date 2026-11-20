use core::mem;

use crate::model::coordinate;
use crate::raster::Gray;
use crate::recognize::Word;
use crate::segment::Line;
use crate::sequence::{Dot, LineWords, nonnegative_dot_kernel, scalar_dot};
use crate::sequence_v4::{
    Bounds, INPUT, MAX_CLASSES, MAX_FRAMES, ROW_HEADER, STRIDE, greedy, labels, layer_rows,
    normalize, project, relu,
};

pub(crate) const MAGIC: &[u8; 4] = b"OCR5";
const WIDTH: usize = 384;
const LOCAL: usize = 64;
const GROUP_WIDTH: usize = 16;
const MAX_PACKED: usize = 1024;
const SLOPES: [i32; 13] = [0, -16, 16, -32, 32, -48, 48, -64, 64, -80, 80, -96, 96];

type Activations = [i8; WIDTH];
type Fine = [i8; LOCAL];
type StemRow = [u8; INPUT.saturating_add(ROW_HEADER)];
type LocalRow = [u8; GROUP_WIDTH.saturating_mul(3).saturating_add(ROW_HEADER)];
type DepthRow = [u8; 3_usize.saturating_add(ROW_HEADER)];
type MatrixRow = [u8; WIDTH.saturating_add(ROW_HEADER)];
type HeadRow = [u8; LOCAL.saturating_add(ROW_HEADER)];

#[derive(Debug)]
struct Downsample<'table> {
    data: &'table [u8],
    group: usize,
    phase: usize,
}

#[derive(Debug)]
struct Block<'table> {
    depth: &'table [DepthRow],
    dilation: usize,
    mixer: &'table [MatrixRow],
}

#[derive(Debug)]
pub(super) struct Sequence<'table> {
    blocks: [Option<Block<'table>>; 4],
    classes: &'table [[u8; 4]],
    dot: Dot,
    down: Downsample<'table>,
    head: &'table [HeadRow],
    local: &'table [LocalRow],
    stem: &'table [StemRow],
    up: &'table [MatrixRow],
}

#[derive(Debug)]
pub(super) struct Scratch {
    coarse: Vec<Activations>,
    fine: Vec<Fine>,
    input: Vec<[i8; INPUT]>,
    intermediate: Vec<Fine>,
    next_coarse: Vec<Activations>,
    points: Vec<(usize, usize)>,
    projection: Vec<u32>,
    scores: Box<[i32; MAX_CLASSES]>,
    shifts: Vec<i32>,
}

impl Default for Scratch {
    fn default() -> Self {
        Self {
            coarse: Vec::with_capacity(MAX_FRAMES.div_ceil(8)),
            next_coarse: Vec::with_capacity(MAX_FRAMES.div_ceil(8)),
            fine: Vec::with_capacity(MAX_FRAMES),
            input: Vec::with_capacity(MAX_FRAMES),
            intermediate: Vec::with_capacity(MAX_FRAMES),
            points: Vec::new(),
            projection: Vec::new(),
            shifts: Vec::new(),
            scores: Box::new([0; MAX_CLASSES]),
        }
    }
}

impl Scratch {
    fn normalize<Pixel>(&mut self, width: usize, height: usize, pixel: Pixel) -> Option<Bounds>
    where
        Pixel: Fn(usize, usize) -> u8,
    {
        let mut tones = [0_usize; 256];
        for y in (0..height).step_by(4) {
            for x in (0..width).step_by(4) {
                if let Some(count) = tones.get_mut(usize::from(pixel(x, y))) {
                    *count = count.saturating_add(1);
                }
            }
        }
        let mut median = width.div_ceil(4).saturating_mul(height.div_ceil(4)) >> 1_u32;
        let paper = tones
            .iter()
            .position(|&count| {
                let found = count > median;
                median = median.saturating_sub(count);
                found
            })
            .and_then(|tone| u8::try_from(tone).ok())
            .unwrap_or(u8::MAX);
        let cutoff = paper.saturating_sub(43).clamp(72, 196);
        let mut slope = 0_i32;
        self.points.clear();
        if width >= 80 {
            for x in (1..width).step_by(4) {
                for y in 0..height {
                    if pixel(x, y) < cutoff {
                        self.points.push((x, y));
                    }
                }
            }
            if self.points.len() >= 16 {
                let padding = skew_shift(0, width, 96).unsigned_abs();
                let pad = usize::try_from(padding).unwrap_or_default();
                self.projection
                    .resize(height.saturating_add(pad.saturating_mul(2)), 0);
                let mut score = 0;
                for candidate in SLOPES {
                    self.projection.fill(0);
                    for &(x, y) in &self.points {
                        let row = y.saturating_add(pad).saturating_add_signed(
                            isize::try_from(skew_shift(x, width, candidate).saturating_neg())
                                .unwrap_or_default(),
                        );
                        if let Some(count) = self.projection.get_mut(row) {
                            *count = count.saturating_add(1);
                        }
                    }
                    let energy = self.projection.iter().fold(0_u64, |sum, &count| {
                        sum.saturating_add(u64::from(count).saturating_pow(2))
                    });
                    if energy > score {
                        (score, slope) = (energy, candidate);
                    }
                }
            }
        }
        if slope == 0_i32 {
            return normalize(
                [0, 0, width, height],
                cutoff,
                paper,
                &pixel,
                &mut self.input,
            );
        }
        self.shifts.clear();
        self.shifts
            .extend((0..width).map(|x| skew_shift(x, width, slope)));
        let pad = usize::try_from(skew_shift(0, width, slope).unsigned_abs()).unwrap_or_default();
        let aligned = |x: usize, y: usize| {
            self.shifts
                .get(x)
                .and_then(|&shift| {
                    let row = i64::try_from(y)
                        .ok()?
                        .checked_add(i64::from(shift))?
                        .checked_sub(i64::try_from(pad).ok()?)?;
                    usize::try_from(row).ok().filter(|&source| source < height)
                })
                .map_or(paper, |row| pixel(x, row))
        };
        normalize(
            [0, 0, width, height.saturating_add(pad.saturating_mul(2))],
            cutoff,
            paper,
            &aligned,
            &mut self.input,
        )
    }
}

impl<'table> Sequence<'table> {
    pub(super) fn decode(table: &'table [u8]) -> Option<Self> {
        let header = table.strip_prefix(MAGIC)?;
        let (format, body) = header.split_first_chunk::<2>()?;
        let (architecture, metadata) = body.split_first_chunk::<2>()?;
        if *format != [1, 0] {
            return None;
        }
        let (group, phase, dilations): (_, _, &[usize]) = match *architecture {
            [1, 0] => (8_usize, LOCAL, &[1, 2, 4, 8]),
            [2, 0] => (16_usize, LOCAL, &[1, 2, 4]),
            [3, 0] => (32_usize, 32_usize, &[1, 3]),
            _ => return None,
        };
        let (class_count, payload) = metadata.get(60..)?.split_first_chunk::<2>()?;
        let count = usize::from(u16::from_le_bytes(*class_count));
        if !(2..=MAX_CLASSES).contains(&count) {
            return None;
        }
        let (classes, parameters) = labels(payload, count)?;
        let (stem, after_stem) = layer_rows(parameters, LOCAL)?;
        let (local, after_local) = layer_rows(after_stem, LOCAL)?;
        let stride = group.checked_mul(phase)?.checked_add(ROW_HEADER)?;
        let (data, mut tail) = after_local.split_at_checked(stride.checked_mul(WIDTH)?)?;
        if data
            .chunks_exact(stride)
            .any(|row| row.get(2).is_none_or(|&shift| shift > 24))
        {
            return None;
        }
        let mut blocks = [None, None, None, None];
        for (slot, &dilation) in blocks.iter_mut().zip(dilations) {
            let (depth, after_depth) = layer_rows(tail, WIDTH)?;
            let (mixer, rest) = layer_rows(after_depth, WIDTH)?;
            *slot = Some(Block {
                depth,
                dilation,
                mixer,
            });
            tail = rest;
        }
        let (up, after_up) = layer_rows(tail, group.checked_mul(phase)?)?;
        let (head, []) = layer_rows(after_up, count)? else {
            return None;
        };
        Some(Self {
            blocks,
            classes,
            dot: nonnegative_dot_kernel(),
            down: Downsample { data, group, phase },
            head,
            local,
            stem,
            up,
        })
    }

    pub(super) fn fixture(&self, image: &Gray, scratch: &mut Scratch) -> Vec<u8> {
        Self::input(scratch, image);
        let size = scratch.input.len().saturating_mul(INPUT);
        let mut result = u32::try_from(size)
            .unwrap_or_default()
            .to_le_bytes()
            .to_vec();
        result.extend(
            scratch
                .input
                .as_flattened()
                .iter()
                .copied()
                .flat_map(i8::to_le_bytes),
        );
        self.logits(scratch, |scores| {
            result.extend(scores.iter().flat_map(|score| score.to_le_bytes()));
        });
        result
    }

    fn input(scratch: &mut Scratch, image: &Gray) {
        let width = usize::try_from(image.width).unwrap_or_default();
        let height = usize::try_from(image.height).unwrap_or_default();
        let _bounds = scratch.normalize(width, height, |x, y| {
            image
                .pixels
                .get(y.saturating_mul(width).saturating_add(x))
                .copied()
                .unwrap_or(255)
        });
    }

    fn logits<Observe>(&self, scratch: &mut Scratch, mut observe: Observe)
    where
        Observe: FnMut(&[i32]),
    {
        let dot = self.dot;
        scratch.intermediate.clear();
        scratch
            .intermediate
            .extend(scratch.input.iter().map(|input| {
                let mut output = [0; LOCAL];
                mix(dot, input, self.stem, &mut output);
                output
            }));
        scratch.fine.clear();
        let zero = [0; LOCAL];
        for (index, current) in scratch.intermediate.iter().enumerate() {
            let left = index
                .checked_sub(1)
                .and_then(|previous| scratch.intermediate.get(previous))
                .unwrap_or(&zero);
            let right = scratch
                .intermediate
                .get(index.saturating_add(1))
                .unwrap_or(&zero);
            let mut output = *current;
            for (((a, b), c), (rows, slots)) in left
                .as_chunks::<GROUP_WIDTH>()
                .0
                .iter()
                .zip(current.as_chunks::<GROUP_WIDTH>().0)
                .zip(right.as_chunks::<GROUP_WIDTH>().0)
                .zip(
                    self.local
                        .as_chunks::<GROUP_WIDTH>()
                        .0
                        .iter()
                        .zip(output.as_chunks_mut::<GROUP_WIDTH>().0),
                )
            {
                let taps = [*a, *b, *c];
                for (slot, row) in slots.iter_mut().zip(rows) {
                    *slot = slot.saturating_add(relu(project(dot, taps.as_flattened(), row)));
                }
            }
            scratch.fine.push(output);
        }
        scratch.coarse.clear();
        let group = self.down.group;
        let phase = self.down.phase;
        let inputs = group.saturating_mul(phase);
        let row_size = inputs.saturating_add(ROW_HEADER);
        let mut packed = [0_i8; MAX_PACKED];
        let Some(input) = packed.get_mut(..inputs) else {
            return;
        };
        for window in scratch.fine.chunks(group) {
            let mut segments = input.chunks_exact_mut(phase);
            for (source, destination) in window.iter().zip(segments.by_ref()) {
                let Some(prefix) = source.get(..phase) else {
                    return;
                };
                destination.copy_from_slice(prefix);
            }
            for remaining in segments {
                remaining.fill(0);
            }
            let mut output = [0; WIDTH];
            for (slot, row) in output.iter_mut().zip(self.down.data.chunks_exact(row_size)) {
                *slot = relu(project(dot, input, row));
            }
            scratch.coarse.push(output);
        }
        let mut depthwise = [0; WIDTH];
        let mut mixed = [0; WIDTH];
        let zeros = [0; WIDTH];
        for block in self.blocks.iter().flatten() {
            scratch.next_coarse.clear();
            for (index, current) in scratch.coarse.iter().enumerate() {
                let prev = index
                    .checked_sub(block.dilation)
                    .and_then(|previous| scratch.coarse.get(previous))
                    .unwrap_or(&zeros);
                let next = scratch
                    .coarse
                    .get(index.saturating_add(block.dilation))
                    .unwrap_or(&zeros);
                for ((((slot, &a), &b), &c), row) in depthwise
                    .iter_mut()
                    .zip(prev)
                    .zip(current)
                    .zip(next)
                    .zip(block.depth)
                {
                    *slot = relu(project(scalar_dot, &[a, b, c], row));
                }
                mix(dot, &depthwise, block.mixer, &mut mixed);
                for (slot, &prior) in mixed.iter_mut().zip(current) {
                    *slot = slot.saturating_add(prior);
                }
                scratch.next_coarse.push(mixed);
            }
            mem::swap(&mut scratch.coarse, &mut scratch.next_coarse);
        }
        let Some(scores) = scratch.scores.get_mut(..self.classes.len()) else {
            return;
        };
        for (coarse, frames) in scratch.coarse.iter().zip(scratch.fine.chunks_mut(group)) {
            for (fine, rows) in frames.iter_mut().zip(self.up.chunks_exact(phase)) {
                for (slot, row) in fine.iter_mut().zip(rows) {
                    *slot = slot.saturating_add(relu(project(dot, coarse, row)));
                }
                for (slot, row) in scores.iter_mut().zip(self.head) {
                    *slot = project(dot, fine, row);
                }
                observe(scores);
            }
        }
    }

    pub(super) fn transcript<Observe>(
        &self,
        image: &Gray,
        scratch: &mut Scratch,
        mut observe: Observe,
    ) where
        Observe: FnMut(char),
    {
        Self::input(scratch, image);
        greedy(
            self.classes,
            |step| self.logits(scratch, step),
            |_, char, _| observe(char),
        );
    }
    pub(super) fn words<Pixel>(
        &self,
        line: &Line,
        scratch: &mut Scratch,
        sample: Pixel,
    ) -> Vec<Word>
    where
        Pixel: Fn(u32, u32) -> u8,
    {
        let mut words = LineWords::new(line);
        let [left, top, right, bottom] = line.bbox;
        let width = usize::try_from(right.saturating_sub(left)).unwrap_or_default();
        let height = usize::try_from(bottom.saturating_sub(top)).unwrap_or_default();
        let pixel = |x: usize, y: usize| {
            sample(
                left.saturating_add(u32::try_from(x).unwrap_or(u32::MAX)),
                top.saturating_add(u32::try_from(y).unwrap_or(u32::MAX)),
            )
        };
        if let Some(bounds) = scratch.normalize(width, height, pixel) {
            greedy(
                self.classes,
                |step| self.logits(scratch, step),
                |frame, char, margin| {
                    let col = frame
                        .saturating_mul(STRIDE)
                        .saturating_add(STRIDE.saturating_div(2));
                    let x = left
                        .saturating_add(u32::try_from(bounds.source_x(col)).unwrap_or_default());
                    let gap = coordinate(margin);
                    words.push(x, char, gap / (gap + 256.0));
                },
            );
        }
        words.finish()
    }
}

fn mix<const SIZE: usize>(dot: Dot, input: &[i8], weights: &[[u8; SIZE]], output: &mut [i8]) {
    for (slot, row) in output.iter_mut().zip(weights) {
        *slot = relu(project(dot, input, row));
    }
}

fn skew_shift(x: usize, width: usize, slope: i32) -> i32 {
    let signed = i32::try_from(x)
        .unwrap_or(i32::MAX)
        .saturating_sub(i32::try_from(width >> 1_u32).unwrap_or(i32::MAX))
        .saturating_mul(slope);
    let magnitude = signed.unsigned_abs().saturating_add(1024) >> 11_u32;
    i32::try_from(magnitude)
        .unwrap_or_default()
        .saturating_mul(signed.signum())
}
