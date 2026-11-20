use crate::model::coordinate;
use crate::raster::{Bits, Gray};
use crate::recognize::Word;
use crate::segment::Line;
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use crate::sequence::wasm_dot;
use crate::sequence::{Dot, LineWords, nonnegative_dot_kernel};

pub(crate) const MAGIC: &[u8; 4] = b"OCR4";
const FORMAT: u16 = 1;
const ARCHITECTURE: u16 = 1;
const INNER_HEIGHT: usize = 26;
const PADDING: usize = 3;
const HEIGHT: usize = 32;
const STRIDE: usize = 4;
const INPUT: usize = HEIGHT.saturating_mul(STRIDE);
const MAX_FRAMES: usize = 1024;
const CHANNELS: usize = 64;
const GROUP_WIDTH: usize = 16;
const GROUPS: usize = CHANNELS.saturating_div(GROUP_WIDTH);
const WINDOW: usize = 3_usize.saturating_mul(GROUP_WIDTH);
const MAX_CLASSES: usize = 512;
const ROW_HEADER: usize = 3;

type StemRow = [u8; INPUT.saturating_add(ROW_HEADER)];
type TemporalRow = [u8; WINDOW.saturating_add(ROW_HEADER)];
type HeadRow = [u8; CHANNELS.saturating_add(ROW_HEADER)];
type Activation = [[i8; GROUP_WIDTH]; GROUPS];

#[derive(Debug)]
pub(crate) struct Sequence<'model> {
    classes: &'model [[u8; 4]],
    dot: Dot,
    head: &'model [HeadRow],
    stem: &'model [StemRow],
    temporal: [&'model [TemporalRow]; 3],
}

#[derive(Debug)]
pub(crate) struct Scratch {
    first: Vec<Activation>,
    input: Vec<[i8; INPUT]>,
    logits: [i32; MAX_CLASSES],
    second: Vec<Activation>,
}

impl Default for Scratch {
    #[inline]
    fn default() -> Self {
        Self {
            input: Vec::with_capacity(MAX_FRAMES),
            first: Vec::with_capacity(MAX_FRAMES),
            second: Vec::with_capacity(MAX_FRAMES),
            logits: [0; MAX_CLASSES],
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Bounds {
    height: usize,
    left: usize,
    scaled: usize,
    top: usize,
    width: usize,
}

impl Bounds {
    fn of<Pixel>(area: [usize; 4], pixel: &Pixel) -> Option<Self>
    where
        Pixel: Fn(usize, usize) -> u8,
    {
        let [x0, y0, x1, y1] = area;
        let (mut left, mut top, mut right, mut bottom) = (x1, y1, x0, y0);
        for y in y0..y1 {
            for x in x0..x1 {
                if pixel(x, y) < 128 {
                    left = left.min(x);
                    top = top.min(y);
                    right = right.max(x.saturating_add(1));
                    bottom = bottom.max(y.saturating_add(1));
                }
            }
        }
        let width = right.checked_sub(left).filter(|&value| value != 0)?;
        let height = bottom.checked_sub(top).filter(|&value| value != 0)?;
        let scaled = width
            .saturating_mul(INNER_HEIGHT)
            .saturating_add(height.saturating_div(2))
            .checked_div(height)?
            .clamp(
                1,
                MAX_FRAMES
                    .saturating_mul(STRIDE)
                    .saturating_sub(PADDING.saturating_mul(2)),
            );
        Some(Self {
            height,
            left,
            scaled,
            top,
            width,
        })
    }

    fn source_x(self, column: usize) -> usize {
        let inner = column
            .saturating_sub(PADDING)
            .min(self.scaled.saturating_sub(1));
        self.left
            .saturating_add(center(inner, self.width, self.scaled))
    }
}

impl Scratch {
    fn normalize_gray(&mut self, gray: &Gray) -> &[[i8; INPUT]] {
        let width = usize::try_from(gray.width).unwrap_or_default();
        let height = usize::try_from(gray.height).unwrap_or_default();
        let rows = gray.pixels.chunks_exact(width.max(1));
        let pixel = |x: usize, y: usize| {
            rows.clone()
                .nth(y)
                .and_then(|row| row.get(x))
                .copied()
                .unwrap_or(u8::MAX)
        };
        let _bounds = normalize(
            [0, 0, width, height.min(rows.len())],
            &pixel,
            &mut self.input,
        );
        &self.input
    }
}

#[doc(hidden)]
#[derive(Debug)]
pub struct Probe<'input> {
    image: Gray,
    model: Sequence<'input>,
    scratch: Scratch,
}

impl<'input> Probe<'input> {
    #[inline]
    #[must_use]
    pub fn decode(packet: &'input [u8]) -> Option<Self> {
        let (header, payload) = packet.split_first_chunk::<12>()?;
        let ([width, height, table_length], []) = header.as_chunks::<4>() else {
            return None;
        };
        let (table, pixels) =
            payload.split_at_checked(usize::try_from(u32::from_le_bytes(*table_length)).ok()?)?;
        let model = Sequence::decode(table)?;
        let image = Gray::new(
            u32::from_le_bytes(*width),
            u32::from_le_bytes(*height),
            pixels.to_vec(),
        )
        .ok()?;
        Some(Self {
            image,
            model,
            scratch: Scratch::default(),
        })
    }

    #[inline]
    #[must_use]
    pub fn fixture(&mut self) -> Vec<u8> {
        let normalized = self.scratch.normalize_gray(&self.image);
        let size = normalized.len().saturating_mul(INPUT);
        let mut result = Vec::new();
        result.extend(u32::try_from(size).unwrap_or_default().to_le_bytes());
        result.extend(
            normalized
                .as_flattened()
                .iter()
                .copied()
                .flat_map(i8::to_le_bytes),
        );
        self.model.logits(&mut self.scratch, |scores| {
            result.extend(scores.iter().flat_map(|score| score.to_le_bytes()));
        });
        result
    }

    #[inline]
    pub fn transcript<Observe>(&mut self, observe: Observe)
    where
        Observe: FnMut(char),
    {
        self.model
            .decode_gray(&self.image, &mut self.scratch, observe);
    }
}

impl<'model> Sequence<'model> {
    pub(crate) fn decode(bytes: &'model [u8]) -> Option<Self> {
        let header = bytes.strip_prefix(MAGIC)?;
        let (format, body) = header.split_first_chunk::<2>()?;
        let (architecture, metadata) = body.split_first_chunk::<2>()?;
        if u16::from_le_bytes(*format) != FORMAT
            || u16::from_le_bytes(*architecture) != ARCHITECTURE
        {
            return None;
        }
        let (class_count, payload) = metadata.get(60..)?.split_first_chunk::<2>()?;
        let count = usize::from(u16::from_le_bytes(*class_count));
        if !(2..=MAX_CLASSES).contains(&count) {
            return None;
        }
        let (labels, parameters) = payload.split_at_checked(count.checked_mul(4)?)?;
        let (classes, []) = labels.as_chunks::<4>() else {
            return None;
        };
        if classes.first() != Some(&[0; 4])
            || !classes.iter().skip(1).all(|raw| {
                char::from_u32(u32::from_le_bytes(*raw))
                    .is_some_and(|char| char != '\0' && !char.is_control())
            })
            || !classes.windows(2).all(|pair| {
                let [left, right] = pair else {
                    return false;
                };
                u32::from_le_bytes(*left) < u32::from_le_bytes(*right)
            })
        {
            return None;
        }
        let (stem, after_stem) = layer_rows(parameters, CHANNELS)?;
        let (first, after_first) = layer_rows(after_stem, CHANNELS)?;
        let (second, after_second) = layer_rows(after_first, CHANNELS)?;
        let (third, after_third) = layer_rows(after_second, CHANNELS)?;
        let (head, []) = layer_rows(after_third, count)? else {
            return None;
        };
        Some(Self {
            classes,
            head,
            stem,
            temporal: [first, second, third],
            dot: nonnegative_dot_kernel(),
        })
    }

    fn decode_gray<Observe>(&self, gray: &Gray, scratch: &mut Scratch, mut observe: Observe)
    where
        Observe: FnMut(char),
    {
        let _normalized = scratch.normalize_gray(gray);
        self.greedy(scratch, |_, character, _| observe(character));
    }

    fn greedy<Observe>(&self, scratch: &mut Scratch, mut emit: Observe)
    where
        Observe: FnMut(usize, char, u32),
    {
        let mut frame = 0_usize;
        let mut selected = (0_usize, 0_usize, 0_u32);
        let mut flush = |(class, position, margin)| {
            if class != 0
                && let Some(label) = self.classes.get(class)
                && let Some(character) = char::from_u32(u32::from_le_bytes(*label))
            {
                emit(position, character, margin);
            }
        };
        self.logits(scratch, |scores| {
            let (mut best, mut second, mut class) = (i32::MIN, i32::MIN, 0);
            for (index, &score) in scores.iter().enumerate() {
                if score > best {
                    (best, second, class) = (score, best, index);
                } else {
                    second = second.max(score);
                }
            }
            let margin = best.abs_diff(second);
            if class != selected.0 {
                flush(selected);
                selected = (class, frame, margin);
            } else if margin > selected.2 {
                selected = (class, frame, margin);
            }
            frame = frame.saturating_add(1);
        });
        flush(selected);
    }

    fn logits<Observe>(&self, scratch: &mut Scratch, mut observe: Observe)
    where
        Observe: FnMut(&[i32]),
    {
        let [first, second, third] = self.temporal;
        scratch.first.clear();
        scratch.first.extend(scratch.input.iter().map(|input| {
            let mut output = Activation::default();
            for (value, row) in output.as_flattened_mut().iter_mut().zip(self.stem) {
                *value = relu(project(self.dot, input, row));
            }
            output
        }));
        temporal(self.dot, first, 1, &scratch.first, &mut scratch.second);
        temporal(self.dot, second, 3, &scratch.second, &mut scratch.first);
        temporal(self.dot, third, 9, &scratch.first, &mut scratch.second);

        let Some(scores) = scratch.logits.get_mut(..self.classes.len()) else {
            return;
        };
        for activation in &scratch.second {
            for (value, row) in scores.iter_mut().zip(self.head) {
                *value = project(self.dot, activation.as_flattened(), row);
            }
            observe(scores);
        }
    }

    pub(crate) fn words(&self, page: &Bits, line: &Line, scratch: &mut Scratch) -> Vec<Word> {
        let mut words = LineWords::new(line);
        let [left, top, right, bottom] = line.bbox;
        let area = [left, top, right.min(page.width), bottom.min(page.height)]
            .map(|edge| usize::try_from(edge).unwrap_or_default());
        let pixel = |x: usize, y: usize| {
            let in_bounds = u32::try_from(x).ok().zip(u32::try_from(y).ok());
            if in_bounds.is_some_and(|(xx, yy)| page.get(xx, yy)) {
                0
            } else {
                u8::MAX
            }
        };
        if let Some(bounds) = normalize(area, &pixel, &mut scratch.input) {
            self.greedy(scratch, |frame, character, margin| {
                let col = frame
                    .saturating_mul(STRIDE)
                    .saturating_add(STRIDE.saturating_div(2));
                let x = u32::try_from(bounds.source_x(col)).unwrap_or(left);
                let gap = coordinate(margin);
                words.push(x, character, gap / (gap + 256.0));
            });
        }
        words.finish()
    }
}

fn center(index: usize, src: usize, dst: usize) -> usize {
    index
        .saturating_mul(2)
        .saturating_add(1)
        .saturating_mul(src)
        .checked_div(dst.saturating_mul(2))
        .unwrap_or_default()
}

fn normalize<Pixel>(
    area: [usize; 4],
    pixel: &Pixel,
    frames: &mut Vec<[i8; INPUT]>,
) -> Option<Bounds>
where
    Pixel: Fn(usize, usize) -> u8,
{
    frames.clear();
    let Some(bounds) = Bounds::of(area, pixel) else {
        frames.push([0; INPUT]);
        return None;
    };
    let padded_width = bounds.scaled.saturating_add(PADDING.saturating_mul(2));
    frames.resize(padded_width.div_ceil(STRIDE), [0; INPUT]);
    for (x, column) in frames
        .iter_mut()
        .flat_map(|frame| frame.as_chunks_mut::<HEIGHT>().0)
        .enumerate()
        .skip(PADDING)
        .take(bounds.scaled)
    {
        let source_x = bounds.source_x(x);
        for (y, output) in column
            .iter_mut()
            .skip(PADDING)
            .take(INNER_HEIGHT)
            .enumerate()
        {
            let source_y = bounds
                .top
                .saturating_add(center(y, bounds.height, INNER_HEIGHT));
            let intensity = u8::MAX.saturating_sub(pixel(source_x, source_y)) >> 1_u8;
            *output = i8::from_le_bytes([intensity]);
        }
    }
    Some(bounds)
}

fn layer_rows<const SIZE: usize>(bytes: &[u8], count: usize) -> Option<(&[[u8; SIZE]], &[u8])> {
    let (rows, tail) = bytes.split_at_checked(count.checked_mul(SIZE)?)?;
    let (records, []) = rows.as_chunks::<SIZE>() else {
        return None;
    };
    records
        .iter()
        .all(|row| row.get(2).is_some_and(|&shift| shift <= 24))
        .then_some((records, tail))
}

fn temporal(
    dot: Dot,
    rows: &[TemporalRow],
    dilation: usize,
    input: &[Activation],
    output: &mut Vec<Activation>,
) {
    output.clear();
    for (index, current) in input.iter().enumerate() {
        let previous = index
            .checked_sub(dilation)
            .and_then(|frame| input.get(frame));
        let next = input.get(index.saturating_add(dilation));
        let zeros = Activation::default();
        let mut result = [[0_i8; GROUPS]; GROUP_WIDTH];
        for (group, (((left, middle), right), weights)) in previous
            .unwrap_or(&zeros)
            .iter()
            .zip(current)
            .zip(next.unwrap_or(&zeros))
            .zip(rows.as_chunks::<GROUP_WIDTH>().0)
            .enumerate()
        {
            let window = [*left, *middle, *right];
            for (shuffled, row) in result.iter_mut().zip(weights) {
                if let Some(slot) = shuffled.get_mut(group) {
                    *slot = relu(project(dot, window.as_flattened(), row));
                }
            }
        }
        let mut groups = Activation::default();
        groups
            .as_flattened_mut()
            .copy_from_slice(result.as_flattened());
        output.push(groups);
    }
}

fn relu(value: i32) -> i8 {
    i8::try_from(value.clamp(0, 127)).unwrap_or_default()
}

#[inline]
fn project<const SIZE: usize>(dot: Dot, input: &[i8], row: &[u8; SIZE]) -> i32 {
    let Some(([low, high, shift], weights)) = row.split_first_chunk::<ROW_HEADER>() else {
        return 0;
    };
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    let sum = dot(input, weights);
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    let sum = {
        let _fallback = dot;
        wasm_dot(input, weights)
    };
    let half = 1_i32.wrapping_shl(u32::from(shift.saturating_sub(1)));
    let rounded = if *shift == 0 {
        sum
    } else {
        sum.wrapping_add(half).wrapping_shr(u32::from(*shift))
    };
    rounded.wrapping_add(i32::from(i16::from_le_bytes([*low, *high])))
}

#[cfg(test)]
mod tests {
    use super::{CHANNELS, INPUT, Probe, ROW_HEADER, WINDOW};

    #[test]
    fn line_probe_decodes_a_signed_projection_and_checks_the_table() {
        let mut table = b"OCR4\x01\0\x01\0".to_vec();
        table.extend([0; 60]);
        table.extend(2_u16.to_le_bytes());
        table.extend(0_u32.to_le_bytes());
        table.extend(65_u32.to_le_bytes());
        for row_size in [INPUT, WINDOW, WINDOW, WINDOW] {
            table.resize(
                table
                    .len()
                    .saturating_add(CHANNELS.saturating_mul(row_size.saturating_add(ROW_HEADER))),
                0,
            );
        }
        table.extend([0; CHANNELS.saturating_add(ROW_HEADER)]);
        table.extend([1, 0, 0]);
        table.extend([0; CHANNELS]);
        let mut packet = Vec::new();
        packet.extend(10_u32.to_le_bytes());
        packet.extend(10_u32.to_le_bytes());
        packet.extend(u32::try_from(table.len()).unwrap_or_default().to_le_bytes());
        packet.extend(&table);
        packet.extend([0; 100]);
        let probe = Probe::decode(&packet);
        assert!(probe.is_some());
        if let Some(mut valid) = probe {
            let mut text = String::new();
            valid.transcript(|character| text.push(character));
            assert_eq!(text, "A");
            assert!(valid.fixture().len() > 4);
        }
        let _removed = packet.pop();
        assert!(Probe::decode(&packet).is_none());
    }
}
