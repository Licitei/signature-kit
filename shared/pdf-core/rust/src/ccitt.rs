use crate::num::widen;
use std::sync::OnceLock;

const PEEK_BITS: u32 = 13;
const TABLE_SIZE: usize = 1 << PEEK_BITS;
const MAX_COLUMNS: usize = 1 << 16;
const MAX_FILL_BITS: usize = 1 << 12;
const MAX_RUN_CODES: usize = 64;
const WHITE_TERMINATING: [(u8, u16); 64] = [
    (8, 0x35),
    (6, 0x07),
    (4, 0x07),
    (4, 0x08),
    (4, 0x0B),
    (4, 0x0C),
    (4, 0x0E),
    (4, 0x0F),
    (5, 0x13),
    (5, 0x14),
    (5, 0x07),
    (5, 0x08),
    (6, 0x08),
    (6, 0x03),
    (6, 0x34),
    (6, 0x35),
    (6, 0x2A),
    (6, 0x2B),
    (7, 0x27),
    (7, 0x0C),
    (7, 0x08),
    (7, 0x17),
    (7, 0x03),
    (7, 0x04),
    (7, 0x28),
    (7, 0x2B),
    (7, 0x13),
    (7, 0x24),
    (7, 0x18),
    (8, 0x02),
    (8, 0x03),
    (8, 0x1A),
    (8, 0x1B),
    (8, 0x12),
    (8, 0x13),
    (8, 0x14),
    (8, 0x15),
    (8, 0x16),
    (8, 0x17),
    (8, 0x28),
    (8, 0x29),
    (8, 0x2A),
    (8, 0x2B),
    (8, 0x2C),
    (8, 0x2D),
    (8, 0x04),
    (8, 0x05),
    (8, 0x0A),
    (8, 0x0B),
    (8, 0x52),
    (8, 0x53),
    (8, 0x54),
    (8, 0x55),
    (8, 0x24),
    (8, 0x25),
    (8, 0x58),
    (8, 0x59),
    (8, 0x5A),
    (8, 0x5B),
    (8, 0x4A),
    (8, 0x4B),
    (8, 0x32),
    (8, 0x33),
    (8, 0x34),
];
const WHITE_MAKEUP: [(u8, u16); 27] = [
    (5, 0x1B),
    (5, 0x12),
    (6, 0x17),
    (7, 0x37),
    (8, 0x36),
    (8, 0x37),
    (8, 0x64),
    (8, 0x65),
    (8, 0x68),
    (8, 0x67),
    (9, 0xCC),
    (9, 0xCD),
    (9, 0xD2),
    (9, 0xD3),
    (9, 0xD4),
    (9, 0xD5),
    (9, 0xD6),
    (9, 0xD7),
    (9, 0xD8),
    (9, 0xD9),
    (9, 0xDA),
    (9, 0xDB),
    (9, 0x98),
    (9, 0x99),
    (9, 0x9A),
    (6, 0x18),
    (9, 0x9B),
];
const BLACK_TERMINATING: [(u8, u16); 64] = [
    (10, 0x37),
    (3, 0x02),
    (2, 0x03),
    (2, 0x02),
    (3, 0x03),
    (4, 0x03),
    (4, 0x02),
    (5, 0x03),
    (6, 0x05),
    (6, 0x04),
    (7, 0x04),
    (7, 0x05),
    (7, 0x07),
    (8, 0x04),
    (8, 0x07),
    (9, 0x18),
    (10, 0x17),
    (10, 0x18),
    (10, 0x08),
    (11, 0x67),
    (11, 0x68),
    (11, 0x6C),
    (11, 0x37),
    (11, 0x28),
    (11, 0x17),
    (11, 0x18),
    (12, 0xCA),
    (12, 0xCB),
    (12, 0xCC),
    (12, 0xCD),
    (12, 0x68),
    (12, 0x69),
    (12, 0x6A),
    (12, 0x6B),
    (12, 0xD2),
    (12, 0xD3),
    (12, 0xD4),
    (12, 0xD5),
    (12, 0xD6),
    (12, 0xD7),
    (12, 0x6C),
    (12, 0x6D),
    (12, 0xDA),
    (12, 0xDB),
    (12, 0x54),
    (12, 0x55),
    (12, 0x56),
    (12, 0x57),
    (12, 0x64),
    (12, 0x65),
    (12, 0x52),
    (12, 0x53),
    (12, 0x24),
    (12, 0x37),
    (12, 0x38),
    (12, 0x27),
    (12, 0x28),
    (12, 0x58),
    (12, 0x59),
    (12, 0x2B),
    (12, 0x2C),
    (12, 0x5A),
    (12, 0x66),
    (12, 0x67),
];
const BLACK_MAKEUP: [(u8, u16); 27] = [
    (10, 0x0F),
    (12, 0xC8),
    (12, 0xC9),
    (12, 0x5B),
    (12, 0x33),
    (12, 0x34),
    (12, 0x35),
    (13, 0x6C),
    (13, 0x6D),
    (13, 0x4A),
    (13, 0x4B),
    (13, 0x4C),
    (13, 0x4D),
    (13, 0x72),
    (13, 0x73),
    (13, 0x74),
    (13, 0x75),
    (13, 0x76),
    (13, 0x77),
    (13, 0x52),
    (13, 0x53),
    (13, 0x54),
    (13, 0x55),
    (13, 0x5A),
    (13, 0x5B),
    (13, 0x64),
    (13, 0x65),
];
const EXTENDED_MAKEUP: [(u8, u16); 13] = [
    (11, 0x08),
    (11, 0x0C),
    (11, 0x0D),
    (12, 0x12),
    (12, 0x13),
    (12, 0x14),
    (12, 0x15),
    (12, 0x16),
    (12, 0x17),
    (12, 0x1C),
    (12, 0x1D),
    (12, 0x1E),
    (12, 0x1F),
];
static WHITE_TABLE: OnceLock<Vec<u32>> = OnceLock::new();
static BLACK_TABLE: OnceLock<Vec<u32>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CcittParams {
    pub black_is_1: bool,
    pub byte_align: bool,
    pub columns: usize,
    pub end_of_line: bool,
    pub k_factor: i64,
    pub rows: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Horizontal,
    Pass,
    Stop,
    Vertical(i64),
}

struct Bits<'data> {
    data: &'data [u8],
    position: usize,
}

impl Bits<'_> {
    const fn align(&mut self) {
        self.position = self.position.saturating_add(7) & !7;
    }

    const fn at_end(&self) -> bool {
        self.position >= self.data.len().saturating_mul(8)
    }

    fn consume(&mut self, count: u32) {
        self.position = self.position.saturating_add(widen(count));
    }

    fn peek(&self, count: u32) -> u32 {
        let mut value = 0_u32;
        let byte_index = self.position >> 3_u32;
        let mut window = 0_u32;
        for offset in 0..4_usize {
            window = (window << 8_u32)
                | u32::from(
                    self.data
                        .get(byte_index.saturating_add(offset))
                        .copied()
                        .unwrap_or(0),
                );
        }
        let skip = u32::try_from(self.position & 7).unwrap_or(0);
        if count > 0 {
            value = (window << skip) >> (32_u32.saturating_sub(count));
        }
        value
    }
}

fn build_table(terminating: &[(u8, u16); 64], makeup: &[(u8, u16); 27]) -> Vec<u32> {
    let mut table = vec![0_u32; TABLE_SIZE];
    let mut place = |length: u8, code: u16, run: u32| {
        let shift = PEEK_BITS.saturating_sub(u32::from(length));
        let start = usize::from(code) << shift;
        let count = 1_usize << shift;
        if let Some(slots) = table.get_mut(start..start.saturating_add(count)) {
            slots.fill((run << 8_u32) | u32::from(length));
        }
    };
    for (run, (length, code)) in (0_u32..).zip(terminating) {
        place(*length, *code, run);
    }
    for (step, (length, code)) in (1_u32..).zip(makeup) {
        place(*length, *code, step.saturating_mul(64));
    }
    for (step, (length, code)) in (28_u32..).zip(&EXTENDED_MAKEUP) {
        place(*length, *code, step.saturating_mul(64));
    }
    table
}

fn read_run(bits: &mut Bits<'_>, black: bool) -> Option<usize> {
    let table = if black {
        BLACK_TABLE.get_or_init(|| build_table(&BLACK_TERMINATING, &BLACK_MAKEUP))
    } else {
        WHITE_TABLE.get_or_init(|| build_table(&WHITE_TERMINATING, &WHITE_MAKEUP))
    };
    let mut total = 0_usize;
    for _ in 0..MAX_RUN_CODES {
        if bits.at_end() {
            return None;
        }
        let entry = *table.get(usize::try_from(bits.peek(PEEK_BITS)).ok()?)?;
        let length = entry & 0xFF;
        if length == 0 {
            return None;
        }
        bits.consume(length);
        let run = usize::try_from(entry >> 8_u32).ok()?;
        total = total.saturating_add(run);
        if run < 64 {
            return Some(total);
        }
    }
    None
}

fn read_mode(bits: &mut Bits<'_>) -> Mode {
    let peek = bits.peek(7);
    let (length, mode) = if peek >> 6_u32 == 1 {
        (1, Mode::Vertical(0))
    } else if peek >> 4_u32 == 0b011 {
        (3, Mode::Vertical(1))
    } else if peek >> 4_u32 == 0b010 {
        (3, Mode::Vertical(-1))
    } else if peek >> 4_u32 == 0b001 {
        (3, Mode::Horizontal)
    } else if peek >> 3_u32 == 0b0001 {
        (4, Mode::Pass)
    } else if peek >> 1_u32 == 0b00_0011 {
        (6, Mode::Vertical(2))
    } else if peek >> 1_u32 == 0b00_0010 {
        (6, Mode::Vertical(-2))
    } else if peek == 0b000_0011 {
        (7, Mode::Vertical(3))
    } else if peek == 0b000_0010 {
        (7, Mode::Vertical(-3))
    } else {
        (0, Mode::Stop)
    };
    bits.consume(length);
    mode
}

fn skip_eol(bits: &mut Bits<'_>, params: &CcittParams) {
    for _ in 0..MAX_FILL_BITS {
        if bits.at_end() {
            return;
        }
        if bits.peek(12) == 1 {
            bits.consume(12);
            continue;
        }
        if params.end_of_line && bits.peek(1) == 0 && bits.peek(12) == 0 {
            bits.consume(1);
            continue;
        }
        return;
    }
}

fn push_change(line: &mut Vec<usize>, position: usize, columns: usize) {
    let clamped = position.min(columns);
    if line.last().is_some_and(|last| *last > clamped) {
        line.push(line.last().copied().unwrap_or(clamped));
    } else {
        line.push(clamped);
    }
}

fn decode_1d(bits: &mut Bits<'_>, columns: usize, line: &mut Vec<usize>) -> Option<()> {
    let mut position = 0_usize;
    let mut black = false;
    while position < columns {
        let run = read_run(bits, black)?;
        position = position.saturating_add(run);
        push_change(line, position, columns);
        black = !black;
    }
    Some(())
}

fn decode_2d(
    bits: &mut Bits<'_>,
    columns: usize,
    reference: &[usize],
    line: &mut Vec<usize>,
) -> Option<()> {
    let mut a0: Option<usize> = None;
    let mut black = false;
    let mut search = 0_usize;
    loop {
        let start = a0.unwrap_or(0);
        if a0.is_some() && start >= columns {
            return Some(());
        }
        search = search.saturating_sub(2);
        while let Some(&element) = reference.get(search) {
            let opposite = (search & 1 == 1) == black;
            if opposite && a0.is_none_or(|current| element > current) {
                break;
            }
            search = search.saturating_add(1);
        }
        let b1 = reference.get(search).copied().unwrap_or(columns);
        let b2 = reference
            .get(search.saturating_add(1))
            .copied()
            .unwrap_or(columns);
        match read_mode(bits) {
            Mode::Pass => a0 = Some(b2),
            Mode::Horizontal => {
                let a1 = start.saturating_add(read_run(bits, black)?);
                let a2 = a1.saturating_add(read_run(bits, !black)?);
                push_change(line, a1, columns);
                push_change(line, a2, columns);
                a0 = Some(a2.min(columns));
            }
            Mode::Vertical(delta) => {
                let magnitude = usize::try_from(delta.unsigned_abs()).ok()?;
                let a1 = if delta >= 0 {
                    b1.saturating_add(magnitude)
                } else {
                    b1.saturating_sub(magnitude)
                };
                push_change(line, a1, columns);
                a0 = Some(a1.min(columns));
                black = !black;
            }
            Mode::Stop => return None,
        }
    }
}

fn fill_row(row: &mut [u8], line: &[usize], black_bit: bool) {
    row.fill(if black_bit { 0x00 } else { 0xFF });
    for pair in line.chunks(2) {
        let start = pair.first().copied().unwrap_or(0);
        let end = pair
            .get(1)
            .copied()
            .unwrap_or_else(|| row.len().saturating_mul(8));
        for pixel in start..end {
            if let Some(byte) = row.get_mut(pixel >> 3_u32) {
                let mask = 0x80_u8 >> (pixel & 7);
                if black_bit {
                    *byte |= mask;
                } else {
                    *byte &= !mask;
                }
            }
        }
    }
}

pub(crate) fn decode(data: &[u8], params: &CcittParams, max_output: usize) -> Option<Vec<u8>> {
    let columns = params.columns;
    if columns == 0 || columns > MAX_COLUMNS || params.rows == 0 {
        return None;
    }
    let row_bytes = columns.div_ceil(8);
    let total = row_bytes.checked_mul(params.rows)?;
    if total > max_output {
        return None;
    }
    let mut output = vec![if params.black_is_1 { 0 } else { 0xFF }; total];
    let mut bits = Bits { data, position: 0 };
    let mut reference: Vec<usize> = vec![columns, columns];
    let mut line: Vec<usize> = Vec::with_capacity(columns.min(4096));
    for row in output.chunks_mut(row_bytes) {
        if params.byte_align {
            bits.align();
        }
        if params.k_factor >= 0 || params.end_of_line {
            skip_eol(&mut bits, params);
        }
        if bits.at_end() {
            break;
        }
        let two_dimensional = match params.k_factor {
            value if value < 0 => true,
            0 => false,
            _ => {
                let tag = bits.peek(1) == 0;
                bits.consume(1);
                tag
            }
        };
        line.clear();
        let decoded = if two_dimensional {
            decode_2d(&mut bits, columns, &reference, &mut line)
        } else {
            decode_1d(&mut bits, columns, &mut line)
        };
        if decoded.is_none() {
            break;
        }
        fill_row(row, &line, params.black_is_1);
        reference.clear();
        reference.extend_from_slice(&line);
        reference.push(columns);
        reference.push(columns);
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIDTH: usize = 37;
    const HEIGHT: usize = 10;

    const GROUP4: [u8; 89] = [
        0x23, 0x91, 0x1C, 0x88, 0xE4, 0x47, 0x22, 0x39, 0x2A, 0x29, 0xC2, 0x08, 0x4A, 0x1C, 0x20,
        0x84, 0xA1, 0xC2, 0x08, 0x4A, 0x1C, 0x20, 0x84, 0xA1, 0xC2, 0x08, 0x7D, 0x82, 0x49, 0x82,
        0x49, 0x82, 0x49, 0x82, 0x49, 0x84, 0xB0, 0xC1, 0x08, 0x84, 0x27, 0x01, 0x8D, 0xA9, 0x6E,
        0x4D, 0xF0, 0xC8, 0xE7, 0x11, 0xD9, 0x1C, 0x1A, 0x1B, 0x23, 0x91, 0x1C, 0x88, 0xE4, 0x47,
        0x25, 0x47, 0x1C, 0x20, 0x99, 0x7C, 0x21, 0x28, 0x70, 0x82, 0x12, 0x87, 0x08, 0x21, 0x28,
        0x70, 0x82, 0x1D, 0x20, 0x84, 0x44, 0x44, 0x44, 0x41, 0x80, 0x08, 0x00, 0x80, 0x00,
    ];

    const GROUP3: [u8; 89] = [
        0x00, 0x11, 0xC8, 0x72, 0x1C, 0x87, 0x21, 0xC8, 0x74, 0x00, 0x26, 0xA9, 0xF1, 0xE1, 0xF1,
        0xE1, 0xF1, 0xE1, 0xF1, 0xE1, 0xF1, 0xE0, 0x01, 0x35, 0x4F, 0x0E, 0x87, 0x63, 0xA1, 0xD8,
        0xE8, 0x76, 0x3A, 0x1D, 0x8E, 0x87, 0x00, 0x13, 0x58, 0x71, 0xD0, 0x18, 0x00, 0x13, 0x59,
        0xCC, 0xED, 0xCD, 0xD8, 0x00, 0x9A, 0x98, 0xE7, 0x40, 0x60, 0x00, 0x4D, 0x48, 0x70, 0x68,
        0x00, 0x11, 0xC8, 0x72, 0x1C, 0x87, 0x21, 0xC8, 0x74, 0x00, 0x26, 0xB8, 0xF8, 0xFB, 0xE3,
        0xC3, 0xE3, 0xC3, 0xE3, 0xC3, 0xE3, 0xC0, 0x02, 0x6A, 0x87, 0x42, 0x60, 0x00, 0x00,
    ];

    const MODIFIED_HUFFMAN: [u8; 76] = [
        0x1C, 0x87, 0x21, 0xC8, 0x72, 0x1C, 0x87, 0x40, 0x35, 0x4F, 0x8F, 0x0F, 0x8F, 0x0F, 0x8F,
        0x0F, 0x8F, 0x0F, 0x8F, 0x00, 0x35, 0x4F, 0x0E, 0x87, 0x63, 0xA1, 0xD8, 0xE8, 0x76, 0x3A,
        0x1D, 0x8E, 0x87, 0x35, 0x87, 0x1D, 0x01, 0x80, 0x35, 0x9C, 0xCE, 0xDC, 0xDD, 0x80, 0x35,
        0x31, 0xCE, 0x80, 0xC0, 0x35, 0x21, 0xC1, 0xA0, 0x1C, 0x87, 0x21, 0xC8, 0x72, 0x1C, 0x87,
        0x40, 0x35, 0xC7, 0xC7, 0xDF, 0x1E, 0x1F, 0x1E, 0x1F, 0x1E, 0x1F, 0x1E, 0x35, 0x43, 0xA1,
        0x30,
    ];

    fn pattern_white(x: usize, y: usize) -> bool {
        x.wrapping_mul(x)
            .wrapping_add(y.wrapping_mul(3))
            .is_multiple_of(7)
            || (11..20).contains(&x) && (3..6).contains(&y)
            || x == y
            || y == 9 && x > 2
    }

    fn params(factor: i64, byte_align: bool) -> CcittParams {
        CcittParams {
            black_is_1: true,
            byte_align,
            columns: WIDTH,
            end_of_line: false,
            k_factor: factor,
            rows: HEIGHT,
        }
    }

    fn assert_pattern(decoded: &[u8]) {
        let row_bytes = WIDTH.div_ceil(8);
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let bit = (decoded[y.wrapping_mul(row_bytes).wrapping_add(x >> 3)]
                    >> (7_usize.wrapping_sub(x & 7)))
                    & 1;
                assert_eq!(bit == 1, !pattern_white(x, y), "pixel {x},{y}");
            }
        }
    }

    #[test]
    fn decodes_group4() {
        assert_pattern(&decode(&GROUP4, &params(-1, false), 1 << 20).unwrap());
    }

    #[test]
    fn decodes_group3_one_dimensional_with_eols() {
        assert_pattern(&decode(&GROUP3, &params(0, false), 1 << 20).unwrap());
    }

    #[test]
    fn decodes_byte_aligned_modified_huffman() {
        assert_pattern(&decode(&MODIFIED_HUFFMAN, &params(0, true), 1 << 20).unwrap());
    }

    #[test]
    fn black_is_zero_inverts_the_output() {
        let mut inverted = params(-1, false);
        inverted.black_is_1 = false;
        let normal = decode(&GROUP4, &params(-1, false), 1 << 20).unwrap();
        let flipped = decode(&GROUP4, &inverted, 1 << 20).unwrap();
        let row_bytes = WIDTH.div_ceil(8);
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let index = y.wrapping_mul(row_bytes).wrapping_add(x >> 3);
                let shift = 7_usize.wrapping_sub(x & 7);
                assert_ne!((normal[index] >> shift) & 1, (flipped[index] >> shift) & 1);
            }
        }
    }

    #[test]
    fn hostile_input_is_bounded() {
        assert!(decode(&GROUP4, &params(-1, false), 4).is_none());
        let mut huge = params(-1, false);
        huge.columns = MAX_COLUMNS + 1;
        assert!(decode(&GROUP4, &huge, usize::MAX).is_none());
        for seed in 0..64_u8 {
            let noise: Vec<u8> = (0..200_u8)
                .map(|index| index.wrapping_mul(31).wrapping_add(seed).rotate_left(3))
                .collect();
            for factor in [-1, 0, 2] {
                let _decoded = decode(&noise, &params(factor, seed.is_multiple_of(2)), 1 << 20);
            }
        }
        let truncated = decode(GROUP4.get(..20).unwrap(), &params(-1, false), 1 << 20).unwrap();
        assert_eq!(truncated.len(), WIDTH.div_ceil(8) * HEIGHT);
    }
}
