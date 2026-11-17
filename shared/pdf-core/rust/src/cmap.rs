use crate::inspection::Limits;
use crate::syntax::{hex_value, is_regular, is_whitespace};

const MAX_ENTRIES: usize = 262_144;
const MAX_HEX_BYTES: usize = 64;
const MAX_ARRAY_ITEMS: usize = 65_536;
const MAX_PARENT_DEPTH: usize = 4;
const RANGE_SCAN: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Token<'a> {
    Hex(&'a [u8]),
    Int(i64),
    Name(&'a [u8]),
    Keyword(&'a [u8]),
    ArrayOpen,
    ArrayClose,
}

struct Lexer<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Lexer<'a> {
    const fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    const fn advance(&mut self, count: usize) {
        self.position = self.position.saturating_add(count);
    }

    fn take_run<P: Fn(u8) -> bool>(&mut self, accept: P) -> &'a [u8] {
        let start = self.position;
        while let Some(byte) = self.data.get(self.position) {
            if !accept(*byte) {
                break;
            }
            self.advance(1);
        }
        self.data.get(start..self.position).unwrap_or_default()
    }

    fn skip_string(&mut self) {
        let mut depth = 0_usize;
        while let Some(byte) = self.data.get(self.position).copied() {
            self.advance(1);
            match byte {
                b'\\' => self.advance(1),
                b'(' => depth = depth.saturating_add(1),
                b')' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return;
                    }
                }
                _ => {}
            }
        }
    }
}

impl<'a> Iterator for Lexer<'a> {
    type Item = Token<'a>;

    fn next(&mut self) -> Option<Token<'a>> {
        loop {
            let byte = *self.data.get(self.position)?;
            match byte {
                _ if is_whitespace(byte) => self.advance(1),
                b'%' => {
                    self.take_run(|other| !matches!(other, b'\n' | b'\r'));
                }
                b'(' => self.skip_string(),
                b'<' => {
                    self.advance(1);
                    if self.data.get(self.position) == Some(&b'<') {
                        self.advance(1);
                        continue;
                    }
                    let raw = self.take_run(|other| other != b'>');
                    self.advance(1);
                    return Some(Token::Hex(raw));
                }
                b'>' | b')' | b'{' | b'}' => self.advance(1),
                b'[' => {
                    self.advance(1);
                    return Some(Token::ArrayOpen);
                }
                b']' => {
                    self.advance(1);
                    return Some(Token::ArrayClose);
                }
                b'/' => {
                    self.advance(1);
                    return Some(Token::Name(self.take_run(is_regular)));
                }
                _ => {
                    let word = self.take_run(is_regular);
                    if word.is_empty() {
                        self.advance(1);
                        continue;
                    }
                    return Some(parse_int(word).map_or(Token::Keyword(word), Token::Int));
                }
            }
        }
    }
}

fn parse_int(word: &[u8]) -> Option<i64> {
    let digits = match word.first()? {
        b'+' | b'-' => word.get(1..)?,
        _ => word,
    };
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let value = core::str::from_utf8(word).ok()?.parse::<i64>().ok()?;
    Some(value)
}

fn hex_bytes(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len().div_ceil(2));
    let mut high: Option<u8> = None;
    for byte in raw {
        let Some(value) = hex_value(*byte) else {
            continue;
        };
        if out.len() >= MAX_HEX_BYTES {
            break;
        }
        match high.take() {
            Some(first) => out.push((first << 4) | value),
            None => high = Some(value),
        }
    }
    if let Some(first) = high {
        out.push(first << 4);
    }
    out
}

fn hex_code(raw: &[u8]) -> Option<(u32, usize)> {
    let bytes = hex_bytes(raw);
    if bytes.is_empty() || bytes.len() > 4 {
        return None;
    }
    let value = bytes
        .iter()
        .fold(0_u32, |acc, byte| (acc << 8) | u32::from(*byte));
    Some((value, bytes.len()))
}

const fn surrogate_pair(lead: u32, trail: u32) -> u32 {
    0x1_0000_u32
        .saturating_add(lead.saturating_sub(0xD800) << 10)
        .saturating_add(trail.saturating_sub(0xDC00))
}

pub(crate) fn decode_utf16(bytes: &[u8]) -> Vec<u32> {
    if let [single] = bytes {
        return vec![u32::from(*single)];
    }
    let mut out = Vec::with_capacity(bytes.len().div_euclid(2));
    let mut units = bytes.as_chunks::<2>().0.iter().map(|pair| {
        (u32::from(pair.first().copied().unwrap_or(0)) << 8)
            | u32::from(pair.get(1).copied().unwrap_or(0))
    });
    while let Some(unit) = units.next() {
        if (0xD800..0xDC00).contains(&unit) {
            let mut lookahead = units.clone();
            if let Some(trail) = lookahead.next()
                && (0xDC00..0xE000).contains(&trail)
            {
                units = lookahead;
                out.push(surrogate_pair(unit, trail));
                continue;
            }
        }
        out.push(unit);
    }
    out
}

pub(crate) fn text_usable(codepoints: &[u32]) -> bool {
    !codepoints.is_empty()
        && codepoints.iter().all(|cp| {
            char::from_u32(*cp).is_some_and(|ch| {
                *cp != 0xFEFF
                    && *cp != 0xFFFD
                    && (!ch.is_control() || matches!(ch, '\t' | '\n' | '\r'))
            })
        })
}

#[derive(Clone, Debug, PartialEq)]
enum RangeDest {
    Incrementing(Box<[u32]>),
    PerCode(Vec<Box<[u32]>>),
}

#[derive(Clone, Debug, PartialEq)]
struct UnicodeRange {
    start: u32,
    end: u32,
    dest: RangeDest,
}

pub(crate) enum Lookup<'a> {
    Slice(&'a [u32]),
    One(u32),
    Owned(Vec<u32>),
}

impl Lookup<'_> {
    pub(crate) fn as_slice(&self) -> &[u32] {
        match self {
            Lookup::Slice(slice) => slice,
            Lookup::One(value) => core::slice::from_ref(value),
            Lookup::Owned(vec) => vec,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct UnicodeMap {
    chars: Vec<(u32, Box<[u32]>)>,
    ranges: Vec<UnicodeRange>,
    has_unusable: bool,
}

impl UnicodeMap {
    pub(crate) fn parse(data: &[u8], limits: &Limits) -> Self {
        parse_cmap_data(data, limits).unicode
    }

    pub(crate) const fn is_empty(&self) -> bool {
        self.chars.is_empty() && self.ranges.is_empty()
    }

    pub(crate) const fn has_unusable(&self) -> bool {
        self.has_unusable
    }

    pub(crate) fn lookup(&self, code: u32) -> Option<Lookup<'_>> {
        if let Ok(position) = self.chars.binary_search_by_key(&code, |(key, _)| *key)
            && let Some((_, dest)) = self.chars.get(position)
        {
            return Some(Lookup::Slice(dest));
        }
        let upper = self.ranges.partition_point(|range| range.start <= code);
        let candidates = self.ranges.get(..upper)?;
        for range in candidates.iter().rev().take(RANGE_SCAN) {
            if code > range.end {
                continue;
            }
            let offset = code.saturating_sub(range.start);
            return match &range.dest {
                RangeDest::Incrementing(base) => match &**base {
                    [] => None,
                    [single] => Some(Lookup::One(single.saturating_add(offset))),
                    [head @ .., last] => {
                        let mut text = head.to_vec();
                        text.push(last.saturating_add(offset));
                        Some(Lookup::Owned(text))
                    }
                },
                RangeDest::PerCode(items) => items
                    .get(usize::try_from(offset).ok()?)
                    .map(|item| Lookup::Slice(item)),
            };
        }
        None
    }

    pub(crate) fn code_for_char(&self, character: u32) -> Option<u32> {
        let wanted = [character];
        if let Some((code, _)) = self.chars.iter().find(|(_, dest)| **dest == wanted) {
            return Some(*code);
        }
        for range in &self.ranges {
            match &range.dest {
                RangeDest::Incrementing(base) => {
                    if let [single] = &**base
                        && character >= *single
                        && character.saturating_sub(*single)
                            <= range.end.saturating_sub(range.start)
                    {
                        return Some(
                            range
                                .start
                                .saturating_add(character.saturating_sub(*single)),
                        );
                    }
                }
                RangeDest::PerCode(items) => {
                    if let Some(position) = items.iter().position(|item| **item == wanted) {
                        return range.start.checked_add(u32::try_from(position).ok()?);
                    }
                }
            }
        }
        None
    }

    pub(crate) fn usable(&self, code: u32) -> Option<Lookup<'_>> {
        self.lookup(code)
            .filter(|found| text_usable(found.as_slice()))
    }

    fn finish(&mut self) {
        self.chars.sort_by_key(|(key, _)| *key);
        let mut merged: Vec<(u32, Box<[u32]>)> = Vec::with_capacity(self.chars.len());
        for item in self.chars.drain(..) {
            match merged.last_mut() {
                Some(last) if last.0 == item.0 => *last = item,
                _ => merged.push(item),
            }
        }
        self.chars = merged;
        self.ranges.sort_by_key(|range| range.start);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Codespace {
    length: u8,
    low: [u8; 4],
    high: [u8; 4],
}

impl Codespace {
    fn contains(self, bytes: &[u8]) -> bool {
        let length = usize::from(self.length);
        bytes.len() >= length
            && self
                .low
                .iter()
                .zip(self.high.iter())
                .zip(bytes.iter())
                .take(length)
                .all(|((low, high), byte)| byte >= low && byte <= high)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CidRange {
    length: u8,
    low: u32,
    high: u32,
    cid: u32,
}

#[derive(Clone, Debug, Default)]
struct CMapData {
    codespace: Vec<Codespace>,
    cid_ranges: Vec<CidRange>,
    notdef: Vec<CidRange>,
    unicode: UnicodeMap,
    parent: Option<Vec<u8>>,
    vertical: bool,
}

fn array_items<'a>(lexer: &mut Lexer<'a>) -> Vec<&'a [u8]> {
    let mut items = Vec::new();
    for token in lexer {
        match token {
            Token::Hex(raw) if items.len() < MAX_ARRAY_ITEMS => items.push(raw),
            Token::ArrayClose => break,
            Token::Hex(_)
            | Token::Name(_)
            | Token::Int(_)
            | Token::Keyword(_)
            | Token::ArrayOpen => {}
        }
    }
    items
}

struct CMapParser<'a> {
    lexer: Lexer<'a>,
    out: CMapData,
    entries: usize,
    cap: usize,
}

impl<'a> CMapParser<'a> {
    fn new(data: &'a [u8], limits: &Limits) -> Self {
        Self {
            lexer: Lexer::new(data),
            out: CMapData::default(),
            entries: 0,
            cap: limits.max_items.min(MAX_ENTRIES),
        }
    }

    const fn take_slot(&mut self) -> bool {
        if self.entries >= self.cap {
            return false;
        }
        self.entries = self.entries.saturating_add(1);
        true
    }

    fn parse(mut self) -> CMapData {
        let mut last_name: Option<&[u8]> = None;
        while let Some(token) = self.lexer.next() {
            match token {
                Token::Name(name) => last_name = Some(name),
                Token::Keyword(b"usecmap") => {
                    if let Some(name) = last_name {
                        self.out.parent = Some(name.to_vec());
                    }
                }
                Token::Int(value) if last_name == Some(b"WMode".as_slice()) => {
                    self.out.vertical = value == 1;
                    last_name = None;
                }
                Token::Keyword(b"begincodespacerange") => self.codespace_ranges(),
                Token::Keyword(b"beginbfchar") => self.bf_chars(),
                Token::Keyword(b"beginbfrange") => self.bf_ranges(),
                Token::Keyword(b"begincidchar") => self.cid_chars(false),
                Token::Keyword(b"beginnotdefchar") => self.cid_chars(true),
                Token::Keyword(b"begincidrange") => self.cid_ranges(false),
                Token::Keyword(b"beginnotdefrange") => self.cid_ranges(true),
                Token::Hex(_)
                | Token::Int(_)
                | Token::Keyword(_)
                | Token::ArrayOpen
                | Token::ArrayClose => {}
            }
        }
        self.out.unicode.finish();
        self.out
            .cid_ranges
            .sort_by_key(|range| (range.length, range.low));
        self.out
            .notdef
            .sort_by_key(|range| (range.length, range.low));
        self.out
    }

    fn codespace_ranges(&mut self) {
        while let Some(Token::Hex(low)) = self.lexer.next() {
            let Some(Token::Hex(high)) = self.lexer.next() else {
                break;
            };
            let (low, high) = (hex_bytes(low), hex_bytes(high));
            if (1..=4).contains(&low.len())
                && low.len() == high.len()
                && self.out.codespace.len() < 256
            {
                let mut space = Codespace {
                    length: u8::try_from(low.len()).unwrap_or(u8::MAX),
                    low: [0; 4],
                    high: [0; 4],
                };
                for (slot, byte) in space.low.iter_mut().zip(low.iter()) {
                    *slot = *byte;
                }
                for (slot, byte) in space.high.iter_mut().zip(high.iter()) {
                    *slot = *byte;
                }
                self.out.codespace.push(space);
            }
        }
    }

    fn bf_chars(&mut self) {
        while let Some(Token::Hex(source)) = self.lexer.next() {
            let Some(dest) = self.lexer.next() else { break };
            let Token::Hex(dest) = dest else { continue };
            if !self.take_slot() {
                break;
            }
            if let Some((code, _)) = hex_code(source) {
                let text = decode_utf16(&hex_bytes(dest));
                self.out.unicode.has_unusable |= !text_usable(&text);
                self.out.unicode.chars.push((code, text.into_boxed_slice()));
            }
        }
    }

    fn bf_ranges(&mut self) {
        while let Some(Token::Hex(low)) = self.lexer.next() {
            let (Some(Token::Hex(high)), Some(dest)) = (self.lexer.next(), self.lexer.next())
            else {
                break;
            };
            let bounds = hex_code(low).zip(hex_code(high));
            let dest = match dest {
                Token::Hex(raw) => {
                    let text = decode_utf16(&hex_bytes(raw)).into_boxed_slice();
                    self.out.unicode.has_unusable |= !text_usable(&text);
                    Some(RangeDest::Incrementing(text))
                }
                Token::ArrayOpen => {
                    let items: Vec<Box<[u32]>> = array_items(&mut self.lexer)
                        .into_iter()
                        .map(|raw| decode_utf16(&hex_bytes(raw)).into_boxed_slice())
                        .collect();
                    self.out.unicode.has_unusable |= items.iter().any(|item| !text_usable(item));
                    Some(RangeDest::PerCode(items))
                }
                Token::Int(_) | Token::Name(_) | Token::Keyword(_) | Token::ArrayClose => None,
            };
            if !self.take_slot() {
                break;
            }
            if let (Some(((start, _), (end, _))), Some(dest)) = (bounds, dest)
                && start <= end
            {
                self.out
                    .unicode
                    .ranges
                    .push(UnicodeRange { start, end, dest });
            }
        }
    }

    fn push_cid(&mut self, notdef: bool, range: CidRange) {
        if notdef {
            self.out.notdef.push(range);
        } else {
            self.out.cid_ranges.push(range);
        }
    }

    fn cid_chars(&mut self, notdef: bool) {
        while let Some(Token::Hex(source)) = self.lexer.next() {
            let Some(Token::Int(cid)) = self.lexer.next() else {
                break;
            };
            if !self.take_slot() {
                break;
            }
            if let (Some((code, length)), Ok(cid)) = (hex_code(source), u32::try_from(cid)) {
                let range = CidRange {
                    length: u8::try_from(length).unwrap_or(u8::MAX),
                    low: code,
                    high: code,
                    cid,
                };
                self.push_cid(notdef, range);
            }
        }
    }

    fn cid_ranges(&mut self, notdef: bool) {
        while let Some(Token::Hex(low)) = self.lexer.next() {
            let (Some(Token::Hex(high)), Some(Token::Int(cid))) =
                (self.lexer.next(), self.lexer.next())
            else {
                break;
            };
            if !self.take_slot() {
                break;
            }
            if let (Some((start, length)), Some((end, _)), Ok(cid)) =
                (hex_code(low), hex_code(high), u32::try_from(cid))
                && start <= end
            {
                let range = CidRange {
                    length: u8::try_from(length).unwrap_or(u8::MAX),
                    low: start,
                    high: end,
                    cid,
                };
                self.push_cid(notdef, range);
            }
        }
    }
}

fn parse_cmap_data(data: &[u8], limits: &Limits) -> CMapData {
    CMapParser::new(data, limits).parse()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Identity,
    Ucs2,
    Utf16,
    Embedded,
}

#[derive(Clone, Debug)]
pub(crate) struct CMap {
    kind: Kind,
    codespace: Vec<Codespace>,
    cid_ranges: Vec<CidRange>,
    notdef: Vec<CidRange>,
    parent: Option<Box<Self>>,
    vertical: bool,
}

pub(crate) struct ParsedCMap {
    pub cmap: CMap,
    pub parent: Option<Vec<u8>>,
}

impl CMap {
    pub(crate) const fn identity(vertical: bool) -> Self {
        Self::with_kind(Kind::Identity, vertical)
    }

    const fn with_kind(kind: Kind, vertical: bool) -> Self {
        Self {
            kind,
            codespace: Vec::new(),
            cid_ranges: Vec::new(),
            notdef: Vec::new(),
            parent: None,
            vertical,
        }
    }

    pub(crate) fn predefined(name: &[u8]) -> Option<Self> {
        let vertical = match name {
            b"Identity-H" => return Some(Self::identity(false)),
            b"Identity-V" => return Some(Self::identity(true)),
            _ if name.ends_with(b"-V") => true,
            _ if name.ends_with(b"-H") => false,
            _ => return None,
        };
        if !name.starts_with(b"Uni") {
            return None;
        }
        let contains = |needle: &[u8]| name.windows(needle.len()).any(|window| window == needle);
        if contains(b"UCS2") {
            Some(Self::with_kind(Kind::Ucs2, vertical))
        } else if contains(b"UTF16") {
            Some(Self::with_kind(Kind::Utf16, vertical))
        } else {
            None
        }
    }

    pub(crate) fn parse(data: &[u8], limits: &Limits) -> ParsedCMap {
        let parsed = parse_cmap_data(data, limits);
        ParsedCMap {
            cmap: Self {
                kind: Kind::Embedded,
                codespace: parsed.codespace,
                cid_ranges: parsed.cid_ranges,
                notdef: parsed.notdef,
                parent: None,
                vertical: parsed.vertical,
            },
            parent: parsed.parent,
        }
    }

    pub(crate) fn with_parent(mut self, parent: Self) -> Self {
        let mut depth = 0_usize;
        let mut cursor = &parent;
        while let Some(next) = cursor.parent.as_deref() {
            depth = depth.saturating_add(1);
            cursor = next;
        }
        if depth < MAX_PARENT_DEPTH {
            if !self.vertical {
                self.vertical = parent.vertical;
            }
            self.parent = Some(Box::new(parent));
        }
        self
    }

    pub(crate) const fn with_vertical(mut self, vertical: bool) -> Self {
        self.vertical = vertical;
        self
    }

    pub(crate) const fn is_vertical(&self) -> bool {
        self.vertical
    }

    pub(crate) fn is_identity(&self) -> bool {
        self.kind == Kind::Identity
    }

    pub(crate) const fn is_unicode_keyed(&self) -> bool {
        matches!(self.kind, Kind::Ucs2 | Kind::Utf16)
    }

    pub(crate) fn is_empty_table(&self) -> bool {
        self.kind == Kind::Embedded
            && self.codespace.is_empty()
            && self.cid_ranges.is_empty()
            && self.parent.is_none()
    }

    fn effective_codespace(&self) -> &[Codespace] {
        if self.codespace.is_empty()
            && let Some(parent) = self.parent.as_deref()
        {
            return parent.effective_codespace();
        }
        &self.codespace
    }

    pub(crate) fn read(&self, bytes: &[u8], offset: usize) -> Option<(u32, usize)> {
        let rest = bytes.get(offset..)?;
        let first = *rest.first()?;
        match self.kind {
            Kind::Identity | Kind::Ucs2 => {
                let pair = rest.get(..2)?;
                Some((
                    (u32::from(*pair.first()?) << 8) | u32::from(*pair.get(1)?),
                    2,
                ))
            }
            Kind::Utf16 => {
                let pair = rest.get(..2)?;
                let unit = (u32::from(*pair.first()?) << 8) | u32::from(*pair.get(1)?);
                if (0xD800..0xDC00).contains(&unit)
                    && let Some(tail) = rest.get(2..4)
                {
                    let trail = (u32::from(*tail.first()?) << 8) | u32::from(*tail.get(1)?);
                    if (0xDC00..0xE000).contains(&trail) {
                        return Some(((unit << 16) | trail, 4));
                    }
                }
                Some((unit, 2))
            }
            Kind::Embedded => {
                let spaces = self.effective_codespace();
                if spaces.is_empty() {
                    let pair = rest.get(..2);
                    return match pair {
                        Some(pair) => Some((
                            (u32::from(*pair.first()?) << 8) | u32::from(*pair.get(1)?),
                            2,
                        )),
                        None => Some((u32::from(first), 1)),
                    };
                }
                for length in 1..=4_usize {
                    let Some(window) = rest.get(..length) else {
                        break;
                    };
                    if spaces
                        .iter()
                        .any(|space| usize::from(space.length) == length && space.contains(window))
                    {
                        return Some((be_value(window), length));
                    }
                }
                let shortest = spaces.iter().map(|space| usize::from(space.length)).min()?;
                let length = shortest.min(rest.len());
                Some((be_value(rest.get(..length)?), length))
            }
        }
    }

    pub(crate) fn cid(&self, code: u32, length: usize) -> Option<u32> {
        match self.kind {
            Kind::Identity => Some(code),
            Kind::Ucs2 | Kind::Utf16 => None,
            Kind::Embedded => Some(self.table_cid(code, length).unwrap_or(0)),
        }
    }

    fn table_cid(&self, code: u32, length: usize) -> Option<u32> {
        let length = u8::try_from(length).ok()?;
        find_range(&self.cid_ranges, length, code)
            .map(|range| range.cid.saturating_add(code.saturating_sub(range.low)))
            .or_else(|| {
                self.parent
                    .as_deref()
                    .and_then(|parent| parent.table_cid(code, usize::from(length)))
            })
            .or_else(|| find_range(&self.notdef, length, code).map(|range| range.cid))
    }

    pub(crate) fn direct_unicode(&self, code: u32) -> Option<Vec<u32>> {
        match self.kind {
            Kind::Ucs2 => Some(vec![code]),
            Kind::Utf16 => Some(if code > 0xFFFF {
                vec![surrogate_pair(code >> 16, code & 0xFFFF)]
            } else {
                vec![code]
            }),
            Kind::Identity | Kind::Embedded => None,
        }
    }
}

fn find_range(ranges: &[CidRange], length: u8, code: u32) -> Option<&CidRange> {
    let upper = ranges.partition_point(|range| (range.length, range.low) <= (length, code));
    ranges
        .get(..upper)?
        .iter()
        .rev()
        .take(RANGE_SCAN)
        .find(|range| range.length == length && code <= range.high)
}

fn be_value(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .fold(0_u32, |acc, byte| (acc << 8) | u32::from(*byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::num::widen;
    use std::hint::black_box;

    fn limits() -> Limits {
        Limits::default()
    }

    fn found(map: &UnicodeMap, code: u32) -> Option<Vec<u32>> {
        map.lookup(code).map(|value| value.as_slice().to_vec())
    }

    #[test]
    fn bfchar_and_count_before_keyword() {
        let data = b"1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar\n<0001> <0041>\n<0002> <00660069>\nendbfchar";
        let map = UnicodeMap::parse(data, &limits());
        assert_eq!(found(&map, 1), Some(vec![0x41]));
        assert_eq!(found(&map, 2), Some(vec![0x66, 0x69]));
        assert_eq!(found(&map, 3), None);
        assert!(!map.has_unusable());
    }

    #[test]
    fn bfrange_incrementing_array_surrogate_and_multi() {
        let data = b"4 beginbfrange\n<0010> <0012> <0061>\n<0020> <0021> [<0041> <00420043>]\n<0030> <0030> <d800dc00>\n<0040> <0042> <00660066>\nendbfrange";
        let map = UnicodeMap::parse(data, &limits());
        assert_eq!(found(&map, 0x10), Some(vec![0x61]));
        assert_eq!(found(&map, 0x12), Some(vec![0x63]));
        assert_eq!(found(&map, 0x13), None);
        assert_eq!(found(&map, 0x20), Some(vec![0x41]));
        assert_eq!(found(&map, 0x21), Some(vec![0x42, 0x43]));
        assert_eq!(found(&map, 0x30), Some(vec![0x1_0000]));
        assert_eq!(found(&map, 0x42), Some(vec![0x66, 0x68]));
    }

    #[test]
    fn later_definition_wins_and_usable_filters() {
        let data = b"2 beginbfchar <01> <0041> <01> <0042> endbfchar 2 beginbfchar <02> <0000> <03> <FFFD> endbfchar";
        let map = UnicodeMap::parse(data, &limits());
        assert_eq!(found(&map, 1), Some(vec![0x42]));
        assert!(map.usable(2).is_none());
        assert!(map.usable(3).is_none());
        assert!(map.usable(1).is_some());
        assert!(map.has_unusable());
    }

    #[test]
    fn ligature_nul_destination_is_flagged() {
        let data = b"beginbfrange <0130> <0130> <0000> endbfrange";
        let map = UnicodeMap::parse(data, &limits());
        assert!(map.has_unusable());
        assert!(map.usable(0x130).is_none());
    }

    #[test]
    fn code_for_char_searches_chars_and_ranges() {
        let data = b"beginbfchar <05> <0074> endbfchar beginbfrange <10> <1f> <0061> <20> <21> [<0058> <0059>] endbfrange";
        let map = UnicodeMap::parse(data, &limits());
        assert_eq!(map.code_for_char(0x74), Some(5));
        assert_eq!(map.code_for_char(0x61), Some(0x10));
        assert_eq!(map.code_for_char(0x63), Some(0x12));
        assert_eq!(map.code_for_char(0x59), Some(0x21));
        assert_eq!(map.code_for_char(0x7A), None);
        assert_eq!(map.code_for_char(0x40), None);
    }

    #[test]
    fn many_overlapping_ranges_are_searched() {
        let data = b"beginbfrange <0000> <00ff> <0100> <0010> <0010> <0900> endbfrange";
        let map = UnicodeMap::parse(data, &limits());
        assert_eq!(found(&map, 0x10), Some(vec![0x900]));
        assert_eq!(found(&map, 0x11), Some(vec![0x111]));
    }

    #[test]
    fn comments_strings_and_dicts_are_skipped() {
        let data = b"%% comment <0001> <0002>\n/CIDInit /ProcSet findresource begin 12 dict begin (a<b) pop << /Registry (Adobe) >> beginbfchar <03> <0058> endbfchar";
        let map = UnicodeMap::parse(data, &limits());
        assert_eq!(found(&map, 3), Some(vec![0x58]));
        assert_eq!(found(&map, 1), None);
    }

    #[test]
    fn embedded_cmap_with_mixed_codespace_and_cids() {
        let data = b"/WMode 1 def 2 begincodespacerange <00> <80> <8140> <9FFC> endcodespacerange 1 begincidchar <20> 1 endcidchar 2 begincidrange <8140> <817e> 633 <8180> <81ac> 696 endcidrange 1 beginnotdefrange <00> <1f> 1 endnotdefrange";
        let parsed = CMap::parse(data, &limits());
        let cmap = parsed.cmap;
        assert!(cmap.is_vertical());
        assert_eq!(cmap.read(&[0x41, 0x81, 0x41], 0), Some((0x41, 1)));
        assert_eq!(cmap.read(&[0x41, 0x81, 0x41], 1), Some((0x8141, 2)));
        assert_eq!(cmap.cid(0x20, 1), Some(1));
        assert_eq!(cmap.cid(0x8141, 2), Some(634));
        assert_eq!(cmap.cid(0x8185, 2), Some(701));
        assert_eq!(cmap.cid(0x05, 1), Some(1));
        assert_eq!(cmap.cid(0x9000, 2), Some(0));
        assert_eq!(cmap.read(&[0x81], 0), Some((0x81, 1)));
    }

    #[test]
    fn usecmap_chains_to_parent_codespace_and_cids() {
        let child = b"/Base usecmap 1 begincidrange <0100> <01ff> 1000 endcidrange";
        let parsed = CMap::parse(child, &limits());
        assert_eq!(parsed.parent.as_deref(), Some(b"Base".as_slice()));
        let parent_data = b"1 begincodespacerange <0000> <ffff> endcodespacerange 1 begincidrange <0000> <00ff> 0 endcidrange";
        let parent = CMap::parse(parent_data, &limits()).cmap;
        let cmap = parsed.cmap.with_parent(parent);
        assert_eq!(cmap.cid(0x0105, 2), Some(1005));
        assert_eq!(cmap.cid(0x0010, 2), Some(0x10));
        assert_eq!(cmap.read(&[0x01, 0x05, 0x00], 0), Some((0x0105, 2)));
    }

    #[test]
    fn parent_depth_is_bounded() {
        let mut cmap = CMap::identity(false);
        for _ in 0..16 {
            cmap = CMap::parse(b"", &limits()).cmap.with_parent(cmap);
        }
        assert!(cmap.cid(1, 2).is_some());
    }

    #[test]
    fn identity_and_unicode_predefined_cmaps() {
        let identity = CMap::predefined(b"Identity-H").expect("identity");
        assert!(identity.is_identity() && !identity.is_vertical());
        assert_eq!(identity.read(&[0x12, 0x34, 0x56], 0), Some((0x1234, 2)));
        assert_eq!(identity.read(&[0x12], 0), None);
        assert_eq!(identity.cid(0x1234, 2), Some(0x1234));
        let vertical = CMap::predefined(b"Identity-V").expect("identity-v");
        assert!(vertical.is_vertical());
        for name in [
            "UniGB-UCS2-H",
            "UniCNS-UCS2-V",
            "UniJIS-UCS2-HW-H",
            "UniKS-UCS2-H",
            "UniGB-UTF16-H",
            "UniJIS-UTF16-V",
        ] {
            let cmap = CMap::predefined(name.as_bytes()).expect(name);
            assert!(cmap.is_unicode_keyed());
            assert_eq!(cmap.is_vertical(), name.ends_with("-V"));
            assert_eq!(cmap.cid(0x4E00, 2), None);
        }
        assert!(CMap::predefined(b"90ms-RKSJ-H").is_none());
        assert!(CMap::predefined(b"UniJIS-UTF8-H").is_none());
        assert!(CMap::predefined(b"").is_none());
    }

    #[test]
    fn ucs2_and_utf16_decode_direct_unicode() {
        let ucs2 = CMap::predefined(b"UniGB-UCS2-H").expect("ucs2");
        assert_eq!(ucs2.read(&[0x4E, 0x2D, 0x65, 0x87], 2), Some((0x6587, 2)));
        assert_eq!(ucs2.direct_unicode(0x4E2D), Some(vec![0x4E2D]));
        let utf16 = CMap::predefined(b"UniJIS-UTF16-H").expect("utf16");
        assert_eq!(utf16.read(&[0x4E, 0x2D], 0), Some((0x4E2D, 2)));
        let pair = [0xD8, 0x40, 0xDC, 0x0B, 0x00, 0x41];
        let (code, length) = utf16.read(&pair, 0).expect("pair");
        assert_eq!(length, 4);
        assert_eq!(utf16.direct_unicode(code), Some(vec![0x2000B]));
        assert_eq!(utf16.read(&pair, 4), Some((0x41, 2)));
        assert_eq!(utf16.read(&[0xD8, 0x40, 0x00, 0x41], 0), Some((0xD840, 2)));
        assert_eq!(utf16.read(&[0xD8, 0x40], 0), Some((0xD840, 2)));
    }

    #[test]
    fn empty_codespace_defaults_to_two_bytes() {
        let cmap = CMap::parse(b"", &limits()).cmap;
        assert!(cmap.is_empty_table());
        assert_eq!(cmap.read(&[1, 2, 3], 0), Some((0x0102, 2)));
        assert_eq!(cmap.read(&[1], 0), Some((1, 1)));
    }

    #[test]
    fn decode_utf16_handles_odd_and_unpaired_units() {
        assert_eq!(decode_utf16(&[0x41]), vec![0x41]);
        assert_eq!(decode_utf16(&[0xD8, 0x00]), vec![0xD800]);
        assert_eq!(decode_utf16(&[0xD8, 0x00, 0x00, 0x41]), vec![0xD800, 0x41]);
        assert_eq!(decode_utf16(&[]), Vec::<u32>::new());
        assert!(!text_usable(&[0xD800]));
        assert!(!text_usable(&[]));
        assert!(text_usable(&[0x41, 0x20]));
    }

    #[test]
    fn garbage_never_panics() {
        let mut seed = 0x9E37_79B9_u32;
        let keywords: [&[u8]; 8] = [
            b" begincodespacerange ",
            b" beginbfchar ",
            b" beginbfrange ",
            b" begincidrange ",
            b" begincidchar ",
            b" beginnotdefrange ",
            b" usecmap ",
            b" [ ",
        ];
        for round in 0..2048_usize {
            let mut data = Vec::new();
            for _ in 0..(8 + round % 40) {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                match (seed >> 16) % 6 {
                    0 => data.extend_from_slice(keywords[widen(seed >> 20) % keywords.len()]),
                    1 => data.extend_from_slice(b"<00"),
                    2 => data.extend_from_slice(b"<ffff> "),
                    3 => data.push(u8::try_from((seed >> 8) & 0xFF).unwrap()),
                    4 => data.extend_from_slice(b" 12345678901234567890 "),
                    _ => data.extend_from_slice(b"> ] "),
                }
            }
            let map = UnicodeMap::parse(&data, &limits());
            black_box(map.lookup(1));
            let parsed = CMap::parse(&data, &limits());
            black_box(parsed.cmap.read(&data, 0));
            black_box(parsed.cmap.cid(0x41, 1));
            black_box(parsed.cmap.cid(0x4141, 2));
        }
    }
}
