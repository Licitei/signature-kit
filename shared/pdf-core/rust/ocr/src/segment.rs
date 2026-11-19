use core::mem;

use crate::clean::TableGrid;
use crate::raster::{Bits, ink_runs};

type Box = [u32; 4];

#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Line {
    pub baseline: f32,
    pub bbox: Box,
    pub block: u32,
    pub words: Vec<WordBox>,
    pub x_height: f32,
}

#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct PageLayout {
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct WordBox {
    pub bbox: Box,
}

#[derive(Clone, Copy)]
struct Run {
    end: u32,
    label: usize,
    start: u32,
}

struct Component {
    area: u32,
    bbox: Box,
    parent: usize,
}

struct TextLine {
    baseline: u32,
    bbox: Box,
    bottoms: Vec<u32>,
    letters: Vec<Box>,
}

impl TextLine {
    fn add(&mut self, bbox: Box, typical: u32) {
        let [_, top, _, bottom] = bbox;
        if bottom.saturating_sub(top) >= typical.div_ceil(2) {
            self.bottoms.push(bottom);
            self.baseline = self.baseline.saturating_mul(3).saturating_add(bottom) >> 2_u32;
        }
        self.bbox = union(self.bbox, bbox);
        self.letters.push(bbox);
    }

    fn finish(mut self, block: u32, typical: u32) -> Line {
        self.letters
            .sort_unstable_by_key(|&[left, top, _, _]| (left, top));
        if self.letters.len() >= 5 {
            let minimum_gap = typical.saturating_mul(5);
            let clusters = self
                .letters
                .chunk_by(|&[_, _, right, _], &[left, _, _, _]| {
                    left.saturating_sub(right) < minimum_gap
                });
            if clusters.clone().any(|cluster| cluster.len() >= 5) {
                self.letters = clusters
                    .filter(|cluster| cluster.len() >= 3)
                    .flatten()
                    .copied()
                    .collect();
                if let Some(bounds) = self.letters.iter().copied().reduce(union) {
                    self.bbox = bounds;
                }
                self.bottoms = self
                    .letters
                    .iter()
                    .filter_map(|&[_, top, _, bottom]| {
                        (bottom.saturating_sub(top) >= typical.div_ceil(2)).then_some(bottom)
                    })
                    .collect();
            }
        }
        let (baseline, x_height) = metrics(self.bbox, &mut self.bottoms, &self.letters, typical);
        Line {
            baseline: coordinate(baseline),
            bbox: self.bbox,
            block,
            words: words(&self.letters, typical),
            x_height: coordinate(x_height),
        }
    }

    const fn matches(&self, bounds: Box, typical: u32) -> bool {
        let [_, top, _, bottom] = bounds;
        let [_, line_top, _, _] = self.bbox;
        let tolerance = (typical >> 1).saturating_add(1);
        if bottom.saturating_sub(top) < typical.div_ceil(2) {
            bottom.saturating_add(tolerance) >= line_top
                && bottom <= self.baseline
                && top < self.baseline
        } else {
            bottom.abs_diff(self.baseline) <= tolerance
        }
    }
}

fn coordinate(value: u32) -> f32 {
    f32::from(u16::try_from(value).unwrap_or(u16::MAX))
}

fn root(components: &mut [Component], mut label: usize) -> usize {
    while let Some(component) = components.get(label) {
        let parent = component.parent;
        if parent == label {
            break;
        }
        if let Some(grandparent) = components.get(parent).map(|entry| entry.parent)
            && let Some(current) = components.get_mut(label)
        {
            current.parent = grandparent;
        }
        label = parent;
    }
    label
}

fn append_run(components: &mut Vec<Component>, bbox: Box, previous: &[Run]) -> usize {
    let [left, _, right, _] = bbox;
    let area = right.saturating_sub(left);
    let mut overlaps = previous.iter().take_while(|run| run.start <= right);
    let Some(first) = overlaps.next() else {
        let label = components.len();
        components.push(Component {
            area,
            bbox,
            parent: label,
        });
        return label;
    };
    let label = root(components, first.label);
    if let Some(component) = components.get_mut(label) {
        component.area = component.area.saturating_add(area);
        component.bbox = union(component.bbox, bbox);
    }
    for overlap in overlaps {
        let other = root(components, overlap.label);
        if label == other {
            continue;
        }
        if let Some(entry) = components.get(other) {
            let area_other = entry.area;
            let box_other = entry.bbox;
            if let Some(component) = components.get_mut(label) {
                component.area = component.area.saturating_add(area_other);
                component.bbox = union(component.bbox, box_other);
            }
        }
        if let Some(entry) = components.get_mut(other) {
            entry.parent = label;
        }
    }
    label
}

fn components(page: &Bits) -> Vec<Component> {
    let mut labels = Vec::new();
    let mut previous = Vec::<Run>::new();
    let mut current = Vec::new();
    for yy in 0..page.height {
        let mut candidates = previous.as_slice();
        ink_runs(page.row(yy), page.width, |start, end| {
            let skipped = candidates.partition_point(|run| run.end < start);
            candidates = candidates.get(skipped..).unwrap_or_default();
            let label = append_run(
                &mut labels,
                [start, yy, end, yy.saturating_add(1)],
                candidates,
            );
            current.push(Run { end, label, start });
        });
        mem::swap(&mut previous, &mut current);
        current.clear();
    }
    labels
        .into_iter()
        .enumerate()
        .filter_map(|(label, component)| (component.parent == label).then_some(component))
        .collect()
}

const fn union(first: Box, second: Box) -> Box {
    let [left, top, right, bottom] = first;
    let [other_left, other_top, other_right, other_bottom] = second;
    [
        if left < other_left { left } else { other_left },
        if top < other_top { top } else { other_top },
        if right > other_right {
            right
        } else {
            other_right
        },
        if bottom > other_bottom {
            bottom
        } else {
            other_bottom
        },
    ]
}

fn median(values: &mut [u32], fallback: u32) -> u32 {
    let middle = values.len() >> 1_u32;
    if values.is_empty() {
        return fallback;
    }
    let (_, median, _) = values.select_nth_unstable(middle);
    *median
}

fn metrics(bbox: Box, bottoms: &mut [u32], letters: &[Box], typical: u32) -> (u32, u32) {
    let [_, _, _, bottom] = bbox;
    let baseline = median(bottoms, bottom);
    let mut heights: Vec<_> = letters
        .iter()
        .filter_map(|&[_, top, _, end]| {
            let height = baseline.saturating_sub(top);
            (end.abs_diff(baseline) <= typical.div_ceil(4) && height >= typical.div_ceil(2))
                .then_some(height)
        })
        .collect();
    (baseline, median(&mut heights, typical))
}

fn words(letters: &[Box], typical: u32) -> Vec<WordBox> {
    let mut gaps = Vec::new();
    let mut right = 0_u32;
    for &[left, _, end, _] in letters {
        let gap = left.saturating_sub(right);
        if right != 0 && gap > 0 && gap <= typical {
            gaps.push(gap);
        }
        right = right.max(end);
    }
    let letter_gap = median(&mut gaps, typical.div_ceil(6));
    let word_gap = letter_gap
        .saturating_mul(2)
        .saturating_add(1)
        .clamp(typical.div_ceil(4), typical.div_ceil(2));
    let mut words = Vec::<WordBox>::new();
    for &bbox in letters {
        let [left, _, _, _] = bbox;
        if let Some(current) = words.last_mut() {
            let [_, _, end, _] = current.bbox;
            if left.saturating_sub(end) < word_gap {
                current.bbox = union(current.bbox, bbox);
                continue;
            }
        }
        words.push(WordBox { bbox });
    }
    words
}

fn line_groups(boxes: &mut [Box], typical: u32, block: u32) -> Vec<Line> {
    boxes.sort_unstable_by_key(|&[left, top, _, bottom]| (top, bottom, left));
    let mut groups = Vec::<TextLine>::new();
    let (main, small): (Vec<_>, Vec<_>) = boxes
        .iter()
        .copied()
        .partition(|&[_, top, _, bottom]| bottom.saturating_sub(top) >= typical.div_ceil(2));
    for bbox in main {
        let [_, _, _, bottom] = bbox;
        let line = groups
            .iter_mut()
            .rev()
            .take(4)
            .filter(|entry| entry.matches(bbox, typical))
            .min_by_key(|entry| bottom.abs_diff(entry.baseline));
        if let Some(entry) = line {
            entry.add(bbox, typical);
        } else {
            groups.push(TextLine {
                baseline: bottom,
                bbox,
                bottoms: vec![bottom],
                letters: vec![bbox],
            });
        }
    }
    groups.sort_unstable_by_key(|entry| entry.baseline);
    for bbox in small {
        let [left, _, right, bottom] = bbox;
        let lower = bottom.saturating_sub(typical.div_ceil(2));
        let upper = bottom.saturating_add(typical.saturating_mul(2));
        let first = groups.partition_point(|entry| entry.baseline < lower);
        let last = groups.partition_point(|entry| entry.baseline <= upper);
        let nearest = groups.get_mut(first..last).and_then(|candidates| {
            candidates
                .iter_mut()
                .filter(|entry| {
                    let [start, _, end, _] = entry.bbox;
                    left <= end.saturating_add(typical.div_ceil(3))
                        && right.saturating_add(typical.div_ceil(3)) >= start
                        && entry.matches(bbox, typical)
                })
                .min_by_key(|entry| bottom.abs_diff(entry.baseline))
        });
        if let Some(line) = nearest {
            line.add(bbox, typical);
        }
    }
    let mut coalesced = Vec::<TextLine>::new();
    for entry in groups {
        if let Some(previous) = coalesced.last_mut()
            && previous.baseline.abs_diff(entry.baseline) <= typical.div_ceil(3).saturating_add(1)
        {
            let [_, prev_top, _, prev_bottom] = previous.bbox;
            let [_, top, _, bottom] = entry.bbox;
            if top < prev_bottom && prev_top < bottom {
                previous.bbox = union(previous.bbox, entry.bbox);
                previous.bottoms.extend(entry.bottoms);
                previous.letters.extend(entry.letters);
                continue;
            }
        }
        coalesced.push(entry);
    }
    coalesced
        .into_iter()
        .filter(|entry| {
            let [left, top, right, bottom] = entry.bbox;
            bottom.saturating_sub(top) >= typical.div_ceil(2)
                && (entry.letters.len() >= 2 || right.saturating_sub(left) >= typical.div_ceil(3))
        })
        .map(|entry| entry.finish(block, typical))
        .collect()
}

fn column_overlap(first: &[Box], second: &[Box]) -> u32 {
    let extent = |boxes: &[Box]| {
        boxes
            .iter()
            .fold((u32::MAX, 0_u32), |(min, max), &[_, top, _, bottom]| {
                (min.min(top), max.max(bottom))
            })
    };
    let (first_top, first_bottom) = extent(first);
    let (second_top, second_bottom) = extent(second);
    first_bottom
        .min(second_bottom)
        .saturating_sub(first_top.max(second_top))
}

fn whitespace_cut(
    boxes: &mut [Box],
    horizontal: bool,
    min_gap: u32,
    typical: u32,
) -> Option<usize> {
    let interval = |[left, top, right, bottom]: Box| {
        if horizontal {
            (top, bottom)
        } else {
            (left, right)
        }
    };
    boxes.sort_unstable_by_key(|&bbox| interval(bbox));
    let mut max_right = 0_u32;
    let mut best_gap = min_gap.saturating_sub(1);
    let mut cut = None;
    for (index, &bbox) in boxes.iter().enumerate() {
        let (left, right) = interval(bbox);
        let gap = left.saturating_sub(max_right);
        if index >= 2
            && boxes.len().saturating_sub(index) >= 2
            && gap > best_gap
            && (horizontal
                || boxes
                    .split_at_checked(index)
                    .is_some_and(|(first, second)| {
                        column_overlap(first, second) >= typical.saturating_mul(2)
                    }))
        {
            best_gap = gap;
            cut = Some(index);
        }
        max_right = max_right.max(right);
    }
    cut
}

fn partition(
    boxes: &mut [Box],
    typical: u32,
    depth: u32,
    next_block: &mut u32,
    lines: &mut Vec<Line>,
) {
    if boxes.is_empty() {
        return;
    }
    if depth < 16 {
        let cut = whitespace_cut(boxes, false, typical.saturating_mul(3), typical)
            .or_else(|| whitespace_cut(boxes, true, typical.saturating_mul(2), typical));
        if let Some(index) = cut
            && let Some((first, second)) = boxes.split_at_mut_checked(index)
        {
            let deeper = depth.saturating_add(1);
            partition(first, typical, deeper, next_block, lines);
            partition(second, typical, deeper, next_block, lines);
            return;
        }
    }
    lines.extend(line_groups(boxes, typical, *next_block));
    *next_block = next_block.saturating_add(1);
}

fn table_cell(bbox: Box, grid: &TableGrid) -> Option<(usize, usize)> {
    let [left, top, right, bottom] = bbox;
    let center_x = u32::midpoint(left, right);
    let center_y = u32::midpoint(top, bottom);
    let row = grid.rows.partition_point(|&boundary| boundary <= center_y);
    let column = grid
        .columns
        .partition_point(|&boundary| boundary <= center_x);
    (row > 0 && row < grid.rows.len() && column > 0 && column < grid.columns.len())
        .then_some((row, column))
}

fn table_lines(boxes: &mut Vec<Box>, grids: &[TableGrid], typical: u32) -> Vec<(u32, Vec<Line>)> {
    let mut tables = Vec::new();
    for grid in grids {
        let mut cells = Vec::new();
        boxes.retain(|&bbox| {
            table_cell(bbox, grid).is_none_or(|cell| {
                cells.push((cell, bbox));
                false
            })
        });
        if cells.is_empty() {
            continue;
        }
        cells.sort_unstable_by_key(|&(cell, _)| cell);
        let mut lines = Vec::new();
        for group in cells.chunk_by(|(cell, _), (next_cell, _)| cell == next_cell) {
            let mut cell_boxes: Vec<_> = group.iter().map(|&(_, bbox)| bbox).collect();
            lines.extend(line_groups(&mut cell_boxes, typical, 0));
        }
        if let Some(&top) = grid.rows.first() {
            tables.push((top, lines));
        }
    }
    tables
}

#[inline]
#[must_use]
pub fn segment(page: &Bits, dpi: f32) -> PageLayout {
    segment_with_tables(page, dpi, &[])
}

pub(crate) fn segment_with_tables(page: &Bits, dpi: f32, grids: &[TableGrid]) -> PageLayout {
    let labels = components(page);
    let heights: Vec<_> = labels
        .iter()
        .filter_map(|component| {
            let [left, top, right, bottom] = component.bbox;
            let width = right.saturating_sub(left);
            let height = bottom.saturating_sub(top);
            ((3..=200).contains(&height)
                && width <= height.saturating_mul(3)
                && component.area >= 6)
                .then_some(height)
        })
        .collect();
    let mut observed = heights;
    let nominal = if dpi < 175.0 {
        10
    } else if dpi > 450.0 {
        30
    } else {
        18
    };
    let typical = median(&mut observed, nominal);
    let mut boxes: Vec<_> = labels
        .into_iter()
        .filter_map(|component| {
            let [left, top, right, bottom] = component.bbox;
            let width = right.saturating_sub(left);
            let height = bottom.saturating_sub(top);
            let solid_mark = width > typical
                && height > typical.saturating_add(typical.div_ceil(2))
                && component.area.saturating_mul(2) > width.saturating_mul(height);
            (component.area >= 2
                && !solid_mark
                && height <= typical.saturating_mul(4)
                && width <= typical.saturating_mul(16))
            .then_some(component.bbox)
        })
        .collect();
    let tables = table_lines(&mut boxes, grids, typical);
    let mut lines = Vec::new();
    let mut next_block = 0_u32;
    partition(&mut boxes, typical, 0, &mut next_block, &mut lines);
    for (top, mut table) in tables {
        let insertion = lines
            .iter()
            .position(|line| {
                let [_, line_top, _, _] = line.bbox;
                line_top >= top
            })
            .unwrap_or(lines.len());
        for line in &mut table {
            line.block = next_block;
        }
        next_block = next_block.saturating_add(1);
        drop(lines.splice(insertion..insertion, table));
    }
    PageLayout { lines }
}

#[cfg(test)]
mod tests {
    use crate::raster::{Bits, RasterError};

    use crate::clean::TableGrid;

    use super::{WordBox, segment, segment_with_tables};

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions report mismatches and raster setup is fallible"
    )]
    fn separates_words_and_reads_columns() -> Result<(), RasterError> {
        let mut page = Bits::new(500, 220)?;
        for start in [35_u32, 290] {
            for top in [10_u32, 50, 90] {
                for offset in [0_u32, 10, 20, 40, 50] {
                    for row in top..top.saturating_add(15) {
                        let left = start.saturating_add(offset);
                        page.set_run(row, left, left.saturating_add(8), true);
                    }
                }
            }
        }
        let layout = segment(&page, 300.0);
        let boxes: Vec<_> = layout.lines.iter().map(|line| line.bbox).collect();
        assert_eq!(
            boxes,
            [
                [35, 10, 93, 25],
                [35, 50, 93, 65],
                [35, 90, 93, 105],
                [290, 10, 348, 25],
                [290, 50, 348, 65],
                [290, 90, 348, 105]
            ]
        );
        let words = layout
            .lines
            .first()
            .map(|line| line.words.as_slice())
            .unwrap_or_default();
        assert_eq!(
            words,
            [
                WordBox {
                    bbox: [35, 10, 63, 25]
                },
                WordBox {
                    bbox: [75, 10, 93, 25]
                }
            ]
        );
        Ok(())
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions report mismatches and raster setup is fallible"
    )]
    fn table_cells_keep_rows_in_reading_order() -> Result<(), RasterError> {
        let mut page = Bits::new(480, 180)?;
        for top in [30_u32, 100] {
            for start in [30_u32, 280] {
                for offset in [0_u32, 12, 24] {
                    for row in top..top.saturating_add(15) {
                        let left = start.saturating_add(offset);
                        page.set_run(row, left, left.saturating_add(8), true);
                    }
                }
            }
        }
        let grid = TableGrid {
            columns: vec![10, 240, 470],
            rows: vec![10, 80, 160],
        };
        let layout = segment_with_tables(&page, 300.0, &[grid]);
        let boxes: Vec<_> = layout.lines.iter().map(|line| line.bbox).collect();
        assert_eq!(
            boxes,
            [
                [30, 30, 62, 45],
                [280, 30, 312, 45],
                [30, 100, 62, 115],
                [280, 100, 312, 115]
            ]
        );
        Ok(())
    }
}
