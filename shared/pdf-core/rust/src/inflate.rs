use crate::failure::{Failure, FailureCode, Outcome};
use crate::num::widen;
use core::iter;

const MAX_BITS: usize = 15;

const LENGTH_BASE: [usize; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];

const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

#[expect(
    clippy::decimal_literal_representation,
    reason = "RFC 1951 section 3.2.5 lists the distance base table in decimal"
)]
const DIST_BASE: [usize; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];

const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

const FIXED_DIST_LENS: [u8; 32] = [5_u8; 32];

const CODE_LENGTH_ORDER: [u8; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

const FAST_BITS: u32 = 10;

const FAST_SIZE: usize = 1 << FAST_BITS;

const FAST_MASK: u64 = (1 << FAST_BITS) - 1;
const MAX_SYMBOLS: usize = 288;
struct Huffman {
    counts: [u16; MAX_BITS + 1],
    fast: [u32; FAST_SIZE],
    first_code: [u16; MAX_BITS + 1],
    max_bits: u8,
    offset: [u16; MAX_BITS + 1],
    symbols: [u16; MAX_SYMBOLS],
}

struct BitReader<'data> {
    bit_buf: u64,
    bit_count: u32,
    data: &'data [u8],
    pos: usize,
}

impl<'data> BitReader<'data> {
    fn align_byte(&mut self) {
        let whole = widen(self.bit_count >> 3_i32);
        self.pos = self.pos.saturating_sub(whole);
        self.bit_buf = 0;
        self.bit_count = 0;
    }

    fn copy_stored_bytes(&mut self, out: &mut Vec<u8>, len: usize, max: usize) -> Outcome<()> {
        self.align_byte();
        let start = self.pos;
        let end = start.saturating_add(len);
        if end > self.data.len() {
            return Err(Failure::invalid("truncated stored block"));
        }
        let chunk = self
            .data
            .get(start..end)
            .ok_or_else(|| Failure::invalid("stored block slice"))?;
        let room = max.saturating_sub(out.len());
        if chunk.len() > room {
            out.extend_from_slice(chunk.get(..room).unwrap_or_default());
            return Err(Failure::limit("inflate output exceeds limit"));
        }
        out.extend_from_slice(chunk);
        self.pos = end;
        Ok(())
    }

    const fn new(data: &'data [u8]) -> Self {
        Self {
            data,
            pos: 0,
            bit_buf: 0,
            bit_count: 0,
        }
    }

    #[inline]
    fn refill(&mut self) {
        if let Some(chunk) = self
            .pos
            .checked_add(8)
            .and_then(|end| self.data.get(self.pos..end))
            && let Ok(bytes) = <[u8; 8]>::try_from(chunk)
        {
            let word = u64::from_le_bytes(bytes);
            self.bit_buf |= word << self.bit_count;
            let consumed = 63_u32.saturating_sub(self.bit_count) >> 3_i32;
            self.pos = self.pos.saturating_add(widen(consumed));
            self.bit_count = self.bit_count.saturating_add(consumed << 3);
            return;
        }
        while self.bit_count <= 56 {
            let Some(byte) = self.data.get(self.pos) else {
                break;
            };
            self.bit_buf |= u64::from(*byte) << self.bit_count;
            self.bit_count = self.bit_count.saturating_add(8);
            self.pos = self.pos.saturating_add(1);
        }
    }

    #[inline]
    fn take_bits(&mut self, count: u8) -> Option<u32> {
        let count_u32 = u32::from(count);
        if count_u32 == 0 {
            return Some(0);
        }
        if self.bit_count < count_u32 {
            self.refill();
            if self.bit_count < count_u32 {
                return None;
            }
        }
        let value = u32::try_from(self.bit_buf & ((1_u64 << count_u32).saturating_sub(1)))
            .unwrap_or(u32::MAX);
        self.bit_buf >>= count_u32;
        self.bit_count = self.bit_count.saturating_sub(count_u32);
        Some(value)
    }
}

impl Huffman {
    fn build(&mut self, lengths: &[u8]) -> Outcome<()> {
        let mut counts = [0_u16; MAX_BITS + 1];
        let mut max_len = 0_u8;
        for &len in lengths {
            max_len = max_len.max(len);
            if let Some(entry) = counts.get_mut(usize::from(len)) {
                *entry = entry.saturating_add(1);
            }
        }
        if max_len == 0 {
            return Err(Failure::invalid("empty huffman tree"));
        }
        if let Some(zero) = counts.first_mut() {
            *zero = 0;
        }

        let mut code = 0_u16;
        let mut symbol_offset = 0_u16;
        for bits in 1..=MAX_BITS {
            let prev_count = counts.get(bits.saturating_sub(1)).copied().unwrap_or(0);
            code = code.saturating_add(prev_count) << 1_i32;
            if let Some(dst) = self.first_code.get_mut(bits) {
                *dst = code;
            }
            if let Some(dst) = self.offset.get_mut(bits) {
                *dst = symbol_offset;
            }
            symbol_offset = symbol_offset.saturating_add(counts.get(bits).copied().unwrap_or(0));
        }

        let mut fill = self.offset;
        for (sym, &len) in lengths.iter().enumerate() {
            if len == 0 {
                continue;
            }
            if let Some(at) = fill.get_mut(usize::from(len)) {
                if let Some(cell) = self.symbols.get_mut(usize::from(*at)) {
                    *cell = u16::try_from(sym).unwrap_or(u16::MAX);
                }
                *at = at.saturating_add(1);
            }
        }

        self.fast.fill(0);
        let fast_max = usize::from(max_len).min(widen(FAST_BITS));
        for len in 1..=fast_max {
            let first = u32::from(self.first_code.get(len).copied().unwrap_or(0));
            let count = usize::from(counts.get(len).copied().unwrap_or(0));
            let base = usize::from(self.offset.get(len).copied().unwrap_or(0));
            let len32 = u32::try_from(len).unwrap_or(u32::MAX);
            let symbols = self
                .symbols
                .get(base..base.saturating_add(count))
                .unwrap_or_default();
            for (assigned_code, &sym) in (first..).zip(symbols) {
                if assigned_code >= (1_u32 << len32) {
                    break;
                }
                let reversed = assigned_code.reverse_bits() >> 32_u32.saturating_sub(len32);
                let entry = (len32 << 16_i32) | u32::from(sym);
                for cell in self
                    .fast
                    .iter_mut()
                    .skip(widen(reversed))
                    .step_by(1_usize << len)
                {
                    *cell = entry;
                }
            }
        }

        self.counts = counts;
        self.max_bits = max_len;
        Ok(())
    }

    const fn new() -> Self {
        Self {
            counts: [0; MAX_BITS + 1],
            first_code: [0; MAX_BITS + 1],
            offset: [0; MAX_BITS + 1],
            symbols: [0; MAX_SYMBOLS],
            max_bits: 0,
            fast: [0; FAST_SIZE],
        }
    }
}

fn partial_or_err(err: Failure, out: &[u8], truncate: bool) -> Outcome<Vec<u8>> {
    if err.code == FailureCode::LimitExceeded && !truncate {
        return Err(err);
    }
    if out.is_empty() {
        Err(err)
    } else {
        Ok(out.to_vec())
    }
}

fn fixed_lit_lens() -> [u8; 288] {
    let mut lens = [8_u8; 288];
    for (symbol, slot) in lens.iter_mut().enumerate() {
        *slot = match symbol {
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    lens
}

#[inline]
fn decode_symbol(bits: &mut BitReader<'_>, tree: &Huffman) -> Option<u16> {
    if bits.bit_count < u32::try_from(MAX_BITS).unwrap_or(u32::MAX) {
        bits.refill();
    }
    let window = usize::try_from(bits.bit_buf & FAST_MASK).unwrap_or_default();
    let entry = tree.fast.get(window).copied().unwrap_or(0);
    if entry != 0 {
        let len = entry >> 16_i32;
        if len > bits.bit_count {
            return None;
        }
        bits.bit_buf >>= len;
        bits.bit_count = bits.bit_count.saturating_sub(len);
        return u16::try_from(entry & 0xffff).ok();
    }
    decode_slow(bits, tree)
}

fn decode_slow(bits: &mut BitReader<'_>, tree: &Huffman) -> Option<u16> {
    let mut code = 0_u32;
    let mut len = 1_u8;
    while len <= tree.max_bits {
        if bits.bit_count == 0 {
            return None;
        }
        let bit = u32::from(bits.bit_buf & 1 == 1);
        bits.bit_buf >>= 1_i32;
        bits.bit_count = bits.bit_count.saturating_sub(1);
        code = (code << 1_i32) | bit;
        let slot = usize::from(len);
        let count = tree.counts.get(slot).copied().unwrap_or(0);
        if count > 0 {
            let first = u32::from(tree.first_code.get(slot).copied().unwrap_or(0));
            let max = first.saturating_add(u32::from(count));
            if code >= first && code < max {
                let base = tree.offset.get(slot).copied().unwrap_or(0);
                let index =
                    usize::from(base.saturating_add(
                        u16::try_from(code.saturating_sub(first)).unwrap_or(u16::MAX),
                    ));
                return tree.symbols.get(index).copied();
            }
        }
        len = len.saturating_add(1);
    }
    None
}

#[inline]
fn copy_match(out: &mut Vec<u8>, distance: usize, length: usize, max: usize) -> Outcome<()> {
    if distance == 0 || distance > out.len() {
        return Err(Failure::invalid("bad back-reference distance"));
    }
    let fits = length.min(max.saturating_sub(out.len()));
    let start = out.len().saturating_sub(distance);
    if distance == 1 {
        let byte = out.get(start).copied().unwrap_or(0);
        out.resize(out.len().saturating_add(fits), byte);
    } else {
        let mut remaining = fits;
        while remaining > 0 {
            let available = out.len().saturating_sub(start);
            let chunk = remaining.min(available);
            out.extend_from_within(start..start.saturating_add(chunk));
            remaining = remaining.saturating_sub(chunk);
        }
    }
    if fits < length {
        return Err(Failure::limit("inflate output exceeds limit"));
    }
    Ok(())
}

fn inflate_block(
    bits: &mut BitReader<'_>,
    out: &mut Vec<u8>,
    max: usize,
    lit: &Huffman,
    dist: &Huffman,
) -> Outcome<bool> {
    loop {
        let Some(sym) = decode_symbol(bits, lit) else {
            return if out.is_empty() {
                Err(Failure::invalid("truncated deflate stream"))
            } else {
                Ok(false)
            };
        };
        if sym < 256 {
            if out.len() >= max {
                return Err(Failure::limit("inflate output exceeds limit"));
            }
            out.push(u8::try_from(sym).unwrap_or(u8::MAX));
            continue;
        }
        if sym == 256 {
            return Ok(true);
        }
        let length_idx = usize::from(sym.saturating_sub(257));
        let base = LENGTH_BASE
            .get(length_idx)
            .copied()
            .ok_or_else(|| Failure::invalid("bad length symbol"))?;
        let extra_len = LENGTH_EXTRA
            .get(length_idx)
            .copied()
            .ok_or_else(|| Failure::invalid("bad length extra"))?;
        let extra = match extra_len {
            0 => 0_usize,
            count => widen(
                bits.take_bits(count)
                    .ok_or_else(|| Failure::invalid("truncated length extra"))?,
            ),
        };
        let length = base.saturating_add(extra);
        let Some(dist_sym) = decode_symbol(bits, dist) else {
            return if out.is_empty() {
                Err(Failure::invalid("truncated distance"))
            } else {
                Ok(false)
            };
        };
        let dist_idx = usize::from(dist_sym);
        let dist_base = DIST_BASE
            .get(dist_idx)
            .copied()
            .ok_or_else(|| Failure::invalid("bad distance symbol"))?;
        let dist_extra = DIST_EXTRA
            .get(dist_idx)
            .copied()
            .ok_or_else(|| Failure::invalid("bad distance extra"))?;
        let dist_bits = match dist_extra {
            0 => 0_usize,
            count => widen(
                bits.take_bits(count)
                    .ok_or_else(|| Failure::invalid("truncated distance extra"))?,
            ),
        };
        let distance = dist_base.saturating_add(dist_bits);
        copy_match(out, distance, length, max)?;
    }
}

fn read_dynamic_trees(
    bits: &mut BitReader<'_>,
    lit: &mut Huffman,
    dist: &mut Huffman,
) -> Outcome<()> {
    let hlit = widen(
        bits.take_bits(5)
            .ok_or_else(|| Failure::invalid("truncated hlit"))?
            .saturating_add(257),
    );
    let hdist = widen(
        bits.take_bits(5)
            .ok_or_else(|| Failure::invalid("truncated hdist"))?
            .saturating_add(1),
    );
    let hclen = widen(
        bits.take_bits(4)
            .ok_or_else(|| Failure::invalid("truncated hclen"))?
            .saturating_add(4),
    );

    let mut clens = [0_u8; 19];
    for position in 0..hclen {
        let ord = CODE_LENGTH_ORDER
            .get(position)
            .copied()
            .ok_or_else(|| Failure::invalid("code length order"))?;
        let len = bits
            .take_bits(3)
            .ok_or_else(|| Failure::invalid("truncated code length"))?;
        if let Some(slot) = clens.get_mut(usize::from(ord)) {
            *slot = u8::try_from(len).unwrap_or(u8::MAX);
        }
    }
    let mut cl_tree = Huffman::new();
    cl_tree.build(&clens)?;

    let mut lengths = Vec::with_capacity(hlit.saturating_add(hdist).saturating_add(138));
    while lengths.len() < hlit.saturating_add(hdist) {
        let Some(sym) = decode_symbol(bits, &cl_tree) else {
            return Err(Failure::invalid("truncated code lengths"));
        };
        if sym < 16 {
            lengths.push(u8::try_from(sym).unwrap_or(u8::MAX));
        } else if sym == 16 {
            let rep = widen(
                bits.take_bits(2)
                    .ok_or_else(|| Failure::invalid("truncated repeat"))?
                    .saturating_add(3),
            );
            let prev = *lengths
                .last()
                .ok_or_else(|| Failure::invalid("repeat without prev"))?;
            for _ in 0..rep {
                lengths.push(prev);
            }
        } else if sym == 17 {
            let rep = widen(
                bits.take_bits(3)
                    .ok_or_else(|| Failure::invalid("truncated repeat17"))?
                    .saturating_add(3),
            );
            lengths.extend(iter::repeat_n(0_u8, rep));
        } else if sym == 18 {
            let rep = widen(
                bits.take_bits(7)
                    .ok_or_else(|| Failure::invalid("truncated repeat18"))?
                    .saturating_add(11),
            );
            lengths.extend(iter::repeat_n(0_u8, rep));
        } else {
            return Err(Failure::invalid("bad code length symbol"));
        }
    }

    lit.build(
        lengths
            .get(..hlit)
            .ok_or_else(|| Failure::invalid("lit lengths"))?,
    )?;
    dist.build(
        lengths
            .get(hlit..hlit.saturating_add(hdist))
            .ok_or_else(|| Failure::invalid("dist lengths"))?,
    )
}

fn fixed_trees() -> Outcome<(Huffman, Huffman)> {
    let mut lit = Huffman::new();
    lit.build(&fixed_lit_lens())?;
    let mut dist = Huffman::new();
    dist.build(&FIXED_DIST_LENS)?;
    Ok((lit, dist))
}

fn skip_zlib_header(data: &[u8]) -> usize {
    if data.len() < 2 {
        return 0;
    }
    let cmf = data.first().copied().unwrap_or(0);
    let flg = data.get(1).copied().unwrap_or(0);
    if cmf & 0x0f == 8 && ((u16::from(cmf) << 8) | u16::from(flg)).rem_euclid(31) == 0 {
        2
    } else {
        0
    }
}

pub(crate) fn inflate(data: &[u8], max_output: usize) -> Outcome<Vec<u8>> {
    inflate_with(data, max_output, false)
}

pub(crate) fn inflate_prefix(data: &[u8], len: usize) -> Outcome<Vec<u8>> {
    inflate_with(data, len, true)
}

fn inflate_with(data: &[u8], max_output: usize, truncate: bool) -> Outcome<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len().saturating_mul(4).min(max_output));
    let skip = skip_zlib_header(data);
    let payload = data.get(skip..).map_or(data, |slice| slice);
    if payload.is_empty() && !data.is_empty() {
        return Ok(out);
    }
    let mut bits = BitReader::new(payload);
    let mut final_block = false;
    let mut fixed: Option<(Huffman, Huffman)> = None;
    let mut dynamic = (Huffman::new(), Huffman::new());

    while !final_block {
        let Some(hdr) = bits.take_bits(3) else { break };
        final_block = (hdr & 1) != 0;
        let btype = (hdr >> 1_i32) & 3;
        match btype {
            0 => {
                bits.align_byte();
                let len_bits = bits
                    .take_bits(16)
                    .ok_or_else(|| Failure::invalid("stored len"))?;
                let nlen_bits = bits
                    .take_bits(16)
                    .ok_or_else(|| Failure::invalid("stored nlen"))?;
                if len_bits.wrapping_add(nlen_bits) != 0xffff {
                    return partial_or_err(
                        Failure::invalid("stored block len mismatch"),
                        &out,
                        truncate,
                    );
                }
                let len = widen(len_bits);
                if let Err(err) = bits.copy_stored_bytes(&mut out, len, max_output) {
                    return partial_or_err(err, &out, truncate);
                }
            }
            1 => {
                if fixed.is_none() {
                    fixed = Some(fixed_trees()?);
                }
                let Some((lit, dist)) = &fixed else {
                    return partial_or_err(Failure::invalid("fixed huffman trees"), &out, truncate);
                };
                match inflate_block(&mut bits, &mut out, max_output, lit, dist) {
                    Ok(true) => {}
                    Ok(false) => return Ok(out),
                    Err(err) => return partial_or_err(err, &out, truncate),
                }
            }
            2 => {
                let (lit, dist) = &mut dynamic;
                read_dynamic_trees(&mut bits, lit, dist)?;
                match inflate_block(&mut bits, &mut out, max_output, lit, dist) {
                    Ok(true) => {}
                    Ok(false) => return Ok(out),
                    Err(err) => return partial_or_err(err, &out, truncate),
                }
            }
            _ => {
                return partial_or_err(
                    Failure::invalid("invalid deflate block type"),
                    &out,
                    truncate,
                );
            }
        }
    }

    if out.is_empty() && !payload.is_empty() {
        return Err(Failure::invalid("no inflated output"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::inflate;
    use core::array;

    const ZLIB_MB: &[u8] = include_bytes!("../tests/fixtures/repetitive_mb.zlib");
    const ZLIB_SKEWED: &[u8] = include_bytes!("../tests/fixtures/skewed.zlib");

    fn crc32_table() -> [u32; 256] {
        array::from_fn(|index| {
            let mut value = u32::try_from(index).unwrap();
            for _ in 0_i32..8_i32 {
                value = if value & 1 == 0 {
                    value >> 1_i32
                } else {
                    0xEDB8_8320 ^ (value >> 1_i32)
                };
            }
            value
        })
    }

    fn crc32(data: &[u8]) -> u32 {
        let table = crc32_table();
        let mut hash = 0xFFFF_FFFF_u32;
        for byte in data {
            let idx = usize::try_from((hash ^ u32::from(*byte)) & 0xff).unwrap();
            hash = table[idx] ^ (hash >> 8_i32);
        }
        hash ^ 0xFFFF_FFFF
    }

    fn adler32(data: &[u8]) -> u32 {
        let mut a = 1_u32;
        let mut b = 0_u32;
        for byte in data {
            a = (a.saturating_add(u32::from(*byte))).rem_euclid(0xFFF1);
            b = (b.saturating_add(a)).rem_euclid(0xFFF1);
        }
        (b << 16) | a
    }

    #[test]
    fn fixed_tree_layout() {
        use super::fixed_trees;
        let (lit, _) = fixed_trees().expect("lit");
        assert_eq!(lit.counts[8], 152);
        assert_eq!(lit.first_code[8], 48);
        assert_eq!(lit.offset[8], 24);
        assert_eq!(lit.symbols.get(91).copied(), Some(67));
    }

    #[test]
    fn decode_first_fixed_symbol() {
        use super::{BitReader, decode_symbol, fixed_trees};
        let (lit, _) = fixed_trees().expect("lit");
        let data = [
            0xcb_u8, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01, 0x00,
        ];
        let mut bits = BitReader::new(&data);
        let hdr = bits.take_bits(3).expect("hdr");
        assert_eq!(hdr, 3);
        let sym = decode_symbol(&mut bits, &lit).expect("sym");
        assert_eq!(sym, 104);
    }

    #[test]
    fn zlib_hello() {
        let data = [
            0x78_u8, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01,
            0x00, 0x1a, 0x0b, 0x04, 0x5d,
        ];
        let out = inflate(&data, 1024).expect("inflate");
        assert_eq!(out, b"hello world");
    }

    #[test]
    fn raw_deflate_no_header() {
        let data = [
            0xcb_u8, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01, 0x00,
        ];
        let out = inflate(&data, 1024).expect("inflate");
        assert_eq!(out, b"hello world");
    }

    #[test]
    fn repetitive_mb_output() {
        let out = inflate(ZLIB_MB, 2 * 1024 * 1024).expect("mb");
        assert_eq!(out.len(), 0x0010_0000);
        assert_eq!(&out[..4], b"ABCD");
        assert_eq!(&out[out.len().saturating_sub(4)..], b"ABCD");
        assert_eq!(crc32(&out), 0x73B9_1CF3);
        assert_eq!(adler32(&out), 0x59E3_3E59);
    }

    #[test]
    fn skewed_alphabet_exercises_long_codes_and_overlapping_matches() {
        let out = inflate(ZLIB_SKEWED, 1024 * 1024).expect("skewed");
        assert_eq!(out.len(), 67_500);
        assert_eq!(crc32(&out), 0x5C83_4526);
        assert_eq!(adler32(&out), 0xD0BD_5B93);
    }

    #[test]
    fn truncated_stream_returns_the_decoded_prefix() {
        let cut = ZLIB_SKEWED
            .get(..ZLIB_SKEWED.len() >> 1_i32)
            .expect("prefix");
        let out = inflate(cut, 1024 * 1024).expect("partial");
        assert_ne!(out, []);
        assert!(out.len() < 67_500);
    }

    #[test]
    fn prefix_matches_the_full_output_at_every_cut() {
        use super::inflate_prefix;
        for data in [ZLIB_SKEWED, ZLIB_MB] {
            let full = inflate(data, 64 * 1024 * 1024).expect("full");
            for len in [
                0_usize,
                1,
                2,
                257,
                258,
                259,
                1000,
                4095,
                4096,
                0x0001_0001,
                full.len(),
            ] {
                let expected = full.get(..len.min(full.len())).expect("slice");
                if len == 0 {
                    drop(inflate_prefix(data, len).expect_err("empty prefix"));
                } else {
                    assert_eq!(inflate_prefix(data, len).expect("prefix"), expected);
                }
            }
        }
    }

    #[test]
    fn stored_prefix_stops_exactly_at_the_cut() {
        use super::inflate_prefix;
        let stored = [
            0x78_u8, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, b'h', b'e', b'l', b'l', b'o',
        ];
        assert_eq!(inflate_prefix(&stored, 3).expect("prefix"), b"hel");
        drop(inflate(&stored, 3).expect_err("limit"));
    }

    #[test]
    fn stored_zlib_block() {
        let data = [
            0x78_u8, 0x01, 0x01, 0x0b, 0x00, 0xf4, 0xff, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77,
            0x6f, 0x72, 0x6c, 0x64, 0x1a, 0x0b, 0x04, 0x5d,
        ];
        let out = inflate(&data, 1024).expect("inflate");
        assert_eq!(out, b"hello world");
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    #[kani::unwind(12)]
    fn inflate_never_panics_on_short_input() {
        let bytes: [u8; 4] = kani::any();
        if let Ok(out) = inflate(&bytes, 8) {
            assert!(out.len() <= 8);
        }
    }
}
