use crate::num::{f64_to_i64, f64_to_usize, fold_char, widen};
use core::cmp::Ordering;
use core::mem;
use std::collections::{HashMap, HashSet};

use crate::document::{Document, Page, pick_pages, select_pages};
use crate::failure::{Failure, FailureCode, Outcome};
use crate::inspection::Limits;
use crate::inspection::LinkInfo;
use crate::markdown::{
    MdBlock, MdItem, MdLine, MdRun, document_metrics, join_pages, page_blocks, render_page,
};
use crate::table::{
    Cell, Rule, Table, column_of, merge_row, render_markdown, render_text, ruled_grids,
};
use crate::text::{Capture, PageContent, Reposition, Session, extract_content};

const CELL_GAP: f64 = 1.75;
const INTRA_WORD_SCALE: f64 = 4.0;
const COMPACT_GAP_EM: f64 = 1.0;
const WORD_GAP: f64 = 0.12;
const LINE_PITCH: f64 = 1.5;
const CELL_EM: f64 = 20.0;
const SIZE_TOLERANCE: f64 = 0.25;
const SAME_LINE: f64 = 0.5;
const LOOKBACK: usize = 8;
const CORE_TOP: f64 = 0.15;
const CORE_BOTTOM: f64 = 0.2;
const DUPLICATE_OVERLAP: f64 = 0.5;
const MAX_CUT_DEPTH: usize = 48;
const FLOWING_LINES: usize = 3;

const ROW_GAP: f64 = 2.6;

const WRAP_GAP: f64 = 1.7;

const HEADER_BAND: f64 = 0.1;

const ALIGNED_SIZE: f64 = 0.15;

const MIN_FILLED_CELLS: usize = 2;

const MARKER_CHARS: usize = 12;

const TEXT_RECURRING: Recurring = Recurring {
    min_pages: 2,
    share: 2,
};

const MARKDOWN_RECURRING: Recurring = Recurring {
    min_pages: 3,
    share: 20,
};

const FURNITURE_BLOCKS: usize = 3;

const FURNITURE_PITCH: f64 = 2.0;

const FURNITURE_MIN_PAGES: usize = 3;

const FURNITURE_SHARE: usize = 20;

pub(crate) struct Heading {
    pub bold: bool,
    pub bounds: [f64; 4],
    pub font_size: f64,
    pub isolation: f64,
    pub italic: bool,
    pub reading_order: usize,
    pub relative_font_size: f64,
    pub running_band: bool,
    pub text: String,
}

pub(crate) struct HeadingPage {
    pub candidates: Vec<Heading>,
    pub page_index: usize,
}

#[derive(Clone, Copy)]
struct Frag<'data> {
    bold: bool,
    italic: bool,
    size: f64,
    text: &'data str,
    x0: f64,
    x1: f64,
    y0: f64,
    y1: f64,
}

impl Frag<'_> {
    const fn center(&self) -> f64 {
        f64::midpoint(self.y0, self.y1)
    }

    fn height(&self) -> f64 {
        self.y1 - self.y0
    }
}

struct Line {
    center: f64,
    height: f64,
    members: Vec<usize>,
}

struct Segment {
    bold: bool,
    center: f64,
    continuation: bool,
    italic: bool,
    members: Vec<usize>,
    size: f64,
    x0: f64,
    x1: f64,
    y0: f64,
    y1: f64,
}

struct Block {
    bottom: f64,
    last: usize,
    last_center: f64,
    last_size: f64,
    last_x0: f64,
    last_x1: f64,
    segments: Vec<usize>,
    table: Option<usize>,
    top: f64,
    x0: f64,
    x1: f64,
}

struct Sweep {
    order: Vec<usize>,
    reach: Vec<f64>,
    starts: Vec<f64>,
}

impl Sweep {
    fn new(spans: impl Iterator<Item = (usize, f64, f64)>) -> Self {
        let mut items: Vec<(usize, f64, f64)> = spans.collect();
        items.sort_unstable_by(|left, right| left.1.total_cmp(&right.1));
        let mut reach = Vec::with_capacity(items.len());
        let mut furthest = f64::NEG_INFINITY;
        for item in &items {
            furthest = furthest.max(item.2);
            reach.push(furthest);
        }
        Self {
            order: items.iter().map(|item| item.0).collect(),
            starts: items.iter().map(|item| item.1).collect(),
            reach,
        }
    }

    fn unique(&self, x0: f64, x1: f64, mut accept: impl FnMut(usize) -> bool) -> Option<usize> {
        let upper = self.starts.partition_point(|&start| start < x1);
        let mut found = None;
        for position in (0..upper).rev() {
            if self.reach.get(position).is_none_or(|&reach| reach <= x0) {
                break;
            }
            let Some(&id) = self.order.get(position) else {
                break;
            };
            if accept(id) {
                if found.is_some() {
                    return None;
                }
                found = Some(id);
            }
        }
        found
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Band {
    Bottom,
    Free,
    Top,
}

struct Piece {
    band: Band,
    lead: &'static str,
    text: String,
}

#[derive(Clone, Copy)]
struct Mode {
    aligned: bool,
    budget: TextBudget,
    markdown: bool,
    text: bool,
}

#[derive(Default)]
struct PoolOut {
    md: Vec<MdItem>,
    pieces: Vec<Piece>,
    tables: Vec<Table>,
}

#[derive(Default)]
struct PageLayout {
    bounded_text: Option<String>,
    height: f64,
    md: Vec<MdItem>,
    pieces: Vec<Piece>,
    tables: Vec<Table>,
}

type LinkRect = ([f64; 4], usize);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TextBudget {
    pub max_blocks: Option<usize>,
    pub max_chars: Option<usize>,
}

impl TextBudget {
    pub(crate) const UNLIMITED: Self = Self {
        max_chars: None,
        max_blocks: None,
    };

    const fn bounded(self) -> bool {
        self.max_chars.is_some() || self.max_blocks.is_some()
    }
}

pub(crate) struct TextOutput {
    budget: TextBudget,
    text: String,
}

impl TextOutput {
    pub(crate) fn append(&mut self, separator: &str, text: &str) -> bool {
        let lead = if self.text.is_empty() { "" } else { separator };
        if let Some(remaining) = self.budget.max_chars.as_mut() {
            let length = lead.len().saturating_add(text.chars().count());
            let Some(left) = remaining.checked_sub(length) else {
                return false;
            };
            *remaining = left;
        }
        if let Some(remaining) = self.budget.max_blocks.as_mut() {
            *remaining = remaining.saturating_sub(1);
        }
        self.text.push_str(lead);
        self.text.push_str(text);
        true
    }

    pub(crate) fn full(&self) -> bool {
        self.budget.max_blocks == Some(0) || self.budget.max_chars == Some(0)
    }

    pub(crate) fn into_text(self) -> String {
        self.text
    }

    pub(crate) const fn new(budget: TextBudget) -> Self {
        Self {
            budget,
            text: String::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TextOptions {
    pub budget: TextBudget,
    pub drop_running: bool,
    pub markdown: bool,
}

type RunningKeys = HashMap<(bool, String), usize>;
struct Recurrence {
    count: usize,
    digits: String,
    first: usize,
    varying: bool,
}
#[derive(Clone, Copy)]
struct Recurring {
    min_pages: usize,
    share: usize,
}
type FurnitureKey = (String, i64, i64);
fn turn(quarter: usize, x: f64, y: f64) -> (f64, f64) {
    match quarter & 3 {
        0 => (x, y),
        1 => (y, -x),
        2 => (-x, -y),
        _ => (-y, x),
    }
}
fn quarter_of(direction: (f64, f64)) -> usize {
    let (dx, dy) = direction;
    if dx.abs() >= dy.abs() {
        if dx >= 0.0 { 0 } else { 2 }
    } else if dy >= 0.0 {
        1
    } else {
        3
    }
}

fn page_quarter(rotate: i32) -> usize {
    let normalized = rotate.rem_euclid(360);
    usize::try_from(normalized.div_euclid(90)).unwrap_or(0) & 3
}

fn compare(left: f64, right: f64) -> Ordering {
    left.total_cmp(&right)
}

fn sort_frag_indices_by_center(order: &mut [usize], frags: &[Frag<'_>]) {
    order.sort_unstable_by(|&a, &b| match (frags.get(a), frags.get(b)) {
        (Some(left), Some(right)) => {
            compare(right.center(), left.center()).then_with(|| compare(left.x0, right.x0))
        }
        _ => Ordering::Equal,
    });
}

fn sort_frag_indices_by_x0(order: &mut [usize], frags: &[Frag<'_>]) {
    order.sort_unstable_by(|&a, &b| match (frags.get(a), frags.get(b)) {
        (Some(left), Some(right)) => compare(left.x0, right.x0),
        _ => Ordering::Equal,
    });
}

fn sort_block_indices_reading(order: &mut [usize], blocks: &[Block]) {
    order.sort_unstable_by(|&a, &b| match (blocks.get(a), blocks.get(b)) {
        (Some(left), Some(right)) => {
            compare(right.top, left.top).then_with(|| compare(left.x0, right.x0))
        }
        _ => Ordering::Equal,
    });
}

fn cluster_lines(frags: &[Frag<'_>]) -> Vec<Line> {
    let mut order: Vec<usize> = (0..frags.len()).collect();
    sort_frag_indices_by_center(&mut order, frags);
    let mut lines: Vec<Line> = Vec::new();
    for index in order {
        let Some(frag) = frags.get(index) else {
            continue;
        };
        let center = frag.center();
        let height = frag.height();
        let start = lines.len().saturating_sub(LOOKBACK);
        let mut target = None;
        for (position, line) in lines.iter().enumerate().skip(start).rev() {
            if (line.center - center).abs() <= SAME_LINE * line.height.min(height) {
                target = Some(position);
                break;
            }
        }
        match target.and_then(|position| lines.get_mut(position)) {
            Some(line) => {
                line.members.push(index);
                line.height = line.height.min(height);
            }
            None => lines.push(Line {
                center,
                height,
                members: vec![index],
            }),
        }
    }
    lines
}

fn line_cell_split_em(frags: &[Frag<'_>], members: &[usize]) -> f64 {
    let mut gaps: Vec<f64> = Vec::new();
    let mut ordered = members.to_vec();
    sort_frag_indices_by_x0(&mut ordered, frags);
    let mut previous: Option<&Frag<'_>> = None;
    for index in ordered {
        let Some(frag) = frags.get(index) else {
            continue;
        };
        if let Some(left) = previous {
            let gap = frag.x0 - left.x1;
            if gap > 0.0_f64 {
                let em = left.size.max(frag.size);
                if em > 0.0_f64 {
                    gaps.push(gap / em);
                }
            }
        }
        previous = Some(frag);
    }
    let mut compact: Vec<f64> = gaps
        .into_iter()
        .filter(|gap| *gap <= COMPACT_GAP_EM)
        .collect();
    if compact.is_empty() {
        return CELL_GAP;
    }
    compact.sort_unstable_by(f64::total_cmp);
    let bucket = usize::midpoint(0, compact.len());
    let typical = compact.get(bucket).copied().unwrap_or(WORD_GAP);
    CELL_GAP.max(typical * INTRA_WORD_SCALE)
}

fn drop_duplicates(frags: &[Frag<'_>], members: &mut Vec<usize>) {
    if members.len() < 2 {
        return;
    }
    let mut kept: Vec<usize> = Vec::with_capacity(members.len());
    for &index in members.iter() {
        let Some(frag) = frags.get(index) else {
            continue;
        };
        let duplicate = kept
            .last()
            .and_then(|&previous| frags.get(previous))
            .is_some_and(|prior| {
                let overlap = prior.x1.min(frag.x1) - prior.x0.max(frag.x0);
                let width = (frag.x1 - frag.x0).min(prior.x1 - prior.x0);
                prior.text == frag.text && width > 0.0_f64 && overlap >= DUPLICATE_OVERLAP * width
            });
        if !duplicate {
            kept.push(index);
        }
    }
    *members = kept;
}

fn split_segments(frags: &[Frag<'_>], line: &Line, out: &mut Vec<Segment>) {
    let mut members = line.members.clone();
    sort_frag_indices_by_x0(&mut members, frags);
    drop_duplicates(frags, &mut members);
    let split_em = line_cell_split_em(frags, &members);
    let mut current: Option<Segment> = None;
    let mut right_edge = f64::NEG_INFINITY;
    let mut right_size = 0.0_f64;
    for index in members {
        let Some(frag) = frags.get(index) else {
            continue;
        };
        let gap = frag.x0 - right_edge;
        let em = frag.size.max(right_size);
        let split = current.is_some() && gap > split_em * em;
        if split && let Some(done) = current.take() {
            out.push(done);
        }
        if let Some(segment) = current.as_mut() {
            segment.members.push(index);
            segment.x0 = segment.x0.min(frag.x0);
            segment.x1 = segment.x1.max(frag.x1);
            segment.y0 = segment.y0.min(frag.y0);
            segment.y1 = segment.y1.max(frag.y1);
            segment.size = segment.size.max(frag.size);
            segment.bold &= frag.bold;
            segment.italic &= frag.italic;
            segment.center = line.center;
        } else {
            let continuation =
                frag.text.chars().next().is_some_and(|ch| {
                    ch.is_lowercase() || matches!(ch, ',' | ';' | ')' | ':' | '.')
                });
            current = Some(Segment {
                members: vec![index],
                x0: frag.x0,
                x1: frag.x1,
                y0: frag.y0,
                y1: frag.y1,
                size: frag.size,
                center: line.center,
                continuation,
                bold: frag.bold,
                italic: frag.italic,
            });
        }
        right_edge = right_edge.max(frag.x1);
        right_size = frag.size;
    }
    if let Some(done) = current {
        out.push(done);
    }
}

fn overlaps(first_x0: f64, first_x1: f64, second_x0: f64, second_x1: f64) -> bool {
    first_x1.min(second_x1) - first_x0.max(second_x0) > 0.0
}

fn similar_size(first: f64, second: f64) -> bool {
    (first - second).abs() <= SIZE_TOLERANCE * first.max(second)
}

fn fits(block: &Block, segment: &Segment) -> bool {
    overlaps(block.last_x0, block.last_x1, segment.x0, segment.x1)
        && similar_size(block.last_size, segment.size)
}

fn naive_targets(blocks: &[Block], active: &[usize], line: &[Segment]) -> Vec<Option<usize>> {
    line.iter()
        .map(|segment| {
            let mut matches = active
                .iter()
                .copied()
                .filter(|&id| blocks.get(id).is_some_and(|block| fits(block, segment)));
            let (Some(target), None) = (matches.next(), matches.next()) else {
                return None;
            };
            let exclusive = blocks
                .get(target)
                .is_some_and(|block| line.iter().filter(|other| fits(block, other)).count() == 1);
            exclusive.then_some(target)
        })
        .collect()
}

fn line_targets(blocks: &[Block], active: &[usize], line: &[Segment]) -> Vec<Option<usize>> {
    let finite = active.iter().all(|&id| {
        blocks
            .get(id)
            .is_some_and(|block| block.last_x0.is_finite() && block.last_x1.is_finite())
    }) && line
        .iter()
        .all(|segment| segment.x0.is_finite() && segment.x1.is_finite());
    if !finite {
        return naive_targets(blocks, active, line);
    }
    let open = Sweep::new(active.iter().filter_map(|&id| {
        blocks
            .get(id)
            .map(|block| (id, block.last_x0, block.last_x1))
    }));
    let current = Sweep::new(
        line.iter()
            .enumerate()
            .map(|(index, segment)| (index, segment.x0, segment.x1)),
    );
    line.iter()
        .map(|segment| {
            let target = open.unique(segment.x0, segment.x1, |id| {
                blocks.get(id).is_some_and(|block| fits(block, segment))
            })?;
            let block = blocks.get(target)?;
            current
                .unique(block.last_x0, block.last_x1, |index| {
                    line.get(index).is_some_and(|other| fits(block, other))
                })
                .map(|_| target)
        })
        .collect()
}

fn build_blocks(segments: &[Segment], ranges: &[(usize, usize)]) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut active: Vec<usize> = Vec::new();
    for &(start, end) in ranges {
        let Some(line) = segments.get(start..end) else {
            continue;
        };
        let Some(first) = line.first() else {
            continue;
        };
        active.retain(|&id| {
            blocks.get(id).is_some_and(|block| {
                block.last_center - first.center <= LINE_PITCH * block.last_size
            })
        });
        let row_break = line.len() >= 2
            && line
                .iter()
                .any(|segment| (segment.x1 - segment.x0) < CELL_EM * segment.size)
            && !line.iter().all(|segment| segment.continuation);
        let targets = if row_break {
            Vec::new()
        } else {
            line_targets(&blocks, &active, line)
        };
        for (offset, segment) in line.iter().enumerate() {
            let segment_index = start.saturating_add(offset);
            let claimed = targets.get(offset).copied().flatten();
            if let Some(block) = claimed.and_then(|id| blocks.get_mut(id)) {
                block.segments.push(segment_index);
                block.x0 = block.x0.min(segment.x0);
                block.x1 = block.x1.max(segment.x1);
                block.top = block.top.max(segment.y1 - CORE_TOP * segment.size);
                block.bottom = block.bottom.min(segment.y0 + CORE_BOTTOM * segment.size);
                block.last = segment_index;
                block.last_x0 = segment.x0;
                block.last_x1 = segment.x1;
                block.last_center = segment.center;
                block.last_size = segment.size;
            } else {
                active.push(blocks.len());
                blocks.push(Block {
                    table: None,
                    segments: vec![segment_index],
                    x0: segment.x0,
                    x1: segment.x1,
                    top: segment.y1 - CORE_TOP * segment.size,
                    bottom: segment.y0 + CORE_BOTTOM * segment.size,
                    last: segment_index,
                    last_x0: segment.x0,
                    last_x1: segment.x1,
                    last_center: segment.center,
                    last_size: segment.size,
                });
            }
        }
    }
    blocks
}

fn cut_bands(
    blocks: &[Block],
    ids: &[usize],
    out: &mut Vec<Vec<usize>>,
    key: fn(&Block) -> (f64, f64),
    descending: bool,
) {
    let mut sorted: Vec<usize> = ids.to_vec();
    sorted.sort_unstable_by(|&a, &b| match (blocks.get(a), blocks.get(b)) {
        (Some(left), Some(right)) => {
            let (left_start, _) = key(left);
            let (right_start, _) = key(right);
            if descending {
                compare(right_start, left_start)
            } else {
                compare(left_start, right_start)
            }
        }
        _ => Ordering::Equal,
    });
    let mut band: Vec<usize> = Vec::new();
    let mut frontier = if descending {
        f64::INFINITY
    } else {
        f64::NEG_INFINITY
    };
    for id in sorted {
        let Some(block) = blocks.get(id) else {
            continue;
        };
        let (start, end) = key(block);
        let separated = !band.is_empty()
            && if descending {
                start <= frontier
            } else {
                start >= frontier
            };
        if separated {
            out.push(mem::take(&mut band));
            frontier = if descending {
                f64::INFINITY
            } else {
                f64::NEG_INFINITY
            };
        }
        band.push(id);
        frontier = if descending {
            frontier.min(end)
        } else {
            frontier.max(end)
        };
    }
    if !band.is_empty() {
        out.push(band);
    }
}

fn flowing(blocks: &[Block], band: &[usize]) -> bool {
    band.iter()
        .filter_map(|&id| blocks.get(id))
        .any(|block| block.table.is_none() && block.segments.len() >= FLOWING_LINES)
}

const fn vertical_key(block: &Block) -> (f64, f64) {
    (block.top, block.bottom)
}

const fn horizontal_key(block: &Block) -> (f64, f64) {
    (block.x0, block.x1)
}

fn reading_order(
    blocks: &[Block],
    ids: Vec<usize>,
    depth: usize,
    columns_first: bool,
    out: &mut Vec<usize>,
) {
    if ids.len() <= 1 || depth >= MAX_CUT_DEPTH {
        if ids.len() > 1 {
            let mut sorted = ids;
            sort_block_indices_reading(&mut sorted, blocks);
            out.extend(sorted);
        } else {
            out.extend(ids);
        }
        return;
    }
    let mut bands: Vec<Vec<usize>> = Vec::new();
    if columns_first {
        cut_bands(blocks, &ids, &mut bands, horizontal_key, false);
        if bands.len() < 2 || !bands.iter().all(|band| flowing(blocks, band)) {
            bands.clear();
        }
    }
    if bands.is_empty() {
        cut_bands(blocks, &ids, &mut bands, vertical_key, true);
    }
    if bands.len() < 2 {
        bands.clear();
        cut_bands(blocks, &ids, &mut bands, horizontal_key, false);
    }
    if bands.len() < 2 {
        let mut sorted = ids;
        sort_block_indices_reading(&mut sorted, blocks);
        out.extend(sorted);
        return;
    }
    for band in bands {
        reading_order(blocks, band, depth.saturating_add(1), columns_first, out);
    }
}

fn write_segment(frags: &[Frag<'_>], segment: &Segment, out: &mut String) {
    let mut right_edge: Option<f64> = None;
    for &index in &segment.members {
        let Some(frag) = frags.get(index) else {
            continue;
        };
        if let Some(edge) = right_edge {
            let gap = frag.x0 - edge;
            let boundary_space = out.chars().next_back().is_none_or(char::is_whitespace)
                || frag.text.chars().next().is_none_or(char::is_whitespace);
            if gap > WORD_GAP * frag.size && !boundary_space {
                out.push(' ');
            }
        }
        out.push_str(frag.text);
        right_edge = Some(right_edge.map_or(frag.x1, |edge| edge.max(frag.x1)));
    }
}

fn is_row_line(line: &[Segment]) -> bool {
    line.len() >= 2
        && line
            .iter()
            .any(|segment| (segment.x1 - segment.x0) < CELL_EM * segment.size)
        && !line.iter().all(|segment| segment.continuation)
}

fn line_size(line: &[Segment]) -> f64 {
    line.iter().map(|segment| segment.size).fold(0.0, f64::max)
}

fn spans_of(line: &[Segment]) -> Vec<(f64, f64)> {
    line.iter()
        .map(|segment| (segment.x0, segment.x1))
        .collect()
}

fn near_size(first: f64, second: f64) -> bool {
    (first - second).abs() <= ALIGNED_SIZE * first.max(second)
}

fn is_marker(text: &str) -> bool {
    let trimmed_text = text.trim();
    let count = trimmed_text.chars().count();
    if count == 0 || count > MARKER_CHARS {
        return false;
    }
    if trimmed_text
        .chars()
        .all(|ch| matches!(ch, '•' | '●' | '▪' | '*' | '-' | '–' | '—' | '§'))
    {
        return true;
    }
    trimmed_text.ends_with(['.', ')', ':'])
        && trimmed_text
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '.' | '(' | ')' | ':' | '°' | 'º'))
}

fn is_list(cells: &[Cell], columns: usize) -> bool {
    let Some(last) = columns.checked_sub(1) else {
        return false;
    };
    let mut markers = 0_usize;
    for cell in cells.iter().filter(|cell| widen(cell.col) != last) {
        let Some(first) = cell.text.lines().next() else {
            continue;
        };
        if !is_marker(first) {
            return false;
        }
        markers = markers.saturating_add(1);
    }
    markers >= 2
}

fn truncate_unmappable<'seg, F>(rows: &mut Vec<Vec<usize>>, columns: &[(f64, f64)], line_at: F)
where
    F: Fn(usize) -> Option<&'seg [Segment]>,
{
    let mappable = |line: usize| {
        line_at(line).is_some_and(|segments| {
            segments
                .iter()
                .all(|segment| column_of(columns, segment.x0, segment.x1).is_some())
        })
    };
    let Some((row_index, cut)) = rows.iter().enumerate().find_map(|(row_index, row)| {
        row.iter()
            .position(|&line| !mappable(line))
            .map(|cut| (row_index, cut))
    }) else {
        return;
    };
    let keep = if cut == 0 {
        row_index
    } else {
        row_index.saturating_add(1)
    };
    rows.truncate(keep);
    if let Some(row) = rows.get_mut(row_index) {
        row.truncate(cut);
    }
}

fn aligned_cells<'seg, F>(
    frags: &[Frag<'_>],
    rows: &[Vec<usize>],
    columns: &[(f64, f64)],
    line_at: F,
) -> (Vec<Cell>, [f64; 4])
where
    F: Fn(usize) -> Option<&'seg [Segment]>,
{
    let mut cells: Vec<Cell> = Vec::with_capacity(rows.len().saturating_mul(columns.len()));
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for (row_index, lines) in rows.iter().enumerate() {
        let (mut top, mut bottom) = (f64::NEG_INFINITY, f64::INFINITY);
        for segment in lines.iter().filter_map(|&line| line_at(line)).flatten() {
            top = top.max(segment.y1);
            bottom = bottom.min(segment.y0);
        }
        let slot = cells.len();
        for (column_index, &(left, right)) in columns.iter().enumerate() {
            cells.push(Cell {
                row: u32::try_from(row_index).unwrap_or(u32::MAX),
                col: u32::try_from(column_index).unwrap_or(u32::MAX),
                row_span: 1,
                col_span: 1,
                bbox: [left, bottom, right, top],
                text: String::new(),
            });
        }
        for segment in lines.iter().filter_map(|&line| line_at(line)).flatten() {
            let Some(column) = column_of(columns, segment.x0, segment.x1) else {
                continue;
            };
            if let Some(cell) = cells.get_mut(slot.saturating_add(column)) {
                if !cell.text.is_empty() {
                    cell.text.push('\n');
                }
                write_segment(frags, segment, &mut cell.text);
            }
        }
        bounds[1] = bounds[1].min(bottom);
        bounds[3] = bounds[3].max(top);
    }
    bounds[0] = columns.first().map_or(0.0_f64, |column| column.0);
    bounds[2] = columns.last().map_or(0.0_f64, |column| column.1);
    (cells, bounds)
}

fn aligned_tables(
    frags: &[Frag<'_>],
    segments: &[Segment],
    ranges: &[(usize, usize)],
) -> (Vec<Table>, Vec<bool>) {
    let mut tables: Vec<Table> = Vec::new();
    let mut consumed = vec![false; ranges.len()];
    let line_at = |index: usize| {
        let &(start, end) = ranges.get(index)?;
        segments.get(start..end)
    };
    let mut index = 0_usize;
    while let Some(first) = line_at(index) {
        if !is_row_line(first) {
            index = index.saturating_add(1);
            continue;
        }
        let Some(mut columns) = merge_row(&[], &spans_of(first)) else {
            index = index.saturating_add(1);
            continue;
        };
        let base_size = line_size(first);
        let mut rows: Vec<Vec<usize>> = vec![vec![index]];
        let mut row_bold = first.iter().all(|segment| segment.bold);
        let mut last = index;
        let mut next = index.saturating_add(1);
        while let (Some(line), Some(previous)) = (line_at(next), line_at(last)) {
            let gap = previous.first().map_or(0.0_f64, |segment| segment.center)
                - line.first().map_or(0.0_f64, |segment| segment.center);
            let size = line_size(line);
            if is_row_line(line) {
                if gap > ROW_GAP * base_size || !near_size(base_size, size) {
                    break;
                }
                let Some(merged) = merge_row(&columns, &spans_of(line)) else {
                    break;
                };
                columns = merged;
                row_bold = line.iter().all(|segment| segment.bold);
                rows.push(vec![next]);
            } else {
                let mut used: Vec<usize> = Vec::new();
                let wraps = gap <= WRAP_GAP * base_size
                    && near_size(base_size, size)
                    && line.iter().all(|segment| {
                        let column = column_of(&columns, segment.x0, segment.x1);
                        let fresh =
                            column.is_some_and(|inner_column| !used.contains(&inner_column));
                        if let Some(found) = column {
                            used.push(found);
                        }
                        fresh && (!segment.bold || row_bold)
                    });
                if !wraps {
                    break;
                }
                if let Some(row) = rows.last_mut() {
                    row.push(next);
                }
            }
            last = next;
            next = next.saturating_add(1);
        }
        truncate_unmappable(&mut rows, &columns, line_at);
        if let Some(&end) = rows.last().and_then(|row| row.last()) {
            last = end;
        }
        let accepted = rows.len() >= 3 || (rows.len() == 2 && columns.len() >= 3);
        if !accepted {
            index = index.saturating_add(1);
            continue;
        }
        let (cells, bounds) = aligned_cells(frags, &rows, &columns, line_at);
        if is_list(&cells, columns.len()) {
            index = last.saturating_add(1);
            continue;
        }
        tables.push(Table {
            page_index: 0,
            bbox: bounds,
            rows: u32::try_from(rows.len()).unwrap_or(u32::MAX),
            cols: u32::try_from(columns.len()).unwrap_or(u32::MAX),
            cells,
        });
        for flag in consumed.iter_mut().take(last.saturating_add(1)).skip(index) {
            *flag = true;
        }
        index = last.saturating_add(1);
    }
    (tables, consumed)
}

fn cell_text(frags: &[Frag<'_>]) -> String {
    let mut sink = PoolOut::default();
    let mode = Mode {
        markdown: false,
        aligned: false,
        budget: TextBudget::UNLIMITED,
        text: true,
    };
    layout_pool(frags, &[], None, mode, &[], &mut sink, None);
    assemble(&sink.pieces, &HashMap::new(), 0, TextBudget::UNLIMITED).replace("\n\n", "\n")
}

fn ruled_tables<'data>(
    frags: &[Frag<'data>],
    rulings: &[Rule],
) -> Option<(Vec<Frag<'data>>, Vec<Table>)> {
    let grids = ruled_grids(rulings);
    if grids.is_empty() {
        return None;
    }
    let mut members: Vec<Vec<Vec<Frag<'data>>>> = grids
        .iter()
        .map(|grid| vec![Vec::new(); grid.cells.len()])
        .collect();
    let mut rest: Vec<Frag<'data>> = Vec::new();
    for frag in frags {
        let (cx, cy) = (
            f64::midpoint(frag.x0, frag.x1),
            f64::midpoint(frag.y0, frag.y1),
        );
        let home = grids
            .iter()
            .enumerate()
            .find_map(|(grid, shape)| shape.locate(cx, cy).map(|cell| (grid, cell)));
        match home.and_then(|(grid, cell)| {
            let cells = members.get_mut(grid)?;
            cells.get_mut(cell)
        }) {
            Some(cell) => cell.push(*frag),
            None => rest.push(*frag),
        }
    }
    let mut tables = Vec::new();
    for (grid, cells) in grids.iter().zip(members) {
        let filled = cells.iter().filter(|cell| !cell.is_empty()).count();
        if filled < MIN_FILLED_CELLS {
            rest.extend(cells.into_iter().flatten());
            continue;
        }
        let converted: Vec<Cell> = grid
            .cells
            .iter()
            .zip(&cells)
            .map(|(shape, inside)| Cell {
                row: u32::try_from(shape.row).unwrap_or(u32::MAX),
                col: u32::try_from(shape.col).unwrap_or(u32::MAX),
                row_span: u32::try_from(shape.row_span).unwrap_or(1),
                col_span: u32::try_from(shape.col_span).unwrap_or(1),
                bbox: grid.cell_rect(*shape),
                text: cell_text(inside),
            })
            .collect();
        tables.push(Table {
            page_index: 0,
            bbox: grid.bounds(),
            rows: u32::try_from(grid.rows()).unwrap_or(u32::MAX),
            cols: u32::try_from(grid.cols()).unwrap_or(u32::MAX),
            cells: converted,
        });
    }
    Some((rest, tables))
}

fn band_of(extent: Option<[f64; 4]>, bottom: f64, top: f64) -> Band {
    let Some([_, low, _, high]) = extent else {
        return Band::Free;
    };
    let reach = HEADER_BAND * (high - low);
    if bottom >= high - reach {
        Band::Top
    } else if top <= low + reach {
        Band::Bottom
    } else {
        Band::Free
    }
}
fn link_at(links: &[LinkRect], frag: &Frag<'_>) -> Option<usize> {
    let (cx, cy) = (
        f64::midpoint(frag.x0, frag.x1),
        f64::midpoint(frag.y0, frag.y1),
    );
    links
        .iter()
        .find(|([x0, y0, x1, y1], _)| {
            *x0 - 1.0_f64 <= cx && cx <= *x1 + 1.0_f64 && *y0 - 1.0_f64 <= cy && cy <= *y1 + 1.0_f64
        })
        .map(|(_, index)| *index)
}

fn push_md_line(items: &mut Vec<MdItem>, line: MdLine) {
    if let Some(MdItem::Line(last)) = items.last_mut()
        && (last.center - line.center).abs() <= SAME_LINE * last.size.min(line.size)
        && line.x0 >= last.x1
    {
        last.x1 = line.x1;
        last.size = last.size.max(line.size);
        last.runs.extend(line.runs);
        return;
    }
    items.push(MdItem::Line(line));
}

fn md_line(
    frags: &[Frag<'_>],
    segment: &Segment,
    extent: Option<[f64; 4]>,
    links: &[LinkRect],
) -> MdLine {
    let runs = segment
        .members
        .iter()
        .filter_map(|&index| frags.get(index))
        .map(|frag| MdRun {
            text: frag.text.to_owned(),
            x0: frag.x0,
            x1: frag.x1,
            size: frag.size,
            bold: frag.bold,
            italic: frag.italic,
            link: link_at(links, frag),
        })
        .collect();
    MdLine {
        runs,
        x0: segment.x0,
        x1: segment.x1,
        center: segment.center,
        size: segment.size,
        band: band_of(extent, segment.center, segment.center),
    }
}

#[inline(never)]
fn positioned_lines(frags: &[Frag<'_>]) -> (Vec<Segment>, Vec<(usize, usize)>) {
    let text_lines = cluster_lines(frags);
    let mut segments: Vec<Segment> = Vec::with_capacity(text_lines.len());
    let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(text_lines.len());
    for line in &text_lines {
        let before = segments.len();
        split_segments(frags, line, &mut segments);
        if segments.len() > before {
            ranges.push((before, segments.len()));
        }
    }
    (segments, ranges)
}

fn layout_pool(
    frags: &[Frag<'_>],
    rulings: &[Rule],
    extent: Option<[f64; 4]>,
    mode: Mode,
    links: &[LinkRect],
    out: &mut PoolOut,
    bounded: Option<&mut TextOutput>,
) {
    if frags.is_empty() {
        return;
    }
    let ruled = if rulings.is_empty() {
        None
    } else {
        ruled_tables(frags, rulings)
    };
    let (owned, mut tables) = match ruled {
        Some((rest, tables)) => (Some(rest), tables),
        None => (None, Vec::new()),
    };
    let free: &[Frag<'_>] = owned.as_deref().unwrap_or(frags);
    let (segments, mut ranges) = positioned_lines(free);
    if mode.aligned {
        let (found, consumed) = aligned_tables(free, &segments, &ranges);
        if !found.is_empty() {
            tables.extend(found);
            let mut taken = consumed.into_iter();
            ranges.retain(|_| !taken.next().unwrap_or(false));
        }
    }
    if mode.text {
        let mut blocks = build_blocks(&segments, &ranges);
        for (index, table) in tables.iter().enumerate() {
            let [x0, y0, x1, y1] = table.bbox;
            blocks.push(Block {
                table: Some(index),
                segments: Vec::new(),
                x0,
                x1,
                top: y1,
                bottom: y0,
                last: 0,
                last_x0: x0,
                last_x1: x1,
                last_center: y1,
                last_size: 0.0,
            });
        }
        let ids: Vec<usize> = (0..blocks.len()).collect();
        let mut order: Vec<usize> = Vec::with_capacity(blocks.len());
        reading_order(&blocks, ids, 0, mode.markdown, &mut order);
        if mode.markdown {
            for block in order.iter().filter_map(|&id| blocks.get(id)) {
                if let Some(table) = block.table.and_then(|index| tables.get(index)) {
                    out.md.push(MdItem::Table {
                        text: render_markdown(table),
                        band: band_of(extent, table.bbox[1], table.bbox[3]),
                        top: table.bbox[3],
                    });
                } else {
                    for &segment_index in &block.segments {
                        if let Some(segment) = segments.get(segment_index) {
                            push_md_line(&mut out.md, md_line(free, segment, extent, links));
                        }
                    }
                }
            }
        } else {
            plain_pieces(
                free,
                &segments,
                order.iter().filter_map(|&id| blocks.get(id)),
                &tables,
                extent,
                &mut out.pieces,
                bounded,
            );
        }
    }
    out.tables.extend(tables);
}

fn plain_pieces<'data, O>(
    frags: &[Frag<'_>],
    segments: &[Segment],
    order: O,
    tables: &[Table],
    extent: Option<[f64; 4]>,
    pieces: &mut Vec<Piece>,
    mut bounded: Option<&mut TextOutput>,
) where
    O: Iterator<Item = &'data Block>,
{
    let first_lead = if bounded.is_some() { "\n\n" } else { "" };
    let mut emit = |text: String, lead, band| {
        if let Some(output) = bounded.as_deref_mut() {
            if output.full() || !output.append(lead, &text) {
                output.budget.max_blocks = Some(0);
                return false;
            }
            return !output.full();
        }
        pieces.push(Piece { band, lead, text });
        true
    };
    let mut previous = None;
    for block in order {
        let leading = previous.map_or(first_lead, |before| separator(segments, before, block));
        if let Some(table) = block.table.and_then(|index| tables.get(index)) {
            if !emit(
                render_text(table),
                if previous.is_some() {
                    "\n\n"
                } else {
                    first_lead
                },
                band_of(extent, table.bbox[1], table.bbox[3]),
            ) {
                return;
            }
        } else {
            for (row, &segment_index) in block.segments.iter().enumerate() {
                let Some(segment) = segments.get(segment_index) else {
                    continue;
                };
                let mut text = String::new();
                write_segment(frags, segment, &mut text);
                if !emit(
                    text,
                    if row == 0 { leading } else { "\n" },
                    band_of(extent, segment.center, segment.center),
                ) {
                    return;
                }
            }
        }
        previous = Some(block);
    }
}

fn separator(segments: &[Segment], before: &Block, after: &Block) -> &'static str {
    let (Some(last), Some(first)) = (
        segments.get(before.last),
        after
            .segments
            .first()
            .and_then(|&index| segments.get(index)),
    ) else {
        return "\n\n";
    };
    let drop = last.center - first.center;
    if before.segments.len() == 1 && drop.abs() <= SAME_LINE * last.size.min(first.size) {
        " "
    } else if drop > 0.0 && drop <= LINE_PITCH * last.size {
        "\n"
    } else {
        "\n\n"
    }
}

fn running_key(text: &str) -> String {
    let mut key = String::with_capacity(text.len());
    let mut digits = false;
    let mut space = false;
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            if !digits {
                key.push('#');
            }
            digits = true;
            space = false;
        } else if ch.is_whitespace() {
            if !space && !key.is_empty() {
                key.push(' ');
            }
            space = true;
            digits = false;
        } else {
            key.push(fold_char(ch));
            digits = false;
            space = false;
        }
    }
    key.truncate(key.trim_end().len());
    key
}

fn running_keys(pages: &[Vec<(Band, &str)>], recurring: Recurring) -> RunningKeys {
    let mut counts: HashMap<(bool, String), Recurrence> = HashMap::new();
    for (position, page) in pages.iter().enumerate() {
        let mut seen: HashSet<(bool, String)> = HashSet::new();
        for &(band, text) in page {
            let top = match band {
                Band::Free => continue,
                Band::Top => true,
                Band::Bottom => false,
            };
            let key = running_key(text);
            if key.is_empty() {
                continue;
            }
            if seen.insert((top, key.clone())) {
                let digits: String = text.chars().filter(char::is_ascii_digit).collect();
                let entry = counts.entry((top, key)).or_insert_with(|| Recurrence {
                    count: 0,
                    first: position,
                    digits: digits.clone(),
                    varying: false,
                });
                entry.count = entry.count.saturating_add(1);
                entry.varying |= entry.digits != digits;
            }
        }
    }
    counts
        .into_iter()
        .filter(|(_, found)| {
            found.count >= recurring.min_pages.min(pages.len())
                && found.count >= 2
                && found.count.saturating_mul(recurring.share) >= pages.len()
        })
        .map(|(key, found)| {
            (
                key,
                if found.varying {
                    usize::MAX
                } else {
                    found.first
                },
            )
        })
        .collect()
}

fn assemble(
    pieces: &[Piece],
    dropped: &RunningKeys,
    position: usize,
    budget: TextBudget,
) -> String {
    let mut out = TextOutput::new(budget);
    if !budget.bounded() {
        out.text.reserve(
            pieces
                .iter()
                .map(|piece| piece.text.len().saturating_add(2))
                .sum(),
        );
    }
    for piece in pieces {
        if out.full() {
            break;
        }
        if !is_dropped(dropped, piece.band, &piece.text, position)
            && !out.append(piece.lead, &piece.text)
        {
            break;
        }
    }
    out.text
}

fn turn_rect(quarter: usize, rect: [f64; 4]) -> [f64; 4] {
    let [x0, y0, x1, y1] = rect;
    let (ax, ay) = turn(quarter, x0, y0);
    let (bx, by) = turn(quarter, x1, y1);
    [ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)]
}

#[inline(never)]
fn fragment_pools(content: &PageContent, page: usize) -> ([Vec<Frag<'_>>; 4], Vec<usize>) {
    let mut pools: [Vec<Frag<'_>>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    let mut weights = [0_usize; 4];
    for run in &content.runs {
        let text = content.text_of(run);
        if text.is_empty() || !run.direction.0.is_finite() || !run.direction.1.is_finite() {
            continue;
        }
        let visible = turn(page, run.direction.0, run.direction.1);
        let quarter = quarter_of(visible);
        let turns = (page.saturating_add(quarter)) & 3;
        let [x0, y0, x1, y1] = run.rect;
        let (ax, ay) = turn(turns, x0, y0);
        let (bx, by) = turn(turns, x1, y1);
        let frag = Frag {
            x0: ax.min(bx),
            y0: ay.min(by),
            x1: ax.max(bx),
            y1: ay.max(by),
            size: run.font_size.abs().max(1e-3),
            bold: run.bold,
            italic: run.italic,
            text,
        };
        if !(frag.x0.is_finite()
            && frag.x1.is_finite()
            && frag.y0.is_finite()
            && frag.y1.is_finite())
        {
            continue;
        }
        if let (Some(pool), Some(weight)) = (pools.get_mut(quarter), weights.get_mut(quarter)) {
            *weight = (*weight).saturating_add(text.len());
            pool.push(frag);
        }
    }
    let mut ranking: Vec<usize> = (0..4)
        .filter(|&quarter| weights.get(quarter).copied().unwrap_or(0) > 0)
        .collect();
    ranking.sort_unstable_by(|&a, &b| {
        weights
            .get(b)
            .copied()
            .unwrap_or(0)
            .cmp(&weights.get(a).copied().unwrap_or(0))
            .then(a.cmp(&b))
    });
    (pools, ranking)
}

fn page_layout(
    content: &PageContent,
    rotate: i32,
    extent: Option<[f64; 4]>,
    mode: Mode,
    links: &[LinkRect],
) -> PageLayout {
    let page = page_quarter(rotate);
    let (pools, ranking) = fragment_pools(content, page);
    let rulings = content.rulings.as_slice();
    let mut layout = PageLayout::default();
    let mut bounded = mode.budget.bounded().then(|| TextOutput::new(mode.budget));
    for (rank, quarter) in ranking.into_iter().enumerate() {
        if bounded.as_ref().is_some_and(TextOutput::full) {
            break;
        }
        let Some(pool) = pools.get(quarter) else {
            continue;
        };
        let turns = (page.saturating_add(quarter)) & 3;
        let ruled_lines: Vec<Rule> = rulings
            .iter()
            .map(|ruling| {
                let [x0, y0, x1, y1] =
                    turn_rect(turns, [ruling.x0, ruling.y0, ruling.x1, ruling.y1]);
                Rule { x0, x1, y0, y1 }
            })
            .collect();
        let pool_extent = extent
            .filter(|_| rank == 0)
            .map(|rect| turn_rect(turns, rect));
        let turned: Vec<LinkRect> = links
            .iter()
            .map(|&(rect, index)| (turn_rect(turns, rect), index))
            .collect();
        let mut sink = PoolOut::default();
        layout_pool(
            pool,
            &ruled_lines,
            pool_extent,
            mode,
            &turned,
            &mut sink,
            bounded.as_mut(),
        );
        if !layout.md.is_empty() && !sink.md.is_empty() {
            layout.md.push(MdItem::Break);
        }
        layout.md.append(&mut sink.md);
        if !layout.pieces.is_empty()
            && let Some(first) = sink.pieces.first_mut()
        {
            first.lead = "\n\n";
        }
        layout.pieces.append(&mut sink.pieces);
        let back = 4_usize.saturating_sub(turns & 3) & 3;
        for mut table in sink.tables {
            table.bbox = turn_rect(back, table.bbox);
            for cell in &mut table.cells {
                cell.bbox = turn_rect(back, cell.bbox);
            }
            layout.tables.push(table);
        }
    }
    layout.bounded_text = bounded.map(|out| out.text);
    layout
}
pub(crate) fn text_limits() -> Limits {
    Limits {
        max_items_per_page: 250_000,
        max_items: usize::MAX,
        max_text_bytes: 1 << 30,
        ..Limits::default()
    }
}
fn page_links(links: &[LinkInfo], page_index: usize) -> Vec<LinkRect> {
    links
        .iter()
        .enumerate()
        .filter(|(_, link)| usize::try_from(link.page_index).ok() == Some(page_index))
        .map(|(index, link)| (link.rect, index))
        .collect()
}
fn single_page(
    document: &Document<'_>,
    page: &Page,
    page_index: usize,
    links: &[LinkInfo],
    limits: &Limits,
    session: &mut Session,
    mode: Mode,
) -> Outcome<PageLayout> {
    let capture = Capture {
        reposition: Reposition::Split,
        structure: true,
        split_style: mode.markdown,
    };
    let scoped = page_links(links, page_index);
    match extract_content(document, page, limits, capture, session) {
        Ok(content) => {
            let mut layout = page_layout(
                &content,
                page.info.rotate,
                Some(page.info.crop_box),
                mode,
                &scoped,
            );
            layout.height = page.info.crop_box[3] - page.info.crop_box[1];
            Ok(layout)
        }
        Err(failure) if failure.code == FailureCode::LimitExceeded => Err(failure),
        Err(_) => Ok(PageLayout::default()),
    }
}

pub(crate) fn document_text(
    bytes: &[u8],
    page_indexes: Option<&[u32]>,
    limits: &Limits,
    options: TextOptions,
) -> Outcome<Vec<String>> {
    if bytes.len() > limits.max_pdf_bytes {
        return Err(Failure::limit("pdf exceeds size limit"));
    }
    let document = Document::open(bytes, limits)?;
    let pages = document.pages()?;
    let selected = select_pages(pages.len(), page_indexes)?;
    opened_text(&document, &pick_pages(&pages, selected), limits, options)
}

#[inline(never)]
pub(crate) fn opened_text(
    document: &Document<'_>,
    selected: &[(usize, &Page)],
    limits: &Limits,
    options: TextOptions,
) -> Outcome<Vec<String>> {
    let mode = Mode {
        markdown: options.markdown,
        aligned: options.markdown,
        budget: if !options.markdown && (!options.drop_running || selected.len() <= 1) {
            options.budget
        } else {
            TextBudget::UNLIMITED
        },
        text: true,
    };
    let mut all_links = Vec::new();
    if options.markdown {
        for &(position, page) in selected {
            if let Ok(page_index) = u32::try_from(position) {
                document.page_links(page, page_index, &mut all_links)?;
            }
        }
    }
    let mut session = Session::default();
    let mut layouts: Vec<PageLayout> = Vec::with_capacity(selected.len());
    for &(position, page) in selected {
        layouts.push(single_page(
            document,
            page,
            position,
            &all_links,
            limits,
            &mut session,
            mode,
        )?);
    }
    if options.markdown {
        return markdown_pages(&layouts, &all_links, options, limits);
    }
    let dropped = if options.drop_running {
        running_keys(
            &layouts
                .iter()
                .map(|layout| {
                    layout
                        .pieces
                        .iter()
                        .map(|piece| (piece.band, piece.text.as_str()))
                        .collect()
                })
                .collect::<Vec<_>>(),
            TEXT_RECURRING,
        )
    } else {
        HashMap::new()
    };
    let mut texts: Vec<String> = Vec::with_capacity(layouts.len());
    let mut total_bytes = 0_usize;
    for (position, layout) in layouts.into_iter().enumerate() {
        let text = layout
            .bounded_text
            .unwrap_or_else(|| assemble(&layout.pieces, &dropped, position, options.budget));
        total_bytes = total_bytes.saturating_add(text.len());
        if total_bytes > limits.max_text_bytes {
            return Err(Failure::limit("text bytes exceed limit"));
        }
        texts.push(text);
    }
    Ok(texts)
}

fn furniture_key(block: &MdBlock, height: f64) -> Option<FurnitureKey> {
    let key = running_key(block.plain());
    (!key.is_empty()).then(|| {
        (
            key,
            f64_to_i64((block.top() / FURNITURE_PITCH).round()),
            f64_to_i64(height.round()),
        )
    })
}

const fn at_page_edge(index: usize, len: usize) -> bool {
    index < FURNITURE_BLOCKS || index.saturating_add(FURNITURE_BLOCKS) >= len
}

fn drop_furniture(pages: &mut [Vec<MdBlock>], heights: &[f64]) {
    let mut recurring: HashMap<FurnitureKey, (usize, usize)> = HashMap::new();
    for (position, blocks) in pages.iter().enumerate() {
        let height = heights.get(position).copied().unwrap_or(0.0_f64);
        let mut seen: HashSet<FurnitureKey> = HashSet::new();
        for (index, block) in blocks.iter().enumerate() {
            if !at_page_edge(index, blocks.len()) {
                continue;
            }
            if let Some(key) = furniture_key(block, height)
                && seen.insert(key.clone())
            {
                let entry = recurring.entry(key).or_insert((position, 0));
                entry.1 = entry.1.saturating_add(1);
            }
        }
    }
    let threshold = FURNITURE_MIN_PAGES.max(pages.len().checked_div(FURNITURE_SHARE).unwrap_or(0));
    recurring.retain(|_, &mut (_, count)| count >= threshold);
    if recurring.is_empty() {
        return;
    }
    for (position, blocks) in pages.iter_mut().enumerate() {
        let height = heights.get(position).copied().unwrap_or(0.0_f64);
        let len = blocks.len();
        let mut index = 0_usize;
        blocks.retain(|block| {
            let edge = at_page_edge(index, len);
            index = index.saturating_add(1);
            !(edge
                && furniture_key(block, height)
                    .and_then(|key| recurring.get(&key))
                    .is_some_and(|&(first, _)| first != position))
        });
    }
}

fn is_dropped(dropped: &RunningKeys, band: Band, text: &str, position: usize) -> bool {
    band != Band::Free
        && !dropped.is_empty()
        && dropped
            .get(&(band == Band::Top, running_key(text)))
            .is_some_and(|&first| first != position)
}

fn markdown_pages(
    layouts: &[PageLayout],
    links: &[LinkInfo],
    options: TextOptions,
    limits: &Limits,
) -> Outcome<Vec<String>> {
    let metrics = document_metrics(layouts.iter().map(|layout| layout.md.as_slice()));
    let mut pages: Vec<Vec<MdBlock>> = layouts
        .iter()
        .map(|layout| page_blocks(&layout.md, metrics))
        .collect();
    if options.drop_running {
        let dropped = running_keys(
            &pages
                .iter()
                .map(|blocks| {
                    blocks
                        .iter()
                        .map(|block| (block.band(), block.plain()))
                        .collect()
                })
                .collect::<Vec<_>>(),
            MARKDOWN_RECURRING,
        );
        for (position, blocks) in pages.iter_mut().enumerate() {
            blocks.retain(|block| !is_dropped(&dropped, block.band(), block.plain(), position));
        }
        let heights: Vec<f64> = layouts.iter().map(|layout| layout.height).collect();
        drop_furniture(&mut pages, &heights);
    }
    join_pages(&mut pages, metrics);
    let mut texts: Vec<String> = Vec::with_capacity(pages.len());
    let mut total_bytes = 0_usize;
    for blocks in &pages {
        let text = render_page(blocks, links, options.budget);
        total_bytes = total_bytes.saturating_add(text.len());
        if total_bytes > limits.max_text_bytes {
            return Err(Failure::limit("text bytes exceed limit"));
        }
        texts.push(text);
    }
    Ok(texts)
}

pub(crate) fn document_tables(
    bytes: &[u8],
    page_indexes: Option<&[u32]>,
    limits: &Limits,
) -> Outcome<Vec<Table>> {
    if bytes.len() > limits.max_pdf_bytes {
        return Err(Failure::limit("pdf exceeds size limit"));
    }
    let document = Document::open(bytes, limits)?;
    let pages = document.pages()?;
    let selected = select_pages(pages.len(), page_indexes)?;
    opened_tables(&document, &pick_pages(&pages, selected), limits)
}

#[inline(never)]
pub(crate) fn opened_tables(
    document: &Document<'_>,
    selected: &[(usize, &Page)],
    limits: &Limits,
) -> Outcome<Vec<Table>> {
    let mode = Mode {
        markdown: false,
        aligned: true,
        budget: TextBudget::UNLIMITED,
        text: false,
    };
    let mut session = Session::default();
    let mut tables: Vec<Table> = Vec::new();
    let mut total_bytes = 0_usize;
    for &(position, page) in selected {
        let layout = single_page(document, page, position, &[], limits, &mut session, mode)?;
        for mut table in layout.tables {
            table.page_index = u32::try_from(position).unwrap_or(u32::MAX);
            total_bytes = table
                .cells
                .iter()
                .fold(total_bytes, |sum, cell| sum.saturating_add(cell.text.len()));
            tables.push(table);
        }
        if total_bytes > limits.max_text_bytes {
            return Err(Failure::limit("table text bytes exceed limit"));
        }
    }
    Ok(tables)
}

fn body_size(pools: &[Vec<Frag<'_>>]) -> f64 {
    let mut counts = HashMap::<u32, u32>::new();
    for frag in pools.iter().flatten() {
        let rounded = f64_to_usize((frag.size * 4.0).round()).max(1);
        let key = u32::try_from(rounded).unwrap_or(u32::MAX);
        let count = counts.entry(key).or_default();
        let chars = frag.text.chars().filter(|ch| !ch.is_whitespace()).count();
        *count = count.saturating_add(u32::try_from(chars).unwrap_or(u32::MAX));
    }
    counts
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1).then(right.0.cmp(&left.0)))
        .map_or(1.0, |(size, _)| f64::from(size) / 4.0_f64)
}

fn relative_bounds(rect: [f64; 4], [left, bottom, right, top]: [f64; 4]) -> Option<[f64; 4]> {
    let width = right - left;
    let height = top - bottom;
    if !width.is_finite() || !height.is_finite() || width <= 0.0_f64 || height <= 0.0_f64 {
        return None;
    }
    let [x0, y0, x1, y1] = rect;
    let bounds = [
        ((x0 - left) / width).clamp(0.0, 1.0),
        ((top - y1) / height).clamp(0.0, 1.0),
        ((x1 - left) / width).clamp(0.0, 1.0),
        ((top - y0) / height).clamp(0.0, 1.0),
    ];
    let [bx0, by0, bx1, by1] = bounds;
    (bx0 < bx1 && by0 < by1).then_some(bounds)
}

fn candidate(
    frags: &[Frag<'_>],
    segment: &Segment,
    bounds: [f64; 4],
    body: f64,
    isolation: f64,
    reading_order: usize,
) -> Heading {
    let mut text = String::new();
    write_segment(frags, segment, &mut text);
    let [_, top, _, bottom] = bounds;
    Heading {
        bold: segment.bold,
        bounds,
        font_size: segment.size,
        isolation,
        italic: segment.italic,
        reading_order,
        relative_font_size: (segment.size / body).min(f64::MAX),
        running_band: band_of(Some([0.0, 0.0, 1.0, 1.0]), 1.0 - bottom, 1.0 - top) != Band::Free,
        text,
    }
}

fn pool_candidates(
    frags: &[Frag<'_>],
    undo: usize,
    crop: [f64; 4],
    body: f64,
    line_index: &mut usize,
    candidates: &mut Vec<Heading>,
) {
    let (segments, ranges) = positioned_lines(frags);
    let blocks = build_blocks(&segments, &ranges);
    let mut order = Vec::with_capacity(blocks.len());
    reading_order(&blocks, (0..blocks.len()).collect(), 0, false, &mut order);
    let center_at = |index: usize| -> Option<f64> {
        segments
            .get(ranges.get(index)?.0)
            .map(|segment| segment.center)
    };
    for block in order.iter().filter_map(|&id| blocks.get(id)) {
        for (&id, segment) in block
            .segments
            .iter()
            .filter_map(|id| segments.get(*id).map(|segment| (id, segment)))
        {
            let line = ranges.partition_point(|&(_, end)| end <= id);
            let above = line.checked_sub(1).and_then(center_at);
            let below = center_at(line.saturating_add(1));
            let spacing = |neighbor: Option<f64>| {
                neighbor.map_or(1.0_f64, |center| {
                    ((center - segment.center).abs() / segment.size - 1.0).clamp(0.0, 1.0)
                })
            };
            let isolation = f64::midpoint(spacing(above), spacing(below));
            let rect = turn_rect(undo, [segment.x0, segment.y0, segment.x1, segment.y1]);
            if let Some(bounds) = relative_bounds(rect, crop) {
                candidates.push(candidate(
                    frags,
                    segment,
                    bounds,
                    body,
                    isolation,
                    *line_index,
                ));
            }
            *line_index = line_index.saturating_add(1);
        }
    }
}

fn page_candidates(page: &Page, content: &PageContent) -> Vec<Heading> {
    let rotation = page_quarter(page.info.rotate);
    let crop = turn_rect(rotation, page.info.crop_box);
    let (pools, ranking) = fragment_pools(content, rotation);
    let body = body_size(&pools);
    let mut candidates = Vec::new();
    let mut reading_order = 0;
    for quarter in ranking {
        if let Some(frags) = pools.get(quarter) {
            pool_candidates(
                frags,
                4_usize.saturating_sub(quarter),
                crop,
                body,
                &mut reading_order,
                &mut candidates,
            );
        }
    }
    candidates
}

#[inline(never)]
pub(crate) fn opened_headings(
    document: &Document<'_>,
    selected: &[(usize, &Page)],
    limits: &Limits,
) -> Outcome<Vec<HeadingPage>> {
    let capture = Capture {
        reposition: Reposition::Split,
        structure: true,
        split_style: true,
    };
    let mut session = Session::default();
    let mut result = Vec::with_capacity(selected.len());
    for &(page_index, page) in selected {
        let candidates = match extract_content(document, page, limits, capture, &mut session) {
            Ok(content) => page_candidates(page, &content),
            Err(failure) if failure.code == FailureCode::LimitExceeded => return Err(failure),
            Err(_) => Vec::new(),
        };
        result.push(HeadingPage {
            candidates,
            page_index,
        });
    }
    Ok(result)
}

pub(crate) fn document_headings(
    bytes: &[u8],
    indexes: Option<&[u32]>,
    limits: &Limits,
) -> Outcome<Vec<HeadingPage>> {
    if bytes.len() > limits.max_pdf_bytes {
        return Err(Failure::limit("pdf exceeds size limit"));
    }
    let document = Document::open(bytes, limits)?;
    let pages = document.pages()?;
    let selected = select_pages(pages.len(), indexes)?;
    opened_headings(&document, &pick_pages(&pages, selected), limits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inspection::TextItem;
    use crate::text::Run;
    use core::hint::black_box;
    use core::iter;
    use std::time::Instant;

    const SIZE: f64 = 10.0;
    const OPTIONS: TextOptions = TextOptions {
        budget: TextBudget::UNLIMITED,
        markdown: false,
        drop_running: true,
    };

    struct Piece {
        bold: bool,
        direction: (f64, f64),
        italic: bool,
        item: TextItem,
    }

    fn page_text(pieces: &[Piece], rotate: i32) -> String {
        let mut content = PageContent::default();
        for piece in pieces {
            let start = u32::try_from(content.text.len()).unwrap();
            content.text.push_str(&piece.item.text);
            content.runs.push(Run {
                rect: piece.item.rect,
                font_size: piece.item.font_size,
                text: start..u32::try_from(content.text.len()).unwrap(),
                direction: piece.direction,
                bold: piece.bold,
                italic: piece.italic,
            });
        }
        let mode = Mode {
            markdown: false,
            aligned: false,
            budget: TextBudget::UNLIMITED,
            text: true,
        };
        let layout = page_layout(&content, rotate, None, mode, &[]);
        assemble(&layout.pieces, &HashMap::new(), 0, TextBudget::UNLIMITED)
    }

    fn run(x: f64, baseline: f64, width: f64, text: &str) -> Piece {
        Piece {
            item: TextItem {
                rect: [x, baseline - 2.24, x + width, baseline + 9.45],
                font_size: SIZE,
                style: 0,
                text: text.to_owned(),
            },
            direction: (1.0, 0.0),
            bold: false,
            italic: false,
        }
    }

    fn turned(rect: [f64; 4], direction: (f64, f64), text: &str) -> Piece {
        Piece {
            item: TextItem {
                rect,
                font_size: SIZE,
                style: 0,
                text: text.to_owned(),
            },
            direction,
            bold: false,
            italic: false,
        }
    }

    fn segment(x0: f64, x1: f64, center: f64, size: f64) -> Segment {
        Segment {
            members: Vec::new(),
            x0,
            x1,
            y0: center - size / 2.0,
            y1: center + size / 2.0,
            size,
            center,
            continuation: false,
            bold: false,
            italic: false,
        }
    }

    #[test]
    fn zero_width_segment_maps_to_its_column() {
        assert_eq!(
            column_of(&[(10.0_f64, 50.0_f64), (100.0_f64, 160.0_f64)], 50.0, 50.0),
            Some(0)
        );
        assert_eq!(
            column_of(
                &[(10.0_f64, 50.0_f64), (100.0_f64, 100.0_f64)],
                100.0,
                120.0
            ),
            Some(1)
        );
        assert_eq!(
            merge_row(&[(10.0_f64, 50.0_f64)], &[(50.0_f64, 50.0_f64)]),
            Some(vec![(10.0_f64, 50.0_f64)])
        );
    }

    #[test]
    fn rows_are_truncated_before_an_unmappable_wrap_line() {
        let columns = [(50.0_f64, 100.0_f64), (200.0_f64, 260.0_f64)];
        let segments = [
            segment(50.0, 90.0, 700.0, SIZE),
            segment(200.0, 250.0, 700.0, SIZE),
            segment(60.0, 230.0, 690.0, SIZE),
            segment(50.0, 90.0, 700.0, SIZE),
        ];
        let ranges = [(0, 2), (2, 3), (3, 4)];
        let line_at = |index: usize| {
            let &(start, end) = ranges.get(index)?;
            segments.get(start..end)
        };
        let mut wrapped = vec![vec![0, 1], vec![2]];
        truncate_unmappable(&mut wrapped, &columns, line_at);
        assert_eq!(wrapped, [vec![0]]);
        let mut split = vec![vec![0], vec![1, 2]];
        truncate_unmappable(&mut split, &columns, line_at);
        assert_eq!(split, [vec![0]]);
    }

    fn open_block(x0: f64, x1: f64, size: f64) -> Block {
        Block {
            table: None,
            segments: Vec::new(),
            x0,
            x1,
            top: 0.0,
            bottom: 0.0,
            last: 0,
            last_x0: x0,
            last_x1: x1,
            last_center: 0.0,
            last_size: size,
        }
    }

    #[test]
    fn swept_line_targets_match_the_exhaustive_search() {
        let mut state = 0x853C_49E6_748F_EA9B_u64;
        let mut draw = move |bound: u64| {
            state ^= state << 13_i32;
            state ^= state >> 7_i32;
            state ^= state << 17_i32;
            u32::try_from(state.rem_euclid(bound)).unwrap()
        };
        for _ in 0_i32..2_000_i32 {
            let count = usize::try_from(draw(12)).unwrap();
            let blocks: Vec<Block> = iter::repeat_with(|| {
                let x0 = f64::from(draw(100));
                open_block(x0, x0 + f64::from(draw(40)), 9.0 + f64::from(draw(3)))
            })
            .take(count)
            .collect();
            let active: Vec<usize> = (0..blocks.len())
                .filter(|_| f64::from(draw(4)) > 0.0_f64)
                .collect();
            let width = usize::try_from(draw(10)).unwrap() + 1;
            let line: Vec<Segment> = iter::repeat_with(|| {
                let x0 = f64::from(draw(100));
                segment(x0, x0 + f64::from(draw(30)), 0.0, 9.0 + f64::from(draw(3)))
            })
            .take(width)
            .collect();
            assert_eq!(
                line_targets(&blocks, &active, &line),
                naive_targets(&blocks, &active, &line)
            );
        }
        let blocks = vec![open_block(0.0, f64::NAN, SIZE), open_block(0.0, 10.0, SIZE)];
        let line = [segment(2.0, 4.0, 0.0, SIZE)];
        assert_eq!(
            line_targets(&blocks, &[0, 1], &line),
            naive_targets(&blocks, &[0, 1], &line)
        );
    }

    #[test]
    fn very_long_lines_build_blocks_in_near_linear_time() {
        let words = 8000_u32;
        let lines = 20_u32;
        let mut segments = Vec::new();
        let mut ranges = Vec::new();
        for line in 0..lines {
            let start = segments.len();
            for word in 0..words {
                let x = f64::from(word) * 300.0_f64;
                segments.push(segment(x, x + 250.0, 1000.0 - f64::from(line) * 12.0, SIZE));
            }
            ranges.push((start, segments.len()));
        }
        let started = Instant::now();
        let blocks = build_blocks(&segments, &ranges);
        assert!(started.elapsed().as_secs() < 5);
        assert_eq!(blocks.len(), usize::try_from(words).unwrap());
        assert!(
            blocks
                .iter()
                .all(|block| block.segments.len() == usize::try_from(lines).unwrap())
        );
    }

    #[test]
    fn items_are_ordered_by_line_then_position() {
        let runs = vec![
            run(120.0, 700.0, 40.0, "world"),
            run(50.0, 688.0, 60.0, "second line"),
            run(50.0, 700.0, 60.0, "hello"),
        ];
        assert_eq!(page_text(&runs, 0), "hello world\nsecond line");
    }

    #[test]
    fn spaces_follow_the_gap_between_items() {
        let runs = vec![
            run(50.0, 700.0, 20.0, "wor"),
            run(70.2, 700.0, 10.0, "ds"),
            run(85.0, 700.0, 20.0, "apart"),
        ];
        assert_eq!(page_text(&runs, 0), "words apart");
    }

    #[test]
    fn two_text_columns_are_read_column_by_column() {
        let mut runs = Vec::new();
        for (index, baseline) in [700.0_f64, 688.0_f64, 676.0_f64].into_iter().enumerate() {
            runs.push(run(300.0, baseline, 230.0, &format!("right {index}")));
            runs.push(run(50.0, baseline, 230.0, &format!("left {index}")));
        }
        assert_eq!(
            page_text(&runs, 0),
            "left 0\nleft 1\nleft 2\n\nright 0\nright 1\nright 2"
        );
    }

    #[test]
    fn label_value_rows_stay_row_major() {
        let mut runs = Vec::new();
        for (baseline, label, value) in [
            (700.0_f64, "Data:", "22/12/2026."),
            (688.0_f64, "Hor\u{e1}rio:", "09h:00min."),
            (676.0_f64, "Local:", "Sala 3"),
        ] {
            runs.push(run(50.0, baseline, 40.0, label));
            runs.push(run(250.0, baseline, 60.0, value));
        }
        assert_eq!(
            page_text(&runs, 0),
            "Data: 22/12/2026.\nHor\u{e1}rio: 09h:00min.\nLocal: Sala 3"
        );
    }

    #[test]
    fn wrapped_value_cells_keep_their_lines_together() {
        let runs = vec![
            run(50.0, 700.0, 40.0, "Prazo"),
            run(250.0, 700.0, 120.0, "180 dias corridos, contados"),
            run(250.0, 688.0, 120.0, "da ordem de servi\u{e7}o"),
            run(50.0, 660.0, 40.0, "Local"),
            run(250.0, 660.0, 120.0, "Avenida Central"),
        ];
        assert_eq!(
            page_text(&runs, 0),
            "Prazo 180 dias corridos, contados\nda ordem de servi\u{e7}o\n\nLocal Avenida Central"
        );
    }

    #[test]
    fn page_rotation_reads_in_the_visible_orientation() {
        let runs = vec![
            turned(
                [100.0_f64, 50.0_f64, 111.7_f64, 110.0_f64],
                (0.0_f64, -1.0_f64),
                "top line",
            ),
            turned(
                [88.0_f64, 50.0_f64, 99.7_f64, 110.0_f64],
                (0.0_f64, -1.0_f64),
                "bottom line",
            ),
        ];
        assert_eq!(page_text(&runs, 90), "top line\nbottom line");
        let upside_down = vec![
            turned(
                [100.0_f64, 50.0_f64, 140.0_f64, 61.7_f64],
                (-1.0_f64, 0.0_f64),
                "last",
            ),
            turned(
                [100.0_f64, 38.0_f64, 140.0_f64, 49.7_f64],
                (-1.0_f64, 0.0_f64),
                "first",
            ),
        ];
        assert_eq!(page_text(&upside_down, 180), "first\nlast");
    }

    #[test]
    fn sideways_text_is_emitted_after_the_main_pool() {
        let runs = vec![
            turned(
                [20.0_f64, 100.0_f64, 31.7_f64, 160.0_f64],
                (0.0_f64, 1.0_f64),
                "margin note",
            ),
            run(50.0, 700.0, 200.0, "main body text on the page"),
        ];
        assert_eq!(
            page_text(&runs, 0),
            "main body text on the page\n\nmargin note"
        );
    }

    #[test]
    fn overdrawn_duplicates_are_dropped() {
        let runs = vec![
            run(50.0, 700.0, 40.0, "Bold"),
            run(50.4, 700.0, 40.0, "Bold"),
            run(95.0, 700.0, 30.0, "text"),
        ];
        assert_eq!(page_text(&runs, 0), "Bold text");
    }

    #[test]
    fn out_of_order_pieces_land_where_they_are_drawn() {
        let runs = vec![
            run(289.0, 700.0, 66.0, "60 (sessenta)"),
            run(366.0, 700.0, 11.0, "as"),
            run(358.0, 700.0, 7.6, "di"),
            run(377.5, 700.0, 3.0, ","),
        ];
        assert_eq!(page_text(&runs, 0), "60 (sessenta) dias,");
    }

    #[test]
    fn degenerate_input_produces_empty_text() {
        assert_eq!(page_text(&[], 0), "");
        let runs = vec![
            run(f64::NAN, 700.0, 10.0, "nan"),
            run(10.0, f64::INFINITY, 10.0, "inf"),
            run(10.0, 10.0, 10.0, ""),
            Piece {
                item: TextItem {
                    rect: [0.0_f64; 4],
                    font_size: 0.0,
                    style: 0,
                    text: "x".to_owned(),
                },
                direction: (f64::NAN, 0.0_f64),
                bold: false,
                italic: false,
            },
        ];
        assert_eq!(page_text(&runs, 0), "");
    }

    #[test]
    fn hostile_layouts_stay_bounded() {
        let mut runs = Vec::new();
        for index in 0_i32..4_000_i32 {
            let x = f64::from(index.rem_euclid(97_i32)) * 7.0_f64;
            let y = f64::from(index.rem_euclid(211_i32)) * 3.0_f64;
            runs.push(run(x, y, 30.0, "ab"));
        }
        let text = page_text(&runs, 270);
        assert_ne!(text, "");
        let mut nested = Vec::new();
        for index in 0_i32..200_i32 {
            let offset = f64::from(index) * 2.0_f64;
            nested.push(run(offset, 700.0 - offset, 500.0 - offset, "n"));
        }
        assert_ne!(page_text(&nested, 0), "");
    }

    #[test]
    fn mutated_documents_never_panic() {
        let fixtures: [&[u8]; 5] = [
            include_bytes!("../../__tests__/fixtures/links.pdf"),
            include_bytes!("../../__tests__/fixtures/helvetica-winansi.pdf"),
            include_bytes!("../../__tests__/fixtures/react-pdf-declaration.pdf"),
            include_bytes!("../../__tests__/fixtures/rotated-cropped.pdf"),
            include_bytes!("../../__tests__/fixtures/object-streams.pdf"),
        ];
        let limits = text_limits();
        let mut state = 0x9E37_79B9_7F4A_7C15_u64;
        let mut next = move || {
            state ^= state << 13_i32;
            state ^= state >> 7_i32;
            state ^= state << 17_i32;
            state
        };
        for fixture in fixtures {
            drop(document_text(fixture, None, &limits, OPTIONS).unwrap());
            for _ in 0_i32..150_i32 {
                let mut bytes = fixture.to_vec();
                for _ in 0..=(next() & 7) {
                    let at = usize::try_from(next()).unwrap_or(0).rem_euclid(bytes.len());
                    if let Some(byte) = bytes.get_mut(at) {
                        *byte ^= u8::try_from(next().rem_euclid(255)).unwrap_or(1).max(1);
                    }
                }
                let cut = usize::try_from(next())
                    .unwrap_or(0)
                    .rem_euclid(bytes.len() + 1);
                if next().is_multiple_of(4) {
                    bytes.truncate(cut);
                }
                drop(black_box(document_text(&bytes, None, &limits, OPTIONS)));
            }
        }
    }

    #[test]
    fn page_selection_validates_indexes() {
        let limits = text_limits();
        let error = document_text(b"%PDF-1.4\n", Some(&[0]), &limits, OPTIONS).unwrap_err();
        assert_eq!(error.code, FailureCode::InvalidPdf);
        let oversized = Limits {
            max_pdf_bytes: 4,
            ..Limits::default()
        };
        let error_2 = document_text(b"%PDF-1.4\n", None, &oversized, OPTIONS).unwrap_err();
        assert_eq!(error_2.code, FailureCode::LimitExceeded);
    }
}

#[cfg(test)]
mod structure_tests {
    use super::*;
    use crate::num::usize_to_f64;
    use crate::test_pdf::build;
    use crate::test_pdf::stream_object;
    use crate::test_pdf::{PageSpec, bold, document, grid, page, rule, text};
    use core::fmt::Write as _;
    use core::hint::black_box;

    const PLAIN: TextOptions = TextOptions {
        budget: TextBudget::UNLIMITED,
        markdown: false,
        drop_running: false,
    };
    const MARKDOWN: TextOptions = TextOptions {
        budget: TextBudget::UNLIMITED,
        markdown: true,
        drop_running: false,
    };
    const OPTIONS: TextOptions = TextOptions {
        budget: TextBudget::UNLIMITED,
        markdown: false,
        drop_running: true,
    };

    fn tables_of(bytes: &[u8]) -> Vec<Table> {
        document_tables(bytes, None, &text_limits()).unwrap()
    }

    fn pages_of(bytes: &[u8], options: TextOptions) -> Vec<String> {
        document_text(bytes, None, &text_limits(), options).unwrap()
    }

    #[test]
    fn markdown_fixtures_match_hand_written_goldens() {
        macro_rules! fixture {
            ($name:literal) => {
                (
                    $name,
                    include_bytes!(concat!("../../__tests__/fixtures/", $name, ".pdf")).as_slice(),
                    include_str!(concat!("../../__tests__/fixtures/", $name, ".md")),
                )
            };
        }
        let options = TextOptions {
            budget: TextBudget::UNLIMITED,
            markdown: true,
            drop_running: true,
        };
        for (name, bytes, golden) in [
            fixture!("markdown-basics"),
            fixture!("markdown-hyphenation"),
            fixture!("markdown-page-continue"),
            fixture!("markdown-nested-lists"),
            fixture!("markdown-two-column"),
            fixture!("markdown-headings-react"),
        ] {
            let pages = pages_of(bytes, options);
            let joined = pages
                .iter()
                .filter(|page| !page.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join("\n\n");
            assert_eq!(joined, golden.trim_end(), "{name}");
        }
    }

    fn cell(table: &Table, row: u32, col: u32) -> &Cell {
        table
            .cells
            .iter()
            .find(|cell| cell.row == row && cell.col == col)
            .unwrap()
    }

    fn price_table(top: f64) -> String {
        let rows = [top, top - 20.0_f64, top - 40.0_f64, top - 60.0_f64];
        let mut out = grid(&rows, &[50.0_f64, 200.0_f64, 350.0_f64]);
        for (index, (left, right)) in [("Item", "Valor"), ("Cimento", "12,50"), ("Areia", "8,00")]
            .into_iter()
            .enumerate()
        {
            let baseline = top - 12.0_f64 - 20.0_f64 * usize_to_f64(index);
            out.push_str(&text(55.0, baseline, 10.0, left));
            out.push_str(&text(205.0, baseline, 10.0, right));
        }
        out
    }

    #[test]
    fn ruled_grid_becomes_a_table() {
        let bytes = document(&[page(price_table(700.0))], &[]);
        let tables = tables_of(&bytes);
        assert_eq!(tables.len(), 1);
        let table = &tables[0];
        assert_eq!((table.page_index, table.rows, table.cols), (0, 3, 2));
        assert_eq!(table.cells.len(), 6);
        assert_eq!(cell(table, 0, 0).text, "Item");
        assert_eq!(cell(table, 2, 1).text, "8,00");
        assert!(
            (table.bbox[0] - 50.0).abs() < 1e-6_f64 && (table.bbox[2] - 350.0).abs() < 1e-6_f64
        );
        assert!(
            (table.bbox[1] - 640.0).abs() < 1e-6_f64 && (table.bbox[3] - 700.0).abs() < 1e-6_f64
        );
        let pages = pages_of(&bytes, PLAIN);
        assert_eq!(pages, ["Item Valor\nCimento 12,50\nAreia 8,00"]);
        let markdown = pages_of(&bytes, MARKDOWN);
        assert_eq!(
            markdown,
            ["| Item | Valor |\n| --- | --- |\n| Cimento | 12,50 |\n| Areia | 8,00 |"]
        );
    }

    #[test]
    fn merged_cells_report_spans() {
        let mut content = String::new();
        for y in [700.0_f64, 680.0_f64, 660.0_f64] {
            content.push_str(&rule(50.0, y, 350.0, y));
        }
        content.push_str(&rule(50.0, 660.0, 50.0, 700.0));
        content.push_str(&rule(350.0, 660.0, 350.0, 700.0));
        content.push_str(&rule(200.0, 660.0, 200.0, 680.0));
        content.push_str(&text(60.0, 688.0, 10.0, "Precos unitarios"));
        content.push_str(&text(60.0, 668.0, 10.0, "Cimento"));
        content.push_str(&text(210.0, 668.0, 10.0, "12,50"));
        let bytes = document(&[page(content)], &[]);
        let tables = tables_of(&bytes);
        assert_eq!(tables.len(), 1);
        let table = &tables[0];
        assert_eq!((table.rows, table.cols, table.cells.len()), (2, 2, 3));
        let header = cell(table, 0, 0);
        assert_eq!((header.row_span, header.col_span), (1, 2));
        assert_eq!(header.text, "Precos unitarios");
        assert!(
            (header.bbox[0] - 50.0).abs() < 1e-6_f64 && (header.bbox[2] - 350.0).abs() < 1e-6_f64
        );
        assert!(table.cells.iter().all(|cell| cell.col <= 1));
        let markdown = pages_of(&bytes, MARKDOWN);
        assert_eq!(
            markdown,
            ["| Precos unitarios |  |\n| --- | --- |\n| Cimento | 12,50 |"]
        );
    }

    #[test]
    fn row_spans_cover_missing_horizontal_edges() {
        let mut content = grid(
            &[700.0_f64, 680.0_f64, 660.0_f64, 640.0_f64],
            &[50.0_f64, 200.0_f64, 350.0_f64],
        );
        content = content.replace(
            "0.5 w 50 660 m 350 660 l S\n",
            "0.5 w 200 660 m 350 660 l S\n",
        );
        content.push_str(&text(55.0, 668.0, 10.0, "Grupo"));
        content.push_str(&text(205.0, 688.0, 10.0, "a"));
        content.push_str(&text(205.0, 668.0, 10.0, "b"));
        content.push_str(&text(205.0, 648.0, 10.0, "c"));
        let tables = tables_of(&document(&[page(content)], &[]));
        let spanning = tables[0]
            .cells
            .iter()
            .find(|cell| cell.text == "Grupo")
            .unwrap();
        assert_eq!((spanning.row, spanning.row_span), (1, 2));
    }

    fn borderless(rows: &[(&str, &str, &str)], top: f64) -> String {
        let mut out = String::new();
        for (index, (a, b, c)) in rows.iter().enumerate() {
            let baseline = top - 14.0_f64 * usize_to_f64(index);
            out.push_str(&text(50.0, baseline, 10.0, a));
            out.push_str(&text(200.0, baseline, 10.0, b));
            out.push_str(&text(350.0, baseline, 10.0, c));
        }
        out
    }

    fn alphanumerics(page: &str) -> usize {
        page.chars().filter(|ch| ch.is_alphanumeric()).count()
    }

    fn assert_no_markdown_loss(name: &str, bytes: &[u8]) {
        let plain = pages_of(bytes, OPTIONS).concat();
        let markdown = pages_of(bytes, MARKDOWN).concat();
        assert!(
            alphanumerics(&markdown) >= alphanumerics(&plain),
            "{name}:\n{plain}\n---\n{markdown}"
        );
    }

    #[test]
    fn bold_row_wrap_spanning_columns_is_not_dropped() {
        let mut content = String::new();
        content.push_str(&bold(50.0, 700.0, 10.0, "Item"));
        content.push_str(&bold(200.0, 700.0, 10.0, "Qtd"));
        content.push_str(&bold(350.0, 700.0, 10.0, "Valor"));
        content.push_str(&text(
            50.0,
            688.0,
            10.0,
            "TAILAH RICARDO BARBOSA assina o termo",
        ));
        content.push_str(&borderless(
            &[
                ("Cimento", "10", "125,00"),
                ("Areia", "4", "32,00"),
                ("Brita", "7", "91,00"),
            ],
            674.0,
        ));
        let bytes = document(&[page(content)], &[]);
        let markdown = pages_of(&bytes, MARKDOWN);
        assert!(
            markdown[0].contains("TAILAH RICARDO BARBOSA"),
            "{}",
            markdown[0]
        );
        assert_no_markdown_loss("bold-row-wrap", &bytes);
    }

    #[test]
    fn markdown_keeps_every_character_of_the_fixture_corpus() {
        macro_rules! fixture {
            ($name:literal) => {
                (
                    $name,
                    include_bytes!(concat!("../../__tests__/fixtures/", $name, ".pdf")).as_slice(),
                )
            };
        }
        for (name, bytes) in [
            fixture!("broken-xref"),
            fixture!("habilitacao-150"),
            fixture!("helvetica-winansi"),
            fixture!("icp-signed"),
            fixture!("incremental-update"),
            fixture!("links"),
            fixture!("object-streams"),
            fixture!("react-pdf-declaration"),
            fixture!("rotated-cropped"),
            fixture!("markdown-basics"),
            fixture!("markdown-headings-react"),
            fixture!("markdown-hyphenation"),
            fixture!("markdown-nested-lists"),
            fixture!("markdown-page-continue"),
            fixture!("markdown-two-column"),
        ] {
            assert_no_markdown_loss(name, bytes);
        }
    }

    #[test]
    fn markdown_drops_recurring_page_edge_blocks_outside_the_bands() {
        let mut pages = Vec::new();
        for index in 0_i32..4_i32 {
            let shift = 30.0_f64 * f64::from(index);
            let mut content = String::new();
            content.push_str(&text(50.0, 650.0, 10.0, "FUNDACAO OSWALDO CRUZ"));
            content.push_str(&text(
                50.0,
                600.0 - shift,
                10.0,
                "Clausula repetida no corpo.",
            ));
            content.push_str(&text(
                50.0,
                400.0 - shift,
                10.0,
                &format!("Texto proprio da pagina {index}."),
            ));
            content.push_str(&text(
                50.0,
                150.0,
                10.0,
                &format!("Portaria 12/2026 pg. {}", index + 1_i32),
            ));
            pages.push(page(content));
        }
        let bytes = document(&pages, &[]);
        let options = TextOptions {
            budget: TextBudget::UNLIMITED,
            markdown: true,
            drop_running: true,
        };
        let markdown = pages_of(&bytes, options);
        assert!(
            markdown[0].contains("FUNDACAO OSWALDO CRUZ"),
            "{}",
            markdown[0]
        );
        assert!(
            markdown[0].contains("Portaria 12/2026 pg. 1"),
            "{}",
            markdown[0]
        );
        for page_markdown in &markdown[1..] {
            assert!(!page_markdown.contains("FUNDACAO"), "{page_markdown}");
            assert!(!page_markdown.contains("Portaria"), "{page_markdown}");
            assert!(
                page_markdown.contains("Clausula repetida no corpo."),
                "{page_markdown}"
            );
            assert!(
                page_markdown.contains("Texto proprio da pagina"),
                "{page_markdown}"
            );
        }
        let kept = pages_of(&bytes, MARKDOWN);
        assert!(
            kept.iter()
                .all(|page_markdown| page_markdown.contains("Portaria"))
        );
    }

    #[test]
    fn borderless_aligned_columns_become_a_table() {
        let content = borderless(
            &[
                ("Item", "Qtd", "Valor"),
                ("Cimento", "10", "125,00"),
                ("Areia", "4", "32,00"),
                ("Brita", "7", "91,00"),
            ],
            700.0,
        );
        let bytes = document(&[page(content)], &[]);
        let tables = tables_of(&bytes);
        assert_eq!(tables.len(), 1);
        let table = &tables[0];
        assert_eq!((table.rows, table.cols), (4, 3));
        assert_eq!(cell(table, 1, 2).text, "125,00");
        assert_eq!(cell(table, 3, 0).text, "Brita");
        let markdown = pages_of(&bytes, MARKDOWN);
        assert_eq!(
            markdown,
            [
                "| Item | Qtd | Valor |\n| --- | --- | --- |\n| Cimento | 10 | 125,00 |\n| Areia | 4 | 32,00 |\n| Brita | 7 | 91,00 |"
            ]
        );
        let plain = pages_of(&bytes, PLAIN);
        assert_eq!(
            plain,
            ["Item Qtd Valor\nCimento 10 125,00\nAreia 4 32,00\nBrita 7 91,00"]
        );
    }

    #[test]
    fn numbered_clauses_are_not_tables() {
        let mut content = String::new();
        for (index, (marker, body)) in [
            ("3.1.", "Os licitantes cadastrarao a proposta no sistema."),
            ("3.2.", "A fase de habilitacao sucedera a de lances."),
            ("3.2.1.", "Documentos poderao ser exigidos depois."),
            ("a)", "Declaracao de inexistencia de fatos."),
        ]
        .iter()
        .enumerate()
        {
            let baseline = 700.0_f64 - 14.0_f64 * usize_to_f64(index);
            content.push_str(&text(50.0, baseline, 10.0, marker));
            content.push_str(&text(120.0, baseline, 10.0, body));
        }
        let bytes = document(&[page(content)], &[]);
        assert_eq!(tables_of(&bytes), []);
        let markdown = pages_of(&bytes, MARKDOWN);
        assert!(!markdown[0].contains("| --- |"), "{}", markdown[0]);
        assert!(is_marker("(12)"));
        assert!(is_marker("IV."));
        assert!(is_marker("\u{2022}"));
        assert!(!is_marker("12"));
        assert!(!is_marker("Valor:  total geral do item"));
    }

    #[test]
    fn wrapped_cell_lines_stay_in_their_row() {
        let mut content = borderless(
            &[
                ("Item", "Qtd", "Valor"),
                ("Cimento", "10", "125,00"),
                ("Areia", "4", "32,00"),
            ],
            700.0,
        );
        content.push_str(&text(50.0, 660.0, 10.0, "fina lavada"));
        let tables = tables_of(&document(&[page(content)], &[]));
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].rows, 3);
        assert_eq!(cell(&tables[0], 2, 0).text, "Areia\nfina lavada");
    }

    #[test]
    fn heading_below_a_table_is_not_merged_into_the_last_cell() {
        let mut content = borderless(
            &[
                ("Item", "Qtd", "Valor"),
                ("Cimento", "10", "125,00"),
                ("Areia", "4", "32,00"),
            ],
            700.0,
        );
        content.push_str(&bold(50.0, 658.0, 10.0, "Observacoes"));
        let bytes = document(&[page(content.clone())], &[]);
        let tables = tables_of(&bytes);
        assert_eq!(tables[0].cells.len(), 9);
        assert_eq!(cell(&tables[0], 2, 0).text, "Areia");
        let markdown = pages_of(&bytes, MARKDOWN);
        assert!(markdown[0].ends_with("| Areia | 4 | 32,00 |\n\n**Observacoes**"));
        let mut large = borderless(
            &[
                ("Item", "Qtd", "Valor"),
                ("Cimento", "10", "125,00"),
                ("Areia", "4", "32,00"),
            ],
            700.0,
        );
        large.push_str(&text(50.0, 658.0, 14.0, "Observacoes"));
        let tables_2 = tables_of(&document(&[page(large)], &[]));
        assert_eq!(cell(&tables_2[0], 2, 0).text, "Areia");
    }

    #[test]
    fn ruled_table_does_not_swallow_the_heading_below_it() {
        let mut content = price_table(700.0);
        content.push_str(&bold(50.0, 622.0, 12.0, "Informacoes Adicionais"));
        let bytes = document(&[page(content)], &[]);
        let tables = tables_of(&bytes);
        assert_eq!(tables.len(), 1);
        assert!(
            tables[0]
                .cells
                .iter()
                .all(|cell| !cell.text.contains("Informacoes"))
        );
        let pages = pages_of(&bytes, PLAIN);
        assert!(pages[0].ends_with("Areia 8,00\n\nInformacoes Adicionais"));
    }

    #[test]
    fn tables_split_by_a_page_break_are_reported_per_page() {
        let bytes = document(&[page(price_table(160.0)), page(price_table(780.0))], &[]);
        let tables = tables_of(&bytes);
        assert_eq!(tables.len(), 2);
        assert_eq!((tables[0].page_index, tables[1].page_index), (0, 1));
        assert_eq!(tables[0].rows, tables[1].rows);
        let second = document_tables(&bytes, Some(&[1]), &text_limits()).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].page_index, 1);
        let missing = document_tables(&bytes, Some(&[5]), &text_limits()).unwrap_err();
        assert_eq!(missing.code, FailureCode::InvalidPdf);
    }

    #[test]
    fn prose_and_table_share_a_page_in_reading_order() {
        let mut content = String::new();
        content.push_str(&text(
            50.0,
            780.0,
            10.0,
            "Introducao ao termo de referencia desta compra.",
        ));
        content.push_str(&text(
            50.0,
            766.0,
            10.0,
            "O quadro abaixo lista os itens previstos.",
        ));
        content.push_str(&price_table(740.0));
        content.push_str(&text(50.0, 600.0, 10.0, "Os valores incluem tributos."));
        let bytes = document(&[page(content)], &[]);
        let markdown = pages_of(&bytes, MARKDOWN);
        let page_text = &markdown[0];
        let intro = page_text.find("Introducao").unwrap();
        let table = page_text.find("| Item | Valor |").unwrap();
        let outro = page_text.find("Os valores").unwrap();
        assert!(intro < table && table < outro, "{page_text}");
        assert!(page_text.contains(
            "Introducao ao termo de referencia desta compra. O quadro abaixo lista os itens previstos."
        ));
        assert!(page_text.contains("| Areia | 8,00 |\n\nOs valores incluem tributos."));
        let plain = pages_of(&bytes, PLAIN);
        assert!(plain[0].contains("Item Valor\nCimento 12,50\nAreia 8,00\n\nOs valores"));
    }

    #[test]
    fn rotated_pages_report_tables_in_visible_orientation() {
        let content = format!("q 0 1 -1 0 600 0 cm\n{}Q\n", price_table(500.0));
        let spec = PageSpec {
            content,
            rotate: 90,
        };
        let bytes = document(&[spec], &[]);
        let tables = tables_of(&bytes);
        assert_eq!(tables.len(), 1);
        let table = &tables[0];
        assert_eq!((table.rows, table.cols), (3, 2));
        assert_eq!(cell(table, 0, 0).text, "Item");
        assert_eq!(cell(table, 2, 1).text, "8,00");
        let [x0, y0, x1, y1] = table.bbox;
        assert!(
            (x0 - 100.0).abs() < 1e-6_f64 && (x1 - 160.0).abs() < 1e-6_f64,
            "{:?}",
            table.bbox
        );
        assert!(
            (y0 - 50.0).abs() < 1e-6_f64 && (y1 - 350.0).abs() < 1e-6_f64,
            "{:?}",
            table.bbox
        );
        assert_eq!(
            pages_of(&bytes, PLAIN),
            ["Item Valor\nCimento 12,50\nAreia 8,00"]
        );
    }

    #[test]
    fn decorative_rules_and_empty_grids_are_not_tables() {
        let mut content = grid(
            &[700.0_f64, 680.0_f64, 660.0_f64],
            &[50.0_f64, 200.0_f64, 350.0_f64],
        );
        content.push_str(&text(50.0, 600.0, 10.0, "Texto solto"));
        let bytes = document(&[page(content)], &[]);
        assert_eq!(tables_of(&bytes), []);
        assert_eq!(pages_of(&bytes, PLAIN), ["Texto solto"]);
        let underline = format!(
            "{}{}",
            text(50.0, 700.0, 10.0, "Titulo sublinhado"),
            rule(50.0, 697.0, 150.0, 697.0)
        );
        assert_eq!(tables_of(&document(&[page(underline)], &[])), []);
    }

    #[test]
    fn page_sized_frames_do_not_count_as_tables() {
        let mut content = String::from("0.5 w 0 0 600 800 re S\n");
        content.push_str("30 30 540 740 re S\n");
        content.push_str(&rule(30.0, 400.0, 570.0, 400.0));
        content.push_str(&rule(300.0, 30.0, 300.0, 770.0));
        content.push_str(&text(40.0, 700.0, 10.0, "Quadro externo"));
        content.push_str(&text(310.0, 700.0, 10.0, "Coluna direita"));
        let tables = tables_of(&document(&[page(content)], &[]));
        assert!(tables.len() <= 1);
        let frame_only = format!(
            "0 0 600 800 re S {}",
            text(40.0, 700.0, 10.0, "Somente moldura")
        );
        assert_eq!(tables_of(&document(&[page(frame_only)], &[])), []);
    }

    #[test]
    fn two_text_columns_are_not_mistaken_for_a_table() {
        let mut content = String::new();
        for index in 0_i32..8_i32 {
            let baseline = 700.0_f64 - 12.0_f64 * f64::from(index);
            content.push_str(&text(
                50.0,
                baseline,
                10.0,
                "A coluna da esquerda traz um texto corrido bem longo que ocupa a largura toda",
            ));
            content.push_str(&text(
                320.0,
                baseline,
                10.0,
                "A coluna da direita traz outro texto corrido bem longo que ocupa a largura",
            ));
        }
        let bytes = document(&[page(content)], &[]);
        assert_eq!(tables_of(&bytes), []);
    }

    fn running_page(index: usize, header: &str, body: &[&str]) -> PageSpec {
        let mut content = String::new();
        content.push_str(&text(50.0, 50.0, 9.0, "Contato 3716-9911"));
        content.push_str(&text(50.0, 770.0, 9.0, header));
        content.push_str(&text(480.0, 770.0, 9.0, &format!("Pagina {index} de 4")));
        for (line, value) in body.iter().enumerate() {
            content.push_str(&text(50.0, 600.0 - 14.0 * usize_to_f64(line), 10.0, value));
        }
        content.push_str(&text(
            50.0,
            30.0,
            9.0,
            &format!("Edital 12/2026 - pg. {index}"),
        ));
        page(content)
    }

    fn running_document(header: impl Fn(usize) -> String) -> Vec<u8> {
        let bodies: [&[&str]; 4] = [
            &["Primeira linha do edital", "a sessao sera realizada na"],
            &["plataforma eletronica indicada", "Segunda linha"],
            &["Terceira pagina"],
            &["Quarta pagina"],
        ];
        let pages: Vec<PageSpec> = bodies
            .iter()
            .enumerate()
            .map(|(index, body)| running_page(index.saturating_add(1), &header(index), body))
            .collect();
        document(&pages, &[])
    }

    #[test]
    fn running_headers_and_footers_are_dropped() {
        let bytes = running_document(|_| "Prefeitura Municipal de Marilac".to_owned());
        let kept = pages_of(&bytes, PLAIN);
        assert!(kept[0].contains("Prefeitura Municipal de Marilac"));
        assert!(kept[0].contains("Edital 12/2026 - pg. 1"));
        let options = TextOptions {
            budget: TextBudget::UNLIMITED,
            markdown: false,
            drop_running: true,
        };
        let dropped = pages_of(&bytes, options);
        assert_eq!(
            dropped,
            [
                "Prefeitura Municipal de Marilac\n\nPrimeira linha do edital\na sessao sera realizada na\n\nContato 3716-9911",
                "plataforma eletronica indicada\nSegunda linha",
                "Terceira pagina",
                "Quarta pagina",
            ]
        );
        let joined = dropped[..2].join("\n\n");
        assert!(joined.contains("realizada na\n\nContato 3716-9911\n\nplataforma"));
    }

    #[test]
    fn varying_headers_below_half_of_the_pages_are_kept() {
        let bytes = running_document(|index| format!("Capitulo {}", ["A", "B", "C", "D"][index]));
        let options = TextOptions {
            budget: TextBudget::UNLIMITED,
            markdown: false,
            drop_running: true,
        };
        let pages = pages_of(&bytes, options);
        assert!(pages[0].starts_with("Capitulo A"));
        assert!(pages[1].starts_with("Capitulo B"));
        assert!(!pages[1].contains("Pagina 2"));
        assert!(!pages[1].contains("Edital 12/2026"));
    }

    #[test]
    fn single_pages_and_selected_pages_never_lose_their_header() {
        let bytes = running_document(|_| "Prefeitura Municipal de Marilac".to_owned());
        let options = TextOptions {
            budget: TextBudget::UNLIMITED,
            markdown: false,
            drop_running: true,
        };
        let one = document_text(&bytes, Some(&[0]), &text_limits(), options).unwrap();
        assert!(one[0].contains("Prefeitura Municipal de Marilac"));
    }

    #[test]
    fn running_keys_normalize_digits_and_spacing() {
        assert_eq!(running_key("Pagina  12  de 120"), "pagina # de #");
        assert_eq!(running_key("  7 "), "#");
        assert_eq!(running_key("Edital 12/2026"), "edital #/#");
        assert_eq!(running_key(""), "");
    }

    #[test]
    fn tables_inside_the_header_band_are_dropped_when_repeated() {
        let mut pages = Vec::new();
        for index in 0_i32..3_i32 {
            let mut content = grid(
                &[780.0_f64, 760.0_f64, 740.0_f64],
                &[50.0_f64, 250.0_f64, 450.0_f64],
            );
            content.push_str(&text(55.0, 768.0, 9.0, "Orgao"));
            content.push_str(&text(
                255.0,
                768.0,
                9.0,
                &format!("Pagina {}", index + 1_i32),
            ));
            content.push_str(&text(55.0, 748.0, 9.0, "Edital"));
            content.push_str(&text(255.0, 748.0, 9.0, "12/2026"));
            content.push_str(&text(50.0, 500.0, 10.0, "Corpo do documento"));
            pages.push(page(content));
        }
        let bytes = document(&pages, &[]);
        let options = TextOptions {
            budget: TextBudget::UNLIMITED,
            markdown: false,
            drop_running: true,
        };
        assert_eq!(
            pages_of(&bytes, options),
            [
                "Corpo do documento",
                "Corpo do documento",
                "Corpo do documento"
            ]
        );
    }

    #[test]
    fn mutated_structured_documents_never_panic() {
        let mut content = price_table(700.0);
        content.push_str(&borderless(
            &[("A", "B", "C"), ("D", "E", "F"), ("G", "H", "I")],
            500.0,
        ));
        let fixture = document(&[page(content)], &[]);
        let limits = text_limits();
        let mut state = 0x2545_F491_4F6C_DD1D_u64;
        let mut next = move || {
            state ^= state << 13_i32;
            state ^= state >> 7_i32;
            state ^= state << 17_i32;
            state
        };
        for _ in 0_i32..300_i32 {
            let mut bytes = fixture.clone();
            for _ in 0..=next().rem_euclid(6) {
                let at = usize::try_from(next()).unwrap_or(0).rem_euclid(bytes.len());
                if let Some(byte) = bytes.get_mut(at) {
                    *byte = u8::try_from(next().rem_euclid(255)).unwrap_or(1).max(1);
                }
            }
            drop(black_box(document_tables(&bytes, None, &limits)));
            drop(black_box(document_text(&bytes, None, &limits, MARKDOWN)));
        }
    }

    #[test]
    fn page_limit_violations_propagate_instead_of_emptying_pages() {
        let mut content = String::new();
        for index in 0_i32..20_i32 {
            content.push_str(&text(50.0, 700.0 - f64::from(index) * 20.0, 10.0, "linha"));
        }
        let bytes = document(&[page(text(50.0, 700.0, 10.0, "ok")), page(content)], &[]);
        let tight = Limits {
            max_items_per_page: 10,
            ..text_limits()
        };
        for options in [PLAIN, MARKDOWN] {
            let error = document_text(&bytes, None, &tight, options).unwrap_err();
            assert_eq!(error.code, FailureCode::LimitExceeded);
        }
        let error = document_tables(&bytes, None, &tight).unwrap_err();
        assert_eq!(error.code, FailureCode::LimitExceeded);
        assert_eq!(
            document_text(&bytes, Some(&[0]), &tight, PLAIN).unwrap(),
            ["ok"]
        );
    }

    #[test]
    fn malformed_page_content_still_degrades_to_an_empty_page() {
        let font = "/Resources << /Font << /F1 3 0 R >> >>";
        let broken = build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (
                2,
                "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>".to_owned(),
            ),
            (
                3,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
            ),
            (
                4,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 5 0 R {font} >>"
                ),
            ),
            (5, stream_object("", &text(50.0, 700.0, 10.0, "first"))),
            (
                6,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 7 0 R {font} >>"
                ),
            ),
            (7, stream_object("/Filter /FlateDecode", "xxxxx")),
        ]);
        let pages = pages_of(&broken, PLAIN);
        assert_eq!(pages, ["first", ""]);
    }

    #[test]
    fn markdown_links_follow_the_selected_pages() {
        let font = "/Resources << /Font << /F1 3 0 R >> >>";
        let link = |uri: &str| {
            format!(
                "<< /Type /Annot /Subtype /Link /Rect [45 695 120 712] /A << /S /URI /URI ({uri}) >> >>"
            )
        };
        let page = |contents: u32, annot: u32| {
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents {contents} 0 R /Annots [{annot} 0 R] {font} >>"
            )
        };
        let bytes = build(&[
            (1, "<< /Type /Catalog /Pages 2 0 R >>".to_owned()),
            (
                2,
                "<< /Type /Pages /Kids [4 0 R 7 0 R] /Count 2 >>".to_owned(),
            ),
            (
                3,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
            ),
            (4, page(5, 6)),
            (5, stream_object("", &text(50.0, 700.0, 10.0, "Site one"))),
            (6, link("https://example.com/one")),
            (7, page(8, 9)),
            (8, stream_object("", &text(50.0, 700.0, 10.0, "Site two"))),
            (9, link("https://example.com/two")),
        ]);
        let all = pages_of(&bytes, MARKDOWN);
        assert!(all[0].contains("(https://example.com/one)"), "{all:?}");
        assert!(all[1].contains("(https://example.com/two)"), "{all:?}");
        let second = document_text(&bytes, Some(&[1]), &text_limits(), MARKDOWN).unwrap();
        assert_eq!(second, [all[1].clone()]);
    }

    #[test]
    fn hostile_rulings_stay_bounded() {
        let mut content = String::new();
        for index in 0_i32..3_000_i32 {
            let y = 10.0_f64 + f64::from(index.rem_euclid(700_i32));
            let x = 10.0_f64 + f64::from(index.rem_euclid(500_i32));
            write!(
                content,
                "{x} {y} m {} {y} l S {x} {y} m {x} {} l S ",
                x + 40.0_f64,
                y + 30.0_f64
            )
            .unwrap();
        }
        content.push_str(&text(50.0, 700.0, 10.0, "texto"));
        let bytes = document(&[page(content)], &[]);
        drop(document_tables(&bytes, None, &text_limits()).unwrap());
        drop(document_text(&bytes, None, &text_limits(), MARKDOWN).unwrap());
    }
}
