use core::array;

use crate::raster::{Gray, RasterError, pixel_count};

const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum DecodeError {
    Format,
    Raster(RasterError),
    Unsupported,
}

type Decode<Value> = Result<Value, DecodeError>;

struct Entropy<'data> {
    available: u32,
    buffer: u32,
    input: &'data [u8],
}

impl Entropy<'_> {
    #[expect(
        clippy::arithmetic_side_effects,
        reason = "JPEG amplitudes fit at most eleven bits"
    )]
    fn amplitude(&mut self, size: u8, max: u8) -> Decode<i32> {
        if size > max {
            return Err(DecodeError::Format);
        }
        if size == 0 {
            return Ok(0);
        }
        let raw =
            i32::try_from(self.read(u32::from(size))?).map_err(|_cause| DecodeError::Format)?;
        let limit = 1_i32 << size;
        Ok(if raw < (limit >> 1_u32) {
            raw + 1 - limit
        } else {
            raw
        })
    }

    fn fill(&mut self, count: u32) {
        while self.available < count {
            let Some((&value, rest)) = self.input.split_first() else {
                break;
            };
            self.input = if value == 0xff {
                let Some((&0, after_escape)) = rest.split_first() else {
                    break;
                };
                after_escape
            } else {
                rest
            };
            self.buffer = self.buffer.wrapping_shl(8) | u32::from(value);
            self.available = self.available.saturating_add(8);
        }
    }

    const fn peek(&self, count: u32) -> u32 {
        self.buffer
            .wrapping_shr(self.available.saturating_sub(count))
            & 1_u32.wrapping_shl(count).wrapping_sub(1)
    }

    fn read(&mut self, count: u32) -> Decode<u32> {
        self.fill(count);
        if count > self.available {
            return Err(DecodeError::Format);
        }
        let value = self.peek(count);
        self.available = self.available.saturating_sub(count);
        Ok(value)
    }
}

#[derive(Clone, Copy)]
struct CodeLength {
    end: u32,
    offset: usize,
    start: u32,
}

struct Huffman {
    lengths: [CodeLength; 16],
    short_codes: [u16; 256],
    symbols: Vec<u8>,
}

impl Huffman {
    #[expect(
        clippy::arithmetic_side_effects,
        reason = "canonical lengths and offsets are bounded by the codebook"
    )]
    fn decode(&self, entropy: &mut Entropy<'_>) -> Decode<u8> {
        entropy.fill(8);
        if entropy.available >= 8 {
            let index = usize::try_from(entropy.peek(8)).map_err(|_cause| DecodeError::Format)?;
            let &entry = self.short_codes.get(index).ok_or(DecodeError::Format)?;
            if entry != 0 {
                entropy.available -= u32::from(entry >> 8_u32);
                return Ok(entry.to_le_bytes().first().copied().unwrap_or_default());
            }
        }
        let mut code = 0_u32;
        for entry in self.lengths {
            code = (code << 1_u32) | entropy.read(1)?;
            if (entry.start..entry.end).contains(&code) {
                let index =
                    usize::try_from(code - entry.start).map_err(|_cause| DecodeError::Format)?;
                return self
                    .symbols
                    .get(entry.offset + index)
                    .copied()
                    .ok_or(DecodeError::Format);
            }
        }
        Err(DecodeError::Format)
    }

    #[expect(
        clippy::arithmetic_side_effects,
        reason = "canonical codes are at most sixteen bits"
    )]
    fn parse(input: &mut &[u8]) -> Decode<Self> {
        let counts = take(input, 16)?;
        let total: usize = counts.iter().copied().map(usize::from).sum();
        if total == 0 || total > 256 {
            return Err(DecodeError::Format);
        }
        let symbols = take(input, total)?.to_vec();
        let mut lengths = [CodeLength {
            end: 0,
            offset: 0,
            start: 0,
        }; 16];
        let mut short_codes = [0_u16; 256];
        let mut start = 0_u32;
        let mut offset = 0_usize;
        for (length, (&count, entry)) in (1_u32..=16).zip(counts.iter().zip(&mut lengths)) {
            let end = start + u32::from(count);
            if end >= (1 << length) {
                return Err(DecodeError::Format);
            }
            *entry = CodeLength { end, offset, start };
            if length <= 8 {
                let shift = 8 - length;
                let first =
                    usize::try_from(start << shift).map_err(|_cause| DecodeError::Format)?;
                let last = usize::try_from(end << shift).map_err(|_cause| DecodeError::Format)?;
                let size = u16::try_from(length).map_err(|_cause| DecodeError::Format)?;
                let entries = short_codes
                    .get_mut(first..last)
                    .ok_or(DecodeError::Format)?;
                let codes = symbols
                    .get(offset..offset + usize::from(count))
                    .ok_or(DecodeError::Format)?;
                for (range, &symbol) in entries.chunks_exact_mut(1 << shift).zip(codes) {
                    range.fill((size << 8_u32) | u16::from(symbol));
                }
            }
            start = end << 1_u32;
            offset += usize::from(count);
        }
        Ok(Self {
            lengths,
            short_codes,
            symbols,
        })
    }
}

type Block = [i16; 64];
type Quant = [u16; 64];

struct Component {
    blocks: Vec<Block>,
    columns: usize,
    horizontal: usize,
    id: u8,
    precision: [Option<u8>; 64],
    quant: Option<Quant>,
    quant_id: usize,
    vertical: usize,
}

struct Frame {
    columns: usize,
    components: Vec<Component>,
    height: u32,
    max_h: usize,
    max_v: usize,
    progressive: bool,
    rows: usize,
    width: u32,
}

impl Frame {
    #[expect(
        clippy::arithmetic_side_effects,
        reason = "validated JPEG dimensions and sampling bound MCU geometry"
    )]
    fn parse(mut input: &[u8], progressive: bool) -> Decode<Self> {
        if byte(&mut input)? != 8 {
            return Err(DecodeError::Unsupported);
        }
        let height = u32::from(short(&mut input)?);
        let width = u32::from(short(&mut input)?);
        let _pixels = pixel_count(width, height).map_err(DecodeError::Raster)?;
        let count = byte(&mut input)?;
        if count != 1 && count != 3 {
            return Err(DecodeError::Unsupported);
        }
        let mut components = Vec::<Component>::with_capacity(usize::from(count));
        for _ in 0..count {
            let id = byte(&mut input)?;
            let sampling = byte(&mut input)?;
            let horizontal = usize::from(sampling >> 4_u32);
            let vertical = usize::from(sampling & 15);
            let quant_id = usize::from(byte(&mut input)?);
            if !input_dimensions(horizontal, vertical)
                || components.iter().any(|component| component.id == id)
                || quant_id >= 4
            {
                return Err(DecodeError::Format);
            }
            components.push(Component {
                blocks: Vec::new(),
                columns: 0,
                horizontal,
                id,
                precision: [None; 64],
                quant: None,
                quant_id,
                vertical,
            });
        }
        if !input.is_empty() {
            return Err(DecodeError::Format);
        }
        if let [component] = components.as_mut_slice() {
            component.horizontal = 1;
            component.vertical = 1;
        }
        let max_h = components
            .iter()
            .map(|component| component.horizontal)
            .max()
            .ok_or(DecodeError::Format)?;
        let max_v = components
            .iter()
            .map(|component| component.vertical)
            .max()
            .ok_or(DecodeError::Format)?;
        let columns = usize::try_from(width)
            .map_err(|_cause| DecodeError::Format)?
            .div_ceil(max_h * 8);
        let rows = usize::try_from(height)
            .map_err(|_cause| DecodeError::Format)?
            .div_ceil(max_v * 8);
        for component in &mut components {
            component.columns = columns * component.horizontal;
            component
                .blocks
                .resize(component.columns * rows * component.vertical, [0; 64]);
        }
        Ok(Self {
            columns,
            components,
            height,
            max_h,
            max_v,
            progressive,
            rows,
            width,
        })
    }
}

#[derive(Clone, Copy)]
struct Band {
    end: usize,
    high: u8,
    low: u8,
    progressive: bool,
    start: usize,
}

struct ScanComponent {
    ac: usize,
    dc: usize,
    index: usize,
    predictor: i32,
}

struct Scan {
    band: Band,
    components: Vec<ScanComponent>,
}

impl Scan {
    #[expect(
        clippy::arithmetic_side_effects,
        reason = "scan header holds 8-bit coefficients and bit positions"
    )]
    fn parse(mut input: &[u8], frame: &mut Frame, quant: &[Option<Quant>; 4]) -> Decode<Self> {
        let count = usize::from(byte(&mut input)?);
        if count == 0 || count > frame.components.len() {
            return Err(DecodeError::Format);
        }
        let mut components = Vec::<ScanComponent>::with_capacity(count);
        for _ in 0..count {
            let id = byte(&mut input)?;
            let tables = byte(&mut input)?;
            let index = frame
                .components
                .iter()
                .position(|component| component.id == id)
                .ok_or(DecodeError::Format)?;
            if components.iter().any(|component| component.index == index) {
                return Err(DecodeError::Format);
            }
            components.push(ScanComponent {
                ac: usize::from(tables & 15),
                dc: usize::from(tables >> 4_u32),
                index,
                predictor: 0,
            });
        }
        let start = usize::from(byte(&mut input)?);
        let end = usize::from(byte(&mut input)?);
        let approximation = byte(&mut input)?;
        let high = approximation >> 4_u32;
        let low = approximation & 15;
        if !input.is_empty() || start > end || end >= 64 {
            return Err(DecodeError::Format);
        }
        if frame.progressive {
            if (start == 0 && end != 0)
                || (start != 0 && count != 1)
                || low > 13
                || (high != 0 && high != low + 1)
            {
                return Err(DecodeError::Format);
            }
        } else if start != 0 || end != 63 || approximation != 0 {
            return Err(DecodeError::Format);
        }
        for entry in &components {
            let component = frame
                .components
                .get_mut(entry.index)
                .ok_or(DecodeError::Format)?;
            if component.quant.is_none() {
                component.quant = Some(
                    *quant
                        .get(component.quant_id)
                        .and_then(Option::as_ref)
                        .ok_or(DecodeError::Format)?,
                );
            }
            let precisions = component
                .precision
                .get_mut(start..=end)
                .ok_or(DecodeError::Format)?;
            let previous = (high != 0).then_some(high);
            for precision in precisions {
                if *precision != previous {
                    return Err(DecodeError::Format);
                }
                *precision = Some(low);
            }
        }
        Ok(Self {
            components,
            band: Band {
                end,
                high,
                low,
                progressive: frame.progressive,
                start,
            },
        })
    }
}

#[derive(Default)]
struct Tables {
    ac: [Option<Huffman>; 4],
    dc: [Option<Huffman>; 4],
    quant: [Option<Quant>; 4],
}

impl Tables {
    fn huffman(&mut self, mut input: &[u8]) -> Decode<()> {
        while !input.is_empty() {
            let info = byte(&mut input)?;
            let class = match info >> 4_u32 {
                0 => &mut self.dc,
                1 => &mut self.ac,
                _ => return Err(DecodeError::Format),
            };
            *class
                .get_mut(usize::from(info & 15))
                .ok_or(DecodeError::Format)? = Some(Huffman::parse(&mut input)?);
        }
        Ok(())
    }

    fn quantization(&mut self, mut input: &[u8]) -> Decode<()> {
        while !input.is_empty() {
            let info = byte(&mut input)?;
            let precision = info >> 4_u32;
            if precision > 1 {
                return Err(DecodeError::Format);
            }
            let mut quant = [0_u16; 64];
            for value in &mut quant {
                *value = if precision == 0 {
                    u16::from(byte(&mut input)?)
                } else {
                    short(&mut input)?
                };
                if *value == 0 {
                    return Err(DecodeError::Format);
                }
            }
            *self
                .quant
                .get_mut(usize::from(info & 15))
                .ok_or(DecodeError::Format)? = Some(quant);
        }
        Ok(())
    }
}

struct ScanReader<'data, 'tables> {
    band: Band,
    entropy: Entropy<'data>,
    eob: u32,
    tables: &'tables Tables,
}

impl ScanReader<'_, '_> {
    fn block(&mut self, table: &mut ScanComponent, block: &mut Block) -> Decode<()> {
        if self.band.start == 0 {
            let dc = block.first_mut().ok_or(DecodeError::Format)?;
            if self.band.high == 0 {
                let huffman = self
                    .tables
                    .dc
                    .get(table.dc)
                    .and_then(Option::as_ref)
                    .ok_or(DecodeError::Format)?;
                let size = huffman.decode(&mut self.entropy)?;
                let delta = self.entropy.amplitude(size, 11)?;
                table.predictor = table
                    .predictor
                    .checked_add(delta)
                    .ok_or(DecodeError::Format)?;
                let scale = 1_i32.wrapping_shl(u32::from(self.band.low));
                *dc = i16::try_from(
                    table
                        .predictor
                        .checked_mul(scale)
                        .ok_or(DecodeError::Format)?,
                )
                .map_err(|_cause| DecodeError::Format)?;
            } else if self.entropy.read(1)? != 0 {
                *dc |= 1_i16.wrapping_shl(u32::from(self.band.low));
            }
            if self.band.progressive {
                return Ok(());
            }
        }
        let huffman = self
            .tables
            .ac
            .get(table.ac)
            .and_then(Option::as_ref)
            .ok_or(DecodeError::Format)?;
        let start = self.band.start.max(1);
        let coefficients = block
            .get_mut(start..=self.band.end)
            .ok_or(DecodeError::Format)?;
        if self.band.high == 0 {
            self.first_ac(huffman, coefficients)
        } else {
            self.refine_ac(huffman, coefficients)
        }
    }

    fn correct(&mut self, coefficient: &mut i16, step: i16) -> Decode<()> {
        if *coefficient != 0 && self.entropy.read(1)? != 0 {
            *coefficient = if *coefficient > 0 {
                coefficient.saturating_add(step)
            } else {
                coefficient.saturating_sub(step)
            };
        }
        Ok(())
    }

    fn first_ac(&mut self, huffman: &Huffman, mut coefficients: &mut [i16]) -> Decode<()> {
        if self.eob != 0 {
            self.eob = self.eob.saturating_sub(1);
            return Ok(());
        }
        while !coefficients.is_empty() {
            let symbol = huffman.decode(&mut self.entropy)?;
            let run = symbol >> 4_u32;
            let size = symbol & 15;
            if size == 0 {
                if run == 15 {
                    coefficients = coefficients.get_mut(16..).ok_or(DecodeError::Format)?;
                    continue;
                }
                if self.band.progressive {
                    self.set_eob(run)?;
                } else if run != 0 {
                    return Err(DecodeError::Format);
                }
                return Ok(());
            }
            coefficients = coefficients
                .get_mut(usize::from(run)..)
                .ok_or(DecodeError::Format)?;
            let (coefficient, rest) = coefficients.split_first_mut().ok_or(DecodeError::Format)?;
            let value = self
                .entropy
                .amplitude(size, 10)?
                .wrapping_shl(u32::from(self.band.low));
            *coefficient = i16::try_from(value).map_err(|_cause| DecodeError::Format)?;
            coefficients = rest;
        }
        Ok(())
    }

    fn refine_ac(&mut self, huffman: &Huffman, coefficients: &mut [i16]) -> Decode<()> {
        let step = 1_i16.wrapping_shl(u32::from(self.band.low));
        let mut remaining = coefficients.iter_mut();
        while self.eob == 0 && !remaining.as_slice().is_empty() {
            let symbol = huffman.decode(&mut self.entropy)?;
            let zeros = symbol >> 4_u32;
            let value = match symbol & 15 {
                0 if zeros == 15 => 0,
                0 => {
                    self.set_eob(zeros)?;
                    for coefficient in remaining {
                        self.correct(coefficient, step)?;
                    }
                    return Ok(());
                }
                1 => {
                    if self.entropy.read(1)? == 0 {
                        step.saturating_neg()
                    } else {
                        step
                    }
                }
                _ => return Err(DecodeError::Format),
            };
            let mut skipped = zeros;
            loop {
                let coefficient = remaining.next().ok_or(DecodeError::Format)?;
                if *coefficient != 0 {
                    self.correct(coefficient, step)?;
                } else if skipped == 0 {
                    *coefficient = value;
                    break;
                } else {
                    skipped = skipped.saturating_sub(1);
                }
            }
        }
        if self.eob != 0 {
            for coefficient in remaining {
                self.correct(coefficient, step)?;
            }
            self.eob = self.eob.saturating_sub(1);
        }
        Ok(())
    }

    fn set_eob(&mut self, run: u8) -> Decode<()> {
        let bits = u32::from(run);
        self.eob = (1_u32.wrapping_shl(bits) | self.entropy.read(bits)?).saturating_sub(1);
        Ok(())
    }
}

fn take<'data>(input: &mut &'data [u8], count: usize) -> Decode<&'data [u8]> {
    let (head, tail) = input.split_at_checked(count).ok_or(DecodeError::Format)?;
    *input = tail;
    Ok(head)
}

fn byte(input: &mut &[u8]) -> Decode<u8> {
    take(input, 1)?.first().copied().ok_or(DecodeError::Format)
}

fn short(input: &mut &[u8]) -> Decode<u16> {
    let &[high, low] = take(input, 2)? else {
        return Err(DecodeError::Format);
    };
    Ok(u16::from_be_bytes([high, low]))
}

fn marker(input: &mut &[u8]) -> Decode<u8> {
    if byte(input)? != 0xff {
        return Err(DecodeError::Format);
    }
    loop {
        let next = byte(input)?;
        if next != 0xff {
            return Ok(next);
        }
    }
}

const fn input_dimensions(horizontal: usize, vertical: usize) -> bool {
    horizontal > 0 && horizontal <= 4 && vertical > 0 && vertical <= 4
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "validated MCU dimensions bound block indexes and counts"
)]
fn read_scan<'data>(
    input: &'data [u8],
    frame: &mut Frame,
    tables: &Tables,
    mut scan: Scan,
    interval: usize,
) -> Decode<&'data [u8]> {
    let interleaved = scan.components.len() > 1;
    let (columns, rows) = if interleaved {
        (frame.columns, frame.rows)
    } else {
        let index = scan.components.first().ok_or(DecodeError::Format)?.index;
        let component = frame.components.get(index).ok_or(DecodeError::Format)?;
        let width = usize::try_from(frame.width).map_err(|_cause| DecodeError::Format)?;
        let height = usize::try_from(frame.height).map_err(|_cause| DecodeError::Format)?;
        (
            (width * component.horizontal).div_ceil(8 * frame.max_h),
            (height * component.vertical).div_ceil(8 * frame.max_v),
        )
    };
    let mut reader = ScanReader {
        entropy: Entropy {
            available: 0,
            buffer: 0,
            input,
        },
        tables,
        band: scan.band,
        eob: 0,
    };
    let mut countdown = interval;
    let mut restart = 0_u8;
    for row in 0..rows {
        for column in 0..columns {
            if interval != 0 && countdown == 0 {
                if reader.eob != 0 || marker(&mut reader.entropy.input)? != 0xd0 + restart {
                    return Err(DecodeError::Format);
                }
                reader.entropy.available = 0;
                countdown = interval;
                restart = (restart + 1) & 7;
                for component in &mut scan.components {
                    component.predictor = 0_i32;
                }
            }
            for entry in &mut scan.components {
                let component = frame
                    .components
                    .get_mut(entry.index)
                    .ok_or(DecodeError::Format)?;
                let (width, height) = if interleaved {
                    (component.horizontal, component.vertical)
                } else {
                    (1, 1)
                };
                for delta_y in 0..height {
                    let start = (row * height + delta_y) * component.columns + column * width;
                    let blocks = component
                        .blocks
                        .get_mut(start..start + width)
                        .ok_or(DecodeError::Format)?;
                    for block in blocks {
                        reader.block(entry, block)?;
                    }
                }
            }
            countdown = countdown.saturating_sub(1);
        }
    }
    if reader.eob != 0 {
        return Err(DecodeError::Format);
    }
    Ok(reader.entropy.input)
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "two 8-point transforms of dequantized i16 coefficients fit i64"
)]
const fn transform(
    [dc, first, second, third, fourth, fifth, sixth, seventh]: [i64; 8],
) -> [i64; 8] {
    if first | second | third | fourth | fifth | sixth | seventh == 0 {
        return [dc * 1448; 8];
    }
    let base_sum = (dc + fourth) * 1448;
    let base_difference = (dc - fourth) * 1448;
    let even_start = second * 1892 + sixth * 784;
    let even_inner = second * 784 - sixth * 1892;
    let even_outer_left = base_sum + even_start;
    let even_inner_left = base_difference + even_inner;
    let even_inner_right = base_difference - even_inner;
    let even_outer_right = base_sum - even_start;
    let odd_outer_left = first * 2009 + third * 1703 + fifth * 1138 + seventh * 400;
    let odd_inner_left = first * 1703 - third * 400 - fifth * 2009 - seventh * 1138;
    let odd_inner_right = first * 1138 - third * 2009 + fifth * 400 + seventh * 1703;
    let odd_outer_right = first * 400 - third * 1138 + fifth * 1703 - seventh * 2009;
    [
        even_outer_left + odd_outer_left,
        even_inner_left + odd_inner_left,
        even_inner_right + odd_inner_right,
        even_outer_right + odd_outer_right,
        even_outer_right - odd_outer_right,
        even_inner_right - odd_inner_right,
        even_inner_left - odd_inner_left,
        even_outer_left - odd_outer_left,
    ]
}

fn transpose<Value>(matrix: &[[Value; 8]; 8]) -> [[Value; 8]; 8]
where
    Value: Copy + Default,
{
    array::from_fn(|column| {
        array::from_fn(|position| {
            matrix
                .get(position)
                .and_then(|row| row.get(column))
                .copied()
                .unwrap_or_default()
        })
    })
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "dequantized i16 coefficients and fixed-point basis fit i64"
)]
fn inverse(block: &Block, quant: &Quant) -> [[u8; 8]; 8] {
    let mut values = block.iter().zip(quant).zip(ZIGZAG);
    let dc = values.next().map_or(0, |((&coefficient, &scale), _index)| {
        i64::from(coefficient) * i64::from(scale)
    });
    if block
        .get(1..)
        .is_some_and(|ac| ac.iter().all(|&coefficient| coefficient == 0))
    {
        return [[sample((dc + 4) >> 3_u32); 8]; 8];
    }
    let mut frequencies = [[0_i64; 8]; 8];
    if let Some(coefficient) = frequencies.first_mut().and_then(|row| row.first_mut()) {
        *coefficient = dc;
    }
    for ((&coefficient, &scale), index) in values {
        if coefficient != 0
            && let Some(slot) = frequencies
                .get_mut(index >> 3_u32)
                .and_then(|row| row.get_mut(index & 7))
        {
            *slot = i64::from(coefficient) * i64::from(scale);
        }
    }
    let columns = transpose(&frequencies.map(transform));
    transpose(
        &columns
            .map(|column| transform(column).map(|value| sample((value + (1 << 23_u32)) >> 24_u32))),
    )
}

fn sample(value: i64) -> u8 {
    u8::try_from(value.saturating_add(128).clamp(0, 255)).unwrap_or_default()
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "decoded plane dimensions bound row and block indexes"
)]
fn render_plane(component: &Component, width: usize, height: usize) -> Decode<Vec<u8>> {
    let quant = component.quant.as_ref().ok_or(DecodeError::Format)?;
    let mut samples = vec![0; width * height];
    for (block_row, row) in component
        .blocks
        .chunks_exact(component.columns)
        .take(height.div_ceil(8))
        .enumerate()
    {
        let rows = (height - block_row * 8).min(8);
        for (block_column, block) in row.iter().take(width.div_ceil(8)).enumerate() {
            let columns = (width - block_column * 8).min(8);
            for (delta_y, decoded) in inverse(block, quant).iter().take(rows).enumerate() {
                let start = (block_row * 8 + delta_y) * width + block_column * 8;
                let destination = samples
                    .get_mut(start..start + columns)
                    .ok_or(DecodeError::Format)?;
                destination.copy_from_slice(decoded.get(..columns).ok_or(DecodeError::Format)?);
            }
        }
    }
    Ok(samples)
}

#[expect(
    clippy::arithmetic_side_effects,
    clippy::integer_division,
    clippy::integer_division_remainder_used,
    reason = "integer component coordinates are bounded by JPEG sampling grids"
)]
fn render(frame: &Frame, adobe: Option<u8>) -> Decode<Gray> {
    let width = usize::try_from(frame.width).map_err(|_cause| DecodeError::Format)?;
    let height = usize::try_from(frame.height).map_err(|_cause| DecodeError::Format)?;
    let rgb = match frame.components.as_slice() {
        [_gray] => false,
        [red, green, blue] => {
            adobe == Some(0) || (adobe.is_none() && [red.id, green.id, blue.id] == *b"RGB")
        }
        _ => return Err(DecodeError::Unsupported),
    };
    if frame
        .components
        .iter()
        .any(|component| component.precision.first().is_none_or(Option::is_none))
    {
        return Err(DecodeError::Format);
    }
    if adobe.is_some_and(|transform| transform > 1) {
        return Err(DecodeError::Unsupported);
    }
    if !rgb {
        let component = frame.components.first().ok_or(DecodeError::Format)?;
        if component.horizontal == frame.max_h && component.vertical == frame.max_v {
            let pixels = render_plane(component, width, height)?;
            return Gray::new(frame.width, frame.height, pixels).map_err(DecodeError::Raster);
        }
    }
    let mut planes = Vec::with_capacity(if rgb { 3 } else { 1 });
    for component in frame.components.iter().take(if rgb { 3 } else { 1 }) {
        let stride = component.columns * 8;
        let rows = component.blocks.len() / component.columns * 8;
        planes.push((component, render_plane(component, stride, rows)?));
    }
    let mut pixels = Vec::with_capacity(width * height);
    for yy in 0..height {
        for xx in 0..width {
            let get = |(component, samples): &(&Component, Vec<u8>)| {
                let offset = yy * component.vertical / frame.max_v * component.columns * 8
                    + xx * component.horizontal / frame.max_h;
                samples.get(offset).copied().ok_or(DecodeError::Format)
            };
            let luminance = match planes.as_slice() {
                [gray] => get(gray)?,
                [red, green, blue] => {
                    let weighted = u32::from(get(red)?) * 19_595
                        + u32::from(get(green)?) * 38_470
                        + u32::from(get(blue)?) * 7471;
                    u8::try_from((weighted + 0x8000) >> 16_u32)
                        .map_err(|_cause| DecodeError::Format)?
                }
                _ => return Err(DecodeError::Format),
            };
            pixels.push(luminance);
        }
    }
    Gray::new(frame.width, frame.height, pixels).map_err(DecodeError::Raster)
}

/// # Errors
/// Returns an error for malformed JPEG data or unsupported frame modes.
#[inline]
pub fn decode(mut input: &[u8]) -> Decode<Gray> {
    if marker(&mut input)? != 0xd8 {
        return Err(DecodeError::Format);
    }
    let mut image = None;
    let mut adobe = None;
    let mut interval = 0;
    let mut tables = Tables::default();
    loop {
        let kind = marker(&mut input)?;
        if kind == 0xd9 {
            return render(&image.ok_or(DecodeError::Format)?, adobe);
        }
        let length = short(&mut input)?
            .checked_sub(2)
            .ok_or(DecodeError::Format)?;
        let mut payload = take(&mut input, usize::from(length))?;
        match kind {
            0xc0..=0xc2 if image.is_none() => image = Some(Frame::parse(payload, kind == 0xc2)?),
            0xc4 => tables.huffman(payload)?,
            0xdb => tables.quantization(payload)?,
            0xdd if payload.len() == 2 => interval = usize::from(short(&mut payload)?),
            0xda => {
                let frame = image.as_mut().ok_or(DecodeError::Format)?;
                let scan = Scan::parse(payload, frame, &tables.quant)?;
                input = read_scan(input, frame, &tables, scan, interval)?;
            }
            0xee if payload.starts_with(b"Adobe") => adobe = payload.get(11).copied(),
            0xe0..=0xef | 0xfe => {}
            _ => return Err(DecodeError::Unsupported),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::raster::read_pgm;

    use super::{DecodeError, decode};

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "PSNR compares reference pixels and assertions report mismatches"
    )]
    fn reference_luminance() -> Result<(), DecodeError> {
        let cases: &[(&[u8], &[u8])] = &[
            (
                include_bytes!("../tests/fixtures/restart.jpg"),
                include_bytes!("../tests/fixtures/restart.pgm"),
            ),
            (
                include_bytes!("../tests/fixtures/progressive.jpg"),
                include_bytes!("../tests/fixtures/progressive.pgm"),
            ),
            (
                include_bytes!("../tests/fixtures/ycbcr.jpg"),
                include_bytes!("../tests/fixtures/ycbcr.pgm"),
            ),
            (
                include_bytes!("../tests/fixtures/adobe-rgb.jpg"),
                include_bytes!("../tests/fixtures/adobe-rgb.pgm"),
            ),
        ];
        for &(jpeg, reference) in cases {
            let expected = read_pgm(reference).map_err(DecodeError::Raster)?;
            let actual = decode(jpeg)?;
            assert_eq!(
                (actual.width, actual.height),
                (expected.width, expected.height)
            );
            let squared: f64 = actual
                .pixels
                .iter()
                .zip(&expected.pixels)
                .map(|(&actual_pixel, &expected_pixel)| {
                    let delta = f64::from(actual_pixel) - f64::from(expected_pixel);
                    delta * delta
                })
                .sum();
            let psnr = 10.0_f64
                * (65_025.0_f64 * f64::from(actual.width * actual.height) / squared).log10();
            assert!(psnr > 50.0_f64, "{psnr:.2} dB");
            let truncated = jpeg
                .get(..jpeg.len().saturating_sub(2))
                .ok_or(DecodeError::Format)?;
            assert_eq!(decode(truncated), Err(DecodeError::Format));
        }
        Ok(())
    }
}
