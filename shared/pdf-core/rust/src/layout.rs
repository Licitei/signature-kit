use std::cmp::Ordering;
use std::collections::HashSet;

use crate::document::{Document, Page};
use crate::failure::{Failure, Outcome};
use crate::inspection::Limits;
use crate::text::{Run, Session, extract_runs};

const CELL_GAP: f64 = 1.5;
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

fn turn(quarter: usize, x: f64, y: f64) -> (f64, f64) {
    match quarter % 4 {
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
    usize::try_from(normalized / 90).unwrap_or(0) % 4
}

struct Frag<'a> {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    size: f64,
    text: &'a str,
}

impl Frag<'_> {
    fn center(&self) -> f64 {
        (self.y0 + self.y1) * 0.5
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
    members: Vec<usize>,
    x0: f64,
    x1: f64,
    y0: f64,
    y1: f64,
    size: f64,
    center: f64,
    continuation: bool,
}

struct Block {
    segments: Vec<usize>,
    x0: f64,
    x1: f64,
    top: f64,
    bottom: f64,
    last: usize,
    last_x0: f64,
    last_x1: f64,
    last_center: f64,
    last_size: f64,
}

fn compare(left: f64, right: f64) -> Ordering {
    left.total_cmp(&right)
}

fn cluster_lines(frags: &[Frag<'_>]) -> Vec<Line> {
    let mut order: Vec<usize> = (0..frags.len()).collect();
    order.sort_unstable_by(|&a, &b| match (frags.get(a), frags.get(b)) {
        (Some(left), Some(right)) => {
            compare(right.center(), left.center()).then_with(|| compare(left.x0, right.x0))
        }
        _ => Ordering::Equal,
    });
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
                prior.text == frag.text && width > 0.0 && overlap >= DUPLICATE_OVERLAP * width
            });
        if !duplicate {
            kept.push(index);
        }
    }
    *members = kept;
}

fn split_segments(frags: &[Frag<'_>], line: &Line, out: &mut Vec<Segment>) {
    let mut members = line.members.clone();
    members.sort_unstable_by(|&a, &b| match (frags.get(a), frags.get(b)) {
        (Some(left), Some(right)) => compare(left.x0, right.x0),
        _ => Ordering::Equal,
    });
    drop_duplicates(frags, &mut members);
    let mut current: Option<Segment> = None;
    let mut right_edge = f64::NEG_INFINITY;
    let mut right_size = 0.0f64;
    for index in members {
        let Some(frag) = frags.get(index) else {
            continue;
        };
        let gap = frag.x0 - right_edge;
        let split = current.is_some() && gap > CELL_GAP * frag.size.max(right_size);
        if split && let Some(done) = current.take() {
            out.push(done);
        }
        match current.as_mut() {
            Some(segment) => {
                segment.members.push(index);
                segment.x0 = segment.x0.min(frag.x0);
                segment.x1 = segment.x1.max(frag.x1);
                segment.y0 = segment.y0.min(frag.y0);
                segment.y1 = segment.y1.max(frag.y1);
                segment.size = segment.size.max(frag.size);
                segment.center = line.center;
            }
            None => {
                let continuation = frag.text.chars().next().is_some_and(|ch| {
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
                });
            }
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

fn build_blocks(segments: &[Segment], line_starts: &[usize]) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut active: Vec<usize> = Vec::new();
    let mut ends = line_starts
        .iter()
        .skip(1)
        .copied()
        .chain(Some(segments.len()));
    for &start in line_starts {
        let end = ends.next().unwrap_or(segments.len());
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
        let fits = |block: &Block, segment: &Segment| {
            overlaps(block.last_x0, block.last_x1, segment.x0, segment.x1)
                && similar_size(block.last_size, segment.size)
        };
        let targets: Vec<Option<usize>> = line
            .iter()
            .map(|segment| {
                if row_break {
                    return None;
                }
                let mut matches = active
                    .iter()
                    .copied()
                    .filter(|&id| blocks.get(id).is_some_and(|block| fits(block, segment)));
                let target = match (matches.next(), matches.next()) {
                    (Some(id), None) => id,
                    _ => return None,
                };
                let exclusive = blocks.get(target).is_some_and(|block| {
                    line.iter().filter(|other| fits(block, other)).count() == 1
                });
                exclusive.then_some(target)
            })
            .collect();
        for (offset, segment) in line.iter().enumerate() {
            let segment_index = start + offset;
            let claimed = targets.get(offset).copied().flatten();
            match claimed.and_then(|id| blocks.get_mut(id)) {
                Some(block) => {
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
                }
                None => {
                    active.push(blocks.len());
                    blocks.push(Block {
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
            out.push(std::mem::take(&mut band));
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

fn vertical_key(block: &Block) -> (f64, f64) {
    (block.top, block.bottom)
}

fn horizontal_key(block: &Block) -> (f64, f64) {
    (block.x0, block.x1)
}

fn reading_order(blocks: &[Block], ids: Vec<usize>, depth: usize, out: &mut Vec<usize>) {
    if ids.len() <= 1 || depth >= MAX_CUT_DEPTH {
        if ids.len() > 1 {
            let mut sorted = ids;
            sorted.sort_unstable_by(|&a, &b| match (blocks.get(a), blocks.get(b)) {
                (Some(left), Some(right)) => {
                    compare(right.top, left.top).then_with(|| compare(left.x0, right.x0))
                }
                _ => Ordering::Equal,
            });
            out.extend(sorted);
        } else {
            out.extend(ids);
        }
        return;
    }
    let mut bands: Vec<Vec<usize>> = Vec::new();
    cut_bands(blocks, &ids, &mut bands, vertical_key, true);
    if bands.len() < 2 {
        bands.clear();
        cut_bands(blocks, &ids, &mut bands, horizontal_key, false);
    }
    if bands.len() < 2 {
        let mut sorted = ids;
        sorted.sort_unstable_by(|&a, &b| match (blocks.get(a), blocks.get(b)) {
            (Some(left), Some(right)) => {
                compare(right.top, left.top).then_with(|| compare(left.x0, right.x0))
            }
            _ => Ordering::Equal,
        });
        out.extend(sorted);
        return;
    }
    for band in bands {
        reading_order(blocks, band, depth + 1, out);
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

fn layout_pool(frags: &[Frag<'_>], out: &mut String) {
    if frags.is_empty() {
        return;
    }
    let lines = cluster_lines(frags);
    let mut segments: Vec<Segment> = Vec::with_capacity(lines.len());
    let mut line_starts: Vec<usize> = Vec::with_capacity(lines.len());
    for line in &lines {
        let before = segments.len();
        split_segments(frags, line, &mut segments);
        if segments.len() > before {
            line_starts.push(before);
        }
    }
    let blocks = build_blocks(&segments, &line_starts);
    let ids: Vec<usize> = (0..blocks.len()).collect();
    let mut order: Vec<usize> = Vec::with_capacity(blocks.len());
    reading_order(&blocks, ids, 0, &mut order);
    let mut previous: Option<&Block> = None;
    for id in order {
        let Some(block) = blocks.get(id) else {
            continue;
        };
        if let Some(before) = previous {
            out.push_str(separator(&segments, before, block));
        }
        for (row, &segment_index) in block.segments.iter().enumerate() {
            let Some(segment) = segments.get(segment_index) else {
                continue;
            };
            if row > 0 {
                out.push('\n');
            }
            write_segment(frags, segment, out);
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

pub fn page_text(runs: &[Run], rotate: i32) -> String {
    let page = page_quarter(rotate);
    let mut pools: [Vec<Frag<'_>>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    let mut weights = [0usize; 4];
    for run in runs {
        if run.item.text.is_empty() || !run.direction.0.is_finite() || !run.direction.1.is_finite()
        {
            continue;
        }
        let visible = turn(page, run.direction.0, run.direction.1);
        let quarter = quarter_of(visible);
        let turns = (page + quarter) % 4;
        let [x0, y0, x1, y1] = run.item.rect;
        let (ax, ay) = turn(turns, x0, y0);
        let (bx, by) = turn(turns, x1, y1);
        let frag = Frag {
            x0: ax.min(bx),
            y0: ay.min(by),
            x1: ax.max(bx),
            y1: ay.max(by),
            size: run.item.font_size.abs().max(1e-3),
            text: &run.item.text,
        };
        if !(frag.x0.is_finite()
            && frag.x1.is_finite()
            && frag.y0.is_finite()
            && frag.y1.is_finite())
        {
            continue;
        }
        if let (Some(pool), Some(weight)) = (pools.get_mut(quarter), weights.get_mut(quarter)) {
            *weight += run.item.text.len();
            pool.push(frag);
        }
    }
    let mut ranking: Vec<usize> = (0..4)
        .filter(|&q| weights.get(q).copied().unwrap_or(0) > 0)
        .collect();
    ranking.sort_by(|&a, &b| {
        weights
            .get(b)
            .copied()
            .unwrap_or(0)
            .cmp(&weights.get(a).copied().unwrap_or(0))
            .then(a.cmp(&b))
    });
    let mut out = String::new();
    for quarter in ranking {
        let Some(pool) = pools.get(quarter) else {
            continue;
        };
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        layout_pool(pool, &mut out);
    }
    out
}

pub fn text_limits() -> Limits {
    Limits {
        max_items_per_page: 250_000,
        max_items: usize::MAX,
        max_text_bytes: 1 << 30,
        ..Limits::default()
    }
}

pub fn document_text(
    bytes: &[u8],
    page_indexes: Option<&[u32]>,
    limits: &Limits,
) -> Outcome<Vec<String>> {
    if bytes.len() > limits.max_pdf_bytes {
        return Err(Failure::limit("pdf exceeds size limit"));
    }
    let document = Document::open(bytes, limits)?;
    let pages = document.pages()?;
    let selected: Vec<usize> = match page_indexes {
        Some(indexes) => {
            let mut seen = HashSet::new();
            let mut chosen = Vec::with_capacity(indexes.len());
            for &index in indexes {
                let position = usize::try_from(index)
                    .ok()
                    .filter(|position| *position < pages.len())
                    .ok_or_else(|| Failure::invalid(format!("page index {index} out of range")))?;
                if seen.insert(position) {
                    chosen.push(position);
                }
            }
            chosen
        }
        None => (0..pages.len()).collect(),
    };
    let mut session = Session::default();
    let mut texts = Vec::with_capacity(selected.len());
    let mut total_bytes = 0usize;
    for position in selected {
        let Some(page) = pages.get(position) else {
            continue;
        };
        let text = single_page(&document, page, limits, &mut session);
        total_bytes = total_bytes.saturating_add(text.len());
        if total_bytes > limits.max_text_bytes {
            return Err(Failure::limit("text bytes exceed limit"));
        }
        texts.push(text);
    }
    Ok(texts)
}

fn single_page(
    document: &Document<'_>,
    page: &Page,
    limits: &Limits,
    session: &mut Session,
) -> String {
    match extract_runs(document, page, limits, true, session) {
        Ok(runs) => page_text(&runs, page.info.rotate),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;
    use crate::inspection::TextItem;

    const SIZE: f64 = 10.0;

    fn run(x: f64, baseline: f64, width: f64, text: &str) -> Run {
        Run {
            item: TextItem {
                rect: [x, baseline - 2.24, x + width, baseline + 9.45],
                font_size: SIZE,
                text: text.to_owned(),
            },
            direction: (1.0, 0.0),
        }
    }

    fn turned(rect: [f64; 4], direction: (f64, f64), text: &str) -> Run {
        Run {
            item: TextItem {
                rect,
                font_size: SIZE,
                text: text.to_owned(),
            },
            direction,
        }
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
        for (index, baseline) in [700.0, 688.0, 676.0].into_iter().enumerate() {
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
            (700.0, "Data:", "22/12/2026."),
            (688.0, "Horário:", "09h:00min."),
            (676.0, "Local:", "Sala 3"),
        ] {
            runs.push(run(50.0, baseline, 40.0, label));
            runs.push(run(250.0, baseline, 60.0, value));
        }
        assert_eq!(
            page_text(&runs, 0),
            "Data: 22/12/2026.\nHorário: 09h:00min.\nLocal: Sala 3"
        );
    }

    #[test]
    fn wrapped_value_cells_keep_their_lines_together() {
        let runs = vec![
            run(50.0, 700.0, 40.0, "Prazo"),
            run(250.0, 700.0, 120.0, "180 dias corridos, contados"),
            run(250.0, 688.0, 120.0, "da ordem de serviço"),
            run(50.0, 660.0, 40.0, "Local"),
            run(250.0, 660.0, 120.0, "Avenida Central"),
        ];
        assert_eq!(
            page_text(&runs, 0),
            "Prazo 180 dias corridos, contados\nda ordem de serviço\n\nLocal Avenida Central"
        );
    }

    #[test]
    fn page_rotation_reads_in_the_visible_orientation() {
        let runs = vec![
            turned([100.0, 50.0, 111.7, 110.0], (0.0, -1.0), "top line"),
            turned([88.0, 50.0, 99.7, 110.0], (0.0, -1.0), "bottom line"),
        ];
        assert_eq!(page_text(&runs, 90), "top line\nbottom line");
        let upside_down = vec![
            turned([100.0, 50.0, 140.0, 61.7], (-1.0, 0.0), "last"),
            turned([100.0, 38.0, 140.0, 49.7], (-1.0, 0.0), "first"),
        ];
        assert_eq!(page_text(&upside_down, 180), "first\nlast");
    }

    #[test]
    fn sideways_text_is_emitted_after_the_main_pool() {
        let runs = vec![
            turned([20.0, 100.0, 31.7, 160.0], (0.0, 1.0), "margin note"),
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
            Run {
                item: TextItem {
                    rect: [0.0; 4],
                    font_size: 0.0,
                    text: "x".to_owned(),
                },
                direction: (f64::NAN, 0.0),
            },
        ];
        assert_eq!(page_text(&runs, 0), "");
    }

    #[test]
    fn hostile_layouts_stay_bounded() {
        let mut runs = Vec::new();
        for index in 0..4000 {
            let x = f64::from(index % 97) * 7.0;
            let y = f64::from(index % 211) * 3.0;
            runs.push(run(x, y, 30.0, "ab"));
        }
        let text = page_text(&runs, 270);
        assert!(!text.is_empty());
        let mut nested = Vec::new();
        for index in 0..200 {
            let offset = f64::from(index) * 2.0;
            nested.push(run(offset, 700.0 - offset, 500.0 - offset, "n"));
        }
        assert!(!page_text(&nested, 0).is_empty());
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
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for fixture in fixtures {
            assert!(document_text(fixture, None, &limits).is_ok());
            for _ in 0..150 {
                let mut bytes = fixture.to_vec();
                for _ in 0..(1 + next() % 8) {
                    let at = usize::try_from(next()).unwrap_or(0) % bytes.len();
                    if let Some(byte) = bytes.get_mut(at) {
                        *byte ^= u8::try_from(next() % 255).unwrap_or(1).max(1);
                    }
                }
                let cut = usize::try_from(next()).unwrap_or(0) % (bytes.len() + 1);
                if next() % 4 == 0 {
                    bytes.truncate(cut);
                }
                let _ = document_text(&bytes, None, &limits);
            }
        }
    }

    #[test]
    fn page_selection_validates_indexes() {
        let limits = text_limits();
        let error = document_text(b"%PDF-1.4\n", Some(&[0]), &limits).unwrap_err();
        assert_eq!(error.code, crate::failure::FailureCode::InvalidPdf);
        let oversized = Limits {
            max_pdf_bytes: 4,
            ..Limits::default()
        };
        let error = document_text(b"%PDF-1.4\n", None, &oversized).unwrap_err();
        assert_eq!(error.code, crate::failure::FailureCode::LimitExceeded);
    }
}
