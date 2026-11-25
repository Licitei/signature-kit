use alloc::rc::Rc;
use core::cell::{Cell, RefCell};
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
use crate::num::{sort_unstable_with, widen};
use crate::object::{Dict, ObjRef, Object, Resolver as _};
use crate::syntax::{
    find_bytes, is_regular, is_whitespace, keyword_at, parse_indirect_object, parse_object_header,
    skip_whitespace_at,
};

const DIGIT_BITS: u32 = 11;
const BUCKETS: usize = 1 << DIGIT_BITS;
const DIGIT_MASK: usize = BUCKETS - 1;
const MIN_SELECTIVE_BUDGET: usize = 2 * 1024 * 1024;
const MIN_PROBE: usize = 128;
const ROUND_SLACK: usize = 256;

#[derive(Debug)]
#[expect(
    clippy::exhaustive_enums,
    reason = "the internal ABI shares these variants with the WASM crate"
)]
pub enum Plan {
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
#[expect(
    clippy::exhaustive_structs,
    reason = "the internal ABI shares this struct with the WASM crate"
)]
pub struct Tuning {
    pub gap: usize,
    pub probe: usize,
    pub round_bytes: usize,
}

#[derive(Debug)]
pub(crate) struct Sparse {
    backlog: RefCell<Vec<Range<usize>>>,
    complete: bool,
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
        let absorbed: Vec<Segment> = self.segments.drain(first..after).collect();
        let last_end = absorbed.last().map_or(end, Segment::end).max(end);
        let mut segments = absorbed.into_iter().peekable();
        let mut merged = segments
            .next_if(|segment| segment.start <= offset)
            .unwrap_or(Segment {
                bytes: Vec::new(),
                start: offset,
            });
        let target = if self.complete && merged.start == 0 {
            self.size
        } else {
            last_end
        };
        merged
            .bytes
            .reserve_exact(target.saturating_sub(merged.end()));
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

    fn plan_ranges(&self, wanted: Vec<Range<usize>>, read_ahead: bool) -> Plan {
        self.plan_requests(wanted, read_ahead, false)
    }

    fn plan_requests(&self, mut wanted: Vec<Range<usize>>, read_ahead: bool, carry: bool) -> Plan {
        sort_unstable_with(&mut wanted, &|left, right| left.start.cmp(&right.start));
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
                return Plan::Need(self.round_with(requests, carry));
            }
        }
        let requests = self.ranges(&wanted, 0);
        if requests.is_empty() {
            return Plan::Fallback;
        }
        Plan::Need(self.round_with(requests, carry))
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

    fn round(&self, requests: Vec<Range<usize>>) -> Vec<Range<usize>> {
        self.round_with(requests, false)
    }

    fn round_with(&self, mut requests: Vec<Range<usize>>, carry: bool) -> Vec<Range<usize>> {
        let mut remaining = self.tuning.round_bytes;
        let mut backlog = self.backlog.borrow_mut();
        backlog.clear();
        for request in &mut requests {
            let length = request.len().min(remaining);
            let split = request.start.saturating_add(length);
            if carry && split < request.end {
                backlog.push(split..request.end);
            }
            request.end = split;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Prefetch,
    Probe,
}

#[derive(Debug)]
enum Source {
    Form(Rc<Object>),
    Page(usize),
}

#[derive(Debug)]
struct Job {
    parent: Rc<Object>,
    source: Source,
}

#[derive(Debug)]
struct Frontier {
    jobs: Vec<Job>,
    pages: Vec<(usize, Page)>,
    pending: Vec<ObjRef>,
    scanned: HashSet<u32>,
    selection: PageRequest<Vec<u32>>,
    visited: HashSet<u32>,
    xobjects: Vec<(ObjRef, Rc<Object>)>,
}

impl Frontier {
    fn advance(&mut self, document: &Document<'_>, sparse: &Sparse) -> Outcome<()> {
        let mut retry = Vec::new();
        let mut retry_xobjects = Vec::new();
        let mut retry_jobs = Vec::new();
        loop {
            while let Some(reference) = self.pending.pop() {
                if !self.visited.insert(reference.number) {
                    continue;
                }
                let before = sparse.misses();
                let object = document.load_transient(reference)?;
                if sparse.misses() == before {
                    collect(&object, &mut self.pending);
                } else {
                    retry.push(reference);
                }
            }
            if let Some((reference, parent)) = self.xobjects.pop() {
                if let Some(missed) = self.load_xobject(document, sparse, reference, parent)? {
                    retry_xobjects.push(missed);
                }
                continue;
            }
            let Some(job) = self.jobs.pop() else {
                break;
            };
            if !self.scan(document, sparse, &job)? {
                retry_jobs.push(job);
            }
        }
        for reference in &retry {
            let _: bool = self.visited.remove(&reference.number);
        }
        self.pending = retry;
        self.xobjects = retry_xobjects;
        self.jobs = retry_jobs;
        Ok(())
    }

    fn load_xobject(
        &mut self,
        document: &Document<'_>,
        sparse: &Sparse,
        reference: ObjRef,
        parent: Rc<Object>,
    ) -> Outcome<Option<(ObjRef, Rc<Object>)>> {
        let before = sparse.misses();
        let object = document.load_transient(reference)?;
        if sparse.misses() != before {
            return Ok(Some((reference, parent)));
        }
        if let Object::Stream(stream) = &*object
            && stream.dict.get(b"Subtype").and_then(Object::as_name) == Some(b"Form")
        {
            collect(&object, &mut self.pending);
            self.jobs.push(Job {
                parent,
                source: Source::Form(object),
            });
        }
        Ok(None)
    }

    fn new(
        document: &Document<'_>,
        selection: PageRequest<&[u32]>,
        pages: Vec<(usize, Page)>,
        render: bool,
        prefetch: bool,
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
        let mut frontier = Self {
            jobs: Vec::new(),
            selection: selection.owned(),
            pages,
            pending,
            scanned: HashSet::new(),
            visited: HashSet::new(),
            xobjects: Vec::new(),
        };
        if prefetch {
            frontier.queue_scans();
        }
        Ok(frontier)
    }

    fn queue_scans(&mut self) {
        for (index, (_, page)) in self.pages.iter().enumerate().rev() {
            if page
                .resources
                .as_dict()
                .is_some_and(|dict| dict.get(b"XObject").is_some())
            {
                self.jobs.push(Job {
                    parent: Rc::clone(&page.resources),
                    source: Source::Page(index),
                });
            }
        }
    }

    const fn ready(&self) -> bool {
        self.pending.is_empty() && self.xobjects.is_empty() && self.jobs.is_empty()
    }

    fn scan(&mut self, document: &Document<'_>, sparse: &Sparse, job: &Job) -> Outcome<bool> {
        let before = sparse.misses();
        let data = match &job.source {
            Source::Page(index) => self
                .pages
                .get(*index)
                .and_then(|(_, page)| document.content(page).ok()),
            Source::Form(object) => object
                .as_stream()
                .and_then(|stream| document.stream_data(stream).ok()),
        };
        if sparse.misses() != before {
            return Ok(false);
        }
        let Some(content) = data else {
            return Ok(true);
        };
        if find_bytes(&content, 0, b"Do").is_none() {
            return Ok(true);
        }
        let resources = match &job.source {
            Source::Form(object) => {
                match object.as_dict().and_then(|dict| dict.get(b"Resources")) {
                    Some(own) => {
                        let found = document.follow(own)?;
                        if found.as_dict().is_some() {
                            found
                        } else {
                            Rc::clone(&job.parent)
                        }
                    }
                    None => Rc::clone(&job.parent),
                }
            }
            Source::Page(_) => Rc::clone(&job.parent),
        };
        let Some(entry) = resources.as_dict().and_then(|dict| dict.get(b"XObject")) else {
            return Ok(sparse.misses() == before);
        };
        let table = document.follow(entry)?;
        if sparse.misses() != before {
            return Ok(false);
        }
        let Some(dict) = table.as_dict() else {
            return Ok(true);
        };
        invoked_names(&content, |name| {
            if let Some(&Object::Ref(reference)) = dict.get(name)
                && self.scanned.insert(reference.number)
            {
                self.xobjects.push((reference, Rc::clone(&resources)));
            }
        });
        Ok(true)
    }

    fn walk(
        frontier: &mut Option<Self>,
        document: &Document<'_>,
        sparse: &Sparse,
        requested: PageRequest<&[u32]>,
        render: bool,
        prefetch: bool,
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
            *frontier = Some(Self::new(document, requested, pages, render, prefetch)?);
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
pub struct Lazy {
    cache: DocumentCache,
    fallback: bool,
    frontier: Option<Frontier>,
    index: Index,
    indexed: bool,
    linearized: Option<(usize, u32)>,
    next_section: Option<usize>,
    phase: Phase,
    render: bool,
    rounds: Cell<usize>,
    sparse: Sparse,
    stalled: Cell<bool>,
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

    fn document(&self, limits: &Limits, abort: bool) -> Outcome<Document<'_>> {
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
            abort,
        )
    }

    #[expect(
        clippy::missing_errors_doc,
        reason = "the TypeScript bindings document the public error contract"
    )]
    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    pub fn execute<A, Run>(&self, limits: &Limits, run: Run) -> Outcome<Option<A>>
    where
        Run: FnOnce(&Document<'_>, &[(usize, &Page)]) -> Outcome<A>,
    {
        let document = self.document(limits, self.phase == Phase::Probe)?;
        let frontier = self
            .frontier
            .as_ref()
            .filter(|frontier| frontier.ready())
            .ok_or_else(|| Failure::invalid("lazy plan is not ready"))?;
        let result = run(&document, &borrow_pages(&frontier.pages));
        if document.was_repaired() {
            self.sparse.missing.borrow_mut().clear();
            self.stalled.set(true);
            return Ok(None);
        }
        if self.needs_ranges() {
            return Ok(None);
        }
        self.rounds.set(0);
        result.map(Some)
    }

    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    pub fn feed(&mut self, offset: usize, bytes: &[u8]) -> bool {
        self.sparse.feed(offset, bytes)
    }

    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    pub fn full_bytes(&self) -> Option<&[u8]> {
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
        radix_sort(&mut self.sparse.offsets);
        self.sparse.offsets.dedup();
        self.indexed = true;
        None
    }

    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    pub fn needs_ranges(&self) -> bool {
        self.sparse.misses() != 0
    }

    #[must_use]
    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    pub fn new(size: usize, tuning: Tuning) -> Self {
        Self {
            cache: DocumentCache::new(),
            fallback: false,
            frontier: None,
            index: Index::default(),
            indexed: false,
            linearized: None,
            next_section: None,
            phase: Phase::Probe,
            render: false,
            rounds: Cell::new(0),
            sparse: Sparse {
                backlog: RefCell::new(Vec::new()),
                complete: false,
                missing: RefCell::new(Vec::new()),
                offsets: Vec::new(),
                segments: Vec::new(),
                size,
                tuning,
            },
            stalled: Cell::new(false),
        }
    }

    pub(crate) fn plan(
        &mut self,
        requested: PageRequest<&[u32]>,
        render: bool,
        limits: &Limits,
    ) -> Plan {
        if self.stalled.get() {
            return Plan::Fallback;
        }
        let misses = mem::take(self.sparse.missing.get_mut());
        let backlog = mem::take(self.sparse.backlog.get_mut());
        let mut frontier = self
            .frontier
            .take()
            .filter(|frontier| frontier.selection.borrowed() == requested && self.render == render);
        if frontier.as_ref().is_some_and(Frontier::ready) {
            if misses.is_empty() {
                let outstanding = self.sparse.ranges(&backlog, 0);
                if !outstanding.is_empty() {
                    self.frontier = frontier;
                    return Plan::Need(self.sparse.round_with(outstanding, true));
                }
            } else {
                let probing = self.phase == Phase::Probe;
                self.phase = Phase::Prefetch;
                if probing && let Some(selection) = &mut frontier {
                    selection.queue_scans();
                }
                if frontier.as_ref().is_some_and(Frontier::ready) {
                    self.frontier = frontier;
                    return self.sparse.plan_requests(misses, true, true);
                }
            }
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
        let result = self.document(limits, false).and_then(|document| {
            let walked = Frontier::walk(
                &mut frontier,
                &document,
                &self.sparse,
                requested,
                render,
                self.phase == Phase::Prefetch,
            );
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

    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    pub fn plan_with_recovery(
        &mut self,
        requested: PageRequest<&[u32]>,
        render: bool,
        limits: &Limits,
        recover: bool,
    ) -> Plan {
        if !self.fallback {
            if !recover {
                let plan = self.plan(requested, render, limits);
                let rounds = self.rounds.get().saturating_add(1);
                self.rounds.set(rounds);
                if !matches!(plan, Plan::Fallback)
                    && (rounds <= self.round_cap() || matches!(plan, Plan::Failed(_)))
                {
                    return plan;
                }
            }
            self.fallback = true;
            self.sparse.complete = true;
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

    pub(crate) fn round_cap(&self) -> usize {
        self.sparse
            .size
            .div_ceil(self.sparse.tuning.round_bytes.max(1))
            .saturating_mul(2)
            .saturating_add(ROUND_SLACK)
    }

    fn section_range(&self, offset: usize, length: usize) -> Range<usize> {
        offset
            ..offset
                .saturating_add(length.saturating_mul(2).max(self.sparse.tuning.probe))
                .min(self.sparse.size)
    }

    #[expect(
        clippy::missing_inline_in_public_items,
        reason = "release LTO chooses inlining across the internal Rust boundary"
    )]
    pub fn trim(&mut self, limit: usize) -> usize {
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

fn radix_sort(values: &mut Vec<usize>) {
    let mut scratch = vec![0_usize; values.len()];
    let top = values.iter().copied().max().unwrap_or(0);
    let mut shift = 0_u32;
    while top.checked_shr(shift).is_some_and(|rest| rest != 0) {
        let mut starts = [0_usize; BUCKETS];
        for &value in values.iter() {
            if let Some(slot) = starts.get_mut(digit(value, shift)) {
                *slot = slot.saturating_add(1);
            }
        }
        let mut running = 0_usize;
        for slot in &mut starts {
            let count = *slot;
            *slot = running;
            running = running.saturating_add(count);
        }
        for &value in values.iter() {
            if let Some(slot) = starts.get_mut(digit(value, shift)) {
                if let Some(target) = scratch.get_mut(*slot) {
                    *target = value;
                }
                *slot = slot.saturating_add(1);
            }
        }
        mem::swap(values, &mut scratch);
        shift = shift.saturating_add(DIGIT_BITS);
    }
}

fn digit(value: usize, shift: u32) -> usize {
    value.checked_shr(shift).unwrap_or(0) & DIGIT_MASK
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

fn invoked_names(data: &[u8], mut visit: impl FnMut(&[u8])) {
    let mut at = 0_usize;
    while let Some(found) = find_bytes(data, at, b"Do") {
        at = found.saturating_add(2);
        if data.get(at).copied().is_some_and(is_regular) {
            continue;
        }
        let Some(head) = data.get(..found) else {
            continue;
        };
        let end = head
            .iter()
            .rposition(|&byte| !is_whitespace(byte))
            .map_or(0, |last| last.saturating_add(1));
        if end == found {
            continue;
        }
        let Some(word) = head.get(..end) else {
            continue;
        };
        let Some(slash) = word.iter().rposition(|&byte| !is_regular(byte)) else {
            continue;
        };
        if let Some((&b'/', name)) = word.get(slash..).and_then(<[u8]>::split_first)
            && !name.is_empty()
        {
            visit(name);
        }
    }
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
    use super::{Lazy, Plan, Tuning, invoked_names};
    use crate::document::PageRequest;
    use crate::failure::FailureCode;
    use crate::inspection::Limits;
    use crate::layout::{TextOptions, document_text, opened_text, text_limits};
    use crate::num::widen;
    use crate::test_pdf::{build, stream_object};

    #[test]
    fn out_of_order_feeds_merge_into_one_exact_segment() {
        let bytes: Vec<u8> = (0_u32..10_000)
            .map(|index| u8::try_from(index.rem_euclid(251)).unwrap())
            .collect();
        let tuning = Tuning {
            gap: 0,
            probe: 128,
            round_bytes: 2048,
        };
        for complete in [false, true] {
            let mut lazy = Lazy::new(bytes.len(), tuning);
            lazy.sparse.complete = complete;
            for range in [
                0..100,
                5_000..6_000,
                100..2_500,
                9_000..10_000,
                2_400..5_100,
            ] {
                assert!(lazy.feed(range.start, &bytes[range.clone()]));
            }
            assert_eq!(lazy.sparse.segments.len(), 2);
            assert_eq!(lazy.sparse.bytes(0..6_000), Some(&bytes[..6_000]));
            assert!(lazy.feed(6_000, &bytes[6_000..9_000]));
            assert_eq!(lazy.sparse.segments.len(), 1);
            assert_eq!(lazy.sparse.bytes(0..bytes.len()), Some(bytes.as_slice()));
            assert!(lazy.sparse.segments[0].bytes.capacity() >= bytes.len());
        }
    }

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

    #[test]
    fn radix_sort_matches_the_standard_sort() {
        let mut state = 0x2545_F491_4F6C_DD1D_u64;
        let mut values: Vec<usize> = (0_u32..5_000)
            .map(|index| {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                usize::try_from(state >> (40_u32 + index.min(20))).unwrap()
            })
            .collect();
        values.push(usize::MAX);
        values.push(0);
        let mut expected = values.clone();
        expected.sort_unstable();
        super::radix_sort(&mut values);
        assert_eq!(values, expected);
        let mut empty: Vec<usize> = Vec::new();
        super::radix_sort(&mut empty);
        assert_eq!(empty, Vec::<usize>::new());
    }

    #[test]
    fn invoked_names_reads_names_before_do_operators() {
        let names = |data: &[u8]| {
            let mut found: Vec<Vec<u8>> = Vec::new();
            invoked_names(data, |name| found.push(name.to_vec()));
            found
        };
        assert_eq!(
            names(b"q /Im0 Do Q\n/Fm1\nDo /Domain 1 Tf (Do) Tj /Fm2 Do"),
            vec![b"Im0".to_vec(), b"Fm1".to_vec(), b"Fm2".to_vec()]
        );
        assert_eq!(names(b"Do /A Do Do"), vec![b"A".to_vec()]);
        assert_eq!(names(b"BT (x) Tj ET"), Vec::<Vec<u8>>::new());
    }

    #[test]
    fn nested_forms_settle_after_one_probe_run_and_match_eager_text() {
        let outer = stream_object(
            "/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> /XObject << /Fm2 6 0 R >> >>",
            "BT /F1 12 Tf 72 100 Td (Outer) Tj ET /Fm2 Do",
        );
        let inner = stream_object(
            "/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /Font << /F1 7 0 R >> >>",
            "BT /F1 12 Tf 72 50 Td (Inner) Tj ET",
        );
        let bytes = build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (
                2,
                "<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>".to_owned(),
            ),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Fm1 5 0 R >> >> >>"
                    .to_owned(),
            ),
            (4, stream_object("", "/Fm1 Do")),
            (5, outer),
            (6, inner),
            (
                7,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
            ),
        ]);
        let limits = text_limits();
        let options = TextOptions {
            drop_running: false,
            markdown: false,
            merge_across_pages: false,
        };
        let request = PageRequest::First(1);
        let eager = document_text(&bytes, request, &limits, options).unwrap();
        let mut lazy = Lazy::new(
            bytes.len(),
            Tuning {
                gap: 0,
                probe: 64,
                round_bytes: 4096,
            },
        );
        let mut runs = 0_u32;
        for _ in 0_i32..64_i32 {
            match lazy.plan_with_recovery(request, false, &limits, false) {
                Plan::Need(ranges) if !ranges.is_empty() => {
                    for range in ranges {
                        assert!(lazy.feed(range.start, &bytes[range.clone()]));
                    }
                }
                Plan::Ready => {
                    runs += 1;
                    let text = lazy
                        .execute(&limits, |opened, pages| {
                            opened_text(opened, pages, &limits, options)
                        })
                        .unwrap();
                    if let Some(pages) = text {
                        assert_eq!(pages, eager);
                        assert!(runs <= 2, "took {runs} runs");
                        return;
                    }
                }
                Plan::Need(_) | Plan::Failed(_) | Plan::Fallback | Plan::Full(_) => {
                    panic!("unexpected lazy plan")
                }
            }
        }
        panic!("lazy plan did not settle");
    }

    #[test]
    fn truncated_rounds_carry_the_remaining_ranges_without_another_run() {
        let bytes = build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (
                2,
                "<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>".to_owned(),
            ),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R /Im1 6 0 R /Im2 7 0 R >> >> >>"
                    .to_owned(),
            ),
            (4, stream_object("", "/Im0 Do /Im1 Do /Im2 Do")),
            (5, stream_object("/Type /XObject /Subtype /Image /Width 1 /Height 1", &"A".repeat(3000))),
            (6, stream_object("/Type /XObject /Subtype /Image /Width 1 /Height 1", &"B".repeat(3000))),
            (7, stream_object("/Type /XObject /Subtype /Image /Width 1 /Height 1", &"C".repeat(3000))),
        ]);
        let limits = text_limits();
        let options = TextOptions {
            drop_running: false,
            markdown: false,
            merge_across_pages: false,
        };
        let request = PageRequest::First(1);
        let eager = document_text(&bytes, request, &limits, options).unwrap();
        let mut lazy = Lazy::new(
            bytes.len(),
            Tuning {
                gap: 0,
                probe: 64,
                round_bytes: 1024,
            },
        );
        let mut runs = 0_u32;
        for _ in 0_i32..128_i32 {
            match lazy.plan_with_recovery(request, false, &limits, false) {
                Plan::Need(ranges) if !ranges.is_empty() => {
                    for range in ranges {
                        assert!(lazy.feed(range.start, &bytes[range.clone()]));
                    }
                }
                Plan::Ready => {
                    runs += 1;
                    let text = lazy
                        .execute(&limits, |opened, pages| {
                            opened_text(opened, pages, &limits, options)
                        })
                        .unwrap();
                    if let Some(pages) = text {
                        assert_eq!(pages, eager);
                        assert!(runs <= 2, "took {runs} runs");
                        return;
                    }
                }
                Plan::Need(_) | Plan::Failed(_) | Plan::Fallback | Plan::Full(_) => {
                    panic!("unexpected lazy plan")
                }
            }
        }
        panic!("lazy plan did not settle");
    }

    #[test]
    fn repair_found_while_running_falls_back_instead_of_planning_ready_again() {
        let mut bytes = build(&[
            (5, "<< /Type /ExtGState /ca 1 >>".to_owned()),
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (
                2,
                "<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>".to_owned(),
            ),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /ExtGState << /G0 5 0 R >> /Font << /F1 6 0 R >> >> >>"
                    .to_owned(),
            ),
            (
                4,
                stream_object("", "/G0 gs BT /F1 12 Tf 72 100 Td (Hi) Tj ET"),
            ),
            (
                6,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
            ),
        ]);
        let marker = b"/ca 1 >>\nendobj";
        let at = bytes
            .windows(marker.len())
            .position(|window| window == marker)
            .unwrap();
        assert!(at + marker.len() < 64);
        bytes[at + marker.len() - 5] = b'#';
        let limits = text_limits();
        let options = TextOptions {
            drop_running: false,
            markdown: false,
            merge_across_pages: false,
        };
        let request = PageRequest::First(1);
        let mut lazy = Lazy::new(
            bytes.len(),
            Tuning {
                gap: 0,
                probe: 64,
                round_bytes: 4096,
            },
        );
        let mut stalls = 0_u32;
        for _ in 0_i32..64_i32 {
            match lazy.plan_with_recovery(request, false, &limits, false) {
                Plan::Need(ranges) | Plan::Full(ranges) if !ranges.is_empty() => {
                    for range in ranges {
                        assert!(lazy.feed(range.start, &bytes[range.clone()]));
                    }
                }
                Plan::Ready => {
                    let text = lazy
                        .execute(&limits, |opened, pages| {
                            opened_text(opened, pages, &limits, options)
                        })
                        .unwrap();
                    assert!(text.is_none(), "repaired lazy run returned text");
                    assert!(!lazy.needs_ranges());
                    stalls += 1;
                }
                Plan::Full(_) => {
                    assert_eq!(stalls, 1);
                    assert_eq!(lazy.full_bytes(), Some(bytes.as_slice()));
                    return;
                }
                Plan::Need(_) | Plan::Failed(_) | Plan::Fallback => {
                    panic!("unexpected lazy plan")
                }
            }
        }
        panic!("lazy plan did not settle");
    }

    #[test]
    fn reference_chains_longer_than_the_round_cap_fall_back() {
        for (depth, falls_back) in [(40_u32, false), (600_u32, true)] {
            let mut objects = vec![
                (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
                (
                    2,
                    "<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>".to_owned(),
                ),
                (
                    3,
                    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> >>"
                        .to_owned(),
                ),
            ];
            objects.extend((4..depth + 4).map(|number| (number, format!("[{} 0 R]", number + 1))));
            objects.push((depth + 4, "null".to_owned()));
            let bytes = build(&objects);
            let limits = text_limits();
            let request = PageRequest::First(1);
            let mut lazy = Lazy::new(
                bytes.len(),
                Tuning {
                    gap: 0,
                    probe: 64,
                    round_bytes: 512,
                },
            );
            assert_eq!(lazy.round_cap() < widen(depth), falls_back);
            let bound = lazy.round_cap() + bytes.len().div_ceil(512) + 8;
            let mut lazy_rounds = 0_usize;
            let settled = (0..bound).find_map(|_| {
                match lazy.plan_with_recovery(request, false, &limits, false) {
                    Plan::Need(ranges) => {
                        lazy_rounds += 1;
                        for range in ranges {
                            assert!(lazy.feed(range.start, &bytes[range.clone()]));
                        }
                        None
                    }
                    Plan::Full(ranges) if !ranges.is_empty() => {
                        for range in ranges {
                            assert!(lazy.feed(range.start, &bytes[range.clone()]));
                        }
                        None
                    }
                    Plan::Full(_) => Some(true),
                    Plan::Ready => Some(false),
                    Plan::Failed(_) | Plan::Fallback => panic!("unexpected lazy plan"),
                }
            });
            assert_eq!(settled, Some(falls_back), "depth {depth}");
            assert!(lazy_rounds <= lazy.round_cap(), "depth {depth}");
            if falls_back {
                assert_eq!(lazy.full_bytes(), Some(bytes.as_slice()));
            }
        }
    }
}
