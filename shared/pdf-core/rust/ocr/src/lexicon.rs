extern crate alloc;

use alloc::collections::{BTreeMap, BTreeSet};
use core::str;
use std::sync::OnceLock;

const BIGRAM_SHIFT: u32 = 16;
const DIACRITIC_UNIT: u16 = 16;
const LEXICON_BYTES: &[u8] = include_bytes!("../data/lexicon.bin");
const MAGIC: &[u8; 4] = b"LXC1";
const VERSION: u16 = 1;

#[derive(Debug)]
pub(crate) struct Lexicon {
    bigrams: BTreeSet<u32>,
    buckets: Vec<u8>,
    exact: BTreeMap<String, u32>,
    stripped: BTreeMap<String, Vec<u32>>,
    words: Vec<String>,
}

impl Lexicon {
    #[inline]
    pub(crate) fn bigram(&self, left: Option<u32>, right: u32) -> bool {
        let Some(left_id) = left else {
            return false;
        };
        let Some(packed) = pack_bigram(left_id, right) else {
            return false;
        };
        self.bigrams.contains(&packed)
    }

    #[inline]
    pub(crate) fn bucket(&self, word_id: u32) -> u8 {
        usize::try_from(word_id)
            .ok()
            .and_then(|index| self.buckets.get(index).copied())
            .unwrap_or(0)
    }

    #[inline]
    pub(crate) fn diacritic_cost(&self, folded: &str, word_id: u32) -> Option<u16> {
        let surface = self.word(word_id)?;
        diacritic_cost(folded, surface)
    }

    #[inline]
    pub(crate) fn exact_id(&self, folded: &str) -> Option<u32> {
        self.exact.get(folded).copied()
    }

    #[inline]
    pub(crate) fn get() -> &'static Self {
        static LEXICON: OnceLock<Lexicon> = OnceLock::new();
        LEXICON.get_or_init(|| parse(LEXICON_BYTES).unwrap_or_default())
    }

    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "entry count is read by the lexicon tests and the size report"
        )
    )]
    #[inline]
    #[must_use]
    pub(crate) const fn len(&self) -> usize {
        self.words.len()
    }

    #[inline]
    pub(crate) fn stripped_ids(&self, stripped: &str) -> &[u32] {
        self.stripped.get(stripped).map_or(&[], Vec::as_slice)
    }

    #[inline]
    pub(crate) fn word(&self, word_id: u32) -> Option<&str> {
        usize::try_from(word_id)
            .ok()
            .and_then(|index| self.words.get(index))
            .map(String::as_str)
    }
}

impl Default for Lexicon {
    #[inline]
    fn default() -> Self {
        Self {
            bigrams: BTreeSet::new(),
            buckets: Vec::new(),
            exact: BTreeMap::new(),
            stripped: BTreeMap::new(),
            words: Vec::new(),
        }
    }
}

#[inline]
pub(crate) fn fold_into(text: &str, out: &mut String) {
    out.clear();
    for ch in text.chars() {
        out.push(fold_char(ch));
    }
}

#[inline]
pub(crate) fn strip_into(folded: &str, out: &mut String) {
    out.clear();
    for ch in folded.chars() {
        out.push(strip_char(ch));
    }
}

#[inline]
fn fold_char(ch: char) -> char {
    if ch.is_ascii() {
        return ch.to_ascii_lowercase();
    }
    let code = u32::from(ch);
    if matches!(code, 0x00C0..=0x00D6 | 0x00D8..=0x00DE)
        && let Some(lower) = char::from_u32(code.saturating_add(0x0020))
    {
        return lower;
    }
    ch
}

#[inline]
fn strip_char(ch: char) -> char {
    match u32::from(ch) {
        0x00E0..=0x00E5 => 'a',
        0x00E7 => 'c',
        0x00E8..=0x00EB => 'e',
        0x00EC..=0x00EF => 'i',
        0x00F1 => 'n',
        0x00F2..=0x00F6 => 'o',
        0x00F9..=0x00FC => 'u',
        0x00FD | 0x00FF => 'y',
        _ => ch,
    }
}

fn diacritic_cost(folded: &str, surface: &str) -> Option<u16> {
    let mut left = folded.chars();
    let mut right = surface.chars();
    let mut diffs: u16 = 0;
    loop {
        match (left.next(), right.next()) {
            (None, None) => break,
            (Some(found), Some(expected)) => {
                if found == expected {
                    continue;
                }
                if strip_char(found) != strip_char(expected) {
                    return None;
                }
                diffs = diffs.saturating_add(1);
            }
            _ => return None,
        }
    }
    if diffs == 0 {
        return None;
    }
    Some(diffs.saturating_mul(DIACRITIC_UNIT))
}

fn pack_bigram(left: u32, right: u32) -> Option<u32> {
    let left_id = u16::try_from(left).ok()?;
    let right_id = u16::try_from(right).ok()?;
    u32::from(left_id)
        .checked_shl(BIGRAM_SHIFT)
        .map(|shifted| shifted | u32::from(right_id))
}

fn parse(bytes: &[u8]) -> Option<Lexicon> {
    let mut offset = 0_usize;
    let (word_count, bigram_count, stripped_count) = parse_header(bytes, &mut offset)?;
    let (words, buckets) = parse_words(bytes, &mut offset, word_count)?;
    let stripped = parse_stripped(bytes, &mut offset, stripped_count)?;
    let bigrams = parse_bigrams(bytes, &mut offset, bigram_count)?;
    if offset != bytes.len() {
        return None;
    }
    let mut exact = BTreeMap::new();
    for (index, word) in words.iter().enumerate() {
        let word_id = u32::try_from(index).ok()?;
        let _: Option<u32> = exact.insert(word.clone(), word_id);
    }
    Some(Lexicon {
        bigrams,
        buckets,
        exact,
        stripped,
        words,
    })
}

fn parse_bigrams(bytes: &[u8], offset: &mut usize, count: u32) -> Option<BTreeSet<u32>> {
    let mut bigrams = BTreeSet::new();
    let mut remaining = count;
    while remaining > 0 {
        let left = read_u16(bytes, offset)?;
        let right = read_u16(bytes, offset)?;
        let _: bool = bigrams.insert(pack_bigram(u32::from(left), u32::from(right))?);
        remaining = remaining.saturating_sub(1);
    }
    Some(bigrams)
}

fn parse_header(bytes: &[u8], offset: &mut usize) -> Option<(u16, u32, u32)> {
    let magic = take(bytes, offset, MAGIC.len())?;
    if magic != MAGIC {
        return None;
    }
    let version = read_u16(bytes, offset)?;
    if version != VERSION {
        return None;
    }
    let word_count = read_u16(bytes, offset)?;
    let bigram_count = read_u32(bytes, offset)?;
    let stripped_count = read_u32(bytes, offset)?;
    Some((word_count, bigram_count, stripped_count))
}

fn parse_stripped(
    bytes: &[u8],
    offset: &mut usize,
    count: u32,
) -> Option<BTreeMap<String, Vec<u32>>> {
    let mut stripped = BTreeMap::new();
    let mut previous: Vec<u8> = Vec::new();
    let mut remaining = count;
    while remaining > 0 {
        let key = read_front(bytes, offset, &mut previous)?;
        let id_count = usize::from(read_u8(bytes, offset)?);
        let mut ids = Vec::with_capacity(id_count);
        let mut left = id_count;
        while left > 0 {
            ids.push(u32::from(read_u16(bytes, offset)?));
            left = left.saturating_sub(1);
        }
        drop(stripped.insert(key, ids));
        remaining = remaining.saturating_sub(1);
    }
    Some(stripped)
}

fn parse_words(bytes: &[u8], offset: &mut usize, count: u16) -> Option<(Vec<String>, Vec<u8>)> {
    let mut words = Vec::new();
    let mut buckets = Vec::new();
    let mut previous: Vec<u8> = Vec::new();
    let mut remaining = u32::from(count);
    while remaining > 0 {
        let word = read_front(bytes, offset, &mut previous)?;
        let bucket = read_u8(bytes, offset)?;
        words.push(word);
        buckets.push(bucket);
        remaining = remaining.saturating_sub(1);
    }
    Some((words, buckets))
}

fn read_front(bytes: &[u8], offset: &mut usize, previous: &mut Vec<u8>) -> Option<String> {
    let prefix = usize::from(read_u8(bytes, offset)?);
    let suffix_len = usize::from(read_u8(bytes, offset)?);
    let suffix = take(bytes, offset, suffix_len)?;
    if prefix > previous.len() {
        return None;
    }
    previous.truncate(prefix);
    previous.extend_from_slice(suffix);
    str::from_utf8(previous).ok().map(ToOwned::to_owned)
}

fn read_u8(bytes: &[u8], offset: &mut usize) -> Option<u8> {
    take(bytes, offset, 1)?.first().copied()
}

fn read_u16(bytes: &[u8], offset: &mut usize) -> Option<u16> {
    let chunk = take(bytes, offset, 2)?;
    Some(u16::from_le_bytes([
        chunk.first().copied()?,
        chunk.get(1).copied()?,
    ]))
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> Option<u32> {
    let chunk = take(bytes, offset, 4)?;
    Some(u32::from_le_bytes([
        chunk.first().copied()?,
        chunk.get(1).copied()?,
        chunk.get(2).copied()?,
        chunk.get(3).copied()?,
    ]))
}

fn take<'data>(bytes: &'data [u8], offset: &mut usize, count: usize) -> Option<&'data [u8]> {
    let start = *offset;
    let end = start.checked_add(count)?;
    let chunk = bytes.get(start..end)?;
    *offset = end;
    Some(chunk)
}
