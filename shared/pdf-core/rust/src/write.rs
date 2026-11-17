use alloc::rc::Rc;
use core::mem;
use std::collections::HashMap;

use crate::deflate::zlib_compress;
use crate::document::{Document, Page, select_pages};
use crate::failure::{Failure, Outcome};
use crate::inspection::Limits;
use crate::num::{f64_to_i64, widen};
use crate::object::{Dict, ObjRef, Object, Stream};
use crate::syntax::{is_delimiter, is_whitespace};

const HEADER: &[u8] = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
const OBJECTS_PER_STREAM: usize = 100;
const REAL_SCALE: f64 = 10_000_000_000.0;
const REAL_DIGITS: u64 = 10_000_000_000;
const MAX_FRACTIONAL_REAL: f64 = 900_000_000.0;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Body {
    pub data: Option<Vec<u8>>,
    pub generation: u16,
    pub object: Object,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Changes(Vec<(u32, Body)>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Packing {
    Classic,
    ObjectStreams,
}

type XrefRow = (u32, u16, XrefEntry);

#[derive(Debug)]
struct Written {
    entries: Vec<(u32, u16, XrefEntry)>,
    out: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum XrefEntry {
    Compressed { index: u32, stream: u32 },
    Free,
    Offset(usize),
}

impl Changes {
    pub(crate) fn get(&self, number: u32) -> Option<&Body> {
        self.position(number)
            .ok()
            .and_then(|found| self.0.get(found))
            .map(|(_, body)| body)
    }

    pub(crate) fn get_mut(&mut self, number: u32) -> Option<&mut Body> {
        self.position(number)
            .ok()
            .and_then(|found| self.0.get_mut(found))
            .map(|(_, body)| body)
    }

    pub(crate) fn insert(&mut self, number: u32, body: Body) {
        match self.position(number) {
            Ok(found) => {
                if let Some(slot) = self.0.get_mut(found) {
                    slot.1 = body;
                }
            }
            Err(found) => self.0.insert(found, (number, body)),
        }
    }

    fn last_number(&self) -> Option<u32> {
        self.0.last().map(|(number, _)| *number)
    }

    fn position(&self, number: u32) -> Result<usize, usize> {
        self.0.binary_search_by_key(&number, |(found, _)| *found)
    }
}

impl Written {
    fn indirect<F>(&mut self, number: u32, generation: u16, object: &Object, data: &[u8], map: &F)
    where
        F: Fn(ObjRef) -> Object,
    {
        self.entries
            .push((number, generation, XrefEntry::Offset(self.out.len())));
        push_unsigned(&mut self.out, u64::from(number));
        self.out.push(b' ');
        push_unsigned(&mut self.out, u64::from(generation));
        self.out.extend_from_slice(b" obj\n");
        if let Object::Stream(stream) = object {
            let mut dict = stream.dict.clone();
            dict.insert(
                b"Length",
                Object::Integer(i64::try_from(data.len()).unwrap_or(i64::MAX)),
            );
            serialize_dict(&mut self.out, &dict, map);
            self.out.extend_from_slice(b"\nstream\n");
            self.out.extend_from_slice(data);
            self.out.extend_from_slice(b"\nendstream");
        } else {
            serialize(&mut self.out, object, map);
        }
        self.out.extend_from_slice(b"\nendobj\n");
    }

    fn xref(&mut self, trailer: &Dict, previous: Option<usize>, as_stream: bool, number: u32) {
        let start = self.out.len();
        let mut dict = trailer.clone();
        match previous {
            Some(prev) => dict.insert(
                b"Prev",
                Object::Integer(i64::try_from(prev).unwrap_or(i64::MAX)),
            ),
            None => self.entries.push((0, u16::MAX, XrefEntry::Free)),
        }
        if as_stream {
            self.entries.push((number, 0, XrefEntry::Offset(start)));
        }
        let mut order: Vec<[u64; 4]> = self
            .entries
            .iter()
            .enumerate()
            .map(|(position, (object, _, _))| {
                [
                    u64::from(*object),
                    u64::try_from(position).unwrap_or(u64::MAX),
                    0,
                    0,
                ]
            })
            .collect();
        order.sort_unstable();
        self.entries = order
            .iter()
            .filter_map(|key| self.entries.get(usize::try_from(key[1]).ok()?).copied())
            .collect();
        let size = self
            .entries
            .last()
            .map_or(1, |(last, _, _)| last.saturating_add(1));
        let current = dict
            .get(b"Size")
            .and_then(Object::as_integer)
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0);
        dict.insert(b"Size", Object::Integer(i64::from(size.max(current))));
        if as_stream {
            self.xref_stream(dict, number, start);
        } else {
            self.xref_table(&dict);
        }
        self.out.extend_from_slice(b"startxref\n");
        push_unsigned(&mut self.out, u64::try_from(start).unwrap_or(0));
        self.out.extend_from_slice(b"\n%%EOF\n");
    }

    fn xref_stream(&mut self, mut dict: Dict, number: u32, start: usize) {
        let offset_width = byte_width(u64::try_from(start).unwrap_or(u64::MAX));
        let mut rows: Vec<u8> = Vec::new();
        let mut index: Vec<Object> = Vec::new();
        for (first, run) in runs(&self.entries) {
            index.push(Object::Integer(i64::from(first)));
            index.push(Object::Integer(i64::try_from(run.len()).unwrap_or(0)));
            for &(_, generation, entry) in run {
                let (kind, field, second) = match entry {
                    XrefEntry::Offset(offset) => {
                        (1, u64::try_from(offset).unwrap_or(0), u64::from(generation))
                    }
                    XrefEntry::Compressed {
                        index: position,
                        stream,
                    } => (2, u64::from(stream), u64::from(position)),
                    XrefEntry::Free => (0, 0, u64::from(generation)),
                };
                rows.push(kind);
                push_be(&mut rows, field, offset_width);
                push_be(&mut rows, second, 2);
            }
        }
        dict.insert(b"Type", Object::Name(b"XRef".to_vec()));
        dict.insert(b"Index", Object::Array(index));
        dict.insert(
            b"W",
            Object::Array(vec![
                Object::Integer(1),
                Object::Integer(i64::try_from(offset_width).unwrap_or(4)),
                Object::Integer(2),
            ]),
        );
        dict.insert(b"Filter", Object::Name(b"FlateDecode".to_vec()));
        let data = zlib_compress(&rows);
        let stream = Object::Stream(Stream { data: 0..0, dict });
        self.indirect(number, 0, &stream, &data, &Object::Ref);
    }

    fn xref_table(&mut self, dict: &Dict) {
        self.out.extend_from_slice(b"xref\n");
        let entries = mem::take(&mut self.entries);
        for (first, run) in runs(&entries) {
            push_unsigned(&mut self.out, u64::from(first));
            self.out.push(b' ');
            push_unsigned(&mut self.out, u64::try_from(run.len()).unwrap_or(0));
            self.out.push(b'\n');
            for &(_, generation, entry) in run {
                let (offset, flag) = match entry {
                    XrefEntry::Offset(offset) => (offset, b" n \n"),
                    XrefEntry::Compressed { .. } | XrefEntry::Free => (0, b" f \n"),
                };
                push_padded(&mut self.out, u64::try_from(offset).unwrap_or(0), 10);
                self.out.push(b' ');
                push_padded(&mut self.out, u64::from(generation), 5);
                self.out.extend_from_slice(flag);
            }
        }
        self.entries = entries;
        self.out.extend_from_slice(b"trailer\n");
        serialize_dict(&mut self.out, dict, &Object::Ref);
        self.out.push(b'\n');
    }
}

#[derive(Default)]
struct Graph {
    bodies: Vec<Option<(ObjRef, Rc<Body>)>>,
    map: HashMap<u32, u32>,
    queue: Vec<ObjRef>,
}

impl Graph {
    fn close<F>(&mut self, fetch: &F) -> Outcome<()>
    where
        F: Fn(ObjRef) -> Outcome<Option<Rc<Body>>>,
    {
        while let Some(original) = self.queue.pop() {
            let Some(&assigned) = self.map.get(&original.number) else {
                continue;
            };
            let Some(body) = fetch(original)? else {
                continue;
            };
            let mut found: Vec<ObjRef> = Vec::new();
            collect_refs(&body.object, &mut found);
            for reference in found {
                let _: ObjRef = self.reach(reference, fetch)?;
            }
            if let Some(slot) = self.bodies.get_mut(widen_index(assigned)) {
                *slot = Some((original, body));
            }
        }
        Ok(())
    }

    fn emit(&self, document: &Document<'_>, trailer: Dict, layout: Packing) -> Outcome<Vec<u8>> {
        let map = |reference: ObjRef| -> Object {
            self.map
                .get(&reference.number)
                .filter(|assigned| {
                    self.bodies
                        .get(widen_index(**assigned))
                        .is_some_and(Option::is_some)
                })
                .map_or(Object::Null, |assigned| {
                    Object::Ref(ObjRef {
                        number: *assigned,
                        generation: 0,
                    })
                })
        };
        let mut written = Written {
            entries: Vec::new(),
            out: Vec::with_capacity(document.bytes().len().saturating_add(1024)),
        };
        written.out.extend_from_slice(HEADER);
        let mut packed: Vec<(u32, &Object)> = Vec::new();
        for (index, slot) in self.bodies.iter().enumerate() {
            let Some((_, body)) = slot else {
                continue;
            };
            let number = u32::try_from(index).unwrap_or(u32::MAX);
            if layout == Packing::ObjectStreams && !matches!(body.object, Object::Stream(_)) {
                packed.push((number, &body.object));
                continue;
            }
            let data = stream_bytes(document, body)?;
            written.indirect(number, 0, &body.object, data, &map);
        }
        let next = u32::try_from(self.bodies.len()).unwrap_or(u32::MAX);
        let xref_number = pack_object_streams(&mut written, &packed, next, &map);
        let mut final_trailer = trailer;
        let digest = fingerprint(&written.out, 0);
        final_trailer.insert(
            b"ID",
            Object::Array(vec![Object::String(digest.clone()), Object::String(digest)]),
        );
        written.xref(
            &final_trailer,
            None,
            layout == Packing::ObjectStreams,
            xref_number,
        );
        Ok(written.out)
    }

    fn reach<F>(&mut self, reference: ObjRef, fetch: &F) -> Outcome<ObjRef>
    where
        F: Fn(ObjRef) -> Outcome<Option<Rc<Body>>>,
    {
        let _: &F = fetch;
        if let Some(assigned) = self.map.get(&reference.number) {
            return Ok(ObjRef {
                number: *assigned,
                generation: 0,
            });
        }
        let number = u32::try_from(self.bodies.len().max(1))
            .ok()
            .ok_or_else(|| Failure::limit("too many objects"))?;
        if self.bodies.is_empty() {
            self.bodies.push(None);
        }
        self.bodies.push(None);
        let assigned = ObjRef {
            number,
            generation: 0,
        };
        let _: Option<u32> = self.map.insert(reference.number, number);
        self.queue.push(reference);
        Ok(assigned)
    }
}

struct MergeOutput {
    bodies: Vec<Option<Object>>,
    datas: Vec<Option<Vec<u8>>>,
}

impl MergeOutput {
    fn emit(&self, trailer: Dict, layout: Packing) -> Vec<u8> {
        let mut written = Written {
            entries: Vec::new(),
            out: Vec::new(),
        };
        written.out.extend_from_slice(HEADER);
        let mut packed: Vec<(u32, &Object)> = Vec::new();
        for (index, slot) in self.bodies.iter().enumerate() {
            let Some(object) = slot else {
                continue;
            };
            let number = u32::try_from(index.saturating_add(1)).unwrap_or(u32::MAX);
            if layout == Packing::ObjectStreams && !matches!(object, Object::Stream(_)) {
                packed.push((number, object));
                continue;
            }
            let data = self
                .datas
                .get(index)
                .and_then(Option::as_deref)
                .unwrap_or_default();
            written.indirect(number, 0, object, data, &Object::Ref);
        }
        let next = u32::try_from(self.bodies.len().saturating_add(1)).unwrap_or(u32::MAX);
        let xref_number = pack_object_streams(&mut written, &packed, next, &Object::Ref);
        let mut final_trailer = trailer;
        let digest = fingerprint(&written.out, 0);
        final_trailer.insert(
            b"ID",
            Object::Array(vec![Object::String(digest.clone()), Object::String(digest)]),
        );
        written.xref(
            &final_trailer,
            None,
            layout == Packing::ObjectStreams,
            xref_number,
        );
        written.out
    }

    fn reserve(&mut self) -> u32 {
        self.bodies.push(None);
        self.datas.push(None);
        u32::try_from(self.bodies.len()).unwrap_or(u32::MAX)
    }

    fn set(&mut self, number: u32, object: Object, data: Option<Vec<u8>>) {
        let index = widen_index(number).saturating_sub(1);
        if let Some(slot) = self.bodies.get_mut(index) {
            *slot = Some(object);
        }
        if let Some(slot) = self.datas.get_mut(index) {
            *slot = data;
        }
    }
}

struct Copier<'doc, 'data> {
    document: &'doc Document<'data>,
    map: HashMap<u32, u32>,
    page_numbers: HashMap<u32, u32>,
    queue: Vec<(ObjRef, u32)>,
}

impl Copier<'_, '_> {
    fn copy(&mut self, object: &Object, output: &mut MergeOutput) -> Outcome<Object> {
        Ok(match object {
            Object::Ref(reference) => self.reference(*reference, output)?,
            Object::Array(items) => Object::Array(
                items
                    .iter()
                    .map(|item| self.copy(item, output))
                    .collect::<Outcome<Vec<_>>>()?,
            ),
            Object::Dict(dict) => Object::Dict(self.copy_dict(dict, output)?),
            Object::Stream(stream) => Object::Stream(Stream {
                data: stream.data.clone(),
                dict: self.copy_dict(&stream.dict, output)?,
            }),
            Object::Bool(_)
            | Object::Integer(_)
            | Object::Name(_)
            | Object::Null
            | Object::Real(_)
            | Object::String(_) => object.clone(),
        })
    }

    fn copy_dict(&mut self, dict: &Dict, output: &mut MergeOutput) -> Outcome<Dict> {
        let mut copied = Dict::default();
        for (key, value) in &dict.entries {
            copied
                .entries
                .push((key.clone(), self.copy(value, output)?));
        }
        Ok(copied)
    }

    fn drain(&mut self, output: &mut MergeOutput) -> Outcome<()> {
        while let Some((reference, number)) = self.queue.pop() {
            let loaded = self.document.load(reference)?;
            let copied = self.copy(&loaded, output)?;
            let data = match &*loaded {
                Object::Stream(stream) => Some(
                    self.document
                        .bytes()
                        .get(stream.data.clone())
                        .ok_or_else(|| Failure::invalid("stream data out of range"))?
                        .to_vec(),
                ),
                Object::Array(_)
                | Object::Bool(_)
                | Object::Dict(_)
                | Object::Integer(_)
                | Object::Name(_)
                | Object::Null
                | Object::Real(_)
                | Object::Ref(_)
                | Object::String(_) => None,
            };
            output.set(number, copied, data);
        }
        Ok(())
    }

    fn reference(&mut self, reference: ObjRef, output: &mut MergeOutput) -> Outcome<Object> {
        if let Some(&number) = self.page_numbers.get(&reference.number) {
            return Ok(Object::Ref(ObjRef {
                number,
                generation: 0,
            }));
        }
        if let Some(&number) = self.map.get(&reference.number) {
            return Ok(Object::Ref(ObjRef {
                number,
                generation: 0,
            }));
        }
        let target = self.document.load(reference)?;
        if matches!(*target, Object::Null) {
            return Ok(Object::Null);
        }
        if target.as_dict().is_some_and(|dict| {
            matches!(
                dict.get(b"Type").and_then(Object::as_name),
                Some(b"Page" | b"Pages")
            )
        }) {
            return Ok(Object::Null);
        }
        let number = output.reserve();
        let _: Option<u32> = self.map.insert(reference.number, number);
        self.queue.push((reference, number));
        Ok(Object::Ref(ObjRef {
            number,
            generation: 0,
        }))
    }
}

trait RefValue {
    fn copied_ref(&self) -> Option<ObjRef>;
}

impl RefValue for Option<&Object> {
    fn copied_ref(&self) -> Option<ObjRef> {
        match self {
            Some(Object::Ref(reference)) => Some(*reference),
            _ => None,
        }
    }
}

pub(crate) fn incremental(document: &Document<'_>, changed: &Changes) -> Outcome<Vec<u8>> {
    let original = document.bytes();
    let previous = document
        .startxref()
        .ok_or_else(|| Failure::invalid("missing startxref for incremental update"))?;
    let previous_is_stream = !original
        .get(previous..)
        .is_some_and(|rest| rest.starts_with(b"xref"));
    let appended: usize = changed
        .0
        .iter()
        .map(|(_, body)| {
            body.data
                .as_ref()
                .map_or(256, |data| data.len().saturating_add(256))
        })
        .fold(1024, usize::saturating_add);
    let mut written = Written {
        entries: Vec::new(),
        out: Vec::with_capacity(original.len().saturating_add(appended)),
    };
    written.out.extend_from_slice(original);
    if written.out.last() != Some(&b'\n') {
        written.out.push(b'\n');
    }
    let appended_start = written.out.len();
    for (number, body) in &changed.0 {
        let data = stream_bytes(document, body)?;
        written.indirect(*number, body.generation, &body.object, data, &Object::Ref);
    }
    let base = document.trailer();
    let mut trailer = Dict::default();
    for key in [b"Root".as_slice(), b"Info".as_slice()] {
        if let Some(value) = base.get(key) {
            trailer.insert(key, value.clone());
        }
    }
    let size = changed
        .last_number()
        .map_or(0, |last| last.saturating_add(1))
        .max(u32::try_from(document.object_count()).unwrap_or(u32::MAX))
        .max(
            base.get(b"Size")
                .and_then(Object::as_integer)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0),
        );
    trailer.insert(b"Size", Object::Integer(i64::from(size)));
    if let Some(Object::Array(id)) = base.get(b"ID")
        && let Some(first) = id.first()
    {
        let digest = fingerprint(
            written.out.get(appended_start..).unwrap_or_default(),
            original.len(),
        );
        trailer.insert(
            b"ID",
            Object::Array(vec![first.clone(), Object::String(digest)]),
        );
    }
    written.xref(&trailer, Some(previous), previous_is_stream, size);
    Ok(written.out)
}

pub(crate) fn rewrite(
    document: &Document<'_>,
    changed: &Changes,
    layout: Packing,
) -> Outcome<Vec<u8>> {
    let trailer = document.trailer();
    let root = trailer
        .get(b"Root")
        .copied_ref()
        .ok_or_else(|| Failure::invalid("missing document catalog"))?;
    let info = trailer.get(b"Info").copied_ref();
    let fetch = |reference: ObjRef| -> Outcome<Option<Rc<Body>>> {
        if let Some(body) = changed.get(reference.number) {
            return Ok(Some(Rc::new(body.clone())));
        }
        let object = document.load(reference)?;
        if matches!(*object, Object::Null) {
            return Ok(None);
        }
        Ok(Some(Rc::new(Body {
            data: None,
            generation: 0,
            object: (*object).clone(),
        })))
    };
    let mut graph = Graph::default();
    let new_root = graph.reach(root, &fetch)?;
    let new_info = match info {
        Some(reference) => Some(graph.reach(reference, &fetch)?),
        None => None,
    };
    graph.close(&fetch)?;
    let mut final_trailer = Dict::default();
    final_trailer.insert(b"Root", Object::Ref(new_root));
    if let Some(reference) = new_info {
        final_trailer.insert(b"Info", Object::Ref(reference));
    }
    if let Some(catalog) = graph.bodies.get_mut(widen_index(new_root.number))
        && let Some((_, body)) = catalog.as_mut()
        && let Object::Dict(dict) = &mut Rc::make_mut(body).object
    {
        dict.insert(b"Type", Object::Name(b"Catalog".to_vec()));
    }
    graph.emit(document, final_trailer, layout)
}

pub(crate) fn merge(
    sources: &[&[u8]],
    selections: &[Option<Vec<u32>>],
    drop_widgets: bool,
    layout: Packing,
    limits: &Limits,
) -> Outcome<Vec<u8>> {
    let mut output = MergeOutput {
        bodies: Vec::new(),
        datas: Vec::new(),
    };
    let pages_number = output.reserve();
    let catalog_number = output.reserve();
    let mut kids: Vec<Object> = Vec::new();
    for (position, source) in sources.iter().enumerate() {
        let document = Document::open(source, limits)?;
        let pages = document.pages()?;
        let selected = select_pages(
            pages.len(),
            selections.get(position).and_then(Option::as_deref),
        )?;
        let mut copier = Copier {
            document: &document,
            map: HashMap::new(),
            page_numbers: HashMap::new(),
            queue: Vec::new(),
        };
        let mut planned: Vec<(usize, u32)> = Vec::with_capacity(selected.len());
        for index in selected {
            let number = output.reserve();
            if let Some(page) = pages.get(index)
                && let Some(reference) = page.obj_ref
            {
                let _: Option<u32> = copier.page_numbers.insert(reference.number, number);
            }
            planned.push((index, number));
        }
        for (index, number) in planned {
            let Some(page) = pages.get(index) else {
                continue;
            };
            let dict = flatten_page(&document, page, drop_widgets)?;
            let mut page_dict = copier.copy_dict(&dict, &mut output)?;
            page_dict.insert(
                b"Parent",
                Object::Ref(ObjRef {
                    number: pages_number,
                    generation: 0,
                }),
            );
            output.set(number, Object::Dict(page_dict), None);
            kids.push(Object::Ref(ObjRef {
                number,
                generation: 0,
            }));
        }
        copier.drain(&mut output)?;
    }
    let mut pages_dict = Dict::default();
    pages_dict.insert(b"Type", Object::Name(b"Pages".to_vec()));
    pages_dict.insert(
        b"Count",
        Object::Integer(i64::try_from(kids.len()).unwrap_or(0)),
    );
    pages_dict.insert(b"Kids", Object::Array(kids));
    output.set(pages_number, Object::Dict(pages_dict), None);
    let mut catalog = Dict::default();
    catalog.insert(b"Type", Object::Name(b"Catalog".to_vec()));
    catalog.insert(
        b"Pages",
        Object::Ref(ObjRef {
            number: pages_number,
            generation: 0,
        }),
    );
    output.set(catalog_number, Object::Dict(catalog), None);
    let mut trailer = Dict::default();
    trailer.insert(
        b"Root",
        Object::Ref(ObjRef {
            number: catalog_number,
            generation: 0,
        }),
    );
    Ok(output.emit(trailer, layout))
}

pub(crate) fn serialize<F>(out: &mut Vec<u8>, object: &Object, map: &F)
where
    F: Fn(ObjRef) -> Object,
{
    match object {
        Object::Null => token(out, b"null"),
        Object::Bool(value) => token(out, if *value { b"true" } else { b"false" }),
        Object::Integer(value) => {
            separate(out);
            push_signed(out, *value);
        }
        Object::Real(value) => {
            separate(out);
            push_real(out, *value);
        }
        Object::Name(name) => push_name(out, name),
        Object::String(bytes) => push_string(out, bytes),
        Object::Array(items) => {
            out.push(b'[');
            for item in items {
                serialize(out, item, map);
            }
            out.push(b']');
        }
        Object::Dict(dict) => serialize_dict(out, dict, map),
        Object::Stream(stream) => serialize_dict(out, &stream.dict, map),
        Object::Ref(reference) => match map(*reference) {
            Object::Ref(target) => {
                separate(out);
                push_unsigned(out, u64::from(target.number));
                out.push(b' ');
                push_unsigned(out, u64::from(target.generation));
                out.extend_from_slice(b" R");
            }
            Object::Array(_)
            | Object::Bool(_)
            | Object::Dict(_)
            | Object::Integer(_)
            | Object::Name(_)
            | Object::Null
            | Object::Real(_)
            | Object::Stream(_)
            | Object::String(_) => token(out, b"null"),
        },
    }
}

pub(crate) fn serialize_dict<F>(out: &mut Vec<u8>, dict: &Dict, map: &F)
where
    F: Fn(ObjRef) -> Object,
{
    out.extend_from_slice(b"<<");
    for (key, value) in &dict.entries {
        push_name(out, key);
        out.push(b' ');
        serialize(out, value, map);
    }
    out.extend_from_slice(b">>");
}

fn byte_width(value: u64) -> usize {
    let bits = u64::BITS.saturating_sub(value.leading_zeros());
    widen_index(bits.saturating_add(7) >> 3_i32).max(1)
}

fn collect_refs(object: &Object, found: &mut Vec<ObjRef>) {
    match object {
        Object::Ref(reference) => found.push(*reference),
        Object::Array(items) => {
            for item in items {
                collect_refs(item, found);
            }
        }
        Object::Dict(dict) => {
            for (_, value) in &dict.entries {
                collect_refs(value, found);
            }
        }
        Object::Stream(stream) => {
            for (_, value) in &stream.dict.entries {
                collect_refs(value, found);
            }
        }
        Object::Bool(_)
        | Object::Integer(_)
        | Object::Name(_)
        | Object::Null
        | Object::Real(_)
        | Object::String(_) => {}
    }
}

fn fingerprint(bytes: &[u8], salt: usize) -> Vec<u8> {
    let mut first: u64 = 0xcbf2_9ce4_8422_2325;
    let mut second: u64 = 0x8422_2325_cbf2_9ce4 ^ u64::try_from(salt).unwrap_or(0);
    for chunk in bytes.chunks(8) {
        let mut word = [0_u8; 8];
        for (slot, byte) in word.iter_mut().zip(chunk) {
            *slot = *byte;
        }
        let value = u64::from_le_bytes(word);
        first = (first ^ value).wrapping_mul(0x0100_0000_01b3);
        second = (second ^ value.rotate_left(29)).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
    let mut digest = first.to_be_bytes().to_vec();
    digest.extend_from_slice(&second.to_be_bytes());
    digest
}

fn flatten_page(document: &Document<'_>, page: &Page, drop_widgets: bool) -> Outcome<Dict> {
    let mut dict = page.dict.clone();
    dict.entries.retain(|(key, _)| key.as_slice() != b"Parent");
    if dict.get(b"MediaBox").is_none() {
        dict.insert(b"MediaBox", rect_object(page.info.media_box));
    }
    if dict.get(b"CropBox").is_none() && !same_rect(page.info.crop_box, page.info.media_box) {
        dict.insert(b"CropBox", rect_object(page.info.crop_box));
    }
    if dict.get(b"Rotate").is_none() && page.info.rotate != 0_i32 {
        dict.insert(b"Rotate", Object::Integer(i64::from(page.info.rotate)));
    }
    if dict.get(b"Resources").is_none() {
        let resources = page
            .resources_ref
            .map_or_else(|| Object::Dict(page.resources.clone()), Object::Ref);
        dict.insert(b"Resources", resources);
    }
    if drop_widgets && let Some(annots) = dict.get(b"Annots").cloned() {
        let resolved = document.follow(&annots)?;
        let mut kept: Vec<Object> = Vec::new();
        for item in resolved.as_array().unwrap_or_default() {
            let annotation = document.follow(item)?;
            let widget = annotation
                .as_dict()
                .and_then(|value| value.get(b"Subtype"))
                .and_then(Object::as_name)
                == Some(b"Widget".as_slice());
            if !widget {
                kept.push(item.clone());
            }
        }
        dict.entries.retain(|(key, _)| key.as_slice() != b"Annots");
        if !kept.is_empty() {
            dict.insert(b"Annots", Object::Array(kept));
        }
    }
    Ok(dict)
}

fn pack_object_streams<F>(
    written: &mut Written,
    packed: &[(u32, &Object)],
    first_free: u32,
    map: &F,
) -> u32
where
    F: Fn(ObjRef) -> Object,
{
    let mut next = first_free;
    for chunk in packed.chunks(OBJECTS_PER_STREAM) {
        let stream_number = next;
        next = next.saturating_add(1);
        let mut header: Vec<u8> = Vec::new();
        let mut body: Vec<u8> = Vec::new();
        for (position, (number, object)) in chunk.iter().enumerate() {
            push_unsigned(&mut header, u64::from(*number));
            header.push(b' ');
            push_unsigned(&mut header, u64::try_from(body.len()).unwrap_or(0));
            header.push(b' ');
            serialize(&mut body, object, map);
            body.push(b'\n');
            written.entries.push((
                *number,
                0,
                XrefEntry::Compressed {
                    index: u32::try_from(position).unwrap_or(0),
                    stream: stream_number,
                },
            ));
        }
        let first = header.len();
        header.extend_from_slice(&body);
        let mut dict = Dict::default();
        dict.insert(b"Type", Object::Name(b"ObjStm".to_vec()));
        dict.insert(
            b"N",
            Object::Integer(i64::try_from(chunk.len()).unwrap_or(0)),
        );
        dict.insert(b"First", Object::Integer(i64::try_from(first).unwrap_or(0)));
        dict.insert(b"Filter", Object::Name(b"FlateDecode".to_vec()));
        let data = zlib_compress(&header);
        written.indirect(
            stream_number,
            0,
            &Object::Stream(Stream { data: 0..0, dict }),
            &data,
            &Object::Ref,
        );
    }
    next
}

fn push_be(out: &mut Vec<u8>, value: u64, width: usize) {
    let bytes = value.to_be_bytes();
    out.extend_from_slice(
        bytes
            .get(bytes.len().saturating_sub(width)..)
            .unwrap_or_default(),
    );
}

fn push_name(out: &mut Vec<u8>, name: &[u8]) {
    out.push(b'/');
    for &byte in name {
        if (0x21..=0x7e).contains(&byte)
            && !matches!(
                byte,
                b'#' | b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
            )
        {
            out.push(byte);
        } else {
            out.push(b'#');
            push_hex_byte(out, byte);
        }
    }
}

fn push_hex_byte(out: &mut Vec<u8>, byte: u8) {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    out.push(
        DIGITS
            .get(usize::from(byte >> 4_i32))
            .copied()
            .unwrap_or(b'0'),
    );
    out.push(
        DIGITS
            .get(usize::from(byte & 0x0f))
            .copied()
            .unwrap_or(b'0'),
    );
}

fn push_padded(out: &mut Vec<u8>, value: u64, width: usize) {
    let mut digits = [b'0'; 20];
    let mut cursor = digits.len();
    let mut remaining = value;
    loop {
        cursor = cursor.saturating_sub(1);
        if let Some(slot) = digits.get_mut(cursor) {
            *slot = b'0'.saturating_add(u8::try_from(remaining.rem_euclid(10)).unwrap_or(0));
        }
        remaining = remaining.checked_div(10).unwrap_or(0);
        if remaining == 0 {
            break;
        }
    }
    let used = digits.len().saturating_sub(cursor);
    for _ in used..width {
        out.push(b'0');
    }
    out.extend_from_slice(digits.get(cursor..).unwrap_or_default());
}

fn push_real(out: &mut Vec<u8>, value: f64) {
    if !value.is_finite() || value.abs() < 0.5e-10_f64 {
        out.push(b'0');
        return;
    }
    if value < 0.0_f64 {
        out.push(b'-');
    }
    let magnitude = value.abs();
    if magnitude >= MAX_FRACTIONAL_REAL {
        push_unsigned(
            out,
            u64::try_from(f64_to_i64(magnitude.round())).unwrap_or(u64::MAX),
        );
        return;
    }
    let scaled = u64::try_from(f64_to_i64((magnitude * REAL_SCALE).round())).unwrap_or(0);
    let whole = scaled.checked_div(REAL_DIGITS).unwrap_or(0);
    let mut fraction = scaled.checked_rem(REAL_DIGITS).unwrap_or(0);
    push_unsigned(out, whole);
    if fraction == 0 {
        return;
    }
    let mut width = 10_usize;
    while fraction.is_multiple_of(10) {
        fraction = fraction.checked_div(10).unwrap_or(0);
        width = width.saturating_sub(1);
    }
    out.push(b'.');
    push_padded(out, fraction, width);
}

fn push_signed(out: &mut Vec<u8>, value: i64) {
    if value < 0 {
        out.push(b'-');
    }
    push_unsigned(out, value.unsigned_abs());
}

pub(crate) fn push_unsigned(out: &mut Vec<u8>, value: u64) {
    push_padded(out, value, 0);
}

fn push_string(out: &mut Vec<u8>, bytes: &[u8]) {
    let printable = bytes
        .iter()
        .all(|&byte| (0x20..=0x7e).contains(&byte) || matches!(byte, b'\n' | b'\r' | b'\t'));
    if !printable {
        out.push(b'<');
        for &byte in bytes {
            push_hex_byte(out, byte);
        }
        out.push(b'>');
        return;
    }
    out.push(b'(');
    for &byte in bytes {
        match byte {
            b'(' | b')' | b'\\' => {
                out.push(b'\\');
                out.push(byte);
            }
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\t' => out.extend_from_slice(b"\\t"),
            _ => out.push(byte),
        }
    }
    out.push(b')');
}

fn rect_object(rect: [f64; 4]) -> Object {
    Object::Array(rect.iter().map(|value| number_object(*value)).collect())
}

pub(crate) fn number_object(value: f64) -> Object {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Object::Integer(f64_to_i64(value))
    } else {
        Object::Real(value)
    }
}

fn runs(entries: &[XrefRow]) -> Vec<(u32, &[XrefRow])> {
    let mut grouped: Vec<(u32, &[XrefRow])> = Vec::new();
    let mut start = 0_usize;
    for (position, pair) in entries.windows(2).enumerate() {
        let contiguous = match pair {
            [(left, _, _), (right, _, _)] => left.checked_add(1) == Some(*right),
            _ => false,
        };
        if !contiguous {
            let end = position.saturating_add(1);
            if let (Some(slice), Some((first, _, _))) =
                (entries.get(start..end), entries.get(start))
            {
                grouped.push((*first, slice));
            }
            start = end;
        }
    }
    if let (Some(slice), Some((first, _, _))) = (entries.get(start..), entries.get(start)) {
        grouped.push((*first, slice));
    }
    grouped
}

fn same_rect(left: [f64; 4], right: [f64; 4]) -> bool {
    left.iter()
        .zip(right)
        .all(|(a, b)| a.to_bits() == b.to_bits())
}

fn separate(out: &mut Vec<u8>) {
    if out
        .last()
        .is_some_and(|&byte| !is_delimiter(byte) && !is_whitespace(byte))
    {
        out.push(b' ');
    }
}

fn stream_bytes<'out>(document: &'out Document<'_>, body: &'out Body) -> Outcome<&'out [u8]> {
    if let Some(data) = &body.data {
        return Ok(data);
    }
    match &body.object {
        Object::Stream(stream) => document
            .bytes()
            .get(stream.data.clone())
            .ok_or_else(|| Failure::invalid("stream data out of range")),
        Object::Array(_)
        | Object::Bool(_)
        | Object::Dict(_)
        | Object::Integer(_)
        | Object::Name(_)
        | Object::Null
        | Object::Real(_)
        | Object::Ref(_)
        | Object::String(_) => Ok(&[]),
    }
}

fn token(out: &mut Vec<u8>, text: &[u8]) {
    separate(out);
    out.extend_from_slice(text);
}

fn widen_index(value: u32) -> usize {
    widen(value)
}
