use crate::num::i64_to_f64;
use crate::num::u64_to_f64;
use alloc::borrow::Cow;
use core::ops::Range;

use crate::failure::{Failure, Outcome};
use crate::object::{Dict, ObjRef, Object, Stream};

const CONTENT_NESTING: usize = 32;
const KEYWORD_PROBE: usize = 16;
const IMAGE_END_PROBE: usize = 10;

const POW10: [f64; 19] = [
    1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16,
    1e17, 1e18,
];

const SPARE_ARRAYS: usize = 8;

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

#[derive(Clone, Copy)]
enum Numeral {
    Integer { plain: bool, value: i64 },
    Real(f64),
}

pub(crate) struct Parser<'data> {
    data: &'data [u8],
    max_depth: usize,
    pos: usize,
    refs: bool,
}

impl<'data> Parser<'data> {
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
        let _: &[u8] = self.regular_run();
        Some(false)
    }

    fn hex_string(&mut self) -> Vec<u8> {
        let start = self.pos.saturating_add(1);
        let rest = self.data.get(start..).unwrap_or_default();
        let length = rest.iter().position(|&byte| byte == b'>');
        let end = start.saturating_add(length.unwrap_or(rest.len()));
        self.pos = if length.is_some() {
            end.saturating_add(1)
        } else {
            end
        };
        let mut out = Vec::new();
        decode_hex(self.slice(start, end), &mut out);
        out
    }

    fn inline_image(&mut self) -> Outcome<InlineImage> {
        let mut length: Option<usize> = None;
        let mut dict = Dict::default();
        loop {
            self.skip_whitespace();
            let Some(byte) = self.peek() else {
                return Ok(InlineImage {
                    dict,
                    data: self.pos..self.pos,
                });
            };
            if self.keyword_here(b"ID") {
                self.pos = self.pos.saturating_add(2);
                break;
            }
            if self.keyword_here(b"EI") {
                self.pos = self.pos.saturating_add(2);
                return Ok(InlineImage {
                    dict,
                    data: self.pos..self.pos,
                });
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
                            length = value.as_integer().and_then(|raw| usize::try_from(raw).ok());
                        }
                        dict.insert(&key, value);
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
        let start = self.pos;
        self.pos = inline_image_end(self.data, self.pos, length);
        let mut end = self.pos.saturating_sub(2).max(start);
        if end > start
            && self
                .data
                .get(end.saturating_sub(1))
                .copied()
                .is_some_and(is_whitespace)
        {
            end = end.saturating_sub(1);
        }
        Ok(InlineImage {
            dict,
            data: start..end,
        })
    }

    fn keyword_here(&self, keyword: &[u8]) -> bool {
        keyword_at(self.data, self.pos, keyword)
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
                            for _ in 0_i32..2_i32 {
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
                out.push((high << 4_i32) | low);
                index = index.saturating_add(3);
            } else {
                out.push(byte);
                index = index.saturating_add(1);
            }
        }
        out
    }

    pub(crate) const fn new(data: &'data [u8], pos: usize, max_depth: usize, refs: bool) -> Self {
        Self {
            data,
            max_depth,
            pos,
            refs,
        }
    }

    fn number(&mut self) -> Object {
        match self.numeral() {
            Numeral::Real(value) => Object::Real(value),
            Numeral::Integer { plain, value } => {
                if self.refs
                    && plain
                    && let Ok(whole) = u64::try_from(value)
                    && let Some((reference, end)) = self.reference(whole)
                {
                    self.pos = end;
                    return reference;
                }
                Object::Integer(value)
            }
        }
    }

    fn numeral(&mut self) -> Numeral {
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
        let start = self.pos;
        let short_end = start.saturating_add(19);
        while self.pos < short_end
            && let Some(byte @ b'0'..=b'9') = self.peek()
        {
            whole = whole.wrapping_mul(10).wrapping_add(u64::from(byte & 0x0f));
            self.pos = self.pos.saturating_add(1);
        }
        while let Some(byte @ b'0'..=b'9') = self.peek() {
            match whole
                .checked_mul(10)
                .and_then(|value| value.checked_add(u64::from(byte & 0x0f)))
            {
                Some(value) => whole = value,
                None => overflow = true,
            }
            self.pos = self.pos.saturating_add(1);
        }
        if self.peek() == Some(b'.') {
            self.pos = self.pos.saturating_add(1);
            let mut fraction: u64 = 0;
            let mut scale = 0_usize;
            while let Some(byte @ b'0'..=b'9') = self.peek() {
                if scale < 18 {
                    fraction = fraction
                        .wrapping_mul(10)
                        .wrapping_add(u64::from(byte & 0x0f));
                    scale = scale.saturating_add(1);
                }
                self.pos = self.pos.saturating_add(1);
            }
            let divisor = POW10.get(scale).copied().unwrap_or(1e18_f64);
            let integral = i64::try_from(whole).map_or_else(|_| u64_to_f64(whole), i64_to_f64);
            let magnitude = integral + i64_to_f64(fraction.cast_signed()) / divisor;
            return Numeral::Real(if negative { -magnitude } else { magnitude });
        }
        if self.pos == start {
            return Numeral::Integer {
                plain: false,
                value: 0,
            };
        }
        if overflow || whole > i64::MAX.cast_unsigned() {
            let magnitude = if overflow {
                f64::MAX
            } else {
                u64_to_f64(whole)
            };
            return Numeral::Real(if negative { -magnitude } else { magnitude });
        }
        let integer = whole.cast_signed();
        Numeral::Integer {
            plain: !signed,
            value: if negative {
                integer.saturating_neg()
            } else {
                integer
            },
        }
    }

    pub(crate) fn parse_object(&mut self) -> Outcome<Object> {
        self.skip_whitespace();
        self.value(0).map_err(Reject::into_failure)
    }

    #[inline]
    fn peek(&self) -> Option<u8> {
        self.data.get(self.pos).copied()
    }

    #[inline]
    fn peek_at(&self, ahead: usize) -> Option<u8> {
        self.data.get(self.pos.saturating_add(ahead)).copied()
    }

    pub(crate) const fn position(&self) -> usize {
        self.pos
    }

    fn reference(&self, number: u64) -> Option<(Object, usize)> {
        let number_u32 = u32::try_from(number).ok()?;
        let data = self.data;
        let mut index = self.pos;
        let number_gap = index;
        while data.get(index).copied().is_some_and(is_whitespace) {
            index = index.saturating_add(1);
        }
        if index == number_gap {
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
        let reference_gap = index;
        while data.get(index).copied().is_some_and(is_whitespace) {
            index = index.saturating_add(1);
        }
        if index == reference_gap || !keyword_at(data, index, b"R") {
            return None;
        }
        let reference = ObjRef {
            number: number_u32,
            generation: u16::try_from(generation).unwrap_or(u16::MAX),
        };
        Some((Object::Ref(reference), index.saturating_add(1)))
    }

    fn regular_run(&mut self) -> &'data [u8] {
        let start = self.pos;
        while let Some(byte) = self.peek() {
            if !is_regular(byte) {
                break;
            }
            self.pos = self.pos.saturating_add(1);
        }
        self.slice(start, self.pos)
    }

    pub(crate) fn skip_whitespace(&mut self) {
        self.pos = skip_whitespace_at(self.data, self.pos);
    }

    fn slice(&self, start: usize, end: usize) -> &'data [u8] {
        self.data.get(start..end).unwrap_or_default()
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
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Operand<'data> {
    Array(Vec<Self>),
    Bool(bool),
    Hex(&'data [u8]),
    Integer(i64),
    Literal(Cow<'data, [u8]>),
    Name(Cow<'data, [u8]>),
    Null,
    Object(Box<Object>),
    Real(f64),
}

impl Operand<'_> {
    pub(crate) const fn as_dict(&self) -> Option<&Dict> {
        if let Self::Object(object) = self {
            object.as_dict()
        } else {
            None
        }
    }

    pub(crate) fn as_name(&self) -> Option<&[u8]> {
        if let Self::Name(name) = self {
            Some(name)
        } else {
            None
        }
    }

    pub(crate) const fn as_number(&self) -> Option<f64> {
        match self {
            Self::Integer(value) => Some(i64_to_f64(*value)),
            Self::Real(value) => Some(*value),
            Self::Bool(_)
            | Self::Null
            | Self::Name(_)
            | Self::Literal(_)
            | Self::Hex(_)
            | Self::Array(_)
            | Self::Object(_) => None,
        }
    }

    pub(crate) fn string<'seg>(&'seg self, scratch: &'seg mut Vec<u8>) -> Option<&'seg [u8]> {
        match self {
            Self::Literal(bytes) => Some(bytes),
            Self::Hex(raw) => {
                scratch.clear();
                decode_hex(raw, scratch);
                Some(scratch)
            }
            Self::Integer(_)
            | Self::Real(_)
            | Self::Bool(_)
            | Self::Null
            | Self::Name(_)
            | Self::Array(_)
            | Self::Object(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct InlineImage {
    pub data: Range<usize>,
    pub dict: Dict,
}

pub(crate) struct ContentLexer<'data> {
    inline: Option<InlineImage>,
    parser: Parser<'data>,
    spare: Vec<Vec<Operand<'data>>>,
}

impl<'data> ContentLexer<'data> {
    fn hex(&mut self) -> &'data [u8] {
        let parser = &mut self.parser;
        let start = parser.pos.saturating_add(1);
        let rest = parser.data.get(start..).unwrap_or_default();
        let length = rest.iter().position(|&byte| byte == b'>');
        let end = start.saturating_add(length.unwrap_or(rest.len()));
        parser.pos = if length.is_some() {
            end.saturating_add(1)
        } else {
            end
        };
        parser.slice(start, end)
    }

    fn make_room(&mut self, operands: &mut Vec<Operand<'data>>, limit: usize) {
        if operands.len() >= limit {
            self.release(operands);
        }
    }

    pub(crate) const fn new(data: &'data [u8]) -> Self {
        Self {
            inline: None,
            parser: Parser::new(data, 0, CONTENT_NESTING, false),
            spare: Vec::new(),
        }
    }

    pub(crate) fn operator(
        &mut self,
        operands: &mut Vec<Operand<'data>>,
        limit: usize,
    ) -> Option<Outcome<&'data [u8]>> {
        self.release(operands);
        loop {
            self.parser.skip_whitespace();
            let byte = self.parser.peek()?;
            match byte {
                b'0'..=b'9' | b'+' | b'-' | b'.' => {
                    let operand = match self.parser.numeral() {
                        Numeral::Real(value) => Operand::Real(value),
                        Numeral::Integer { value, .. } => Operand::Integer(value),
                    };
                    self.make_room(operands, limit);
                    operands.push(operand);
                }
                b'/' => {
                    self.make_room(operands, limit);
                    self.push_name(operands);
                }
                b'(' => {
                    self.make_room(operands, limit);
                    self.push_literal(operands);
                }
                b'<' | b'[' => {
                    self.make_room(operands, limit);
                    if let Err(reject) = self.push_value(byte, operands, 0) {
                        return Some(Err(reject.into_failure()));
                    }
                }
                b')' | b']' | b'>' | b'{' | b'}' | b'%' => {
                    let parser = &mut self.parser;
                    let start = parser.pos;
                    parser.pos = parser.pos.saturating_add(1);
                    return Some(Ok(parser.slice(start, parser.pos)));
                }
                _ => {
                    let parser = &mut self.parser;
                    let run = parser.regular_run();
                    let operand = match run {
                        b"true" => Operand::Bool(true),
                        b"false" => Operand::Bool(false),
                        b"null" => Operand::Null,
                        b"BI" => {
                            return Some(parser.inline_image().map(|image| {
                                self.inline = Some(image);
                                &b"EI"[..]
                            }));
                        }
                        _ => return Some(Ok(run)),
                    };
                    self.make_room(operands, limit);
                    operands.push(operand);
                }
            }
        }
    }

    fn push_array(&mut self, out: &mut Vec<Operand<'data>>, depth: usize) -> Parsed<()> {
        if depth >= self.parser.max_depth {
            self.parser.pos = self.parser.pos.saturating_add(1);
            return Err(Reject::TooDeep);
        }
        self.parser.pos = self.parser.pos.saturating_add(1);
        let mut items = self.spare.pop().unwrap_or_default();
        loop {
            self.parser.skip_whitespace();
            let Some(byte) = self.parser.peek() else {
                break;
            };
            if byte == b']' {
                self.parser.pos = self.parser.pos.saturating_add(1);
                break;
            }
            if is_regular(byte) && !is_number_start(byte) {
                match self.parser.garbage_keyword() {
                    Some(true) => break,
                    Some(false) => continue,
                    None => {}
                }
            }
            match self.push_value(byte, &mut items, depth.saturating_add(1)) {
                Ok(()) | Err(Reject::Garbage) => {}
                Err(Reject::TooDeep) => return Err(Reject::TooDeep),
            }
        }
        out.push(Operand::Array(items));
        Ok(())
    }

    fn push_literal(&mut self, out: &mut Vec<Operand<'data>>) {
        let parser = &mut self.parser;
        let start = parser.pos.saturating_add(1);
        let mut end = start;
        while let Some(&byte) = parser.data.get(end) {
            match byte {
                b')' => {
                    parser.pos = end.saturating_add(1);
                    out.push(Operand::Literal(Cow::Borrowed(parser.slice(start, end))));
                    return;
                }
                b'(' | b'\\' | b'\r' => break,
                _ => end = end.saturating_add(1),
            }
        }
        out.push(Operand::Literal(Cow::Owned(parser.literal_string())));
    }

    fn push_name(&mut self, out: &mut Vec<Operand<'data>>) {
        let parser = &mut self.parser;
        let start = parser.pos.saturating_add(1);
        let mut end = start;
        while let Some(&byte) = parser.data.get(end) {
            if !is_regular(byte) {
                break;
            }
            if byte == b'#' {
                out.push(Operand::Name(Cow::Owned(parser.name())));
                return;
            }
            end = end.saturating_add(1);
        }
        parser.pos = end;
        out.push(Operand::Name(Cow::Borrowed(parser.slice(start, end))));
    }

    fn push_value(&mut self, byte: u8, out: &mut Vec<Operand<'data>>, depth: usize) -> Parsed<()> {
        match byte {
            b'0'..=b'9' | b'+' | b'-' | b'.' => match self.parser.numeral() {
                Numeral::Real(value) => out.push(Operand::Real(value)),
                Numeral::Integer { value, .. } => out.push(Operand::Integer(value)),
            },
            b'/' => self.push_name(out),
            b'(' => self.push_literal(out),
            b'<' if self.parser.peek_at(1) == Some(b'<') => {
                let object = self.parser.dictionary(depth)?;
                out.push(Operand::Object(Box::new(object)));
            }
            b'<' => {
                let raw = self.hex();
                out.push(Operand::Hex(raw));
            }
            b'[' => return self.push_array(out, depth),
            b']' | b')' | b'>' | b'{' | b'}' | b'%' => {
                self.parser.pos = self.parser.pos.saturating_add(1);
                return Err(Reject::Garbage);
            }
            _ => match self.parser.regular_run() {
                b"true" => out.push(Operand::Bool(true)),
                b"false" => out.push(Operand::Bool(false)),
                b"null" => out.push(Operand::Null),
                _ => return Err(Reject::Garbage),
            },
        }
        Ok(())
    }

    fn release(&mut self, operands: &mut Vec<Operand<'data>>) {
        while let Some(used) = operands.pop() {
            match used {
                Operand::Array(mut items) => {
                    if self.spare.len() < SPARE_ARRAYS {
                        items.clear();
                        self.spare.push(items);
                    }
                }
                Operand::Literal(text) | Operand::Name(text) => drop(text),
                Operand::Object(object) => drop(object),
                Operand::Bool(_)
                | Operand::Hex(_)
                | Operand::Integer(_)
                | Operand::Null
                | Operand::Real(_) => {}
            }
        }
    }

    pub(crate) fn take_inline_image(&mut self) -> Option<(Dict, &'data [u8])> {
        let image = self.inline.take()?;
        let data = self.parser.data.get(image.data).unwrap_or_default();
        Some((image.dict, data))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct IndirectObject {
    pub end: usize,
    pub obj_ref: ObjRef,
    pub object: Object,
    pub used_declared_length: bool,
}

#[inline]
pub(crate) const fn is_whitespace(byte: u8) -> bool {
    matches!(byte, 0 | 9 | 10 | 12 | 13 | 32)
}

#[inline]
pub(crate) const fn is_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

#[inline]
pub(crate) const fn is_regular(byte: u8) -> bool {
    !is_whitespace(byte) && !is_delimiter(byte)
}

#[inline]
const fn is_number_start(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'+' | b'-' | b'.')
}

pub(crate) const fn hex_value(byte: u8) -> Option<u8> {
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

fn decode_hex(raw: &[u8], out: &mut Vec<u8>) {
    let mut high: Option<u8> = None;
    for &byte in raw {
        if let Some(nibble) = hex_value(byte) {
            match high.take() {
                Some(upper) => out.push((upper << 4_i32) | nibble),
                None => high = Some(nibble),
            }
        }
    }
    if let Some(upper) = high {
        out.push(upper << 4_i32);
    }
}

pub(crate) fn parse_object_header(data: &[u8], offset: usize) -> Option<(ObjRef, usize)> {
    let mut pos = skip_whitespace_at(data, offset);
    let number = read_unsigned(data, &mut pos)?;
    let number_gap = pos;
    pos = skip_whitespace_at(data, pos);
    if pos == number_gap {
        return None;
    }
    let generation = read_unsigned(data, &mut pos)?;
    let generation_gap = pos;
    pos = skip_whitespace_at(data, pos);
    if pos == generation_gap || !keyword_at(data, pos, b"obj") {
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

fn trim_stream_end(data: &[u8], start: usize, mut end: usize) -> usize {
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
    let cursor = skip_whitespace_at(data, pos);
    keyword_at(data, cursor, b"endstream") || keyword_at(data, cursor, b"endobj")
}

fn stream_range(data: &[u8], start: usize, declared: Option<usize>) -> (Range<usize>, bool) {
    let declared_end = declared
        .and_then(|length| start.checked_add(length))
        .filter(|&end| end <= data.len());
    if let Some(end) = declared_end
        && end_marker_follows(data, end)
    {
        return (start..end, true);
    }
    if let Some(marker) = find_bytes(data, start, b"endstream") {
        return (start..trim_stream_end(data, start, marker), false);
    }
    if let Some(end) = declared_end {
        return (start..end, false);
    }
    let end = find_bytes(data, start, b"endobj").unwrap_or(data.len());
    (start..trim_stream_end(data, start, end), false)
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

#[inline(never)]
pub(crate) fn parse_indirect_object(
    data: &[u8],
    offset: usize,
    max_depth: usize,
    resolve_length: &dyn Fn(ObjRef) -> Option<i64>,
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
    if has_stream && let Object::Dict(dict) = object {
        let declared = match dict.get(b"Length") {
            Some(Object::Integer(length)) => usize::try_from(*length).ok(),
            Some(Object::Ref(reference)) => {
                resolve_length(*reference).and_then(|length| usize::try_from(length).ok())
            }
            _ => None,
        };
        let start = stream_start(data, keyword.saturating_add(6));
        let (range, used_declared_length) = stream_range(data, start, declared);
        let end = object_tail(data, range.end);
        return Ok(IndirectObject {
            obj_ref,
            used_declared_length,
            object: Object::Stream(Stream {
                dict,
                data: range,
                decrypted: None,
            }),
            end,
        });
    }
    Ok(IndirectObject {
        obj_ref,
        object,
        used_declared_length: false,
        end: object_tail(data, after),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::FailureCode;
    use core::hint::black_box;
    use core::mem;

    #[derive(Clone, Debug, PartialEq)]
    enum ContentToken<'data> {
        Operand(Operand<'data>),
        Operator(&'data [u8]),
    }

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
        assert_eq!(parse(b"0.000001"), Object::Real(0.000_001));
        assert_eq!(parse(b"612.0"), Object::Real(612.0));
    }

    #[test]
    fn saturates_integer_overflow() {
        let huge = parse(b"99999999999999999999999999");
        assert!(matches!(huge, Object::Real(value) if value > 1e18_f64));
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
        let Some(dict_2) = broken.as_dict() else {
            panic!("not a dict");
        };
        assert_eq!(dict_2.get(b"A"), Some(&Object::Integer(1)));
        assert_eq!(dict_2.get(b"B"), Some(&name("C")));
        assert_eq!(dict_2.get(b"D"), None);

        let odd = parse(b"<< 5 /A 1 ) /B 2 >>");
        let Some(dict_3) = odd.as_dict() else {
            panic!("not a dict");
        };
        assert_eq!(dict_3.get(b"A"), Some(&Object::Integer(1)));
        assert_eq!(dict_3.get(b"B"), Some(&Object::Integer(2)));
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
        assert_eq!(result.map_err(|f| f.code), Err(FailureCode::LimitExceeded));
        let nested = b"[[[[1]]]]";
        drop(Parser::new(nested, 0, 64, true).parse_object().unwrap());
        let shallow = Parser::new(nested, 0, 3, true).parse_object();
        assert_eq!(shallow.map_err(|f| f.code), Err(FailureCode::LimitExceeded));
    }

    #[test]
    fn garbage_never_hangs() {
        for input in [&b")))))"[..], b">>>>", b"}{}{", b"%", b"", b"   "] {
            drop(black_box(Parser::new(input, 0, 8, true).parse_object()));
        }
    }

    #[test]
    fn parses_indirect_object() {
        let data = b"7 0 obj\n<< /A 1 >>\nendobj\n";
        let Ok(parsed) = parse_indirect_object(data, 0, 64, &no_length) else {
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
        let Ok(parsed_2) = parse_indirect_object(compact, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(
            parsed_2.obj_ref,
            ObjRef {
                number: 3,
                generation: 2
            }
        );
        assert_eq!(parsed_2.end, compact.len());

        let empty = b"4 0 obj endobj";
        let Ok(parsed_3) = parse_indirect_object(empty, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(parsed_3.object, Object::Null);
    }

    #[test]
    fn rejects_missing_header() {
        drop(parse_indirect_object(b"hello", 0, 64, &no_length).unwrap_err());
        drop(parse_indirect_object(b"1 0 objx", 0, 64, &no_length).unwrap_err());
        drop(parse_indirect_object(b"10obj", 0, 64, &no_length).unwrap_err());
    }

    fn stream_bytes<'data>(data: &'data [u8], parsed: &IndirectObject) -> &'data [u8] {
        if let Object::Stream(stream) = &parsed.object {
            data.get(stream.data.clone()).unwrap_or_default()
        } else {
            &[]
        }
    }

    #[test]
    fn stream_with_correct_length() {
        let data = b"1 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n";
        let Ok(parsed) = parse_indirect_object(data, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(data, &parsed), b"hello");
        assert_eq!(parsed.end, data.len() - 1);
    }

    #[test]
    fn stream_with_crlf_and_cr_only() {
        let crlf = b"1 0 obj\r\n<< /Length 5 >>\r\nstream\r\nhello\r\nendstream\r\nendobj";
        let Ok(parsed) = parse_indirect_object(crlf, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(crlf, &parsed), b"hello");
        let cr = b"1 0 obj << /Length 5 >> stream\rhello\rendstream endobj";
        let Ok(parsed_4) = parse_indirect_object(cr, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(cr, &parsed_4), b"hello");
        let spaced = b"1 0 obj << /Length 5 >> stream  \nhello\nendstream endobj";
        let Ok(parsed_5) = parse_indirect_object(spaced, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(spaced, &parsed_5), b"hello");
    }

    #[test]
    fn stream_with_wrong_length_scans_for_endstream() {
        let short = b"1 0 obj\n<< /Length 2 >>\nstream\nhello\nendstream\nendobj\n";
        let Ok(parsed) = parse_indirect_object(short, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(short, &parsed), b"hello");
        let long = b"1 0 obj\n<< /Length 999 >>\nstream\nhello\nendstream\nendobj\n";
        let Ok(parsed_6) = parse_indirect_object(long, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(long, &parsed_6), b"hello");
        let missing = b"1 0 obj\n<< >>\nstream\nhello\nendstream\nendobj\n";
        let Ok(parsed_7) = parse_indirect_object(missing, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(missing, &parsed_7), b"hello");
    }

    #[test]
    fn stream_with_indirect_length() {
        let data = b"1 0 obj\n<< /Length 9 0 R >>\nstream\nhel\nendstream lo\nendstream\nendobj\n";
        let resolve = |reference: ObjRef| (reference.number == 9).then_some(16);
        let Ok(parsed) = parse_indirect_object(data, 0, 64, &resolve) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(data, &parsed), b"hel\nendstream lo");
        let Ok(unresolved) = parse_indirect_object(data, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(data, &unresolved), b"hel");
    }

    #[test]
    fn stream_without_endstream_uses_endobj_or_eof() {
        let data = b"1 0 obj\n<< /Length 99 >>\nstream\nhello\nendobj\n";
        let Ok(parsed) = parse_indirect_object(data, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(data, &parsed), b"hello");
        let eof = b"1 0 obj\n<< >>\nstream\nhello";
        let Ok(parsed_8) = parse_indirect_object(eof, 0, 64, &no_length) else {
            panic!("parse failed");
        };
        assert_eq!(stream_bytes(eof, &parsed_8), b"hello");
    }

    fn tokens(input: &[u8]) -> Vec<Outcome<ContentToken<'_>>> {
        let mut lexer = ContentLexer::new(input);
        let mut operands = Vec::new();
        let mut out = Vec::new();
        loop {
            let next = lexer.operator(&mut operands, usize::MAX);
            out.extend(
                mem::take(&mut operands)
                    .into_iter()
                    .map(|operand| Ok(ContentToken::Operand(operand))),
            );
            match next {
                Some(result) => out.push(result.map(ContentToken::Operator)),
                None => return out,
            }
        }
    }

    fn lex(input: &[u8]) -> Vec<ContentToken<'_>> {
        tokens(input).into_iter().filter_map(Result::ok).collect()
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
                ContentToken::Operand(Operand::Name(Cow::Borrowed(b"F1"))),
                ContentToken::Operand(Operand::Integer(12)),
                op(b"Tf"),
                ContentToken::Operand(Operand::Integer(72)),
                ContentToken::Operand(Operand::Integer(720)),
                op(b"Td"),
                ContentToken::Operand(Operand::Literal(Cow::Borrowed(b"Hello"))),
                op(b"Tj"),
                ContentToken::Operand(Operand::Array(vec![
                    Operand::Literal(Cow::Borrowed(b"A")),
                    Operand::Integer(-120),
                    Operand::Literal(Cow::Borrowed(b"B"))
                ])),
                op(b"TJ"),
                op(b"ET"),
            ]
        );
    }

    #[test]
    fn content_lexer_borrows_plain_operands_and_owns_escaped_ones() {
        let tokens = lex(b"/A#20B /Plain (esc\\)aped) (nest(ed)) (plain) <48 65 6>");
        assert_eq!(
            tokens,
            vec![
                ContentToken::Operand(Operand::Name(Cow::Owned(b"A B".to_vec()))),
                ContentToken::Operand(Operand::Name(Cow::Borrowed(b"Plain"))),
                ContentToken::Operand(Operand::Literal(Cow::Owned(b"esc)aped".to_vec()))),
                ContentToken::Operand(Operand::Literal(Cow::Owned(b"nest(ed)".to_vec()))),
                ContentToken::Operand(Operand::Literal(Cow::Borrowed(b"plain"))),
                ContentToken::Operand(Operand::Hex(b"48 65 6")),
            ]
        );
        let mut scratch = Vec::new();
        let Some(ContentToken::Operand(hex)) = tokens.last() else {
            panic!("hex operand expected");
        };
        assert_eq!(hex.string(&mut scratch), Some(&b"He`"[..]));
        assert_eq!(
            lex(b"<41"),
            vec![ContentToken::Operand(Operand::Hex(b"41"))]
        );
    }

    #[test]
    fn content_lexer_recycles_array_buffers() {
        let data = b"[(a) 1] TJ [(b)] TJ";
        let mut lexer = ContentLexer::new(data);
        let mut operands = Vec::new();
        assert_eq!(
            lexer.operator(&mut operands, usize::MAX),
            Some(Ok(&b"TJ"[..]))
        );
        let Some(Operand::Array(items)) = operands.first() else {
            panic!("array expected, got {operands:?}");
        };
        let capacity = items.capacity();
        assert_eq!(
            lexer.operator(&mut operands, usize::MAX),
            Some(Ok(&b"TJ"[..]))
        );
        let Some(Operand::Array(second)) = operands.first() else {
            panic!("array expected, got {operands:?}");
        };
        assert_eq!(second.capacity(), capacity);
        assert_eq!(second, &vec![Operand::Literal(Cow::Borrowed(b"b"))]);
    }

    #[test]
    fn content_lexer_clears_operands_past_the_limit() {
        let mut lexer = ContentLexer::new(b"1 2 3 4 5 Td");
        let mut operands = Vec::new();
        assert_eq!(lexer.operator(&mut operands, 2), Some(Ok(&b"Td"[..])));
        assert_eq!(operands, vec![Operand::Integer(5)]);
    }

    #[test]
    fn content_lexer_handles_tight_syntax_and_quotes() {
        let tokens = lex(b"BT/F1 1 Tf(A)'(B)\" 1 0 0 1 0 0 Tm<41>Tj");
        assert!(tokens.contains(&op(b"'")));
        assert!(tokens.contains(&op(b"\"")));
        assert!(tokens.contains(&op(b"Tm")));
        assert!(
            tokens.contains(&ContentToken::Operand(Operand::Literal(Cow::Borrowed(
                b"A"
            ))))
        );
    }

    #[test]
    fn content_lexer_does_not_read_references() {
        let tokens = lex(b"1 0 R");
        assert_eq!(
            tokens,
            vec![
                ContentToken::Operand(Operand::Integer(1)),
                ContentToken::Operand(Operand::Integer(0)),
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
            Some(ContentToken::Operand(Operand::Object(object))) if matches!(**object, Object::Dict(_))
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
                ContentToken::Operand(Operand::Integer(1)),
                ContentToken::Operand(Operand::Integer(2)),
                op(b")"),
                op(b"]"),
                op(b">"),
                op(b"}"),
                op(b"{"),
                op(b"foo"),
                ContentToken::Operand(Operand::Integer(3)),
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
        let results = tokens(&data);
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
                ContentToken::Operand(Operand::Bool(true)),
                ContentToken::Operand(Operand::Bool(false)),
                ContentToken::Operand(Operand::Null),
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

#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    #[kani::unwind(8)]
    fn unsigned_numbers_read_every_leading_digit() {
        let bytes: [u8; 6] = kani::any();
        let start: usize = kani::any();
        kani::assume(start <= bytes.len());
        let mut pos = start;
        let parsed = read_unsigned(&bytes, &mut pos);
        let mut end = start;
        let mut expected = 0_u64;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            expected = expected * 10 + u64::from(bytes[end] - b'0');
            end += 1;
        }
        if end == start {
            assert!(parsed.is_none());
            assert_eq!(pos, start);
        } else {
            assert_eq!(parsed, Some(expected));
            assert_eq!(pos, end);
        }
    }

    #[kani::proof]
    #[kani::unwind(9)]
    fn find_bytes_returns_the_first_match_at_or_after_the_start() {
        let data: [u8; 7] = kani::any();
        let needle: [u8; 2] = kani::any();
        let from: usize = kani::any();
        kani::assume(from <= data.len() + 1);
        let found = find_bytes(&data, from, &needle);
        let mut expected = None;
        let mut at = from;
        while at + needle.len() <= data.len() {
            if data[at] == needle[0] && data[at + 1] == needle[1] {
                expected = Some(at);
                break;
            }
            at += 1;
        }
        assert_eq!(found, expected);
    }

    #[kani::proof]
    #[kani::unwind(10)]
    fn object_headers_never_panic() {
        let bytes: [u8; 8] = kani::any();
        let offset: usize = kani::any();
        kani::assume(offset <= bytes.len() + 1);
        if let Some((_, end)) = parse_object_header(&bytes, offset) {
            assert!(end <= bytes.len());
        }
        let mut pos: usize = kani::any();
        kani::assume(pos <= bytes.len() + 1);
        let _ = read_unsigned(&bytes, &mut pos);
    }
}
