use crate::failure::{Failure, FailureCode, Outcome};

fn partial_or_err(err: Failure, out: &[u8]) -> Outcome<Vec<u8>> {
    if err.code == FailureCode::LimitExceeded {
        return Err(err);
    }
    if out.is_empty() {
        Err(err)
    } else {
        Ok(out.to_vec())
    }
}

const MAX_BITS: usize = 15;

const LENGTH_BASE: [usize; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];

const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

const DIST_BASE: [usize; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];

const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

fn fixed_lit_lens() -> [u8; 288] {
    let mut lens = [0u8; 288];
    let mut i = 0usize;
    while i < 144 {
        if let Some(slot) = lens.get_mut(i) {
            *slot = 8;
        }
        i = i.saturating_add(1);
    }
    while i < 256 {
        if let Some(slot) = lens.get_mut(i) {
            *slot = 9;
        }
        i = i.saturating_add(1);
    }
    while i < 280 {
        if let Some(slot) = lens.get_mut(i) {
            *slot = 7;
        }
        i = i.saturating_add(1);
    }
    while i < 288 {
        if let Some(slot) = lens.get_mut(i) {
            *slot = 8;
        }
        i = i.saturating_add(1);
    }
    lens
}

const FIXED_DIST_LENS: [u8; 32] = [5u8; 32];

const CODE_LENGTH_ORDER: [u8; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

struct Huffman {
    counts: [u16; MAX_BITS + 1],
    first_code: [u16; MAX_BITS + 1],
    offset: [u16; MAX_BITS + 1],
    symbols: Vec<u16>,
    max_bits: u8,
}

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    bit_buf: u32,
    bit_count: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            pos: 0,
            bit_buf: 0,
            bit_count: 0,
        }
    }

    fn read_bit(&mut self) -> Option<u32> {
        if self.bit_count == 0 {
            let byte = self.data.get(self.pos)?;
            self.pos = self.pos.saturating_add(1);
            self.bit_buf = u32::from(*byte);
            self.bit_count = 8;
        }
        let bit = self.bit_buf & 1;
        self.bit_buf >>= 1;
        self.bit_count = self.bit_count.saturating_sub(1);
        Some(bit)
    }

    fn take_bits(&mut self, count: u8) -> Option<u32> {
        let mut value = 0u32;
        let mut i = 0u8;
        while i < count {
            value |= (self.read_bit()? & 1) << i;
            i = i.saturating_add(1);
        }
        Some(value)
    }

    fn align_byte(&mut self) {
        let discard = self.bit_count & 7;
        if discard > 0 {
            let _ = self.take_bits(discard);
        }
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
        if out.len().saturating_add(chunk.len()) > max {
            return Err(Failure::limit("inflate output exceeds limit"));
        }
        out.extend_from_slice(chunk);
        self.pos = end;
        Ok(())
    }
}

fn build_huffman(lengths: &[u8]) -> Outcome<Huffman> {
    let mut max_len = 0u8;
    for &len in lengths {
        if len > max_len {
            max_len = len;
        }
    }
    if max_len == 0 {
        return Err(Failure::invalid("empty huffman tree"));
    }

    let mut counts = [0u16; MAX_BITS + 1];
    for &len in lengths {
        if len > 0 {
            let slot = usize::from(len);
            if let Some(entry) = counts.get_mut(slot) {
                *entry = entry.saturating_add(1);
            }
        }
    }

    let mut next_code = [0u16; MAX_BITS + 1];
    let mut code = 0u16;
    let mut bits = 1u8;
    while usize::from(bits) <= MAX_BITS {
        let prev = usize::from(bits).saturating_sub(1);
        let prev_count = counts.get(prev).copied().unwrap_or(0);
        code = code.saturating_add(prev_count) << 1;
        if let Some(slot) = next_code.get_mut(usize::from(bits)) {
            *slot = code;
        }
        bits = bits.saturating_add(1);
    }

    let mut first_code = [0u16; MAX_BITS + 1];
    let mut offset = [0u16; MAX_BITS + 1];
    let mut symbol_offset = 0u16;
    let mut bit = 1u8;
    while usize::from(bit) <= MAX_BITS {
        let slot = usize::from(bit);
        if let Some(dst) = first_code.get_mut(slot) {
            *dst = next_code.get(slot).copied().unwrap_or(0);
        }
        if let Some(dst) = offset.get_mut(slot) {
            *dst = symbol_offset;
        }
        symbol_offset = symbol_offset.saturating_add(counts.get(slot).copied().unwrap_or(0));
        bit = bit.saturating_add(1);
    }

    let mut lens_sorted: Vec<(u8, u16)> = lengths
        .iter()
        .enumerate()
        .filter_map(|(sym, &len)| {
            if len > 0 {
                Some((len, sym as u16))
            } else {
                None
            }
        })
        .collect();
    lens_sorted.sort_by_key(|(len, sym)| (*len, *sym));

    let mut symbols = Vec::with_capacity(lens_sorted.len());
    for &(_, sym) in &lens_sorted {
        symbols.push(sym);
    }

    Ok(Huffman {
        counts,
        first_code,
        offset,
        symbols,
        max_bits: max_len,
    })
}

fn decode_symbol(bits: &mut BitReader<'_>, tree: &Huffman) -> Option<u16> {
    let mut code = 0u32;
    let mut len = 1u8;
    while len <= tree.max_bits {
        let bit = bits.read_bit()?;
        code = (code << 1) | bit;
        let slot = usize::from(len);
        let count = tree.counts.get(slot).copied().unwrap_or(0);
        if count > 0 {
            let first = u32::from(tree.first_code.get(slot).copied().unwrap_or(0));
            let max = first.saturating_add(u32::from(count));
            if code >= first && code < max {
                let base = tree.offset.get(slot).copied().unwrap_or(0);
                let index = usize::from(base.saturating_add((code.saturating_sub(first)) as u16));
                return tree.symbols.get(index).copied();
            }
        }
        len = len.saturating_add(1);
    }
    None
}

fn copy_match(out: &mut Vec<u8>, distance: usize, length: usize, max: usize) -> Outcome<()> {
    if distance == 0 || distance > out.len() {
        return Err(Failure::invalid("bad back-reference distance"));
    }
    if out.len().saturating_add(length) > max {
        return Err(Failure::limit("inflate output exceeds limit"));
    }
    for _ in 0..length {
        let idx = out.len().saturating_sub(distance);
        let b = *out
            .get(idx)
            .ok_or_else(|| Failure::invalid("back-reference read"))?;
        out.push(b);
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
        let sym = match decode_symbol(bits, lit) {
            Some(s) => s,
            None => {
                return if out.is_empty() {
                    Err(Failure::invalid("truncated deflate stream"))
                } else {
                    Ok(false)
                };
            }
        };
        if sym < 256 {
            if out.len() >= max {
                return Err(Failure::limit("inflate output exceeds limit"));
            }
            out.push(sym as u8);
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
            0 => 0usize,
            n => bits
                .take_bits(n)
                .ok_or_else(|| Failure::invalid("truncated length extra"))?
                as usize,
        };
        let length = base.saturating_add(extra);
        let dist_sym = match decode_symbol(bits, dist) {
            Some(s) => s,
            None => {
                return if out.is_empty() {
                    Err(Failure::invalid("truncated distance"))
                } else {
                    Ok(false)
                };
            }
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
            0 => 0usize,
            n => bits
                .take_bits(n)
                .ok_or_else(|| Failure::invalid("truncated distance extra"))?
                as usize,
        };
        let distance = dist_base.saturating_add(dist_bits);
        copy_match(out, distance, length, max)?;
    }
}

fn read_dynamic_trees(bits: &mut BitReader<'_>) -> Outcome<(Huffman, Huffman)> {
    let hlit = bits
        .take_bits(5)
        .ok_or_else(|| Failure::invalid("truncated hlit"))?
        .saturating_add(257) as usize;
    let hdist = bits
        .take_bits(5)
        .ok_or_else(|| Failure::invalid("truncated hdist"))?
        .saturating_add(1) as usize;
    let hclen = bits
        .take_bits(4)
        .ok_or_else(|| Failure::invalid("truncated hclen"))?
        .saturating_add(4) as usize;

    let mut clens = [0u8; 19];
    for i in 0..hclen {
        let ord = CODE_LENGTH_ORDER
            .get(i)
            .copied()
            .ok_or_else(|| Failure::invalid("code length order"))?;
        let len = bits
            .take_bits(3)
            .ok_or_else(|| Failure::invalid("truncated code length"))?;
        if let Some(slot) = clens.get_mut(usize::from(ord)) {
            *slot = len as u8;
        }
    }
    let cl_tree = build_huffman(&clens)?;

    let mut lengths = Vec::new();
    while lengths.len() < hlit.saturating_add(hdist) {
        let sym = match decode_symbol(bits, &cl_tree) {
            Some(s) => s,
            None => return Err(Failure::invalid("truncated code lengths")),
        };
        if sym < 16 {
            lengths.push(sym as u8);
        } else if sym == 16 {
            let rep = bits
                .take_bits(2)
                .ok_or_else(|| Failure::invalid("truncated repeat"))?
                .saturating_add(3) as usize;
            let prev = *lengths
                .last()
                .ok_or_else(|| Failure::invalid("repeat without prev"))?;
            for _ in 0..rep {
                lengths.push(prev);
            }
        } else if sym == 17 {
            let rep = bits
                .take_bits(3)
                .ok_or_else(|| Failure::invalid("truncated repeat17"))?
                .saturating_add(3) as usize;
            lengths.extend(std::iter::repeat_n(0u8, rep));
        } else if sym == 18 {
            let rep = bits
                .take_bits(7)
                .ok_or_else(|| Failure::invalid("truncated repeat18"))?
                .saturating_add(11) as usize;
            lengths.extend(std::iter::repeat_n(0u8, rep));
        } else {
            return Err(Failure::invalid("bad code length symbol"));
        }
    }

    let lit_lens = lengths
        .get(..hlit)
        .ok_or_else(|| Failure::invalid("lit lengths"))?
        .to_vec();
    let dist_lens = lengths
        .get(hlit..hlit.saturating_add(hdist))
        .ok_or_else(|| Failure::invalid("dist lengths"))?
        .to_vec();

    Ok((build_huffman(&lit_lens)?, build_huffman(&dist_lens)?))
}

fn skip_zlib_header(data: &[u8]) -> usize {
    if data.len() < 2 {
        return 0;
    }
    let cmf = data.first().copied().unwrap_or(0);
    let flg = data.get(1).copied().unwrap_or(0);
    if cmf & 0x0f == 8 && (u16::from(cmf) << 8 | u16::from(flg)) % 31 == 0 {
        2
    } else {
        0
    }
}

pub fn inflate(data: &[u8], max_output: usize) -> Outcome<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len().saturating_mul(4).min(max_output));
    let skip = skip_zlib_header(data);
    let payload = match data.get(skip..) {
        Some(slice) => slice,
        None => data,
    };
    if payload.is_empty() && !data.is_empty() {
        return Ok(out);
    }
    let mut bits = BitReader::new(payload);
    let mut final_block = false;

    while !final_block {
        let hdr = match bits.take_bits(3) {
            Some(v) => v,
            None => break,
        };
        final_block = (hdr & 1) != 0;
        let btype = (hdr >> 1) & 3;
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
                    return partial_or_err(Failure::invalid("stored block len mismatch"), &out);
                }
                let len = len_bits as usize;
                if let Err(err) = bits.copy_stored_bytes(&mut out, len, max_output) {
                    return partial_or_err(err, &out);
                }
            }
            1 => {
                let lit = build_huffman(&fixed_lit_lens())?;
                let dist = build_huffman(&FIXED_DIST_LENS)?;
                match inflate_block(&mut bits, &mut out, max_output, &lit, &dist) {
                    Ok(true) => {}
                    Ok(false) => return Ok(out),
                    Err(err) => return partial_or_err(err, &out),
                }
            }
            2 => {
                let (lit, dist) = read_dynamic_trees(&mut bits)?;
                match inflate_block(&mut bits, &mut out, max_output, &lit, &dist) {
                    Ok(true) => {}
                    Ok(false) => return Ok(out),
                    Err(err) => return partial_or_err(err, &out),
                }
            }
            _ => {
                return partial_or_err(Failure::invalid("invalid deflate block type"), &out);
            }
        }
    }

    if out.is_empty() && !payload.is_empty() {
        return Err(Failure::invalid("no inflated output"));
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::inflate;
    include!(".scratch_mb_zlib.rs");

    #[test]
    fn fixed_tree_layout() {
        use super::{build_huffman, fixed_lit_lens};
        let lit = build_huffman(&fixed_lit_lens()).expect("lit");
        assert_eq!(lit.counts[8], 152);
        assert_eq!(lit.first_code[8], 48);
        assert_eq!(lit.offset[8], 24);
        assert_eq!(lit.symbols.get(91).copied(), Some(67));
    }

    #[test]
    fn decode_first_fixed_symbol() {
        use super::{BitReader, build_huffman, decode_symbol, fixed_lit_lens};
        let lit = build_huffman(&fixed_lit_lens()).expect("lit");
        let data = [
            0xcbu8, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01, 0x00,
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
            0x78u8, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01,
            0x00, 0x1a, 0x0b, 0x04, 0x5d,
        ];
        let out = inflate(&data, 1024).expect("inflate");
        assert_eq!(out, b"hello world");
    }

    #[test]
    fn raw_deflate_no_header() {
        let data = [
            0xcbu8, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01, 0x00,
        ];
        let out = inflate(&data, 1024).expect("inflate");
        assert_eq!(out, b"hello world");
    }

    #[test]
    fn repetitive_mb_output() {
        let out = inflate(ZLIB_MB, 2 * 1024 * 1024).expect("mb");
        assert_eq!(out.len(), 1_048_576);
        assert_eq!(&out[..4], b"ABCD");
        assert_eq!(&out[out.len().saturating_sub(4)..], b"ABCD");
    }

    #[test]
    fn stored_zlib_block() {
        let data = [
            0x78u8, 0x01, 0x01, 0x0b, 0x00, 0xf4, 0xff, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77,
            0x6f, 0x72, 0x6c, 0x64, 0x1a, 0x0b, 0x04, 0x5d,
        ];
        let out = inflate(&data, 1024).expect("inflate");
        assert_eq!(out, b"hello world");
    }
}
