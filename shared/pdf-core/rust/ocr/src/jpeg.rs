use core::{array, mem};

use crate::raster::{Gray, RasterError, pixel_count};

const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const LOOK_BITS: u32 = 11;
const LOOK_SIZE: usize = 1_usize << 11;

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
    buffer: u64,
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

    #[inline]
    fn fill(&mut self, count: u32) {
        while self.available < count && self.pull() {}
    }

    #[expect(
        clippy::as_conversions,
        clippy::cast_possible_truncation,
        reason = "a masked peek of at most 32 bits fits in u32"
    )]
    const fn peek(&self, count: u32) -> u32 {
        let shift = self.available.saturating_sub(count);
        let mask = 1_u64.wrapping_shl(count).wrapping_sub(1);
        (self.buffer.wrapping_shr(shift) & mask) as u32
    }

    #[inline]
    fn pull(&mut self) -> bool {
        if self.available <= 32 && self.pull_word() {
            return true;
        }
        self.pull_byte()
    }

    #[expect(
        clippy::arithmetic_side_effects,
        reason = "the bit buffer keeps at most 56 filled bits before a byte is appended"
    )]
    fn pull_byte(&mut self) -> bool {
        if self.available > 56 {
            return false;
        }
        let Some((&value, rest)) = self.input.split_first() else {
            return false;
        };
        self.input = if value == 0xff {
            let Some((&0, after_escape)) = rest.split_first() else {
                return false;
            };
            after_escape
        } else {
            rest
        };
        self.buffer = self.buffer.wrapping_shl(8) | u64::from(value);
        self.available += 8;
        true
    }

    #[expect(
        clippy::arithmetic_side_effects,
        reason = "four marker-free bytes fit in the 64-bit buffer when at most 32 bits are full"
    )]
    fn pull_word(&mut self) -> bool {
        let Some(chunk) = self.input.get(..4) else {
            return false;
        };
        if chunk.contains(&0xff) {
            return false;
        }
        let Ok(bytes) = <[u8; 4]>::try_from(chunk) else {
            return false;
        };
        let Some(rest) = self.input.get(4..) else {
            return false;
        };
        self.input = rest;
        self.buffer = self.buffer.wrapping_shl(32) | u64::from(u32::from_be_bytes(bytes));
        self.available += 32;
        true
    }

    #[inline]
    fn read(&mut self, count: u32) -> Decode<u32> {
        if count > 32 {
            return Err(DecodeError::Format);
        }
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
    look: Vec<u16>,
    symbols: Vec<u8>,
}

impl Huffman {
    #[inline]
    fn decode(&self, entropy: &mut Entropy<'_>) -> Decode<u8> {
        entropy.fill(LOOK_BITS);
        if entropy.available >= LOOK_BITS {
            let index =
                usize::try_from(entropy.peek(LOOK_BITS)).map_err(|_cause| DecodeError::Format)?;
            let entry = self.look.get(index).copied().ok_or(DecodeError::Format)?;
            let bits = u32::from(entry >> 8_u32);
            if bits != 0 {
                entropy.available = entropy.available.saturating_sub(bits);
                return Ok(entry.to_le_bytes().first().copied().unwrap_or_default());
            }
        }
        self.decode_long(entropy)
    }

    #[expect(
        clippy::arithmetic_side_effects,
        reason = "canonical lengths and offsets are bounded by the codebook"
    )]
    fn decode_long(&self, entropy: &mut Entropy<'_>) -> Decode<u8> {
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
        let mut look = vec![0_u16; LOOK_SIZE];
        let mut start = 0_u32;
        let mut offset = 0_usize;
        for (length, (&count, entry)) in (1_u32..=16).zip(counts.iter().zip(&mut lengths)) {
            let end = start + u32::from(count);
            if end >= (1 << length) {
                return Err(DecodeError::Format);
            }
            *entry = CodeLength { end, offset, start };
            if length <= LOOK_BITS {
                let shift = LOOK_BITS - length;
                let first =
                    usize::try_from(start << shift).map_err(|_cause| DecodeError::Format)?;
                let last = usize::try_from(end << shift).map_err(|_cause| DecodeError::Format)?;
                let size = u16::try_from(length).map_err(|_cause| DecodeError::Format)?;
                let entries = look.get_mut(first..last).ok_or(DecodeError::Format)?;
                let width = 1_usize << shift;
                let codes = symbols
                    .get(offset..offset + usize::from(count))
                    .ok_or(DecodeError::Format)?;
                for (range, &symbol) in entries.chunks_exact_mut(width).zip(codes) {
                    range.fill((size << 8_u32) | u16::from(symbol));
                }
            }
            start = end << 1_u32;
            offset += usize::from(count);
        }
        Ok(Self {
            lengths,
            look,
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
    retain: bool,
    vertical: usize,
}

struct Frame {
    columns: usize,
    components: Vec<Component>,
    fused: bool,
    height: u32,
    max_h: usize,
    max_v: usize,
    pixels: Vec<u8>,
    progressive: bool,
    rows: usize,
    scans: u8,
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
                retain: false,
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
        }
        Ok(Self {
            columns,
            components,
            fused: false,
            height,
            max_h,
            max_v,
            pixels: Vec::new(),
            progressive,
            rows,
            scans: 0,
            width,
        })
    }

    fn prepare(&mut self, adobe: Option<u8>, denominator: u8) -> Decode<()> {
        let discard = discard_chroma(self, adobe);
        let luma = self.components.len() == 1 || discard;
        if self.scans == 0 {
            self.fused = luma && !self.progressive && denominator == 1;
            if self.fused {
                let count = pixel_count(self.width, self.height).map_err(DecodeError::Raster)?;
                self.pixels.resize(count, 0);
            }
        } else {
            self.fused = false;
            self.pixels.clear();
        }
        let fused = self.fused;
        for (index, component) in self.components.iter_mut().enumerate() {
            component.retain = !fused && (index == 0 || !discard);
            if component.retain && component.blocks.is_empty() {
                let count = component
                    .columns
                    .saturating_mul(self.rows)
                    .saturating_mul(component.vertical);
                component.blocks.resize(count, [0; 64]);
            }
        }
        self.scans = self.scans.saturating_add(1);
        Ok(())
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
    const fn baseline(&self) -> bool {
        !self.band.progressive
            && self.band.end == 63
            && self.band.high == 0
            && self.band.low == 0
            && self.band.start == 0
    }

    fn block(&mut self, table: &mut ScanComponent, block: &mut Block) -> Decode<()> {
        if self.baseline() {
            return self.block_baseline(table, block);
        }
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

    fn block_baseline(&mut self, table: &mut ScanComponent, block: &mut Block) -> Decode<()> {
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
        let dc = block.first_mut().ok_or(DecodeError::Format)?;
        *dc = i16::try_from(table.predictor).map_err(|_cause| DecodeError::Format)?;
        let ac = self
            .tables
            .ac
            .get(table.ac)
            .and_then(Option::as_ref)
            .ok_or(DecodeError::Format)?;
        let mut index = 1_usize;
        while index < 64 {
            let symbol = ac.decode(&mut self.entropy)?;
            let run = usize::from(symbol >> 4_u32);
            let magnitude = symbol & 15;
            if magnitude == 0 {
                if run == 15 {
                    index = index.checked_add(16).ok_or(DecodeError::Format)?;
                    if index > 64 {
                        return Err(DecodeError::Format);
                    }
                    continue;
                }
                if run != 0 {
                    return Err(DecodeError::Format);
                }
                return Ok(());
            }
            index = index.checked_add(run).ok_or(DecodeError::Format)?;
            let value = self.entropy.amplitude(magnitude, 10)?;
            let slot = block.get_mut(index).ok_or(DecodeError::Format)?;
            *slot = i16::try_from(value).map_err(|_cause| DecodeError::Format)?;
            index = index.checked_add(1).ok_or(DecodeError::Format)?;
        }
        Ok(())
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

struct Mcu {
    column: usize,
    fused: bool,
    image_height: usize,
    image_width: usize,
    interleaved: bool,
    row: usize,
}

struct ScanGrid {
    columns: usize,
    interleaved: bool,
    rows: usize,
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
    reason = "validated component sampling bounds the non-interleaved grid"
)]
fn scan_grid(frame: &Frame, scan: &Scan) -> Decode<ScanGrid> {
    let interleaved = scan.components.len() > 1;
    if interleaved {
        return Ok(ScanGrid {
            columns: frame.columns,
            interleaved,
            rows: frame.rows,
        });
    }
    let index = scan.components.first().ok_or(DecodeError::Format)?.index;
    let component = frame.components.get(index).ok_or(DecodeError::Format)?;
    let width = usize::try_from(frame.width).map_err(|_cause| DecodeError::Format)?;
    let height = usize::try_from(frame.height).map_err(|_cause| DecodeError::Format)?;
    Ok(ScanGrid {
        columns: (width * component.horizontal).div_ceil(8 * frame.max_h),
        interleaved,
        rows: (height * component.vertical).div_ceil(8 * frame.max_v),
    })
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "restart markers cycle through RST0 through RST7"
)]
fn reset_restart(reader: &mut ScanReader<'_, '_>, scan: &mut Scan, restart: u8) -> Decode<u8> {
    if reader.eob != 0 || marker(&mut reader.entropy.input)? != 0xd0 + restart {
        return Err(DecodeError::Format);
    }
    reader.entropy.available = 0;
    for component in &mut scan.components {
        component.predictor = 0_i32;
    }
    Ok((restart + 1) & 7)
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "validated MCU dimensions bound block indexes and counts"
)]
fn read_mcu(
    reader: &mut ScanReader<'_, '_>,
    frame: &mut Frame,
    scan: &mut Scan,
    place: &Mcu,
) -> Decode<()> {
    let Frame {
        components, pixels, ..
    } = frame;
    for entry in &mut scan.components {
        let index = entry.index;
        let component = components.get_mut(index).ok_or(DecodeError::Format)?;
        let horizontal = if place.interleaved {
            component.horizontal
        } else {
            1
        };
        let vertical = if place.interleaved {
            component.vertical
        } else {
            1
        };
        if !component.retain {
            if place.fused && index == 0 {
                let quant = component.quant.as_ref().ok_or(DecodeError::Format)?;
                for delta_y in 0..vertical {
                    for delta_x in 0..horizontal {
                        let mut scratch = [0_i16; 64];
                        reader.block(entry, &mut scratch)?;
                        let decoded = inverse(&scratch, quant);
                        paint_block(
                            pixels,
                            place.image_width,
                            place.image_height,
                            place.column * horizontal + delta_x,
                            place.row * vertical + delta_y,
                            &decoded,
                        )?;
                    }
                }
            } else {
                for _step in 0..horizontal * vertical {
                    let mut scratch = [0_i16; 64];
                    reader.block(entry, &mut scratch)?;
                }
            }
            continue;
        }
        let quant = *component.quant.as_ref().ok_or(DecodeError::Format)?;
        let columns = component.columns;
        for delta_y in 0..vertical {
            let start = (place.row * vertical + delta_y) * columns + place.column * horizontal;
            let blocks = component
                .blocks
                .get_mut(start..start + horizontal)
                .ok_or(DecodeError::Format)?;
            for (delta_x, block) in blocks.iter_mut().enumerate() {
                reader.block(entry, block)?;
                if place.fused && index == 0 {
                    let decoded = inverse(block, &quant);
                    paint_block(
                        pixels,
                        place.image_width,
                        place.image_height,
                        place.column * horizontal + delta_x,
                        place.row * vertical + delta_y,
                        &decoded,
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn read_scan<'data>(
    input: &'data [u8],
    frame: &mut Frame,
    tables: &Tables,
    mut scan: Scan,
    interval: usize,
) -> Decode<&'data [u8]> {
    let grid = scan_grid(frame, &scan)?;
    let image_width = usize::try_from(frame.width).map_err(|_cause| DecodeError::Format)?;
    let image_height = usize::try_from(frame.height).map_err(|_cause| DecodeError::Format)?;
    let fused = frame.fused;
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
    for row in 0..grid.rows {
        for column in 0..grid.columns {
            if interval != 0 && countdown == 0 {
                restart = reset_restart(&mut reader, &mut scan, restart)?;
                countdown = interval;
            }
            let place = Mcu {
                column,
                fused,
                image_height,
                image_width,
                interleaved: grid.interleaved,
                row,
            };
            read_mcu(&mut reader, frame, &mut scan, &place)?;
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
#[cfg_attr(
    all(target_arch = "wasm32", target_feature = "simd128", not(test)),
    expect(
        dead_code,
        reason = "wasm simd128 calls transform_simd; scalar stays for native builds and the parity test"
    )
)]
const fn transform_scalar(
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

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline]
const fn transform_row(values: [i64; 8]) -> [i64; 8] {
    transform_scalar(values)
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn transform_row(values: [i64; 8]) -> [i64; 8] {
    transform_simd(values)
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn pair_product(left_0: i64, right_0: i64, left_1: i64, right_1: i64) -> (i64, i64) {
    use core::arch::wasm32::{i64x2, i64x2_extract_lane, i64x2_mul};
    let product = i64x2_mul(i64x2(left_0, left_1), i64x2(right_0, right_1));
    (
        i64x2_extract_lane::<0>(product),
        i64x2_extract_lane::<1>(product),
    )
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[expect(
    clippy::arithmetic_side_effects,
    reason = "two 8-point transforms of dequantized i16 coefficients fit i64"
)]
fn transform_simd([dc, first, second, third, fourth, fifth, sixth, seventh]: [i64; 8]) -> [i64; 8] {
    if first | second | third | fourth | fifth | sixth | seventh == 0 {
        return [dc * 1448; 8];
    }
    let (dc_scaled, fourth_scaled) = pair_product(dc, 1448, fourth, 1448);
    let base_sum = dc_scaled + fourth_scaled;
    let base_difference = dc_scaled - fourth_scaled;
    let (even_second, even_sixth) = pair_product(second, 1892, sixth, 784);
    let even_start = even_second + even_sixth;
    let (inner_second, inner_sixth) = pair_product(second, 784, sixth, 1892);
    let even_inner = inner_second - inner_sixth;
    let even_outer_left = base_sum + even_start;
    let even_inner_left = base_difference + even_inner;
    let even_inner_right = base_difference - even_inner;
    let even_outer_right = base_sum - even_start;
    let (outer_first, outer_third) = pair_product(first, 2009, third, 1703);
    let (outer_fifth, outer_seventh) = pair_product(fifth, 1138, seventh, 400);
    let odd_outer_left = outer_first + outer_third + outer_fifth + outer_seventh;
    let (inner_left_first, inner_left_third) = pair_product(first, 1703, third, 400);
    let (inner_left_fifth, inner_left_seventh) = pair_product(fifth, 2009, seventh, 1138);
    let odd_inner_left =
        inner_left_first - inner_left_third - inner_left_fifth - inner_left_seventh;
    let (inner_right_first, inner_right_third) = pair_product(first, 1138, third, 2009);
    let (inner_right_fifth, inner_right_seventh) = pair_product(fifth, 400, seventh, 1703);
    let odd_inner_right =
        inner_right_first - inner_right_third + inner_right_fifth + inner_right_seventh;
    let (outer_right_first, outer_right_third) = pair_product(first, 400, third, 1138);
    let (outer_right_fifth, outer_right_seventh) = pair_product(fifth, 1703, seventh, 2009);
    let odd_outer_right =
        outer_right_first - outer_right_third + outer_right_fifth - outer_right_seventh;
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
    let columns = transpose(&frequencies.map(transform_row));
    transpose(
        &columns.map(|column| {
            transform_row(column).map(|value| sample((value + (1 << 23_u32)) >> 24_u32))
        }),
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
fn render_full(frame: &Frame, adobe: Option<u8>) -> Decode<Gray> {
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

fn discard_chroma(frame: &Frame, adobe: Option<u8>) -> bool {
    if frame.progressive || adobe == Some(0) {
        return false;
    }
    match frame.components.as_slice() {
        [first, second, third] => {
            [first.id, second.id, third.id] != *b"RGB"
                && first.horizontal == frame.max_h
                && first.vertical == frame.max_v
        }
        _ => false,
    }
}

fn paint_block(
    pixels: &mut [u8],
    image_width: usize,
    image_height: usize,
    block_x: usize,
    block_y: usize,
    samples: &[[u8; 8]; 8],
) -> Decode<()> {
    let origin_x = block_x.saturating_mul(8);
    let origin_y = block_y.saturating_mul(8);
    if origin_x >= image_width || origin_y >= image_height {
        return Ok(());
    }
    let rows = image_height.saturating_sub(origin_y).min(8);
    let columns = image_width.saturating_sub(origin_x).min(8);
    for (delta_y, decoded) in samples.iter().take(rows).enumerate() {
        let start = origin_y
            .saturating_add(delta_y)
            .saturating_mul(image_width)
            .saturating_add(origin_x);
        let destination = pixels
            .get_mut(start..start.saturating_add(columns))
            .ok_or(DecodeError::Format)?;
        destination.copy_from_slice(decoded.get(..columns).ok_or(DecodeError::Format)?);
    }
    Ok(())
}

fn render(frame: &mut Frame, adobe: Option<u8>, denominator: u8) -> Decode<Gray> {
    if denominator == 1 && frame.fused {
        let pixels = mem::take(&mut frame.pixels);
        return Gray::new(frame.width, frame.height, pixels).map_err(DecodeError::Raster);
    }
    if denominator == 1 {
        return render_full(frame, adobe);
    }
    render_scaled(frame, adobe, denominator)
}

fn uses_rgb(frame: &Frame, adobe: Option<u8>) -> bool {
    match frame.components.as_slice() {
        [red, green, blue] => {
            adobe == Some(0) || (adobe.is_none() && [red.id, green.id, blue.id] == *b"RGB")
        }
        _ => false,
    }
}

fn render_scaled(frame: &Frame, adobe: Option<u8>, denominator: u8) -> Decode<Gray> {
    let fast = frame.components.first().is_some_and(|component| {
        component.horizontal == frame.max_h && component.vertical == frame.max_v
    });
    if fast && !uses_rgb(frame, adobe) {
        return render_luma_scaled(frame, denominator);
    }
    downsample(&render_full(frame, adobe)?, denominator)
}

fn render_luma_scaled(frame: &Frame, denominator: u8) -> Decode<Gray> {
    let component = frame.components.first().ok_or(DecodeError::Format)?;
    let quant = component.quant.as_ref().ok_or(DecodeError::Format)?;
    let width = usize::try_from(frame.width).map_err(|_cause| DecodeError::Format)?;
    let height = usize::try_from(frame.height).map_err(|_cause| DecodeError::Format)?;
    let step = usize::from(denominator);
    let out_width = width.div_ceil(step);
    let out_height = height.div_ceil(step);
    let mut pixels = vec![0_u8; out_width.saturating_mul(out_height)];
    if denominator == 8 {
        paint_dc_plane(&mut pixels, component, quant, out_width, out_height)?;
    } else {
        paint_subsampled(
            &mut pixels,
            component,
            quant,
            width,
            height,
            step,
            out_width,
        )?;
    }
    Gray::new(
        u32::try_from(out_width).map_err(|_cause| DecodeError::Format)?,
        u32::try_from(out_height).map_err(|_cause| DecodeError::Format)?,
        pixels,
    )
    .map_err(DecodeError::Raster)
}

#[expect(
    clippy::arithmetic_side_effects,
    reason = "dequantized DC coefficients use the same rounding as the full inverse transform"
)]
fn paint_dc_plane(
    pixels: &mut [u8],
    component: &Component,
    quant: &Quant,
    out_width: usize,
    out_height: usize,
) -> Decode<()> {
    if component.columns == 0 {
        return Err(DecodeError::Format);
    }
    for (block_row, row) in component
        .blocks
        .chunks_exact(component.columns)
        .take(out_height)
        .enumerate()
    {
        for (block_column, block) in row.iter().take(out_width).enumerate() {
            let coefficient = i64::from(block.first().copied().unwrap_or(0));
            let scale = i64::from(quant.first().copied().unwrap_or(0));
            let pixel = sample((coefficient * scale + 4) >> 3_u32);
            let index = block_row
                .saturating_mul(out_width)
                .saturating_add(block_column);
            if let Some(slot) = pixels.get_mut(index) {
                *slot = pixel;
            }
        }
    }
    Ok(())
}

#[expect(
    clippy::arithmetic_side_effects,
    clippy::integer_division,
    clippy::integer_division_remainder_used,
    reason = "scaled output coordinates divide a position by 2 or 4"
)]
fn paint_subsampled(
    pixels: &mut [u8],
    component: &Component,
    quant: &Quant,
    width: usize,
    height: usize,
    step: usize,
    out_width: usize,
) -> Decode<()> {
    if component.columns == 0 || step == 0 {
        return Err(DecodeError::Format);
    }
    for (block_row, row) in component
        .blocks
        .chunks_exact(component.columns)
        .take(height.div_ceil(8))
        .enumerate()
    {
        for (block_column, block) in row.iter().take(width.div_ceil(8)).enumerate() {
            let decoded = inverse(block, quant);
            let origin_y = block_row.saturating_mul(8);
            let origin_x = block_column.saturating_mul(8);
            for delta_y in (0..8).step_by(step) {
                let y = origin_y.saturating_add(delta_y);
                if y >= height {
                    break;
                }
                let Some(samples) = decoded.get(delta_y) else {
                    continue;
                };
                for delta_x in (0..8).step_by(step) {
                    let x = origin_x.saturating_add(delta_x);
                    if x >= width {
                        break;
                    }
                    let Some(&pixel) = samples.get(delta_x) else {
                        continue;
                    };
                    let index = (y / step) * out_width + (x / step);
                    if let Some(slot) = pixels.get_mut(index) {
                        *slot = pixel;
                    }
                }
            }
        }
    }
    Ok(())
}

fn downsample(gray: &Gray, denominator: u8) -> Decode<Gray> {
    let step = usize::from(denominator);
    if step == 0 {
        return Err(DecodeError::Format);
    }
    let width = usize::try_from(gray.width).map_err(|_cause| DecodeError::Format)?;
    let height = usize::try_from(gray.height).map_err(|_cause| DecodeError::Format)?;
    let out_width = width.div_ceil(step);
    let out_height = height.div_ceil(step);
    let mut pixels = Vec::with_capacity(out_width.saturating_mul(out_height));
    for y in (0..height).step_by(step) {
        let row = y.saturating_mul(width);
        for x in (0..width).step_by(step) {
            pixels.push(gray.pixels.get(row.saturating_add(x)).copied().unwrap_or(0));
        }
    }
    Gray::new(
        u32::try_from(out_width).map_err(|_cause| DecodeError::Format)?,
        u32::try_from(out_height).map_err(|_cause| DecodeError::Format)?,
        pixels,
    )
    .map_err(DecodeError::Raster)
}

/// # Errors
/// Returns an error for malformed JPEG data or unsupported frame modes.
#[inline]
pub fn decode(input: &[u8]) -> Decode<Gray> {
    decode_scaled(input, 1)
}

/// Decodes a baseline or progressive JPEG to grayscale at `1/denominator` resolution.
///
/// `denominator` must be 1, 2, 4, or 8. A factor of 1 matches [`decode`]. A factor of 8 emits
/// one DC sample per block.
///
/// # Errors
/// Returns [`DecodeError::Unsupported`] for any other denominator, and [`DecodeError::Format`]
/// for malformed JPEG data.
#[inline]
pub fn decode_scaled(input: &[u8], denominator: u8) -> Decode<Gray> {
    if !matches!(denominator, 1 | 2 | 4 | 8) {
        return Err(DecodeError::Unsupported);
    }
    decode_frame(input, denominator)
}

fn decode_frame(mut input: &[u8], denominator: u8) -> Decode<Gray> {
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
            return render(
                image.as_mut().ok_or(DecodeError::Format)?,
                adobe,
                denominator,
            );
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
                frame.prepare(adobe, denominator)?;
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
    use std::fs;
    use std::path::Path;

    use crate::raster::read_pgm;

    use super::{DecodeError, decode, decode_scaled};

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
                (actual.width, actual.height, actual.pixels.len()),
                (expected.width, expected.height, expected.pixels.len())
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

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "scaled-decode checks compare pixels and dimensions"
    )]
    fn scaled_decode_matches_full_scale_and_rejects_other_factors() -> Result<(), DecodeError> {
        let jpeg = include_bytes!("../tests/fixtures/ycbcr.jpg");
        let full = decode(jpeg)?;
        assert_eq!(decode_scaled(jpeg, 1)?.pixels, full.pixels);
        let width = usize::try_from(full.width).unwrap_or(0);
        let height = usize::try_from(full.height).unwrap_or(0);
        let eighth = decode_scaled(jpeg, 8)?;
        assert_eq!(
            (eighth.width, eighth.height, eighth.pixels.len()),
            (
                u32::try_from(width.div_ceil(8)).unwrap_or(0),
                u32::try_from(height.div_ceil(8)).unwrap_or(0),
                width.div_ceil(8).saturating_mul(height.div_ceil(8)),
            )
        );
        let quarter = decode_scaled(jpeg, 4)?;
        assert_eq!(
            quarter.pixels.len(),
            width.div_ceil(4).saturating_mul(height.div_ceil(4))
        );
        assert_eq!(decode_scaled(jpeg, 3), Err(DecodeError::Unsupported));
        Ok(())
    }

    fn fingerprint(pixels: &[u8]) -> u64 {
        pixels
            .iter()
            .fold(0xcbf2_9ce4_8422_2325_u64, |state, &pixel| {
                state.wrapping_mul(0x0000_0100_0000_01b3) ^ u64::from(pixel)
            })
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "fingerprints lock full-scale pixels to the vision decoder"
    )]
    fn full_scale_matches_the_vision_decoder() -> Result<(), DecodeError> {
        let cases: &[(&str, &[u8], u64)] = &[
            (
                "restart",
                include_bytes!("../tests/fixtures/restart.jpg"),
                0x130d_f62e_04fe_4581,
            ),
            (
                "progressive",
                include_bytes!("../tests/fixtures/progressive.jpg"),
                0x1fe1_5c27_f3a1_df8d,
            ),
            (
                "ycbcr",
                include_bytes!("../tests/fixtures/ycbcr.jpg"),
                0x1fe1_5c27_f3a1_df8d,
            ),
            (
                "adobe-rgb",
                include_bytes!("../tests/fixtures/adobe-rgb.jpg"),
                0xd3ae_5331_9b7c_3456,
            ),
        ];
        for &(name, jpeg, expected) in cases {
            let image = decode(jpeg)?;
            assert_eq!(fingerprint(&image.pixels), expected, "{name}");
        }
        let scan = Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../.cache/jpeg-bench/0029p_contratacao-de-empresa-para-pavimentacao-com-bloco_23718034000111-2026-112.jpg"
        ));
        if let Ok(bytes) = fs::read(scan) {
            let image = decode(&bytes)?;
            assert_eq!(fingerprint(&image.pixels), 0x324a_c139_71b8_06a1, "0029p");
        }
        Ok(())
    }

    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    #[test]
    fn simd_idct_matches_scalar() {
        let rows = [
            [0_i64, 0, 0, 0, 0, 0, 0, 0],
            [10, 0, 0, 0, 0, 0, 0, 0],
            [4, -3, 2, -1, 5, 0, 1, -2],
            [100, 50, -50, 25, -25, 12, -12, 6],
        ];
        for row in rows {
            assert_eq!(super::transform_scalar(row), super::transform_simd(row));
        }
    }
}
