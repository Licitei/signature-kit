use alloc::rc::Rc;
use core::mem;
use std::collections::{HashMap, HashSet};

use crate::deflate::adler32;
use crate::document::Document;
use crate::filters;
use crate::inflate::inflate;
use crate::inspection::Limits;
use crate::num::{f64_to_i64, u64_to_f64};
use crate::object::{Dict, Object};

const MAX_REVISIONS: usize = 128;
const MAX_SIGNATURE_DICTIONARIES: usize = 1024;
const MAX_INDIRECT_VALUES: usize = 200 * 1000;
const MAX_REVISION_WORK: usize = 200 * 1000;
const MAX_CROSS_REFERENCE_SOURCES: usize = MAX_REVISIONS * 2;
const MAX_TOTAL_ENTRIES: usize = 500 * 1000;
const MAX_XREF_STREAM_BYTES: usize = 16 * 1024 * 1024;
const MAX_XREF_ENTRIES: u64 = 1000 * 1000;
const MAX_OBJECT_STREAM_BYTES: usize = 16 * 1024 * 1024;
const MAX_OBJECT_STREAM_OBJECTS: u64 = 100 * 1000;
const MAX_OBJECT_STREAM_RESOLUTIONS: usize = 10 * 1000;
const MAX_DECOMPRESSED_BYTES: usize = 64 * 1024 * 1024;
const MAX_FIELD_DEPTH: usize = 64;
const MAX_FIELD_NODES: usize = 10 * 1000;
const MAX_NESTING: usize = 512;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const PLACEHOLDER_NAME: &[u8] = b"**********";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Analysis {
    Dictionaries,
    Scan,
    Verification,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reason {
    CrossReferenceStream,
    DictionaryParse,
    IndirectLengths,
    InvalidByteRange,
    LengthBudget,
    ObjectStream,
    RevisionLengths,
    RevisionStructure,
    StreamEnd,
    TraversalBudget,
}

impl From<Reason> for u32 {
    #[inline]
    fn from(reason: Reason) -> Self {
        match reason {
            Reason::StreamEnd => 1,
            Reason::RevisionLengths => 2,
            Reason::IndirectLengths => 3,
            Reason::LengthBudget => 4,
            Reason::DictionaryParse => 5,
            Reason::RevisionStructure => 6,
            Reason::CrossReferenceStream => 7,
            Reason::ObjectStream => 8,
            Reason::TraversalBudget => 9,
            Reason::InvalidByteRange => 10,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each flag is an independent scanner outcome reported over the ABI"
)]
pub(crate) struct ScanFlags {
    pub limit: bool,
    pub parse_failed: bool,
    pub stream_failed: bool,
    pub stream_uncertain: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FieldSpan {
    pub key_start: usize,
    pub value_end: usize,
    pub value_start: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SignatureDictionary {
    pub byte_range: Option<FieldSpan>,
    pub byte_range_values: Option<[f64; 4]>,
    pub contents: Option<FieldSpan>,
    pub generation: u64,
    pub number: u64,
    pub object_start: usize,
    pub timestamp: bool,
    pub unsigned_placeholder: bool,
    pub uses_etsi_cades_detached: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Report {
    pub dictionaries: Vec<SignatureDictionary>,
    pub failure: Option<Reason>,
    pub flags: ScanFlags,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct Key {
    generation: u64,
    number: u64,
}

#[derive(Clone, Debug, PartialEq)]
enum Value {
    Array(Vec<Self>),
    Bool,
    Dict(Vec<Field>),
    Name(Vec<u8>),
    Null,
    Number(f64),
    Ref(Key),
    Text,
}

#[derive(Clone, Debug, PartialEq)]
struct Field {
    key: Vec<u8>,
    key_start: usize,
    value: Value,
    value_end: usize,
    value_start: usize,
}

impl Value {
    fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(items) => Some(items),
            Self::Bool
            | Self::Dict(_)
            | Self::Name(_)
            | Self::Null
            | Self::Number(_)
            | Self::Ref(_)
            | Self::Text => None,
        }
    }

    fn as_dict(&self) -> Option<&[Field]> {
        match self {
            Self::Dict(fields) => Some(fields),
            Self::Array(_)
            | Self::Bool
            | Self::Name(_)
            | Self::Null
            | Self::Number(_)
            | Self::Ref(_)
            | Self::Text => None,
        }
    }

    const fn as_number(&self) -> Option<f64> {
        if let Self::Number(value) = self {
            Some(*value)
        } else {
            None
        }
    }

    fn field(&self, key: &[u8]) -> Option<&Field> {
        self.as_dict()?
            .iter()
            .rev()
            .find(|field| field.key.as_slice() == key)
    }

    fn get(&self, key: &[u8]) -> Option<&Self> {
        self.field(key).map(|field| &field.value)
    }

    fn is_name(&self, expected: &[u8]) -> bool {
        matches!(self, Self::Name(name) if name.as_slice() == expected)
    }

    fn safe_integer(&self) -> Option<i64> {
        self.as_number().and_then(safe_integer)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Numbers,
    Revisions,
    Signatures,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Thrown;

type Parsed<T> = Result<T, Thrown>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Definition {
    key: Key,
    start: usize,
    stream: Option<(usize, usize)>,
    value_start: usize,
}

#[derive(Debug, Default)]
struct NumberIndex {
    entries: Vec<[u64; 4]>,
    failure: Option<usize>,
    first_offsets: Vec<usize>,
    values: Vec<f64>,
}

#[derive(Debug)]
struct RevisionNumbers {
    eof_ends: Vec<usize>,
    index: NumberIndex,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Entry {
    Compressed { index: u64, stream: u64 },
    Free { generation: u64 },
    Uncompressed { generation: u64, offset: u64 },
}

#[derive(Clone, Debug, Default)]
struct Entries(Vec<(u64, Entry)>);

#[derive(Clone, Debug, Default)]
struct KeySet(Vec<Key>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceKind {
    Stream,
    Table,
}

#[derive(Clone, Debug)]
struct Source {
    entries: Entries,
    has_trailer: bool,
    kind: SourceKind,
    offset: usize,
    previous: Option<i64>,
    root: Option<Value>,
    supplemental: Option<i64>,
}

#[derive(Clone, Debug)]
struct XrefStream {
    dict: Value,
    end: usize,
    expected_length: usize,
    ranges: Vec<(u64, u64)>,
    start: usize,
    widths: [usize; 3],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Terminal {
    eof_end: usize,
    xref_offset: u64,
}

#[derive(Debug, Default)]
struct Structure {
    entry_count: usize,
    limit: bool,
    pending_table: Option<usize>,
    sources: Vec<Source>,
    streams: Vec<(usize, XrefStream)>,
    terminals: Vec<Terminal>,
    valid: bool,
}

#[derive(Debug)]
struct Candidates {
    by_revision: Vec<(Terminal, Vec<SignatureDictionary>)>,
    final_terminal: Option<Terminal>,
    invalid: Vec<SignatureDictionary>,
}

#[derive(Debug, Default)]
struct SignatureScan {
    definitions: Vec<Definition>,
    dictionaries: Vec<SignatureDictionary>,
    flags: ScanFlags,
    numbers: HashMap<Key, f64>,
}

#[derive(Clone, Copy, Debug)]
struct Predictor {
    bits: usize,
    colors: usize,
    columns: usize,
    kind: usize,
}

impl Predictor {
    fn row_bytes(self) -> Option<usize> {
        self.colors
            .checked_mul(self.columns)?
            .checked_mul(self.bits)?
            .checked_add(7)?
            .checked_div(8)
            .filter(|bytes| *bytes > 0)
    }
}

struct Scanner<'ctx> {
    current: Option<(Key, usize)>,
    current_stream: Option<(usize, usize)>,
    data: &'ctx [u8],
    dict_depth: usize,
    index: NumberIndex,
    mode: Mode,
    nesting: usize,
    own: HashMap<Key, f64>,
    pos: usize,
    record: bool,
    revisions: Option<&'ctx RevisionNumbers>,
    signatures: SignatureScan,
    structure: Structure,
}

impl<'ctx> Scanner<'ctx> {
    fn array(&mut self) -> Parsed<Value> {
        self.enter()?;
        self.pos = self.pos.saturating_add(1);
        self.skip_ws_comments();
        let mut items = Vec::new();
        while self.peek() != Some(b']') {
            items.push(self.object()?);
            self.skip_ws_comments();
        }
        self.pos = self.pos.saturating_add(1);
        self.nesting = self.nesting.saturating_sub(1);
        Ok(Value::Array(items))
    }

    fn consume_eol(&mut self) -> bool {
        match self.peek() {
            Some(b'\r') => {
                self.pos = self.pos.saturating_add(1);
                if self.peek() == Some(b'\n') {
                    self.pos = self.pos.saturating_add(1);
                }
                true
            }
            Some(b'\n') => {
                self.pos = self.pos.saturating_add(1);
                true
            }
            _ => false,
        }
    }

    fn cross_reference_table(&mut self) -> bool {
        let offset = self.pos;
        if !self.keyword(b"xref") {
            return false;
        }
        self.skip_ws_comments();
        let mut entries: Vec<(u64, Entry)> = Vec::new();
        let mut subsections = 0_usize;
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            let first = self.raw_int();
            self.skip_ws_comments();
            if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                self.structure.valid = false;
                return true;
            }
            let count = self.raw_int();
            self.skip_ws_comments();
            let remaining =
                u64::try_from(self.data.len().saturating_sub(self.pos)).unwrap_or(u64::MAX);
            if first > MAX_SAFE_INTEGER || count > MAX_XREF_ENTRIES || count > remaining {
                self.structure.valid = false;
                self.structure.limit = count > MAX_XREF_ENTRIES;
                return true;
            }
            self.structure.entry_count = self
                .structure
                .entry_count
                .saturating_add(usize::try_from(count).unwrap_or(usize::MAX));
            if self.structure.entry_count > MAX_TOTAL_ENTRIES {
                self.structure.limit = true;
                self.structure.valid = false;
                return true;
            }
            for entry in 0..count {
                if !self.table_entry(first, entry, &mut entries) {
                    self.structure.valid = false;
                    return true;
                }
            }
            subsections = subsections.saturating_add(1);
        }
        if subsections == 0 {
            self.structure.valid = false;
            return true;
        }
        if self.structure.sources.len() >= MAX_CROSS_REFERENCE_SOURCES {
            self.structure.limit = true;
            self.structure.valid = false;
            return true;
        }
        self.insert_source(Source {
            entries: Entries::first_wins(&entries),
            has_trailer: false,
            kind: SourceKind::Table,
            offset,
            previous: None,
            root: None,
            supplemental: None,
        });
        self.structure.pending_table = Some(offset);
        true
    }

    fn dict_or_stream(&mut self) -> Parsed<Value> {
        self.enter()?;
        let depth = self.dict_depth;
        self.dict_depth = self.dict_depth.saturating_add(1);
        self.pos = self.pos.saturating_add(2);
        self.skip_ws_comments();
        let mut fields: Vec<Field> = Vec::new();
        while self.pos < self.data.len()
            && (self.peek() != Some(b'>') || self.peek_at(1) != Some(b'>'))
        {
            let key_start = self.pos;
            let key = self.name()?;
            self.skip_ws_comments();
            let value_start = self.pos;
            let value = self.object()?;
            fields.push(Field {
                key,
                key_start,
                value,
                value_end: self.pos,
                value_start,
            });
            self.skip_ws_comments();
        }
        self.skip_ws_comments();
        if self.peek() != Some(b'>') || self.peek_at(1) != Some(b'>') {
            return Err(Thrown);
        }
        self.pos = self.pos.saturating_add(2);
        self.dict_depth = self.dict_depth.saturating_sub(1);
        self.nesting = self.nesting.saturating_sub(1);
        let dict = Value::Dict(fields);
        if self.mode == Mode::Signatures && depth == 0 && self.record {
            self.record_signature(&dict);
        }
        let before = self.pos;
        self.skip_ws_comments();
        if !self.keyword(b"stream") {
            return Ok(dict);
        }
        match self.mode {
            Mode::Numbers => self.number_stream(dict, before),
            Mode::Revisions => Ok(self.revision_stream(dict)),
            Mode::Signatures => Ok(self.signature_stream(dict)),
        }
    }

    const fn enter(&mut self) -> Parsed<()> {
        self.nesting = self.nesting.saturating_add(1);
        if self.nesting > MAX_NESTING {
            return Err(Thrown);
        }
        Ok(())
    }

    fn header(&mut self) -> Option<Key> {
        if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let number = self.raw_int();
        self.skip_ws_comments();
        if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let generation = self.raw_int();
        self.skip_ws_comments();
        if !self.keyword(b"obj") {
            return None;
        }
        Some(Key { generation, number })
    }

    fn hex_string(&mut self) -> Parsed<Value> {
        let rest = self
            .data
            .get(self.pos.saturating_add(1)..)
            .unwrap_or_default();
        let close = rest.iter().position(|&byte| byte == b'>').ok_or(Thrown)?;
        self.pos = self.pos.saturating_add(close).saturating_add(2);
        Ok(Value::Text)
    }

    fn indirect_length(&self, key: Key) -> Option<f64> {
        if let (Some((_, start)), Some(revisions)) = (self.current, self.revisions) {
            for &eof_end in &revisions.eof_ends {
                if start < eof_end {
                    return revisions.index.lookup(key, eof_end);
                }
            }
        }
        self.own.get(&key).copied()
    }

    fn insert_source(&mut self, source: Source) {
        match self
            .structure
            .sources
            .binary_search_by_key(&source.offset, |found| found.offset)
        {
            Ok(position) => {
                if let Some(slot) = self.structure.sources.get_mut(position) {
                    *slot = source;
                }
            }
            Err(position) => self.structure.sources.insert(position, source),
        }
    }

    fn keyword(&mut self, keyword: &[u8]) -> bool {
        let matched = self
            .data
            .get(self.pos..)
            .is_some_and(|rest| rest.starts_with(keyword));
        if !matched {
            return false;
        }
        let end = self.pos.saturating_add(keyword.len());
        if !self.data.get(end).copied().is_none_or(is_token_boundary) {
            return false;
        }
        self.pos = end;
        true
    }

    fn literal_string(&mut self) -> Parsed<Value> {
        let mut nesting = 0_usize;
        let mut escaped = false;
        while let Some(byte) = self.peek() {
            self.pos = self.pos.saturating_add(1);
            if !escaped {
                if byte == b'(' {
                    nesting = nesting.saturating_add(1);
                }
                if byte == b')' {
                    nesting = nesting.wrapping_sub(1);
                }
            }
            if byte == b'\\' {
                escaped = !escaped;
            } else {
                escaped = false;
            }
            if nesting == 0 {
                return Ok(Value::Text);
            }
        }
        Err(Thrown)
    }

    fn main_loop(&mut self) -> Parsed<()> {
        loop {
            self.skip_ws_comments();
            if self.pos >= self.data.len() {
                return Ok(());
            }
            if self.mode == Mode::Revisions {
                if self.cross_reference_table() || self.trailer()? || self.start_xref() {
                    continue;
                }
            } else {
                if self.keyword(b"trailer") {
                    self.skip_ws_comments();
                    drop(self.object()?);
                    continue;
                }
                if self.keyword(b"startxref") {
                    self.skip_ws_comments();
                    if self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                        let _: u64 = self.raw_int();
                    }
                    continue;
                }
            }
            let start = self.pos;
            let Some(key) = self.header() else {
                self.pos = self.pos.saturating_add(1);
                continue;
            };
            self.object_body(key, start)?;
        }
    }

    fn match_literal(&mut self, literal: &[u8]) -> bool {
        let matched = self
            .data
            .get(self.pos..)
            .is_some_and(|rest| rest.starts_with(literal));
        if matched {
            self.pos = self.pos.saturating_add(literal.len());
        }
        matched
    }

    fn name(&mut self) -> Parsed<Vec<u8>> {
        if self.peek() != Some(b'/') {
            return Err(Thrown);
        }
        self.pos = self.pos.saturating_add(1);
        let start = self.pos;
        while let Some(byte) = self.peek() {
            if is_whitespace(byte) || is_delimiter(byte) {
                break;
            }
            self.pos = self.pos.saturating_add(1);
        }
        let raw = self.data.get(start..self.pos).unwrap_or_default();
        Ok(decode_name(raw))
    }

    fn new(data: &'ctx [u8], mode: Mode, revisions: Option<&'ctx RevisionNumbers>) -> Self {
        Self {
            current: None,
            current_stream: None,
            data,
            dict_depth: 0,
            index: NumberIndex::default(),
            mode,
            nesting: 0,
            own: HashMap::new(),
            pos: 0,
            record: true,
            revisions,
            signatures: SignatureScan::default(),
            structure: Structure {
                valid: true,
                ..Structure::default()
            },
        }
    }

    fn number_or_ref(&mut self) -> Parsed<Value> {
        let first = self.raw_number()?;
        self.skip_ws_comments();
        let lookahead = self.pos;
        if self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            let second = self.raw_number()?;
            self.skip_ws_comments();
            if self.peek() == Some(b'R') {
                self.pos = self.pos.saturating_add(1);
                return Ok(Value::Ref(Key {
                    generation: reference_part(second),
                    number: reference_part(first),
                }));
            }
        }
        self.pos = lookahead;
        Ok(Value::Number(first))
    }

    fn number_stream(&mut self, dict: Value, before: usize) -> Parsed<Value> {
        if !self.consume_eol() {
            self.pos = before;
            return Ok(dict);
        }
        let start = self.pos;
        let declared = dict
            .get(b"Length")
            .and_then(Value::as_number)
            .and_then(|length| stream_end(start, length, self.data.len()));
        if let Some(end) = declared {
            self.pos = end;
            self.skip_ws_comments();
            if self.match_literal(b"endstream") {
                if self.dict_depth == 0 {
                    self.current_stream = Some((start, end));
                }
                return Ok(dict);
            }
        }
        let marker = find(self.data, start, b"endstream").ok_or(Thrown)?;
        if self.dict_depth == 0 {
            self.current_stream = Some((start, marker));
        }
        self.pos = marker.saturating_add(9);
        Ok(dict)
    }

    fn object(&mut self) -> Parsed<Value> {
        self.skip_ws_comments();
        if self.match_literal(b"true") || self.match_literal(b"false") {
            return Ok(Value::Bool);
        }
        if self.match_literal(b"null") {
            return Ok(Value::Null);
        }
        match self.peek() {
            Some(b'<') if self.peek_at(1) == Some(b'<') => self.dict_or_stream(),
            Some(b'<') => self.hex_string(),
            Some(b'(') => self.literal_string(),
            Some(b'/') => self.name().map(Value::Name),
            Some(b'[') => self.array(),
            Some(b'0'..=b'9' | b'.' | b'+' | b'-') => self.number_or_ref(),
            _ => Err(Thrown),
        }
    }

    fn object_body(&mut self, key: Key, start: usize) -> Parsed<()> {
        self.skip_ws_comments();
        let value_start = self.pos;
        self.current = Some((key, start));
        self.current_stream = None;
        self.dict_depth = 0;
        let value = self.object()?;
        let stream = self.current_stream.take();
        self.current = None;
        match self.mode {
            Mode::Signatures => self.record_definition(key, start, value_start, stream, &value),
            Mode::Numbers => self.record_number(key, start, stream, &value)?,
            Mode::Revisions => self.record_revision_object(start, &value),
        }
        self.skip_ws_comments();
        if !self.keyword(b"endobj") && self.mode == Mode::Revisions {
            self.structure.valid = false;
        }
        Ok(())
    }

    fn object_stream_numbers(&mut self, dict: &Value, decoded: &[u8], start: usize) -> Parsed<()> {
        let count = dict.get(b"N").and_then(Value::safe_integer).ok_or(Thrown)?;
        let first = dict
            .get(b"First")
            .and_then(Value::safe_integer)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or(Thrown)?;
        let mut header = Scanner::new(decoded, Mode::Numbers, None);
        let mut members: Vec<(u64, usize)> = Vec::new();
        for _ in 0..count.max(0) {
            header.skip_ws_comments();
            if !header.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                return Err(Thrown);
            }
            let number = header.raw_int();
            header.skip_ws_comments();
            if !header.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                return Err(Thrown);
            }
            let relative = usize::try_from(header.raw_int()).ok().ok_or(Thrown)?;
            members.push((number, relative));
        }
        for (number, relative) in members {
            let mut member = Scanner::new(decoded, Mode::Numbers, None);
            member.pos = first.saturating_add(relative);
            if let Value::Number(value) = member.object()? {
                self.index.push(
                    Key {
                        generation: 0,
                        number,
                    },
                    start,
                    value,
                );
            }
        }
        Ok(())
    }

    fn peek(&self) -> Option<u8> {
        self.data.get(self.pos).copied()
    }

    fn peek_at(&self, ahead: usize) -> Option<u8> {
        self.data.get(self.pos.saturating_add(ahead)).copied()
    }

    fn raw_int(&mut self) -> u64 {
        let mut value = 0_u64;
        while let Some(byte) = self.peek() {
            if !byte.is_ascii_digit() {
                break;
            }
            value = value
                .saturating_mul(10)
                .saturating_add(u64::from(byte.saturating_sub(b'0')));
            self.pos = self.pos.saturating_add(1);
        }
        value
    }

    fn raw_number(&mut self) -> Parsed<f64> {
        let start = self.pos;
        while self
            .peek()
            .is_some_and(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'+' | b'-'))
        {
            self.pos = self.pos.saturating_add(1);
        }
        let lexeme = self.data.get(start..self.pos).unwrap_or_default();
        parse_js_number(lexeme).ok_or(Thrown)
    }

    fn record_definition(
        &mut self,
        key: Key,
        start: usize,
        value_start: usize,
        stream: Option<(usize, usize)>,
        value: &Value,
    ) {
        if self.signatures.definitions.len() >= MAX_INDIRECT_VALUES {
            self.signatures.flags.limit = true;
        } else {
            self.signatures.definitions.push(Definition {
                key,
                start,
                stream,
                value_start,
            });
        }
        if let Value::Number(number) = value {
            if self.own.len() >= MAX_INDIRECT_VALUES {
                self.signatures.flags.limit = true;
            } else {
                let _: Option<f64> = self.own.insert(key, *number);
            }
        }
    }

    fn record_number(
        &mut self,
        key: Key,
        start: usize,
        stream: Option<(usize, usize)>,
        value: &Value,
    ) -> Parsed<()> {
        if let Value::Number(number) = value {
            self.index.push(key, start, *number);
            return Ok(());
        }
        if let Some((data_start, data_end)) = stream
            && value
                .get(b"Type")
                .is_some_and(|kind| kind.is_name(b"ObjStm"))
        {
            let raw = self.data.get(data_start..data_end).unwrap_or_default();
            let decoded = decode_object_stream(value, raw).ok_or(Thrown)?;
            self.object_stream_numbers(value, &decoded, start)?;
        }
        Ok(())
    }

    fn record_revision_object(&mut self, start: usize, value: &Value) {
        if value.as_dict().is_none()
            || !value.get(b"Type").is_some_and(|kind| kind.is_name(b"XRef"))
        {
            return;
        }
        let previous = previous_offset(value);
        if value.get(b"Prev").is_some() && previous.is_none() {
            self.structure.valid = false;
        }
        if !self
            .structure
            .streams
            .iter()
            .any(|(offset, _)| *offset == start)
        {
            self.structure.valid = false;
        }
        if self.structure.sources.len() >= MAX_CROSS_REFERENCE_SOURCES {
            self.structure.limit = true;
            self.structure.valid = false;
            return;
        }
        self.insert_source(Source {
            entries: Entries::default(),
            has_trailer: true,
            kind: SourceKind::Stream,
            offset: start,
            previous,
            root: value.get(b"Root").cloned(),
            supplemental: None,
        });
    }

    fn record_signature(&mut self, dict: &Value) {
        let Some((key, object_start)) = self.current else {
            return;
        };
        let byte_range = dict.field(b"ByteRange");
        let contents = dict.field(b"Contents");
        let kind = dict.get(b"Type");
        let timestamp = match kind {
            Some(value) if value.is_name(b"DocTimeStamp") => true,
            Some(value) if value.is_name(b"Sig") => false,
            None if byte_range.is_some() && contents.is_some() => false,
            _ => return,
        };
        if self.signatures.dictionaries.len() >= MAX_SIGNATURE_DICTIONARIES {
            self.signatures.flags.limit = true;
            return;
        }
        let byte_range_values = byte_range.and_then(|field| byte_range_values(&field.value));
        let unsigned_placeholder = byte_range
            .is_some_and(|field| is_placeholder_array(&field.value))
            && contents.is_some_and(|field| self.zero_contents(field));
        self.signatures.dictionaries.push(SignatureDictionary {
            byte_range: byte_range.map(span),
            byte_range_values,
            contents: contents.map(span),
            generation: key.generation,
            number: key.number,
            object_start,
            timestamp,
            unsigned_placeholder,
            uses_etsi_cades_detached: dict
                .get(b"SubFilter")
                .is_some_and(|value| value.is_name(b"ETSI.CAdES.detached")),
        });
    }

    fn revision_stream(&mut self, dict: Value) -> Value {
        if !self.consume_eol() {
            self.structure.valid = false;
            return dict;
        }
        let start = self.pos;
        let Some(length) = self.stream_length(&dict) else {
            self.structure.valid = false;
            if !self.skip_unknown_stream() {
                self.structure.valid = false;
            }
            return dict;
        };
        let Some(end) = stream_end(start, length, self.data.len()) else {
            self.structure.valid = false;
            self.pos = self.data.len();
            return dict;
        };
        self.pos = end;
        self.skip_ws_comments();
        if !self.keyword(b"endstream") {
            self.structure.valid = false;
            return dict;
        }
        if dict.get(b"Type").is_some_and(|kind| kind.is_name(b"XRef")) {
            let definition = self.current.and_then(|(_, offset)| {
                xref_stream_definition(&dict, start, end).map(|stream| (offset, stream))
            });
            match definition {
                Some((offset, stream)) => {
                    if let Some(slot) = self
                        .structure
                        .streams
                        .iter_mut()
                        .find(|(found, _)| *found == offset)
                    {
                        slot.1 = stream;
                    } else {
                        self.structure.streams.push((offset, stream));
                    }
                }
                None => self.structure.valid = false,
            }
        }
        dict
    }

    fn signature_stream(&mut self, dict: Value) -> Value {
        if !self.consume_eol() {
            self.signatures.flags.stream_failed = true;
            return dict;
        }
        let start = self.pos;
        let Some(length) = self.stream_length(&dict) else {
            self.signatures.flags.stream_uncertain = true;
            if !self.skip_unknown_stream() {
                self.signatures.flags.stream_failed = true;
            }
            return dict;
        };
        let Some(end) = stream_end(start, length, self.data.len()) else {
            self.signatures.flags.stream_failed = true;
            self.pos = self.data.len();
            return dict;
        };
        self.pos = end;
        self.skip_ws_comments();
        if !self.keyword(b"endstream") {
            self.signatures.flags.stream_failed = true;
        } else if self.current.is_some() && self.dict_depth == 0 {
            self.current_stream = Some((start, end));
        }
        dict
    }

    fn skip_unknown_stream(&mut self) -> bool {
        let mut from = self.pos;
        while let Some(found) = find(self.data, from, b"endstream") {
            let previous = found
                .checked_sub(1)
                .and_then(|at| self.data.get(at).copied());
            let after = self.data.get(found.saturating_add(9)).copied();
            if found > 0
                && matches!(previous, Some(b'\n' | b'\r'))
                && after.is_none_or(is_token_boundary)
            {
                self.pos = found.saturating_add(9);
                return true;
            }
            from = found.saturating_add(1);
        }
        self.pos = self.data.len();
        false
    }

    fn skip_whitespace(&mut self) {
        while self.peek().is_some_and(is_whitespace) {
            self.pos = self.pos.saturating_add(1);
        }
    }

    fn skip_ws_comments(&mut self) {
        self.skip_whitespace();
        while self.peek() == Some(b'%') {
            while let Some(byte) = self.peek() {
                if byte == b'\n' || byte == b'\r' {
                    break;
                }
                self.pos = self.pos.saturating_add(1);
            }
            self.skip_whitespace();
        }
    }

    fn start_xref(&mut self) -> bool {
        if !self.keyword(b"startxref") {
            return false;
        }
        self.skip_whitespace();
        if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.structure.valid = false;
            return true;
        }
        let xref_offset = self.raw_int();
        self.skip_whitespace();
        if xref_offset > MAX_SAFE_INTEGER || !self.keyword(b"%%EOF") {
            self.structure.valid = false;
            return true;
        }
        if self.structure.terminals.len() >= MAX_REVISIONS {
            self.structure.limit = true;
            self.structure.valid = false;
            return true;
        }
        self.structure.terminals.push(Terminal {
            eof_end: self.pos,
            xref_offset,
        });
        true
    }

    fn stream_length(&self, dict: &Value) -> Option<f64> {
        match dict.get(b"Length")? {
            Value::Number(length) => Some(*length),
            Value::Ref(key) => self.indirect_length(*key),
            Value::Array(_)
            | Value::Bool
            | Value::Dict(_)
            | Value::Name(_)
            | Value::Null
            | Value::Text => None,
        }
    }

    fn table_entry(&mut self, first: u64, entry: u64, entries: &mut Vec<(u64, Entry)>) -> bool {
        if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            return false;
        }
        let offset = self.raw_int();
        self.skip_ws_comments();
        if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            return false;
        }
        let generation = self.raw_int();
        self.skip_ws_comments();
        let kind = self.peek();
        if !matches!(kind, Some(b'n' | b'f')) || !self.peek_at(1).is_none_or(is_token_boundary) {
            return false;
        }
        let number = first.saturating_add(entry);
        if number > MAX_SAFE_INTEGER || offset > MAX_SAFE_INTEGER || generation > MAX_SAFE_INTEGER {
            return false;
        }
        entries.push((
            number,
            if kind == Some(b'n') {
                Entry::Uncompressed { generation, offset }
            } else {
                Entry::Free { generation }
            },
        ));
        self.pos = self.pos.saturating_add(1);
        self.skip_ws_comments();
        true
    }

    fn trailer(&mut self) -> Parsed<bool> {
        if !self.keyword(b"trailer") {
            return Ok(false);
        }
        self.skip_ws_comments();
        let trailer = self.object()?;
        let pending = self.structure.pending_table;
        let (Some(table), Some(_)) = (pending, trailer.as_dict()) else {
            self.structure.valid = false;
            return Ok(true);
        };
        let previous = previous_offset(&trailer);
        let supplemental = trailer
            .get(b"XRefStm")
            .and_then(Value::safe_integer)
            .filter(|value| *value >= 0);
        let table_offset = i64::try_from(table).unwrap_or(i64::MAX);
        if (trailer.get(b"Prev").is_some() && previous.is_none())
            || (trailer.get(b"XRefStm").is_some() && supplemental.is_none())
            || supplemental.is_some_and(|offset| offset >= table_offset)
        {
            self.structure.valid = false;
        }
        let root = trailer.get(b"Root").cloned();
        let Some(source) = self.structure.source_mut(table) else {
            self.structure.valid = false;
            return Ok(true);
        };
        source.previous = previous;
        source.supplemental = supplemental;
        source.has_trailer = true;
        source.root = root;
        self.structure.pending_table = None;
        Ok(true)
    }

    fn zero_contents(&self, field: &Field) -> bool {
        let start = field.value_start;
        let Some(end) = field.value_end.checked_sub(1) else {
            return false;
        };
        if end <= start || self.data.get(start) != Some(&b'<') || self.data.get(end) != Some(&b'>')
        {
            return false;
        }
        self.data
            .get(start.saturating_add(1)..end)
            .unwrap_or_default()
            .iter()
            .all(|&byte| byte == b'0' || is_whitespace(byte))
    }
}

impl Entries {
    fn first_wins(rows: &[(u64, Entry)]) -> Self {
        let mut order: Vec<[u64; 4]> = rows
            .iter()
            .enumerate()
            .map(|(position, (number, _))| [*number, sequence(position), 0, 0])
            .collect();
        order.sort_unstable();
        order.dedup_by_key(|key| key[0]);
        Self(
            order
                .iter()
                .filter_map(|key| rows.get(usize::try_from(key[1]).ok()?).copied())
                .collect(),
        )
    }

    fn get(&self, number: u64) -> Option<Entry> {
        self.0
            .binary_search_by_key(&number, |(found, _)| *found)
            .ok()
            .and_then(|position| self.0.get(position))
            .map(|(_, entry)| *entry)
    }

    const fn len(&self) -> usize {
        self.0.len()
    }

    fn overlaid(&self, below: &Self) -> Self {
        let mut rows = self.0.clone();
        rows.extend_from_slice(&below.0);
        Self::first_wins(&rows)
    }
}

impl KeySet {
    fn add(&mut self, key: Key) {
        if let Err(position) = self.0.binary_search(&key) {
            self.0.insert(position, key);
        }
    }

    fn contains(&self, key: Key) -> bool {
        self.0.binary_search(&key).is_ok()
    }

    fn insert(&mut self, key: Key) -> bool {
        let fresh = !self.contains(key);
        self.add(key);
        fresh
    }
}

impl NumberIndex {
    fn build(data: &[u8]) -> Self {
        let mut scanner = Scanner::new(data, Mode::Numbers, None);
        if scanner.main_loop().is_err() {
            let failed_at = scanner.current.map_or(scanner.pos, |(_, start)| start);
            scanner.index.failure = Some(failed_at);
        }
        let mut index = scanner.index;
        index.entries.sort_unstable();
        let mut previous: Option<(u64, u64)> = None;
        let mut firsts: Vec<[u64; 4]> = Vec::new();
        for [number, generation, offset, _] in &index.entries {
            if previous != Some((*number, *generation)) {
                firsts.push([*offset, 0, 0, 0]);
                previous = Some((*number, *generation));
            }
        }
        firsts.sort_unstable();
        index.first_offsets = firsts
            .iter()
            .map(|[offset, ..]| usize::try_from(*offset).unwrap_or(usize::MAX))
            .collect();
        index
    }

    fn distinct_before(&self, bound: usize) -> usize {
        self.first_offsets.partition_point(|&offset| offset < bound)
    }

    fn lookup(&self, key: Key, bound: usize) -> Option<f64> {
        let limit = u64::try_from(bound).unwrap_or(u64::MAX);
        let start = self.entries.partition_point(|[number, generation, ..]| {
            (*number, *generation) < (key.number, key.generation)
        });
        self.entries
            .get(start..)?
            .iter()
            .take_while(|[number, generation, ..]| {
                *number == key.number && *generation == key.generation
            })
            .filter(|[_, _, offset, _]| *offset < limit)
            .last()
            .and_then(|[.., position]| self.values.get(usize::try_from(*position).ok()?))
            .copied()
    }

    fn push(&mut self, key: Key, offset: usize, value: f64) {
        let position = sequence(self.values.len());
        self.values.push(value);
        self.entries.push([
            key.number,
            key.generation,
            u64::try_from(offset).unwrap_or(u64::MAX),
            position,
        ]);
    }

    fn snapshot(&self) -> HashMap<Key, f64> {
        self.entries
            .iter()
            .filter_map(|[number, generation, _, position]| {
                let value = self.values.get(usize::try_from(*position).ok()?)?;
                Some((
                    Key {
                        generation: *generation,
                        number: *number,
                    },
                    *value,
                ))
            })
            .collect()
    }
}

impl Structure {
    fn chain_complete(&self, terminal: Terminal) -> bool {
        if !self.valid {
            return false;
        }
        let mut visited: HashSet<usize> = HashSet::new();
        let Ok(mut offset) = usize::try_from(terminal.xref_offset) else {
            return false;
        };
        loop {
            if !visited.insert(offset) {
                return false;
            }
            let Some(source) = self.usable(offset, terminal) else {
                return false;
            };
            let Some(previous) = source.previous else {
                return true;
            };
            let Ok(next) = usize::try_from(previous) else {
                return false;
            };
            offset = next;
        }
    }

    fn effective_entry(&self, terminal: Terminal, key: Key) -> Option<Entry> {
        let mut visited: HashSet<usize> = HashSet::new();
        let mut offset = usize::try_from(terminal.xref_offset).ok()?;
        loop {
            if !visited.insert(offset) {
                return None;
            }
            let source = self.usable(offset, terminal)?;
            if let Some(entry) = source.entries.get(key.number) {
                return match entry {
                    Entry::Uncompressed { generation, .. } if generation == key.generation => {
                        Some(entry)
                    }
                    Entry::Compressed { .. } if key.generation == 0 => Some(entry),
                    Entry::Compressed { .. } | Entry::Free { .. } | Entry::Uncompressed { .. } => {
                        None
                    }
                };
            }
            offset = usize::try_from(source.previous?)
                .ok()
                .filter(|next| *next < source.offset)?;
        }
    }

    fn root(&self, terminal: Terminal) -> Option<Value> {
        let mut visited: HashSet<usize> = HashSet::new();
        let mut offset = usize::try_from(terminal.xref_offset).ok()?;
        loop {
            if !visited.insert(offset) {
                return None;
            }
            let source = self.usable(offset, terminal)?;
            if let Some(root) = &source.root {
                return Some(root.clone());
            }
            offset = usize::try_from(source.previous?)
                .ok()
                .filter(|next| *next < source.offset)?;
        }
    }

    fn source(&self, offset: usize) -> Option<&Source> {
        let position = self
            .sources
            .binary_search_by_key(&offset, |found| found.offset)
            .ok()?;
        self.sources.get(position)
    }

    fn source_mut(&mut self, offset: usize) -> Option<&mut Source> {
        let position = self
            .sources
            .binary_search_by_key(&offset, |found| found.offset)
            .ok()?;
        self.sources.get_mut(position)
    }

    fn terminal_for_range(&self, pdf: &[u8], range_end: usize) -> Option<Terminal> {
        let mut chosen: Option<Terminal> = None;
        for &candidate in &self.terminals {
            if candidate.eof_end > range_end || !self.chain_complete(candidate) {
                continue;
            }
            let whitespace = pdf
                .get(candidate.eof_end..range_end)
                .unwrap_or_default()
                .iter()
                .all(|&byte| is_whitespace(byte));
            if whitespace && chosen.is_none_or(|current| candidate.eof_end > current.eof_end) {
                chosen = Some(candidate);
            }
        }
        chosen
    }

    fn usable(&self, offset: usize, terminal: Terminal) -> Option<&Source> {
        let source = self.source(offset)?;
        if source.offset >= terminal.eof_end
            || (source.kind == SourceKind::Table && !source.has_trailer)
        {
            return None;
        }
        Some(source)
    }
}

struct Resolver<'ctx> {
    budget: &'ctx mut usize,
    cache: Vec<(Key, Rc<Value>)>,
    decoded: Option<(u64, Rc<DecodedObjectStream>)>,
    decompressed: usize,
    definitions: &'ctx [Definition],
    pdf: &'ctx [u8],
    resolutions: usize,
    revisions: Option<&'ctx RevisionNumbers>,
    structure: &'ctx Structure,
    terminal: Terminal,
}

#[derive(Debug)]
struct DecodedObjectStream {
    bytes: Vec<u8>,
    first: usize,
    references: Vec<(u64, usize)>,
}

impl Resolver<'_> {
    fn decode_object_stream(&mut self, number: u64) -> Result<Rc<DecodedObjectStream>, Reason> {
        let key = Key {
            generation: 0,
            number,
        };
        let Some(Entry::Uncompressed { offset, .. }) =
            self.structure.effective_entry(self.terminal, key)
        else {
            return Err(Reason::ObjectStream);
        };
        let definition = usize::try_from(offset)
            .ok()
            .and_then(|at| definition_at(self.definitions, at))
            .ok_or(Reason::ObjectStream)?;
        let (start, end) = definition.stream.ok_or(Reason::ObjectStream)?;
        if definition.key != key
            || end < start
            || end > self.pdf.len()
            || end.saturating_sub(start) > MAX_OBJECT_STREAM_BYTES
        {
            return Err(Reason::ObjectStream);
        }
        let dict = self
            .parse_definition(definition)
            .ok_or(Reason::ObjectStream)?;
        if !dict
            .get(b"Type")
            .is_some_and(|kind| kind.is_name(b"ObjStm"))
        {
            return Err(Reason::ObjectStream);
        }
        let count = dict
            .get(b"N")
            .and_then(Value::safe_integer)
            .and_then(|value| u64::try_from(value).ok())
            .filter(|value| *value <= MAX_OBJECT_STREAM_OBJECTS)
            .ok_or(Reason::ObjectStream)?;
        let first = dict
            .get(b"First")
            .and_then(Value::safe_integer)
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value <= MAX_OBJECT_STREAM_BYTES)
            .ok_or(Reason::ObjectStream)?;
        let filter = dict.get(b"Filter");
        let parms = dict.get(b"DecodeParms");
        let flate = filter.is_some_and(|value| match value {
            Value::Name(_) => value.is_name(b"FlateDecode"),
            Value::Array(items) => {
                matches!(items.as_slice(), [only] if only.is_name(b"FlateDecode"))
            }
            Value::Bool
            | Value::Dict(_)
            | Value::Null
            | Value::Number(_)
            | Value::Ref(_)
            | Value::Text => false,
        });
        if (filter.is_none() && parms.is_some())
            || (filter.is_some() && (!flate || parms.is_some()))
        {
            return Err(Reason::ObjectStream);
        }
        let encoded = self.pdf.get(start..end).unwrap_or_default();
        let bytes = if filter.is_none() {
            encoded.to_vec()
        } else {
            inflate_zlib(encoded, MAX_OBJECT_STREAM_BYTES).ok_or(Reason::ObjectStream)?
        };
        if bytes.len() > MAX_OBJECT_STREAM_BYTES
            || self.decompressed.saturating_add(bytes.len()) > MAX_DECOMPRESSED_BYTES
            || first > bytes.len()
        {
            return Err(Reason::ObjectStream);
        }
        let references =
            object_stream_references(&bytes, first, count).ok_or(Reason::ObjectStream)?;
        self.decompressed = self.decompressed.saturating_add(bytes.len());
        let decoded = Rc::new(DecodedObjectStream {
            bytes,
            first,
            references,
        });
        self.decoded = Some((number, Rc::clone(&decoded)));
        Ok(decoded)
    }

    fn parse_definition(&self, definition: Definition) -> Option<Value> {
        let mut scanner = Scanner::new(self.pdf, Mode::Signatures, self.revisions);
        scanner.record = false;
        scanner.pos = definition.value_start;
        scanner.current = Some((definition.key, definition.start));
        scanner.object().ok()
    }

    fn resolve(&mut self, value: &Value) -> Result<Option<Rc<Value>>, Reason> {
        let Value::Ref(key) = value else {
            return Ok(Some(Rc::new(value.clone())));
        };
        let slot = self.cache.binary_search_by_key(key, |(found, _)| *found);
        if let Ok(position) = slot
            && let Some((_, hit)) = self.cache.get(position)
        {
            return Ok(Some(Rc::clone(hit)));
        }
        let Some(entry) = self.structure.effective_entry(self.terminal, *key) else {
            return Ok(None);
        };
        let resolved = match entry {
            Entry::Free { .. } => return Ok(None),
            Entry::Uncompressed { offset, .. } => {
                let definition = usize::try_from(offset)
                    .ok()
                    .and_then(|at| definition_at(self.definitions, at));
                let Some(found) = definition
                    .filter(|found| found.start < self.terminal.eof_end && found.key == *key)
                else {
                    return Ok(None);
                };
                let Some(parsed) = self.parse_definition(found) else {
                    return Ok(None);
                };
                parsed
            }
            Entry::Compressed { index, stream } => self.resolve_compressed(*key, index, stream)?,
        };
        let shared = Rc::new(resolved);
        if let Err(position) = slot {
            self.cache.insert(position, (*key, Rc::clone(&shared)));
        }
        Ok(Some(shared))
    }

    fn resolve_compressed(&mut self, key: Key, index: u64, stream: u64) -> Result<Value, Reason> {
        if self.resolutions >= MAX_OBJECT_STREAM_RESOLUTIONS {
            return Err(Reason::ObjectStream);
        }
        let decoded = match &self.decoded {
            Some((number, cached)) if *number == stream => Rc::clone(cached),
            _ => self.decode_object_stream(stream)?,
        };
        let position = usize::try_from(index).ok().ok_or(Reason::ObjectStream)?;
        let &(member, relative) = decoded
            .references
            .get(position)
            .ok_or(Reason::ObjectStream)?;
        if member != key.number {
            return Err(Reason::ObjectStream);
        }
        let start = decoded.first.saturating_add(relative);
        let end = decoded
            .references
            .get(position.saturating_add(1))
            .map_or(decoded.bytes.len(), |next| {
                decoded.first.saturating_add(next.1)
            });
        if start < decoded.first || end <= start || end > decoded.bytes.len() {
            return Err(Reason::ObjectStream);
        }
        let slice = decoded.bytes.get(start..end).unwrap_or_default();
        let mut scanner = Scanner::new(slice, Mode::Numbers, None);
        let value = scanner.object().map_err(|Thrown| Reason::ObjectStream)?;
        self.resolutions = self.resolutions.saturating_add(1);
        Ok(value)
    }

    const fn spend(&mut self) -> Result<(), Reason> {
        if *self.budget == 0 {
            return Err(Reason::TraversalBudget);
        }
        *self.budget = self.budget.saturating_sub(1);
        Ok(())
    }
}

struct Reachability<'ctx, 'res> {
    reachable: KeySet,
    resolver: &'res mut Resolver<'ctx>,
    traversed: usize,
    visited: KeySet,
}

impl Reachability<'_, '_> {
    fn inherits_signature(
        &mut self,
        value: Option<&Value>,
        parents: &KeySet,
        depth: usize,
    ) -> Result<bool, Reason> {
        if depth > MAX_FIELD_DEPTH {
            return Err(Reason::TraversalBudget);
        }
        self.resolver.spend()?;
        if let Some(Value::Ref(key)) = value {
            if parents.contains(*key) {
                return Ok(false);
            }
            let Some(field) = self.resolver.resolve(&Value::Ref(*key))? else {
                return Ok(false);
            };
            if field.as_dict().is_none() {
                return Ok(false);
            }
            match field.get(b"FT") {
                Some(kind) if kind.is_name(b"Sig") => return Ok(true),
                Some(_) => return Ok(false),
                None => {}
            }
            let mut next = parents.clone();
            next.add(*key);
            return self.inherits_signature(field.get(b"Parent"), &next, depth.saturating_add(1));
        }
        let Some(dict) = value.filter(|candidate| candidate.as_dict().is_some()) else {
            return Ok(false);
        };
        match dict.get(b"FT") {
            Some(kind) if kind.is_name(b"Sig") => Ok(true),
            Some(_) => Ok(false),
            None => self.inherits_signature(dict.get(b"Parent"), parents, depth.saturating_add(1)),
        }
    }

    fn visit(
        &mut self,
        value: Option<&Value>,
        inherited: bool,
        depth: usize,
    ) -> Result<(), Reason> {
        let Some(found) = value else {
            return Ok(());
        };
        if depth > MAX_FIELD_DEPTH {
            return Err(Reason::TraversalBudget);
        }
        if let Value::Ref(key) = found
            && !self.visited.insert(*key)
        {
            return Ok(());
        }
        self.resolver.spend()?;
        let Some(field) = self.resolver.resolve(found)? else {
            return Ok(());
        };
        if field.as_dict().is_none() {
            return Ok(());
        }
        self.traversed = self.traversed.saturating_add(1);
        if self.traversed > MAX_FIELD_NODES {
            return Err(Reason::TraversalBudget);
        }
        let is_signature = match field.get(b"FT") {
            Some(kind) if kind.is_name(b"Sig") => true,
            Some(_) => false,
            None if inherited => true,
            None => self.inherits_signature(
                field.get(b"Parent"),
                &KeySet::default(),
                depth.saturating_add(1),
            )?,
        };
        if is_signature
            && let Some(Value::Ref(signature)) = field.get(b"V")
            && self.resolver.resolve(&Value::Ref(*signature))?.is_some()
        {
            self.reachable.add(*signature);
        }
        let kids = match field.get(b"Kids") {
            Some(kids) => self.resolver.resolve(kids)?,
            None => None,
        };
        if let Some(items) = kids.as_deref().and_then(Value::as_array) {
            for kid in items {
                self.visit(Some(kid), is_signature, depth.saturating_add(1))?;
            }
        }
        Ok(())
    }
}

pub(crate) fn analyze(pdf: &[u8], analysis: Analysis) -> Report {
    match analysis {
        Analysis::Scan => {
            let mut scanner = Scanner::new(pdf, Mode::Signatures, None);
            let parsed = scanner.main_loop();
            let mut scan = finish_signatures(scanner);
            if parsed.is_err() {
                scan.flags.parse_failed = true;
                scan.dictionaries.clear();
            }
            Report {
                dictionaries: scan.dictionaries,
                failure: None,
                flags: scan.flags,
            }
        }
        Analysis::Dictionaries => match dictionary_scan(pdf) {
            Ok((scan, _)) if scan.flags.stream_failed || scan.flags.stream_uncertain => Report {
                dictionaries: Vec::new(),
                failure: Some(Reason::StreamEnd),
                flags: scan.flags,
            },
            Ok((scan, _)) => Report {
                dictionaries: scan.dictionaries,
                failure: None,
                flags: scan.flags,
            },
            Err(reason) => Report {
                dictionaries: Vec::new(),
                failure: Some(reason),
                flags: ScanFlags::default(),
            },
        },
        Analysis::Verification => match verification(pdf) {
            Ok(dictionaries) => Report {
                dictionaries,
                failure: None,
                flags: ScanFlags::default(),
            },
            Err(reason) => Report {
                dictionaries: Vec::new(),
                failure: Some(reason),
                flags: ScanFlags::default(),
            },
        },
    }
}

pub(crate) fn revision_complete(pdf: &[u8], end: usize) -> bool {
    if end == 0 || end > pdf.len() {
        return false;
    }
    let Some(prefix) = pdf.get(..end) else {
        return false;
    };
    let index = NumberIndex::build(prefix);
    if index.failure.is_some() || index.first_offsets.len() > MAX_INDIRECT_VALUES {
        return false;
    }
    let mut scanner = Scanner::new(prefix, Mode::Revisions, None);
    scanner.own = index.snapshot();
    if scanner.main_loop().is_err() {
        return false;
    }
    let structure = finish_structure(scanner);
    let Some(&terminal) = structure.terminals.last() else {
        return false;
    };
    let trailing_whitespace = prefix
        .get(terminal.eof_end..)
        .unwrap_or_default()
        .iter()
        .all(|&byte| is_whitespace(byte));
    if !trailing_whitespace || !structure.chain_complete(terminal) {
        return false;
    }
    Document::open(prefix, &Limits::default())
        .and_then(|document| document.catalog())
        .is_ok_and(|catalog| catalog.is_some())
}

fn byte_range_values(value: &Value) -> Option<[f64; 4]> {
    let [a, b, c, d] = value.as_array()? else {
        return None;
    };
    let mut values = [0.0_f64; 4];
    for (slot, item) in values.iter_mut().zip([a, b, c, d]) {
        let number = item.as_number()?;
        let _: i64 = safe_integer(number).filter(|integer| *integer >= 0)?;
        *slot = number;
    }
    Some(values)
}

fn candidates_for(pdf: &[u8], structure: &Structure, scan: &SignatureScan) -> Candidates {
    let mut by_revision: Vec<(Terminal, Vec<SignatureDictionary>)> = Vec::new();
    let mut invalid: Vec<SignatureDictionary> = Vec::new();
    let final_terminal = structure.terminal_for_range(pdf, pdf.len());
    for dictionary in &scan.dictionaries {
        let key = Key {
            generation: dictionary.generation,
            number: dictionary.number,
        };
        let range_end = dictionary
            .byte_range_values
            .and_then(|[_, _, start, length]| finite_sum(start, length))
            .filter(|end| *end <= pdf.len());
        let terminal = range_end.and_then(|end| structure.terminal_for_range(pdf, end));
        if let Some(found) = terminal {
            let active = structure.effective_entry(found, key);
            if !matches!(active, Some(Entry::Uncompressed { offset, .. }) if usize::try_from(offset).ok() == Some(dictionary.object_start))
            {
                continue;
            }
            match by_revision
                .iter_mut()
                .find(|(existing, _)| existing.eof_end == found.eof_end)
            {
                Some((_, list)) => list.push(dictionary.clone()),
                None => by_revision.push((found, vec![dictionary.clone()])),
            }
            continue;
        }
        let final_entry = final_terminal.and_then(|found| structure.effective_entry(found, key));
        if matches!(final_entry, Some(Entry::Uncompressed { offset, .. }) if usize::try_from(offset).ok() == Some(dictionary.object_start))
        {
            invalid.push(dictionary.clone());
        }
    }
    Candidates {
        by_revision,
        final_terminal,
        invalid,
    }
}

fn decode_name(raw: &[u8]) -> Vec<u8> {
    if !raw.contains(&b'#') {
        return raw.to_vec();
    }
    let mut out = Vec::with_capacity(raw.len());
    let mut index = 0_usize;
    while let Some(&byte) = raw.get(index) {
        let high = raw
            .get(index.saturating_add(1))
            .copied()
            .and_then(upper_hex);
        let low = raw
            .get(index.saturating_add(2))
            .copied()
            .and_then(upper_hex);
        if byte == b'#'
            && let (Some(first), Some(second)) = (high, low)
        {
            out.push((first << 4_i32) | second);
            index = index.saturating_add(3);
        } else {
            out.push(byte);
            index = index.saturating_add(1);
        }
    }
    out
}

fn decode_object_stream(dict: &Value, raw: &[u8]) -> Option<Vec<u8>> {
    let mut converted = Dict::default();
    for key in [b"Filter".as_slice(), b"DecodeParms".as_slice()] {
        if let Some(value) = dict.get(key) {
            converted.insert(key, to_object(value)?);
        }
    }
    filters::decode_stream(&converted, raw, MAX_OBJECT_STREAM_BYTES, None).ok()
}

fn decode_predictor(input: &[u8], expected: usize, predictor: Predictor) -> Option<Vec<u8>> {
    if predictor.kind == 1 {
        return (input.len() == expected).then(|| input.to_vec());
    }
    let row_bytes = predictor.row_bytes()?;
    if expected.checked_rem(row_bytes)? != 0 {
        return None;
    }
    if predictor.kind == 2 {
        if input.len() != expected {
            return None;
        }
        return Some(tiff_predictor(input, expected, row_bytes, predictor));
    }
    let rows = expected.checked_div(row_bytes)?;
    if input.len() != expected.checked_add(rows)? {
        return None;
    }
    let bytes_per_pixel = predictor
        .colors
        .checked_mul(predictor.bits)?
        .checked_add(7)?
        .checked_div(8)?;
    if bytes_per_pixel == 0 {
        return None;
    }
    let mut output = vec![0_u8; expected];
    let mut cursor = 0_usize;
    for row in 0..rows {
        let filter = *input.get(cursor)?;
        cursor = cursor.saturating_add(1);
        if filter > 4
            || (predictor.kind != 15 && usize::from(filter) != predictor.kind.saturating_sub(10))
        {
            return None;
        }
        let row_start = row.saturating_mul(row_bytes);
        for column in 0..row_bytes {
            let encoded = *input.get(cursor)?;
            cursor = cursor.saturating_add(1);
            let at = row_start.saturating_add(column);
            let left = if column >= bytes_per_pixel {
                output
                    .get(at.saturating_sub(bytes_per_pixel))
                    .copied()
                    .unwrap_or(0)
            } else {
                0
            };
            let above = if row > 0 {
                output
                    .get(at.saturating_sub(row_bytes))
                    .copied()
                    .unwrap_or(0)
            } else {
                0
            };
            let upper_left = if row > 0 && column >= bytes_per_pixel {
                output
                    .get(at.saturating_sub(row_bytes).saturating_sub(bytes_per_pixel))
                    .copied()
                    .unwrap_or(0)
            } else {
                0
            };
            let prediction = match filter {
                0 => 0,
                1 => left,
                2 => above,
                3 => u8::try_from((u16::from(left).saturating_add(u16::from(above))) >> 1_i32)
                    .unwrap_or(0),
                _ => paeth(left, above, upper_left),
            };
            if let Some(slot) = output.get_mut(at) {
                *slot = encoded.wrapping_add(prediction);
            }
        }
    }
    Some(output)
}

fn dictionary_scan(pdf: &[u8]) -> Result<(SignatureScan, Option<RevisionNumbers>), Reason> {
    let mut initial = Scanner::new(pdf, Mode::Signatures, None);
    if initial.main_loop().is_ok() {
        let scan = finish_signatures(initial);
        if !scan.flags.stream_failed && !scan.flags.stream_uncertain {
            return Ok((scan, None));
        }
    }
    let revisions = revision_numbers(pdf)?;
    let mut fallback = Scanner::new(pdf, Mode::Signatures, Some(&revisions));
    if fallback.main_loop().is_err() {
        return Err(Reason::DictionaryParse);
    }
    let scan = finish_signatures(fallback);
    Ok((scan, Some(revisions)))
}

fn entries_from_stream(stream: &XrefStream, decoded: &[u8]) -> Option<Entries> {
    if decoded.len() != stream.expected_length {
        return None;
    }
    let [type_width, first_width, second_width] = stream.widths;
    let row = type_width
        .saturating_add(first_width)
        .saturating_add(second_width);
    let mut entries: Vec<(u64, Entry)> = Vec::new();
    let mut offset = 0_usize;
    for &(first, count) in &stream.ranges {
        for index in 0..count {
            let kind = if type_width == 0 {
                1
            } else {
                read_field(decoded, offset, type_width)?
            };
            let first_field = read_field(decoded, offset.saturating_add(type_width), first_width)?;
            let second_field = read_field(
                decoded,
                offset
                    .saturating_add(type_width)
                    .saturating_add(first_width),
                second_width,
            )?;
            let number = first
                .checked_add(index)
                .filter(|value| *value <= MAX_SAFE_INTEGER)?;
            let entry = match kind {
                0 => Entry::Free {
                    generation: second_field,
                },
                1 => Entry::Uncompressed {
                    generation: second_field,
                    offset: first_field,
                },
                2 => {
                    if second_field > MAX_OBJECT_STREAM_OBJECTS {
                        return None;
                    }
                    Entry::Compressed {
                        index: second_field,
                        stream: first_field,
                    }
                }
                _ => return None,
            };
            entries.push((number, entry));
            offset = offset.saturating_add(row);
        }
    }
    entries.reverse();
    Some(Entries::first_wins(&entries))
}

fn definition_at(definitions: &[Definition], start: usize) -> Option<Definition> {
    definitions
        .binary_search_by_key(&start, |definition| definition.start)
        .ok()
        .and_then(|position| definitions.get(position))
        .copied()
}

fn find(data: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    let haystack = data.get(from..)?;
    let first = *needle.first()?;
    let mut cursor = 0_usize;
    while let Some(position) = haystack
        .get(cursor..)?
        .iter()
        .position(|&byte| byte == first)
    {
        let at = cursor.saturating_add(position);
        if haystack
            .get(at..)
            .is_some_and(|rest| rest.starts_with(needle))
        {
            return Some(from.saturating_add(at));
        }
        cursor = at.saturating_add(1);
    }
    None
}

fn finish_signatures(scanner: Scanner<'_>) -> SignatureScan {
    let mut scan = scanner.signatures;
    scan.numbers = scanner.own;
    let (mut ranged, unranged): (Vec<SignatureDictionary>, Vec<SignatureDictionary>) = scan
        .dictionaries
        .into_iter()
        .partition(|dictionary| dictionary.byte_range.is_some());
    ranged.extend(unranged);
    scan.dictionaries = ranged;
    scan
}

fn finish_structure(scanner: Scanner<'_>) -> Structure {
    let mut structure = scanner.structure;
    if structure.pending_table.is_some() {
        structure.valid = false;
    }
    structure
}

fn finite_sum(start: f64, length: f64) -> Option<usize> {
    let total = start + length;
    usize::try_from(safe_integer(total)?).ok()
}

fn hydrate(pdf: &[u8], structure: &mut Structure) -> Result<(), Reason> {
    if structure.limit {
        return Err(Reason::CrossReferenceStream);
    }
    let mut entry_count = structure
        .sources
        .iter()
        .filter(|source| source.kind == SourceKind::Table)
        .map(|source| source.entries.len())
        .fold(0_usize, usize::saturating_add);
    if entry_count > MAX_TOTAL_ENTRIES {
        return Err(Reason::CrossReferenceStream);
    }
    let streams = mem::take(&mut structure.streams);
    for (offset, stream) in &streams {
        let declared = stream
            .ranges
            .iter()
            .map(|(_, count)| usize::try_from(*count).unwrap_or(usize::MAX))
            .fold(0_usize, usize::saturating_add);
        if entry_count.saturating_add(declared) > MAX_TOTAL_ENTRIES {
            return Err(Reason::CrossReferenceStream);
        }
        let entries = xref_stream_entries(pdf, stream).ok_or(Reason::CrossReferenceStream)?;
        entry_count = entry_count.saturating_add(entries.len());
        let source = structure
            .source_mut(*offset)
            .ok_or(Reason::CrossReferenceStream)?;
        source.entries = entries;
    }
    structure.streams = streams;
    let tables: Vec<usize> = structure
        .sources
        .iter()
        .filter(|source| source.kind == SourceKind::Table && source.supplemental.is_some())
        .map(|source| source.offset)
        .collect();
    for offset in tables {
        let Some(source) = structure.source(offset) else {
            continue;
        };
        let supplemental_offset = source
            .supplemental
            .and_then(|value| usize::try_from(value).ok())
            .ok_or(Reason::CrossReferenceStream)?;
        let supplemental = structure
            .source(supplemental_offset)
            .ok_or(Reason::CrossReferenceStream)?;
        if supplemental.kind != SourceKind::Stream
            || supplemental.offset >= source.offset
            || supplemental
                .previous
                .is_some_and(|previous| Some(previous) != source.previous)
        {
            return Err(Reason::CrossReferenceStream);
        }
        let merged = source.entries.overlaid(&supplemental.entries);
        if let Some(target) = structure.source_mut(offset) {
            target.entries = merged;
        }
    }
    Ok(())
}

fn inflate_zlib(encoded: &[u8], max: usize) -> Option<Vec<u8>> {
    let [cmf, flg, ..] = *encoded else {
        return None;
    };
    let header = (u16::from(cmf) << 8_i32) | u16::from(flg);
    if cmf & 0x0f != 8 || cmf >> 4_i32 > 7 || header.rem_euclid(31) != 0 || flg & 0x20 != 0 {
        return None;
    }
    let output = inflate(encoded, max).ok()?;
    let trailer = encoded.get(encoded.len().checked_sub(4)?..)?;
    let expected = u32::from_be_bytes(<[u8; 4]>::try_from(trailer).ok()?);
    (adler32(&output) == expected).then_some(output)
}

const fn is_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn is_placeholder_array(value: &Value) -> bool {
    let Some([first, second, third, fourth]) = value.as_array() else {
        return false;
    };
    first.as_number().is_some_and(|number| number == 0.0_f64)
        && [second, third, fourth]
            .iter()
            .all(|item| item.is_name(PLACEHOLDER_NAME))
}

const fn is_token_boundary(byte: u8) -> bool {
    is_whitespace(byte) || is_delimiter(byte)
}

const fn is_whitespace(byte: u8) -> bool {
    matches!(byte, 0x00 | 0x09 | 0x0a | 0x0c | 0x0d | 0x20)
}

fn object_stream_references(bytes: &[u8], first: usize, count: u64) -> Option<Vec<(u64, usize)>> {
    let wanted = usize::try_from(count).ok()?.checked_mul(2)?;
    let mut values: Vec<u64> = Vec::with_capacity(wanted.min(1024));
    let mut offset = 0_usize;
    while values.len() < wanted {
        while bytes.get(offset).copied().is_some_and(is_whitespace) {
            offset = offset.saturating_add(1);
        }
        if bytes.get(offset) == Some(&b'%') {
            if offset >= first {
                return None;
            }
            while offset < first && !matches!(bytes.get(offset), Some(b'\n' | b'\r')) {
                offset = offset.saturating_add(1);
            }
            continue;
        }
        if offset >= first || !bytes.get(offset).is_some_and(u8::is_ascii_digit) {
            return None;
        }
        let mut value = 0_u64;
        while let Some(&digit) = bytes.get(offset).filter(|byte| byte.is_ascii_digit()) {
            value = value
                .checked_mul(10)?
                .checked_add(u64::from(digit.saturating_sub(b'0')))?;
            if value > MAX_SAFE_INTEGER {
                return None;
            }
            offset = offset.saturating_add(1);
        }
        values.push(value);
    }
    while offset < first && bytes.get(offset).copied().is_some_and(is_whitespace) {
        offset = offset.saturating_add(1);
    }
    if offset != first {
        return None;
    }
    let mut references: Vec<(u64, usize)> = Vec::with_capacity(values.len().saturating_div(2));
    let mut previous: Option<u64> = None;
    let (pairs, _) = values.as_chunks::<2>();
    for &[number, relative] in pairs {
        if previous.is_some_and(|last| relative <= last) {
            return None;
        }
        previous = Some(relative);
        references.push((number, usize::try_from(relative).ok()?));
    }
    let mut numbers: Vec<[u64; 4]> = references
        .iter()
        .map(|(number, _)| [*number, 0, 0, 0])
        .collect();
    numbers.sort_unstable();
    if numbers.windows(2).any(|pair| pair.first() == pair.get(1)) {
        return None;
    }
    Some(references)
}

fn paeth(left: u8, above: u8, upper_left: u8) -> u8 {
    let estimate = i32::from(left)
        .saturating_add(i32::from(above))
        .saturating_sub(i32::from(upper_left));
    let left_distance = estimate.saturating_sub(i32::from(left)).abs();
    let above_distance = estimate.saturating_sub(i32::from(above)).abs();
    let upper_left_distance = estimate.saturating_sub(i32::from(upper_left)).abs();
    if left_distance <= above_distance && left_distance <= upper_left_distance {
        left
    } else if above_distance <= upper_left_distance {
        above
    } else {
        upper_left
    }
}

fn parse_js_number(lexeme: &[u8]) -> Option<f64> {
    let (negative, unsigned) = match lexeme.split_first() {
        Some((b'-', rest)) => (true, rest),
        Some((b'+', rest)) => (false, rest),
        _ => (false, lexeme),
    };
    let mut whole = 0.0_f64;
    let mut fraction = 0.0_f64;
    let mut scale = 1.0_f64;
    let mut digits = 0_usize;
    let mut dotted = false;
    for &byte in unsigned {
        match byte {
            b'.' if !dotted => dotted = true,
            b'0'..=b'9' => {
                let digit = f64::from(byte.saturating_sub(b'0'));
                digits = digits.saturating_add(1);
                if dotted {
                    if scale < 1e300_f64 {
                        scale *= 10.0_f64;
                        fraction = fraction * 10.0_f64 + digit;
                    }
                } else {
                    whole = whole * 10.0_f64 + digit;
                }
            }
            _ => return None,
        }
    }
    if digits == 0 {
        return None;
    }
    let magnitude = whole + fraction / scale;
    let value = if negative { -magnitude } else { magnitude };
    value.is_finite().then_some(value)
}

fn previous_offset(dict: &Value) -> Option<i64> {
    dict.get(b"Prev").and_then(Value::safe_integer)
}

fn read_field(decoded: &[u8], offset: usize, width: usize) -> Option<u64> {
    let mut value = 0_u64;
    for index in 0..width {
        let byte = *decoded.get(offset.saturating_add(index))?;
        value = value.checked_mul(256)?.checked_add(u64::from(byte))?;
        if value > MAX_SAFE_INTEGER {
            return None;
        }
    }
    Some(value)
}

fn reference_part(value: f64) -> u64 {
    safe_integer(value)
        .and_then(|integer| u64::try_from(integer).ok())
        .unwrap_or(u64::MAX)
}

fn revision_numbers(pdf: &[u8]) -> Result<RevisionNumbers, Reason> {
    let mut scanner = Scanner::new(pdf, Mode::Revisions, None);
    if scanner.main_loop().is_err() {
        return Err(Reason::RevisionLengths);
    }
    let structure = finish_structure(scanner);
    if structure.limit || structure.terminals.is_empty() {
        return Err(Reason::RevisionLengths);
    }
    let index = NumberIndex::build(pdf);
    let mut eof_ends = Vec::with_capacity(structure.terminals.len());
    for terminal in &structure.terminals {
        if index
            .failure
            .is_some_and(|failed| failed < terminal.eof_end)
        {
            return Err(Reason::IndirectLengths);
        }
        if index.distinct_before(terminal.eof_end) > MAX_INDIRECT_VALUES {
            return Err(Reason::LengthBudget);
        }
        eof_ends.push(terminal.eof_end);
    }
    Ok(RevisionNumbers { eof_ends, index })
}

fn safe_integer(value: f64) -> Option<i64> {
    (value.is_finite() && value.fract() == 0.0 && value.abs() <= u64_to_f64(MAX_SAFE_INTEGER))
        .then(|| f64_to_i64(value))
}

const fn span(field: &Field) -> FieldSpan {
    FieldSpan {
        key_start: field.key_start,
        value_end: field.value_end,
        value_start: field.value_start,
    }
}

fn sequence(position: usize) -> u64 {
    u64::try_from(position).unwrap_or(u64::MAX)
}

fn stream_end(start: usize, length: f64, size: usize) -> Option<usize> {
    let value = usize::try_from(safe_integer(length).filter(|integer| *integer >= 0)?).ok()?;
    let end = start.checked_add(value)?;
    (end <= size).then_some(end)
}

fn tiff_predictor(
    input: &[u8],
    expected: usize,
    row_bytes: usize,
    predictor: Predictor,
) -> Vec<u8> {
    let mut output = input.to_vec();
    let samples = predictor.colors.saturating_mul(predictor.columns);
    let bits = predictor.bits;
    let rows = expected.checked_div(row_bytes).unwrap_or(0);
    let read_bits = |buffer: &[u8], bit_offset: usize| -> u32 {
        let mut value = 0_u32;
        for bit in 0..bits {
            let absolute = bit_offset.saturating_add(bit);
            let byte = buffer.get(absolute >> 3_i32).copied().unwrap_or(0);
            let shift = 7_usize.saturating_sub(absolute & 7);
            value = (value << 1_i32) | u32::from((byte >> shift) & 1);
        }
        value
    };
    for row in 0..rows {
        let row_bit = row.saturating_mul(row_bytes).saturating_mul(8);
        for sample in predictor.colors..samples {
            let bit_offset = row_bit.saturating_add(sample.saturating_mul(bits));
            let previous_offset = bit_offset.saturating_sub(predictor.colors.saturating_mul(bits));
            let encoded = read_bits(input, bit_offset);
            let previous = read_bits(&output, previous_offset);
            let mask = if bits >= 32 {
                u32::MAX
            } else {
                (1_u32 << bits).wrapping_sub(1)
            };
            let value = encoded.wrapping_add(previous) & mask;
            for bit in 0..bits {
                let absolute = bit_offset.saturating_add(bit);
                let shift = 7_usize.saturating_sub(absolute & 7);
                let set = (value >> (bits.saturating_sub(bit).saturating_sub(1))) & 1 == 1;
                if let Some(slot) = output.get_mut(absolute >> 3_i32) {
                    if set {
                        *slot |= 1 << shift;
                    } else {
                        *slot &= !(1 << shift);
                    }
                }
            }
        }
    }
    output
}

fn to_object(value: &Value) -> Option<Object> {
    Some(match value {
        Value::Name(name) => Object::Name(name.clone()),
        Value::Null => Object::Null,
        Value::Number(number) => {
            safe_integer(*number).map_or(Object::Real(*number), Object::Integer)
        }
        Value::Array(items) => {
            Object::Array(items.iter().map(to_object).collect::<Option<Vec<_>>>()?)
        }
        Value::Dict(fields) => {
            let mut dict = Dict::default();
            for field in fields {
                dict.insert(&field.key, to_object(&field.value)?);
            }
            Object::Dict(dict)
        }
        Value::Bool | Value::Ref(_) | Value::Text => return None,
    })
}

const fn upper_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte.wrapping_sub(b'0')),
        b'A'..=b'F' => Some(byte.wrapping_sub(b'A').wrapping_add(10)),
        _ => None,
    }
}

fn verification(pdf: &[u8]) -> Result<Vec<SignatureDictionary>, Reason> {
    let (scan, revisions) = dictionary_scan(pdf)?;
    if scan.flags.stream_failed || scan.flags.stream_uncertain {
        return Err(Reason::StreamEnd);
    }
    if scan.flags.limit {
        return Err(Reason::TraversalBudget);
    }
    if scan.dictionaries.is_empty() {
        return Ok(Vec::new());
    }
    let mut scanner = Scanner::new(pdf, Mode::Revisions, revisions.as_ref());
    scanner.own.clone_from(&scan.numbers);
    if scanner.main_loop().is_err() {
        return Err(Reason::RevisionStructure);
    }
    let mut structure = finish_structure(scanner);
    hydrate(pdf, &mut structure)?;
    let Candidates {
        by_revision,
        final_terminal,
        invalid,
    } = candidates_for(pdf, &structure, &scan);
    let definitions = scan.definitions.as_slice();
    let mut budget = MAX_REVISION_WORK;
    let mut reachable: Vec<SignatureDictionary> = Vec::new();
    for (terminal, dictionaries) in by_revision {
        let found = reachable_signatures(
            pdf,
            &structure,
            terminal,
            definitions,
            revisions.as_ref(),
            &mut budget,
        )?;
        for dictionary in dictionaries {
            if found.contains(Key {
                generation: dictionary.generation,
                number: dictionary.number,
            }) {
                reachable.push(dictionary);
            }
        }
    }
    if let Some(terminal) = final_terminal
        && !invalid.is_empty()
    {
        let found = reachable_signatures(
            pdf,
            &structure,
            terminal,
            definitions,
            revisions.as_ref(),
            &mut budget,
        )?;
        if invalid.iter().any(|dictionary| {
            found.contains(Key {
                generation: dictionary.generation,
                number: dictionary.number,
            })
        }) {
            return Err(Reason::InvalidByteRange);
        }
    }
    Ok(reachable)
}

fn reachable_signatures(
    pdf: &[u8],
    structure: &Structure,
    terminal: Terminal,
    definitions: &[Definition],
    revisions: Option<&RevisionNumbers>,
    budget: &mut usize,
) -> Result<KeySet, Reason> {
    let mut resolver = Resolver {
        budget,
        cache: Vec::new(),
        decoded: None,
        decompressed: 0,
        definitions,
        pdf,
        resolutions: 0,
        revisions,
        structure,
        terminal,
    };
    let root_value = structure.root(terminal);
    let root = match root_value {
        Some(value) => resolver.resolve(&value)?,
        None => None,
    };
    let Some(catalog) = root.filter(|value| value.as_dict().is_some()) else {
        return Ok(KeySet::default());
    };
    let acro_form = match catalog.get(b"AcroForm") {
        Some(value) => resolver.resolve(value)?,
        None => None,
    };
    let Some(form) = acro_form.filter(|value| value.as_dict().is_some()) else {
        return Ok(KeySet::default());
    };
    let fields = match form.get(b"Fields") {
        Some(value) => resolver.resolve(value)?,
        None => None,
    };
    let Some(list) = fields.filter(|value| value.as_array().is_some()) else {
        return Ok(KeySet::default());
    };
    let mut walk = Reachability {
        reachable: KeySet::default(),
        resolver: &mut resolver,
        traversed: 0,
        visited: KeySet::default(),
    };
    for field in list.as_array().unwrap_or_default() {
        walk.visit(Some(field), false, 0)?;
    }
    Ok(walk.reachable)
}

fn xref_predictor(expected: usize, parameters: Option<&Value>) -> Option<(Predictor, usize)> {
    let read = |key: &[u8], fallback: i64| -> Option<i64> {
        match parameters.and_then(|dict| dict.get(key)) {
            Some(Value::Number(number)) => safe_integer(*number),
            _ => Some(fallback),
        }
    };
    let predictor = read(b"Predictor", 1)?;
    let colors = read(b"Colors", 1)?;
    let columns = read(b"Columns", 1)?;
    let bits = read(b"BitsPerComponent", 8)?;
    if colors <= 0 || columns <= 0 || !matches!(bits, 1 | 2 | 4 | 8 | 16) {
        return None;
    }
    let config = Predictor {
        bits: usize::try_from(bits).ok()?,
        colors: usize::try_from(colors).ok()?,
        columns: usize::try_from(columns).ok()?,
        kind: usize::try_from(predictor).ok()?,
    };
    if predictor == 1 || predictor == 2 {
        return Some((config, expected));
    }
    if !(10..=15).contains(&predictor) {
        return None;
    }
    let row_bytes = config.row_bytes()?;
    if expected.checked_rem(row_bytes)? != 0 {
        return None;
    }
    let maximum = expected.checked_add(expected.checked_div(row_bytes)?)?;
    (maximum <= MAX_XREF_STREAM_BYTES).then_some((config, maximum))
}

fn xref_stream_definition(dict: &Value, start: usize, end: usize) -> Option<XrefStream> {
    if end.saturating_sub(start) > MAX_XREF_STREAM_BYTES {
        return None;
    }
    let [w0, w1, w2] = dict.get(b"W")?.as_array()? else {
        return None;
    };
    let mut widths = [0_usize; 3];
    for (slot, item) in widths.iter_mut().zip([w0, w1, w2]) {
        let width = safe_integer(item.as_number()?)?;
        if !(0..=8).contains(&width) {
            return None;
        }
        *slot = usize::try_from(width).ok()?;
    }
    let row = widths.iter().copied().fold(0_usize, usize::saturating_add);
    if row == 0 {
        return None;
    }
    let mut ranges: Vec<(u64, u64)> = Vec::new();
    if let Some(Value::Array(items)) = dict.get(b"Index") {
        let (pairs, rest) = items.as_chunks::<2>();
        if !rest.is_empty() {
            return None;
        }
        for [first, count] in pairs {
            let first_value = u64::try_from(safe_integer(first.as_number()?)?).ok()?;
            let count_value = u64::try_from(safe_integer(count.as_number()?)?).ok()?;
            ranges.push((first_value, count_value));
        }
    } else {
        let size = u64::try_from(safe_integer(dict.get(b"Size")?.as_number()?)?).ok()?;
        ranges.push((0, size));
    }
    let mut entry_count = 0_u64;
    for &(_, count) in &ranges {
        entry_count = entry_count.checked_add(count)?;
        if entry_count > MAX_XREF_ENTRIES {
            return None;
        }
    }
    let expected_length = usize::try_from(entry_count).ok()?.checked_mul(row)?;
    if expected_length > MAX_XREF_STREAM_BYTES {
        return None;
    }
    Some(XrefStream {
        dict: dict.clone(),
        end,
        expected_length,
        ranges,
        start,
        widths,
    })
}

fn xref_stream_entries(pdf: &[u8], stream: &XrefStream) -> Option<Entries> {
    let filter = stream.dict.get(b"Filter");
    let parms = stream.dict.get(b"DecodeParms");
    let parameters: Option<&Value> = match filter {
        None if parms.is_some() => return None,
        None => None,
        Some(value) if value.is_name(b"FlateDecode") => match parms {
            None | Some(Value::Null) => None,
            Some(dict @ Value::Dict(_)) => Some(dict),
            Some(_) => return None,
        },
        Some(Value::Array(items)) if matches!(items.as_slice(), [only] if only.is_name(b"FlateDecode")) => {
            match parms {
                None => None,
                Some(Value::Array(entries)) => match entries.as_slice() {
                    [Value::Null] => None,
                    [dict @ Value::Dict(_)] => Some(dict),
                    _ => return None,
                },
                Some(_) => return None,
            }
        }
        Some(_) => return None,
    };
    let (predictor, maximum) = xref_predictor(stream.expected_length, parameters)?;
    let encoded = pdf.get(stream.start..stream.end)?;
    let decoded = if filter.is_none() {
        encoded.to_vec()
    } else {
        inflate_zlib(encoded, maximum)?
    };
    let predicted = decode_predictor(&decoded, stream.expected_length, predictor)?;
    entries_from_stream(stream, &predicted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deflate::zlib_compress;
    use core::fmt::Write as _;

    const FAKE_BYTE_RANGE: &str = "/ByteRange [0 0 0 0]";

    struct RawSignature {
        byte_range_text: String,
        pdf: Vec<u8>,
        xref_offset: usize,
    }

    fn padded(values: [usize; 4]) -> String {
        format!(
            "[{:010} {:010} {:010} {:010}]",
            values[0], values[1], values[2], values[3]
        )
    }

    fn render_raw(
        kind: &str,
        byte_range_text: &str,
        field_body: &str,
        unindexed: &[(u32, &str)],
    ) -> (String, usize) {
        let stream_contents = "binary\nendstream fake\nstream payload";
        let objects: Vec<(u32, String)> = vec![
            (
                1,
                "<< /Type /Catalog /Pages 2 0 R /AcroForm 3 0 R >>".to_owned(),
            ),
            (2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>".to_owned()),
            (3, "<< /Fields [6 0 R] >>".to_owned()),
            (
                4,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 7 0 R >>"
                    .to_owned(),
            ),
            (6, field_body.to_owned()),
            (
                7,
                format!("<< /Length 5 0 R >>\nstream\n{stream_contents}\nendstream"),
            ),
            (
                8,
                format!("<< /Type /{kind} /ByteRange {byte_range_text} /Contents <00> >>"),
            ),
            (5, stream_contents.len().to_string()),
        ];
        let mut source = String::from("%PDF-1.7\n");
        let mut offsets = [None; 9];
        for (number, body) in &objects {
            offsets[usize::try_from(*number).unwrap()] = Some(source.len());
            write!(source, "{number} 0 obj\n{body}\nendobj\n").unwrap();
        }
        for (number, body) in unindexed {
            write!(source, "{number} 0 obj\n{body}\nendobj\n").unwrap();
        }
        let xref_offset = source.len();
        source.push_str("xref\n0 9\n0000000000 65535 f \n");
        for offset in offsets.iter().skip(1) {
            match offset {
                Some(value) => writeln!(source, "{value:010} 00000 n ").unwrap(),
                None => source.push_str("0000000000 00000 f \n"),
            }
        }
        write!(
            source,
            "trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF"
        )
        .unwrap();
        (source, xref_offset)
    }

    fn raw_signature_with(
        kind: &str,
        format: fn([usize; 4]) -> String,
        field_body: &str,
        unindexed: &[(u32, &str)],
    ) -> RawSignature {
        let (template, _) = render_raw(kind, &format([0, 0, 0, 0]), field_body, unindexed);
        let contents_start = template
            .find("/Contents <")
            .unwrap()
            .saturating_add("/Contents ".len());
        let contents_end = contents_start.saturating_add(4);
        let byte_range_text = format([
            0,
            contents_start,
            contents_end,
            template.len().saturating_sub(contents_end),
        ]);
        let (source, xref_offset) = render_raw(kind, &byte_range_text, field_body, unindexed);
        RawSignature {
            byte_range_text,
            pdf: source.into_bytes(),
            xref_offset,
        }
    }

    fn raw_signature() -> RawSignature {
        raw_signature_with("Sig", padded, "<< /FT /Sig /V 8 0 R >>", &[])
    }

    fn verify(pdf: &[u8]) -> Report {
        analyze(pdf, Analysis::Verification)
    }

    fn scan(pdf: &[u8]) -> Report {
        analyze(pdf, Analysis::Scan)
    }

    fn has_byte_range(report: &Report) -> bool {
        report.flags.parse_failed
            || report.flags.stream_failed
            || report.flags.stream_uncertain
            || report
                .dictionaries
                .iter()
                .any(|item| item.byte_range.is_some())
    }

    fn has_dictionary(report: &Report) -> bool {
        report.flags.parse_failed
            || report.flags.stream_failed
            || report.flags.stream_uncertain
            || !report.dictionaries.is_empty()
    }

    fn regular(report: &Report) -> usize {
        report
            .dictionaries
            .iter()
            .filter(|item| !item.timestamp && item.byte_range.is_some())
            .count()
    }

    fn entry(kind: u8, first: usize, second: u16) -> [u8; 7] {
        let first_bytes = u32::try_from(first).unwrap().to_be_bytes();
        let second_bytes = second.to_be_bytes();
        [
            kind,
            first_bytes[0],
            first_bytes[1],
            first_bytes[2],
            first_bytes[3],
            second_bytes[0],
            second_bytes[1],
        ]
    }

    fn base_objects(byte_range_text: &str) -> Vec<(u32, String)> {
        vec![
            (
                1,
                "<< /Type /Catalog /Pages 2 0 R /AcroForm 3 0 R >>".to_owned(),
            ),
            (2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>".to_owned()),
            (3, "<< /Fields [6 0 R] >>".to_owned()),
            (
                4,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 7 0 R >>"
                    .to_owned(),
            ),
            (5, "3".to_owned()),
            (6, "<< /FT /Sig /V 8 0 R >>".to_owned()),
            (7, "<< /Length 5 0 R >>\nstream\nq\nQ\nendstream".to_owned()),
            (
                8,
                format!("<< /Type /Sig /ByteRange {byte_range_text} /Contents <00> >>"),
            ),
        ]
    }

    fn with_byte_range<F>(render: F) -> Vec<u8>
    where
        F: Fn(&str) -> Vec<u8>,
    {
        let template = render(&padded([0, 0, 0, 0]));
        let needle = b"/Contents <";
        let contents_start = template
            .windows(needle.len())
            .position(|window| window == needle)
            .unwrap()
            .saturating_add("/Contents ".len());
        let contents_end = contents_start.saturating_add(4);
        render(&padded([
            0,
            contents_start,
            contents_end,
            template.len().saturating_sub(contents_end),
        ]))
    }

    fn xref_stream_pdf(encoding: &str) -> Vec<u8> {
        with_byte_range(|byte_range_text| {
            let mut prefix = b"%PDF-1.7\n".to_vec();
            let mut offsets = [0_usize; 10];
            for (number, body) in base_objects(byte_range_text) {
                offsets[usize::try_from(number).unwrap()] = prefix.len();
                prefix.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
            }
            let xref_offset = prefix.len();
            let mut entries = Vec::new();
            entries.extend_from_slice(&entry(0, 0, u16::MAX));
            for offset in offsets.iter().take(9).skip(1) {
                entries.extend_from_slice(&entry(1, *offset, 0));
            }
            entries.extend_from_slice(&entry(1, xref_offset, 0));
            let (encoded, filter) = match encoding {
                "plain" => (entries.clone(), String::new()),
                "scalar" => (zlib_compress(&entries), "/Filter /FlateDecode".to_owned()),
                "array" => (zlib_compress(&entries), "/Filter [/FlateDecode]".to_owned()),
                "predictor" => {
                    let mut predicted = Vec::new();
                    for (row, chunk) in entries.chunks(7).enumerate() {
                        predicted.push(2);
                        for (column, byte) in chunk.iter().enumerate() {
                            let above = if row == 0 {
                                0
                            } else {
                                entries[(row.saturating_sub(1))
                                    .saturating_mul(7)
                                    .saturating_add(column)]
                            };
                            predicted.push(byte.wrapping_sub(above));
                        }
                    }
                    (
                        zlib_compress(&predicted),
                        "/Filter [/FlateDecode] /DecodeParms [<< /Predictor 12 /Columns 7 >>]"
                            .to_owned(),
                    )
                }
                "malformed-predictor" => (
                    zlib_compress(&entries),
                    "/Filter [/FlateDecode] /DecodeParms [<< /Predictor 12 /Columns 7 >>]"
                        .to_owned(),
                ),
                _ => (entries.clone(), "/Filter /LZWDecode".to_owned()),
            };
            prefix.extend_from_slice(
                format!(
                    "9 0 obj\n<< /Type /XRef /Size 10 /Root 1 0 R /W [1 4 2] /Index [0 10] {filter} /Length {} >>\nstream\n",
                    encoded.len()
                )
                .as_bytes(),
            );
            prefix.extend_from_slice(&encoded);
            prefix.extend_from_slice(
                format!("\nendstream\nendobj\nstartxref\n{xref_offset}\n%%EOF").as_bytes(),
            );
            prefix
        })
    }

    fn compressed_field_pdf(malformed: bool) -> Vec<u8> {
        let object_stream = zlib_compress(b"6 0 << /FT /Sig /V 8 0 R >>");
        with_byte_range(|byte_range_text| {
            let mut out = b"%PDF-1.7\n".to_vec();
            let mut offsets: Vec<(usize, usize)> = Vec::new();
            for (number, body) in base_objects(byte_range_text) {
                if number == 6 {
                    continue;
                }
                offsets.push((usize::try_from(number).unwrap(), out.len()));
                out.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
            }
            offsets.push((10, out.len()));
            out.extend_from_slice(
                format!(
                    "10 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length {} >>\nstream\n",
                    object_stream.len()
                )
                .as_bytes(),
            );
            out.extend_from_slice(&object_stream);
            out.extend_from_slice(b"\nendstream\nendobj\n");
            let xref_offset = out.len();
            let mut rows = vec![[0_u8; 7]; 12];
            rows[0] = entry(0, 0, u16::MAX);
            for (number, offset) in &offsets {
                rows[*number] = entry(1, *offset, 0);
            }
            rows[6] = entry(2, 10, u16::from(malformed));
            rows[11] = entry(1, xref_offset, 0);
            out.extend_from_slice(
                b"11 0 obj\n<< /Type /XRef /Size 12 /Root 1 0 R /W [1 4 2] /Index [0 12] /Length 84 >>\nstream\n",
            );
            for row in rows {
                out.extend_from_slice(&row);
            }
            out.extend_from_slice(
                format!("\nendstream\nendobj\nstartxref\n{xref_offset}\n%%EOF").as_bytes(),
            );
            out
        })
    }

    fn hybrid_pdf(malformed: bool) -> Vec<u8> {
        with_byte_range(|byte_range_text| {
            let objects: Vec<(u32, String)> = vec![
                (
                    1,
                    "<< /Type /Catalog /Pages 2 0 R /AcroForm 3 0 R >>".to_owned(),
                ),
                (2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>".to_owned()),
                (3, "<< /Fields [6 0 R] >>".to_owned()),
                (
                    4,
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>".to_owned(),
                ),
                (6, "<< /FT /Sig /V 8 0 R >>".to_owned()),
                (
                    8,
                    format!("<< /Type /Sig /ByteRange {byte_range_text} /Contents <00> >>"),
                ),
            ];
            let mut out = b"%PDF-1.7\n".to_vec();
            let mut offsets = [0_usize; 11];
            for (number, body) in &objects {
                offsets[usize::try_from(*number).unwrap()] = out.len();
                out.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
            }
            let stream_offset = out.len();
            out.extend_from_slice(
                b"10 0 obj\n<< /Type /XRef /Size 11 /W [1 4 2] /Index [6 1] /Length 7 >>\nstream\n",
            );
            out.extend_from_slice(&entry(1, offsets[6], 0));
            out.extend_from_slice(b"\nendstream\nendobj\n");
            let xref_offset = out.len();
            let row = |number: usize| format!("{:010} 00000 n \n", offsets[number]);
            out.extend_from_slice(
                format!(
                    "xref\n0 1\n0000000000 65535 f \n1 4\n{}{}{}{}8 1\n{}10 1\n{stream_offset:010} 00000 n \ntrailer\n<< /Size 11 /Root 1 0 R /XRefStm {} >>\nstartxref\n{xref_offset}\n%%EOF",
                    row(1),
                    row(2),
                    row(3),
                    row(4),
                    row(8),
                    stream_offset.saturating_add(usize::from(malformed))
                )
                .as_bytes(),
            );
            out
        })
    }

    fn append_empty_revisions(raw: &RawSignature, count: usize) -> Vec<u8> {
        let mut source = String::from_utf8(raw.pdf.clone()).unwrap();
        let mut previous = raw.xref_offset;
        for index in 0..count {
            let number = index.saturating_add(9);
            let object_offset = source.len().saturating_add(1);
            write!(source, "\n{number} 0 obj\n<< /Note /Revision >>\nendobj\n").unwrap();
            let xref_offset = source.len();
            write!(
                source,
                "xref\n{number} 1\n{object_offset:010} 00000 n \ntrailer\n<< /Size {} /Prev {previous} >>\nstartxref\n{xref_offset}\n%%EOF",
                number.saturating_add(1)
            )
            .unwrap();
            previous = xref_offset;
        }
        source.into_bytes()
    }

    #[test]
    fn ignores_byte_range_syntax_in_comments_strings_and_streams() {
        let contents = format!("/Type /Sig {FAKE_BYTE_RANGE} /Contents <00>");
        let pdf = format!(
            "%PDF-1.7\n1 0 obj\n<< /Note ({FAKE_BYTE_RANGE} /Contents <00>) >>\nendobj\n2 0 obj\n<< /Length {} >>\nstream\n{contents}\nendstream\nendobj\n% {FAKE_BYTE_RANGE}\n%%EOF",
            contents.len()
        );
        let report = scan(pdf.as_bytes());
        assert!(!has_byte_range(&report));
        assert!(!has_dictionary(&report));
    }

    #[test]
    fn detects_typed_signature_dictionaries_without_byte_range() {
        let signature = scan(b"%PDF-1.7\n1 0 obj\n<< /Type /Sig /Contents <00> >>\nendobj\n%%EOF");
        let timestamp =
            scan(b"%PDF-1.7\n1 0 obj\n<< /Type /DocTimeStamp /Contents <00> >>\nendobj\n%%EOF");
        assert!(has_dictionary(&signature) && !has_byte_range(&signature));
        assert!(has_dictionary(&timestamp) && !has_byte_range(&timestamp));
        assert!(timestamp.dictionaries[0].timestamp);
    }

    #[test]
    fn discovers_untyped_and_malformed_signature_dictionaries() {
        let untyped =
            format!("%PDF-1.7\n1 0 obj\n<< {FAKE_BYTE_RANGE} /Contents <00> >>\nendobj\n%%EOF");
        let report = analyze(untyped.as_bytes(), Analysis::Dictionaries);
        assert_eq!(regular(&report), 1);
        let malformed = scan(
            b"%PDF-1.7\n1 0 obj\n<< /ByteRange [0 /Invalid 0 0] /Contents <00> >>\nendobj\n%%EOF",
        );
        assert!(has_byte_range(&malformed));
        assert!(malformed.dictionaries[0].byte_range_values.is_none());
    }

    #[test]
    fn finds_byte_range_offsets_owned_by_signature_dictionaries() {
        let contents = format!("/Type /Sig {FAKE_BYTE_RANGE} /Contents <00>");
        let signature =
            format!("3 0 obj\n<< /Type /Sig {FAKE_BYTE_RANGE} /Contents <0000> >>\nendobj");
        let pdf = format!(
            "%PDF-1.7\n1 0 obj\n<< /Note ({FAKE_BYTE_RANGE} /Contents <00>) >>\nendobj\n2 0 obj\n<< /Length {} >>\nstream\n{contents}\nendstream\nendobj\n% {FAKE_BYTE_RANGE}\n{signature}\n%%EOF",
            contents.len()
        );
        let report = analyze(pdf.as_bytes(), Analysis::Dictionaries);
        let expected = pdf
            .len()
            .saturating_sub(signature.len())
            .saturating_sub("\n%%EOF".len())
            .saturating_add(signature.find("/ByteRange").unwrap());
        assert_eq!(report.dictionaries.len(), 1);
        assert_eq!(
            report.dictionaries[0].byte_range.unwrap().key_start,
            expected
        );
    }

    #[test]
    fn resolves_forward_indirect_lengths_through_revision_values() {
        let raw = raw_signature();
        let initial = scan(&raw.pdf);
        assert!(initial.flags.stream_uncertain);
        let report = verify(&raw.pdf);
        assert_eq!(report.failure, None);
        assert_eq!(regular(&report), 1);
        assert!(revision_complete(&raw.pdf, raw.pdf.len()));
    }

    #[test]
    fn binds_signatures_through_xref_streams_and_filters() {
        for encoding in ["plain", "scalar", "array", "predictor"] {
            let pdf = xref_stream_pdf(encoding);
            let report = verify(&pdf);
            assert_eq!(report.failure, None, "{encoding}");
            assert_eq!(regular(&report), 1, "{encoding}");
        }
        assert!(revision_complete(
            &xref_stream_pdf("plain"),
            xref_stream_pdf("plain").len()
        ));
        for encoding in ["unsupported", "malformed-predictor"] {
            let report = verify(&xref_stream_pdf(encoding));
            assert_eq!(
                report.failure,
                Some(Reason::CrossReferenceStream),
                "{encoding}"
            );
        }
    }

    #[test]
    fn resolves_compressed_signature_fields() {
        let report = verify(&compressed_field_pdf(false));
        assert_eq!(report.failure, None);
        assert_eq!(regular(&report), 1);
        let malformed = verify(&compressed_field_pdf(true));
        assert_eq!(malformed.failure, Some(Reason::ObjectStream));
    }

    #[test]
    fn merges_hybrid_supplemental_xref_streams() {
        let report = verify(&hybrid_pdf(false));
        assert_eq!(report.failure, None);
        assert_eq!(regular(&report), 1);
        assert!(verify(&hybrid_pdf(true)).failure.is_some());
    }

    #[test]
    fn fails_closed_beyond_the_revision_budget() {
        let pdf = append_empty_revisions(&raw_signature(), MAX_REVISIONS);
        assert!(verify(&pdf).failure.is_some());
        let within = append_empty_revisions(&raw_signature(), 3);
        assert_eq!(regular(&verify(&within)), 1);
    }

    #[test]
    fn uses_each_revision_length_values() {
        let first = raw_signature();
        let mut source = String::from_utf8(first.pdf.clone()).unwrap();
        let object_offset = source.len().saturating_add(1);
        let object = "5 1 obj\n1\nendobj\n";
        let xref_offset = object_offset.saturating_add(object.len());
        write!(
            source,
            "\n{object}xref\n5 1\n{object_offset:010} 00001 n \ntrailer\n<< /Size 9 /Prev {} >>\nstartxref\n{xref_offset}\n%%EOF",
            first.xref_offset
        )
        .unwrap();
        let revised = source.into_bytes();
        assert_eq!(regular(&verify(&revised)), 1);
        assert!(revision_complete(&revised, first.pdf.len()));
        assert!(revision_complete(&revised, revised.len()));
    }

    #[test]
    fn accepts_comments_and_signed_integers_in_byte_range_arrays() {
        let raw = raw_signature_with(
            "Sig",
            |values| {
                format!(
                    "[+{:010} % byte range\n+{:010} +{:010} +{:010}]",
                    values[0], values[1], values[2], values[3]
                )
            },
            "<< /FT /Sig /V 8 0 R >>",
            &[],
        );
        let report = verify(&raw.pdf);
        assert_eq!(regular(&report), 1);
        assert_eq!(
            report.dictionaries[0].byte_range_values.unwrap()[0],
            0.0_f64
        );
    }

    #[test]
    fn excludes_unindexed_duplicates() {
        let raw = raw_signature();
        let source = String::from_utf8(raw.pdf.clone()).unwrap();
        let duplicate = format!(
            "\n8 0 obj\n<< /Type /Sig /ByteRange {} /Contents <00> >>\nendobj\n",
            raw.byte_range_text
        );
        let object_offset = raw.pdf.len().saturating_add(duplicate.len());
        let xref_offset =
            object_offset.saturating_add("9 0 obj\n<< /Note /Duplicate >>\nendobj\n".len());
        let pdf = format!(
            "{source}{duplicate}9 0 obj\n<< /Note /Duplicate >>\nendobj\nxref\n9 1\n{object_offset:010} 00000 n \ntrailer\n<< /Size 10 /Prev {} >>\nstartxref\n{xref_offset}\n%%EOF",
            raw.xref_offset
        );
        assert_eq!(regular(&verify(pdf.as_bytes())), 1);
        let field = raw_signature_with(
            "Sig",
            padded,
            "<< /FT /Sig >>",
            &[(6, "<< /FT /Sig /V 8 0 R >>")],
        );
        let report = verify(&field.pdf);
        assert_eq!(report.failure, None);
        assert_eq!(regular(&report), 0);
        assert_eq!(
            analyze(&field.pdf, Analysis::Dictionaries)
                .dictionaries
                .len(),
            1
        );
    }

    #[test]
    fn respects_explicit_types() {
        let other = raw_signature_with("XObject", padded, "<< /FT /Sig /V 8 0 R >>", &[]);
        assert_eq!(
            analyze(&other.pdf, Analysis::Dictionaries)
                .dictionaries
                .len(),
            0
        );
        let timestamp = raw_signature_with("DocTimeStamp", padded, "<< /FT /Sig /V 8 0 R >>", &[]);
        let report = verify(&timestamp.pdf);
        assert_eq!(report.dictionaries.len(), 1);
        assert!(report.dictionaries[0].timestamp);
    }

    #[test]
    fn rejects_xref_markers_inside_streams() {
        let marker = "XREF_OFFSET";
        let template = format!(
            "xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\nstartxref\n{marker}\n%%EOF"
        );
        let stream_prefix = "payload\n";
        let stream_contents = format!("{stream_prefix}{template}\ncontinued stream data");
        let before = format!(
            "%PDF-1.7\n1 0 obj\n<< /Type /Sig {FAKE_BYTE_RANGE} /Contents <00> >>\nendobj\n2 0 obj\n<< /Length {} >>\nstream\n",
            stream_contents.len()
        );
        let xref_offset = before.len().saturating_add(stream_prefix.len());
        let revision = template.replace(marker, &format!("{xref_offset:011}"));
        let prefix = format!("{before}{stream_prefix}{revision}");
        let pdf = format!("{prefix}\ncontinued stream data\nendstream\nendobj\n%%EOF");
        assert!(!revision_complete(pdf.as_bytes(), prefix.len()));
    }

    #[test]
    fn marks_unsigned_placeholders() {
        let pdf = b"%PDF-1.7\n1 0 obj\n<< /Type /Sig /ByteRange [0 /********** /********** /**********] /Note (/Contents <11111111>) /Contents <0000000000000000> >>\nendobj\n%%EOF";
        let report = analyze(pdf, Analysis::Dictionaries);
        let dictionary = &report.dictionaries[0];
        assert!(dictionary.unsigned_placeholder);
        let contents = dictionary.contents.unwrap();
        assert_eq!(
            &pdf[contents.value_start..contents.value_end],
            b"<0000000000000000>"
        );
    }

    #[test]
    fn parse_failures_fail_closed() {
        let report = scan(b"%PDF-1.7\n1 0 obj\n<< /A [1 2 >>\nendobj\n");
        assert!(report.flags.parse_failed);
        assert!(has_byte_range(&report));
        let truncated = scan(b"%PDF-1.7\n1 0 obj\n<< /Length 5 >>\nstream\nab");
        assert!(truncated.flags.stream_failed);
    }

    #[test]
    fn js_number_grammar() {
        assert_eq!(parse_js_number(b"+0000000000"), Some(0.0_f64));
        assert_eq!(parse_js_number(b"-.5"), Some(-0.5_f64));
        assert_eq!(parse_js_number(b"5."), Some(5.0_f64));
        assert_eq!(parse_js_number(b"1.2.3"), None);
        assert_eq!(parse_js_number(b"--5"), None);
        assert_eq!(parse_js_number(b"."), None);
        assert_eq!(parse_js_number(b"+"), None);
        assert_eq!(safe_integer(9_007_199_254_740_992.0), None);
        assert_eq!(safe_integer(-3.0), Some(-3));
    }
}
