use crate::num::u64_to_f64;
use std::ops::Range;

use crate::failure::{Failure, Outcome};
use crate::object::{Dict, ObjRef, Object, Stream};

const CONTENT_NESTING: usize = 32;
const KEYWORD_PROBE: usize = 16;
const IMAGE_END_PROBE: usize = 10;

#[inline(always)]
pub(crate) const fn is_whitespace(byte: u8) -> bool {
    matches!(byte, 0 | 9 | 10 | 12 | 13 | 32)
}

#[inline(always)]
pub(crate) const fn is_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

#[inline(always)]
pub(crate) const fn is_regular(byte: u8) -> bool {
    !is_whitespace(byte) && !is_delimiter(byte)
}

#[inline(always)]
const fn is_number_start(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'+' | b'-' | b'.')
}

const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte.saturating_sub(b'0')),
        b'a'..=b'f' => Some((byte.saturating_sub(b'a')).saturating_add(10)),
        b'A'..=b'F' => Some((byte.saturating_sub(b'A')).saturating_add(10)),
        _ => None,
    }
}

pub(crate) fn skip_whitespace_at(data: &[u8], mut pos: usize) -> usize {
    while let Some(&byte) = data.get(pos) {
        if is_whitespace(byte) {
            pos = pos.saturating_add(1);
        } else if byte == b'%' {
            pos = pos.saturating_add(1);
            while let Some(&next) = data.get(pos) {
                if next == b'\n' || next == b'\r' {
                    break;
                }
                pos = pos.saturating_add(1);
            }
        } else {
            break;
        }
    }
    pos
}

pub(crate) fn read_unsigned(data: &[u8], pos: &mut usize) -> Option<u64> {
    let start = *pos;
    let mut value: u64 = 0;
    let mut cursor = start;
    while let Some(&byte) = data.get(cursor) {
        if !byte.is_ascii_digit() {
            break;
        }
        value = value
            .checked_mul(10)?
            .checked_add(u64::from(byte.saturating_sub(b'0')))?;
        cursor = cursor.saturating_add(1);
    }
    if cursor == start {
        return None;
    }
    *pos = cursor;
    Some(value)
}

pub(crate) fn find_bytes(data: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    let first = *needle.first()?;
    let mut index = from;
    while let Some(rest) = data.get(index..) {
        let offset = rest.iter().position(|&byte| byte == first)?;
        let start = index.saturating_add(offset);
        if data.get(start..start.saturating_add(needle.len())) == Some(needle) {
            return Some(start);
        }
        index = start.saturating_add(1);
    }
    None
}

pub(crate) fn keyword_at(data: &[u8], pos: usize, keyword: &[u8]) -> bool {
    data.get(pos..pos.saturating_add(keyword.len())) == Some(keyword)
        && !data
            .get(pos.saturating_add(keyword.len()))
            .copied()
            .is_some_and(is_regular)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reject {
    Garbage,
    TooDeep,
}

impl Reject {
    pub(crate) fn into_failure(self) -> Failure {
        match self {
            Self::Garbage => Failure::invalid("malformed object"),
            Self::TooDeep => Failure::limit("object nesting exceeds limit"),
        }
    }
}

type Parsed<T> = Result<T, Reject>;

pub(crate) struct Parser<'a> {
    data: &'a [u8],
    pos: usize,
    max_depth: usize,
    refs: bool,
}

impl<'a> Parser<'a> {
    pub(crate) const fn new(data: &'a [u8], pos: usize, max_depth: usize, refs: bool) -> Self {
        Self {
            data,
            pos,
            max_depth,
            refs,
        }
    }

    pub(crate) const fn position(&self) -> usize {
        self.pos
    }

    #[inline(always)]
    fn peek(&self) -> Option<u8> {
        self.data.get(self.pos).copied()
    }

    #[inline(always)]
    fn peek_at(&self, ahead: usize) -> Option<u8> {
        self.data.get(self.pos.saturating_add(ahead)).copied()
    }

    fn slice(&self, start: usize, end: usize) -> &'a [u8] {
        self.data.get(start..end).unwrap_or_default()
    }

    pub(crate) fn skip_whitespace(&mut self) {
        self.pos = skip_whitespace_at(self.data, self.pos);
    }

    pub(crate) fn parse_object(&mut self) -> Outcome<Object> {
        self.skip_whitespace();
        self.value(0).map_err(Reject::into_failure)
    }

    fn regular_run(&mut self) -> &'a [u8] {
        let start = self.pos;
        while let Some(byte) = self.peek() {
            if !is_regular(byte) {
                break;
            }
            self.pos = self.pos.saturating_add(1);
        }
        self.slice(start, self.pos)
    }

    fn keyword_here(&self, keyword: &[u8]) -> bool {
        keyword_at(self.data, self.pos, keyword)
    }

    fn value(&mut self, depth: usize) -> Parsed<Object> {
        self.skip_whitespace();
        let Some(byte) = self.peek() else {
            return Err(Reject::Garbage);
        };
        match byte {
            b'/' => Ok(Object::Name(self.name())),
            b'(' => Ok(Object::String(self.literal_string())),
            b'<' => {
                if self.peek_at(1) == Some(b'<') {
                    self.dictionary(depth)
                } else {
                    Ok(Object::String(self.hex_string()))
                }
            }
            b'[' => self.array(depth),
            b'0'..=b'9' | b'+' | b'-' | b'.' => Ok(self.number()),
            b']' | b')' | b'>' | b'{' | b'}' | b'%' => {
                self.pos = self.pos.saturating_add(1);
                Err(Reject::Garbage)
            }
            _ => {
                let run = self.regular_run();
                match run {
                    b"true" => Ok(Object::Bool(true)),
                    b"false" => Ok(Object::Bool(false)),
                    b"null" => Ok(Object::Null),
                    _ => Err(Reject::Garbage),
                }
            }
        }
    }

    fn garbage_keyword(&mut self) -> Option<bool> {
        let byte = self.peek()?;
        if !is_regular(byte) || is_number_start(byte) {
            return None;
        }
        let start = self.pos;
        let mut end = start;
        while end.saturating_sub(start) < KEYWORD_PROBE
            && self.data.get(end).copied().is_some_and(is_regular)
        {
            end = end.saturating_add(1);
        }
        let run = self.slice(start, end);
        if matches!(run, b"true" | b"false" | b"null") {
            return None;
        }
        let terminator = matches!(
            run,
            b"endobj" | b"stream" | b"endstream" | b"obj" | b"startxref" | b"xref" | b"trailer"
        );
        if terminator || !self.refs {
            return Some(true);
        }
        self.regular_run();
        Some(false)
    }

    fn array(&mut self, depth: usize) -> Parsed<Object> {
        if depth >= self.max_depth {
            self.pos = self.pos.saturating_add(1);
            return Err(Reject::TooDeep);
        }
        self.pos = self.pos.saturating_add(1);
        let mut items = Vec::new();
        loop {
            self.skip_whitespace();
            match self.peek() {
                None => break,
                Some(b']') => {
                    self.pos = self.pos.saturating_add(1);
                    break;
                }
                Some(_) => {}
            }
            match self.garbage_keyword() {
                Some(true) => break,
                Some(false) => continue,
                None => {}
            }
            match self.value(depth.saturating_add(1)) {
                Ok(item) => items.push(item),
                Err(Reject::TooDeep) => return Err(Reject::TooDeep),
                Err(Reject::Garbage) => {}
            }
        }
        Ok(Object::Array(items))
    }

    fn dictionary(&mut self, depth: usize) -> Parsed<Object> {
        if depth >= self.max_depth {
            self.pos = self.pos.saturating_add(1);
            return Err(Reject::TooDeep);
        }
        self.pos = self.pos.saturating_add(2);
        let mut dict = Dict::default();
        loop {
            self.skip_whitespace();
            let Some(byte) = self.peek() else { break };
            if byte == b'>' {
                if self.peek_at(1) == Some(b'>') {
                    self.pos = self.pos.saturating_add(2);
                    break;
                }
                self.pos = self.pos.saturating_add(1);
                continue;
            }
            if byte != b'/' {
                match self.garbage_keyword() {
                    Some(true) => break,
                    Some(false) => continue,
                    None => {}
                }
                match self.value(depth.saturating_add(1)) {
                    Err(Reject::TooDeep) => return Err(Reject::TooDeep),
                    _ => continue,
                }
            }
            let key = self.name();
            self.skip_whitespace();
            match self.peek() {
                None => break,
                Some(b'>') if self.peek_at(1) == Some(b'>') => continue,
                Some(_) => {}
            }
            match self.garbage_keyword() {
                Some(true) => break,
                Some(false) => continue,
                None => {}
            }
            match self.value(depth.saturating_add(1)) {
                Ok(value) => dict.entries.push((key, value)),
                Err(Reject::TooDeep) => return Err(Reject::TooDeep),
                Err(Reject::Garbage) => {}
            }
        }
        Ok(Object::Dict(dict))
    }

    fn name(&mut self) -> Vec<u8> {
        self.pos = self.pos.saturating_add(1);
        let raw = self.regular_run();
        if !raw.contains(&b'#') {
            return raw.to_vec();
        }
        let mut out = Vec::with_capacity(raw.len());
        let mut index = 0;
        while let Some(&byte) = raw.get(index) {
            if byte == b'#'
                && let Some(high) = raw
                    .get(index.saturating_add(1))
                    .copied()
                    .and_then(hex_value)
                && let Some(low) = raw
                    .get(index.saturating_add(2))
                    .copied()
                    .and_then(hex_value)
            {
                out.push(high << 4 | low);
                index = index.saturating_add(3);
            } else {
                out.push(byte);
                index = index.saturating_add(1);
            }
        }
        out
    }

    fn hex_string(&mut self) -> Vec<u8> {
        self.pos = self.pos.saturating_add(1);
        let mut out = Vec::new();
        let mut high: Option<u8> = None;
        while let Some(byte) = self.peek() {
            self.pos = self.pos.saturating_add(1);
            if byte == b'>' {
                break;
            }
            if let Some(nibble) = hex_value(byte) {
                match high.take() {
                    Some(upper) => out.push(upper << 4 | nibble),
                    None => high = Some(nibble),
                }
            }
        }
        if let Some(upper) = high {
            out.push(upper << 4);
        }
        out
    }

    fn literal_string(&mut self) -> Vec<u8> {
        self.pos = self.pos.saturating_add(1);
        let mut out = Vec::new();
        let mut depth = 1_usize;
        loop {
            let start = self.pos;
            while let Some(byte) = self.peek() {
                if matches!(byte, b'(' | b')' | b'\\' | b'\r') {
                    break;
                }
                self.pos = self.pos.saturating_add(1);
            }
            out.extend_from_slice(self.slice(start, self.pos));
            let Some(byte) = self.peek() else { break };
            self.pos = self.pos.saturating_add(1);
            match byte {
                b'(' => {
                    depth = depth.saturating_add(1);
                    out.push(b'(');
                }
                b')' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        break;
                    }
                    out.push(b')');
                }
                b'\r' => {
                    if self.peek() == Some(b'\n') {
                        self.pos = self.pos.saturating_add(1);
                    }
                    out.push(b'\n');
                }
                _ => {
                    let Some(escaped) = self.peek() else { break };
                    self.pos = self.pos.saturating_add(1);
                    match escaped {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'\r' => {
                            if self.peek() == Some(b'\n') {
                                self.pos = self.pos.saturating_add(1);
                            }
                        }
                        b'\n' => {}
                        b'0'..=b'7' => {
                            let mut value = u32::from(escaped.saturating_sub(b'0'));
                            for _ in 0..2 {
                                match self.peek() {
                                    Some(digit @ b'0'..=b'7') => {
                                        value = (value.saturating_mul(8))
                                            .saturating_add(u32::from(digit.saturating_sub(b'0')));
                                        self.pos = self.pos.saturating_add(1);
                                    }
                                    _ => break,
                                }
                            }
                            out.push(u8::try_from(value & 0xff).unwrap_or(u8::MAX));
                        }
                        other => out.push(other),
                    }
                }
            }
        }
        out
    }

    fn number(&mut self) -> Object {
        let mut negative = false;
        let mut signed = false;
        match self.peek() {
            Some(b'+') => {
                signed = true;
                self.pos = self.pos.saturating_add(1);
            }
            Some(b'-') => {
                signed = true;
                negative = true;
                self.pos = self.pos.saturating_add(1);
                while self.peek() == Some(b'-') {
                    self.pos = self.pos.saturating_add(1);
                }
            }
            _ => {}
        }
        let mut whole: u64 = 0;
        let mut overflow = false;
        let mut digits = 0_usize;
        while let Some(byte @ b'0'..=b'9') = self.peek() {
            match whole
                .checked_mul(10)
                .and_then(|value| value.checked_add(u64::from(byte.saturating_sub(b'0'))))
            {
                Some(value) => whole = value,
                None => overflow = true,
            }
            digits = digits.saturating_add(1);
            self.pos = self.pos.saturating_add(1);
        }
        if self.peek() == Some(b'.') {
            self.pos = self.pos.saturating_add(1);
            let mut fraction: u64 = 0;
            let mut scale = 0_usize;
            while let Some(byte @ b'0'..=b'9') = self.peek() {
                if scale < 18 {
                    fraction = (fraction.saturating_mul(10))
                        .saturating_add(u64::from(byte.saturating_sub(b'0')));
                    scale = scale.saturating_add(1);
                }
                self.pos = self.pos.saturating_add(1);
            }
            let divisor = 10_f64.powi(i32::try_from(scale).unwrap_or(0));
            let magnitude = u64_to_f64(whole) + u64_to_f64(fraction) / divisor;
            return Object::Real(if negative { -magnitude } else { magnitude });
        }
        if digits == 0 {
            return Object::Integer(0);
        }
        if overflow || whole > i64::MAX.cast_unsigned() {
            let magnitude = if overflow {
                f64::MAX
            } else {
                u64_to_f64(whole)
            };
            return Object::Real(if negative { -magnitude } else { magnitude });
        }
        let integer = whole.cast_signed();
        if self.refs
            && !signed
            && let Some((reference, end)) = self.reference(whole)
        {
            self.pos = end;
            return reference;
        }
        Object::Integer(if negative {
            integer.saturating_neg()
        } else {
            integer
        })
    }

    fn reference(&self, number: u64) -> Option<(Object, usize)> {
        let number = u32::try_from(number).ok()?;
        let data = self.data;
        let mut index = self.pos;
        let gap = index;
        while data.get(index).copied().is_some_and(is_whitespace) {
            index = index.saturating_add(1);
        }
        if index == gap {
            return None;
        }
        let digits_start = index;
        let mut generation: u32 = 0;
        while let Some(&byte) = data.get(index) {
            if !byte.is_ascii_digit() {
                break;
            }
            if index.saturating_sub(digits_start) >= 5 {
                return None;
            }
            generation = (generation.saturating_mul(10))
                .saturating_add(u32::from(byte.saturating_sub(b'0')));
            index = index.saturating_add(1);
        }
        if index == digits_start {
            return None;
        }
        let gap = index;
        while data.get(index).copied().is_some_and(is_whitespace) {
            index = index.saturating_add(1);
        }
        if index == gap || !keyword_at(data, index, b"R") {
            return None;
        }
        let reference = ObjRef {
            number,
            generation: u16::try_from(generation).unwrap_or(u16::MAX),
        };
        Some((Object::Ref(reference), index.saturating_add(1)))
    }

    fn inline_image(&mut self) -> Outcome<ContentToken<'a>> {
        let mut length: Option<usize> = None;
        loop {
            self.skip_whitespace();
            let Some(byte) = self.peek() else {
                return Ok(ContentToken::Operator(b"EI"));
            };
            if self.keyword_here(b"ID") {
                self.pos = self.pos.saturating_add(2);
                break;
            }
            if self.keyword_here(b"EI") {
                self.pos = self.pos.saturating_add(2);
                return Ok(ContentToken::Operator(b"EI"));
            }
            if byte == b'/' {
                let key = self.name();
                self.skip_whitespace();
                if self.keyword_here(b"ID") {
                    continue;
                }
                match self.value(0) {
                    Ok(value) => {
                        if key == b"L" || key == b"Length" {
                            length = value.as_integer().and_then(|n| usize::try_from(n).ok());
                        }
                    }
                    Err(reject @ Reject::TooDeep) => return Err(reject.into_failure()),
                    Err(Reject::Garbage) => {}
                }
            } else if let Err(reject @ Reject::TooDeep) = self.value(0) {
                return Err(reject.into_failure());
            }
        }
        if let Some(byte) = self.peek()
            && is_whitespace(byte)
        {
            self.pos = self.pos.saturating_add(1);
            if byte == b'\r' && self.peek() == Some(b'\n') {
                self.pos = self.pos.saturating_add(1);
            }
        }
        self.pos = inline_image_end(self.data, self.pos, length);
        Ok(ContentToken::Operator(b"EI"))
    }
}

fn image_terminated(data: &[u8], pos: usize) -> bool {
    data.get(pos)
        .is_none_or(|&byte| is_whitespace(byte) || is_delimiter(byte))
}

fn textual_after(data: &[u8], pos: usize) -> bool {
    let end = data.len().min(pos.saturating_add(IMAGE_END_PROBE));
    data.get(pos..end)
        .unwrap_or_default()
        .iter()
        .all(|&byte| byte < 0x80 && (byte >= 0x20 || is_whitespace(byte)))
}

fn inline_image_end(data: &[u8], start: usize, length: Option<usize>) -> usize {
    if let Some(declared) = length
        && let Some(end) = start.checked_add(declared)
    {
        let mut after = end;
        while data.get(after).copied().is_some_and(is_whitespace) {
            after = after.saturating_add(1);
        }
        if data.get(after..after.saturating_add(2)) == Some(b"EI")
            && image_terminated(data, after.saturating_add(2))
        {
            return after.saturating_add(2);
        }
    }
    let mut from = start;
    while let Some(found) = find_bytes(data, from, b"EI") {
        let preceded = found == start
            || found
                .checked_sub(1)
                .and_then(|before| data.get(before))
                .copied()
                .is_some_and(is_whitespace);
        if preceded
            && image_terminated(data, found.saturating_add(2))
            && textual_after(data, found.saturating_add(2))
        {
            return found.saturating_add(2);
        }
        from = found.saturating_add(1);
    }
    data.len()
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ContentToken<'a> {
    Operand(Object),
    Operator(&'a [u8]),
}

pub(crate) struct ContentLexer<'a> {
    parser: Parser<'a>,
}

impl<'a> ContentLexer<'a> {
    pub(crate) const fn new(data: &'a [u8]) -> Self {
        Self {
            parser: Parser::new(data, 0, CONTENT_NESTING, false),
        }
    }
}

impl<'a> Iterator for ContentLexer<'a> {
    type Item = Outcome<ContentToken<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        let parser = &mut self.parser;
        parser.skip_whitespace();
        let byte = parser.peek()?;
        let token = match byte {
            b'0'..=b'9' | b'+' | b'-' | b'.' => ContentToken::Operand(parser.number()),
            b'/' => ContentToken::Operand(Object::Name(parser.name())),
            b'(' => ContentToken::Operand(Object::String(parser.literal_string())),
            b'<' | b'[' => match parser.value(0) {
                Ok(object) => ContentToken::Operand(object),
                Err(reject) => return Some(Err(reject.into_failure())),
            },
            b')' | b']' | b'>' | b'{' | b'}' | b'%' => {
                let start = parser.pos;
                parser.pos = parser.pos.saturating_add(1);
                ContentToken::Operator(parser.slice(start, parser.pos))
            }
            _ => {
                let run = parser.regular_run();
                match run {
                    b"true" => ContentToken::Operand(Object::Bool(true)),
                    b"false" => ContentToken::Operand(Object::Bool(false)),
                    b"null" => ContentToken::Operand(Object::Null),
                    b"BI" => return Some(parser.inline_image()),
                    _ => ContentToken::Operator(run),
                }
            }
        };
        Some(Ok(token))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct IndirectObject {
    pub obj_ref: ObjRef,
    pub object: Object,
    pub end: usize,
}

pub(crate) fn parse_object_header(data: &[u8], offset: usize) -> Option<(ObjRef, usize)> {
    let mut pos = skip_whitespace_at(data, offset);
    let number = read_unsigned(data, &mut pos)?;
    let gap = pos;
    pos = skip_whitespace_at(data, pos);
    if pos == gap {
        return None;
    }
    let generation = read_unsigned(data, &mut pos)?;
    let gap = pos;
    pos = skip_whitespace_at(data, pos);
    if pos == gap || !keyword_at(data, pos, b"obj") {
        return None;
    }
    let reference = ObjRef {
        number: u32::try_from(number).ok()?,
        generation: u16::try_from(generation).unwrap_or(u16::MAX),
    };
    Some((reference, pos.saturating_add(3)))
}

fn stream_start(data: &[u8], keyword_end: usize) -> usize {
    let mut probe = keyword_end;
    while matches!(data.get(probe), Some(b' ' | b'\t')) {
        probe = probe.saturating_add(1);
    }
    match data.get(probe) {
        Some(b'\r') => {
            let next = probe.saturating_add(1);
            if data.get(next) == Some(&b'\n') {
                next.saturating_add(1)
            } else {
                next
            }
        }
        Some(b'\n') => probe.saturating_add(1),
        _ => keyword_end,
    }
}

fn trim_stream_end(data: &[u8], start: usize, end: usize) -> usize {
    let mut end = end;
    if end > start && data.get(end.saturating_sub(1)) == Some(&b'\n') {
        end = end.saturating_sub(1);
        if end > start && data.get(end.saturating_sub(1)) == Some(&b'\r') {
            end = end.saturating_sub(1);
        }
    } else if end > start && data.get(end.saturating_sub(1)) == Some(&b'\r') {
        end = end.saturating_sub(1);
    }
    end
}

fn end_marker_follows(data: &[u8], pos: usize) -> bool {
    let mut cursor = pos;
    while data.get(cursor).copied().is_some_and(is_whitespace) {
        cursor = cursor.saturating_add(1);
    }
    keyword_at(data, cursor, b"endstream") || keyword_at(data, cursor, b"endobj")
}

fn stream_range(data: &[u8], start: usize, declared: Option<usize>) -> Range<usize> {
    let declared_end = declared
        .and_then(|length| start.checked_add(length))
        .filter(|&end| end <= data.len());
    if let Some(end) = declared_end
        && end_marker_follows(data, end)
    {
        return start..end;
    }
    if let Some(marker) = find_bytes(data, start, b"endstream") {
        return start..trim_stream_end(data, start, marker);
    }
    if let Some(end) = declared_end {
        return start..end;
    }
    let end = find_bytes(data, start, b"endobj").unwrap_or(data.len());
    start..trim_stream_end(data, start, end)
}

fn object_tail(data: &[u8], from: usize) -> usize {
    let mut pos = skip_whitespace_at(data, from);
    if keyword_at(data, pos, b"endstream") {
        pos = skip_whitespace_at(data, pos.saturating_add(9));
    }
    if keyword_at(data, pos, b"endobj") {
        pos = pos.saturating_add(6);
    }
    pos
}

pub(crate) fn parse_indirect_object(
    data: &[u8],
    offset: usize,
    max_depth: usize,
    resolve_length: impl Fn(ObjRef) -> Option<i64>,
) -> Outcome<IndirectObject> {
    let (obj_ref, body) = parse_object_header(data, offset)
        .ok_or_else(|| Failure::invalid("missing object header"))?;
    let mut parser = Parser::new(data, body, max_depth, true);
    parser.skip_whitespace();
    let object = if parser.keyword_here(b"endobj") {
        Object::Null
    } else {
        parser.parse_object()?
    };
    let after = parser.position();
    let keyword = skip_whitespace_at(data, after);
    let has_stream = matches!(object, Object::Dict(_)) && keyword_at(data, keyword, b"stream");
    match object {
        Object::Dict(dict) if has_stream => {
            let declared = match dict.get(b"Length") {
                Some(Object::Integer(length)) => usize::try_from(*length).ok(),
                Some(Object::Ref(reference)) => {
                    resolve_length(*reference).and_then(|length| usize::try_from(length).ok())
                }
                _ => None,
            };
            let start = stream_start(data, keyword.saturating_add(6));
            let range = stream_range(data, start, declared);
            let end = object_tail(data, range.end);
            Ok(IndirectObject {
                obj_ref,
                object: Object::Stream(Stream { dict, data: range }),
                end,
            })
        }
        other => Ok(IndirectObject {
            obj_ref,
            object: other,
            end: object_tail(data, after),
        }),
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    fn parse(input: &[u8]) -> Object {
        Parser::new(input, 0, 64, true)
            .parse_object()
            .unwrap_or(Object::Null)
    }

    fn name(value: &str) -> Object {
        Object::Name(value.as_bytes().to_vec())
    }

    fn no_length(_: ObjRef) -> Option<i64> {
        None
    }

    #[test]
    fn parses_numbers() {
        assert_eq!(parse(b"42"), Object::Integer(42));
        assert_eq!(parse(b"+3"), Object::Integer(3));
        assert_eq!(parse(b"-17"), Object::Integer(-17));
        assert_eq!(parse(b"--5"), Object::Integer(-5));
        assert_eq!(parse(b"-"), Object::Integer(0));
        assert_eq!(parse(b"-.5"), Object::Real(-0.5));
        assert_eq!(parse(b"5."), Object::Real(5.0));
        assert_eq!(parse(b"3.25"), Object::Real(3.25));
        assert_eq!(parse(b"0.000001"), Object::Real(0.000001));
        assert_eq!(parse(b"612.0"), Object::Real(612.0));
    }

    #[test]
    fn saturates_integer_overflow() {
        let huge = parse(b"99999999999999999999999999");
        assert!(matches!(huge, Object::Real(value) if value > 1e18));
        assert_eq!(parse(b"9223372036854775807"), Object::Integer(i64::MAX));
    }

    #[test]
    fn parses_names_with_escapes() {
        assert_eq!(parse(b"/Type"), name("Type"));
        assert_eq!(parse(b"/A#20B"), name("A B"));
        assert_eq!(parse(b"/A#2"), name("A#2"));
        assert_eq!(parse(b"/A#zzB"), name("A#zzB"));
        assert_eq!(parse(b"/"), name(""));
        assert_eq!(parse(b"/Name/Other"), name("Name"));
    }

    #[test]
    fn parses_literal_string_escapes() {
        assert_eq!(parse(b"(abc)"), Object::String(b"abc".to_vec()));
        assert_eq!(parse(b"(a(b)c)"), Object::String(b"a(b)c".to_vec()));
        assert_eq!(parse(b"(a\\(b)"), Object::String(b"a(b".to_vec()));
        assert_eq!(
            parse(b"(\\n\\r\\t\\b\\f\\\\)"),
            Object::String(vec![10, 13, 9, 8, 12, b'\\'])
        );
        assert_eq!(
            parse(b"(\\101\\60\\7)"),
            Object::String(vec![b'A', b'0', 7])
        );
        assert_eq!(parse(b"(\\1015)"), Object::String(b"A5".to_vec()));
        assert_eq!(parse(b"(\\400)"), Object::String(vec![0]));
        assert_eq!(parse(b"(a\\\nb)"), Object::String(b"ab".to_vec()));
        assert_eq!(parse(b"(a\\\r\nb)"), Object::String(b"ab".to_vec()));
        assert_eq!(parse(b"(a\\\rb)"), Object::String(b"ab".to_vec()));
        assert_eq!(
            parse(b"(a\r\nb\rc\nd)"),
            Object::String(b"a\nb\nc\nd".to_vec())
        );
        assert_eq!(parse(b"(\\q)"), Object::String(b"q".to_vec()));
        assert_eq!(
            parse(b"(unterminated"),
            Object::String(b"unterminated".to_vec())
        );
    }

    #[test]
    fn parses_hex_strings() {
        assert_eq!(parse(b"<48656C6C6F>"), Object::String(b"Hello".to_vec()));
        assert_eq!(
            parse(b"<48 65\n6c 6C 6f>"),
            Object::String(b"Hello".to_vec())
        );
        assert_eq!(parse(b"<901FA>"), Object::String(vec![0x90, 0x1f, 0xa0]));
        assert_eq!(parse(b"<>"), Object::String(Vec::new()));
    }

    #[test]
    fn parses_references_and_containers() {
        assert_eq!(
            parse(b"12 0 R"),
            Object::Ref(ObjRef {
                number: 12,
                generation: 0
            })
        );
        let array = parse(b"[1 2 3 R 4]");
        assert_eq!(
            array,
            Object::Array(vec![
                Object::Integer(1),
                Object::Ref(ObjRef {
                    number: 2,
                    generation: 3
                }),
                Object::Integer(4)
            ])
        );
    }

    #[test]
    fn reference_lookahead_does_not_misread_plain_numbers() {
        assert_eq!(
            parse(b"[1 2 3]"),
            Object::Array(vec![
                Object::Integer(1),
                Object::Integer(2),
                Object::Integer(3)
            ])
        );
        assert_eq!(
            parse(b"[1 0 Rx 5]"),
            Object::Array(vec![
                Object::Integer(1),
                Object::Integer(0),
                Object::Integer(5)
            ])
        );
        assert_eq!(
            parse(b"[-1 0 R]"),
            Object::Array(vec![Object::Integer(-1), Object::Integer(0)])
        );
    }

    #[test]
    fn parses_dictionaries_leniently() {
        let object = parse(b"<< /Type /Page /Count 3 /Kids [1 0 R 2 0 R] /Flag true /N null >>");
        let Some(dict) = object.as_dict() else {
            panic!("not a dict");
        };
        assert_eq!(dict.get(b"Type"), Some(&name("Page")));
        assert_eq!(dict.get(b"Count"), Some(&Object::Integer(3)));
        assert_eq!(dict.get(b"Flag"), Some(&Object::Bool(true)));
        assert_eq!(dict.get(b"N"), Some(&Object::Null));
        assert_eq!(
            dict.get(b"Kids")
                .and_then(Object::as_array)
                .map(<[Object]>::len),
            Some(2)
        );

        let broken = parse(b"<< /A 1 garbage /B /C /D >> ");
        let Some(dict) = broken.as_dict() else {
            panic!("not a dict");
        };
        assert_eq!(dict.get(b"A"), Some(&Object::Integer(1)));
        assert_eq!(dict.get(b"B"), Some(&name("C")));
        assert_eq!(dict.get(b"D"), None);

        let odd = parse(b"<< 5 /A 1 ) /B 2 >>");
        let Some(dict) = odd.as_dict() else {
            panic!("not a dict");
        };
        assert_eq!(dict.get(b"A"), Some(&Object::Integer(1)));
        assert_eq!(dict.get(b"B"), Some(&Object::Integer(2)));
    }

    #[test]
    fn dictionary_stops_at_object_terminators() {
        let object = parse(b"<< /A 1 /B endobj");
        let Some(dict) = object.as_dict() else {
            panic!("not a dict");
        };
        assert_eq!(dict.get(b"A"), Some(&Object::Integer(1)));
        assert_eq!(dict.get(b"B"), None);
    }

    #[test]
    fn skips_comments() {
        assert_eq!(parse(b"% comment\n 7"), Object::Integer(7));
        let object = parse(b"<< /A % x\n 1 >>");
        assert_eq!(
            object.as_dict().and_then(|d| d.get(b"A")),
            Some(&Object::Integer(1))
        );
    }

    #[test]
    fn nesting_limit_fails_hard() {
        let deep = vec![b'['; 200];
        let result = Parser::new(&deep, 0, 64, true).parse_object();
        assert_eq!(
            result.map_err(|f| f.code),
            Err(crate::failure::FailureCode::LimitExceeded)
        );
        let nested = b"[[[[1]]]]";
        assert!(Parser::new(nested, 0, 64, true).parse_object().is_ok());
        let shallow = Parser::new(nested, 0, 3, true).parse_object();
        assert_eq!(
            shallow.map_err(|f| f.code),
            Err(crate::failure::FailureCode::LimitExceeded)
        );
    }

    #[test]
    fn garbage_never_hangs() {
        for input in [&b")))))"[..], b">>>>", b"}{}{", b"%", b"", b"   "] {
            let _ = Parser::new(input, 0, 8, true).parse_object();
        }
    }

    #[test]
    fn parses_indirect_object() {
        let data = b"7 0 obj\n<< /A 1 >>\nendobj\n";
        let Ok(parsed) = parse_indirect_object(data, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(
            parsed.obj_ref,
            ObjRef {
                number: 7,
                generation: 0
            }
        );
        assert_eq!(parsed.end, data.len() - 1);
        assert!(matches!(parsed.object, Object::Dict(_)));

        let compact = b"3 2 obj<</A 1>>endobj";
        let Ok(parsed) = parse_indirect_object(compact, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(
            parsed.obj_ref,
            ObjRef {
                number: 3,
                generation: 2
            }
        );
        assert_eq!(parsed.end, compact.len());

        let empty = b"4 0 obj endobj";
        let Ok(parsed) = parse_indirect_object(empty, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(parsed.object, Object::Null);
    }

    #[test]
    fn rejects_missing_header() {
        assert!(parse_indirect_object(b"hello", 0, 64, no_length).is_err());
        assert!(parse_indirect_object(b"1 0 objx", 0, 64, no_length).is_err());
        assert!(parse_indirect_object(b"10obj", 0, 64, no_length).is_err());
    }

    fn stream_bytes<'a>(data: &'a [u8], parsed: &IndirectObject) -> &'a [u8] {
        match &parsed.object {
            Object::Stream(stream) => data.get(stream.data.clone()).unwrap_or_default(),
            _ => &[],
        }
    }

    #[test]
    fn stream_with_correct_length() {
        let data = b"1 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n";
        let Ok(parsed) = parse_indirect_object(data, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(data, &parsed), b"hello");
        assert_eq!(parsed.end, data.len() - 1);
    }

    #[test]
    fn stream_with_crlf_and_cr_only() {
        let crlf = b"1 0 obj\r\n<< /Length 5 >>\r\nstream\r\nhello\r\nendstream\r\nendobj";
        let Ok(parsed) = parse_indirect_object(crlf, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(crlf, &parsed), b"hello");
        let cr = b"1 0 obj << /Length 5 >> stream\rhello\rendstream endobj";
        let Ok(parsed) = parse_indirect_object(cr, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(cr, &parsed), b"hello");
        let spaced = b"1 0 obj << /Length 5 >> stream  \nhello\nendstream endobj";
        let Ok(parsed) = parse_indirect_object(spaced, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(spaced, &parsed), b"hello");
    }

    #[test]
    fn stream_with_wrong_length_scans_for_endstream() {
        let short = b"1 0 obj\n<< /Length 2 >>\nstream\nhello\nendstream\nendobj\n";
        let Ok(parsed) = parse_indirect_object(short, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(short, &parsed), b"hello");
        let long = b"1 0 obj\n<< /Length 999 >>\nstream\nhello\nendstream\nendobj\n";
        let Ok(parsed) = parse_indirect_object(long, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(long, &parsed), b"hello");
        let missing = b"1 0 obj\n<< >>\nstream\nhello\nendstream\nendobj\n";
        let Ok(parsed) = parse_indirect_object(missing, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(missing, &parsed), b"hello");
    }

    #[test]
    fn stream_with_indirect_length() {
        let data = b"1 0 obj\n<< /Length 9 0 R >>\nstream\nhel\nendstream lo\nendstream\nendobj\n";
        let resolve = |reference: ObjRef| (reference.number == 9).then_some(16);
        let Ok(parsed) = parse_indirect_object(data, 0, 64, resolve) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(data, &parsed), b"hel\nendstream lo");
        let Ok(unresolved) = parse_indirect_object(data, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(data, &unresolved), b"hel");
    }

    #[test]
    fn stream_without_endstream_uses_endobj_or_eof() {
        let data = b"1 0 obj\n<< /Length 99 >>\nstream\nhello\nendobj\n";
        let Ok(parsed) = parse_indirect_object(data, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(data, &parsed), b"hello");
        let eof = b"1 0 obj\n<< >>\nstream\nhello";
        let Ok(parsed) = parse_indirect_object(eof, 0, 64, no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(eof, &parsed), b"hello");
    }

    fn lex(input: &[u8]) -> Vec<ContentToken<'_>> {
        ContentLexer::new(input).filter_map(Result::ok).collect()
    }

    fn op(value: &'static [u8]) -> ContentToken<'static> {
        ContentToken::Operator(value)
    }

    #[test]
    fn content_lexer_basic_text_operators() {
        let tokens = lex(b"BT /F1 12 Tf 72 720 Td (Hello) Tj [(A) -120 (B)] TJ ET");
        assert_eq!(
            tokens,
            vec![
                op(b"BT"),
                ContentToken::Operand(name("F1")),
                ContentToken::Operand(Object::Integer(12)),
                op(b"Tf"),
                ContentToken::Operand(Object::Integer(72)),
                ContentToken::Operand(Object::Integer(720)),
                op(b"Td"),
                ContentToken::Operand(Object::String(b"Hello".to_vec())),
                op(b"Tj"),
                ContentToken::Operand(Object::Array(vec![
                    Object::String(b"A".to_vec()),
                    Object::Integer(-120),
                    Object::String(b"B".to_vec())
                ])),
                op(b"TJ"),
                op(b"ET"),
            ]
        );
    }

    #[test]
    fn content_lexer_handles_tight_syntax_and_quotes() {
        let tokens = lex(b"BT/F1 1 Tf(A)'(B)\" 1 0 0 1 0 0 Tm<41>Tj");
        assert!(tokens.contains(&op(b"'")));
        assert!(tokens.contains(&op(b"\"")));
        assert!(tokens.contains(&op(b"Tm")));
        assert!(tokens.contains(&ContentToken::Operand(Object::String(b"A".to_vec()))));
    }

    #[test]
    fn content_lexer_does_not_read_references() {
        let tokens = lex(b"1 0 R");
        assert_eq!(
            tokens,
            vec![
                ContentToken::Operand(Object::Integer(1)),
                ContentToken::Operand(Object::Integer(0)),
                op(b"R"),
            ]
        );
    }

    #[test]
    fn content_lexer_marked_content_dictionaries() {
        let tokens = lex(b"/Span <</MCID 0 /ActualText (x)>> BDC EMC");
        assert_eq!(tokens.len(), 4);
        assert!(matches!(
            tokens.get(1),
            Some(ContentToken::Operand(Object::Dict(_)))
        ));
        assert_eq!(tokens.get(2), Some(&op(b"BDC")));
    }

    #[test]
    fn content_lexer_skips_inline_image() {
        let mut data = b"q BI /W 2 /H 2 /BPC 8 /CS /G ID ".to_vec();
        data.extend_from_slice(&[0x45, 0x49, 0x20, 0x00, 0xff, 0x01]);
        data.extend_from_slice(b"\nEI Q BT (x) Tj ET");
        let tokens = lex(&data);
        assert_eq!(tokens.first(), Some(&op(b"q")));
        assert_eq!(tokens.get(1), Some(&op(b"EI")));
        assert_eq!(tokens.get(2), Some(&op(b"Q")));
        assert_eq!(
            tokens.iter().filter(|token| **token == op(b"EI")).count(),
            1
        );
        assert!(tokens.contains(&op(b"Tj")));
    }

    #[test]
    fn content_lexer_inline_image_with_length_hint() {
        let mut data = b"BI /W 1 /H 1 /L 8 ID ".to_vec();
        data.extend_from_slice(b"ab EI cd");
        data.extend_from_slice(b"\nEI\nQ");
        let tokens = lex(&data);
        assert_eq!(tokens, vec![op(b"EI"), op(b"Q")]);
    }

    #[test]
    fn content_lexer_inline_image_unterminated() {
        let tokens = lex(b"BI /W 1 ID abcdef");
        assert_eq!(tokens, vec![op(b"EI")]);
    }

    #[test]
    fn content_lexer_recovers_from_garbage() {
        let tokens = lex(b"1 2 ) ] > } { foo 3 bar");
        assert_eq!(
            tokens,
            vec![
                ContentToken::Operand(Object::Integer(1)),
                ContentToken::Operand(Object::Integer(2)),
                op(b")"),
                op(b"]"),
                op(b">"),
                op(b"}"),
                op(b"{"),
                op(b"foo"),
                ContentToken::Operand(Object::Integer(3)),
                op(b"bar"),
            ]
        );
    }

    #[test]
    fn content_lexer_unterminated_array_stops_at_operator() {
        let tokens = lex(b"[(a) 1 Tj (b) Tj");
        assert!(tokens.contains(&op(b"Tj")));
    }

    #[test]
    fn content_lexer_reports_deep_nesting_and_continues() {
        let mut data = vec![b'['; 100];
        data.extend_from_slice(b" 1 Tj");
        let results: Vec<_> = ContentLexer::new(&data).collect();
        assert!(results.iter().any(Result::is_err));
        assert!(
            results
                .iter()
                .any(|item| matches!(item, Ok(token) if *token == op(b"Tj")))
        );
    }

    #[test]
    fn content_lexer_booleans() {
        let tokens = lex(b"true false null");
        assert_eq!(
            tokens,
            vec![
                ContentToken::Operand(Object::Bool(true)),
                ContentToken::Operand(Object::Bool(false)),
                ContentToken::Operand(Object::Null),
            ]
        );
    }

    #[test]
    fn finds_bytes() {
        assert_eq!(find_bytes(b"abcabc", 0, b"bc"), Some(1));
        assert_eq!(find_bytes(b"abcabc", 2, b"bc"), Some(4));
        assert_eq!(find_bytes(b"abc", 0, b"x"), None);
        assert_eq!(find_bytes(b"abc", 9, b"a"), None);
        assert_eq!(find_bytes(b"abc", 0, b""), None);
    }
}
