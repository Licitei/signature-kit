use core::cell::RefCell;
use core::iter;
use core::mem;
use core::ops::Range;
use core::slice;
use std::collections::HashSet;

use crate::document::{
    Document, DocumentCache, Entry, MAX_SECTIONS, Page, PageRequest, STARTXREF_PROBE, Section,
    apply_entries, borrow_pages, find_startxref, merge_section_trailer, object_bound,
    previous_section,
};
use crate::failure::{Failure, Outcome};
use crate::inspection::Limits;
use crate::num::widen;
use crate::object::{Dict, ObjRef, Object};
use crate::syntax::{keyword_at, parse_indirect_object, parse_object_header, skip_whitespace_at};

const MIN_SELECTIVE_BUDGET: usize = 2 * 1024 * 1024;
const MIN_PROBE: usize = 128;

#[derive(Debug)]
pub(crate) enum Plan {
    Failed(Failure),
    Fallback,
    Full(Vec<Range<usize>>),
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

#[derive(Clone, Copy, Debug)]
pub(crate) struct Tuning {
    pub(crate) gap: usize,
    pub(crate) probe: usize,
    pub(crate) round_bytes: usize,
}

#[derive(Debug)]
pub(crate) struct Sparse {
    missing: RefCell<Vec<Range<usize>>>,
    offsets: Vec<usize>,
    segments: Vec<Segment>,
    size: usize,
    tuning: Tuning,
}

impl Sparse {
    pub(crate) fn bytes(&self, range: Range<usize>) -> Option<&[u8]> {
        let length = range.end.checked_sub(range.start)?;
        let bytes = self.window(range.start, range.end);
        (bytes.len() == length).then_some(bytes)
    }

    fn cached_bytes(&self) -> usize {
        self.segments
            .iter()
            .map(|segment| segment.bytes.len())
            .sum()
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

    pub(crate) fn misses(&self) -> usize {
        self.missing.borrow().len()
    }

    pub(crate) fn object(&self, offset: usize) -> (&[u8], usize) {
        let next = self.offsets.partition_point(|position| *position <= offset);
        let end = self.offsets.get(next).copied().unwrap_or(self.size);
        let ceiling = end.saturating_add(1).min(self.size);
        (self.window(offset, ceiling), ceiling)
    }

    fn plan_ranges(&self, mut wanted: Vec<Range<usize>>, read_ahead: bool) -> Plan {
        wanted.sort_unstable_by_key(|range| range.start);
        let gap = self
            .tuning
            .gap
            .min(self.tuning.round_bytes.checked_div(4).unwrap_or_default());
        if read_ahead && gap != 0 {
            let cached = self.cached_bytes();
            let budget = self
                .size
                .checked_div(2)
                .unwrap_or_default()
                .max(MIN_SELECTIVE_BUDGET);
            let requests = self.ranges(&wanted, gap);
            let planned = requests
                .iter()
                .fold(cached, |sum, range| sum.saturating_add(range.len()));
            if !requests.is_empty() && planned < self.size && planned <= budget {
                return Plan::Need(self.round(requests));
            }
        }
        let requests = self.ranges(&wanted, 0);
        if requests.is_empty() {
            return Plan::Fallback;
        }
        Plan::Need(self.round(requests))
    }

    fn ranges(&self, wanted: &[Range<usize>], gap: usize) -> Vec<Range<usize>> {
        let mut targets = Vec::new();
        for range in wanted {
            let start = range.start.saturating_sub(gap);
            let end = range.end.saturating_add(gap).min(self.size);
            append_range(&mut targets, start..end, gap);
        }
        let mut requests = Vec::new();
        for target in targets {
            let mut start = target.start;
            let first = self
                .segments
                .partition_point(|segment| segment.end() <= start);
            for segment in self.segments.iter().skip(first) {
                if segment.start >= target.end {
                    break;
                }
                if segment.start > start {
                    requests.push(start..segment.start);
                }
                start = start.max(segment.end());
            }
            if start < target.end {
                requests.push(start..target.end);
            }
        }
        requests
    }

    pub(crate) fn request(&self, start: usize, end: usize) {
        self.missing.borrow_mut().push(start..end);
    }

    fn round(&self, mut requests: Vec<Range<usize>>) -> Vec<Range<usize>> {
        let mut remaining = self.tuning.round_bytes;
        for request in &mut requests {
            let length = request.len().min(remaining);
            request.end = request.start.saturating_add(length);
            remaining = remaining.saturating_sub(length);
        }
        requests.retain(|request| !request.is_empty());
        requests
    }

    fn window(&self, start: usize, end: usize) -> &[u8] {
        let first = self
            .segments
            .partition_point(|segment| segment.end() <= start);
        let Some(segment) = self.segments.get(first) else {
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

#[derive(Debug)]
struct Frontier {
    pages: Vec<(usize, Page)>,
    pending: Vec<ObjRef>,
    selection: PageRequest<Vec<u32>>,
    visited: HashSet<u32>,
}

impl Frontier {
    fn advance(&mut self, document: &Document<'_>, sparse: &Sparse) -> Outcome<()> {
        let mut retry = Vec::new();
        while let Some(reference) = self.pending.pop() {
            if !self.visited.insert(reference.number) {
                continue;
            }
            let before = sparse.misses();
            let object = document.load(reference)?;
            if sparse.misses() == before {
                collect(&object, &mut self.pending);
            } else {
                retry.push(reference);
            }
        }
        for reference in &retry {
            let _: bool = self.visited.remove(&reference.number);
        }
        self.pending = retry;
        Ok(())
    }

    fn new(
        document: &Document<'_>,
        selection: PageRequest<&[u32]>,
        pages: Vec<(usize, Page)>,
        render: bool,
    ) -> Outcome<Self> {
        let mut pending = Vec::new();
        for (_, page) in &pages {
            collect(&page.resources, &mut pending);
            for key in [b"Contents".as_slice(), b"Annots"] {
                if let Some(value) = page.dict.get(key) {
                    collect(value, &mut pending);
                }
            }
        }
        if render
            && let Some(catalog) = document.catalog()?
            && let Some(properties) = catalog.as_dict().and_then(|dict| dict.get(b"OCProperties"))
        {
            collect(properties, &mut pending);
        }
        Ok(Self {
            selection: selection.owned(),
            pages,
            pending,
            visited: HashSet::new(),
        })
    }

    fn walk(
        frontier: &mut Option<Self>,
        document: &Document<'_>,
        sparse: &Sparse,
        requested: PageRequest<&[u32]>,
        render: bool,
    ) -> Outcome<Option<Failure>> {
        if frontier.is_none() {
            let (count, pages) = document.sparse_pages(requested)?;
            if sparse.misses() != 0 {
                return Ok(None);
            }
            if matches!(requested, PageRequest::Indexes(Some(_)))
                && requested.stop_after().is_some_and(|end| end > count)
                && let Err(failure) = requested.select(count)
            {
                return Ok(Some(failure));
            }
            *frontier = Some(Self::new(document, requested, pages, render)?);
        }
        if let Some(selection) = frontier {
            selection.advance(document, sparse)?;
        }
        Ok(None)
    }
}

#[derive(Debug, Default)]
struct Index {
    hybrid: Option<Section>,
    table: Vec<Entry>,
    trailer: Option<Dict>,
    visited: HashSet<usize>,
}

#[derive(Debug)]
pub(crate) struct Lazy {
    cache: DocumentCache,
    fallback: bool,
    frontier: Option<Frontier>,
    index: Index,
    indexed: bool,
    linearized: Option<(usize, u32)>,
    next_section: Option<usize>,
    render: bool,
    sparse: Sparse,
}

impl Lazy {
    fn accept_section(&mut self, section: Section, bound: usize) {
        self.sparse
            .offsets
            .extend(section.entries.iter().filter_map(|(_, entry)| match entry {
                Entry::Offset(offset) if *offset < self.sparse.size => Some(*offset),
                Entry::Offset(_) | Entry::Free | Entry::Unset | Entry::Compressed { .. } => None,
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

    fn document(&self, limits: &Limits) -> Outcome<Document<'_>> {
        let trailer = self
            .index
            .trailer
            .as_ref()
            .ok_or_else(|| Failure::invalid("missing lazy trailer"))?;
        Document::sparse(
            &self.sparse,
            &self.index.table,
            trailer,
            &self.cache,
            limits,
        )
    }

    pub(crate) fn execute<A>(
        &self,
        limits: &Limits,
        run: impl FnOnce(&Document<'_>, &[(usize, &Page)]) -> Outcome<A>,
    ) -> Outcome<Option<A>> {
        let document = self.document(limits)?;
        let frontier = self
            .frontier
            .as_ref()
            .filter(|frontier| frontier.pending.is_empty())
            .ok_or_else(|| Failure::invalid("lazy plan is not ready"))?;
        let result = run(&document, &borrow_pages(&frontier.pages));
        if document.was_repaired() {
            self.sparse.missing.borrow_mut().clear();
            return Ok(None);
        }
        if self.needs_ranges() {
            return Ok(None);
        }
        result.map(Some)
    }

    pub(crate) fn feed(&mut self, offset: usize, bytes: &[u8]) -> bool {
        self.sparse.feed(offset, bytes)
    }

    pub(crate) fn full_bytes(&self) -> Option<&[u8]> {
        if !self.fallback {
            return None;
        }
        self.sparse.bytes(0..self.sparse.size)
    }

    fn head_and_tail(&mut self, limits: &Limits) -> Option<Plan> {
        let sparse = &self.sparse;
        let probe = sparse.tuning.probe.min(
            sparse
                .size
                .checked_div(8)
                .unwrap_or_default()
                .max(MIN_PROBE),
        );
        let head_end = probe.min(sparse.size);
        let tail_start = sparse.size.saturating_sub(probe);
        let mut wanted = Vec::new();
        if sparse.bytes(0..head_end).is_none() {
            wanted.push(0..head_end);
        }
        if sparse.bytes(tail_start..sparse.size).is_none() {
            wanted.push(tail_start..sparse.size);
        }
        if !wanted.is_empty() {
            return Some(sparse.plan_ranges(wanted, false));
        }
        let head = sparse.window(0, head_end);
        if !head.starts_with(b"%PDF-") {
            return Some(Plan::Fallback);
        }
        let tail = sparse.window(tail_start, sparse.size);
        self.next_section = find_startxref(tail);
        if self.next_section.is_none() && tail.len() < STARTXREF_PROBE.min(sparse.size) {
            return Some(sparse.plan_ranges(
                iter::once(sparse.size.saturating_sub(STARTXREF_PROBE)..sparse.size).collect(),
                false,
            ));
        }
        self.linearized = linearized_first_page(head, sparse.size, limits);
        self.next_section.is_none().then_some(Plan::Fallback)
    }

    fn hinted_end(&self) -> Option<usize> {
        let (end, page) = self.linearized?;
        if self.indexed
            && !matches!(self.index.table.get(widen(page)), Some(Entry::Offset(at)) if *at < end)
        {
            return None;
        }
        self.sparse.bytes(0..end).is_none().then_some(end)
    }

    fn index(&mut self, first: bool, limits: &Limits) -> Option<Plan> {
        if self.indexed {
            return None;
        }
        if self.next_section.is_none()
            && let Some(plan) = self.head_and_tail(limits)
        {
            return Some(plan);
        }
        let size = self.sparse.size;
        let bound = object_bound(size, limits);
        while let Some(offset) = self.next_section {
            if offset >= size
                || self.index.visited.len() >= MAX_SECTIONS
                || self.index.visited.contains(&offset)
            {
                return Some(Plan::Fallback);
            }
            let window = self.sparse.window(offset, size);
            let complete = offset.saturating_add(window.len()) == size;
            let parsed = Document::section_window(window, limits, complete);
            let Ok(section) = parsed else {
                let start = skip_whitespace_at(window, 0);
                if complete
                    || (window.len() >= MIN_PROBE
                        && start < window.len()
                        && !keyword_at(window, start, b"xref")
                        && parse_object_header(window, start).is_none())
                {
                    return Some(Plan::Fallback);
                }
                let tail_bytes = size.saturating_sub(offset);
                let current = if tail_bytes <= self.sparse.tuning.probe.saturating_mul(4) {
                    offset..size
                } else {
                    self.section_range(offset, window.len())
                };
                let mut wanted = vec![current];
                if let Some(prev) = self
                    .index
                    .hybrid
                    .as_ref()
                    .and_then(|base| previous_section(&base.trailer))
                    && prev < size
                    && prev != offset
                    && !self.index.visited.contains(&prev)
                {
                    wanted.push(self.section_range(prev, 0));
                }
                if first && let Some(end) = self.hinted_end() {
                    let mut speculative = wanted.clone();
                    speculative.push(0..end);
                    if let plan @ Plan::Need(_) = self.sparse.plan_ranges(speculative, false) {
                        return Some(plan);
                    }
                }
                return Some(self.sparse.plan_ranges(wanted, false));
            };
            let _: bool = self.index.visited.insert(offset);
            self.sparse.offsets.push(offset);
            self.accept_section(section, bound);
        }
        if self.index.table.is_empty() {
            return Some(Plan::Fallback);
        }
        self.sparse.offsets.sort_unstable();
        self.sparse.offsets.dedup();
        self.indexed = true;
        None
    }

    pub(crate) fn needs_ranges(&self) -> bool {
        self.sparse.misses() != 0
    }

    pub(crate) fn new(size: usize, tuning: Tuning) -> Self {
        Self {
            cache: DocumentCache::new(),
            fallback: false,
            frontier: None,
            index: Index::default(),
            indexed: false,
            linearized: None,
            next_section: None,
            render: false,
            sparse: Sparse {
                missing: RefCell::new(Vec::new()),
                offsets: Vec::new(),
                segments: Vec::new(),
                size,
                tuning,
            },
        }
    }

    pub(crate) fn plan(
        &mut self,
        requested: PageRequest<&[u32]>,
        render: bool,
        limits: &Limits,
    ) -> Plan {
        let misses = mem::take(self.sparse.missing.get_mut());
        let mut frontier = self
            .frontier
            .take()
            .filter(|frontier| frontier.selection.borrowed() == requested && self.render == render);
        if !misses.is_empty()
            && frontier
                .as_ref()
                .is_some_and(|selection| selection.pending.is_empty())
        {
            self.frontier = frontier;
            return self.sparse.plan_ranges(misses, true);
        }
        if self.render != render {
            self.cache = DocumentCache::new();
            self.render = render;
        }
        if self.sparse.size > limits.max_pdf_bytes {
            return Plan::Fallback;
        }
        let stop_after = requested.stop_after();
        let first = stop_after == Some(1);
        if let Some(plan) = self.index(first, limits) {
            return plan;
        }
        let mut repaired = false;
        let result = self.document(limits).and_then(|document| {
            let walked = Frontier::walk(&mut frontier, &document, &self.sparse, requested, render);
            repaired = document.was_repaired();
            walked
        });
        if repaired {
            self.sparse.missing.get_mut().clear();
            return Plan::Fallback;
        }
        self.frontier = frontier;
        if self.sparse.misses() != 0 {
            let wanted = mem::take(self.sparse.missing.get_mut());
            if first && let Some(end) = self.hinted_end() {
                let mut speculative = wanted.clone();
                speculative.push(0..end);
                if let plan @ Plan::Need(_) = self.sparse.plan_ranges(speculative, true) {
                    return plan;
                }
            }
            return self.sparse.plan_ranges(wanted, true);
        }
        match result {
            Ok(Some(failure)) => Plan::Failed(failure),
            Ok(None) if self.frontier.is_some() => Plan::Ready,
            Ok(None) | Err(_) => Plan::Fallback,
        }
    }

    pub(crate) fn plan_with_recovery(
        &mut self,
        requested: PageRequest<&[u32]>,
        render: bool,
        limits: &Limits,
        recover: bool,
    ) -> Plan {
        if !self.fallback {
            if !recover {
                let plan = self.plan(requested, render, limits);
                if !matches!(plan, Plan::Fallback) {
                    return plan;
                }
            }
            self.fallback = true;
            self.cache = DocumentCache::new();
            self.frontier = None;
            self.index = Index::default();
        }
        let wanted = 0..self.sparse.size;
        Plan::Full(
            self.sparse
                .round(self.sparse.ranges(slice::from_ref(&wanted), 0)),
        )
    }

    fn section_range(&self, offset: usize, length: usize) -> Range<usize> {
        offset
            ..offset
                .saturating_add(length.saturating_mul(2).max(self.sparse.tuning.probe))
                .min(self.sparse.size)
    }

    pub(crate) fn trim(&mut self, limit: usize) -> usize {
        let cached = self.sparse.cached_bytes();
        if cached <= limit || self.fallback && cached == self.sparse.size {
            return cached;
        }
        self.cache = DocumentCache::new();
        self.frontier = None;
        self.sparse.missing.get_mut().clear();
        let prefix = self
            .sparse
            .window(0, limit.min(self.sparse.tuning.probe))
            .to_vec();
        self.sparse.segments.clear();
        let retained = prefix.len();
        if retained != 0 {
            self.sparse.segments.push(Segment {
                bytes: prefix,
                start: 0,
            });
        }
        retained
    }
}

fn append_range(ranges: &mut Vec<Range<usize>>, range: Range<usize>, gap: usize) {
    if let Some(last) = ranges.last_mut()
        && range.start <= last.end.saturating_add(gap)
    {
        last.end = last.end.max(range.end);
    } else {
        ranges.push(range);
    }
}

fn linearized_first_page(bytes: &[u8], size: usize, limits: &Limits) -> Option<(usize, u32)> {
    let start = skip_whitespace_at(bytes, 0);
    let parsed = parse_indirect_object(bytes, start, limits.max_nesting, &|_| None).ok()?;
    let dict = parsed.object.as_dict()?;
    let integer = |key: &[u8]| usize::try_from(dict.get(key)?.as_integer()?).ok();
    let end = integer(b"E")?;
    let page = u32::try_from(integer(b"O")?).ok()?;
    let hints = dict.get(b"H")?.as_array()?;
    if dict.get(b"Linearized")?.as_number()? <= 0.0_f64
        || integer(b"L")? != size
        || page == 0
        || end <= parsed.end
        || end >= size
        || !matches!(hints.len(), 2 | 4)
    {
        return None;
    }
    for [at, len] in hints.as_chunks::<2>().0 {
        let offset = usize::try_from(at.as_integer()?).ok()?;
        let length = usize::try_from(len.as_integer()?).ok()?;
        if offset < parsed.end || length == 0 || offset.checked_add(length)? > size {
            return None;
        }
    }
    Some((end, page))
}

fn references(dict: &Dict, refs: &mut Vec<ObjRef>) {
    let object_type = dict.get(b"Type").and_then(Object::as_name);
    if matches!(object_type, Some(b"Page" | b"Pages" | b"Catalog")) {
        return;
    }
    let annotation = object_type == Some(b"Annot")
        || dict.get(b"Subtype").and_then(Object::as_name) == Some(b"Widget");
    for (key, value) in &dict.entries {
        if annotation && matches!(key.as_slice(), b"Parent" | b"P" | b"V") {
            continue;
        }
        if key == b"XObject" {
            continue;
        }
        collect(value, refs);
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

#[cfg(test)]
mod tests {
    use super::{Lazy, Plan, Tuning};
    use crate::document::PageRequest;
    use crate::failure::FailureCode;
    use crate::inspection::Limits;
    use crate::layout::{TextOptions, document_text, opened_text, text_limits};
    use crate::test_pdf::{build, stream_object};

    #[test]
    fn exact_selection_skips_unselected_leaf_resources() {
        let bytes = build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (
                2,
                "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>"
                    .to_owned(),
            ),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /Resources 6 0 R >>".to_owned(),
            ),
            (4, "<< /Type /Page /Parent 2 0 R >>".to_owned()),
            (5, format!("<{}>", "00".repeat(4 * 1024))),
            (6, "<< /Font << >> >>".to_owned()),
            (7, format!("<{}>", "00".repeat(4 * 1024))),
        ]);
        let marker = b"6 0 obj\n";
        let excluded = bytes
            .windows(marker.len())
            .position(|window| window == marker)
            .unwrap();
        let limits = Limits::default();
        let mut lazy = Lazy::new(
            bytes.len(),
            Tuning {
                gap: 0,
                probe: 128,
                round_bytes: 2048,
            },
        );
        let request = PageRequest::Indexes(Some(&[1][..]));
        for _ in 0_i32..16_i32 {
            match lazy.plan(request, false, &limits) {
                Plan::Need(ranges) => {
                    for range in ranges {
                        assert!(!range.contains(&excluded), "read unselected resources");
                        assert!(lazy.feed(range.start, &bytes[range.clone()]));
                    }
                }
                Plan::Ready => {
                    let indexes = lazy
                        .execute(&limits, |_, pages| {
                            Ok(pages.iter().map(|(index, _)| *index).collect::<Vec<_>>())
                        })
                        .unwrap();
                    assert_eq!(indexes, Some(vec![1]));
                    let missing = PageRequest::Indexes(Some(&[2][..]));
                    let Plan::Failed(failure) =
                        lazy.plan_with_recovery(missing, false, &limits, false)
                    else {
                        panic!("out-of-range selection did not fail");
                    };
                    assert_eq!(failure.code, FailureCode::InvalidPdf);
                    assert!(matches!(lazy.plan(request, false, &limits), Plan::Ready));
                    return;
                }
                Plan::Failed(_) | Plan::Fallback | Plan::Full(_) => {
                    panic!("exact selection requires fallback");
                }
            }
        }
        panic!("exact selection did not complete");
    }

    #[test]
    fn page_object_needing_repair_falls_back_instead_of_dropping_the_page() {
        let content = stream_object("", "BT /F1 12 Tf 72 700 Td (Second) Tj ET");
        let bytes = build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (
                2,
                "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>"
                    .to_owned(),
            ),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /Contents 5 0 (R >>".to_owned(),
            ),
            (
                4,
                "<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>"
                    .to_owned(),
            ),
            (5, content),
            (
                6,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
            ),
        ]);
        let limits = text_limits();
        let options = TextOptions {
            drop_running: false,
            markdown: false,
            merge_across_pages: false,
        };
        let request = PageRequest::First(2);
        let eager = document_text(&bytes, request, &limits, options).unwrap();
        let mut lazy = Lazy::new(
            bytes.len(),
            Tuning {
                gap: 0,
                probe: 64,
                round_bytes: 4096,
            },
        );
        for _ in 0_i32..64_i32 {
            match lazy.plan_with_recovery(request, false, &limits, false) {
                Plan::Need(ranges) | Plan::Full(ranges) if !ranges.is_empty() => {
                    for range in ranges {
                        assert!(lazy.feed(range.start, &bytes[range.clone()]));
                    }
                }
                Plan::Ready => {
                    let lazy_text = lazy
                        .execute(&limits, |opened, pages| {
                            opened_text(opened, pages, &limits, options)
                        })
                        .unwrap();
                    if let Some(pages) = lazy_text {
                        assert_eq!(pages, eager);
                        return;
                    }
                }
                Plan::Full(_) | Plan::Fallback => return,
                Plan::Need(_) | Plan::Failed(_) => panic!("unexpected lazy plan"),
            }
        }
        panic!("lazy plan did not settle");
    }
}
