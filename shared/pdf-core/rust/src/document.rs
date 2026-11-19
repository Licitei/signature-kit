use crate::num::widen;
use crate::num::{f64_to_i64, f64_to_usize};
use crate::syntax::is_whitespace;
use crate::text::Session;
use crate::text::{Capture, Reposition, extract_content};
use alloc::rc::Rc;
use core::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

use crate::encryption::Encryption;
use crate::failure::{Failure, FailureCode, Outcome};
use crate::filters;
use crate::inspection::{InspectOptions, Inspection, Limits, LinkInfo, PageInfo, PageText};
use crate::lazy::Sparse;
use crate::object::{Dict, ObjRef, Object, Resolver, Stream};
use crate::syntax::{
    IndirectObject, Parser, find_bytes, keyword_at, parse_indirect_object, parse_object_header,
    read_unsigned, skip_whitespace_at,
};

const HEADER_PROBE: usize = 1024;
pub(crate) const STARTXREF_PROBE: usize = 4096;
pub(crate) const MAX_SECTIONS: usize = 4096;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entry {
    Compressed { index: u32, stream: u32 },
    Free,
    Offset(usize),
    Unset,
}

#[derive(Debug)]
struct ObjectStream {
    data: Vec<u8>,
    entries: Vec<(u32, usize)>,
    first: usize,
}

#[derive(Debug)]
pub(crate) struct Section {
    pub entries: Vec<(u32, Entry)>,
    pub hybrid: Option<usize>,
    pub trailer: Dict,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Page {
    pub dict: Dict,
    pub info: PageInfo,
    pub obj_ref: Option<ObjRef>,
    pub resources: Dict,
    pub resources_ref: Option<ObjRef>,
}

#[derive(Clone, Default)]
struct Inherited {
    crop_box: Option<Rc<Object>>,
    media_box: Option<Rc<Object>>,
    resources: Option<Rc<Object>>,
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

#[derive(Default)]
struct Scan {
    catalogs: Vec<u32>,
    object_streams: Vec<(u32, usize)>,
    table: Vec<Entry>,
    trailers: Vec<Dict>,
}

#[derive(Debug)]
pub(crate) struct DocumentCache {
    objects: RefCell<Vec<Option<Rc<Object>>>>,
    streams: RefCell<HashMap<u32, Rc<ObjectStream>>>,
}

impl DocumentCache {
    pub(crate) fn new() -> Self {
        Self {
            objects: RefCell::new(Vec::new()),
            streams: RefCell::new(HashMap::new()),
        }
    }
}

struct SparseDocument<'data> {
    cache: &'data DocumentCache,
    source: &'data Sparse,
    table: &'data [Entry],
    trailer: &'data Dict,
}

pub(crate) struct Document<'data> {
    bytes: &'data [u8],
    cache: DocumentCache,
    depth: Cell<u32>,
    encryption: RefCell<Option<Encryption>>,
    limits: Limits,
    repaired: Cell<bool>,
    shift: Cell<usize>,
    sparse: Option<SparseDocument<'data>>,
    table: RefCell<Vec<Entry>>,
    trailer: RefCell<Dict>,
}

impl<'data> Document<'data> {
    fn adopt_catalog(&self, catalogs: &[u32], compressed: &[u32]) -> Outcome<()> {
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

    pub(crate) const fn bytes(&self) -> &'data [u8] {
        self.bytes
    }

    fn cache(&self) -> &DocumentCache {
        self.sparse
            .as_ref()
            .map_or(&self.cache, |sparse| sparse.cache)
    }

    pub(crate) fn catalog(&self) -> Outcome<Option<Rc<Object>>> {
        let root = self.sparse.as_ref().map_or_else(
            || self.trailer.borrow().get(b"Root").cloned(),
            |sparse| sparse.trailer.get(b"Root").cloned(),
        );
        let Some(root_next) = root else {
            return Ok(None);
        };
        let Some(object) = lenient(self.follow(&root_next))? else {
            return Ok(None);
        };
        Ok(object.as_dict().is_some().then_some(object))
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
        if let Object::Array(items) = &*resolved {
            for item in items {
                if let Some(part) = lenient(self.follow(item))? {
                    append(&part)?;
                }
            }
        } else {
            append(&resolved)?;
        }
        Ok(out)
    }

    fn encryption_dictionary(&self, reference: ObjRef) -> Option<Dict> {
        let entry = self.entry(reference.number);
        let Entry::Offset(offset) = entry else {
            return None;
        };
        let start = offset.saturating_add(self.shift.get());
        let parsed = self.parse_at(start, &|_| None).ok()??;
        if parsed.obj_ref == reference
            && let Object::Dict(dict) = parsed.object
        {
            return Some(dict);
        }
        None
    }

    fn entry(&self, number: u32) -> Entry {
        let index = widen(number);
        self.sparse
            .as_ref()
            .map_or_else(
                || self.table.borrow().get(index).copied(),
                |sparse| sparse.table.get(index).copied(),
            )
            .unwrap_or(Entry::Unset)
    }

    pub(crate) fn follow(&self, object: &Object) -> Outcome<Rc<Object>> {
        let Object::Ref(first) = object else {
            return Ok(Rc::new(object.clone()));
        };
        let mut current = self.load(*first)?;
        for _ in 0..MAX_REF_CHAIN {
            if let &Object::Ref(next) = &*current {
                current = self.load(next)?;
            } else {
                return Ok(current);
            }
        }
        Ok(Rc::new(Object::Null))
    }

    fn index_object_streams(&self, object_streams: Vec<(u32, usize)>) -> Vec<u32> {
        let bound = self.object_bound();
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
            let mut cache = self.cache.objects.borrow_mut();
            if cache.len() < len {
                cache.resize(len, None);
            }
        }
        compressed
    }

    fn install(&self, table: Vec<Entry>, trailer: Dict) {
        *self.cache.objects.borrow_mut() = vec![None; table.len()];
        *self.table.borrow_mut() = table;
        *self.trailer.borrow_mut() = trailer;
        self.cache.streams.borrow_mut().clear();
        *self.encryption.borrow_mut() = None;
    }

    pub(crate) fn is_encrypted(&self) -> bool {
        self.encryption.borrow().is_some()
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

    pub(crate) fn link_uri(&self, dict: &Dict) -> Outcome<Option<String>> {
        if !name_is(dict, b"Subtype", b"Link") {
            return Ok(None);
        }
        let Some(action) = dict.get(b"A") else {
            return Ok(None);
        };
        let Some(resolved_action) = lenient(self.follow(action))? else {
            return Ok(None);
        };
        let Some(action_dict) = resolved_action.as_dict() else {
            return Ok(None);
        };
        if !name_is(action_dict, b"S", b"URI") {
            return Ok(None);
        }
        let Some(uri) = action_dict.get(b"URI") else {
            return Ok(None);
        };
        let Some(resolved_uri) = lenient(self.follow(uri))? else {
            return Ok(None);
        };
        Ok(uri_from_action(&resolved_uri))
    }

    pub(crate) fn links(&self, pages: &[Page]) -> Outcome<Vec<LinkInfo>> {
        let mut links = Vec::new();
        for (index, page) in pages.iter().enumerate() {
            let Ok(page_index) = u32::try_from(index) else {
                break;
            };
            self.page_links(page, page_index, &mut links)?;
        }
        Ok(links)
    }

    pub(crate) fn load(&self, reference: ObjRef) -> Outcome<Rc<Object>> {
        let index = widen(reference.number);
        let cache = &self.cache().objects;
        if let Some(hit) = cache.borrow().get(index).and_then(Clone::clone) {
            return Ok(hit);
        }
        let before = self.pending_reads();
        let loaded = match self.entry(reference.number) {
            Entry::Unset | Entry::Free => return Ok(Rc::new(Object::Null)),
            Entry::Offset(offset) => self.load_at(reference.number, offset),
            Entry::Compressed {
                stream,
                index: position,
            } => self.load_compressed(reference.number, stream, position),
        };
        if self.pending_reads() != before {
            return Ok(Rc::new(Object::Null));
        }
        match loaded {
            Ok(object) => {
                let shared_object = Rc::new(object);
                if let Some(slot) = cache.borrow_mut().get_mut(index) {
                    *slot = Some(Rc::clone(&shared_object));
                }
                Ok(shared_object)
            }
            Err(failure)
                if matches!(
                    failure.code,
                    FailureCode::LimitExceeded | FailureCode::EncryptedPdf
                ) || self.repaired.get() =>
            {
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
        let Some(mut parsed) = self.parse_at(start, &|length| self.length_of(length))? else {
            return Ok(Object::Null);
        };
        if parsed.obj_ref.number != number {
            return Err(Failure::invalid("object number mismatch"));
        }
        if self.is_encrypted()
            && let Object::Stream(stream) = &mut parsed.object
        {
            self.resolve_crypt_filter(&mut stream.dict)?;
        }
        if let Some(encryption) = self.encryption.borrow().as_ref() {
            let window = self
                .sparse
                .as_ref()
                .map_or(self.bytes, |sparse| sparse.source.object(start).0);
            encryption.decrypt_object(&mut parsed.object, parsed.obj_ref, window)?;
        }
        if self.sparse.is_some()
            && let Object::Stream(stream) = &mut parsed.object
        {
            stream.data =
                stream.data.start.saturating_add(start)..stream.data.end.saturating_add(start);
        }
        Ok(parsed.object)
    }

    fn load_compressed(&self, number: u32, stream: u32, index: u32) -> Outcome<Object> {
        if !matches!(self.entry(stream), Entry::Offset(_)) {
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

    fn new(bytes: &'data [u8], limits: &Limits) -> Self {
        Self {
            bytes,
            shift: Cell::new(header_shift(bytes)),
            limits: *limits,
            sparse: None,
            table: RefCell::new(Vec::new()),
            trailer: RefCell::new(Dict::default()),
            cache: DocumentCache::new(),
            repaired: Cell::new(false),
            depth: Cell::new(0),
            encryption: RefCell::new(None),
        }
    }

    const fn object_bound(&self) -> usize {
        object_bound(self.bytes.len(), &self.limits)
    }

    pub(crate) fn object_count(&self) -> usize {
        self.table.borrow().len()
    }

    fn object_stream(&self, number: u32) -> Outcome<Rc<ObjectStream>> {
        let streams = &self.cache().streams;
        let before = self.pending_reads();
        if let Some(hit) = streams.borrow().get(&number) {
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
            Ok(lenient(self.follow(value))?.and_then(|inner_value| inner_value.as_integer()))
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
            let (Ok(member_u32), Ok(relative_u32)) =
                (u32::try_from(member), usize::try_from(relative))
            else {
                break;
            };
            entries.push((member_u32, relative_u32));
        }
        let parsed = Rc::new(ObjectStream {
            data,
            entries,
            first,
        });
        if self.pending_reads() == before {
            drop(streams.borrow_mut().insert(number, Rc::clone(&parsed)));
        }
        Ok(parsed)
    }

    pub(crate) fn open(bytes: &'data [u8], limits: &Limits) -> Outcome<Self> {
        if bytes.len() > limits.max_pdf_bytes {
            return Err(Failure::limit("pdf exceeds size limit"));
        }
        let document = Self::new(bytes, limits);
        if document.read_xref_chain().is_err() {
            document.rebuild()?;
        } else {
            document.unlock()?;
        }
        if !document.root_valid() && !document.repaired.get() {
            document.rebuild()?;
        }
        if !document.root_valid() {
            return Err(Failure::invalid("missing document catalog"));
        }
        Ok(document)
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
        .map_or(0_i32, normalize_rotation);
        Ok(PageInfo {
            crop_box,
            media_box,
            rotate,
        })
    }

    pub(crate) fn page_links(
        &self,
        page: &Page,
        page_index: u32,
        links: &mut Vec<LinkInfo>,
    ) -> Outcome<()> {
        let Some(annots) = page.dict.get(b"Annots") else {
            return Ok(());
        };
        let Some(resolved_annots) = lenient(self.follow(annots))? else {
            return Ok(());
        };
        let Some(items) = resolved_annots.as_array() else {
            return Ok(());
        };
        for item in items {
            let Some(annotation) = lenient(self.follow(item))? else {
                continue;
            };
            let Some(dict) = annotation.as_dict() else {
                continue;
            };
            let Some(uri_next) = self.link_uri(dict)? else {
                continue;
            };
            let Some(rect) = dict.get(b"Rect") else {
                continue;
            };
            let Some(rect_next) = self.rect(rect)? else {
                continue;
            };
            links.push(LinkInfo {
                page_index,
                rect: rect_next,
                uri: uri_next,
            });
        }
        Ok(())
    }

    pub(crate) fn pages(&self) -> Outcome<Vec<Page>> {
        let pages = self.walk_pages(false)?;
        if pages.is_empty() && !self.repaired.get() && self.rebuild().is_ok() {
            return self.walk_pages(false);
        }
        Ok(pages)
    }

    fn parse_at(
        &self,
        start: usize,
        resolve: &dyn Fn(ObjRef) -> Option<i64>,
    ) -> Outcome<Option<IndirectObject>> {
        let Some(sparse) = &self.sparse else {
            return parse_indirect_object(self.bytes, start, self.limits.max_nesting, resolve)
                .map(Some);
        };
        let (window, ceiling) = sparse.source.object(start);
        let end = start.saturating_add(window.len());
        let parsed = parse_indirect_object(window, 0, self.limits.max_nesting, resolve);
        if let Ok(object) = &parsed
            && (object.end < window.len() || end == ceiling)
            && object_terminated(window, object.end)
            && (!matches!(object.object, Object::Stream(_)) || end == ceiling)
        {
            return parsed.map(Some);
        }
        if end < ceiling {
            sparse.source.request(end, ceiling);
            return Ok(None);
        }
        drop(parsed?);
        Err(Failure::invalid("incomplete sparse object"))
    }

    pub(crate) fn pending_reads(&self) -> usize {
        self.sparse
            .as_ref()
            .map_or(0, |sparse| sparse.source.misses())
    }

    fn read_classic_section(&self, start: usize, complete: bool) -> Outcome<Section> {
        let data = self.bytes;
        let mut pos = start;
        let mut entries: Vec<(u32, Entry)> = Vec::new();
        loop {
            pos = skip_whitespace_at(data, pos);
            if keyword_at(data, pos, b"trailer") {
                pos = pos.saturating_add(7);
                break;
            }
            let mut first = read_unsigned(data, &mut pos)
                .ok_or_else(|| Failure::invalid("bad xref subsection"))?;
            pos = skip_whitespace_at(data, pos);
            let count = read_unsigned(data, &mut pos)
                .ok_or_else(|| Failure::invalid("bad xref subsection"))?;
            let remaining = data.len().saturating_sub(pos);
            if usize::try_from(count).map_or(true, |inner_count| inner_count > remaining) {
                return Err(Failure::invalid("xref subsection exceeds file"));
            }
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
                        Ok(inner_offset) if inner_offset > 0 => Entry::Offset(inner_offset),
                        _ => Entry::Free,
                    },
                    Some(b'f') => {
                        if index == 0 && first == 1 && generation == 0xFFFF {
                            first = 0;
                        }
                        Entry::Free
                    }
                    _ => return Err(Failure::invalid("bad xref entry flag")),
                };
                let number = u32::try_from(first.saturating_add(index))
                    .ok()
                    .ok_or_else(|| Failure::invalid("object number out of range"))?;
                entries.push((number, entry));
            }
        }
        let mut parser = Parser::new(data, pos, self.limits.max_nesting, true);
        let Object::Dict(trailer) = parser.parse_object()? else {
            return Err(Failure::invalid("trailer is not a dictionary"));
        };
        if !complete && parser.position() >= data.len() {
            return Err(Failure::invalid("incomplete xref trailer"));
        }
        let hybrid = trailer
            .get(b"XRefStm")
            .and_then(Object::as_integer)
            .and_then(|value| usize::try_from(value).ok());
        Ok(Section {
            entries,
            hybrid,
            trailer,
        })
    }

    fn read_section(&self, offset: usize) -> Outcome<Section> {
        let shift = self.shift.get();
        let candidates = [offset.saturating_add(shift), offset];
        for (index, candidate) in candidates.iter().enumerate() {
            if index == 1 && *candidate == candidates[0] {
                break;
            }
            let pos = skip_whitespace_at(self.bytes, *candidate);
            if keyword_at(self.bytes, pos, b"xref")
                || parse_object_header(self.bytes, pos).is_some()
            {
                return self.section_at(pos, true);
            }
        }
        Err(Failure::invalid("cross-reference section not found"))
    }

    fn read_stream_section(&self, pos: usize, complete: bool) -> Outcome<Section> {
        let parsed = parse_indirect_object(self.bytes, pos, self.limits.max_nesting, &|_| None)?;
        if !complete
            && (parsed.end >= self.bytes.len() || !object_terminated(self.bytes, parsed.end))
        {
            return Err(Failure::invalid("incomplete xref stream"));
        }
        let Object::Stream(stream) = parsed.object else {
            return Err(Failure::invalid("xref stream expected"));
        };
        if !complete
            && stream
                .dict
                .get(b"Length")
                .and_then(Object::as_integer)
                .and_then(|value| usize::try_from(value).ok())
                .is_some_and(|length| stream.data.start.saturating_add(length) >= self.bytes.len())
        {
            return Err(Failure::invalid("incomplete xref stream data"));
        }
        let widths = stream
            .dict
            .get(b"W")
            .and_then(Object::as_array)
            .ok_or_else(|| Failure::invalid("xref stream without /W"))?;
        let mut widths_by_field = [0_usize; 3];
        if widths.len() < 3 {
            return Err(Failure::invalid("bad xref /W"));
        }
        for (slot, value) in widths_by_field.iter_mut().zip(widths) {
            *slot = value
                .as_integer()
                .and_then(|width| usize::try_from(width).ok())
                .filter(|width| *width <= 8)
                .ok_or_else(|| Failure::invalid("bad xref /W"))?;
        }
        let [w0, w1, w2] = widths_by_field;
        let row = (w0.saturating_add(w1)).saturating_add(w2);
        if row == 0 {
            return Err(Failure::invalid("empty xref row"));
        }
        let size = stream
            .dict
            .get(b"Size")
            .and_then(Object::as_integer)
            .unwrap_or(0);
        let index: Vec<i64> = stream
            .dict
            .get(b"Index")
            .and_then(Object::as_array)
            .map_or_else(
                || vec![0, size],
                |items| items.iter().filter_map(Object::as_integer).collect(),
            );
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
                let kind_next = if w0 == 0 { 1 } else { be_value(kind) };
                let second_next = be_value(second);
                let third_next = be_value(third);
                let Ok(number) = u32::try_from(start.saturating_add(offset)) else {
                    continue;
                };
                let entry = match kind_next {
                    0 => Entry::Free,
                    1 => usize::try_from(second_next).map_or(Entry::Free, Entry::Offset),
                    2 => match (u32::try_from(second_next), u32::try_from(third_next)) {
                        (Ok(holder), Ok(position)) => Entry::Compressed {
                            stream: holder,
                            index: position,
                        },
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
                apply_entries(&mut table, extra.entries, self.object_bound());
            }
            apply_entries(&mut table, section.entries, self.object_bound());
            next = previous_section(&section.trailer);
            merge_section_trailer(&mut trailer, section.trailer);
        }
        let trailer_next = trailer.ok_or_else(|| Failure::invalid("missing trailer"))?;
        if table.is_empty() {
            return Err(Failure::invalid("empty cross-reference table"));
        }
        self.install(table, trailer_next);
        Ok(())
    }

    fn rebuild(&self) -> Outcome<()> {
        if self.sparse.is_some() {
            if !self.waiting() {
                self.repaired.set(true);
            }
            return Err(Failure::invalid(
                "sparse cross-reference table requires repair",
            ));
        }
        self.repaired.set(true);
        self.shift.set(0);
        let scan = self.scan_objects();
        self.install(scan.table, merged_trailer(&scan.trailers));
        self.unlock()?;
        let compressed = self.index_object_streams(scan.object_streams);
        if self.root_valid() {
            return Ok(());
        }
        self.adopt_catalog(&scan.catalogs, &compressed)
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
                Some(inner_number) if inner_number.is_finite() => *slot = inner_number,
                _ => return Ok(None),
            }
        }
        let [x0, y0, x1, y1] = values;
        Ok(Some([x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)]))
    }

    fn resolve_crypt_filter(&self, dict: &mut Dict) -> Outcome<()> {
        let Some(value) = dict.get(b"Filter") else {
            return Ok(());
        };
        let first = value
            .as_array()
            .and_then(<[Object]>::first)
            .unwrap_or(value);
        if !first.is_ref() && first.as_name() != Some(b"Crypt") {
            return Ok(());
        }
        if self.depth.get() >= MAX_LENGTH_DEPTH {
            return Err(Failure::invalid("cyclic stream filter reference"));
        }
        self.depth.set(self.depth.get().saturating_add(1));
        let resolved = self.resolve_filter_head(value);
        self.depth.set(self.depth.get().saturating_sub(1));
        let filter = resolved?;
        let first_filter = filter
            .as_array()
            .and_then(<[Object]>::first)
            .unwrap_or(&filter);
        if first_filter.as_name() != Some(b"Crypt") {
            return Ok(());
        }
        if let Some(parameters) = dict.get(b"DecodeParms").or_else(|| dict.get(b"DP")) {
            self.depth.set(self.depth.get().saturating_add(1));
            let resolved_parameters = self.resolve_filter_head(parameters);
            self.depth.set(self.depth.get().saturating_sub(1));
            dict.insert(b"DecodeParms", resolved_parameters?);
        }
        dict.insert(b"Filter", filter);
        Ok(())
    }

    fn resolve_deep(&self, object: &Object, depth: usize) -> Outcome<Object> {
        if depth > MAX_DEEP_RESOLVE {
            return Ok(Object::Null);
        }
        let resolved = self.follow(object)?;
        if let Object::Array(items) = &*resolved {
            items
                .iter()
                .map(|item| self.resolve_deep(item, depth.saturating_add(1)))
                .collect::<Outcome<Vec<_>>>()
                .map(Object::Array)
        } else if let Object::Dict(dict) = &*resolved {
            let mut out = Dict::default();
            for (key, value) in &dict.entries {
                out.entries.push((
                    key.clone(),
                    self.resolve_deep(value, depth.saturating_add(1))?,
                ));
            }
            Ok(Object::Dict(out))
        } else {
            Ok((*resolved).clone())
        }
    }

    fn resolve_filter_head(&self, value: &Object) -> Outcome<Object> {
        let resolved = self.follow(value)?;
        let Object::Array(items) = &*resolved else {
            return self.resolve_deep(&resolved, 0);
        };
        let mut filters = items.clone();
        if let Some(first) = filters.first_mut() {
            *first = self.resolve_deep(first, 0)?;
        }
        Ok(Object::Array(filters))
    }

    pub(crate) fn root_valid(&self) -> bool {
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

    fn scan_object(&self, scan: &mut Scan, at: usize, floor: usize, bound: usize) -> Option<usize> {
        let data = self.bytes;
        let start = header_before(data, at, floor)?;
        let parsed = parse_indirect_object(data, start, self.limits.max_nesting, &|_| None).ok()?;
        let number = parsed.obj_ref.number;
        let index = widen(number);
        if index < bound {
            if scan.table.len() <= index {
                scan.table.resize(index.saturating_add(1), Entry::Unset);
            }
            if let Some(slot) = scan.table.get_mut(index) {
                *slot = Entry::Offset(start);
            }
        }
        if let Some(dict) = parsed.object.as_dict() {
            if name_is(dict, b"Type", b"Catalog") {
                scan.catalogs.push(number);
            } else if name_is(dict, b"Type", b"XRef") {
                scan.trailers.push(dict.clone());
            } else if name_is(dict, b"Type", b"ObjStm") {
                scan.object_streams.push((number, start));
            }
        }
        Some(parsed.end.max(at.saturating_add(3)))
    }

    fn scan_objects(&self) -> Scan {
        let data = self.bytes;
        let bound = self.object_bound();
        let nesting = self.limits.max_nesting;
        let mut scan = Scan::default();
        let mut pos = 0_usize;
        while let Some(rest) = data.get(pos..) {
            let Some(found) = rest.iter().position(|&byte| byte == b'o' || byte == b't') else {
                break;
            };
            let at = pos.saturating_add(found);
            pos = if keyword_at(data, at, b"obj") {
                self.scan_object(&mut scan, at, pos, bound)
                    .unwrap_or_else(|| at.saturating_add(3))
            } else if keyword_at(data, at, b"trailer") {
                let mut parser = Parser::new(data, at.saturating_add(7), nesting, true);
                if let Ok(Object::Dict(dict)) = parser.parse_object() {
                    scan.trailers.push(dict);
                    parser.position().max(at.saturating_add(7))
                } else {
                    at.saturating_add(7)
                }
            } else {
                at.saturating_add(1)
            };
        }
        scan
    }

    fn section_at(&self, pos: usize, complete: bool) -> Outcome<Section> {
        if keyword_at(self.bytes, pos, b"xref") {
            self.read_classic_section(pos.saturating_add(4), complete)
        } else {
            self.read_stream_section(pos, complete)
        }
    }

    pub(crate) fn section_window(
        bytes: &'data [u8],
        limits: &Limits,
        complete: bool,
    ) -> Outcome<Section> {
        Self::new(bytes, limits).section_at(skip_whitespace_at(bytes, 0), complete)
    }

    pub(crate) const fn shift(&self) -> usize {
        self.shift.get()
    }

    pub(crate) fn sparse(
        source: &'data Sparse,
        table: &'data [Entry],
        trailer: &'data Dict,
        cache: &'data DocumentCache,
        limits: &Limits,
    ) -> Outcome<Self> {
        let mut document = Self::new(&[], limits);
        document.sparse = Some(SparseDocument {
            cache,
            source,
            table,
            trailer,
        });
        if cache.objects.borrow().is_empty() {
            *cache.objects.borrow_mut() = vec![None; table.len()];
        }
        document.unlock()?;
        Ok(document)
    }

    pub(crate) fn sparse_pages(&self, indexes: Option<&[u32]>) -> Outcome<Vec<(usize, Page)>> {
        if !self.root_valid() {
            return Err(Failure::invalid("missing document catalog"));
        }
        let first =
            indexes.is_some_and(|items| !items.is_empty() && items.iter().all(|item| *item == 0));
        let pages = self.walk_pages(first)?;
        if pages.is_empty() {
            return Err(Failure::invalid("page tree requires repair"));
        }
        let selected = select_pages(pages.len(), indexes)?;
        Ok(pick_pages(&pages, selected)
            .into_iter()
            .map(|(index, page)| (index, page.clone()))
            .collect())
    }

    pub(crate) fn startxref(&self) -> Option<usize> {
        find_startxref(self.bytes)
    }

    pub(crate) fn trailer(&self) -> Dict {
        self.trailer.borrow().clone()
    }

    fn unlock(&self) -> Outcome<()> {
        let stored = self.trailer.borrow();
        let trailer = self
            .sparse
            .as_ref()
            .map_or(&*stored, |sparse| sparse.trailer);
        let Some(setting) = trailer.get(b"Encrypt") else {
            return Ok(());
        };
        let encryption = match setting {
            Object::Null => return Ok(()),
            Object::Dict(dict) => Encryption::authenticate(dict, trailer, None),
            Object::Ref(reference) => match self.encryption_dictionary(*reference) {
                Some(dict) => Encryption::authenticate(&dict, trailer, Some(*reference)),
                None if !self.repaired.get() => {
                    drop(stored);
                    return self.rebuild();
                }
                None => None,
            },
            Object::Array(_)
            | Object::Bool(_)
            | Object::Integer(_)
            | Object::Name(_)
            | Object::Real(_)
            | Object::Stream(_)
            | Object::String(_) => None,
        };
        *self.encryption.borrow_mut() = Some(encryption.ok_or_else(|| {
            Failure::new(
                FailureCode::EncryptedPdf,
                "cannot open encrypted PDF with an empty user password",
            )
        })?);
        Ok(())
    }

    fn waiting(&self) -> bool {
        self.pending_reads() != 0
    }

    fn walk_pages(&self, first: bool) -> Outcome<Vec<Page>> {
        let Some(catalog) = self.catalog()? else {
            return Err(Failure::invalid("missing document catalog"));
        };
        let Some(root) = catalog.as_dict().and_then(|dict| dict.get(b"Pages")) else {
            return Err(Failure::invalid("missing page tree"));
        };
        let mut pages: Vec<Page> = Vec::new();
        let mut visited: HashSet<u32> = HashSet::new();
        let mut stack: Vec<(Object, Inherited)> = vec![(root.clone(), Inherited::default())];
        let mut declared = self.limits.max_pages;
        while let Some((node, inherited)) = stack.pop() {
            let obj_ref = if let Object::Ref(reference) = &node {
                if !visited.insert(reference.number) {
                    if first {
                        return self.walk_pages(false);
                    }
                    continue;
                }
                Some(*reference)
            } else {
                None
            };
            if visited.len() > self.limits.max_objects {
                return Err(Failure::limit("page tree too large"));
            }
            let Some(resolved) = lenient(self.follow(&node))? else {
                continue;
            };
            if first && self.waiting() {
                break;
            }
            let Some(dict) = resolved.as_dict() else {
                if first {
                    return self.walk_pages(false);
                }
                continue;
            };
            let merged = inherited.merged(dict);
            let kids = match dict.get(b"Kids") {
                Some(kids) if !name_is(dict, b"Type", b"Page") => {
                    lenient(self.follow(kids))?.filter(|inner_kids| inner_kids.as_array().is_some())
                }
                _ => None,
            };
            if first && self.waiting() {
                break;
            }
            if let Some(items) = kids.as_deref().and_then(Object::as_array) {
                if first {
                    let Some(count) = page_count(dict, items.len(), declared) else {
                        return self.walk_pages(false);
                    };
                    declared = count.saturating_sub(items.len().saturating_sub(1));
                }
                stack.extend(items.iter().rev().map(|kid| (kid.clone(), merged.clone())));
                continue;
            }
            if name_is(dict, b"Type", b"Pages") {
                if first {
                    return self.walk_pages(false);
                }
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
            let resources_ref = match merged.resources.as_deref() {
                Some(Object::Ref(reference)) => Some(*reference),
                _ => None,
            };
            pages.push(Page {
                obj_ref,
                dict: dict.clone(),
                resources,
                resources_ref,
                info: self.page_info(&merged)?,
            });
            if first {
                break;
            }
        }
        Ok(pages)
    }

    pub(crate) const fn was_repaired(&self) -> bool {
        self.repaired.get()
    }
}

impl Resolver for Document<'_> {
    fn resolve(&self, object: &Object) -> Outcome<Rc<Object>> {
        self.follow(object)
    }

    fn stream_data(&self, stream: &Stream) -> Outcome<Vec<u8>> {
        self.decode_stream(stream, None)
    }

    fn stream_prefix(&self, stream: &Stream, len: usize) -> Outcome<Vec<u8>> {
        self.decode_stream(stream, Some(len))
    }
}

impl Document<'_> {
    fn decode_stream(&self, stream: &Stream, prefix: Option<usize>) -> Outcome<Vec<u8>> {
        let raw = if let Some(sparse) = &self.sparse
            && stream.decrypted.is_none()
        {
            sparse
                .source
                .bytes(stream.data.clone())
                .ok_or_else(|| Failure::invalid("sparse stream data out of range"))?
        } else {
            stream.encoded_bytes(self.bytes)?
        };
        let max = self.limits.max_decoded_stream_bytes;
        let Some(filter) = stream.dict.get(b"Filter") else {
            return filters::decode_stream(&stream.dict, raw, max, prefix);
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
        filters::decode_stream(&resolved, raw, max, prefix)
    }
}

pub(crate) fn object_terminated(bytes: &[u8], end: usize) -> bool {
    end >= 6 && keyword_at(bytes, end.saturating_sub(6), b"endobj")
}

pub(crate) fn previous_section(trailer: &Dict) -> Option<usize> {
    trailer
        .get(b"Prev")
        .and_then(Object::as_number)
        .filter(|value| value.is_finite() && *value >= 0.0_f64)
        .map(f64_to_usize)
}

pub(crate) fn merge_section_trailer(trailer: &mut Option<Dict>, section: Dict) {
    if let Some(base) = trailer {
        for (key, value) in section.entries {
            if base.get(&key).is_none() {
                base.entries.push((key, value));
            }
        }
    } else {
        *trailer = Some(section);
    }
}

pub(crate) fn apply_entries(table: &mut Vec<Entry>, entries: Vec<(u32, Entry)>, bound: usize) {
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

pub(crate) const fn object_bound(size: usize, limits: &Limits) -> usize {
    let bound = size.saturating_mul(8).saturating_add(4096);
    if limits.max_objects < bound {
        limits.max_objects
    } else {
        bound
    }
}

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

pub(crate) fn decode_pdf_name(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut index = 0_usize;
    while let Some(byte) = bytes.get(index).copied() {
        index = index.saturating_add(1);
        if byte == b'#' {
            let h0 = bytes.get(index).copied();
            let h1 = bytes.get(index.saturating_add(1)).copied();
            if let (Some(inner_h0), Some(inner_h1)) = (h0, h1)
                && inner_h0.is_ascii_hexdigit()
                && inner_h1.is_ascii_hexdigit()
            {
                let hex = [inner_h0, inner_h1];
                if let Ok(text) = str::from_utf8(&hex)
                    && let Ok(value) = u8::from_str_radix(text, 16)
                {
                    out.push(char::from(value));
                    index = index.saturating_add(2);
                    continue;
                }
            }
            out.push('#');
        } else {
            out.push(char::from(byte));
        }
    }
    out
}

fn uri_from_action(value: &Object) -> Option<String> {
    if let Some(bytes) = value.as_string() {
        return Some(decode_text_string(bytes));
    }
    value.as_name().map(decode_pdf_name)
}

pub(crate) fn decode_text_string(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        let units = rest.chunks(2).map(|pair| match pair {
            [high, low] => (u16::from(*high) << 8_i32) | u16::from(*low),
            [high] => u16::from(*high) << 8_i32,
            _ => 0,
        });
        return char::decode_utf16(units)
            .map(|unit| unit.unwrap_or('\u{FFFD}'))
            .collect();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        let units = rest.chunks(2).map(|pair| match pair {
            [low, high] => (u16::from(*high) << 8_i32) | u16::from(*low),
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

fn lenient<T>(result: Outcome<T>) -> Outcome<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(failure)
            if matches!(
                failure.code,
                FailureCode::LimitExceeded | FailureCode::EncryptedPdf
            ) =>
        {
            Err(failure)
        }
        Err(_) => Ok(None),
    }
}

fn name_is(dict: &Dict, key: &[u8], expected: &[u8]) -> bool {
    dict.get(key)
        .and_then(Object::as_name)
        .is_some_and(|name| name == expected)
}

pub(crate) fn find_startxref(bytes: &[u8]) -> Option<usize> {
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
    let generation_end = back(keyword_index, is_whitespace, 4096)?;
    let generation_start = back(generation_end, |byte| byte.is_ascii_digit(), 10)?;
    let number_end = back(generation_start, is_whitespace, 4096)?;
    back(number_end, |byte| byte.is_ascii_digit(), 10)
}

fn merged_trailer(trailers: &[Dict]) -> Dict {
    let mut merged = Dict::default();
    for trailer in trailers {
        for (key, value) in &trailer.entries {
            if matches!(key.as_slice(), b"Root" | b"Encrypt" | b"Info" | b"ID") {
                merged.insert(key, value.clone());
            }
        }
    }
    merged
}

fn be_value(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(0_u64, |value, &byte| (value << 8_i32) | u64::from(byte))
}

fn normalize_rotation(value: f64) -> i32 {
    if !value.is_finite() || value.fract() != 0.0_f64 {
        return 0;
    }
    let degrees = f64_to_i64(value).rem_euclid(360);
    if degrees.rem_euclid(90) != 0 {
        return 0;
    }
    i32::try_from(degrees).unwrap_or(0)
}

fn page_count(dict: &Dict, kids: usize, declared: usize) -> Option<usize> {
    let count = usize::try_from(dict.get(b"Count")?.as_integer()?).ok()?;
    (kids > 0 && count >= kids && count <= declared).then_some(count)
}

pub(crate) fn pick_pages(pages: &[Page], selected: Vec<usize>) -> Vec<(usize, &Page)> {
    selected
        .into_iter()
        .filter_map(|index| pages.get(index).map(|page| (index, page)))
        .collect()
}

pub(crate) fn select_pages(count: usize, page_indexes: Option<&[u32]>) -> Outcome<Vec<usize>> {
    let Some(indexes) = page_indexes else {
        return Ok((0..count).collect());
    };
    let mut seen = HashSet::new();
    let mut chosen = Vec::with_capacity(indexes.len());
    for &index in indexes {
        let position = usize::try_from(index)
            .ok()
            .filter(|position| *position < count)
            .ok_or_else(|| Failure::invalid("page index out of range"))?;
        if seen.insert(position) {
            chosen.push(position);
        }
    }
    Ok(chosen)
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
        let selected = select_pages(pages.len(), options.page_indexes.as_deref())?;
        let mut total_items = 0_usize;
        let mut total_bytes = 0_usize;
        let mut session = Session::default();
        for position in selected {
            let Some(page) = pages.get(position) else {
                continue;
            };
            let capture = Capture {
                reposition: if options.runs {
                    Reposition::SplitGapped
                } else {
                    Reposition::Join
                },
                split_style: options.runs,
                structure: false,
            };
            let content = extract_content(&document, page, limits, capture, &mut session)?;
            let items = content.items();
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
                    .ok()
                    .ok_or_else(|| Failure::limit("page index out of range"))?,
                items,
            });
        }
    }
    Ok(inspection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lazy::{Lazy, Plan, Tuning};
    use crate::test_pdf::assert_exact;
    use core::fmt::Write as _;
    use core::hint::black_box;
    use core::iter;
    use core::time::Duration;
    use std::time::Instant;

    const CATALOG: &str = "<< /Type /Catalog /Pages 2 0 R >>";
    const PAGES: &str = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
    const PAGE: &str = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>";

    struct Built {
        bytes: Vec<u8>,
        xref: usize,
    }

    struct ObjStmFile {
        bytes: Vec<u8>,
        content: usize,
        object_stream: usize,
        xref_stream: usize,
    }

    struct XorShift(u64);

    impl XorShift {
        fn below(&mut self, bound: usize) -> usize {
            let bound_u64 = u64::try_from(bound.max(1)).unwrap_or(1);
            usize::try_from(self.next().checked_rem(bound_u64).unwrap_or(0)).unwrap_or(0)
        }

        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13_i32;
            x ^= x >> 7_i32;
            x ^= x << 17_i32;
            self.0 = x;
            x
        }
    }

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
            match offsets.iter().find(|(found, _)| *found == number) {
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
                runs: false,
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
        assert_exact(
            &pages[0].info.media_box,
            &[0.0_f64, 0.0_f64, 200.0_f64, 100.0_f64],
        );
        assert_exact(
            &pages[0].info.crop_box,
            &[0.0_f64, 0.0_f64, 200.0_f64, 100.0_f64],
        );
        assert_eq!(pages[0].info.rotate, 0_i32);
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
        assert_eq!(result.links, []);
        assert_eq!(result.text.len(), 1);
        assert_eq!(result.text[0].page_index, 0);
        let plain = inspect(&bytes, &InspectOptions::default(), &Limits::default()).unwrap();
        assert_eq!(plain.text, []);
    }

    #[test]
    fn inspect_runs_split_by_style_and_position_and_report_bold() {
        use crate::test_pdf::{bold, document, page, text};
        let content = [
            bold(28.0, 700.0, 9.0, "17/06/2026 15:39:26"),
            text(122.0, 700.0, 9.0, "MENSAGEM PREGOEIRO"),
            "BT /F1 9 Tf 1 0 0 1 28 680 Tm (Marca: ) Tj /F2 9 Tf (ACME) Tj ET\n".to_owned(),
            text(28.0, 660.0, 9.0, "AB"),
            text(40.006, 660.0, 9.0, "CD"),
            text(28.0, 640.0, 9.0, "EF"),
            text(39.004, 640.0, 9.0, "    "),
            text(49.0, 640.0, 9.0, "GH"),
        ]
        .concat();
        let bytes = document(&[page(content)], &[]);
        let run = |runs: bool| {
            let inspection = inspect(
                &bytes,
                &InspectOptions {
                    runs,
                    text: true,
                    links: false,
                    page_indexes: None,
                },
                &Limits::default(),
            )
            .unwrap();
            let page = inspection.text.into_iter().next().unwrap();
            let texts: Vec<String> = page
                .items
                .iter()
                .map(|item| item.text.trim().to_owned())
                .collect();
            let styles: Vec<u8> = page.items.iter().map(|item| item.style).collect();
            (texts, styles)
        };
        let (merged, _) = run(false);
        assert_eq!(merged.len(), 4);
        let (texts, styles) = run(true);
        assert_eq!(
            texts,
            [
                "17/06/2026 15:39:26",
                "MENSAGEM PREGOEIRO",
                "Marca:",
                "ACME",
                "ABCD",
                "EF",
                "GH"
            ]
        );
        assert_eq!(styles, [1, 0, 0, 1, 0, 0, 0]);
    }

    #[test]
    fn inspect_runs_keep_kerning_split_same_pen_words_and_bold_stroked_text() {
        use crate::test_pdf::{document, page};
        let content = [
            "BT /F1 9 Tf 1 0 0 1 28 700 Tm [(Ka) -400 (Kb)] TJ ET\n",
            "BT /F1 9 Tf 1 0 0 1 28 680 Tm (Rua ) Tj 1 0 0 1 47.008 680 Tm (Principal) Tj ET\n",
            "BT /F1 9 Tf 2 Tr 1 0 0 1 28 660 Tm (Forte) Tj ET\n",
        ]
        .concat();
        let bytes = document(&[page(content)], &[]);
        let inspection = inspect(
            &bytes,
            &InspectOptions {
                runs: true,
                text: true,
                links: false,
                page_indexes: None,
            },
            &Limits::default(),
        )
        .unwrap();
        let page = inspection.text.into_iter().next().unwrap();
        let texts: Vec<&str> = page.items.iter().map(|item| item.text.as_str()).collect();
        assert_eq!(texts, ["Ka Kb", "Rua", "Principal", "Forte"]);
        let styles: Vec<u8> = page.items.iter().map(|item| item.style).collect();
        assert_eq!(styles, [0, 0, 0, 1]);
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
            runs: false,
            text: true,
            links: false,
            page_indexes: Some(vec![5]),
        };
        let error_2 = inspect(&bytes, &options, &Limits::default()).unwrap_err();
        assert_eq!(error_2.code, FailureCode::InvalidPdf);
        let options_2 = InspectOptions {
            runs: false,
            text: true,
            links: false,
            page_indexes: Some(vec![0, 0]),
        };
        let result = inspect(&bytes, &options_2, &Limits::default()).unwrap();
        assert_eq!(result.text.len(), 1);
        let few_pages = Limits {
            max_pages: 0,
            ..Limits::default()
        };
        let error_3 = inspect(&bytes, &InspectOptions::default(), &few_pages).unwrap_err();
        assert_eq!(error_3.code, FailureCode::LimitExceeded);
    }

    fn be(value: u64, width: usize) -> Vec<u8> {
        value.to_be_bytes()[8_usize.saturating_sub(width)..].to_vec()
    }

    fn object_stream_pdf(hybrid: bool) -> ObjStmFile {
        let compressed = [(1_u32, CATALOG), (2, PAGES), (3, PAGE)];
        let mut header = String::new();
        let mut bodies = String::new();
        for (number, body) in compressed {
            write!(header, "{number} {} ", bodies.len()).unwrap();
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
        let row = |sink: &mut Vec<u8>, kind: u64, second: u64, third: u64| {
            sink.extend(be(kind, 1));
            sink.extend(be(second, 4));
            sink.extend(be(third, 1));
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
            for _ in 0_i32..3_i32 {
                text.push_str("0000000000 00000 f \n");
            }
            writeln!(text, "{content:010} 00000 n ").unwrap();
            writeln!(text, "{object_stream:010} 00000 n ").unwrap();
            writeln!(text, "{xref_stream:010} 00000 n ").unwrap();
            write!(
                text,
                "trailer\n<< /Size 7 /Root 1 0 R /XRefStm {xref_stream} >>\nstartxref\n{table}\n%%EOF\n"
            )
            .unwrap();
            bytes.extend_from_slice(text.as_bytes());
            return ObjStmFile {
                bytes,
                content,
                object_stream,
                xref_stream,
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
            content,
            object_stream,
            xref_stream,
        }
    }

    #[test]
    fn opens_xref_stream_with_object_stream() {
        let file = object_stream_pdf(false);
        let document = open(&file.bytes);
        assert!(!document.was_repaired());
        let pages = document.pages().unwrap();
        assert_eq!(pages.len(), 1);
        assert_exact(
            &pages[0].info.media_box,
            &[0.0_f64, 0.0_f64, 200.0_f64, 100.0_f64],
        );
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
        assert_exact(
            &pages[0].info.media_box,
            &[0.0_f64, 0.0_f64, 300.0_f64, 400.0_f64],
        );
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
        assert_eq!(document.content(&pages[0]).unwrap(), []);
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
        let document_2 = open(&missing);
        assert!(document_2.was_repaired());
        assert_eq!(document_2.pages().unwrap().len(), 1);
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
        assert_exact(
            &pages[0].info.media_box,
            &[0.0_f64, 0.0_f64, 50.0_f64, 60.0_f64],
        );
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
        let bytes_next = replace(
            &bytes,
            format!("startxref\n{startxref}").as_bytes(),
            format!("startxref\n{}", startxref + junk.len()).as_bytes(),
        );
        let document = open(&bytes_next);
        assert_eq!(document.pages().unwrap().len(), 1);
    }

    #[test]
    fn indirect_length_is_resolved() {
        let mut objects = basic_objects();
        drop(objects.pop());
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
        drop(objects.pop());
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
        drop(objects.pop());
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
        assert_exact(&pages[0].info.media_box, &DEFAULT_MEDIA_BOX);
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
        assert_exact(
            &pages[0].info.media_box,
            &[0.0_f64, 0.0_f64, 400.0_f64, 500.0_f64],
        );
        assert_eq!(pages[0].info.rotate, 180_i32);
        assert!(pages[0].resources.get(b"Font").is_some());
        assert_exact(
            &pages[1].info.media_box,
            &[0.0_f64, 0.0_f64, 10.0_f64, 20.0_f64],
        );
        assert_eq!(pages[1].info.rotate, 90_i32);
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
        assert_eq!(page_info_with("/Rotate 90").rotate, 90_i32);
        assert_eq!(page_info_with("/Rotate -90").rotate, 270_i32);
        assert_eq!(page_info_with("/Rotate 450").rotate, 90_i32);
        assert_eq!(page_info_with("/Rotate 360").rotate, 0_i32);
        assert_eq!(page_info_with("/Rotate 45").rotate, 0_i32);
        assert_eq!(page_info_with("/Rotate 90.0").rotate, 90_i32);
        assert_eq!(page_info_with("/Rotate 90.5").rotate, 0_i32);
        assert_eq!(page_info_with("/Rotate /Foo").rotate, 0_i32);
        assert_eq!(page_info_with("").rotate, 0_i32);
    }

    #[test]
    fn boxes_are_normalised() {
        let info = page_info_with("");
        assert_exact(&info.media_box, &DEFAULT_MEDIA_BOX);
        assert_exact(&info.crop_box, &DEFAULT_MEDIA_BOX);
        assert_exact(
            &page_info_with("/MediaBox [200 100 0 0]").media_box,
            &[0.0_f64, 0.0_f64, 200.0_f64, 100.0_f64],
        );
        assert_exact(
            &page_info_with("/MediaBox [0 0 0 0]").media_box,
            &DEFAULT_MEDIA_BOX,
        );
        assert_exact(
            &page_info_with("/MediaBox [1 2 3]").media_box,
            &DEFAULT_MEDIA_BOX,
        );
        assert_exact(
            &page_info_with("/MediaBox [a b c d]").media_box,
            &DEFAULT_MEDIA_BOX,
        );
        assert_exact(
            &page_info_with("/MediaBox [0.5 0.5 10.5 20.25]").media_box,
            &[0.5_f64, 0.5_f64, 10.5_f64, 20.25_f64],
        );
    }

    #[test]
    fn cropbox_is_intersected_with_mediabox() {
        let info = page_info_with("/MediaBox [0 0 200 100] /CropBox [50 -20 500 60]");
        assert_exact(&info.crop_box, &[50.0_f64, 0.0_f64, 200.0_f64, 60.0_f64]);
        let disjoint = page_info_with("/MediaBox [0 0 200 100] /CropBox [300 300 400 400]");
        assert_exact(
            &disjoint.crop_box,
            &[0.0_f64, 0.0_f64, 200.0_f64, 100.0_f64],
        );
        let invalid = page_info_with("/MediaBox [0 0 200 100] /CropBox [5 5 5 5]");
        assert_exact(&invalid.crop_box, &[0.0_f64, 0.0_f64, 200.0_f64, 100.0_f64]);
        let inner = page_info_with("/MediaBox [0 0 200 100] /CropBox [10 20 30 40]");
        assert_exact(&inner.crop_box, &[10.0_f64, 20.0_f64, 30.0_f64, 40.0_f64]);
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
        assert_exact(&info.media_box, &[0.0_f64, 0.0_f64, 120.0_f64, 240.0_f64]);
        assert_eq!(info.rotate, 90_i32);
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
                rect: [10.0_f64, 20.0_f64, 100.0_f64, 50.0_f64],
                uri: "https://example.com/a".to_owned()
            }
        );
        assert_eq!(result.links[1].uri, "http://\u{e9}");
        assert_exact(&result.links[1].rect, &[0.0_f64, 0.0_f64, 5.0_f64, 5.0_f64]);
        let indirect = build_classic(&link_objects("/Annots 10 0 R"), "", 0).bytes;
        assert_eq!(inspect_all(&indirect).unwrap().links.len(), 2);
        let none = inspect(&indirect, &InspectOptions::default(), &Limits::default()).unwrap();
        assert_eq!(none.links, []);
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
        let error_4 = Document::open(&with_trailer, &Limits::default())
            .err()
            .unwrap();
        assert_eq!(error_4.code, FailureCode::EncryptedPdf);
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
        assert_eq!(result.pages, []);
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
        assert_eq!(*chained, Object::String(b"done".to_vec()));
        let missing = document
            .resolve(&Object::Ref(ObjRef {
                number: 50,
                generation: 0,
            }))
            .unwrap();
        assert_eq!(*missing, Object::Null);
        let looped = document
            .resolve(&Object::Ref(ObjRef {
                number: 8,
                generation: 0,
            }))
            .unwrap();
        assert_eq!(*looped, Object::Null);
        assert_eq!(
            *document.resolve(&Object::Integer(3)).unwrap(),
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
                .find(|(found, _)| *found == number)
                .map_or(0, |(_, offset)| *offset);
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
    fn decodes_pdf_name_uri_escapes() {
        assert_eq!(
            decode_pdf_name(b"https:#2F#2Fsignature-kit.dev#2Fcorpus"),
            "https://signature-kit.dev/corpus"
        );
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

    fn plan_first(bytes: &[u8]) -> Option<Lazy> {
        let mut lazy = Lazy::new(
            bytes.len(),
            Tuning {
                gap: 16 * 1024,
                probe: 32 * 1024,
                round_bytes: 1024 * 1024,
            },
        );
        for _ in 0_i32..64_i32 {
            match lazy.plan(Some(&[0]), false, &Limits::default()) {
                Plan::Ready => return Some(lazy),
                Plan::Fallback => return None,
                Plan::Need(ranges) => {
                    for range in ranges {
                        let offset = range.start;
                        assert!(lazy.feed(offset, &bytes[range]));
                    }
                }
            }
        }
        panic!("lazy planner did not finish");
    }

    fn lazy_contents(lazy: &Lazy) -> Vec<u8> {
        lazy.execute(&Limits::default(), |document, pages| {
            assert_eq!(pages[0].0, 0);
            document.content(pages[0].1)
        })
        .unwrap()
        .unwrap()
    }

    #[test]
    fn lazy_planner_handles_classic_stream_and_hybrid_indexes() {
        let classic = basic_pdf();
        let expected = open(&classic);
        let expected_content = expected.content(&expected.pages().unwrap()[0]).unwrap();
        assert_eq!(
            lazy_contents(&plan_first(&classic).unwrap()),
            expected_content
        );
        for hybrid in [false, true] {
            let file = object_stream_pdf(hybrid);
            assert_eq!(
                lazy_contents(&plan_first(&file.bytes).unwrap()),
                b"BT (Hi) Tj ET"
            );
        }
    }

    #[test]
    fn lazy_planner_accepts_xref_offsets_at_the_preceding_newline() {
        let mut bytes = basic_pdf();
        let xref = find_startxref(&bytes).unwrap();
        let mut line = find_bytes(&bytes, xref, b"65535 f \n")
            .unwrap()
            .saturating_add(9);
        for _ in 0_i32..4_i32 {
            let last_digit = line.saturating_add(10);
            let offset = str::from_utf8(&bytes[line..last_digit])
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let previous_byte = offset.saturating_sub(1);
            bytes[line..last_digit].copy_from_slice(format!("{previous_byte:010}").as_bytes());
            line = line.saturating_add(20);
        }
        assert_eq!(
            lazy_contents(&plan_first(&bytes).unwrap()),
            b"BT /F1 12 Tf (Hi) Tj ET"
        );
    }

    #[test]
    fn lazy_planner_uses_prev_and_falls_back_when_startxref_is_broken() {
        let base = build_classic(&basic_objects(), "", 0);
        let mut bytes = base.bytes;
        let updated = bytes.len();
        bytes.extend_from_slice(
            format!(
                "4 0 obj\n{}\nendobj\n",
                stream_object("", "BT (Updated) Tj ET")
            )
            .as_bytes(),
        );
        let xref = bytes.len();
        bytes.extend_from_slice(format!("xref\n4 1\n{updated:010} 00000 n \ntrailer\n<< /Size 5 /Prev {} >>\nstartxref\n{xref}\n%%EOF\n", base.xref).as_bytes());
        assert_eq!(
            lazy_contents(&plan_first(&bytes).unwrap()),
            b"BT (Updated) Tj ET"
        );
        assert!(plan_first(include_bytes!("../../__tests__/fixtures/broken-xref.pdf")).is_none());
    }

    #[test]
    fn lazy_planner_unlocks_rc4_and_aes() {
        let vectors = [
            (
                "d2a1b8340024ec0293a0f34da5092a93e2d573c1c005fc711b12c829745f092bdc101c0f37003b61e6fc65066568464ac60da87c26dc6ae398d214ad4f094a9c3018fa3ca26a43526b556b6742d28d8ba9d42e960ac929ac78df07ef103b46e3f7d82913cce35279c657d10d",
                "<< /Filter /Standard /Length 40 /O <a0b130ed69fe55902dc33d8c602379c856fe7ed15e9d8e0bacd7367a5f67b6dc> /P -4 /R 2 /U <e0dcfef423e881eb379f48274cf2f6c4deb74ca157e4a2ed17813dfddf601617> /V 1 >>",
            ),
            (
                "0e1c2a38465462707e8c9aa8b6c4d2e0db4f7853f5e2f47456927395c5850459dc16dbf12c0700e5b5e30c8b22231a2914ff78041ed4395d7d81ae37daceea24e89aa7c7956d75bbb01217441266f7fdf150d7f98b37565da339833385cfca10134778a8af002791c98f3e4d2e6c6bc842bee258d6c96a605c69759782d0860e",
                "<< /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /Filter /Standard /Length 128 /O <5a0c0b55deda723d6a1a77ca020e0bf91273d02733c4748c700d9eb9a6d68a09> /OE <> /P -4 /R 4 /StmF /StdCF /StrF /StdCF /U <7556a3ea1d7266be2635f8b0c1eb48ab0021446990b9e4114071a4d9104984c1> /UE <> /V 4 >>",
            ),
        ];
        let trailer = "/Encrypt 7 0 R /ID [<31415926535897932384626433832795><31415926535897932384626433832795>]";
        for (hex, dictionary) in vectors {
            let ciphertext: Vec<_> = hex
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            let mut objects = basic_objects();
            let stream = objects.iter_mut().find(|(number, _)| *number == 4).unwrap();
            stream.0 = 5;
            stream.1 = stream_object("/Filter /FlateDecode", &" ".repeat(ciphertext.len()));
            let leaf = objects.iter_mut().find(|(number, _)| *number == 3).unwrap();
            leaf.1 = leaf.1.replace("/Contents 4 0 R", "/Contents 5 0 R");
            objects.push((7, dictionary.to_owned()));
            let mut bytes = build_classic(&objects, trailer, 0).bytes;
            let start = find_bytes(&bytes, 0, b"stream\n")
                .unwrap()
                .saturating_add(7);
            let end = start.saturating_add(ciphertext.len());
            bytes[start..end].copy_from_slice(&ciphertext);
            let lazy = plan_first(&bytes).unwrap();
            let expected = open(&bytes);
            assert!(expected.is_encrypted());
            let content = lazy_contents(&lazy);
            assert_eq!(
                content,
                expected.content(&expected.pages().unwrap()[0]).unwrap()
            );
            assert!(find_bytes(&content, 0, b"(Item)").is_some());
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
                    drop(bytes.drain(at..end));
                }
                2 => {
                    let at = rng.below(bytes.len());
                    let count = rng.below(16);
                    let extra: Vec<u8> =
                        iter::repeat_with(|| u8::try_from(rng.next() & 0xFF).unwrap())
                            .take(count)
                            .collect();
                    drop(bytes.splice(at..at, extra));
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
                    drop(bytes.splice(to..to, chunk));
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
            runs: false,
            text: true,
            links: true,
            page_indexes: None,
        };
        let mut rng = XorShift(0x9e37_79b9_7f4a_7c15);
        let started = Instant::now();
        for iteration in 0_usize..4000 {
            let seed = &seeds[iteration.rem_euclid(seeds.len())];
            let mutated = mutate(seed, &mut rng);
            let one = Instant::now();
            drop(black_box(inspect(&mutated, &options, &limits)));
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
        for number in 1_i32..20_000_i32 {
            many_objects.extend_from_slice(format!("{number} 0 obj [ ").as_bytes());
        }
        let started = Instant::now();
        drop(black_box(inspect_all(&many_objects)));
        assert!(started.elapsed().as_secs() < 10);

        let mut nested = b"%PDF-1.4\n1 0 obj ".to_vec();
        nested.extend(iter::repeat_n(b'[', 200_000));
        let started_2 = Instant::now();
        drop(black_box(inspect_all(&nested)));
        assert!(started_2.elapsed().as_secs() < 10);

        let mut huge_xref = b"%PDF-1.4\nxref\n0 99999999999\n".to_vec();
        huge_xref.extend_from_slice(b"trailer\n<< >>\nstartxref\n9\n");
        drop(black_box(inspect_all(&huge_xref)));
    }

    #[test]
    fn two_thousand_pages_open_within_budget() {
        let pages = 2000_u32;
        let mut objects = vec![(1_u32, CATALOG.to_owned())];
        let kids = (0..pages).fold(String::new(), |mut kids, index| {
            write!(kids, "{} 0 R ", 10 + index * 3).unwrap();
            kids
        });
        objects.push((
            2,
            format!("<< /Type /Pages /Kids [{kids}] /Count {pages} /MediaBox [0 0 612 792] >>"),
        ));
        for index in 0..pages {
            let page = 10 + index * 3;
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
        let budget = Duration::from_secs(5);
        assert!(opened < budget, "open took {opened:?}");
        assert!(pages_time < budget, "pages took {pages_time:?}");
        assert!(links_time < budget, "links took {links_time:?}");
        assert_eq!(list.len(), widen(pages));
        assert_eq!(links.len(), widen(pages));
        let repaired = replace(&bytes, b"startxref\n", b"startxref\n9");
        let started_3 = Instant::now();
        let document_3 = Document::open(&repaired, &Limits::default()).unwrap();
        let count = document_3.pages().unwrap().len();
        assert!(
            started_3.elapsed() < budget,
            "repair took {:?}",
            started_3.elapsed()
        );
        assert_eq!(count, widen(pages));
    }
}
