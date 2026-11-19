use core::cell::RefCell;
use core::iter;
use core::ops::Range;
use std::collections::HashSet;

use crate::document::{
    Document, Entry, MAX_SECTIONS, Page, STARTXREF_PROBE, Section, apply_entries, find_startxref,
    merge_section_trailer, object_bound, object_terminated, previous_section,
};
use crate::failure::{Failure, Outcome};
use crate::inspection::Limits;
use crate::num::widen;
use crate::object::{Dict, ObjRef, Object};
use crate::syntax::{keyword_at, parse_indirect_object, parse_object_header, skip_whitespace_at};

const COALESCE_GAP: usize = 16;
const FINAL_SECTION_PROBE: usize = 128 * 1024;
const HEADER_PROBE: usize = 16;
const MIN_SELECTIVE_BUDGET: usize = 2 * 1024 * 1024;
const OBJECT_PROBE: usize = 128;
const SECTION_PROBE: usize = 1024;
const TAIL_PROBE: usize = 96;

#[derive(Debug)]
pub(crate) enum Plan {
    Fallback,
    Need(Vec<Range<usize>>),
    Ready,
}

#[derive(Debug)]
struct Segment {
    bytes: Vec<u8>,
    start: usize,
}

impl Segment {
    const fn end(&self) -> usize {
        self.start.saturating_add(self.bytes.len())
    }
}

#[derive(Debug, Default)]
struct Index {
    hybrid: Option<Section>,
    offsets: Vec<usize>,
    table: Vec<Entry>,
    trailer: Option<Dict>,
    visited: HashSet<usize>,
}

#[derive(Debug)]
pub(crate) struct Lazy {
    compact: Vec<u8>,
    ends: Vec<usize>,
    index: Index,
    next_section: Option<usize>,
    pending: HashSet<u32>,
    ready: Option<Vec<(usize, Page)>>,
    remapped: Vec<Entry>,
    segments: Vec<Segment>,
    size: usize,
}

impl Lazy {
    fn accept_section(&mut self, section: Section, bound: usize) {
        self.index
            .offsets
            .extend(section.entries.iter().filter_map(|(_, entry)| match entry {
                Entry::Offset(offset) if *offset < self.size => Some(*offset),
                Entry::Offset(_)
                | Entry::Free
                | Entry::Pending
                | Entry::Unset
                | Entry::Compressed { .. } => None,
            }));
        if let Some(base) = self.index.hybrid.take() {
            apply_entries(&mut self.index.table, section.entries, bound);
            self.accept_trailer(base, bound);
        } else if let Some(hybrid) = section.hybrid {
            self.next_section = Some(hybrid);
            self.index.hybrid = Some(section);
        } else {
            self.accept_trailer(section, bound);
        }
    }

    fn accept_trailer(&mut self, section: Section, bound: usize) {
        apply_entries(&mut self.index.table, section.entries, bound);
        self.next_section = previous_section(&section.trailer);
        merge_section_trailer(&mut self.index.trailer, section.trailer);
    }

    fn at(&self, start: usize) -> usize {
        self.segments
            .partition_point(|segment| segment.end() <= start)
    }

    fn document<'data>(
        &'data self,
        limits: &Limits,
        missing: &'data RefCell<HashSet<u32>>,
    ) -> Outcome<Document<'data>> {
        let trailer = self
            .index
            .trailer
            .as_ref()
            .ok_or_else(|| Failure::invalid("missing lazy trailer"))?;
        Document::compact(
            &self.compact,
            self.size,
            &self.ends,
            self.remapped.clone(),
            trailer.clone(),
            limits,
            missing,
        )
    }

    pub(crate) fn execute<A>(
        &self,
        limits: &Limits,
        run: impl FnOnce(&Document<'_>, &[(usize, &Page)]) -> Outcome<A>,
    ) -> Outcome<Option<A>> {
        let missing = RefCell::new(HashSet::new());
        let document = self.document(limits, &missing)?;
        let pages = self
            .ready
            .as_ref()
            .ok_or_else(|| Failure::invalid("lazy plan is not ready"))?;
        let selected: Vec<_> = pages.iter().map(|(index, page)| (*index, page)).collect();
        let result = run(&document, &selected);
        if document.was_repaired() || !missing.borrow().is_empty() {
            return Ok(None);
        }
        result.map(Some)
    }

    pub(crate) fn feed(&mut self, offset: usize, bytes: &[u8]) -> bool {
        let end = offset.saturating_add(bytes.len());
        if end > self.size || bytes.is_empty() {
            return false;
        }
        let first = self
            .segments
            .partition_point(|segment| segment.end() < offset);
        let after = self
            .segments
            .partition_point(|segment| segment.start <= end);
        if let Some(segment) = self.segments.get_mut(first)
            && segment.start <= offset
            && end <= segment.end()
        {
            return true;
        }
        let mut segments = self.segments.drain(first..after);
        let mut merged = match segments.next() {
            Some(segment) if segment.start <= offset => segment,
            Some(segment) => {
                let mut merged = Segment {
                    bytes: bytes.to_vec(),
                    start: offset,
                };
                let overlap = end.saturating_sub(segment.start);
                merged
                    .bytes
                    .extend_from_slice(segment.bytes.get(overlap..).unwrap_or_default());
                merged
            }
            None => Segment {
                bytes: Vec::new(),
                start: offset,
            },
        };
        let overlap = merged.end().saturating_sub(offset);
        merged
            .bytes
            .extend_from_slice(bytes.get(overlap..).unwrap_or_default());
        for segment in segments {
            let overlap_next = merged.end().saturating_sub(segment.start);
            merged
                .bytes
                .extend_from_slice(segment.bytes.get(overlap_next..).unwrap_or_default());
        }
        self.segments.insert(first, merged);
        true
    }

    fn head_and_tail(&mut self) -> Option<Plan> {
        let head_end = HEADER_PROBE.min(self.size);
        let head = Self::window(&self.segments, 0, head_end);
        let tail_size = TAIL_PROBE.min(self.size);
        let mut wanted = Vec::new();
        if head.len() < head_end {
            wanted.push(0..head_end);
        } else if !head.starts_with(b"%PDF-") {
            return Some(Plan::Fallback);
        }
        let mut probe = tail_size;
        while probe > 0 {
            let start = self.size.saturating_sub(probe);
            let tail = Self::window(&self.segments, start, self.size);
            if tail.len() < probe {
                wanted.push(start..self.size);
                break;
            }
            if let Some(offset) = find_startxref(tail) {
                if wanted.is_empty() {
                    self.next_section = Some(offset);
                }
                break;
            }
            let ceiling = STARTXREF_PROBE.min(self.size);
            if probe >= ceiling {
                break;
            }
            probe = probe.saturating_mul(2).min(ceiling);
        }
        if !wanted.is_empty() {
            return Some(self.plan_ranges(wanted));
        }
        self.next_section.is_none().then_some(Plan::Fallback)
    }

    fn index(&mut self, limits: &Limits) -> Option<Plan> {
        if !self.remapped.is_empty() {
            return None;
        }
        if self.next_section.is_none()
            && let Some(plan) = self.head_and_tail()
        {
            return Some(plan);
        }
        let bound = object_bound(self.size, limits);
        while let Some(offset) = self.next_section {
            if offset >= self.size
                || self.index.visited.len() >= MAX_SECTIONS
                || self.index.visited.contains(&offset)
            {
                return Some(Plan::Fallback);
            }
            let window = Self::window(&self.segments, offset, self.size);
            let complete = offset.saturating_add(window.len()) == self.size;
            let parsed = Document::section_window(window, limits, complete);
            let Ok(section) = parsed else {
                if complete || (window.len() >= OBJECT_PROBE && !section_prefix(window)) {
                    return Some(Plan::Fallback);
                }
                let remaining = self.size.saturating_sub(offset);
                let end = if self.index.visited.is_empty() && remaining <= FINAL_SECTION_PROBE {
                    self.size
                } else {
                    grow(offset, window.len(), self.size, SECTION_PROBE)
                };
                return Some(self.plan_ranges(iter::once(offset..end).collect()));
            };
            let _: bool = self.index.visited.insert(offset);
            self.index.offsets.push(offset);
            self.accept_section(section, bound);
        }
        if self.index.table.is_empty() {
            return Some(Plan::Fallback);
        }
        self.index.offsets.sort_unstable();
        self.index.offsets.dedup();
        self.remapped = self
            .index
            .table
            .iter()
            .map(|entry| {
                if matches!(entry, Entry::Offset(_)) {
                    Entry::Pending
                } else {
                    *entry
                }
            })
            .collect();
        if let Some(Object::Ref(reference)) = self
            .index
            .trailer
            .as_ref()
            .and_then(|dict| dict.get(b"Encrypt"))
        {
            let _: bool = self.pending.insert(reference.number);
        }
        None
    }

    pub(crate) fn new(size: usize) -> Self {
        Self {
            compact: Vec::new(),
            ends: Vec::new(),
            index: Index::default(),
            next_section: None,
            pending: HashSet::new(),
            ready: None,
            remapped: Vec::new(),
            segments: Vec::new(),
            size,
        }
    }

    fn pack(&mut self, limits: &Limits) -> Option<Plan> {
        let mut wanted = Vec::new();
        let mut pending: Vec<_> = self.pending.drain().collect();
        pending.sort_unstable();
        for number in pending {
            let Some(Entry::Offset(offset)) = self.index.table.get(widen(number)).copied() else {
                return Some(Plan::Fallback);
            };
            let offsets = &self.index.offsets;
            let next = offsets.partition_point(|position| *position <= offset);
            let ceiling = offsets.get(next).copied().unwrap_or(self.size);
            if offset >= ceiling || ceiling > self.size {
                return Some(Plan::Fallback);
            }
            let lookahead = ceiling.saturating_add(1).min(self.size);
            let window = Self::window(&self.segments, offset, lookahead);
            match object_extent(window, number, limits, offset, ceiling, self.size) {
                Extent::Complete(length) => {
                    let Some(bytes) = window.get(..length) else {
                        return Some(Plan::Fallback);
                    };
                    let Some(slot) = self.remapped.get_mut(widen(number)) else {
                        return Some(Plan::Fallback);
                    };
                    let packed = self.compact.len();
                    self.compact.extend_from_slice(bytes);
                    self.compact.push(b'\n');
                    self.ends.push(self.compact.len());
                    *slot = Entry::Offset(packed);
                }
                Extent::More(end) => {
                    wanted.push(offset..end);
                    let _: bool = self.pending.insert(number);
                }
                Extent::Invalid => return Some(Plan::Fallback),
            }
        }
        (!wanted.is_empty()).then(|| self.plan_ranges(wanted))
    }

    pub(crate) fn plan(&mut self, indexes: Option<&[u32]>, render: bool, limits: &Limits) -> Plan {
        self.ready = None;
        let minimum = HEADER_PROBE
            .saturating_add(TAIL_PROBE)
            .saturating_add(COALESCE_GAP);
        if self.size <= minimum || self.size > limits.max_pdf_bytes {
            return Plan::Fallback;
        }
        if let Some(plan) = self.index(limits) {
            return plan;
        }
        for _ in 0..=self.index.table.len() {
            if let Some(plan) = self.pack(limits) {
                return plan;
            }
            let missing = RefCell::new(HashSet::new());
            let result = self.document(limits, &missing).and_then(|document| {
                let pages = document.compact_pages(indexes)?;
                if missing.borrow().is_empty() {
                    dependencies(&document, &pages, render)?;
                }
                if document.was_repaired() {
                    return Err(Failure::invalid("lazy document requires repair"));
                }
                Ok(pages)
            });
            self.pending = missing.into_inner();
            if !self.pending.is_empty() {
                continue;
            }
            let Ok(pages) = result else {
                return Plan::Fallback;
            };
            self.ready = Some(pages);
            return Plan::Ready;
        }
        Plan::Fallback
    }

    fn plan_ranges(&self, mut wanted: Vec<Range<usize>>) -> Plan {
        wanted.sort_unstable_by_key(|range| range.start);
        let mut requests: Vec<Range<usize>> = Vec::new();
        for range in wanted {
            let mut start = range.start;
            for segment in self.segments.iter().skip(self.at(start)) {
                if segment.start >= range.end {
                    break;
                }
                if segment.start > start {
                    append_range(&mut requests, start..segment.start);
                }
                start = start.max(segment.end());
            }
            if start < range.end {
                append_range(&mut requests, start..range.end);
            }
        }
        let budget = self
            .size
            .checked_div(4)
            .unwrap_or(0)
            .max(MIN_SELECTIVE_BUDGET);
        let cached = self.segments.iter().fold(0_usize, |sum, segment| {
            sum.saturating_add(segment.bytes.len())
        });
        let planned = requests.iter().fold(cached, |sum, range| {
            sum.saturating_add(range.end.saturating_sub(range.start))
        });
        if requests.is_empty() || planned > budget {
            Plan::Fallback
        } else {
            Plan::Need(requests)
        }
    }

    fn window(segments: &[Segment], start: usize, end: usize) -> &[u8] {
        let first = segments.partition_point(|segment| segment.end() <= start);
        let Some(segment) = segments.get(first) else {
            return &[];
        };
        if segment.start > start {
            return &[];
        }
        segment
            .bytes
            .get(
                start.saturating_sub(segment.start)
                    ..end.min(segment.end()).saturating_sub(segment.start),
            )
            .unwrap_or_default()
    }
}

enum Extent {
    Complete(usize),
    Invalid,
    More(usize),
}

fn object_extent(
    window: &[u8],
    number: u32,
    limits: &Limits,
    offset: usize,
    ceiling: usize,
    size: usize,
) -> Extent {
    let end = offset.saturating_add(window.len());
    let lookahead = ceiling.saturating_add(1).min(size);
    if let Some((reference, _)) = parse_object_header(window, 0)
        && reference.number != number
    {
        return Extent::Invalid;
    }
    if let Ok(parsed) = parse_indirect_object(window, 0, limits.max_nesting, |_| None) {
        if let Object::Stream(stream) = &parsed.object {
            if end < lookahead {
                return Extent::More(lookahead);
            }
            if stream.dict.get(b"Length").is_some_and(Object::is_ref) {
                return Extent::Complete(ceiling.saturating_sub(offset));
            }
        }
        if (parsed.end < window.len() || end == size)
            && parsed.end <= ceiling.saturating_sub(offset)
            && object_terminated(window, parsed.end)
        {
            return Extent::Complete(parsed.end);
        }
    }
    if end >= lookahead {
        return Extent::Invalid;
    }
    Extent::More(grow(offset, window.len(), lookahead, OBJECT_PROBE))
}

fn append_range(ranges: &mut Vec<Range<usize>>, range: Range<usize>) {
    if let Some(last) = ranges.last_mut()
        && range.start <= last.end.saturating_add(COALESCE_GAP)
    {
        last.end = last.end.max(range.end);
    } else {
        ranges.push(range);
    }
}

fn grow(offset: usize, length: usize, end: usize, minimum: usize) -> usize {
    offset
        .saturating_add(length.saturating_mul(2).max(minimum))
        .min(end)
}

fn section_prefix(bytes: &[u8]) -> bool {
    let pos = skip_whitespace_at(bytes, 0);
    pos == bytes.len()
        || keyword_at(bytes, pos, b"xref")
        || parse_object_header(bytes, pos).is_some()
}

fn dependencies(document: &Document<'_>, pages: &[(usize, Page)], render: bool) -> Outcome<()> {
    let mut refs = Vec::new();
    for (_, page) in pages {
        references(&page.resources, &mut refs);
        for key in [b"Contents".as_slice(), b"Annots"] {
            if let Some(value) = page.dict.get(key) {
                collect(value, &mut refs);
            }
        }
    }
    if render
        && let Some(catalog) = document.catalog()?
        && let Some(properties) = catalog.as_dict().and_then(|dict| dict.get(b"OCProperties"))
    {
        collect(properties, &mut refs);
    }
    let mut seen = HashSet::new();
    while let Some(reference) = refs.pop() {
        if !seen.insert(reference.number) {
            continue;
        }
        let object = document.load(reference)?;
        collect(&object, &mut refs);
    }
    Ok(())
}

fn references(dict: &Dict, refs: &mut Vec<ObjRef>) {
    let object_type = dict.get(b"Type").and_then(Object::as_name);
    if matches!(object_type, Some(b"Page" | b"Pages" | b"Catalog")) {
        return;
    }
    let annotation = object_type == Some(b"Annot")
        || dict.get(b"Subtype").and_then(Object::as_name) == Some(b"Widget");
    for (key, value) in &dict.entries {
        if !annotation || !matches!(key.as_slice(), b"Parent" | b"P") {
            collect(value, refs);
        }
    }
}
fn collect(object: &Object, refs: &mut Vec<ObjRef>) {
    match object {
        Object::Ref(reference) => refs.push(*reference),
        Object::Dict(dict) => references(dict, refs),
        Object::Stream(stream) => references(&stream.dict, refs),
        Object::Array(items) => items.iter().for_each(|item| collect(item, refs)),
        Object::Null
        | Object::Bool(_)
        | Object::Integer(_)
        | Object::Real(_)
        | Object::Name(_)
        | Object::String(_) => {}
    }
}
