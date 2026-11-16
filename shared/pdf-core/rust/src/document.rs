use crate::num::widen;
use crate::num::{f64_to_i64, f64_to_usize};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::failure::{Failure, FailureCode, Outcome};
use crate::filters;
use crate::inspection::{InspectOptions, Inspection, Limits, LinkInfo, PageInfo, PageText};
use crate::object::{Dict, ObjRef, Object, Resolver, Stream};
use crate::syntax::{
    Parser, find_bytes, keyword_at, parse_indirect_object, parse_object_header, read_unsigned,
    skip_whitespace_at,
};

const HEADER_PROBE: usize = 1024;
const STARTXREF_PROBE: usize = 4096;
const MAX_SECTIONS: usize = 4096;
const MAX_REF_CHAIN: usize = 32;
const MAX_LENGTH_DEPTH: u32 = 4;
const MAX_DEEP_RESOLVE: usize = 8;
const DEFAULT_MEDIA_BOX: [f64; 4] = [0.0, 0.0, 612.0, 792.0];

const PDF_DOC_LOW: [char; 8] = [
    '\u{02D8}', '\u{02C7}', '\u{02C6}', '\u{02D9}', '\u{02DD}', '\u{02DB}', '\u{02DA}', '\u{02DC}',
];

const PDF_DOC_HIGH: [char; 31] = [
    '\u{2022}', '\u{2020}', '\u{2021}', '\u{2026}', '\u{2014}', '\u{2013}', '\u{0192}', '\u{2044}',
    '\u{2039}', '\u{203A}', '\u{2212}', '\u{2030}', '\u{201E}', '\u{201C}', '\u{201D}', '\u{2018}',
    '\u{2019}', '\u{201A}', '\u{2122}', '\u{FB01}', '\u{FB02}', '\u{0141}', '\u{0152}', '\u{0160}',
    '\u{0178}', '\u{017D}', '\u{0131}', '\u{0142}', '\u{0153}', '\u{0161}', '\u{017E}',
];

fn pdf_doc_char(byte: u8) -> char {
    match byte {
        0x18..=0x1f => PDF_DOC_LOW
            .get(usize::from(byte.saturating_sub(0x18)))
            .copied()
            .unwrap_or('\u{FFFD}'),
        0x7f | 0x9f => '\u{FFFD}',
        0x80..=0x9e => PDF_DOC_HIGH
            .get(usize::from(byte.saturating_sub(0x80)))
            .copied()
            .unwrap_or('\u{FFFD}'),
        0xa0 => '\u{20AC}',
        other => char::from(other),
    }
}

pub(crate) fn decode_text_string(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        let units = rest.chunks(2).map(|pair| match pair {
            [high, low] => u16::from(*high) << 8 | u16::from(*low),
            [high] => u16::from(*high) << 8,
            _ => 0,
        });
        return char::decode_utf16(units)
            .map(|unit| unit.unwrap_or('\u{FFFD}'))
            .collect();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        let units = rest.chunks(2).map(|pair| match pair {
            [low, high] => u16::from(*high) << 8 | u16::from(*low),
            [low] => u16::from(*low),
            _ => 0,
        });
        return char::decode_utf16(units)
            .map(|unit| unit.unwrap_or('\u{FFFD}'))
            .collect();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    bytes.iter().map(|&byte| pdf_doc_char(byte)).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Entry {
    Unset,
    Free,
    Offset(usize),
    Compressed { stream: u32, index: u32 },
}

struct ObjectStream {
    data: Vec<u8>,
    first: usize,
    entries: Vec<(u32, usize)>,
}

struct Section {
    entries: Vec<(u32, Entry)>,
    trailer: Dict,
    hybrid: Option<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Page {
    pub obj_ref: Option<ObjRef>,
    pub dict: Dict,
    pub resources: Dict,
    pub info: PageInfo,
}

#[derive(Default)]
struct Inherited {
    resources: Option<Rc<Object>>,
    media_box: Option<Rc<Object>>,
    crop_box: Option<Rc<Object>>,
    rotate: Option<Rc<Object>>,
}

impl Inherited {
    fn merged(&self, dict: &Dict) -> Self {
        let pick = |key: &[u8], parent: &Option<Rc<Object>>| {
            dict.get(key)
                .map(|value| Rc::new(value.clone()))
                .or_else(|| parent.clone())
        };
        Self {
            resources: pick(b"Resources", &self.resources),
            media_box: pick(b"MediaBox", &self.media_box),
            crop_box: pick(b"CropBox", &self.crop_box),
            rotate: pick(b"Rotate", &self.rotate),
        }
    }
}

fn lenient<T>(result: Outcome<T>) -> Outcome<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(failure) if failure.code == FailureCode::LimitExceeded => Err(failure),
        Err(_) => Ok(None),
    }
}

fn name_is(dict: &Dict, key: &[u8], expected: &[u8]) -> bool {
    dict.get(key)
        .and_then(Object::as_name)
        .is_some_and(|name| name == expected)
}

fn find_startxref(bytes: &[u8]) -> Option<usize> {
    let tail_start = bytes.len().saturating_sub(STARTXREF_PROBE);
    let mut found = None;
    let mut from = tail_start;
    while let Some(at) = find_bytes(bytes, from, b"startxref") {
        found = Some(at);
        from = at.saturating_add(9);
    }
    let mut pos = skip_whitespace_at(bytes, found?.saturating_add(9));
    let value = read_unsigned(bytes, &mut pos)?;
    usize::try_from(value).ok()
}

fn header_shift(bytes: &[u8]) -> usize {
    let probe = bytes
        .get(..HEADER_PROBE.min(bytes.len()))
        .unwrap_or_default();
    find_bytes(probe, 0, b"%PDF-").unwrap_or(0)
}

fn header_before(data: &[u8], keyword_index: usize, floor: usize) -> Option<usize> {
    let back = |mut index: usize, accept: fn(u8) -> bool, limit: usize| -> Option<usize> {
        let end = index;
        while index > floor
            && data
                .get(index.saturating_sub(1))
                .is_some_and(|&byte| accept(byte))
        {
            index = index.saturating_sub(1);
            if end.saturating_sub(index) > limit {
                return None;
            }
        }
        (index < end).then_some(index)
    };
    let index = back(keyword_index, crate::syntax::is_whitespace, 4096)?;
    let index = back(index, |byte| byte.is_ascii_digit(), 10)?;
    let index = back(index, crate::syntax::is_whitespace, 4096)?;
    back(index, |byte| byte.is_ascii_digit(), 10)
}

pub(crate) struct Document<'a> {
    bytes: &'a [u8],
    shift: Cell<usize>,
    limits: Limits,
    table: RefCell<Vec<Entry>>,
    trailer: RefCell<Dict>,
    cache: RefCell<Vec<Option<Rc<Object>>>>,
    object_streams: RefCell<HashMap<u32, Rc<ObjectStream>>>,
    repaired: Cell<bool>,
    depth: Cell<u32>,
}

impl<'a> Document<'a> {
    pub(crate) fn open(bytes: &'a [u8], limits: &Limits) -> Outcome<Self> {
        if bytes.len() > limits.max_pdf_bytes {
            return Err(Failure::limit("pdf exceeds size limit"));
        }
        let document = Document {
            bytes,
            shift: Cell::new(header_shift(bytes)),
            limits: *limits,
            table: RefCell::new(Vec::new()),
            trailer: RefCell::new(Dict::default()),
            cache: RefCell::new(Vec::new()),
            object_streams: RefCell::new(HashMap::new()),
            repaired: Cell::new(false),
            depth: Cell::new(0),
        };
        if document.read_xref_chain().is_err() {
            document.rebuild()?;
        }
        document.check_encrypted()?;
        if !document.root_valid() && !document.repaired.get() {
            document.rebuild()?;
        }
        document.check_encrypted()?;
        if !document.root_valid() {
            return Err(Failure::invalid("missing document catalog"));
        }
        Ok(document)
    }

    #[cfg(test)]
    pub(crate) const fn was_repaired(&self) -> bool {
        self.repaired.get()
    }

    fn check_encrypted(&self) -> Outcome<()> {
        let encrypted = self
            .trailer
            .borrow()
            .get(b"Encrypt")
            .is_some_and(|value| !matches!(value, Object::Null));
        if encrypted {
            return Err(Failure::new(
                FailureCode::EncryptedPdf,
                "encrypted documents are not supported",
            ));
        }
        Ok(())
    }

    fn object_bound(&self) -> usize {
        self.limits
            .max_objects
            .min(self.bytes.len().saturating_mul(8).saturating_add(4096))
    }

    pub(crate) fn catalog(&self) -> Outcome<Option<Rc<Object>>> {
        let root = self.trailer.borrow().get(b"Root").cloned();
        let Some(root) = root else { return Ok(None) };
        let Some(object) = lenient(self.follow(&root))? else {
            return Ok(None);
        };
        Ok(object.as_dict().is_some().then_some(object))
    }

    fn root_valid(&self) -> bool {
        let Ok(Some(catalog)) = self.catalog() else {
            return false;
        };
        let Some(pages) = catalog.as_dict().and_then(|dict| dict.get(b"Pages")) else {
            return false;
        };
        matches!(
            lenient(self.follow(pages)),
            Ok(Some(object)) if object.as_dict().is_some()
        )
    }

    fn apply(&self, table: &mut Vec<Entry>, entries: Vec<(u32, Entry)>) {
        let bound = self.object_bound();
        for (number, entry) in entries {
            let index = widen(number);
            if index >= bound {
                continue;
            }
            if table.len() <= index {
                table.resize(index.saturating_add(1), Entry::Unset);
            }
            if let Some(slot) = table.get_mut(index)
                && *slot == Entry::Unset
            {
                *slot = entry;
            }
        }
    }

    fn read_xref_chain(&self) -> Outcome<()> {
        let start =
            find_startxref(self.bytes).ok_or_else(|| Failure::invalid("missing startxref"))?;
        let mut table: Vec<Entry> = Vec::new();
        let mut trailer: Option<Dict> = None;
        let mut visited: HashSet<usize> = HashSet::new();
        let mut next = Some(start);
        while let Some(offset) = next {
            if !visited.insert(offset) || visited.len() > MAX_SECTIONS {
                break;
            }
            let section = self.read_section(offset)?;
            if let Some(hybrid) = section.hybrid
                && let Ok(extra) = self.read_section(hybrid)
            {
                self.apply(&mut table, extra.entries);
            }
            self.apply(&mut table, section.entries);
            next = section
                .trailer
                .get(b"Prev")
                .and_then(Object::as_number)
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(f64_to_usize);
            match trailer.as_mut() {
                None => trailer = Some(section.trailer),
                Some(base) => {
                    for (key, value) in section.trailer.entries {
                        if base.get(&key).is_none() {
                            base.entries.push((key, value));
                        }
                    }
                }
            }
        }
        let trailer = trailer.ok_or_else(|| Failure::invalid("missing trailer"))?;
        if table.is_empty() {
            return Err(Failure::invalid("empty cross-reference table"));
        }
        self.install(table, trailer);
        Ok(())
    }

    fn install(&self, table: Vec<Entry>, trailer: Dict) {
        *self.cache.borrow_mut() = vec![None; table.len()];
        *self.table.borrow_mut() = table;
        *self.trailer.borrow_mut() = trailer;
        self.object_streams.borrow_mut().clear();
    }

    fn read_section(&self, offset: usize) -> Outcome<Section> {
        let shift = self.shift.get();
        let candidates = [offset.saturating_add(shift), offset];
        for (index, candidate) in candidates.iter().enumerate() {
            if index == 1 && *candidate == candidates[0] {
                break;
            }
            let pos = skip_whitespace_at(self.bytes, *candidate);
            if keyword_at(self.bytes, pos, b"xref") {
                return self.read_classic_section(pos.saturating_add(4));
            }
            if parse_object_header(self.bytes, pos).is_some() {
                return self.read_stream_section(pos);
            }
        }
        Err(Failure::invalid("cross-reference section not found"))
    }

    fn read_classic_section(&self, start: usize) -> Outcome<Section> {
        let data = self.bytes;
        let mut pos = start;
        let mut entries: Vec<(u32, Entry)> = Vec::new();
        loop {
            pos = skip_whitespace_at(data, pos);
            if keyword_at(data, pos, b"trailer") {
                pos = pos.saturating_add(7);
                break;
            }
            let first = read_unsigned(data, &mut pos)
                .ok_or_else(|| Failure::invalid("bad xref subsection"))?;
            pos = skip_whitespace_at(data, pos);
            let count = read_unsigned(data, &mut pos)
                .ok_or_else(|| Failure::invalid("bad xref subsection"))?;
            let remaining = data.len().saturating_sub(pos);
            if usize::try_from(count).map_or(true, |count| count > remaining) {
                return Err(Failure::invalid("xref subsection exceeds file"));
            }
            let mut first = first;
            for index in 0..count {
                pos = skip_whitespace_at(data, pos);
                let offset = read_unsigned(data, &mut pos)
                    .ok_or_else(|| Failure::invalid("bad xref entry"))?;
                pos = skip_whitespace_at(data, pos);
                let generation = read_unsigned(data, &mut pos)
                    .ok_or_else(|| Failure::invalid("bad xref entry"))?;
                pos = skip_whitespace_at(data, pos);
                let flag = data.get(pos).copied();
                pos = pos.saturating_add(1);
                let entry = match flag {
                    Some(b'n') => match usize::try_from(offset) {
                        Ok(offset) if offset > 0 => Entry::Offset(offset),
                        _ => Entry::Free,
                    },
                    Some(b'f') => {
                        if index == 0 && first == 1 && generation == 65535 {
                            first = 0;
                        }
                        Entry::Free
                    }
                    _ => return Err(Failure::invalid("bad xref entry flag")),
                };
                let number = u32::try_from(first.saturating_add(index))
                    .map_err(|_| Failure::invalid("object number out of range"))?;
                entries.push((number, entry));
            }
        }
        let mut parser = Parser::new(data, pos, self.limits.max_nesting, true);
        let trailer = match parser.parse_object()? {
            Object::Dict(dict) => dict,
            _ => return Err(Failure::invalid("trailer is not a dictionary")),
        };
        let hybrid = trailer
            .get(b"XRefStm")
            .and_then(Object::as_integer)
            .and_then(|value| usize::try_from(value).ok());
        Ok(Section {
            entries,
            trailer,
            hybrid,
        })
    }

    fn read_stream_section(&self, pos: usize) -> Outcome<Section> {
        let parsed = parse_indirect_object(self.bytes, pos, self.limits.max_nesting, |_| None)?;
        let Object::Stream(stream) = parsed.object else {
            return Err(Failure::invalid("xref stream expected"));
        };
        let widths = stream
            .dict
            .get(b"W")
            .and_then(Object::as_array)
            .ok_or_else(|| Failure::invalid("xref stream without /W"))?;
        let mut w = [0_usize; 3];
        if widths.len() < 3 {
            return Err(Failure::invalid("bad xref /W"));
        }
        for (slot, value) in w.iter_mut().zip(widths) {
            *slot = value
                .as_integer()
                .and_then(|width| usize::try_from(width).ok())
                .filter(|width| *width <= 8)
                .ok_or_else(|| Failure::invalid("bad xref /W"))?;
        }
        let [w0, w1, w2] = w;
        let row = (w0.saturating_add(w1)).saturating_add(w2);
        if row == 0 {
            return Err(Failure::invalid("empty xref row"));
        }
        let size = stream
            .dict
            .get(b"Size")
            .and_then(Object::as_integer)
            .unwrap_or(0);
        let index: Vec<i64> = match stream.dict.get(b"Index").and_then(Object::as_array) {
            Some(items) => items.iter().filter_map(Object::as_integer).collect(),
            None => vec![0, size],
        };
        let data = self.stream_data(&stream)?;
        let mut entries = Vec::new();
        let mut cursor = 0_usize;
        for pair in index.chunks(2) {
            let [start, count] = pair else { break };
            if *start < 0 || *count < 0 {
                continue;
            }
            for offset in 0..*count {
                let Some(bytes) = data.get(cursor..cursor.saturating_add(row)) else {
                    break;
                };
                cursor = cursor.saturating_add(row);
                let (kind, rest) = bytes.split_at(w0);
                let (second, third) = rest.split_at(w1);
                let kind = if w0 == 0 { 1 } else { be_value(kind) };
                let second = be_value(second);
                let third = be_value(third);
                let Ok(number) = u32::try_from(start.saturating_add(offset)) else {
                    continue;
                };
                let entry = match kind {
                    0 => Entry::Free,
                    1 => match usize::try_from(second) {
                        Ok(offset) => Entry::Offset(offset),
                        Err(_) => Entry::Free,
                    },
                    2 => match (u32::try_from(second), u32::try_from(third)) {
                        (Ok(stream), Ok(index)) => Entry::Compressed { stream, index },
                        _ => Entry::Free,
                    },
                    _ => continue,
                };
                entries.push((number, entry));
            }
        }
        Ok(Section {
            entries,
            trailer: stream.dict,
            hybrid: None,
        })
    }

    fn rebuild(&self) -> Outcome<()> {
        self.repaired.set(true);
        self.shift.set(0);
        let data = self.bytes;
        let bound = self.object_bound();
        let nesting = self.limits.max_nesting;
        let mut table: Vec<Entry> = Vec::new();
        let mut trailers: Vec<Dict> = Vec::new();
        let mut catalogs: Vec<u32> = Vec::new();
        let mut object_streams: Vec<(u32, usize)> = Vec::new();
        let mut pos = 0_usize;
        while let Some(rest) = data.get(pos..) {
            let Some(found) = rest.iter().position(|&byte| byte == b'o' || byte == b't') else {
                break;
            };
            let at = pos.saturating_add(found);
            if keyword_at(data, at, b"obj") {
                let Some(start) = header_before(data, at, pos) else {
                    pos = at.saturating_add(3);
                    continue;
                };
                match parse_indirect_object(data, start, nesting, |_| None) {
                    Ok(parsed) => {
                        let number = parsed.obj_ref.number;
                        let index = widen(number);
                        if index < bound {
                            if table.len() <= index {
                                table.resize(index.saturating_add(1), Entry::Unset);
                            }
                            if let Some(slot) = table.get_mut(index) {
                                *slot = Entry::Offset(start);
                            }
                        }
                        if let Some(dict) = parsed.object.as_dict() {
                            if name_is(dict, b"Type", b"Catalog") {
                                catalogs.push(number);
                            } else if name_is(dict, b"Type", b"XRef") {
                                trailers.push(dict.clone());
                            } else if name_is(dict, b"Type", b"ObjStm") {
                                object_streams.push((number, start));
                            }
                        }
                        pos = parsed.end.max(at.saturating_add(3));
                    }
                    Err(_) => pos = at.saturating_add(3),
                }
            } else if keyword_at(data, at, b"trailer") {
                let mut parser = Parser::new(data, at.saturating_add(7), nesting, true);
                if let Ok(Object::Dict(dict)) = parser.parse_object() {
                    trailers.push(dict);
                    pos = parser.position().max(at.saturating_add(7));
                } else {
                    pos = at.saturating_add(7);
                }
            } else {
                pos = at.saturating_add(1);
            }
        }
        let mut merged = Dict::default();
        for trailer in &trailers {
            for (key, value) in &trailer.entries {
                if matches!(key.as_slice(), b"Root" | b"Encrypt" | b"Info" | b"ID") {
                    match merged.entries.iter_mut().find(|(name, _)| name == key) {
                        Some(slot) => slot.1 = value.clone(),
                        None => merged.entries.push((key.clone(), value.clone())),
                    }
                }
            }
        }
        self.install(table, merged);
        let encrypted = self
            .trailer
            .borrow()
            .get(b"Encrypt")
            .is_some_and(|value| !matches!(value, Object::Null));
        if encrypted {
            return Ok(());
        }
        let mut compressed: Vec<u32> = Vec::new();
        let mut seen: HashSet<u32> = HashSet::new();
        for (number, offset) in object_streams {
            if !seen.insert(number) {
                continue;
            }
            let Ok(stream) = self.object_stream(number) else {
                continue;
            };
            let mut table = self.table.borrow_mut();
            for (index, (member, _)) in stream.entries.iter().enumerate() {
                let slot_index = widen(*member);
                if slot_index >= bound {
                    continue;
                }
                if table.len() <= slot_index {
                    table.resize(slot_index.saturating_add(1), Entry::Unset);
                }
                let Some(slot) = table.get_mut(slot_index) else {
                    continue;
                };
                let replace = match *slot {
                    Entry::Unset | Entry::Free | Entry::Compressed { .. } => true,
                    Entry::Offset(existing) => existing < offset,
                };
                if replace {
                    *slot = Entry::Compressed {
                        stream: number,
                        index: u32::try_from(index).unwrap_or(u32::MAX),
                    };
                    compressed.push(*member);
                }
            }
            drop(table);
            let len = self.table.borrow().len();
            let mut cache = self.cache.borrow_mut();
            if cache.len() < len {
                cache.resize(len, None);
            }
        }
        if self.root_valid() {
            return Ok(());
        }
        for number in catalogs.iter().rev().chain(compressed.iter().rev()) {
            let candidate = ObjRef {
                number: *number,
                generation: 0,
            };
            let is_catalog = matches!(
                lenient(self.load(candidate)),
                Ok(Some(object)) if object
                    .as_dict()
                    .is_some_and(|dict| name_is(dict, b"Type", b"Catalog"))
            );
            if !is_catalog {
                continue;
            }
            self.trailer
                .borrow_mut()
                .insert(b"Root", Object::Ref(candidate));
            if self.root_valid() {
                return Ok(());
            }
        }
        Err(Failure::invalid("no document catalog found"))
    }

    pub(crate) fn load(&self, reference: ObjRef) -> Outcome<Rc<Object>> {
        let index = widen(reference.number);
        if let Some(hit) = self.cache.borrow().get(index).and_then(Clone::clone) {
            return Ok(hit);
        }
        let entry = self
            .table
            .borrow()
            .get(index)
            .copied()
            .unwrap_or(Entry::Unset);
        let loaded = match entry {
            Entry::Unset | Entry::Free => return Ok(Rc::new(Object::Null)),
            Entry::Offset(offset) => self.load_at(reference.number, offset),
            Entry::Compressed { stream, index } => {
                self.load_compressed(reference.number, stream, index)
            }
        };
        match loaded {
            Ok(object) => {
                let object = Rc::new(object);
                if let Some(slot) = self.cache.borrow_mut().get_mut(index) {
                    *slot = Some(Rc::clone(&object));
                }
                Ok(object)
            }
            Err(failure) if failure.code == FailureCode::LimitExceeded || self.repaired.get() => {
                Err(failure)
            }
            Err(_) => {
                self.rebuild()?;
                self.load(reference)
            }
        }
    }

    fn load_at(&self, number: u32, offset: usize) -> Outcome<Object> {
        let start = offset.saturating_add(self.shift.get());
        let parsed = parse_indirect_object(self.bytes, start, self.limits.max_nesting, |length| {
            self.length_of(length)
        })?;
        if parsed.obj_ref.number != number {
            return Err(Failure::invalid("object number mismatch"));
        }
        Ok(parsed.object)
    }

    fn length_of(&self, reference: ObjRef) -> Option<i64> {
        if self.depth.get() >= MAX_LENGTH_DEPTH {
            return None;
        }
        self.depth.set(self.depth.get().saturating_add(1));
        let length = self
            .load(reference)
            .ok()
            .and_then(|object| object.as_integer());
        self.depth.set(self.depth.get().saturating_sub(1));
        length
    }

    fn load_compressed(&self, number: u32, stream: u32, index: u32) -> Outcome<Object> {
        let container = self
            .table
            .borrow()
            .get(widen(stream))
            .copied()
            .unwrap_or(Entry::Unset);
        if !matches!(container, Entry::Offset(_)) {
            return Err(Failure::invalid("object stream is not a direct object"));
        }
        let object_stream = self.object_stream(stream)?;
        let relative = match object_stream.entries.get(widen(index)) {
            Some(&(member, relative)) if member == number => Some(relative),
            _ => object_stream
                .entries
                .iter()
                .find(|(member, _)| *member == number)
                .map(|&(_, relative)| relative),
        }
        .ok_or_else(|| Failure::invalid("object missing from object stream"))?;
        let start = object_stream
            .first
            .checked_add(relative)
            .ok_or_else(|| Failure::invalid("object stream offset overflow"))?;
        Parser::new(&object_stream.data, start, self.limits.max_nesting, true).parse_object()
    }

    fn object_stream(&self, number: u32) -> Outcome<Rc<ObjectStream>> {
        if let Some(hit) = self.object_streams.borrow().get(&number) {
            return Ok(Rc::clone(hit));
        }
        let object = self.load(ObjRef {
            number,
            generation: 0,
        })?;
        let Object::Stream(stream) = &*object else {
            return Err(Failure::invalid("object stream expected"));
        };
        let data = self.stream_data(stream)?;
        let integer = |key: &[u8]| -> Outcome<Option<i64>> {
            let Some(value) = stream.dict.get(key) else {
                return Ok(None);
            };
            Ok(lenient(self.follow(value))?.and_then(|value| value.as_integer()))
        };
        let count = integer(b"N")?
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| Failure::invalid("object stream without /N"))?;
        let first = integer(b"First")?
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| Failure::invalid("object stream without /First"))?;
        if count > self.limits.max_objects || count > data.len() {
            return Err(Failure::limit("object stream too large"));
        }
        let mut entries = Vec::with_capacity(count);
        let mut pos = 0_usize;
        for _ in 0..count {
            pos = skip_whitespace_at(&data, pos);
            let Some(member) = read_unsigned(&data, &mut pos) else {
                break;
            };
            pos = skip_whitespace_at(&data, pos);
            let Some(relative) = read_unsigned(&data, &mut pos) else {
                break;
            };
            let (Ok(member), Ok(relative)) = (u32::try_from(member), usize::try_from(relative))
            else {
                break;
            };
            entries.push((member, relative));
        }
        let parsed = Rc::new(ObjectStream {
            data,
            first,
            entries,
        });
        self.object_streams
            .borrow_mut()
            .insert(number, Rc::clone(&parsed));
        Ok(parsed)
    }

    pub(crate) fn follow(&self, object: &Object) -> Outcome<Rc<Object>> {
        let Object::Ref(first) = object else {
            return Ok(Rc::new(object.clone()));
        };
        let mut current = self.load(*first)?;
        for _ in 0..MAX_REF_CHAIN {
            if let Object::Ref(next) = &*current {
                let next = *next;
                current = self.load(next)?;
            } else {
                return Ok(current);
            }
        }
        Ok(Rc::new(Object::Null))
    }

    fn resolve_deep(&self, object: &Object, depth: usize) -> Outcome<Object> {
        if depth > MAX_DEEP_RESOLVE {
            return Ok(Object::Null);
        }
        let resolved = self.follow(object)?;
        match &*resolved {
            Object::Array(items) => items
                .iter()
                .map(|item| self.resolve_deep(item, depth.saturating_add(1)))
                .collect::<Outcome<Vec<_>>>()
                .map(Object::Array),
            Object::Dict(dict) => {
                let mut out = Dict::default();
                for (key, value) in &dict.entries {
                    out.entries.push((
                        key.clone(),
                        self.resolve_deep(value, depth.saturating_add(1))?,
                    ));
                }
                Ok(Object::Dict(out))
            }
            other => Ok(other.clone()),
        }
    }

    fn rect(&self, object: &Object) -> Outcome<Option<[f64; 4]>> {
        let Some(resolved) = lenient(self.follow(object))? else {
            return Ok(None);
        };
        let Some(items) = resolved.as_array() else {
            return Ok(None);
        };
        if items.len() < 4 {
            return Ok(None);
        }
        let mut values = [0.0_f64; 4];
        for (slot, item) in values.iter_mut().zip(items) {
            let number = lenient(self.follow(item))?.and_then(|value| value.as_number());
            match number {
                Some(number) if number.is_finite() => *slot = number,
                _ => return Ok(None),
            }
        }
        let [x0, y0, x1, y1] = values;
        Ok(Some([x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)]))
    }

    fn page_info(&self, inherited: &Inherited) -> Outcome<PageInfo> {
        let valid = |rect: [f64; 4]| rect[2] > rect[0] && rect[3] > rect[1];
        let media_box = match &inherited.media_box {
            Some(object) => self.rect(object)?.filter(|rect| valid(*rect)),
            None => None,
        }
        .unwrap_or(DEFAULT_MEDIA_BOX);
        let crop_box = match &inherited.crop_box {
            Some(object) => self.rect(object)?.filter(|rect| valid(*rect)),
            None => None,
        }
        .map(|crop| {
            [
                crop[0].max(media_box[0]),
                crop[1].max(media_box[1]),
                crop[2].min(media_box[2]),
                crop[3].min(media_box[3]),
            ]
        })
        .filter(|rect| valid(*rect))
        .unwrap_or(media_box);
        let rotate = match &inherited.rotate {
            Some(object) => lenient(self.follow(object))?.and_then(|value| value.as_number()),
            None => None,
        }
        .map_or(0, normalize_rotation);
        Ok(PageInfo {
            media_box,
            crop_box,
            rotate,
        })
    }

    fn walk_pages(&self) -> Outcome<Vec<Page>> {
        let Some(catalog) = self.catalog()? else {
            return Err(Failure::invalid("missing document catalog"));
        };
        let Some(root) = catalog.as_dict().and_then(|dict| dict.get(b"Pages")) else {
            return Err(Failure::invalid("missing page tree"));
        };
        let mut pages: Vec<Page> = Vec::new();
        let mut visited: HashSet<u32> = HashSet::new();
        let mut stack: Vec<(Object, Inherited)> = vec![(root.clone(), Inherited::default())];
        while let Some((node, inherited)) = stack.pop() {
            let mut obj_ref = None;
            if let Object::Ref(reference) = &node {
                if !visited.insert(reference.number) {
                    continue;
                }
                obj_ref = Some(*reference);
            }
            if visited.len() > self.limits.max_objects {
                return Err(Failure::limit("page tree too large"));
            }
            let Some(resolved) = lenient(self.follow(&node))? else {
                continue;
            };
            let Some(dict) = resolved.as_dict() else {
                continue;
            };
            let merged = inherited.merged(dict);
            let kids = match dict.get(b"Kids") {
                Some(kids) if !name_is(dict, b"Type", b"Page") => {
                    lenient(self.follow(kids))?.filter(|kids| kids.as_array().is_some())
                }
                _ => None,
            };
            if let Some(kids) = kids {
                if let Some(items) = kids.as_array() {
                    for kid in items.iter().rev() {
                        stack.push((
                            kid.clone(),
                            Inherited {
                                resources: merged.resources.clone(),
                                media_box: merged.media_box.clone(),
                                crop_box: merged.crop_box.clone(),
                                rotate: merged.rotate.clone(),
                            },
                        ));
                    }
                }
                continue;
            }
            if name_is(dict, b"Type", b"Pages") {
                continue;
            }
            if pages.len() >= self.limits.max_pages {
                return Err(Failure::limit("page count exceeds limit"));
            }
            let resources = match &merged.resources {
                Some(object) => lenient(self.follow(object))?
                    .and_then(|value| value.as_dict().cloned())
                    .unwrap_or_default(),
                None => Dict::default(),
            };
            pages.push(Page {
                obj_ref,
                dict: dict.clone(),
                resources,
                info: self.page_info(&merged)?,
            });
        }
        Ok(pages)
    }

    pub(crate) fn pages(&self) -> Outcome<Vec<Page>> {
        let pages = self.walk_pages()?;
        if pages.is_empty() && !self.repaired.get() && self.rebuild().is_ok() {
            return self.walk_pages();
        }
        Ok(pages)
    }

    pub(crate) fn content(&self, page: &Page) -> Outcome<Vec<u8>> {
        let Some(contents) = page.dict.get(b"Contents") else {
            return Ok(Vec::new());
        };
        let Some(resolved) = lenient(self.follow(contents))? else {
            return Ok(Vec::new());
        };
        let max = self.limits.max_decoded_stream_bytes;
        let mut out: Vec<u8> = Vec::new();
        let mut append = |object: &Object| -> Outcome<()> {
            let Object::Stream(stream) = object else {
                return Ok(());
            };
            let Some(data) = lenient(self.stream_data(stream))? else {
                return Ok(());
            };
            if out.is_empty() {
                if data.len() > max {
                    return Err(Failure::limit("page content exceeds limit"));
                }
                out = data;
                return Ok(());
            }
            out.push(b'\n');
            if out.len().saturating_add(data.len()) > max {
                return Err(Failure::limit("page content exceeds limit"));
            }
            out.extend_from_slice(&data);
            Ok(())
        };
        match &*resolved {
            Object::Stream(_) => append(&resolved)?,
            Object::Array(items) => {
                for item in items {
                    if let Some(part) = lenient(self.follow(item))? {
                        append(&part)?;
                    }
                }
            }
            _ => {}
        }
        Ok(out)
    }

    pub(crate) fn links(&self, pages: &[Page]) -> Outcome<Vec<LinkInfo>> {
        let mut links = Vec::new();
        for (index, page) in pages.iter().enumerate() {
            let Ok(page_index) = u32::try_from(index) else {
                break;
            };
            let Some(annots) = page.dict.get(b"Annots") else {
                continue;
            };
            let Some(annots) = lenient(self.follow(annots))? else {
                continue;
            };
            let Some(items) = annots.as_array() else {
                continue;
            };
            for item in items {
                let Some(annotation) = lenient(self.follow(item))? else {
                    continue;
                };
                let Some(dict) = annotation.as_dict() else {
                    continue;
                };
                if !name_is(dict, b"Subtype", b"Link") {
                    continue;
                }
                let Some(action) = dict.get(b"A") else {
                    continue;
                };
                let Some(action) = lenient(self.follow(action))? else {
                    continue;
                };
                let Some(action) = action.as_dict() else {
                    continue;
                };
                if !name_is(action, b"S", b"URI") {
                    continue;
                }
                let Some(uri) = action.get(b"URI") else {
                    continue;
                };
                let Some(uri) = lenient(self.follow(uri))? else {
                    continue;
                };
                let Some(uri) = uri.as_string() else { continue };
                let Some(rect) = dict.get(b"Rect") else {
                    continue;
                };
                let Some(rect) = self.rect(rect)? else {
                    continue;
                };
                links.push(LinkInfo {
                    page_index,
                    rect,
                    uri: decode_text_string(uri),
                });
            }
        }
        Ok(links)
    }
}

fn be_value(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(0_u64, |value, &byte| value << 8 | u64::from(byte))
}

fn normalize_rotation(value: f64) -> i32 {
    if !value.is_finite() || value.fract() != 0.0 {
        return 0;
    }
    let degrees = f64_to_i64(value).rem_euclid(360);
    if degrees % 90 != 0 {
        return 0;
    }
    i32::try_from(degrees).unwrap_or(0)
}

impl Resolver for Document<'_> {
    fn resolve(&self, object: &Object) -> Outcome<Object> {
        match object {
            Object::Ref(_) => self.follow(object).map(|resolved| (*resolved).clone()),
            other => Ok(other.clone()),
        }
    }

    fn stream_data(&self, stream: &Stream) -> Outcome<Vec<u8>> {
        let raw = self
            .bytes
            .get(stream.data.clone())
            .ok_or_else(|| Failure::invalid("stream data out of range"))?;
        let max = self.limits.max_decoded_stream_bytes;
        let Some(filter) = stream.dict.get(b"Filter") else {
            return filters::decode_stream(&stream.dict, raw, max);
        };
        let mut resolved = Dict::default();
        for (key, value) in &stream.dict.entries {
            if matches!(key.as_slice(), b"Filter" | b"DecodeParms" | b"DP") {
                continue;
            }
            resolved.entries.push((key.clone(), value.clone()));
        }
        resolved
            .entries
            .push((b"Filter".to_vec(), self.resolve_deep(filter, 0)?));
        if let Some(parms) = stream
            .dict
            .get(b"DecodeParms")
            .or_else(|| stream.dict.get(b"DP"))
        {
            resolved
                .entries
                .push((b"DecodeParms".to_vec(), self.resolve_deep(parms, 0)?));
        }
        filters::decode_stream(&resolved, raw, max)
    }
}

pub(crate) fn inspect(
    bytes: &[u8],
    options: &InspectOptions,
    limits: &Limits,
) -> Outcome<Inspection> {
    if bytes.len() > limits.max_pdf_bytes {
        return Err(Failure::limit("pdf exceeds size limit"));
    }
    let document = Document::open(bytes, limits)?;
    let pages = document.pages()?;
    let mut inspection = Inspection {
        pages: pages.iter().map(|page| page.info).collect(),
        ..Inspection::default()
    };
    if options.links {
        inspection.links = document.links(&pages)?;
    }
    if options.text {
        let mut selected: Vec<usize> = Vec::new();
        match &options.page_indexes {
            Some(indexes) => {
                let mut seen = HashSet::new();
                for &index in indexes {
                    let position = usize::try_from(index)
                        .ok()
                        .filter(|position| *position < pages.len())
                        .ok_or_else(|| {
                            Failure::invalid(format!("page index {index} out of range"))
                        })?;
                    if seen.insert(position) {
                        selected.push(position);
                    }
                }
            }
            None => selected.extend(0..pages.len()),
        }
        let mut total_items = 0_usize;
        let mut total_bytes = 0_usize;
        for position in selected {
            let Some(page) = pages.get(position) else {
                continue;
            };
            let items = crate::text::extract_page(&document, page, limits)?;
            if items.len() > limits.max_items_per_page {
                return Err(Failure::limit("page text items exceed limit"));
            }
            total_items = total_items.saturating_add(items.len());
            if total_items > limits.max_items {
                return Err(Failure::limit("text items exceed limit"));
            }
            total_bytes = items
                .iter()
                .fold(total_bytes, |sum, item| sum.saturating_add(item.text.len()));
            if total_bytes > limits.max_text_bytes {
                return Err(Failure::limit("text bytes exceed limit"));
            }
            inspection.text.push(PageText {
                page_index: u32::try_from(position)
                    .map_err(|_| Failure::limit("page index out of range"))?,
                items,
            });
        }
    }
    Ok(inspection)
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
    use std::time::Instant;

    const CATALOG: &str = "<< /Type /Catalog /Pages 2 0 R >>";
    const PAGES: &str = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
    const PAGE: &str = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>";

    fn stream_object(dict: &str, data: &str) -> String {
        format!(
            "<< /Length {} {} >>\nstream\n{}\nendstream",
            data.len(),
            dict,
            data
        )
    }

    fn basic_objects() -> Vec<(u32, String)> {
        vec![
            (1, CATALOG.to_owned()),
            (2, PAGES.to_owned()),
            (3, PAGE.to_owned()),
            (4, stream_object("", "BT /F1 12 Tf (Hi) Tj ET")),
        ]
    }

    struct Built {
        bytes: Vec<u8>,
        xref: usize,
    }

    fn build_classic(objects: &[(u32, String)], extra: &str, skew: usize) -> Built {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        let mut offsets = Vec::new();
        for (number, body) in objects {
            offsets.push((*number, bytes.len()));
            bytes.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
        }
        let xref = bytes.len();
        let max = objects.iter().map(|(number, _)| *number).max().unwrap_or(0);
        bytes.extend_from_slice(format!("xref\n0 {}\n", max.saturating_add(1)).as_bytes());
        for number in 0..=max {
            match offsets.iter().find(|(n, _)| *n == number) {
                Some((_, offset)) => {
                    bytes.extend_from_slice(
                        format!("{:010} 00000 n \n", offset.saturating_add(skew)).as_bytes(),
                    );
                }
                None => bytes.extend_from_slice(b"0000000000 65535 f \n"),
            }
        }
        bytes.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R {extra} >>\nstartxref\n{xref}\n%%EOF\n",
                max.saturating_add(1)
            )
            .as_bytes(),
        );
        Built { bytes, xref }
    }

    fn basic_pdf() -> Vec<u8> {
        build_classic(&basic_objects(), "", 0).bytes
    }

    fn inspect_all(bytes: &[u8]) -> Outcome<Inspection> {
        inspect(
            bytes,
            &InspectOptions {
                text: true,
                links: true,
                page_indexes: None,
            },
            &Limits::default(),
        )
    }

    fn open(bytes: &[u8]) -> Document<'_> {
        Document::open(bytes, &Limits::default()).unwrap()
    }

    fn replace(bytes: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
        let at = find_bytes(bytes, 0, from).unwrap();
        let mut out = bytes[..at].to_vec();
        out.extend_from_slice(to);
        out.extend_from_slice(&bytes[at.saturating_add(from.len())..]);
        out
    }

    #[test]
    fn opens_classic_xref() {
        let bytes = basic_pdf();
        let document = open(&bytes);
        assert!(!document.was_repaired());
        let pages = document.pages().unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].info.media_box, [0.0, 0.0, 200.0, 100.0]);
        assert_eq!(pages[0].info.crop_box, [0.0, 0.0, 200.0, 100.0]);
        assert_eq!(pages[0].info.rotate, 0);
        assert_eq!(
            pages[0].obj_ref,
            Some(ObjRef {
                number: 3,
                generation: 0
            })
        );
        assert_eq!(
            document.content(&pages[0]).unwrap(),
            b"BT /F1 12 Tf (Hi) Tj ET"
        );
    }

    #[test]
    fn inspect_returns_pages_links_and_text_placeholder() {
        let bytes = basic_pdf();
        let result = inspect_all(&bytes).unwrap();
        assert_eq!(result.pages.len(), 1);
        assert!(result.links.is_empty());
        assert_eq!(result.text.len(), 1);
        assert_eq!(result.text[0].page_index, 0);
        let plain = inspect(&bytes, &InspectOptions::default(), &Limits::default()).unwrap();
        assert!(plain.text.is_empty());
    }

    #[test]
    fn inspect_enforces_limits_and_page_indexes() {
        let bytes = basic_pdf();
        let tiny = Limits {
            max_pdf_bytes: 10,
            ..Limits::default()
        };
        let error = inspect(&bytes, &InspectOptions::default(), &tiny).unwrap_err();
        assert_eq!(error.code, FailureCode::LimitExceeded);
        let options = InspectOptions {
            text: true,
            links: false,
            page_indexes: Some(vec![5]),
        };
        let error = inspect(&bytes, &options, &Limits::default()).unwrap_err();
        assert_eq!(error.code, FailureCode::InvalidPdf);
        let options = InspectOptions {
            text: true,
            links: false,
            page_indexes: Some(vec![0, 0]),
        };
        let result = inspect(&bytes, &options, &Limits::default()).unwrap();
        assert_eq!(result.text.len(), 1);
        let few_pages = Limits {
            max_pages: 0,
            ..Limits::default()
        };
        let error = inspect(&bytes, &InspectOptions::default(), &few_pages).unwrap_err();
        assert_eq!(error.code, FailureCode::LimitExceeded);
    }

    fn be(value: u64, width: usize) -> Vec<u8> {
        value.to_be_bytes()[8_usize.saturating_sub(width)..].to_vec()
    }

    struct ObjStmFile {
        bytes: Vec<u8>,
        xref_stream: usize,
        content: usize,
        object_stream: usize,
    }

    fn object_stream_pdf(hybrid: bool) -> ObjStmFile {
        let compressed = [(1_u32, CATALOG), (2, PAGES), (3, PAGE)];
        let mut header = String::new();
        let mut bodies = String::new();
        for (number, body) in compressed {
            header.push_str(&format!("{number} {} ", bodies.len()));
            bodies.push_str(body);
            bodies.push('\n');
        }
        let data = format!("{header}{bodies}");
        let mut bytes = b"%PDF-1.5\n".to_vec();
        let content = bytes.len();
        bytes.extend_from_slice(
            format!("4 0 obj\n{}\nendobj\n", stream_object("", "BT (Hi) Tj ET")).as_bytes(),
        );
        let object_stream = bytes.len();
        bytes.extend_from_slice(
            format!(
                "5 0 obj\n{}\nendobj\n",
                stream_object(
                    &format!("/Type /ObjStm /N 3 /First {}", header.len()),
                    &data
                )
            )
            .as_bytes(),
        );
        let xref_stream = bytes.len();
        let mut rows: Vec<u8> = Vec::new();
        let row = |rows: &mut Vec<u8>, kind: u64, second: u64, third: u64| {
            rows.extend(be(kind, 1));
            rows.extend(be(second, 4));
            rows.extend(be(third, 1));
        };
        if hybrid {
            row(&mut rows, 2, 5, 0);
            row(&mut rows, 2, 5, 1);
            row(&mut rows, 2, 5, 2);
            let mut section = format!(
                "6 0 obj\n<< /Type /XRef /Size 7 /W [1 4 1] /Index [1 3] /Length {} >>\nstream\n",
                rows.len()
            )
            .into_bytes();
            section.extend_from_slice(&rows);
            section.extend_from_slice(b"\nendstream\nendobj\n");
            bytes.extend_from_slice(&section);
            let table = bytes.len();
            let mut text = String::from("xref\n0 7\n0000000000 65535 f \n");
            for _ in 0..3 {
                text.push_str("0000000000 00000 f \n");
            }
            text.push_str(&format!("{content:010} 00000 n \n"));
            text.push_str(&format!("{object_stream:010} 00000 n \n"));
            text.push_str(&format!("{xref_stream:010} 00000 n \n"));
            text.push_str(&format!(
                "trailer\n<< /Size 7 /Root 1 0 R /XRefStm {xref_stream} >>\nstartxref\n{table}\n%%EOF\n"
            ));
            bytes.extend_from_slice(text.as_bytes());
            return ObjStmFile {
                bytes,
                xref_stream,
                content,
                object_stream,
            };
        }
        row(&mut rows, 0, 0, 0);
        row(&mut rows, 2, 5, 0);
        row(&mut rows, 2, 5, 1);
        row(&mut rows, 2, 5, 2);
        row(&mut rows, 1, u64::try_from(content).unwrap(), 0);
        row(&mut rows, 1, u64::try_from(object_stream).unwrap(), 0);
        row(&mut rows, 1, u64::try_from(xref_stream).unwrap(), 0);
        let mut section = format!(
            "6 0 obj\n<< /Type /XRef /Size 7 /W [1 4 1] /Root 1 0 R /Length {} >>\nstream\n",
            rows.len()
        )
        .into_bytes();
        section.extend_from_slice(&rows);
        section.extend_from_slice(b"\nendstream\nendobj\n");
        bytes.extend_from_slice(&section);
        bytes.extend_from_slice(format!("startxref\n{xref_stream}\n%%EOF\n").as_bytes());
        ObjStmFile {
            bytes,
            xref_stream,
            content,
            object_stream,
        }
    }

    #[test]
    fn opens_xref_stream_with_object_stream() {
        let file = object_stream_pdf(false);
        let document = open(&file.bytes);
        assert!(!document.was_repaired());
        let pages = document.pages().unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].info.media_box, [0.0, 0.0, 200.0, 100.0]);
        assert_eq!(document.content(&pages[0]).unwrap(), b"BT (Hi) Tj ET");
        assert!(file.xref_stream > file.object_stream && file.object_stream > file.content);
    }

    #[test]
    fn opens_hybrid_xref_stream() {
        let file = object_stream_pdf(true);
        let document = open(&file.bytes);
        assert!(!document.was_repaired());
        let pages = document.pages().unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(document.content(&pages[0]).unwrap(), b"BT (Hi) Tj ET");
    }

    #[test]
    fn repairs_xref_stream_without_startxref() {
        let file = object_stream_pdf(false);
        let cut = find_bytes(&file.bytes, 0, b"startxref").unwrap();
        let bytes = file.bytes[..cut].to_vec();
        let document = open(&bytes);
        assert!(document.was_repaired());
        let pages = document.pages().unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(document.content(&pages[0]).unwrap(), b"BT (Hi) Tj ET");
    }

    #[test]
    fn incremental_update_prev_overrides_object() {
        let base = build_classic(&basic_objects(), "", 0);
        let mut bytes = base.bytes.clone();
        let updated = bytes.len();
        bytes.extend_from_slice(
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R >>\nendobj\n",
        );
        let xref = bytes.len();
        bytes.extend_from_slice(
            format!(
                "xref\n3 1\n{:010} 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R /Prev {} >>\nstartxref\n{xref}\n%%EOF\n",
                updated, base.xref
            )
            .as_bytes(),
        );
        let document = open(&bytes);
        assert!(!document.was_repaired());
        let pages = document.pages().unwrap();
        assert_eq!(pages[0].info.media_box, [0.0, 0.0, 300.0, 400.0]);
        assert_eq!(
            document.content(&pages[0]).unwrap(),
            b"BT /F1 12 Tf (Hi) Tj ET"
        );
    }

    #[test]
    fn incremental_update_free_entry_hides_object() {
        let base = build_classic(&basic_objects(), "", 0);
        let mut bytes = base.bytes.clone();
        let xref = bytes.len();
        bytes.extend_from_slice(
            format!(
                "xref\n4 1\n0000000000 00001 f \ntrailer\n<< /Size 5 /Root 1 0 R /Prev {} >>\nstartxref\n{xref}\n%%EOF\n",
                base.xref
            )
            .as_bytes(),
        );
        let document = open(&bytes);
        let pages = document.pages().unwrap();
        assert!(document.content(&pages[0]).unwrap().is_empty());
    }

    #[test]
    fn prev_cycle_terminates() {
        let base = build_classic(&basic_objects(), "", 0);
        let mut bytes = base.bytes;
        let xref = bytes.len();
        bytes.extend_from_slice(
            format!(
                "xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 5 /Root 1 0 R /Prev {xref} >>\nstartxref\n{xref}\n%%EOF\n"
            )
            .as_bytes(),
        );
        let document = open(&bytes);
        assert_eq!(document.pages().unwrap().len(), 1);
    }

    #[test]
    fn broken_startxref_triggers_repair() {
        let bytes = replace(&basic_pdf(), b"startxref\n", b"startxref\n9999");
        let document = open(&bytes);
        assert!(document.was_repaired());
        assert_eq!(document.pages().unwrap().len(), 1);
        let missing = {
            let cut = find_bytes(&basic_pdf(), 0, b"startxref").unwrap();
            basic_pdf()[..cut].to_vec()
        };
        let document = open(&missing);
        assert!(document.was_repaired());
        assert_eq!(document.pages().unwrap().len(), 1);
    }

    #[test]
    fn wrong_offsets_trigger_repair() {
        let bytes = build_classic(&basic_objects(), "", 7).bytes;
        let document = open(&bytes);
        let pages = document.pages().unwrap();
        assert!(document.was_repaired());
        assert_eq!(pages.len(), 1);
        assert_eq!(
            document.content(&pages[0]).unwrap(),
            b"BT /F1 12 Tf (Hi) Tj ET"
        );
    }

    #[test]
    fn missing_trailer_scans_for_catalog() {
        let built = build_classic(&basic_objects(), "", 0);
        let bytes = built.bytes[..built.xref].to_vec();
        let document = open(&bytes);
        assert!(document.was_repaired());
        assert_eq!(document.pages().unwrap().len(), 1);
    }

    #[test]
    fn repair_last_object_wins() {
        let mut objects = basic_objects();
        objects.push((
            3,
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 50 60] >>".to_owned(),
        ));
        let built = build_classic(&objects, "", 0);
        let bytes = built.bytes[..built.xref].to_vec();
        let document = open(&bytes);
        let pages = document.pages().unwrap();
        assert_eq!(pages[0].info.media_box, [0.0, 0.0, 50.0, 60.0]);
    }

    #[test]
    fn junk_before_header_uses_shifted_offsets() {
        let mut bytes = b"garbage garbage\n\n".to_vec();
        bytes.extend_from_slice(&basic_pdf());
        let document = open(&bytes);
        assert!(!document.was_repaired());
        assert_eq!(document.pages().unwrap().len(), 1);
    }

    #[test]
    fn junk_with_absolute_offsets_still_opens() {
        let junk = b"garbage garbage\n\n";
        let built = build_classic(&basic_objects(), "", junk.len());
        let startxref = built.xref;
        let mut bytes = junk.to_vec();
        bytes.extend_from_slice(&built.bytes);
        let bytes = replace(
            &bytes,
            format!("startxref\n{startxref}").as_bytes(),
            format!("startxref\n{}", startxref + junk.len()).as_bytes(),
        );
        let document = open(&bytes);
        assert_eq!(document.pages().unwrap().len(), 1);
    }

    #[test]
    fn indirect_length_is_resolved() {
        let mut objects = basic_objects();
        objects.pop();
        objects.push((
            4,
            "<< /Length 5 0 R >>\nstream\nBT (A) Tj ET\nendstream".to_owned(),
        ));
        objects.push((5, "12".to_owned()));
        let bytes = build_classic(&objects, "", 0).bytes;
        let document = open(&bytes);
        let pages = document.pages().unwrap();
        assert!(!document.was_repaired());
        assert_eq!(document.content(&pages[0]).unwrap(), b"BT (A) Tj ET");
    }

    #[test]
    fn indirect_length_cycle_does_not_hang() {
        let mut objects = basic_objects();
        objects.pop();
        objects.push((
            4,
            "<< /Length 5 0 R >>\nstream\nBT ET\nendstream".to_owned(),
        ));
        objects.push((5, "<< /Length 4 0 R >>\nstream\nxx\nendstream".to_owned()));
        let bytes = build_classic(&objects, "", 0).bytes;
        let document = open(&bytes);
        let pages = document.pages().unwrap();
        assert_eq!(document.content(&pages[0]).unwrap(), b"BT ET");
    }

    #[test]
    fn wrong_length_falls_back_to_endstream() {
        let mut objects = basic_objects();
        objects.pop();
        objects.push((
            4,
            "<< /Length 3 >>\nstream\nBT (A) Tj ET\nendstream".to_owned(),
        ));
        let bytes = build_classic(&objects, "", 0).bytes;
        let document = open(&bytes);
        let pages = document.pages().unwrap();
        assert_eq!(document.content(&pages[0]).unwrap(), b"BT (A) Tj ET");
    }

    #[test]
    fn contents_array_is_joined_and_skips_broken_parts() {
        let objects = vec![
            (1, CATALOG.to_owned()),
            (2, PAGES.to_owned()),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /Contents [4 0 R 9 0 R 5 0 R 7 0 R] >>".to_owned(),
            ),
            (4, stream_object("", "q")),
            (5, stream_object("", "Q")),
            (7, "42".to_owned()),
        ];
        let bytes = build_classic(&objects, "", 0).bytes;
        let document = open(&bytes);
        let pages = document.pages().unwrap();
        assert_eq!(document.content(&pages[0]).unwrap(), b"q\nQ");
        assert_eq!(pages[0].info.media_box, DEFAULT_MEDIA_BOX);
    }

    #[test]
    fn content_limit_is_enforced() {
        let bytes = basic_pdf();
        let limits = Limits {
            max_decoded_stream_bytes: 4,
            ..Limits::default()
        };
        let document = Document::open(&bytes, &limits).unwrap();
        let pages = document.pages().unwrap();
        let error = document.content(&pages[0]).unwrap_err();
        assert_eq!(error.code, FailureCode::LimitExceeded);
    }

    #[test]
    fn nested_page_tree_with_inheritance_and_cycle() {
        let objects = vec![
            (1, CATALOG.to_owned()),
            (
                2,
                "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 3 /Rotate 90 /MediaBox [0 0 400 500] /Resources << /Font << /F1 9 0 R >> >> >>".to_owned(),
            ),
            (
                3,
                "<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 2 0 R 3 0 R] /Rotate 180 >>".to_owned(),
            ),
            (4, "<< /Type /Page /Parent 3 0 R >>".to_owned()),
            (
                5,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 20] /Resources << /XObject << >> >> >>".to_owned(),
            ),
        ];
        let bytes = build_classic(&objects, "", 0).bytes;
        let document = open(&bytes);
        let pages = document.pages().unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].info.media_box, [0.0, 0.0, 400.0, 500.0]);
        assert_eq!(pages[0].info.rotate, 180);
        assert!(pages[0].resources.get(b"Font").is_some());
        assert_eq!(pages[1].info.media_box, [0.0, 0.0, 10.0, 20.0]);
        assert_eq!(pages[1].info.rotate, 90);
        assert!(pages[1].resources.get(b"XObject").is_some());
        assert!(pages[1].resources.get(b"Font").is_none());
    }

    #[test]
    fn page_tree_tolerates_garbage_kids() {
        let objects = vec![
            (1, CATALOG.to_owned()),
            (
                2,
                "<< /Type /Pages /Kids [3 0 R 77 0 R 5 null (x) 3 0 R] >>".to_owned(),
            ),
            (3, PAGE.to_owned()),
        ];
        let bytes = build_classic(&objects, "", 0).bytes;
        let document = open(&bytes);
        assert_eq!(document.pages().unwrap().len(), 1);
    }

    fn page_info_with(extra: &str) -> PageInfo {
        let objects = vec![
            (1, CATALOG.to_owned()),
            (2, PAGES.to_owned()),
            (3, format!("<< /Type /Page /Parent 2 0 R {extra} >>")),
        ];
        let bytes = build_classic(&objects, "", 0).bytes;
        let document = open(&bytes);
        document.pages().unwrap()[0].info
    }

    #[test]
    fn rotation_is_normalised() {
        assert_eq!(page_info_with("/Rotate 90").rotate, 90);
        assert_eq!(page_info_with("/Rotate -90").rotate, 270);
        assert_eq!(page_info_with("/Rotate 450").rotate, 90);
        assert_eq!(page_info_with("/Rotate 360").rotate, 0);
        assert_eq!(page_info_with("/Rotate 45").rotate, 0);
        assert_eq!(page_info_with("/Rotate 90.0").rotate, 90);
        assert_eq!(page_info_with("/Rotate 90.5").rotate, 0);
        assert_eq!(page_info_with("/Rotate /Foo").rotate, 0);
        assert_eq!(page_info_with("").rotate, 0);
    }

    #[test]
    fn boxes_are_normalised() {
        let info = page_info_with("");
        assert_eq!(info.media_box, DEFAULT_MEDIA_BOX);
        assert_eq!(info.crop_box, DEFAULT_MEDIA_BOX);
        assert_eq!(
            page_info_with("/MediaBox [200 100 0 0]").media_box,
            [0.0, 0.0, 200.0, 100.0]
        );
        assert_eq!(
            page_info_with("/MediaBox [0 0 0 0]").media_box,
            DEFAULT_MEDIA_BOX
        );
        assert_eq!(
            page_info_with("/MediaBox [1 2 3]").media_box,
            DEFAULT_MEDIA_BOX
        );
        assert_eq!(
            page_info_with("/MediaBox [a b c d]").media_box,
            DEFAULT_MEDIA_BOX
        );
        assert_eq!(
            page_info_with("/MediaBox [0.5 0.5 10.5 20.25]").media_box,
            [0.5, 0.5, 10.5, 20.25]
        );
    }

    #[test]
    fn cropbox_is_intersected_with_mediabox() {
        let info = page_info_with("/MediaBox [0 0 200 100] /CropBox [50 -20 500 60]");
        assert_eq!(info.crop_box, [50.0, 0.0, 200.0, 60.0]);
        let disjoint = page_info_with("/MediaBox [0 0 200 100] /CropBox [300 300 400 400]");
        assert_eq!(disjoint.crop_box, [0.0, 0.0, 200.0, 100.0]);
        let invalid = page_info_with("/MediaBox [0 0 200 100] /CropBox [5 5 5 5]");
        assert_eq!(invalid.crop_box, [0.0, 0.0, 200.0, 100.0]);
        let inner = page_info_with("/MediaBox [0 0 200 100] /CropBox [10 20 30 40]");
        assert_eq!(inner.crop_box, [10.0, 20.0, 30.0, 40.0]);
    }

    #[test]
    fn indirect_box_values_are_resolved() {
        let objects = vec![
            (1, CATALOG.to_owned()),
            (2, PAGES.to_owned()),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /MediaBox 5 0 R /Rotate 6 0 R >>".to_owned(),
            ),
            (5, "[0 0 7 0 R 8 0 R]".to_owned()),
            (6, "90".to_owned()),
            (7, "120".to_owned()),
            (8, "240".to_owned()),
        ];
        let bytes = build_classic(&objects, "", 0).bytes;
        let document = open(&bytes);
        let info = document.pages().unwrap()[0].info;
        assert_eq!(info.media_box, [0.0, 0.0, 120.0, 240.0]);
        assert_eq!(info.rotate, 90);
    }

    fn link_objects(page_extra: &str) -> Vec<(u32, String)> {
        vec![
            (1, CATALOG.to_owned()),
            (2, PAGES.to_owned()),
            (
                3,
                format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] {page_extra} >>"),
            ),
            (
                4,
                "<< /Type /Annot /Subtype /Link /Rect [100 50 10 20] /A << /S /URI /URI (https://example.com/a) >> >>".to_owned(),
            ),
            (
                5,
                "<< /Type /Annot /Subtype /Link /Rect [0 0 5 5] /A 6 0 R >>".to_owned(),
            ),
            (
                6,
                "<< /S /URI /URI <FEFF0068007400740070003A002F002F00E9> >>".to_owned(),
            ),
            (
                7,
                "<< /Subtype /Link /Rect [0 0 1 1] /Dest [3 0 R /Fit] >>".to_owned(),
            ),
            (
                8,
                "<< /Subtype /Text /Rect [0 0 1 1] /A << /S /URI /URI (x) >> >>".to_owned(),
            ),
            (
                9,
                "<< /Subtype /Link /Rect [0 0 1 1] /A << /S /GoTo /D (x) >> >>".to_owned(),
            ),
            (10, "[4 0 R 5 0 R 7 0 R 8 0 R 9 0 R 99 0 R null]".to_owned()),
        ]
    }

    #[test]
    fn extracts_uri_links() {
        let bytes = build_classic(
            &link_objects("/Annots [4 0 R 5 0 R 7 0 R 8 0 R 9 0 R 99 0 R]"),
            "",
            0,
        )
        .bytes;
        let result = inspect_all(&bytes).unwrap();
        assert_eq!(result.links.len(), 2);
        assert_eq!(
            result.links[0],
            LinkInfo {
                page_index: 0,
                rect: [10.0, 20.0, 100.0, 50.0],
                uri: "https://example.com/a".to_owned()
            }
        );
        assert_eq!(result.links[1].uri, "http://\u{e9}");
        assert_eq!(result.links[1].rect, [0.0, 0.0, 5.0, 5.0]);
        let indirect = build_classic(&link_objects("/Annots 10 0 R"), "", 0).bytes;
        assert_eq!(inspect_all(&indirect).unwrap().links.len(), 2);
        let none = inspect(&indirect, &InspectOptions::default(), &Limits::default()).unwrap();
        assert!(none.links.is_empty());
    }

    #[test]
    fn encrypted_documents_are_rejected() {
        let bytes = build_classic(&basic_objects(), "/Encrypt 9 0 R", 0).bytes;
        let error = Document::open(&bytes, &Limits::default()).err().unwrap();
        assert_eq!(error.code, FailureCode::EncryptedPdf);
        let built = build_classic(&basic_objects(), "/Encrypt << /Filter /Standard >>", 0);
        let broken = built.bytes[..built.xref].to_vec();
        let mut with_trailer = broken;
        with_trailer
            .extend_from_slice(b"trailer\n<< /Root 1 0 R /Encrypt << /Filter /Standard >> >>\n");
        let error = Document::open(&with_trailer, &Limits::default())
            .err()
            .unwrap();
        assert_eq!(error.code, FailureCode::EncryptedPdf);
    }

    #[test]
    fn garbage_is_rejected() {
        for input in [
            &b""[..],
            b"hello world",
            b"%PDF-1.4\n",
            b"%PDF-1.4\n1 0 obj << >> endobj",
        ] {
            let error = Document::open(input, &Limits::default()).err().unwrap();
            assert_eq!(error.code, FailureCode::InvalidPdf);
        }
    }

    #[test]
    fn document_without_pages_is_empty_not_error() {
        let objects = vec![
            (1, CATALOG.to_owned()),
            (2, "<< /Type /Pages /Kids [] /Count 0 >>".to_owned()),
        ];
        let bytes = build_classic(&objects, "", 0).bytes;
        let result = inspect_all(&bytes).unwrap();
        assert!(result.pages.is_empty());
    }

    #[test]
    fn resolver_follows_chains_and_missing_objects() {
        let objects = vec![
            (1, CATALOG.to_owned()),
            (2, PAGES.to_owned()),
            (3, PAGE.to_owned()),
            (5, "6 0 R".to_owned()),
            (6, "7 0 R".to_owned()),
            (7, "(done)".to_owned()),
            (8, "8 0 R".to_owned()),
        ];
        let bytes = build_classic(&objects, "", 0).bytes;
        let document = open(&bytes);
        let chained = document
            .resolve(&Object::Ref(ObjRef {
                number: 5,
                generation: 0,
            }))
            .unwrap();
        assert_eq!(chained, Object::String(b"done".to_vec()));
        let missing = document
            .resolve(&Object::Ref(ObjRef {
                number: 50,
                generation: 0,
            }))
            .unwrap();
        assert_eq!(missing, Object::Null);
        let looped = document
            .resolve(&Object::Ref(ObjRef {
                number: 8,
                generation: 0,
            }))
            .unwrap();
        assert_eq!(looped, Object::Null);
        assert_eq!(
            document.resolve(&Object::Integer(3)).unwrap(),
            Object::Integer(3)
        );
    }

    fn append_binary_stream_pdf(dict: &str, data: &[u8]) -> Vec<u8> {
        let objects = [
            (1_u32, CATALOG),
            (2_u32, PAGES),
            (3_u32, PAGE),
            (5_u32, "/FlateDecode"),
        ];
        let mut bytes = b"%PDF-1.7\n".to_vec();
        let mut offsets = Vec::new();
        for (number, body) in objects {
            offsets.push((number, bytes.len()));
            bytes.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
        }
        let stream_obj = bytes.len();
        offsets.push((4, stream_obj));
        bytes.extend_from_slice(b"4 0 obj\n");
        bytes.extend_from_slice(
            format!(
                "<< /Length {} {} /Filter 5 0 R >>\nstream\n",
                data.len(),
                dict
            )
            .as_bytes(),
        );
        bytes.extend_from_slice(data);
        bytes.extend_from_slice(b"\nendstream\nendobj\n");
        let xref = bytes.len();
        bytes.extend_from_slice(b"xref\n0 6\n0000000000 65535 f \n");
        for number in 1..=5 {
            let offset = offsets
                .iter()
                .find(|(n, _)| *n == number)
                .map_or(0, |(_, o)| *o);
            bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        bytes.extend_from_slice(
            format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
        );
        bytes
    }

    #[test]
    fn stream_data_resolves_indirect_filter_to_filters_module() {
        let flate_ab = [
            0x78_u8, 0x9c, 0x4b, 0x4c, 0x02, 0x00, 0x01, 0x26, 0x00, 0xc4,
        ];
        let bytes = append_binary_stream_pdf("", &flate_ab);
        let document = open(&bytes);
        let object = document
            .load(ObjRef {
                number: 4,
                generation: 0,
            })
            .unwrap();
        let Object::Stream(stream) = &*object else {
            panic!("not a stream");
        };
        assert_eq!(document.stream_data(stream).unwrap(), b"ab");
    }

    #[test]
    fn decodes_text_strings() {
        assert_eq!(decode_text_string(b"plain"), "plain");
        assert_eq!(
            decode_text_string(&[0xfe, 0xff, 0x00, 0x41, 0x00, 0xe9]),
            "A\u{e9}"
        );
        assert_eq!(decode_text_string(&[0xff, 0xfe, 0x41, 0x00]), "A");
        assert_eq!(
            decode_text_string(&[0xfe, 0xff, 0xd8, 0x3d, 0xde, 0x00]),
            "\u{1F600}"
        );
        assert_eq!(decode_text_string(&[0xfe, 0xff, 0xd8, 0x3d]), "\u{FFFD}");
        assert_eq!(
            decode_text_string(&[0xef, 0xbb, 0xbf, 0xc3, 0xa9]),
            "\u{e9}"
        );
        assert_eq!(
            decode_text_string(&[0x80, 0x81, 0x84, 0x92, 0xa0, 0xe9]),
            "\u{2022}\u{2020}\u{2014}\u{2122}\u{20ac}\u{e9}"
        );
        assert_eq!(
            decode_text_string(&[0x18, 0x1f, 0x93, 0x9e]),
            "\u{2d8}\u{2dc}\u{fb01}\u{17e}"
        );
        assert_eq!(decode_text_string(&[0x7f, 0x9f]), "\u{FFFD}\u{FFFD}");
    }

    struct XorShift(u64);

    impl XorShift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        fn below(&mut self, bound: usize) -> usize {
            let bound = u64::try_from(bound.max(1)).unwrap_or(1);
            usize::try_from(self.next().checked_rem(bound).unwrap_or(0)).unwrap_or(0)
        }
    }

    fn mutate(seed: &[u8], rng: &mut XorShift) -> Vec<u8> {
        let mut bytes = seed.to_vec();
        for _ in 0..=rng.below(8) {
            if bytes.is_empty() {
                break;
            }
            match rng.below(6) {
                0 => {
                    let at = rng.below(bytes.len());
                    bytes[at] = u8::try_from(rng.next() & 0xFF).unwrap();
                }
                1 => {
                    let at = rng.below(bytes.len());
                    let end = (at.saturating_add(rng.below(32))).min(bytes.len());
                    bytes.drain(at..end);
                }
                2 => {
                    let at = rng.below(bytes.len());
                    let extra: Vec<u8> = (0..rng.below(16))
                        .map(|_| u8::try_from(rng.next() & 0xFF).unwrap())
                        .collect();
                    bytes.splice(at..at, extra);
                }
                3 => {
                    let keep = rng.below(bytes.len());
                    bytes.truncate(keep);
                }
                4 => {
                    let at = rng.below(bytes.len());
                    let end = (at.saturating_add(rng.below(64))).min(bytes.len());
                    let chunk = bytes[at..end].to_vec();
                    let to = rng.below(bytes.len());
                    bytes.splice(to..to, chunk);
                }
                _ => {
                    let at = rng.below(bytes.len());
                    bytes[at] = b"0123456789 <>[]()/%\n"[rng.below(20)];
                }
            }
        }
        bytes
    }

    #[test]
    fn mutated_inputs_never_panic_and_stay_bounded() {
        let seeds = [
            basic_pdf(),
            object_stream_pdf(false).bytes,
            object_stream_pdf(true).bytes,
            build_classic(&link_objects("/Annots [4 0 R 5 0 R]"), "", 0).bytes,
        ];
        let limits = Limits {
            max_pdf_bytes: 1 << 20,
            max_decoded_stream_bytes: 1 << 20,
            max_objects: 100_000,
            max_pages: 1_000,
            ..Limits::default()
        };
        let options = InspectOptions {
            text: true,
            links: true,
            page_indexes: None,
        };
        let mut rng = XorShift(0x9e37_79b9_7f4a_7c15);
        let started = Instant::now();
        for iteration in 0..4000 {
            let seed = &seeds[iteration % seeds.len()];
            let mutated = mutate(seed, &mut rng);
            let one = Instant::now();
            let _ = inspect(&mutated, &options, &limits);
            assert!(
                one.elapsed().as_secs() < 5,
                "slow input at iteration {iteration}"
            );
        }
        assert!(started.elapsed().as_secs() < 120);
    }

    #[test]
    fn pathological_inputs_stay_linear() {
        let mut many_objects = b"%PDF-1.4\n".to_vec();
        for number in 1..20_000 {
            many_objects.extend_from_slice(format!("{number} 0 obj [ ").as_bytes());
        }
        let started = Instant::now();
        let _ = inspect_all(&many_objects);
        assert!(started.elapsed().as_secs() < 10);

        let mut nested = b"%PDF-1.4\n1 0 obj ".to_vec();
        nested.extend(std::iter::repeat_n(b'[', 200_000));
        let started = Instant::now();
        let _ = inspect_all(&nested);
        assert!(started.elapsed().as_secs() < 10);

        let mut huge_xref = b"%PDF-1.4\nxref\n0 99999999999\n".to_vec();
        huge_xref.extend_from_slice(b"trailer\n<< >>\nstartxref\n9\n");
        let _ = inspect_all(&huge_xref);
    }

    #[test]
    #[ignore]
    fn perf_two_thousand_pages() {
        let pages = 2000_u32;
        let mut objects = vec![(1_u32, CATALOG.to_owned())];
        let kids: String = (0..pages).map(|i| format!("{} 0 R ", 10 + i * 3)).collect();
        objects.push((
            2,
            format!("<< /Type /Pages /Kids [{kids}] /Count {pages} /MediaBox [0 0 612 792] >>"),
        ));
        for i in 0..pages {
            let page = 10 + i * 3;
            objects.push((
                page,
                format!(
                    "<< /Type /Page /Parent 2 0 R /Annots [{} 0 R] /Contents {} 0 R >>",
                    page + 1,
                    page + 2
                ),
            ));
            objects.push((
                page + 1,
                "<< /Subtype /Link /Rect [10 10 100 30] /A << /S /URI /URI (https://example.com/x) >> >>".to_owned(),
            ));
            objects.push((page + 2, stream_object("", "BT /F1 12 Tf (Hello) Tj ET")));
        }
        let bytes = build_classic(&objects, "", 0).bytes;
        let started = Instant::now();
        let document = Document::open(&bytes, &Limits::default()).unwrap();
        let opened = started.elapsed();
        let listed = Instant::now();
        let list = document.pages().unwrap();
        let pages_time = listed.elapsed();
        let linked = Instant::now();
        let links = document.links(&list).unwrap();
        let links_time = linked.elapsed();
        println!(
            "bytes={} open={opened:?} pages={} ({pages_time:?}) links={} ({links_time:?})",
            bytes.len(),
            list.len(),
            links.len()
        );
        assert_eq!(list.len(), widen(pages));
        assert_eq!(links.len(), widen(pages));
        let repaired = replace(&bytes, b"startxref\n", b"startxref\n9");
        let started = Instant::now();
        let document = Document::open(&repaired, &Limits::default()).unwrap();
        let count = document.pages().unwrap().len();
        println!("repair open+pages={:?} pages={count}", started.elapsed());
        assert_eq!(count, widen(pages));
    }
}
