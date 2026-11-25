use crate::num::widen;

const WINDOW: usize = 1 << 15;
const WINDOW_MASK: usize = WINDOW - 1;
const HASH_SIZE: usize = 1 << 15;
const HASH_MASK: u32 = (1 << 15) - 1;
const MIN_MATCH: usize = 3;
const MAX_MATCH: usize = 258;
const MAX_CHAIN: usize = 48;
const NICE_MATCH: usize = 128;
const BLOCK_TOKENS: usize = 1 << 15;
const MAX_STORED: usize = 0xffff;
const NO_POSITION: u32 = u32::MAX;
const MATCH_FLAG: u32 = 1 << 31;
const LITERAL_CODES: usize = 286;
const DISTANCE_CODES: usize = 30;
const CODE_LENGTH_CODES: usize = 19;
const END_OF_BLOCK: usize = 256;
const MAX_CODE_BITS: u8 = 15;
const MAX_LENGTH_CODE_BITS: u8 = 7;
const ADLER_BASE: u32 = 0xFFF1;
const ADLER_CHUNK: usize = 5_552;

const LENGTH_BASE: [u16; 29] = [
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
const DISTANCE_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];

const DISTANCE_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

const CODE_LENGTH_ORDER: [u8; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

struct BitWriter {
    buffer: u64,
    count: u32,
    out: Vec<u8>,
}

impl BitWriter {
    fn align(&mut self) {
        if self.count & 7 != 0 {
            self.put(0, 8_u32.saturating_sub(self.count & 7));
        }
        self.flush();
    }

    fn flush(&mut self) {
        while self.count >= 8 {
            self.out.push(u8::try_from(self.buffer & 0xff).unwrap_or(0));
            self.buffer >>= 8_i32;
            self.count = self.count.saturating_sub(8);
        }
    }

    fn put(&mut self, value: u32, bits: u32) {
        if bits == 0 {
            return;
        }
        let mask = (1_u64 << bits).wrapping_sub(1);
        self.buffer |= (u64::from(value) & mask) << self.count;
        self.count = self.count.saturating_add(bits);
        if self.count >= 32 {
            self.flush();
        }
    }
}

struct Code {
    bits: Vec<u16>,
    lengths: Vec<u8>,
}

impl Code {
    fn from_lengths(lengths: Vec<u8>) -> Self {
        let mut counts = [0_u16; 16];
        for &length in &lengths {
            if let Some(slot) = counts.get_mut(usize::from(length)) {
                *slot = slot.saturating_add(1);
            }
        }
        if let Some(zero) = counts.first_mut() {
            *zero = 0;
        }
        let mut next = [0_u16; 16];
        let mut code = 0_u16;
        for bits in 1..16_usize {
            let previous = counts.get(bits.saturating_sub(1)).copied().unwrap_or(0);
            code = code.wrapping_add(previous) << 1_i32;
            if let Some(slot) = next.get_mut(bits) {
                *slot = code;
            }
        }
        let bits = lengths
            .iter()
            .map(|&length| {
                if length == 0 {
                    return 0;
                }
                let Some(slot) = next.get_mut(usize::from(length)) else {
                    return 0;
                };
                let assigned = *slot;
                *slot = slot.wrapping_add(1);
                assigned.reverse_bits() >> 16_u32.saturating_sub(u32::from(length))
            })
            .collect();
        Self { bits, lengths }
    }

    fn put(&self, writer: &mut BitWriter, symbol: usize) {
        let bits = self.bits.get(symbol).copied().unwrap_or(0);
        let length = self.lengths.get(symbol).copied().unwrap_or(0);
        writer.put(u32::from(bits), u32::from(length));
    }
}

struct Block<'data> {
    distance_freq: [u32; DISTANCE_CODES],
    literal_freq: [u32; LITERAL_CODES],
    raw: &'data [u8],
    tokens: &'data [u32],
}

struct Header {
    code_lengths: Code,
    distance_count: usize,
    literal_count: usize,
    runs: Vec<(u8, u8)>,
}

struct Matcher {
    head: Vec<u32>,
    previous: Vec<u32>,
}

impl Matcher {
    fn chain_hash(data: &[u8], position: usize) -> Option<usize> {
        let window = data.get(position..position.saturating_add(MIN_MATCH))?;
        let [a, b, c] = *window else { return None };
        let mixed = (u32::from(a) << 16_i32) | (u32::from(b) << 8_i32) | u32::from(c);
        Some(widen(
            (mixed.wrapping_mul(0x9E37_79B1) >> 17_i32) & HASH_MASK,
        ))
    }

    fn insert(&mut self, data: &[u8], position: usize) {
        let Some(hash) = Self::chain_hash(data, position) else {
            return;
        };
        let Ok(current) = u32::try_from(position) else {
            return;
        };
        let Some(head) = self.head.get_mut(hash) else {
            return;
        };
        let previous = *head;
        *head = current;
        if let Some(slot) = self.previous.get_mut(position & WINDOW_MASK) {
            *slot = previous;
        }
    }

    fn insert_run(&mut self, data: &[u8], position: usize, length: usize) {
        for offset in 0..length {
            self.insert(data, position.saturating_add(offset));
        }
    }

    fn longest(&self, data: &[u8], position: usize) -> (usize, usize) {
        let Some(hash) = Self::chain_hash(data, position) else {
            return (0, 0);
        };
        let limit = MAX_MATCH.min(data.len().saturating_sub(position));
        let Some(target) = data.get(position..position.saturating_add(limit)) else {
            return (0, 0);
        };
        let mut candidate = self.head.get(hash).copied().unwrap_or(NO_POSITION);
        let mut best_length = 0_usize;
        let mut best_distance = 0_usize;
        for _ in 0..MAX_CHAIN {
            if candidate == NO_POSITION {
                break;
            }
            let start = widen(candidate);
            if start >= position {
                break;
            }
            let distance = position.saturating_sub(start);
            if distance > WINDOW {
                break;
            }
            let length = data
                .get(start..)
                .map_or(0, |earlier| common_prefix(earlier, target));
            if length > best_length {
                best_length = length;
                best_distance = distance;
                if length >= NICE_MATCH || length == limit {
                    break;
                }
            }
            let next = self
                .previous
                .get(start & WINDOW_MASK)
                .copied()
                .unwrap_or(NO_POSITION);
            if next == NO_POSITION || widen(next) >= start {
                break;
            }
            candidate = next;
        }
        (best_length, best_distance)
    }

    fn new() -> Self {
        Self {
            head: vec![NO_POSITION; HASH_SIZE],
            previous: vec![NO_POSITION; WINDOW],
        }
    }
}

impl<'data> Block<'data> {
    fn new(raw: &'data [u8], tokens: &'data [u32]) -> Self {
        let mut literal_freq = [0_u32; LITERAL_CODES];
        let mut distance_freq = [0_u32; DISTANCE_CODES];
        for &token in tokens {
            if token & MATCH_FLAG == 0 {
                bump(&mut literal_freq, widen(token));
            } else {
                let (length, distance) = unpack(token);
                bump(
                    &mut literal_freq,
                    257_usize.saturating_add(length_code(length)),
                );
                bump(&mut distance_freq, distance_code(distance));
            }
        }
        bump(&mut literal_freq, END_OF_BLOCK);
        Self {
            distance_freq,
            literal_freq,
            raw,
            tokens,
        }
    }

    fn payload_bits(&self, literal: &[u8], distance: &[u8]) -> u64 {
        let mut total = 0_u64;
        for (symbol, &freq) in self.literal_freq.iter().enumerate() {
            let length = u64::from(literal.get(symbol).copied().unwrap_or(0));
            let extra = symbol
                .checked_sub(257)
                .and_then(|code| LENGTH_EXTRA.get(code))
                .map_or(0, |bits| u64::from(*bits));
            total =
                total.saturating_add(u64::from(freq).saturating_mul(length.saturating_add(extra)));
        }
        for (symbol, &freq) in self.distance_freq.iter().enumerate() {
            let length = u64::from(distance.get(symbol).copied().unwrap_or(0));
            let extra = u64::from(DISTANCE_EXTRA.get(symbol).copied().unwrap_or(0));
            total =
                total.saturating_add(u64::from(freq).saturating_mul(length.saturating_add(extra)));
        }
        total
    }

    fn write(&self, writer: &mut BitWriter, last: bool, fixed: &(Code, Code)) {
        let final_bit = u32::from(last);
        let literal = Code::from_lengths(huffman_lengths(&self.literal_freq, MAX_CODE_BITS));
        let mut distance_lengths = huffman_lengths(&self.distance_freq, MAX_CODE_BITS);
        if distance_lengths.iter().all(|&length| length == 0)
            && let Some(first) = distance_lengths.first_mut()
        {
            *first = 1;
        }
        let distance = Code::from_lengths(distance_lengths);
        let header = Header::new(&literal, &distance);
        let dynamic_bits = header
            .bits()
            .saturating_add(self.payload_bits(&literal.lengths, &distance.lengths));
        let fixed_bits = self.payload_bits(&fixed.0.lengths, &fixed.1.lengths);
        let stored_bits = u64::try_from(self.raw.len())
            .unwrap_or(u64::MAX)
            .saturating_add(5)
            .saturating_mul(8)
            .saturating_add(
                u64::try_from(self.raw.len().saturating_div(MAX_STORED))
                    .unwrap_or(0)
                    .saturating_mul(40),
            );
        if stored_bits <= dynamic_bits.min(fixed_bits) {
            write_stored(writer, self.raw, last);
        } else if fixed_bits <= dynamic_bits {
            writer.put(final_bit | 2, 3);
            self.write_tokens(writer, &fixed.0, &fixed.1);
        } else {
            writer.put(final_bit | 4, 3);
            header.write(writer);
            self.write_tokens(writer, &literal, &distance);
        }
    }

    fn write_tokens(&self, writer: &mut BitWriter, literal: &Code, distance: &Code) {
        for &token in self.tokens {
            if token & MATCH_FLAG == 0 {
                literal.put(writer, widen(token));
                continue;
            }
            let (length, offset) = unpack(token);
            let length_index = length_code(length);
            literal.put(writer, 257_usize.saturating_add(length_index));
            let base = usize::from(LENGTH_BASE.get(length_index).copied().unwrap_or(3));
            let extra = u32::from(LENGTH_EXTRA.get(length_index).copied().unwrap_or(0));
            writer.put(
                u32::try_from(length.saturating_sub(base)).unwrap_or(0),
                extra,
            );
            let distance_index = distance_code(offset);
            distance.put(writer, distance_index);
            let distance_base =
                usize::from(DISTANCE_BASE.get(distance_index).copied().unwrap_or(1));
            let distance_extra =
                u32::from(DISTANCE_EXTRA.get(distance_index).copied().unwrap_or(0));
            writer.put(
                u32::try_from(offset.saturating_sub(distance_base)).unwrap_or(0),
                distance_extra,
            );
        }
        literal.put(writer, END_OF_BLOCK);
    }
}

impl Header {
    fn bits(&self) -> u64 {
        let mut total = 14_u64
            .saturating_add(3_u64.saturating_mul(u64::try_from(self.order_count()).unwrap_or(19)));
        for &(symbol, _) in &self.runs {
            let length = u64::from(
                self.code_lengths
                    .lengths
                    .get(usize::from(symbol))
                    .copied()
                    .unwrap_or(0),
            );
            let extra = match symbol {
                16 => 2,
                17 => 3,
                18 => 7,
                _ => 0,
            };
            total = total.saturating_add(length.saturating_add(extra));
        }
        total
    }

    fn new(literal: &Code, distance: &Code) -> Self {
        let literal_count = used_prefix(&literal.lengths, 257);
        let distance_count = used_prefix(&distance.lengths, 1);
        let mut joined: Vec<u8> = Vec::with_capacity(literal_count.saturating_add(distance_count));
        joined.extend_from_slice(literal.lengths.get(..literal_count).unwrap_or_default());
        joined.extend_from_slice(distance.lengths.get(..distance_count).unwrap_or_default());
        let runs = run_length_encode(&joined);
        let mut freq = [0_u32; CODE_LENGTH_CODES];
        for &(symbol, _) in &runs {
            if let Some(slot) = freq.get_mut(usize::from(symbol)) {
                *slot = slot.saturating_add(1);
            }
        }
        let code_lengths = Code::from_lengths(huffman_lengths(&freq, MAX_LENGTH_CODE_BITS));
        Self {
            code_lengths,
            distance_count,
            literal_count,
            runs,
        }
    }

    fn order_count(&self) -> usize {
        let mut count = CODE_LENGTH_CODES;
        while count > 4 {
            let symbol = CODE_LENGTH_ORDER
                .get(count.saturating_sub(1))
                .copied()
                .unwrap_or(0);
            if self
                .code_lengths
                .lengths
                .get(usize::from(symbol))
                .copied()
                .unwrap_or(0)
                != 0
            {
                break;
            }
            count = count.saturating_sub(1);
        }
        count
    }

    fn write(&self, writer: &mut BitWriter) {
        let order_count = self.order_count();
        writer.put(
            u32::try_from(self.literal_count.saturating_sub(257)).unwrap_or(0),
            5,
        );
        writer.put(
            u32::try_from(self.distance_count.saturating_sub(1)).unwrap_or(0),
            5,
        );
        writer.put(u32::try_from(order_count.saturating_sub(4)).unwrap_or(0), 4);
        for &symbol in CODE_LENGTH_ORDER.get(..order_count).unwrap_or_default() {
            let length = self
                .code_lengths
                .lengths
                .get(usize::from(symbol))
                .copied()
                .unwrap_or(0);
            writer.put(u32::from(length), 3);
        }
        for &(symbol, extra) in &self.runs {
            self.code_lengths.put(writer, usize::from(symbol));
            match symbol {
                16 => writer.put(u32::from(extra), 2),
                17 => writer.put(u32::from(extra), 3),
                18 => writer.put(u32::from(extra), 7),
                _ => {}
            }
        }
    }
}

pub(crate) fn adler32(data: &[u8]) -> u32 {
    let mut a = 1_u32;
    let mut b = 0_u32;
    for chunk in data.chunks(ADLER_CHUNK) {
        for &byte in chunk {
            a = a.wrapping_add(u32::from(byte));
            b = b.wrapping_add(a);
        }
        a = a.rem_euclid(ADLER_BASE);
        b = b.rem_euclid(ADLER_BASE);
    }
    (b << 16_i32) | a
}

fn bump(freq: &mut [u32], symbol: usize) {
    if let Some(slot) = freq.get_mut(symbol) {
        *slot = slot.saturating_add(1);
    }
}

fn common_prefix(earlier: &[u8], target: &[u8]) -> usize {
    let mut length = 0_usize;
    let (left, _) = earlier.as_chunks::<8>();
    let (right, _) = target.as_chunks::<8>();
    for (a, b) in left.iter().zip(right) {
        let difference = u64::from_le_bytes(*a) ^ u64::from_le_bytes(*b);
        if difference != 0 {
            return length.saturating_add(widen(difference.trailing_zeros() >> 3_i32));
        }
        length = length.saturating_add(8);
    }
    let tail_left = earlier.get(length..).unwrap_or_default();
    let tail_right = target.get(length..).unwrap_or_default();
    length.saturating_add(
        tail_left
            .iter()
            .zip(tail_right)
            .take_while(|(a, b)| a == b)
            .count(),
    )
}

fn distance_code(distance: usize) -> usize {
    let value = u16::try_from(distance).unwrap_or(u16::MAX);
    DISTANCE_BASE
        .partition_point(|&base| base <= value)
        .saturating_sub(1)
}

fn fixed_literal_lengths() -> [u8; 288] {
    let mut lengths = [8_u8; 288];
    for (symbol, slot) in lengths.iter_mut().enumerate() {
        *slot = match symbol {
            0..=143 | 280.. => 8,
            144..=255 => 9,
            _ => 7,
        };
    }
    lengths
}

fn huffman_lengths(freq: &[u32], max_bits: u8) -> Vec<u8> {
    let mut lengths = vec![0_u8; freq.len()];
    let mut leaves: Vec<(u32, usize)> = freq
        .iter()
        .enumerate()
        .filter(|(_, weight)| **weight > 0)
        .map(|(symbol, weight)| (*weight, symbol))
        .collect();
    if let [(_, only)] = leaves.as_slice() {
        if let Some(slot) = lengths.get_mut(*only) {
            *slot = 1;
        }
        return lengths;
    }
    if leaves.is_empty() {
        return lengths;
    }
    insertion_sort(&mut leaves);
    let leaf_count = leaves.len();
    let node_count = leaf_count.saturating_mul(2).saturating_sub(1);
    let mut weights: Vec<u64> = leaves
        .iter()
        .map(|(weight, _)| u64::from(*weight))
        .collect();
    weights.resize(node_count, 0);
    let mut parent: Vec<usize> = vec![0; node_count];
    let mut next_leaf = 0_usize;
    let mut next_internal = leaf_count;
    for created in leaf_count..node_count {
        let mut pick = || {
            let leaf_weight = weights
                .get(next_leaf)
                .copied()
                .filter(|_| next_leaf < leaf_count);
            let internal_weight = weights
                .get(next_internal)
                .copied()
                .filter(|_| next_internal < created);
            let take_leaf = match (leaf_weight, internal_weight) {
                (Some(leaf), Some(internal)) => leaf <= internal,
                (Some(_), None) => true,
                (None, Some(_) | None) => false,
            };
            if take_leaf {
                next_leaf = next_leaf.saturating_add(1);
                next_leaf.saturating_sub(1)
            } else {
                next_internal = next_internal.saturating_add(1);
                next_internal.saturating_sub(1)
            }
        };
        let left = pick();
        let right = pick();
        let total = weights
            .get(left)
            .copied()
            .unwrap_or(0)
            .saturating_add(weights.get(right).copied().unwrap_or(0));
        if let Some(slot) = weights.get_mut(created) {
            *slot = total;
        }
        for child in [left, right] {
            if let Some(slot) = parent.get_mut(child) {
                *slot = created;
            }
        }
    }
    let mut depth: Vec<u32> = vec![0; node_count];
    for node in (0..node_count.saturating_sub(1)).rev() {
        let above = parent
            .get(node)
            .and_then(|up| depth.get(*up))
            .copied()
            .unwrap_or(0);
        if let Some(slot) = depth.get_mut(node) {
            *slot = above.saturating_add(1);
        }
    }
    let mut counts = [0_u32; 64];
    for bits in depth.iter().take(leaf_count) {
        if let Some(slot) = counts.get_mut(widen((*bits).min(63))) {
            *slot = slot.saturating_add(1);
        }
    }
    limit_lengths(&mut counts, usize::from(max_bits));
    let mut ranked = leaves.iter().rev();
    for bits in 1..=max_bits {
        for _ in 0..counts.get(usize::from(bits)).copied().unwrap_or(0) {
            if let Some(slot) = ranked
                .next()
                .and_then(|(_, symbol)| lengths.get_mut(*symbol))
            {
                *slot = bits;
            }
        }
    }
    lengths
}

fn insertion_sort(items: &mut [(u32, usize)]) {
    for index in 1..items.len() {
        let mut position = index;
        while position > 0 && items.get(position.saturating_sub(1)) > items.get(position) {
            items.swap(position.saturating_sub(1), position);
            position = position.saturating_sub(1);
        }
    }
}

fn length_code(length: usize) -> usize {
    let value = u16::try_from(length).unwrap_or(u16::MAX);
    LENGTH_BASE
        .partition_point(|&base| base <= value)
        .saturating_sub(1)
}

fn limit_lengths(counts: &mut [u32; 64], max_bits: usize) {
    let overflow: u32 = counts
        .get(max_bits.saturating_add(1)..)
        .map_or(0, |rest| rest.iter().sum());
    for slot in counts.iter_mut().skip(max_bits.saturating_add(1)) {
        *slot = 0;
    }
    if let Some(slot) = counts.get_mut(max_bits) {
        *slot = slot.saturating_add(overflow);
    }
    let capacity = 1_u64 << max_bits;
    let mut total: u64 = (1..=max_bits)
        .map(|bits| {
            u64::from(counts.get(bits).copied().unwrap_or(0)) << max_bits.saturating_sub(bits)
        })
        .sum();
    while total > capacity {
        if let Some(slot) = counts.get_mut(max_bits) {
            *slot = slot.saturating_sub(1);
        }
        for bits in (1..max_bits).rev() {
            if counts.get(bits).copied().unwrap_or(0) != 0 {
                if let Some(slot) = counts.get_mut(bits) {
                    *slot = slot.saturating_sub(1);
                }
                if let Some(slot) = counts.get_mut(bits.saturating_add(1)) {
                    *slot = slot.saturating_add(2);
                }
                break;
            }
        }
        total = total.saturating_sub(1);
    }
}

fn match_token(length: usize, distance: usize) -> u32 {
    let length_bits = u32::try_from(length.saturating_sub(MIN_MATCH)).unwrap_or(0);
    let distance_bits = u32::try_from(distance).unwrap_or(0);
    MATCH_FLAG | (length_bits << 16_i32) | distance_bits
}

fn run_length_encode(lengths: &[u8]) -> Vec<(u8, u8)> {
    let mut runs: Vec<(u8, u8)> = Vec::new();
    let mut index = 0_usize;
    while let Some(&value) = lengths.get(index) {
        let run = lengths
            .get(index..)
            .unwrap_or_default()
            .iter()
            .take_while(|&&next| next == value)
            .count();
        let mut remaining = run;
        if value == 0 {
            while remaining >= 11 {
                let take = remaining.min(138);
                runs.push((18, u8::try_from(take.saturating_sub(11)).unwrap_or(0)));
                remaining = remaining.saturating_sub(take);
            }
            if remaining >= 3 {
                runs.push((17, u8::try_from(remaining.saturating_sub(3)).unwrap_or(0)));
                remaining = 0;
            }
        } else {
            runs.push((value, 0));
            remaining = remaining.saturating_sub(1);
            while remaining >= 3 {
                let take = remaining.min(6);
                runs.push((16, u8::try_from(take.saturating_sub(3)).unwrap_or(0)));
                remaining = remaining.saturating_sub(take);
            }
        }
        for _ in 0..remaining {
            runs.push((value, 0));
        }
        index = index.saturating_add(run);
    }
    runs
}

fn unpack(token: u32) -> (usize, usize) {
    let length = widen((token >> 16_i32) & 0xff).saturating_add(MIN_MATCH);
    (length, widen(token & 0xffff))
}

fn used_prefix(lengths: &[u8], minimum: usize) -> usize {
    let used = lengths
        .iter()
        .rposition(|&length| length != 0)
        .map_or(0, |last| last.saturating_add(1));
    used.max(minimum)
}

fn write_stored(writer: &mut BitWriter, raw: &[u8], last: bool) {
    let mut chunks = raw.chunks(MAX_STORED).peekable();
    if chunks.peek().is_none() {
        writer.put(u32::from(last), 3);
        writer.align();
        writer.out.extend_from_slice(&[0, 0, 0xff, 0xff]);
        return;
    }
    while let Some(chunk) = chunks.next() {
        let final_chunk = last && chunks.peek().is_none();
        writer.put(u32::from(final_chunk), 3);
        writer.align();
        let length = u16::try_from(chunk.len()).unwrap_or(u16::MAX);
        writer.out.extend_from_slice(&length.to_le_bytes());
        writer.out.extend_from_slice(&(!length).to_le_bytes());
        writer.out.extend_from_slice(chunk);
    }
}

#[must_use]
#[expect(
    clippy::missing_inline_in_public_items,
    reason = "release LTO chooses inlining across the internal Rust boundary"
)]
pub fn zlib_compress(data: &[u8]) -> Vec<u8> {
    let mut writer = BitWriter {
        buffer: 0,
        count: 0,
        out: Vec::with_capacity(data.len().saturating_div(2).saturating_add(64)),
    };
    writer.out.extend_from_slice(&[0x78, 0x9c]);
    let mut matcher = Matcher::new();
    let fixed = (
        Code::from_lengths(fixed_literal_lengths().to_vec()),
        Code::from_lengths(vec![5_u8; DISTANCE_CODES]),
    );
    let mut tokens: Vec<u32> = Vec::with_capacity(BLOCK_TOKENS.saturating_add(MAX_MATCH));
    let mut position = 0_usize;
    let mut emitted_final = false;
    while position < data.len() || !emitted_final {
        let block_start = position;
        tokens.clear();
        while position < data.len() && tokens.len() < BLOCK_TOKENS {
            let (length, distance) = matcher.longest(data, position);
            if length >= MIN_MATCH {
                tokens.push(match_token(length, distance));
                matcher.insert_run(data, position, length);
                position = position.saturating_add(length);
            } else {
                tokens.push(u32::from(data.get(position).copied().unwrap_or(0)));
                matcher.insert(data, position);
                position = position.saturating_add(1);
            }
        }
        let last = position >= data.len();
        let block = Block::new(data.get(block_start..position).unwrap_or_default(), &tokens);
        block.write(&mut writer, last, &fixed);
        emitted_final = last;
    }
    writer.align();
    let checksum = adler32(data);
    writer.out.extend_from_slice(&checksum.to_be_bytes());
    writer.out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inflate::inflate;
    use core::iter;

    struct XorShift(u64);

    impl XorShift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13_i32;
            self.0 ^= self.0 >> 7_i32;
            self.0 ^= self.0 << 17_i32;
            self.0
        }
    }

    fn round_trip(data: &[u8]) -> Vec<u8> {
        let compressed = zlib_compress(data);
        let restored = inflate(&compressed, data.len().saturating_add(16)).unwrap();
        assert_eq!(restored, data);
        compressed
    }

    #[test]
    fn empty_input_matches_the_reference_stream() {
        assert_eq!(
            zlib_compress(b""),
            vec![0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]
        );
    }

    #[test]
    fn short_and_repetitive_inputs_round_trip() {
        drop(round_trip(b"a"));
        drop(round_trip(b"abcabcabcabcabcabcabcabcabcabc"));
        let repeated = b"q 1 0 0 1 72 720 cm BT /F1 12 Tf (Hello) Tj ET Q\n".repeat(400);
        let compressed = round_trip(&repeated);
        assert!(
            compressed.len().saturating_mul(20) < repeated.len(),
            "{}",
            compressed.len()
        );
    }

    #[test]
    fn long_runs_use_maximal_matches() {
        let zeros = vec![0_u8; 1_000_000];
        let compressed = round_trip(&zeros);
        assert!(compressed.len() < 2_000, "{}", compressed.len());
    }

    #[test]
    fn random_data_falls_back_to_stored_blocks() {
        let mut rng = XorShift(0x1234_5678_9abc_def0);
        let data: Vec<u8> = iter::repeat_with(|| rng.next().to_le_bytes()[0])
            .take(200_000_usize)
            .collect();
        let compressed = round_trip(&data);
        assert!(
            compressed.len().saturating_mul(100)
                < data.len().saturating_mul(101).saturating_add(6_400)
        );
    }

    #[test]
    fn mixed_text_and_binary_round_trips() {
        let mut rng = XorShift(42);
        let mut data = Vec::new();
        for index in 0..5_000_u32 {
            if index.is_multiple_of(7) {
                let run = usize::try_from(rng.next().rem_euclid(40)).unwrap();
                let noise: Vec<u8> = iter::repeat_with(|| rng.next().to_le_bytes()[1])
                    .take(run)
                    .collect();
                data.extend(noise);
            } else {
                data.extend_from_slice(
                    format!("{index} 0 obj << /Type /Annot >> endobj\n").as_bytes(),
                );
            }
        }
        drop(round_trip(&data));
    }

    #[test]
    fn skewed_frequencies_respect_the_code_length_limit() {
        let mut data = Vec::new();
        let mut weight = 1_usize;
        for symbol in 0..40_u8 {
            data.extend(iter::repeat_n(symbol, weight));
            weight = weight.saturating_mul(2).min(1 << 12_i32);
        }
        let mut rng = XorShift(7);
        for index in (1..data.len()).rev() {
            let bound = u64::try_from(index.saturating_add(1)).unwrap();
            let swap = usize::try_from(rng.next().rem_euclid(bound)).unwrap();
            data.swap(index, swap);
        }
        drop(round_trip(&data));
        let mut freq = [0_u32; LITERAL_CODES];
        for (symbol, slot) in freq.iter_mut().enumerate().take(40) {
            *slot = 1_u32 << symbol.min(30);
        }
        let lengths = huffman_lengths(&freq, MAX_CODE_BITS);
        assert!(lengths.iter().all(|&length| length <= MAX_CODE_BITS));
        let kraft: f64 = lengths
            .iter()
            .filter(|&&length| length > 0)
            .map(|&length| 1.0_f64 / f64::from(1_u32 << length))
            .sum();
        assert!(kraft <= 1.0_f64 + 1e-12_f64, "{kraft}");
    }

    #[test]
    fn adler_matches_reference_values() {
        assert_eq!(adler32(b""), 1);
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
        let long = vec![0xff_u8; 100_000];
        let mut a = 1_u64;
        let mut b = 0_u64;
        for &byte in &long {
            a = a.saturating_add(u64::from(byte)).rem_euclid(0xFFF1);
            b = b.saturating_add(a).rem_euclid(0xFFF1);
        }
        assert_eq!(u64::from(adler32(&long)), (b << 16_i32) | a);
    }
}
