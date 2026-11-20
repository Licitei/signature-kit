use core::mem;

use crate::clean::{Rule, TableGrid};
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
    letters: Vec<Box>,
}

impl TextLine {
    fn add(&mut self, bbox: Box, typical: u32) {
        let [_, top, _, bottom] = bbox;
        if bottom.saturating_sub(top) >= typical.div_ceil(2) {
            self.baseline = self.baseline.saturating_mul(3).saturating_add(bottom) >> 2_u32;
        }
        self.bbox = union(self.bbox, bbox);
        self.letters.push(bbox);
    }

    fn finish(mut self, block: u32, typical: u32, allow_single_glyph: bool) -> Option<Line> {
        self.letters
            .sort_unstable_by_key(|&[left, top, _, _]| (left, top));
        let minimum_gap = typical.saturating_mul(4);
        let mut rightmost = 0;
        self.letters = self
            .letters
            .chunk_by(|&[_, _, right, _], &[left, _, _, _]| {
                rightmost = rightmost.max(right);
                let adjacent = left.saturating_sub(rightmost) < minimum_gap;
                if !adjacent {
                    rightmost = 0;
                }
                adjacent
            })
            .filter(|cluster| allow_single_glyph || has_text_support(cluster, typical))
            .flatten()
            .copied()
            .collect();
        let bbox = self.letters.iter().copied().reduce(union)?;
        let mut bottoms: Vec<_> = self
            .letters
            .iter()
            .filter_map(|&[_, top, _, bottom]| {
                (bottom.saturating_sub(top) >= typical.div_ceil(2)).then_some(bottom)
            })
            .collect();
        let (baseline, x_height) = metrics(bbox, &mut bottoms, &self.letters, typical);
        Some(Line {
            baseline: coordinate(baseline),
            bbox,
            block,
            words: words(&self.letters, typical),
            x_height: coordinate(x_height),
        })
    }

    const fn matches(&self, bounds: Box, typical: u32) -> bool {
        let [_, top, _, bottom] = bounds;
        let [_, line_top, _, _] = self.bbox;
        let tolerance = (typical >> 1).saturating_add(1);
        if bottom.saturating_sub(top) < typical.div_ceil(2) {
            bottom.saturating_add(tolerance) >= line_top
                && bottom <= self.baseline.saturating_add(typical.div_ceil(3))
        } else {
            bottom.abs_diff(self.baseline) <= tolerance && top < self.baseline && line_top < bottom
        }
    }
}

fn has_text_support(cluster: &[Box], typical: u32) -> bool {
    let mut glyphs = 0_u32;
    for &[left, top, right, bottom] in cluster {
        let height = bottom.saturating_sub(top);
        let width = right.saturating_sub(left);
        if height < typical.div_ceil(2) || height > typical.saturating_mul(3) {
            continue;
        }
        if width >= height.saturating_mul(2) && width <= height.saturating_mul(8) {
            return true;
        }
        if width >= height.div_ceil(6) && width < height.saturating_mul(2) {
            glyphs = glyphs.saturating_add(1);
            if glyphs >= 2 {
                return true;
            }
        }
    }
    false
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

fn line_groups(boxes: &mut [Box], typical: u32, block: u32, allow_single_glyph: bool) -> Vec<Line> {
    boxes.sort_unstable_by_key(|&[left, top, _, bottom]| (top, bottom, left));
    let mut groups = Vec::<TextLine>::new();
    let (main, mut small): (Vec<_>, Vec<_>) = boxes
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
                letters: vec![bbox],
            });
        }
    }
    groups.sort_unstable_by_key(|entry| entry.baseline);
    small.sort_unstable_by_key(|&[left, top, _, _]| (left, top));
    for bbox in small {
        let [left, _, right, bottom] = bbox;
        let lower = bottom.saturating_sub(typical.div_ceil(3));
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
                .min_by_key(|entry| {
                    let [_, top, _, line_bottom] = entry.bbox;
                    let gap = top
                        .saturating_sub(bottom)
                        .max(bottom.saturating_sub(line_bottom));
                    (gap, bottom.abs_diff(entry.baseline))
                })
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
        .filter_map(|entry| entry.finish(block, typical, allow_single_glyph))
        .collect()
}

fn has_column_gutter(first: &[Box], second: &[Box], typical: u32) -> bool {
    let extent = |boxes: &[Box]| boxes.iter().copied().reduce(union).unwrap_or_default();
    let [first_left, first_top, first_right, first_bottom] = extent(first);
    let [second_left, second_top, second_right, second_bottom] = extent(second);
    let overlap = first_bottom
        .min(second_bottom)
        .saturating_sub(first_top.max(second_top));
    let minimum_width = typical.saturating_mul(3);
    overlap >= typical.saturating_mul(3)
        && first_right.saturating_sub(first_left) >= minimum_width
        && second_right.saturating_sub(second_left) >= minimum_width
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
                    .is_some_and(|(first, second)| has_column_gutter(first, second, typical)))
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
        let cut = whitespace_cut(boxes, true, typical.saturating_mul(2), typical)
            .or_else(|| whitespace_cut(boxes, false, typical.saturating_mul(3), typical));
        if let Some(index) = cut
            && let Some((first, second)) = boxes.split_at_mut_checked(index)
        {
            let deeper = depth.saturating_add(1);
            partition(first, typical, deeper, next_block, lines);
            partition(second, typical, deeper, next_block, lines);
            return;
        }
    }
    lines.extend(line_groups(boxes, typical, *next_block, false));
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
            lines.extend(line_groups(&mut cell_boxes, typical, 0, true));
        }
        if let Some(&top) = grid.rows.first() {
            tables.push((top, lines));
        }
    }
    tables
}

fn split_at_rules(lines: Vec<Line>, rules: &[Rule]) -> Vec<Line> {
    let vertical = rules
        .iter()
        .copied()
        .filter(|rule| !rule.horizontal)
        .collect::<Vec<_>>();
    if vertical.is_empty() {
        return lines;
    }
    let mut output = Vec::with_capacity(lines.len());
    for line in lines {
        let [left, top, right, bottom] = line.bbox;
        let first = vertical.partition_point(|rule| rule.position <= left);
        let end = vertical.partition_point(|rule| rule.position < right);
        let candidates = vertical.get(first..end).unwrap_or_default();
        let mut parts = line.words.chunk_by(|previous, next| {
            let [_, _, word_end, _] = previous.bbox;
            let [word_start, _, _, _] = next.bbox;
            !candidates.iter().any(|rule| {
                word_end <= rule.position
                    && rule.position < word_start
                    && rule.start <= top
                    && rule.end >= bottom
            })
        });
        let first_part = parts.next();
        if first_part.is_none_or(|part| part.len() == line.words.len()) {
            output.push(line);
            continue;
        }
        for words in first_part.into_iter().chain(parts) {
            if let Some(bbox) = words.iter().map(|word| word.bbox).reduce(union) {
                output.push(Line {
                    bbox,
                    words: words.to_vec(),
                    ..line
                });
            }
        }
    }
    output
}

#[inline]
#[must_use]
pub fn segment(page: &Bits, dpi: f32) -> PageLayout {
    segment_with_tables(page, dpi, &[], &[])
}

pub(crate) fn segment_with_tables(
    page: &Bits,
    dpi: f32,
    grids: &[TableGrid],
    rules: &[Rule],
) -> PageLayout {
    let labels = components(page);
    let minimum_scale = dpi * 0.045;
    let mut heights: Vec<_> = labels
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
    if heights
        .iter()
        .filter(|&&height| coordinate(height) >= minimum_scale)
        .take(3)
        .count()
        == 3
    {
        heights.retain(|&height| coordinate(height) >= minimum_scale);
    }
    let nominal = if dpi < 175.0 {
        10
    } else if dpi > 450.0 {
        30
    } else {
        18
    };
    let typical = median(&mut heights, nominal);
    let mut boxes: Vec<_> = labels
        .into_iter()
        .filter_map(|component| {
            let [left, top, right, bottom] = component.bbox;
            let width = right.saturating_sub(left);
            let height = bottom.saturating_sub(top);
            let solid_mark = width > typical
                && height > typical.saturating_add(typical.div_ceil(2))
                && component.area.saturating_mul(2) > width.saturating_mul(height);
            let solid_rule = width >= typical.saturating_mul(3)
                && width >= height.saturating_mul(4)
                && component.area.saturating_mul(4)
                    >= width.saturating_mul(height).saturating_mul(3);
            (component.area >= 2
                && !solid_mark
                && !solid_rule
                && height <= typical.saturating_mul(4)
                && width <= typical.saturating_mul(16))
            .then_some(component.bbox)
        })
        .collect();
    let tables = table_lines(&mut boxes, grids, typical);
    let mut lines = Vec::new();
    let mut next_block = 0_u32;
    partition(&mut boxes, typical, 0, &mut next_block, &mut lines);
    lines = split_at_rules(lines, rules);
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

    use crate::clean::{Rule, TableGrid};

    use super::{WordBox, segment, segment_with_tables};

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "the raster fixture is fallible and assertions check the resulting layout"
    )]
    fn dot_leaders_do_not_set_the_page_glyph_scale() -> Result<(), RasterError> {
        let mut page = Bits::new(600, 240)?;
        for top in [35_u32, 100, 165] {
            for yy in top..top.saturating_add(26) {
                for left in (35..160_u32).step_by(18) {
                    page.set_run(yy, left, left.saturating_add(12), true);
                }
            }
            for yy in top.saturating_add(22)..top.saturating_add(26) {
                for left in (160..545_u32).step_by(8) {
                    page.set_run(yy, left, left.saturating_add(4), true);
                }
            }
        }
        let result = segment(&page, 300.0);
        let geometry: Vec<_> = result
            .lines
            .into_iter()
            .map(|line| (line.bbox, line.x_height))
            .collect();
        assert_eq!(
            geometry,
            [
                ([35, 35, 548, 61], 26.0),
                ([35, 100, 548, 126], 26.0),
                ([35, 165, 548, 191], 26.0)
            ]
        );
        Ok(())
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions check extracted line bounds from a fallible raster fixture"
    )]
    fn includes_detached_marks_on_both_sides_of_the_baseline() -> Result<(), RasterError> {
        let mut page = Bits::new(240, 100)?;
        for yy in 30..50 {
            for left in [30_u32, 48, 66] {
                page.set_run(yy, left, left.saturating_add(10), true);
            }
        }
        page.set_run(25, 33, 37, true);
        page.set_run(53, 69, 73, true);
        let boxes: Vec<_> = segment(&page, 300.0)
            .lines
            .into_iter()
            .map(|line| line.bbox)
            .collect();
        assert_eq!(boxes, [[30, 25, 76, 54]]);
        Ok(())
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "the raster fixture is fallible and assertions check the resulting layout"
    )]
    fn discards_disconnected_marks_without_widening_text_lines() -> Result<(), RasterError> {
        let mut page = Bits::new(640, 300)?;
        for top in [50_u32, 100, 150] {
            for yy in top..top.saturating_add(18) {
                page.set_run(yy, 24, 31, true);
                for left in (120..220_u32).step_by(12) {
                    page.set_run(yy, left, left.saturating_add(7), true);
                }
                page.set_run(yy, 580, 599, true);
            }
        }
        for yy in 240..260 {
            page.set_run(yy, 590, 610, true);
        }
        let result = segment(&page, 300.0);
        let boxes: Vec<_> = result.lines.into_iter().map(|line| line.bbox).collect();
        assert_eq!(
            boxes,
            [
                [120, 50, 223, 68],
                [120, 100, 223, 118],
                [120, 150, 223, 168]
            ]
        );
        Ok(())
    }

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
        reason = "assertions report order from a fallible raster fixture"
    )]
    fn reads_the_title_before_a_hanging_clause_number() -> Result<(), RasterError> {
        let mut page = Bits::new(360, 140)?;
        for (top, starts) in [
            (15_u32, [150_u32, 162, 174, 186, 198]),
            (70, [15, 27, 101, 113, 125]),
            (98, [101, 113, 125, 137, 149]),
        ] {
            for yy in top..top.saturating_add(15) {
                for left in starts {
                    page.set_run(yy, left, left.saturating_add(8), true);
                }
            }
        }
        let boxes: Vec<_> = segment(&page, 300.0)
            .lines
            .into_iter()
            .map(|line| line.bbox)
            .collect();
        assert_eq!(
            boxes,
            [[150, 15, 206, 30], [15, 70, 133, 85], [101, 98, 157, 113]]
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
        let layout = segment_with_tables(&page, 300.0, &[grid], &[]);
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

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions report layout from a fallible raster fixture"
    )]
    fn splits_a_line_at_a_vertical_rule_without_a_complete_grid() -> Result<(), RasterError> {
        let mut page = Bits::new(240, 150)?;
        for yy in 30..50 {
            for left in [30_u32, 42, 54, 85, 97, 109] {
                page.set_run(yy, left, left.saturating_add(8), true);
            }
        }
        let rule = Rule {
            end: 100,
            horizontal: false,
            position: 75,
            start: 20,
        };
        let result = segment_with_tables(&page, 300.0, &[], &[rule]);
        let boxes: Vec<_> = result.lines.into_iter().map(|line| line.bbox).collect();
        assert_eq!(boxes, [[30, 30, 62, 50], [85, 30, 117, 50]]);
        Ok(())
    }
}
